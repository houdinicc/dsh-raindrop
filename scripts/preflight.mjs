/**
 * Raindrop Dashboard（dsh-raindrop）—— 发布前自检。
 *
 * `npm pack` / `npm publish` 之前由 `prepack` 自动跑（`npm run preflight` 也能手动跑）。
 * 校验的都是**会让别人装不上或让 DSH 起不来**的硬约束：
 *
 *   1. 清单本身：可发布（无 `private`）、必备字段齐全、`engines.dsh` 声明了宿主范围；
 *   2. bundle 契约：`dsh.bundle.patch` 与 `exports["./client"]` 存在且能解析；
 *   3. **模块 id 必须等于包名** —— 客户端 bundle 的 `window.__ModuleLoader__.load({ id })`
 *      与包名不一致时，DSH 启动会响亮失败（这正是 loader 强制的规则）；
 *   4. **工具 schema 必须落在 Harness 的 JSON Schema 子集内** —— 违反时 `register()`
 *      抛错并回滚整个工具注册，表现是「路由正常、工具表里没有工具」；
 *   5. 清单引用的文件都真实存在（icon / locale / patch / 入口）；
 *   6. 不允许把**本机绝对路径**带出去（开发机的 HMR 覆盖曾经就藏在补丁里）；
 *   7. `files` 覆盖了运行时真正需要的一切，且不含 test/dev/scripts。
 *
 * 运行：node scripts/preflight.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSchema } from '../test/schema-subset.mjs';
import { createTools } from '../lib/tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(root, rel));
const readText = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const problems = [];
const notes = [];
const fail = (message) => problems.push(message);

const manifest = readJson('package.json');
const name = manifest.name;

// ------------------------------------------------------------ 1. 清单本身

if (manifest.private === true) {
  fail('`private: true` 会让 npm 拒绝发布，分发前必须删掉。');
}
if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name ?? '')) {
  fail(`包名 ${JSON.stringify(name)} 不是合法的 npm 名。`);
}
if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
  fail('缺少合法的 `version`。');
}
if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
  fail('缺少 `description`（插件市场与 Plugins 页都显示它）。');
} else if (!/[·|]/.test(manifest.description)) {
  notes.push('description 建议同时给出中英两版（插件市场按语言显示）。');
}
if (typeof manifest.license !== 'string' || manifest.license.trim() === '') {
  fail('缺少 `license`：别人无法合法使用你的插件。');
}
if (!Array.isArray(manifest.keywords) || !manifest.keywords.includes('dsh-plugin')) {
  fail('缺少 `dsh-plugin` 关键词：npm 搜索与人工检索都靠它。');
}
if (!manifest.engines || typeof manifest.engines.dsh !== 'string') {
  fail('未声明 `engines.dsh`：插件市场无法按宿主版本提示兼容性。');
}
if (manifest.repository === undefined) {
  fail('未声明 `repository`：插件目录条目需要 GitHub 仓库地址，更新检查也用它。');
}

// ------------------------------------------------------------ 2. bundle 契约

if (manifest.dsh === undefined) fail('缺少 `dsh` 段：这不是一个 DSH bundle。');
const patchRef = manifest.dsh?.bundle?.patch;
const patchList = Array.isArray(patchRef) ? patchRef : patchRef === undefined ? [] : [patchRef];
if (patchList.length === 0) fail('`dsh.bundle.patch` 未声明：安装后不会插入任何插件行。');
for (const rel of patchList) {
  if (!exists(rel)) fail(`\`dsh.bundle.patch\` 指向的 ${rel} 不存在。`);
}

if (manifest.dsh?.client === undefined) {
  fail('缺少 `dsh.client`：GUI 那一半不会被加载。');
} else if (manifest.dsh.client.platform !== 'web') {
  fail('`dsh.client.platform` 应为 "web"。');
}
const clientRel = manifest.exports?.['./client'];
const clientPath = typeof clientRel === 'string' ? clientRel : clientRel?.default;
if (typeof clientPath !== 'string') {
  fail('`exports["./client"]` 必须指向客户端 bundle（字符串或带 default 的对象）。');
} else if (!exists(clientPath)) {
  fail(`\`exports["./client"]\` 指向的 ${clientPath} 不存在。`);
}

const mainRel = manifest.exports?.['.'] ?? manifest.main;
const mainPath = typeof mainRel === 'string' ? mainRel : mainRel?.default;
if (typeof mainPath !== 'string' || !exists(mainPath)) {
  fail('宿主半入口（`exports["."]` 或 `main`）缺失或指向不存在的文件。');
}

// 补丁行必须插入本包，且行 id 与客户端面板 key 约定一致。
for (const rel of patchList) {
  if (!exists(rel)) continue;
  const patchText = readText(rel);
  if (!patchText.includes(`name: '${name}'`) && !patchText.includes(`name: "${name}"`)) {
    fail(`${rel} 里没有插入 name: ${name} 的插件行。`);
  }
  if (!/id:\s*raindrop\b/.test(patchText)) {
    notes.push(`${rel} 的插件行 id 不是 'raindrop'（客户端面板 key 依赖它）。`);
  }
}

// ------------------------------------ 3. 客户端 bundle 的 id 必须等于包名

if (typeof clientPath === 'string' && exists(clientPath)) {
  const source = readText(clientPath);
  const match = /__ModuleLoader__\.load\(\s*\{\s*id:\s*['"`]([^'"`]+)['"`]/.exec(source);
  if (match === null) {
    fail(`客户端 bundle ${clientPath} 里找不到 \`window.__ModuleLoader__.load({ id })\` 自注册。`);
  } else if (match[1] !== name) {
    fail(
      `客户端 bundle 的 id ${JSON.stringify(match[1])} 与包名 ${JSON.stringify(name)} 不一致。`
      + ' loader 要求两者完全相同，否则 DSH 加载该插件时会失败。',
    );
  }
}

// --------------------------------- 4. Agent 工具 schema 必须满足 Harness 子集

try {
  const store = {
    config: { scanPages: 8, cacheTtlSeconds: 300, enableTools: true },
    file: path.join(root, 'package.json'),
    readToken: () => null,
  };
  const tools = createTools(store);
  if (tools.length !== 2) fail(`应注册 2 个 Agent 工具，实际 ${tools.length} 个。`);
  for (const tool of tools) {
    for (const [label, schema] of [['parameters', tool.parameters], ['output.schema', tool.output?.schema]]) {
      const violations = checkSchema(schema, `${tool.name}.${label}`);
      if (violations.length > 0) fail(`${tool.name} 的 ${label} 不在 Harness JSON Schema 子集内：${violations.join('; ')}`);
    }
    if (typeof tool.output?.render !== 'function') fail(`${tool.name} 缺少 output.render。`);
  }
} catch (error) {
  fail(`工具定义无法加载：${error?.message ?? error}`);
}

// -------------------------------------------- 5/6. 清单引用的文件 + 绝对路径

for (const rel of [manifest.icon]) {
  if (typeof rel === 'string' && !exists(rel)) fail(`\`icon\` 指向的 ${rel} 不存在。`);
}

for (const rel of ['locale/en.json', 'locale/zh.json']) {
  if (!exists(rel)) notes.push(`缺少 ${rel}：Plugins 页会退回 package.json 的 name/description。`);
}

/** 待发布的文件清单：files 白名单 + npm 永远包含的几个。 */
function shippedFiles() {
  const out = ['package.json', 'README.md', 'LICENSE'];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(abs)) walk(path.join(rel, entry));
    } else {
      out.push(rel);
    }
  };
  for (const entry of manifest.files ?? []) walk(entry);
  return [...new Set(out)];
}

