# dsh-raindrop 实施契约 v1（并行开发唯一事实来源）

> 本文件由 Lead 维护。`host-dev` 与 `client-dev` 都必须严格按本契约实现；
> 需要改契约时先给 Lead 发消息，不要各自改动本文件。

## 0. 产品目标

在 DSH Web GUI 里新增一个 **Raindrop.io 仪表盘**：侧边栏一个入口 → 中央主面板，
把用户收藏库快速分析成「分类与标签分布 / 域名来源 Top / 待清理项（死链·无标签·重复·未分类）/
类型分布 / 最近收藏」。同时注册 2 个 Agent 工具，让对话里的 Agent 能直接读取同一份统计数据。

**产品口径（用户已拍板，不可删减）：**
- 必做：分类与标签分布、域名/来源 Top、待清理（死链/无标签/重要未读）、最近收藏列表；
- 类型分布、月度趋势作为同屏补充；
- 必须注册 Agent 工具（`raindrop_overview`、`raindrop_search`）；
- Token 由用户在面板里粘贴，Host 侧保存，浏览器永不接触 token。

## 1. 包与运行环境

- 包名/模块 id/客户端 NS/侧边栏面板 key 统一为 **`raindrop`**（包名 `dsh-raindrop`）。
- 工作目录：`<workspace>/dsh-raindrop/`。
- Node ESM，**不新增任何 npm 依赖**，宿主半**不 import 任何 `@deepseek-ai/*` 包**。
- HTTP 路由前缀：`/api/dsh-raindrop`；客户端用**文档相对路径** `api/dsh-raindrop/...`
  （GUI 有 `<base href="./">`，不要用根绝对路径）。
- 数据文件：`$DSH_HOME/dsh-raindrop/config.json`（`$DSH_HOME` 缺省 `~/.dsh`），目录 0700、文件 0600。

## 2. 文件归属（写作用域，禁止越界）

| 文件 | 负责人 |
|---|---|
| `package.json` `cordis.patch.yml` `lib/index.js` `locale/*.json` `icon.svg` `README.md` `CONTRACT.md` | Lead |
| `lib/store.js` `lib/api.js` `lib/routes.js` `lib/tools.js` `test/analytics.test.mjs` `test/routes.test.mjs` | **host-dev** |
| `lib/client.js` | **client-dev** |

任何一方都不要运行 `plugin_manager`、不要安装 bundle、不要改 profile 文件。

## 3. 宿主半模块接口（`lib/index.js` 已按此写好，不得改签名）

### 3.1 `lib/store.js`

```js
export function resolveDataDir()            // -> string：$DSH_HOME/dsh-raindrop
export function createStore({ dir, defaults })
```

`createStore` 返回：

```js
{
  file,                    // 配置文件绝对路径
  config,                  // { scanPages, cacheTtlSeconds, enableTools }（defaults 合并后的值）
  readToken(): string|null,
  writeToken(token): void, // 原子写（tmp + rename），0600；同时清空 user 缓存
  clearToken(): void,
  readUserCache(): { name: string|null, pro: boolean|null } | null,
  writeUserCache(user): void
}
```

- 文件不存在 / JSON 损坏时**不得抛错**，按未配置处理（损坏时下次写入覆盖）。
- `writeToken` 后 `readUserCache()` 返回 `null`（token 换了，旧用户信息失效）。
- 持久化内容：`{ "token": string|null, "user": { "name": string|null, "pro": boolean|null } | null }`。

### 3.2 `lib/api.js`

```js
export class RaindropError extends Error {
  code;      // 'invalid-token' | 'rate-limited' | 'upstream' | 'network' | 'timeout'
  status;    // number|undefined  HTTP 状态
  retryAfter;// number|undefined  秒
}
export function createClient({ token, fetchImpl = globalThis.fetch, baseUrl = 'https://api.raindrop.io/rest/v1', timeoutMs = 15000 })
```

`createClient` 返回对象，方法：

