/**
 * 宿主半离线测试（二）：HTTP 路由的围栏、信封、token 流程与 dashboard 缓存。
 *
 * 只用 node:* 内置模块；fetch 用假实现、时间用假 now，不碰真实 Raindrop，
 * 也不注册任何真实 HTTP server。运行：`node test/routes.test.mjs`
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes, isLoopbackRequest } from '../lib/routes.js';
import { createStore } from '../lib/store.js';

// ------------------------------------------------------------- 测试小框架

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const PREFIX = '/api/dsh-raindrop';

function jsonResponse(body, status = 200, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    async json() {
      return body;
    },
  };
}

/** 假 fetch：routes 以去掉 `/rest/v1` 后的 pathname 为键。记录所有调用。 */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url, pathname: parsed.pathname, search: parsed.search, init });
    const key = parsed.pathname.replace(/^\/rest\/v1/, '');
    const route = routes[key];
    if (route === undefined) throw new Error(`unexpected request: ${url}`);
    const result = typeof route === 'function' ? await route(parsed, init) : route;
    return jsonResponse(result.body, result.status ?? 200, result.headers ?? {});
  };
}

const raindropFixtureItem = {
  _id: 1,
  title: 'A bookmark',
  link: 'https://example.com/a',
  domain: 'example.com',
  excerpt: 'hello',
  type: 'link',
  tags: ['js'],
  created: '2026-06-01T00:00:00.000Z',
  important: false,
  broken: false,
  collection: { $id: 10 },
};

function raindropRoutes(overrides = {}) {
  return {
    '/user': () => ({ body: { result: true, user: { fullName: 'Alice', pro: true } } }),
    '/filters/0': () => ({
      body: {
        result: true,
        broken: { count: 1 },
        duplicates: { count: 2 },
        important: { count: 3 },
        notag: { count: 4 },
        types: [{ _id: 'link', count: 10 }],
      },
    }),
    '/user/stats': () => ({
      body: {
        result: true,
        items: [
          { _id: 0, count: 50 },
          { _id: -1, count: 5 },
          { _id: -99, count: 1 },
        ],
        meta: { broken: { count: 1 }, duplicates: { count: 2 } },
      },
    }),
    '/collections': () => ({ body: { result: true, items: [{ _id: 10, title: 'Dev', count: 40 }] } }),
    '/collections/childrens': () => ({ body: { result: true, items: [] } }),
    '/tags/0': () => ({ body: { result: true, items: [{ _id: 'js', count: 7 }] } }),
    '/raindrops/0': () => ({ body: { result: true, count: 1, items: [raindropFixtureItem] } }),
    ...overrides,
  };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk);
    },
  };
}

function makeReq({
  method = 'GET',
  pathname = '/status',
  query = '',
  host = '127.0.0.1:57168',
  remoteAddress = '127.0.0.1',
  headers = {},
  body = null,
} = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) normalized[key.toLowerCase()] = value;
  const req = {
    method,
    url: `${PREFIX}${pathname}${query}`,
    headers: { host, ...normalized },
    socket: { remoteAddress },
  };
  req[Symbol.asyncIterator] = async function* iterator() {
    if (body !== null) yield Buffer.from(body);
  };
  return req;
}