const shipped = shippedFiles();
const shippedSet = new Set(shipped);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const SKIP_EXT = new Set(['.tgz', '.woff', '.woff2', '.ttf', '.png', '.jpg', '.jpeg', '.webp', '.icns']);
const PATH_PATTERN = /(^|[\s"'(])\/(Users|home)\/[A-Za-z0-9._-]+\//;

function scanForLocalPaths(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      scanForLocalPaths(abs, relPath);
      continue;
    }
    if (SKIP_EXT.has(path.extname(entry.name))) continue;
    if (fs.statSync(abs).size > 512 * 1024) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue; // 二进制文件，跳过
    }
    const hit = PATH_PATTERN.exec(text);
    if (hit === null) continue;
    const where = shippedSet.has(relPath)
      ? '**该文件会进 npm 包**，别人会看到'
      : '本仓库是公开仓库，别人 clone 后也会看到';
    fail(`${relPath} 里含本机绝对路径（${hit[0].trim()}…）—— ${where}。`);
  }
}
scanForLocalPaths(root);

// ------------------------------------------------ 7. files 是否漏了运行时文件

for (const required of ['lib', 'locale', 'cordis.patch.yml', 'icon.svg']) {
  const listed = (manifest.files ?? []).some((entry) => entry === required || entry.startsWith(`${required}/`));
  if (!listed) fail(`\`files\` 未包含 ${required}：发布出去的包里会缺文件。`);
}
for (const unwanted of ['test', 'dev', 'scripts']) {
  if ((manifest.files ?? []).includes(unwanted)) {
    fail(`\`files\` 不应包含 ${unwanted}/：那是开发期文件，不该进别人的 node_modules。`);
  }
}

// ---------------------------------------------------------------- 报告

console.log(`包名：${name}@${manifest.version}`);
console.log(`将发布 ${shipped.length} 个文件：`);
for (const rel of shipped) console.log(`  ${rel}`);

if (notes.length > 0) {
  console.log('\n提醒（不阻塞发布）：');
  for (const note of notes) console.log(`  · ${note}`);
}

if (problems.length > 0) {
  console.error(`\n自检未通过，${problems.length} 个问题：`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log('\n自检通过。');