```js
user()          // -> Promise<{ name: string|null, pro: boolean|null }>   GET /user
aggregates()    // -> Promise<Aggregates>（见 3.3；内部并发 GET /filters/0、/user/stats、/collections、/collections/childrens、/tags/0）
sample(pages)   // -> Promise<{ items: RaindropItem[], total: number|null, pages: number, complete: boolean }>
                // GET /raindrops/0?perpage=50&page=N&sort=-created，N=0..pages-1，页间并发度 3
buildDashboard(client, { scanPages, generatedAt })  // -> Promise<Dashboard>（见 4.2）
```

规则：
- 请求头 `Authorization: Bearer <token>`，`accept: application/json`。
- Raindrop 成功响应必须 `result === true`；错误体不统一，只信 `result` 与 HTTP 状态。
- HTTP 401 → `RaindropError('invalid-token', 'Raindrop Token 无效或已过期', { status: 401 })`。
- HTTP 429 → `RaindropError('rate-limited', ..., { status: 429, retryAfter })`，`retryAfter` 读
  `retry-after` 或 `X-RateLimit-Reset - now`（秒，向上取整，最小 1）。
- 超时用 `AbortSignal.timeout(timeoutMs)` → `code:'timeout'`；其它网络错误 → `code:'network'`。
- 其它非 2xx 或 `result !== true` → `code:'upstream'`，message 带 HTTP 状态与 `errorMessage`（若有）。
- 不做隐式重试（429 直接抛给上层，保持可观测）。

### 3.3 `Aggregates`（`aggregates()` 的返回）

```js
{
  totals: {
    all, unsorted, trash,          // /user/stats items _id 0 / -1 / -99；缺失按 0
    collections, tags,             // 由 /collections(+childrens) 与 /tags/0 计算；tags = 标签种类数
    broken, duplicates, important, untagged  // /filters/0 的 broken/duplicates/important/notag 的 count
  },
  types: [{ type, count }],        // 固定 6 项、规范顺序 link/article/image/video/document/audio，缺失补 0
  collections: [{ id, parentId, title, count, depth }],  // 根 + 子收藏夹重建；按 count 降序
  groups: [{ id, title, count, collections }],          // 顶层分类聚合（子树 count 合计）；按 count 降序
  tags: [{ name, count }],         // /tags/0；按 count 降序；最多 20 项
  availability: {                  // 字段是否存在 —— 免费账号没有死链/重复检测，不能当 0
    broken: boolean, duplicates: boolean, important: boolean, untagged: boolean
  },
  warnings: string[]               // 可选接口失败时的代码，如 'filters-unavailable'；成功时 []
}
```

降级规则（网络/上游失败时**不要整体失败**，尽量出部分数据）：
- `/filters/0` 失败 → `broken/duplicates` 用 `/user/stats` 的 `meta.broken.count` / `meta.duplicates.count`
  兜底（有则用），`important/untagged = 0`，`types` 全 0，`warnings` 加 `'filters-unavailable'`。
- `/tags/0` 失败 → `tags: []`，`totals.tags = 0`，`warnings` 加 `'tags-unavailable'`。
- `/collections` 失败 → `collections: []`，`warnings` 加 `'collections-unavailable'`。
- `/user/stats` 失败 → all/unsorted/trash 置 0，`warnings` 加 `'stats-unavailable'`。
- `/user` 失败：401 必须抛 invalid-token，其它失败允许 `{name:null,pro:null}` 继续。

### 3.4 `lib/routes.js`

```js
export function isLoopbackRequest(req): boolean      // 与 dsh-todos 同款围栏
export function createRoutes(store, options = {})    // options: { fetchImpl, now }
// 返回可直接交给 webServer.register() 的 WebRoute 数组
```