async function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-raindrop-routes-'));
  try {
    const store = createStore({
      dir,
      defaults: { scanPages: 1, cacheTtlSeconds: 300, enableTools: true },
    });
    return await fn(store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function routeFor(routes, pathname) {
  const route = routes.find((entry) => entry.path === `${PREFIX}${pathname}`);
  assert.ok(route !== undefined, `missing route ${pathname}`);
  return route;
}

/** 3 条 exact 路由；POST/DELETE `/token` 合并注册在索引 1。 */
const ROUTE_INDEX = {
  'GET /status': 0,
  'POST /token': 1,
  'DELETE /token': 1,
  'GET /dashboard': 2,
};

/** 调一个路由并解析 JSON 信封。 */
async function call(routes, { method = 'GET', pathname = '/status', query = '', headers = {}, body = null, remoteAddress, host } = {}) {
  const res = makeRes();
  const req = makeReq({
    method,
    pathname,
    query,
    body,
    remoteAddress,
    host,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
  const index = ROUTE_INDEX[`${method} ${pathname}`];
  const route = index === undefined ? routeFor(routes, pathname) : routes[index];
  await route.handler(req, res);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  return { status: res.statusCode, headers: res.headers, body: res.body === '' ? null : JSON.parse(res.body) };
}

const NOW = new Date('2026-06-15T10:00:00.000Z');

// ------------------------------------------------------------- 回环围栏

test('isLoopbackRequest：接受本机回环，拒绝跨站/非回环 Host', () => {
  assert.equal(isLoopbackRequest(makeReq({ remoteAddress: '127.0.0.1' })), true);
  assert.equal(isLoopbackRequest(makeReq({ remoteAddress: '::1', host: 'localhost:57168' })), true);
  assert.equal(isLoopbackRequest(makeReq({ remoteAddress: '::ffff:127.0.0.1' })), true);

  assert.equal(isLoopbackRequest(makeReq({ remoteAddress: '192.168.1.9' })), false);
  assert.equal(isLoopbackRequest(makeReq({ host: 'evil.example:443' })), false);
  assert.equal(
    isLoopbackRequest(makeReq({ headers: { 'sec-fetch-site': 'cross-site' } })),
    false,
  );
  assert.equal(
    isLoopbackRequest(makeReq({ headers: { 'sec-fetch-site': 'same-origin' } })),
    true,
  );
});

test('非回环请求一律 403 forbidden，且不触发上游调用', async () => {
  const calls = [];
  const routes = createRoutes(
    { readToken: () => 'tok', readUserCache: () => null, config: { scanPages: 1, cacheTtlSeconds: 300 } },
    { fetchImpl: fakeFetch(raindropRoutes(), calls), now: () => NOW },
  );
  for (const pathname of ['/status', '/dashboard']) {
    const result = await call(routes, {
      pathname,
      remoteAddress: '10.0.0.7',
    });
    assert.equal(result.status, 403);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'forbidden');
  }
  assert.equal(calls.length, 0);
});

test('路由表：3 条 exact 路由，方法/路径与契约一致', async () => {
  await withStore(async (store) => {
    const routes = createRoutes(store, { fetchImpl: fakeFetch(raindropRoutes()), now: () => NOW });
    assert.equal(routes.length, 3);
    assert.deepEqual(
      routes.map((entry) => `${entry.kind} ${entry.path}`),
      [
        'exact /api/dsh-raindrop/status',
        'exact /api/dsh-raindrop/token',
        'exact /api/dsh-raindrop/dashboard',
      ],
    );

    // 回归：webServer.register 以 (kind,path) 判重；重复会让第二次 register 抛错，
    // 并中断后续路由与工具注册（实测：status 可用、dashboard 401、工具消失）。
    const keys = routes.map((entry) => `${entry.kind} ${entry.path}`);
    assert.equal(new Set(keys).size, keys.length, `存在重复路由：${keys.join(' | ')}`);

    assert.ok(routes.every((entry) => typeof entry.handler === 'function'));

    // 未预期方法统一 404 not-found。
    for (const probe of [
      { method: 'PUT', pathname: '/status' },
      { method: 'POST', pathname: '/dashboard' },
      { method: 'GET', pathname: '/token' },
      { method: 'PATCH', pathname: '/token' },
    ]) {
      const result = await call(routes, probe);
      assert.equal(result.status, 404);
      assert.equal(result.body.error.code, 'not-found');
    }
  });
});

test('回归：/token 单条路由按 req.method 分发 POST 保存 / DELETE 清除', async () => {
  await withStore(async (store) => {
    const calls = [];
    const routes = createRoutes(store, {
      fetchImpl: fakeFetch(raindropRoutes(), calls),
      now: () => NOW,
    });
    const tokenRoutes = routes.filter(
      (entry) => entry.kind === 'exact' && entry.path === `${PREFIX}/token`,
    );
    assert.equal(tokenRoutes.length, 1);

    const saved = await call(routes, {
      method: 'POST',
      pathname: '/token',
      body: JSON.stringify({ token: 'merged-token-wxyz' }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.value, {
      configured: true,
      masked: '••••wxyz',
      user: { name: 'Alice', pro: true },
    });
    assert.equal(store.readToken(), 'merged-token-wxyz');
    // 同一条路由里 POST 分支只验证一次 /user。
    assert.equal(calls.length, 1);

    const cleared = await call(routes, { method: 'DELETE', pathname: '/token' });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.value, { configured: false, masked: null, user: null });
    assert.equal(store.readToken(), null);
    assert.equal(store.readUserCache(), null);
  });
});

// ------------------------------------------------------------ status 路由

test('GET status：未配置时 configured=false / masked=null / user=null', async () => {
  await withStore(async (store) => {
    const routes = createRoutes(store, { fetchImpl: fakeFetch(raindropRoutes()), now: () => NOW });
    const result = await call(routes, { pathname: '/status' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      ok: true,
      value: { configured: false, masked: null, user: null },
    });
  });
});

// ------------------------------------------------------------- token 路由

test('POST token：先验证 /user，成功才落盘并返回掩码', async () => {
  await withStore(async (store) => {
    const calls = [];
    const routes = createRoutes(store, { fetchImpl: fakeFetch(raindropRoutes(), calls), now: () => NOW });

    const result = await call(routes, {
      method: 'POST',
      pathname: '/token',
      body: JSON.stringify({ token: 'secret-token-abcd' }),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      ok: true,
      value: { configured: true, masked: '••••abcd', user: { name: 'Alice', pro: true } },
    });
    assert.equal(store.readToken(), 'secret-token-abcd');
    assert.deepEqual(store.readUserCache(), { name: 'Alice', pro: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.headers.authorization, 'Bearer secret-token-abcd');

    // 后续 status 直接读缓存，不触发上游。
    const status = await call(routes, { pathname: '/status' });
    assert.deepEqual(status.body.value, {
      configured: true,
      masked: '••••abcd',
      user: { name: 'Alice', pro: true },
    });
    assert.equal(calls.length, 1);
  });
});

test('POST token：Raindrop 401 → HTTP 401 invalid-token，且不落盘', async () => {
  await withStore(async (store) => {
    const routes = createRoutes(store, {
      fetchImpl: fakeFetch(raindropRoutes({ '/user': { status: 401, body: { result: false } } })),
      now: () => NOW,
    });
    const result = await call(routes, {
      method: 'POST',
      pathname: '/token',
      body: JSON.stringify({ token: 'bad-token' }),
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'invalid-token');
    assert.equal(store.readToken(), null);
    assert.equal(store.readUserCache(), null);
  });
});

test('POST token：网络失败 → 502 upstream；429 → 429 rate-limited 带 retryAfter', async () => {
  await withStore(async (store) => {
    const offline = createRoutes(store, {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
      now: () => NOW,
    });
    const network = await call(offline, {
      method: 'POST',
      pathname: '/token',
      body: JSON.stringify({ token: 'whatever' }),
    });
    assert.equal(network.status, 502);
    assert.equal(network.body.error.code, 'upstream');
    assert.equal(store.readToken(), null);

    const limited = createRoutes(store, {
      fetchImpl: fakeFetch(raindropRoutes({
        '/user': { status: 429, body: { result: false }, headers: { 'retry-after': '30' } },
      })),
      now: () => NOW,
    });
    const rateLimited = await call(limited, {
      method: 'POST',
      pathname: '/token',
      body: JSON.stringify({ token: 'whatever' }),
    });
    assert.equal(rateLimited.status, 429);
    assert.equal(rateLimited.body.error.code, 'rate-limited');
    assert.equal(rateLimited.body.error.retryAfter, 30);
    assert.equal(store.readToken(), null);
  });
});

test('POST token：非法 body / 非 JSON content-type / 超限都 400 invalid-body', async () => {
  await withStore(async (store) => {
    const routes = createRoutes(store, { fetchImpl: fakeFetch(raindropRoutes()), now: () => NOW });

    const invalidJson = await call(routes, {
      method: 'POST',
      pathname: '/token',
      body: 'not json at all',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.error.code, 'invalid-body');

    const notJsonType = await call(routes, {
      method: 'POST',
      pathname: '/token',
      body: JSON.stringify({ token: 'abc' }),
      headers: { 'content-type': 'text/plain' },
    });
    assert.equal(notJsonType.status, 400);
    assert.equal(notJsonType.body.error.code, 'invalid-body');

    for (const body of [JSON.stringify({}), JSON.stringify({ token: '' }), JSON.stringify({ token: 42 })]) {
      const result = await call(routes, { method: 'POST', pathname: '/token', body });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, 'invalid-body');
    }

    const oversized = await call(routes, {
      method: 'POST',
      pathname: '/token',
      body: JSON.stringify({ token: 'x'.repeat(17 * 1024) }),
    });
    assert.equal(oversized.status, 400);
    assert.equal(oversized.body.error.code, 'invalid-body');

    assert.equal(store.readToken(), null);
  });
});

test('DELETE token：清除配置并返回未配置信封', async () => {
  await withStore(async (store) => {
    store.writeToken('secret-token-abcd');
    store.writeUserCache({ name: 'Alice', pro: true });
    const routes = createRoutes(store, { fetchImpl: fakeFetch(raindropRoutes()), now: () => NOW });

    const result = await call(routes, { method: 'DELETE', pathname: '/token' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      ok: true,
      value: { configured: false, masked: null, user: null },
    });
    assert.equal(store.readToken(), null);
    assert.equal(store.readUserCache(), null);
  });
});

// --------------------------------------------------------- dashboard 路由

test('GET dashboard：未配置 token → 400 not-configured', async () => {
  await withStore(async (store) => {
    const routes = createRoutes(store, { fetchImpl: fakeFetch(raindropRoutes()), now: () => NOW });
    const result = await call(routes, { pathname: '/dashboard' });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'not-configured');
  });
});

test('GET dashboard：返回契约 §4.2 的完整 value', async () => {
  await withStore(async (store) => {
    store.writeToken('secret-token-abcd');
    store.writeUserCache({ name: 'Alice', pro: true });
    const calls = [];
    const routes = createRoutes(store, {
      fetchImpl: fakeFetch(raindropRoutes(), calls),
      now: () => NOW,
    });

    const result = await call(routes, { pathname: '/dashboard' });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    const value = result.body.value;

    assert.equal(value.generatedAt, NOW.toISOString());
    assert.deepEqual(value.user, { name: 'Alice', pro: true });
    assert.deepEqual(value.totals, {
      all: 50,
      unsorted: 5,
      trash: 1,
      collections: 1,
      tags: 1,
      broken: 1,
      duplicates: 2,
      important: 3,
      untagged: 4,
    });
    assert.equal(value.types.length, 6);
    assert.deepEqual(value.types[0], { type: 'link', count: 10 });
    assert.deepEqual(value.collections, [{ id: 10, parentId: null, title: 'Dev', count: 40, depth: 0 }]);
    assert.deepEqual(value.tags, [{ name: 'js', count: 7 }]);
    assert.deepEqual(value.domains, [{ domain: 'example.com', count: 1 }]);
    assert.equal(value.monthly.length, 12);
    assert.equal(value.monthly.at(-1).month, '2026-06');
    assert.equal(value.monthly.at(-1).count, 1);
    assert.equal(value.recent.length, 1);
    assert.deepEqual(value.recent[0], {
      id: 1,
      title: 'A bookmark',
      link: 'https://example.com/a',
      domain: 'example.com',
      type: 'link',
      tags: ['js'],
      created: '2026-06-01T00:00:00.000Z',
      important: false,
      broken: false,
      collectionId: 10,
    });
    assert.deepEqual(value.scan, { scanned: 1, total: 1, pages: 1, complete: true });
    assert.deepEqual(value.warnings, []);

    // user 1 + aggregates 5 + sample 1。
    assert.equal(calls.length, 7);
  });
});

test('GET dashboard：缓存命中、force=1 绕过、TTL 过期后重取、换 token 失效', async () => {
  await withStore(async (store) => {
    store.writeToken('token-abcdef');
    store.writeUserCache({ name: 'Alice', pro: true });
    let current = NOW;
    const calls = [];
    const routes = createRoutes(store, {
      fetchImpl: fakeFetch(raindropRoutes(), calls),
      now: () => current,
    });

    const first = await call(routes, { pathname: '/dashboard' });
    assert.equal(calls.length, 7);
    assert.equal(first.body.value.generatedAt, NOW.toISOString());

    // TTL 内 → 命中缓存，不再发请求。
    const cached = await call(routes, { pathname: '/dashboard' });
    assert.equal(calls.length, 7);
    assert.deepEqual(cached.body.value, first.body.value);

    // force=1 → 绕过缓存。
    const forced = await call(routes, { pathname: '/dashboard', query: '?force=1' });
    assert.equal(calls.length, 14);
    assert.equal(forced.body.ok, true);

    // 超过 TTL（300s）→ 重取。
    current = new Date(NOW.getTime() + 301_000);
    const expired = await call(routes, { pathname: '/dashboard' });
    assert.equal(calls.length, 21);
    assert.equal(expired.body.value.generatedAt, current.toISOString());

    // 换 token → 旧缓存自然失效。
    store.writeToken('token-other');
    store.writeUserCache({ name: 'Alice', pro: true });
    await call(routes, { pathname: '/dashboard' });
    assert.equal(calls.length, 28);
  });
});

test('GET dashboard：上游 401 → HTTP 401 invalid-token；单接口 429 按降级处理', async () => {
  await withStore(async (store) => {
    store.writeToken('token-abcdef');
    store.writeUserCache({ name: 'Alice', pro: true });

    const invalid = createRoutes(store, {
      fetchImpl: fakeFetch(raindropRoutes({
        '/filters/0': { status: 401, body: { result: false } },
      })),
      now: () => NOW,
    });
    const invalidResult = await call(invalid, { pathname: '/dashboard' });
    assert.equal(invalidResult.status, 401);
    assert.equal(invalidResult.body.error.code, 'invalid-token');

    // 契约 §3.3：聚合接口失败要降级出部分数据（401 除外），所以单接口 429 不整体失败。
    const limited = createRoutes(store, {
      fetchImpl: fakeFetch(raindropRoutes({
        '/user/stats': { status: 429, body: { result: false }, headers: { 'retry-after': '9' } },
      })),
      now: () => NOW,
    });
    const limitedResult = await call(limited, { pathname: '/dashboard' });
    assert.equal(limitedResult.status, 200);
    assert.ok(limitedResult.body.value.warnings.includes('stats-unavailable'));
    assert.equal(limitedResult.body.value.totals.all, 0);
  });
});

// ------------------------------------------------------------------ 执行

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error);
  }
}
if (failed > 0) {
  console.error(`${failed}/${tests.length} 项失败`);
  process.exit(1);
}
console.log(`${tests.length} 项全部通过`);
