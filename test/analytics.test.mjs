/**
 * 宿主半离线测试（一）：聚合口径、降级、Dashboard 载荷与 Agent 工具。
 *
 * 只用 node:* 内置模块；网络用假 fetch，时间用假 now，不碰真实 Raindrop。
 * 运行：`node test/analytics.test.mjs`
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CANONICAL_TYPES, RaindropError, buildDashboard, createClient } from '../lib/api.js';
import { createStore, resolveDataDir } from '../lib/store.js';
import { createTools } from '../lib/tools.js';

// ------------------------------------------------------------- 测试小框架

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ------------------------------------------------------------------ 工具

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

/** 假 fetch：routes 以去掉 `/rest/v1` 后的 pathname 为键，值可以是对象或函数。 */
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

function filtersBody(overrides = {}) {
  return {
    result: true,
    broken: { count: 12 },
    duplicates: { count: 3 },
    important: { count: 7 },
    notag: { count: 42 },
    types: [
      { _id: 'link', count: 100 },
      { _id: 'article', count: 40 },
      { _id: 'image', count: 10 },
    ],
    ...overrides,
  };
}

function statsBody(overrides = {}) {
  return {
    result: true,
    items: [
      { _id: 0, count: 1000 },
      { _id: -1, count: 5 },
      { _id: -99, count: 2 },
    ],
    meta: { broken: { count: 9 }, duplicates: { count: 4 } },
    ...overrides,
  };
}

const baseRoutes = () => ({
  '/user': { body: { result: true, user: { fullName: 'Alice', pro: true } } },
  '/filters/0': { body: filtersBody() },
  '/user/stats': { body: statsBody() },
  '/collections': {
    body: {
      result: true,
      items: [
        { _id: 10, title: 'Dev', count: 300 },
        { _id: 20, title: 'Design', count: 120 },
      ],
    },
  },
  '/collections/childrens': {
    body: {
      result: true,
      items: [
        { _id: 11, title: 'JS', count: 200, parent: { $id: 10 } },
        { _id: 12, title: 'TS', count: 50, parent: { $id: 10 } },
        { _id: 21, title: 'UI', count: 80, parent: { $id: 20 } },
      ],
    },
  },
  '/tags/0': { body: { result: true, items: [{ _id: 'js', count: 30 }, { _id: 'css', count: 20 }] } },
  '/raindrops/0': { body: { result: true, count: 0, items: [] } },
});

function memoryStore(token, config = {}) {
  let currentToken = token;
  let user = null;
  return {
    config: { scanPages: 1, cacheTtlSeconds: 300, enableTools: true, ...config },
    readToken: () => currentToken,
    writeToken(value) {
      currentToken = value;
      user = null;
    },
    clearToken() {
      currentToken = null;
      user = null;
    },
    readUserCache: () => user,
    writeUserCache(value) {
      user = value;
    },
  };
}

const item = (id, overrides = {}) => ({
  _id: id,
  title: `Item ${id}`,
  link: `https://example.com/${id}`,
  domain: 'example.com',
  excerpt: '',
  type: 'link',
  tags: ['tag'],
  created: new Date(2026, 5, 10, 12, 0, 0).toISOString(),
  important: false,
  broken: false,
  collection: { $id: 10 },
  ...overrides,
});