四条路由（**全部先过 `isLoopbackRequest`，否则 403**）：

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/dsh-raindrop/status` | 见 4.1 |
| POST | `/api/dsh-raindrop/token` | body `{ token }`；先 `GET /user` 验证，成功才 `writeToken`；见 4.1 |
| DELETE | `/api/dsh-raindrop/token` | 清除 token 与用户缓存；见 4.1 |
| GET | `/api/dsh-raindrop/dashboard` | 见 4.2；query `force=1` 跳过缓存 |

> ⚠️ 实现约束（2026-10-17 实测发现）：`webServer.register` 以 `(kind, path)` 判重，
> 同一路径只能注册**一条** WebRoute。因此 POST 与 DELETE `/token` **必须合并成一条
> `/api/dsh-raindrop/token` 路由**，在 handler 内按 `req.method` 分发；未知方法返回
> JSON 信封 `404 not-found`（保持契约不引入 405）。最终 `createRoutes()` 返回 **3 条**
> WebRoute：`/status`、`/token`、`/dashboard`。重复路径会让第二次 register 抛错，
> 并**中断后续路由与工具注册**（实测表现：status 可用、dashboard 401、工具消失）。

通用约定：
- 响应头 `content-type: application/json; charset=utf-8`、`cache-control: no-store`。
- 成功：HTTP 200 `{ ok: true, value: <payload> }`；失败：HTTP 4xx/5xx `{ ok:false, error:{ code, message, retryAfter? } }`。
- 请求体上限 16 KiB，非法 JSON → 400 `invalid-body`；非 JSON content-type 也按 `invalid-body`。
- 未配置 token 时访问 dashboard → 400 `not-configured`。
- 缓存：内存中 `{ token, at, payload }`，TTL 取 `store.config.cacheTtlSeconds`；`force=1` 绕过；
  token 变化自然因 token 不同而失效。
- `options.now`（返回 Date）与 `options.fetchImpl` 仅供离线测试注入。
- 非 GET/POST/DELETE 或未知子路径 → 404 `not-found`。

### 3.5 `lib/tools.js`

```js
export function createTools(store, options = {})   // options: { fetchImpl, now }
// 返回 2 个 ToolDefinition（原始 JSON Schema，直接给 ctx.tools.register()）
```

两个工具（名称、描述、参数、返回**严格**如下）：

> ⚠️ Harness `dsh-tools` 对 `tool.output.schema` 执行**严格 JSON Schema 子集**校验
> （`assertSupportedJsonSchema`）：只允许 `type / oneOf / properties / required /
> additionalProperties / items / enum / const` 加注解 `description / title / default /
> examples`；`type` 只能是一个字符串（**不允许 type 数组**），联合类型必须写成
> `oneOf: [...]`，且 `oneOf` 旁不能带 `properties/required/...`。违反时 `register()`
> 抛 `JsonSchemaError` 并**回滚整个工具注册 effect** —— 表现是「路由正常、工具表里却
> 没有工具」。回归用例：`node test/tools-schema.test.mjs`。

#### `raindrop_overview`

- 描述（中文）：`读取用户 Raindrop.io 收藏库的聚合统计（总数、类型、收藏夹、标签、域名、月度趋势）与最近收藏样本，用于分析收藏结构与待清理项。只返回统计与元数据，不返回收藏正文全文。`
- 参数：`{ "type":"object", "properties":{}, "additionalProperties":false }`
- 返回（**必须**是这个结构，`ok:false` 时只有 `ok/code/message`）：
```js
{
  ok: true,
  generatedAt,                          // ISO
  user: { name, pro },
  totals: { all, unsorted, trash, collections, tags, broken, duplicates, important, untagged },
  types: [{ type, count }],
  collections: [{ id, title, count, depth }],   // 最多 8 条
  tags: [{ name, count }],                      // 最多 12 条
  domains: [{ domain, count }],                 // 最多 8 条
  monthly: [{ month, count }],                  // 12 项
  recent: [{ id, title, domain, type, created }], // 最多 5 条，不含 link
  scan: { scanned, total, pages, complete },
  availability: { broken, duplicates, important, untagged }, // 可选；false = 免费账号无此统计
  warnings: []
}
```
- `output.render(args, value)` 渲染为紧凑 Markdown（标题行 + 每类一行），失败时渲染一句中文说明。
- `timeoutMs: 30000`，`isConcurrencySafe: () => false`。

#### `raindrop_search`

- 描述（中文）：`在用户 Raindrop.io 收藏库中按关键词/标签检索书签（只读），返回标题、链接、域名、类型、标签、收藏时间与摘要片段，用于进一步分析具体收藏。`
- 参数：
```js
{
  type: 'object',
  properties: {
    query: { type: 'string', description: '关键词，匹配标题、摘要、域名等（Raindrop 搜索语法）。' },
    tag: { type: 'string', description: '标签名（不带 #）。' },
    collectionId: { type: 'integer', description: '0=全部（默认），-1=未分类，其它为收藏夹 id。' },
    limit: { type: 'integer', description: '1-20，默认 10。' }
  },
  additionalProperties: false
}
```
- 返回：
```js
{ ok:true, count, items:[{ id, title, link, domain, type, tags, created, important, broken, excerpt }] }
// excerpt 取 excerpt 字段并截断到 200 字符；没有则为 null
```
- 检索串：`query` 非空取 query；`tag` 非空追加 `#tag`（多个用空格连接）。`perpage=limit`、`page=0`、`sort=-created`。
- 未配置 token → `{ ok:false, code:'not-configured', message:'尚未配置 Raindrop API Token，请先在 Raindrop 面板里填写。' }`；
  其它 `RaindropError` → `{ ok:false, code, message }`（不要让 tool 抛原始异常）。
