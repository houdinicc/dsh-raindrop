/**
 * Raindrop Dashboard（dsh-raindrop）—— 产物级验证：不看工作区，只看「别人真正会装到的东西」。
 *
 * `preflight.mjs` 校验源码与分发契约；本脚本校验**打包产物本身**：
 * 解压 → 纯 Node 导入宿主半 → 喂一个假 ctx → 断言它真的注册了 3 条路由与 2 个工具。
 *
 * 这一步能抓到的、preflight 抓不到的问题：
 *   - `files` 漏了某个 `lib/*.js`，导致 import 时解析失败；
 *   - 产物里某个文件被改动过（内容与工作区不一致）；
 *   - 宿主半在「没有 DSH 环境」时 import 就抛错（比如偷偷 import 了 `@deepseek-ai/*`）。
 *
 * 用法：
 *   node scripts/verify-pack.mjs                 # 用当前版本对应的 .tgz
 *   node scripts/verify-pack.mjs <路径或 URL>     # 指定 tarball
 *
 * 环境：需要 `tar`。数据目录指向临时目录，**不会碰真实的 token 配置**。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const problems = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok || detail === undefined ? '' : `\n        → ${detail}`}`);
  if (!ok) problems.push(label);
};

// ------------------------------------------------------------ 1. 取 tarball

const localManifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

async function resolveTarget() {
  const arg = process.argv[2];
  if (arg !== undefined) {
    if (/^https?:\/\//.test(arg)) {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-raindrop-dl-')), 'pkg.tgz');
      const response = await fetch(arg);
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${arg}`);
      fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()));
      return { file: tmp, label: arg, downloaded: true };
    }
    return { file: path.resolve(arg), label: path.resolve(arg), downloaded: false };
  }

  // 只认与当前 manifest 版本一致的那份，避免静默验证了 dist/ 里的旧包。
  const expected = `${localManifest.name}-${localManifest.version}.tgz`;
  const exact = [path.join(root, expected), path.join(root, 'dist', expected)].find((p) => fs.existsSync(p));
  if (exact !== undefined) return { file: exact, label: exact, downloaded: false };

  const dir = path.join(root, 'dist');
  const inDist = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')) : [];
  const inRoot = fs.readdirSync(root).filter((f) => f.endsWith('.tgz'));
  const all = [...inRoot, ...inDist];
  if (all.length === 0) {
    throw new Error(`没找到 ${expected}，${root} 和 dist/ 里也没有任何 .tgz。先跑 \`npm pack\`。`);
  }
  throw new Error(
    `没找到与当前清单版本一致的 ${expected}，但存在其它 tarball：${all.join('、')}。\n`
    + '  先跑 `npm pack` 重新打包，或显式把 tarball 路径作为参数传进来。',
  );
}

const target = await resolveTarget();
console.log(`待验证产物：${target.label}`);
console.log(`大小：${fs.statSync(target.file).size} 字节\n`);

// ---------------------------------------------------------------- 2. 解压

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-raindrop-verify-'));
const extractDir = path.join(workdir, 'x');
fs.mkdirSync(extractDir, { recursive: true });
execFileSync('tar', ['-xzf', target.file, '-C', extractDir], { stdio: 'pipe' });
const pkgDir = path.join(extractDir, 'package');
if (!fs.existsSync(pkgDir)) throw new Error('tarball 里没有 package/ 目录');

const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

// --------------------------------------------------- 3. 清单与文件完整性

check(
  `产物版本与本地清单一致（${manifest.name}@${manifest.version}）`,
  manifest.version === localManifest.version && manifest.name === localManifest.name,
  `本地清单是 ${localManifest.name}@${localManifest.version}；验的可能不是刚打包的那份`,
);

const clientRel = manifest.exports?.['./client'];
const clientPath = typeof clientRel === 'string' ? clientRel : clientRel?.default;

const clientSource = fs.readFileSync(path.join(pkgDir, clientPath), 'utf8');
const bundleId = /__ModuleLoader__\.load\(\s*\{\s*id:\s*['"`]([^'"`]+)['"`]/.exec(clientSource)?.[1];
check(
  `客户端 bundle 的 id 与包名一致（${bundleId} === ${manifest.name}）`,
  bundleId === manifest.name,
  'loader 要求两者完全相同，否则 DSH 加载该插件会失败',
);

const required = [
  manifest.exports?.['.'] ?? manifest.main,
  clientPath,
  manifest.icon,
  manifest.dsh?.bundle?.patch,
  'locale/en.json',
  'locale/zh.json',
];
for (const rel of required) {
  check(`产物含 ${rel}`, typeof rel === 'string' && fs.existsSync(path.join(pkgDir, rel)));
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const leaked = walk(pkgDir).filter((f) => /(^|[\s"'(])\/(Users|home)\/[A-Za-z0-9._-]+\//.test(fs.readFileSync(f, 'utf8')));
check('产物内无本机绝对路径', leaked.length === 0, leaked.join(', '));

// ------------------------------- 4. 导入宿主半（模拟「没有 DSH 的机器」）

let moduleExports = null;
try {
  moduleExports = await import(pathToFileURL(path.join(pkgDir, 'lib', 'index.js')).href);
  check('宿主半可以被纯 Node 直接 import（说明没偷偷 import @deepseek-ai/* 等运行时包）', true);
} catch (error) {
  check('宿主半可以被纯 Node 直接 import', false, String(error?.message ?? error));
}

if (moduleExports !== null) {
  check('导入后导出 apply 函数', typeof moduleExports.apply === 'function');

  // 数据目录指向临时目录，绝不碰真实 token 配置。
  const dataHome = path.join(workdir, 'dsh-home');
  fs.mkdirSync(dataHome, { recursive: true });
  process.env.DSH_HOME = dataHome;

  const routes = [];
  const tools = [];
  const fakeCtx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    inject(_services, callback) {
      callback(this);
      return () => {};
    },
    effect(fn) {
      return fn();
    },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
    tools: { register: (definition) => { tools.push(definition); return () => {}; } },
  };

  try {
    moduleExports.apply(fakeCtx, { scanPages: 8, cacheTtlSeconds: 300, enableTools: true });
    check(`apply(ctx) 注册了 3 条路由（实际 ${routes.length}）`, routes.length === 3);
    check(`apply(ctx) 注册了 2 个 Agent 工具（实际 ${tools.length}）`, tools.length === 2);

    const names = tools.map((t) => t.name).sort();
    check(
      '工具名为 raindrop_overview / raindrop_search',
      names.length === 2 && names[0] === 'raindrop_overview' && names[1] === 'raindrop_search',
      names.join(', '),
    );
    for (const tool of tools) {
      if (typeof tool.output?.render !== 'function') {
        check(`${tool.name} 的 output.render 可用`, false);
      }
    }

    const paths = routes.map((r) => r.path);
    check(
      '路由路径唯一且都以 /api/dsh-raindrop 开头',
      paths.every((p) => p.startsWith('/api/dsh-raindrop')) && new Set(paths).size === paths.length,
      paths.join(', '),
    );

    // 没配 token 时，只读工具应返回结构化的 not-configured，而不是抛异常。
    const overview = tools.find((t) => t.name === 'raindrop_overview');
    if (overview !== undefined) {
      const value = await overview.execute({}, {});
      check(
        '产物里的 raindrop_overview 未配置 token 时返回 not-configured',
        value?.ok === false && value?.code === 'not-configured',
        JSON.stringify(value),
      );
    }
  } catch (error) {
    check('apply(ctx) 能正常执行', false, String(error?.message ?? error));
  }
}

// ---------------------------------------------------------------- 报告

fs.rmSync(workdir, { recursive: true, force: true });
if (!target.downloaded && process.argv[2] === undefined) {
  console.log('\n（只验证了本地 tarball；要验证注册表上的，传 tarball URL：');
  console.log(`   node scripts/verify-pack.mjs https://registry.npmjs.org/${manifest.name}/-/${manifest.name}-${manifest.version}.tgz ）`);
}

if (problems.length > 0) {
  console.error(`\n产物验证未通过：${problems.length} 项`);
  process.exit(1);
}
console.log('\n产物验证通过。');
