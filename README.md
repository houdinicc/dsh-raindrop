# Raindrop Dashboard（`dsh-raindrop`）

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns your
[Raindrop.io](https://raindrop.io) library into a dashboard in the sidebar, and exposes two
read-only agent tools so the agent can analyze your saved content in chat.

> 把 Raindrop.io 收藏库变成 DSH 侧边栏里的分析仪表盘，并给 Agent 两个只读工具，
> 在对话里也能直接分析你的收藏。

- 侧边栏 **Raindrop Dashboard** 入口 → 中央主面板；
- KPI：总收藏 / 本月新增 / 收藏夹 / 标签；
- **分类分布**：按顶层收藏夹聚合（含子收藏夹合计），点击直达 Raindrop；
- **域名来源 Top**：排除 Raindrop 自家上传域（`up.raindrop.io` 等）；
- **内容类型分布**：链接 / 文章 / 图片 / 视频 / 文档 / 音频；
- **近 12 个月新增趋势**；
- **待清理**：死链 / 无标签 / 重复 / 未分类（免费账号拿不到的数据显示「—」，不冒充 0）；
- **最近收藏**：标题外链、域名、类型、标签、相对时间；
- Agent 工具：`raindrop_overview`（聚合统计）、`raindrop_search`（按关键词/标签检索）。

## 安装

**插件市场（桌面版）**：设置 → 插件 → **插件市场** → 搜 `dsh-raindrop` → 安装。

**命令行（`dsh web` 等非 Electron profile）**：

```bash
dsh plugin --profile web add dsh-raindrop
```

**本地开发安装**：让 Agent 调 `plugin_manager` 的 `install_bundle`，`target` 指向本目录。

安装后刷新页面，侧边栏出现 **Raindrop Dashboard** 入口。

> ⚠️ 桌面版 profile（`desktop`）由 Electron 应用独占管理，`dsh plugin` CLI 会拒绝操作它，
> 桌面用户请走插件市场或 `plugin_manager`。

## 配置 Token

1. 打开 <https://app.raindrop.io/settings/integrations>；
2. 在 **For Developers** 下创建一个应用，进入应用设置，复制 **Test token**
   （Test token 不会过期；普通 access token 两周过期）；
3. 回到面板，把 token 粘贴进引导页/页脚的「配置 Token」，点保存。

Token 只保存在宿主侧：`$DSH_HOME/dsh-raindrop/config.json`（目录 0700、文件 0600）。
浏览器只和本机回环路由通信，**token 不会进入页面、日志或 Agent 上下文**。
面板页脚可以随时重新配置或清除 token。

## 配置项

`cordis.patch.yml` 插入插件行 `id: raindrop`，三个配置项：

| 配置 | 默认 | 说明 |
|---|---|---|
| `scanPages` | `8` | 采样页数（每页 50 条）。总数/类型/未分类等精确值来自聚合接口，不受影响；`0` = 完全不采样 |
| `cacheTtlSeconds` | `300` | 数据缓存秒数；面板「刷新」强制绕过 |
| `enableTools` | `true` | 是否注册两个 Agent 工具 |

覆盖方式：在 profile 的 `cordis.patch.yml` 里按 `id: raindrop` 覆盖 `config`（整体替换，字段写全）。

## Agent 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `raindrop_overview` | 无 | 收藏总数/未分类/回收站、类型分布、收藏夹 Top、标签 Top、域名 Top、12 个月趋势、最近样本、数据可用性 |
| `raindrop_search` | `query?` / `tag?` / `collectionId?`（0=全部，-1=未分类） / `limit?`（1–20） | 命中的书签元数据（标题、链接、域名、类型、标签、收藏时间、摘要片段） |

两个工具都只读，不写 Raindrop。

## 数据与口径

- 精确统计来自 Raindrop 聚合接口：`/filters/0`、`/user/stats`、`/collections`、`/tags/0`；
- 域名 Top / 月度趋势 / 最近收藏来自最近 `scanPages × 50` 条样本，面板会标注「基于最近 N 条样本」；
  未分类数、各类型总数、死链/重复等仍是全库精确值；
- **免费账号**的 Raindrop 不返回死链/重复检测数据，这两张卡显示「—」而不是 0；
- 缓存 5 分钟；Raindrop 限流 120 请求/分钟，插件只发少量请求，429 会带重试时间返回。

## HTTP 路由（仅本机回环）

`/api/dsh-raindrop/status`、`/api/dsh-raindrop/token`（POST / DELETE）、`/api/dsh-raindrop/dashboard`。
全部校验来源为 127.0.0.1 / ::1 + 回环 Host 头 + 非 cross-site。

## 兼容性与设计取舍

- **零依赖、零 `import`**：宿主半不 import 任何 `@deepseek-ai/*`，客户端半只 `require('react')`；
  没有 `dependencies` / `peerDependencies`，不需要构建工具链。
- 可选服务用 `ctx.inject([...], cb)` 声明：宿主没有 `webServer` / `tools` 时插件只是少一块能力，
  不会让 DSH 起不来。
- `engines.dsh` 声明实测范围 `>=0.2.0-rc.1 <0.3.0`。
- 客户端 bundle 是手写的 `window.__ModuleLoader__` bundle，无构建步骤；样式只用 `--dsw-alias-*`
  主题 token，跟随亮/暗主题。

## 开发

```
lib/index.js       宿主半入口：apply(ctx, config)
lib/store.js       token 与用户信息缓存（原子写，0600）
lib/api.js         Raindrop REST API 客户端 + 聚合统计
lib/routes.js      GUI 的 HTTP 路由（本机回环围栏）
lib/tools.js       两个 Agent 工具（原始 JSON Schema）
lib/client.js      客户端半：手写 bundle（侧边栏入口 + 仪表盘）
locale/{en,zh}.json 插件在 Plugins 页的显示名与描述
cordis.patch.yml   本 bundle 贡献的配置层
scripts/preflight.mjs   发布前自检（npm pack/publish 自动跑）
scripts/verify-pack.mjs 产物级验证：解包 → 纯 Node import → 假 ctx 断言注册结果
```

测试（零依赖，纯 Node）：

```bash
npm test                         # 统计 15 例 + 路由 14 例 + 工具 schema 子集 9 例
node scripts/preflight.mjs       # 分发契约自检
npm pack && node scripts/verify-pack.mjs   # 产物级验证
```

客户端半（`lib/client.js`）由 `dsh-client-hmr` 轮询 bundle 变化，改完约 1 秒生效；
宿主半是 ESM，Node 按 URL 缓存模块，**改宿主半需要重启 DSH**（`plugin_manager` 的
disable/enable 不会重新 import）。

## License

[MIT](./LICENSE) © 2026 houdinicc