- `timeoutMs: 30000`，`isConcurrencySafe: () => false`。

## 4. HTTP 载荷（客户端唯一依赖，逐字段照抄）

### 4.1 配置类

`GET status` → `{ ok:true, value:{ configured:boolean, masked:string|null, user:{name,pro}|null } }`
（`masked`：`'••••' + token.slice(-4)`；未配置为 `null`）

`POST token`（body `{ token:"..." }`）→ 成功 value 同 status；token 空/非字符串 → 400 `invalid-body`；
Raindrop 401 → 401 `invalid-token`；网络失败 → 502 `upstream`。

`DELETE token` → `{ ok:true, value:{ configured:false, masked:null, user:null } }`

### 4.2 `GET dashboard` 的 `value`（Dashboard）

```js
{
  generatedAt,                         // ISO 字符串
  user: { name: string|null, pro: boolean|null },
  totals: {
    all, unsorted, trash, collections, tags,
    broken, duplicates, important, untagged
  },
  types: [{ type: string, count: number }],        // 固定 6 项，规范顺序 link/article/image/video/document/audio
  collections: [{ id, parentId, title, count, depth }], // count 降序
  groups: [{ id, title, count, collections }],      // 顶层分类聚合：count 为整棵子树合计，collections 为收藏夹个数
  tags: [{ name, count }],                          // count 降序，最多 20
  domains: [{ domain, count }],                     // 样本口径，最多 10；已排除 raindrop.io 自家上传域
  availability: { broken, duplicates, important, untagged }, // 字段是否可用；false 时 UI 显示「—」
  monthly: [{ month: 'YYYY-MM', count: number }],   // 恰好 12 项，旧 → 新（含当前月）
  recent: [{                                        // 最多 12 项，sample 口径
    id: number, title: string, link: string, domain: string,
    type: string, tags: string[], created: string,
    important: boolean, broken: boolean,
    collectionId: number|null
  }],
  scan: { scanned: number, total: number|null, pages: number, complete: boolean },
  warnings: string[]
}
```

统计口径：
- `types` / `broken` / `duplicates` / `important` / `untagged` / `totals.all|unsorted|trash` 来自
  `/filters/0`、`/user/stats`，是**全库精确值**；
- `domains` / `monthly` / `recent` / `scan` 来自**最近样本书签**（`scanPages*50` 条），
  客户端会显式标注「基于最近 N 条样本」；
- `monthly` 用宿主本地时区切月；`domains` 取 `item.domain`，空则从 `link` 解析 hostname，再空归 `unknown`。

## 5. 客户端半 `lib/client.js`

### 5.1 形态

```js
window.__ModuleLoader__.load({
  id: 'dsh-raindrop',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    // ...
    return { inject: ['slots', 'locale'], apply(ctx) { /* 注册 */ } };
  },
});
```

- 只 `require('react')`，不 import 任何 Harness Client 包。
- 只注册两个槽位（顺序/参数照抄）：
  - `sidebar.panellist`：`{ name:'sidebar.panellist', id:'raindrop', order:35, label:()=>t('entry.label') }`，组件为小图标；
  - `main`：`{ name:'main', key:'raindrop', locale: 'raindrop' }`，组件为仪表盘。