test('resolveDataDir：尊重 DSH_HOME，缺省 ~/.dsh/dsh-raindrop', () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = '/tmp/dsh-home-test';
    assert.equal(resolveDataDir(), path.join('/tmp/dsh-home-test', 'dsh-raindrop'));
    delete process.env.DSH_HOME;
    assert.equal(resolveDataDir(), path.join(os.homedir(), '.dsh', 'dsh-raindrop'));
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('createClient：client.buildDashboard(options) 与模块级 buildDashboard 等价', async () => {
  const client = createClient({ token: 'tok', fetchImpl: fakeFetch(baseRoutes()) });
  assert.equal(typeof client.buildDashboard, 'function');
  const dashboard = await client.buildDashboard({
    scanPages: 0,
    generatedAt: new Date(2026, 5, 15, 12, 0, 0).toISOString(),
  });
  assert.equal(dashboard.scan.pages, 0);
  assert.equal(dashboard.types.length, 6);
  assert.equal(dashboard.monthly.length, 12);
  assert.deepEqual(dashboard.user, { name: 'Alice', pro: true });
});

// ------------------------------------------------------- api.aggregates()

test('aggregates：总数/类型补零/收藏夹 depth/标签上限 20', async () => {
  const routes = baseRoutes();
  routes['/filters/0'] = {
    body: filtersBody({
      broken: { count: 12 },
      duplicates: { count: 3 },
      important: { count: 7 },
      notag: { count: 42 },
      types: [
        { _id: 'link', count: 100 },
        { _id: 'article', count: 40 },
      ],
    }),
  };
  routes['/tags/0'] = {
    body: {
      result: true,
      items: Array.from({ length: 25 }, (_, index) => ({ _id: `tag-${index}`, count: index + 1 })),
    },
  };

  const calls = [];
  const client = createClient({ token: 'tok-123', fetchImpl: fakeFetch(routes, calls) });
  const result = await client.aggregates();

  assert.deepEqual(result.totals, {
    all: 1000,
    unsorted: 5,
    trash: 2,
    collections: 5,
    tags: 25,
    broken: 12,
    duplicates: 3,
    important: 7,
    untagged: 42,
  });

  // 固定 6 项、规范顺序、缺失补 0。
  assert.deepEqual(
    result.types.map((entry) => entry.type),
    CANONICAL_TYPES,
  );
  assert.deepEqual(result.types, [
    { type: 'link', count: 100 },
    { type: 'article', count: 40 },
    { type: 'image', count: 0 },
    { type: 'video', count: 0 },
    { type: 'document', count: 0 },
    { type: 'audio', count: 0 },
  ]);

  // count 降序；depth 由 parent.$id 重建。
  assert.deepEqual(result.collections, [
    { id: 10, parentId: null, title: 'Dev', count: 300, depth: 0 },
    { id: 11, parentId: 10, title: 'JS', count: 200, depth: 1 },
    { id: 20, parentId: null, title: 'Design', count: 120, depth: 0 },
    { id: 21, parentId: 20, title: 'UI', count: 80, depth: 1 },
    { id: 12, parentId: 10, title: 'TS', count: 50, depth: 1 },
  ]);

  // 最多 20 项，且按 count 降序。
  assert.equal(result.tags.length, 20);
  assert.equal(result.tags[0].name, 'tag-24');
  assert.equal(result.tags[0].count, 25);
  assert.deepEqual(result.warnings, []);

  // 请求头与 URL 拼装。
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.init.headers.authorization, 'Bearer tok-123');
    assert.equal(call.init.headers.accept, 'application/json');
    assert.equal(call.init.method, 'GET');
  }
});

test('aggregates 降级：filters 失败用 stats.meta 兜底，tags/collections 失败给 warning', async () => {
  const routes = baseRoutes();
  routes['/filters/0'] = { status: 500, body: { result: false, errorMessage: 'boom' } };
  routes['/tags/0'] = { status: 500, body: { result: false } };
  routes['/collections'] = { status: 500, body: { result: false } };

  const client = createClient({ token: 'tok', fetchImpl: fakeFetch(routes) });
  const result = await client.aggregates();

  assert.deepEqual(result.warnings, [
    'filters-unavailable',
    'tags-unavailable',
    'collections-unavailable',
  ]);
  assert.deepEqual(result.totals, {
    all: 1000,
    unsorted: 5,
    trash: 2,
    collections: 0,
    tags: 0,
    broken: 9, // stats.meta.broken.count
    duplicates: 4, // stats.meta.duplicates.count
    important: 0,
    untagged: 0,
  });
  assert.deepEqual(result.types, CANONICAL_TYPES.map((type) => ({ type, count: 0 })));
  assert.deepEqual(result.collections, []);
  assert.deepEqual(result.tags, []);
});

test('aggregates 降级：stats 失败时总数置 0，其余精确值仍来自 filters', async () => {
  const routes = baseRoutes();
  routes['/user/stats'] = { status: 500, body: { result: false } };

  const client = createClient({ token: 'tok', fetchImpl: fakeFetch(routes) });
  const result = await client.aggregates();

  assert.ok(result.warnings.includes('stats-unavailable'));
  assert.equal(result.totals.all, 0);
  assert.equal(result.totals.unsorted, 0);
  assert.equal(result.totals.trash, 0);
  assert.equal(result.totals.broken, 12);
  assert.equal(result.types[0].count, 100);
});

test('aggregates：401 不被降级，抛出 invalid-token', async () => {
  const routes = baseRoutes();
  routes['/user/stats'] = { status: 401, body: { result: false } };
  const client = createClient({ token: 'bad', fetchImpl: fakeFetch(routes) });
  await assert.rejects(
    () => client.aggregates(),
    (error) => {
      assert.ok(error instanceof RaindropError);
      assert.equal(error.code, 'invalid-token');
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test('RaindropError 归一：429 retry-after、超时、网络、result!==true', async () => {
  const rateLimited = createClient({
    token: 'tok',
    fetchImpl: async () =>
      jsonResponse({ result: false }, 429, { 'retry-after': '17', 'x-ratelimit-reset': '0' }),
  });
  await assert.rejects(
    () => rateLimited.user(),
    (error) => {
      assert.equal(error.code, 'rate-limited');
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 17);
      return true;
    },
  );

  const resetOnly = createClient({
    token: 'tok',
    fetchImpl: async () => {
      const reset = Math.ceil(Date.now() / 1000) + 42;
      return jsonResponse({ result: false }, 429, { 'x-ratelimit-reset': String(reset) });
    },
  });
  await assert.rejects(
    () => resetOnly.user(),
    (error) => {
      assert.equal(error.code, 'rate-limited');
      assert.ok(error.retryAfter >= 41 && error.retryAfter <= 43, `retryAfter=${error.retryAfter}`);
      return true;
    },
  );

  const timeout = createClient({
    token: 'tok',
    fetchImpl: async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    },
  });
  await assert.rejects(
    () => timeout.user(),
    (error) => {
      assert.equal(error.code, 'timeout');
      return true;
    },
  );

  const network = createClient({
    token: 'tok',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  await assert.rejects(
    () => network.user(),
    (error) => {
      assert.equal(error.code, 'network');
      return true;
    },
  );

  const badResult = createClient({
    token: 'tok',
    fetchImpl: async () => jsonResponse({ result: false, errorMessage: 'nope' }, 200),
  });
  await assert.rejects(
    () => badResult.user(),
    (error) => {
      assert.equal(error.code, 'upstream');
      assert.match(error.message, /HTTP 200/);
      assert.match(error.message, /nope/);
      return true;
    },
  );
});

// -------------------------------------------------------- api.sample()

test('sample：分页拉取（页间并发）、total 与 complete', async () => {
  const routes = baseRoutes();
  routes['/raindrops/0'] = (url) => {
    const page = Number(url.searchParams.get('page'));
    return {
      body: {
        result: true,
        count: 120,
        items: Array.from({ length: 50 }, (_, index) => item(page * 50 + index)),
      },
    };
  };
  const calls = [];
  const client = createClient({ token: 'tok', fetchImpl: fakeFetch(routes, calls) });
  const sample = await client.sample(2);

  assert.equal(sample.pages, 2);
  assert.equal(sample.items.length, 100);
  assert.equal(sample.total, 120);
  assert.equal(sample.complete, false);
  assert.deepEqual(
    calls.map((call) => new URL(call.url).searchParams.get('page')).sort(),
    ['0', '1'],
  );
  assert.ok(calls.every((call) => call.search.includes('perpage=50') && call.search.includes('sort=-created')));

  const empty = await client.sample(0);
  assert.deepEqual(empty, { items: [], total: null, pages: 0, complete: false });
});

// ---------------------------------------------------- buildDashboard 口径

function zeroTypes() {
  return CANONICAL_TYPES.map((type) => ({ type, count: 0 }));
}

function monthKeyLocal(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function lastMonths(anchor, count = 12) {
  const months = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    months.push(monthKeyLocal(new Date(anchor.getFullYear(), anchor.getMonth() - offset, 1)));
  }
  return months;
}

function dashboardFixture() {
  const anchor = new Date(2026, 5, 15, 12, 0, 0); // 本地 2026-06-15 12:00
  const at = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour, 0, 0);
  const items = [
    item(1, { created: at(2026, 6, 14).toISOString() }),
    item(2, { created: at(2026, 6, 12).toISOString(), domain: 'a.com', collection: { $id: 11 } }),
    item(3, {
      created: at(2026, 6, 10).toISOString(),
      domain: '',
      link: 'https://www.b.com/some/path',
      important: true,
      broken: true,
      tags: ['alpha', 'beta', ''],
      type: 'article',
    }),
    item(4, { created: at(2026, 5, 20).toISOString(), domain: '', link: 'not a url' }),
    item(5, { created: at(2026, 5, 3).toISOString(), domain: 'a.com' }),
    item(6, { created: at(2024, 1, 5).toISOString() }), // 12 个月窗口之外
    item(7, { created: 'garbage' }), // 非法时间：月度忽略、recent 排最后
  ];
  for (let id = 8; id <= 15; id += 1) {
    items.push(item(id, { created: at(2026, 6, 1, id).toISOString() }));
  }
  const aggregates = {
    totals: {
      all: 1234,
      unsorted: 56,
      trash: 7,
      collections: 2,
      tags: 2,
      broken: 12,
      duplicates: 3,
      important: 7,
      untagged: 42,
    },
    types: zeroTypes().map((entry) => (entry.type === 'link' ? { ...entry, count: 100 } : entry)),
    collections: [
      { id: 10, parentId: null, title: 'Dev', count: 300, depth: 0 },
      { id: 11, parentId: 10, title: 'JS', count: 200, depth: 1 },
    ],
    tags: [
      { name: 'js', count: 30 },
      { name: 'css', count: 20 },
    ],
    warnings: ['filters-unavailable'],
  };
  return { anchor, items, aggregates };
}

test('buildDashboard：12 个月补零、域名聚合、recent 截断与字段映射', async () => {
  const { anchor, items, aggregates } = dashboardFixture();
  const client = {
    async user() {
      return { name: 'Alice', pro: true };
    },
    async aggregates() {
      return aggregates;
    },
    async sample(pages) {
      return { items, total: null, pages, complete: false };
    },
  };

  const dashboard = await buildDashboard(client, {
    scanPages: 2,
    generatedAt: anchor.toISOString(),
  });

  // 恰好 12 项、旧 → 新、含当前月。
  assert.deepEqual(
    dashboard.monthly.map((entry) => entry.month),
    lastMonths(anchor),
  );
  assert.equal(dashboard.monthly.length, 12);
  const expectedCounts = new Map(lastMonths(anchor).map((month) => [month, 0]));
  for (const raw of items) {
    const date = new Date(raw.created);
    if (Number.isNaN(date.getTime())) continue;
    const key = monthKeyLocal(date);
    if (expectedCounts.has(key)) expectedCounts.set(key, expectedCounts.get(key) + 1);
  }
  assert.deepEqual(
    dashboard.monthly,
    lastMonths(anchor).map((month) => ({ month, count: expectedCounts.get(month) })),
  );
  // 2024-01 与非法时间都不在窗口内。
  assert.equal(
    dashboard.monthly.reduce((sum, entry) => sum + entry.count, 0),
    13,
  );

  // 域名：domain 优先，空则 link hostname，再空 unknown；最多 10、count 降序。
  assert.deepEqual(dashboard.domains, [
    { domain: 'example.com', count: 11 },
    { domain: 'a.com', count: 2 },
    { domain: 'www.b.com', count: 1 },
    { domain: 'unknown', count: 1 },
  ]);

  // recent：最多 12 条，最新在前，非法时间排最后。
  assert.equal(dashboard.recent.length, 12);
  assert.equal(dashboard.recent[0].id, 1);
  assert.equal(dashboard.recent.at(-1).id, 4);
  assert.ok(!dashboard.recent.some((entry) => entry.id === 7));
  const third = dashboard.recent.find((entry) => entry.id === 3);
  assert.deepEqual(third, {
    id: 3,
    title: 'Item 3',
    link: 'https://www.b.com/some/path',
    domain: 'www.b.com',
    type: 'article',
    tags: ['alpha', 'beta'],
    created: new Date(2026, 5, 10, 12, 0, 0).toISOString(),
    important: true,
    broken: true,
    collectionId: 10,
  });
  assert.equal(dashboard.recent.find((entry) => entry.id === 2).collectionId, 11);

  // 精确值原样透传，样本口径字段齐全。
  assert.deepEqual(dashboard.totals, aggregates.totals);
  assert.equal(dashboard.types.length, 6);
  assert.deepEqual(dashboard.scan, { scanned: items.length, total: null, pages: 2, complete: false });
  assert.deepEqual(dashboard.warnings, ['filters-unavailable']);
  assert.deepEqual(dashboard.tags, aggregates.tags);
  assert.equal(dashboard.generatedAt, anchor.toISOString());
  assert.deepEqual(dashboard.user, { name: 'Alice', pro: true });
});

test('buildDashboard：user 非 401 失败可继续，401 必须抛 invalid-token', async () => {
  const { anchor, items, aggregates } = dashboardFixture();
  const base = {
    async aggregates() {
      return aggregates;
    },
    async sample(pages) {
      return { items, total: null, pages, complete: false };
    },
  };

  const tolerate = await buildDashboard(
    {
      ...base,
      async user() {
        throw new RaindropError('network', 'offline');
      },
    },
    { scanPages: 1, generatedAt: anchor.toISOString() },
  );
  assert.deepEqual(tolerate.user, { name: null, pro: null });

  await assert.rejects(
    () =>
      buildDashboard(
        {
          ...base,
          async user() {
            throw new RaindropError('invalid-token', 'bad token', { status: 401 });
          },
        },
        { scanPages: 1, generatedAt: anchor.toISOString() },
      ),
    (error) => error.code === 'invalid-token',
  );
});

// --------------------------------------------------------------- Agent 工具

function overviewRoutes() {
  const anchor = new Date(2026, 5, 15, 12, 0, 0);
  const routes = baseRoutes();
  routes['/collections'] = {
    body: {
      result: true,
      items: Array.from({ length: 9 }, (_, index) => ({
        _id: 100 + index,
        title: `Collection ${index}`,
        count: 100 - index,
      })),
    },
  };
  routes['/collections/childrens'] = { body: { result: true, items: [] } };
  routes['/tags/0'] = {
    body: {
      result: true,
      items: Array.from({ length: 13 }, (_, index) => ({ _id: `tag${index}`, count: 100 - index })),
    },
  };
  routes['/raindrops/0'] = {
    body: {
      result: true,
      count: 60,
      items: Array.from({ length: 50 }, (_, index) =>
        item(index + 1, {
          domain: `site${index % 10}.com`,
          created: new Date(anchor.getTime() - index * 3600_000).toISOString(),
        }),
      ),
    },
  };
  return { anchor, routes };
}

test('raindrop_overview：未配置 token 返回 not-configured', async () => {
  const tools = createTools(memoryStore(null));
  const overview = tools.find((entry) => entry.name === 'raindrop_overview');
  const value = await overview.execute({});
  assert.deepEqual(value, {
    ok: false,
    code: 'not-configured',
    message: '尚未配置 Raindrop API Token，请先在 Raindrop 面板里填写。',
  });
  assert.deepEqual(Object.keys(value).sort(), ['code', 'message', 'ok']);
  assert.equal(overview.timeoutMs, 30000);
  assert.equal(overview.isConcurrencySafe(), false);
  assert.equal(overview.parameters.additionalProperties, false);
});

test('raindrop_overview：字段结构 + 8/12/8/5 截断', async () => {
  const { anchor, routes } = overviewRoutes();
  const store = memoryStore('tok', { scanPages: 1 });
  const tools = createTools(store, { fetchImpl: fakeFetch(routes), now: () => anchor });
  const overview = tools.find((entry) => entry.name === 'raindrop_overview');
  const value = await overview.execute({});

  assert.equal(value.ok, true);
  assert.equal(value.generatedAt, anchor.toISOString());
  assert.deepEqual(value.user, { name: 'Alice', pro: true });
  assert.equal(value.types.length, 6);
  assert.equal(value.collections.length, 8);
  assert.deepEqual(Object.keys(value.collections[0]).sort(), ['count', 'depth', 'id', 'title']);
  assert.equal(value.tags.length, 12);
  assert.equal(value.domains.length, 8);
  assert.equal(value.monthly.length, 12);
  assert.equal(value.recent.length, 5);
  assert.deepEqual(Object.keys(value.recent[0]).sort(), ['created', 'domain', 'id', 'title', 'type']);
  assert.deepEqual(value.scan, { scanned: 50, total: 60, pages: 1, complete: false });
  assert.deepEqual(value.warnings, []);

  const rendered = overview.output.render({}, value);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /Raindrop 概览/);
  assert.match(rendered[0].text, /类型：link/);
  assert.match(rendered[0].text, /月度新增/);

  const failed = overview.output.render({}, { ok: false, code: 'invalid-token', message: 'x' });
  assert.match(failed[0].text, /失败/);
});

test('raindrop_overview：上游错误归一为 {ok:false,code,message}', async () => {
  const { anchor, routes } = overviewRoutes();
  routes['/user/stats'] = { status: 401, body: { result: false } };
  const store = memoryStore('bad', { scanPages: 0 });
  const tools = createTools(store, { fetchImpl: fakeFetch(routes), now: () => anchor });
  const overview = tools.find((entry) => entry.name === 'raindrop_overview');
  const value = await overview.execute({});
  assert.deepEqual(value, { ok: false, code: 'invalid-token', message: 'Raindrop Token 无效或已过期' });
});

test('raindrop_search：检索串、perpage 上限、excerpt 截断与错误映射', async () => {
  const anchor = new Date(2026, 5, 15, 12, 0, 0);
  const longExcerpt = 'x'.repeat(300);
  const routes = {
    '/raindrops/0': (url) => {
      if (url.searchParams.get('search') === 'boom') {
        return { status: 500, body: { result: false, errorMessage: 'search failed' } };
      }
      if (url.searchParams.get('search') === 'bad-token') {
        return { status: 401, body: { result: false } };
      }
      return {
        body: {
          result: true,
          count: 57,
          items: [
            item(1, { title: 'Hello', excerpt: longExcerpt, tags: ['a', 'b'] }),
            item(2, { title: 'World' }),
          ],
        },
      };
    },
  };
  const calls = [];
  const store = memoryStore('tok');
  const tools = createTools(store, { fetchImpl: fakeFetch(routes, calls), now: () => anchor });
  const search = tools.find((entry) => entry.name === 'raindrop_search');

  const value = await search.execute({ query: 'hello', tag: '#tag', limit: 50 });
  assert.equal(value.ok, true);
  assert.equal(value.count, 57);
  assert.equal(value.items.length, 2);
  assert.equal(value.items[0].excerpt.length, 200);
  assert.equal(value.items[1].excerpt, null);
  assert.deepEqual(value.items[0].tags, ['a', 'b']);

  const call = calls.at(-1);
  const parsed = new URL(call.url);
  assert.equal(parsed.pathname, '/rest/v1/raindrops/0');
  assert.equal(parsed.searchParams.get('search'), 'hello #tag');
  assert.equal(parsed.searchParams.get('perpage'), '20'); // 50 被夹到 20
  assert.equal(parsed.searchParams.get('page'), '0');
  assert.equal(parsed.searchParams.get('sort'), '-created');

  // 默认 limit=10、默认 collectionId=0。
  calls.length = 0;
  await search.execute({ query: 'hello' });
  assert.equal(new URL(calls.at(-1).url).searchParams.get('perpage'), '10');
  assert.equal(new URL(calls.at(-1).url).searchParams.get('search'), 'hello');

  const upstream = await search.execute({ query: 'boom' });
  assert.equal(upstream.ok, false);
  assert.equal(upstream.code, 'upstream');
  assert.match(upstream.message, /HTTP 500/);

  const invalid = await search.execute({ query: 'bad-token' });
  assert.deepEqual(invalid, { ok: false, code: 'invalid-token', message: 'Raindrop Token 无效或已过期' });

  const rendered = search.output.render({}, value);
  assert.match(rendered[0].text, /检索到 57 条/);

  const unconfigured = await createTools(memoryStore(null))
    .find((entry) => entry.name === 'raindrop_search')
    .execute({ query: 'x' });
  assert.equal(unconfigured.code, 'not-configured');
});

// ------------------------------------------------------------ store 行为

test('store：token 原子写 0600、写入后清空用户缓存、损坏文件不抛错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-raindrop-store-'));
  try {
    const store = createStore({ dir, defaults: { scanPages: 3, cacheTtlSeconds: 60, enableTools: false } });
    assert.equal(store.file, path.join(dir, 'config.json'));
    assert.deepEqual(store.config, { scanPages: 3, cacheTtlSeconds: 60, enableTools: false });

    // 未创建时按未配置处理。
    assert.equal(store.readToken(), null);
    assert.equal(store.readUserCache(), null);

    store.writeToken('secret-token-abcd');
    assert.equal(store.readToken(), 'secret-token-abcd');
    assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);

    store.writeUserCache({ name: 'Alice', pro: true });
    assert.deepEqual(store.readUserCache(), { name: 'Alice', pro: true });

    // 换 token 立即作废旧用户缓存。
    store.writeToken('another-token-wxyz');
    assert.equal(store.readUserCache(), null);
    assert.equal(store.readToken(), 'another-token-wxyz');

    store.clearToken();
    assert.equal(store.readToken(), null);
    assert.equal(store.readUserCache(), null);

    // 损坏 JSON：不抛错，按未配置处理，下次写入覆盖。
    fs.writeFileSync(store.file, '{ not json', 'utf8');
    assert.equal(store.readToken(), null);
    assert.equal(store.readUserCache(), null);
    store.writeToken('after-corrupt');
    assert.equal(store.readToken(), 'after-corrupt');
    assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), {
      token: 'after-corrupt',
      user: null,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