- 主面板组件签名 `function RaindropPanel({ t })`，`t` 支持 `{name}` 插值。
- locale 字典由 `ctx.locale.register('raindrop', { zh, en })` 提供，所有可见文案走 `t()`（zh 为默认文案）。
- 样式：`<style data-plugin-css="dsh-raindrop">` 由 `ctx.effect` 安装/卸载；类名统一 `dsr-` 前缀；
  **只用主题 token**：`--dsw-alias-bg-base|-layer-1|-layer-2|-border-l1|-border-l2|-brand-primary|`
  `-label-primary|-label-secondary|-state-error-primary|-state-success-primary|-state-warn-primary|-state-idle-primary`；
  数据可视化配色用这些 token 及其 `color-mix(in srgb, var(--dsw-alias-…) X%, transparent)`，**不写死十六进制色值**。
- 不写组件外的 DOM、不 append 到 body、不用 localStorage / iframe / CDN。
- 所有请求 `fetch('api/dsh-raindrop/...')`；JSON 信封解析：成功取 `value`，失败抛 `Error(error.message)` 并保留 `code`。
- 必须处理三种状态：`loading`（骨架屏/加载文案）、`error`（错误信息 + 重试按钮）、`needs-token`（引导 + token 输入）。
- 组件卸载后不得 setState（用 `alive` 标记或 AbortController 均可）。

### 5.2 面板内容（按优先级；用户点名要的不可省）

1. **顶栏**：标题「Raindrop Dashboard」、用户 `name`（若有）、右上角「刷新」按钮、token 状态点。
2. **KPI 行**：总收藏 `totals.all`、本月新增（`monthly` 最后一项）、收藏夹 `totals.collections`、标签 `totals.tags`。
3. **类型分布**：6 类横向堆叠条 + 图例（数量与占比）。
4. **收藏夹分布**：按 `count` 降序的横向条形列表（最多 10 个，显示前 3 名以外的可省略；`depth>0` 缩进）。
5. **热门域名 Top**：横向条形列表（最多 8 个），点击在新标签页打开 `https://{domain}`。
6. **热门标签 Top**：chips（最多 16 个），显示数量；点击在新标签页打开
   `https://app.raindrop.io/my/0?search=%23{encodeURIComponent(tag)}`。
7. **待清理**：四张可点小卡：死链 `broken`、无标签 `untagged`、重复 `duplicates`、未分类 `unsorted`；
   分别链到 `https://app.raindrop.io/my/0`、`https://app.raindrop.io/my/0`、`https://app.raindrop.io/my/0`、`https://app.raindrop.io/my/-1`；
   数值为 0 时弱化显示。
8. **最近收藏**：最多 12 条，标题（外链）、域名、类型徽章、标签、相对时间；`broken` 加「死链」标记，`important` 加「重要」标记。
9. **页脚**：`scan.complete ? '全库已扫描' : '基于最近 {scanned} 条样本'`、更新时间、`warnings` 提示（若有）、
   「重新配置 Token」折叠区（password 输入 + 保存 + 清除）。
10. **needs-token 引导**：说明去 `https://app.raindrop.io/settings/integrations` →
    For Developers 创建 Test token，粘贴保存；提供「保存并加载」按钮与错误展示。

### 5.3 Token 流程

- 首次挂载：GET status → `configured=false` 显示引导；`true` 则 GET dashboard。
- 保存：POST token `{ token }` → 成功后 GET dashboard（force=1）。
- 清除：DELETE token → 回到引导态。
- token 输入框 `type="password"`、`autoComplete="off"`；提交中禁用按钮并显示「保存中…」。

## 6. 开发与自测

- 所有 JS 必须先 `node --check <file>` 通过。
- host-dev 写 `test/analytics.test.mjs`、`test/routes.test.mjs`：仅用 `node:*` 内置模块，
  `node test/analytics.test.mjs && node test/routes.test.mjs` 直接可跑，全绿。
  - 覆盖：12 个月补零、域名聚合、类型补零、收藏夹 depth、上限截断；
  - 覆盖：未配置 status、token 保存成功/失败、dashboard 缓存与 force、非回环 403、非法 JSON 400。
- client-dev 只做 `node --check lib/client.js`；**不要**为了预览造 HTML/截图/自建渲染器。
- 完成后给 Lead 发一条消息：改了哪些文件、跑了什么命令、结果、遗留风险。
