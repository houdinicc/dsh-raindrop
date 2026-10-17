/**
 * Raindrop 仪表盘 —— Raindrop.io REST API v1 客户端与聚合口径。
 *
 * 这里不 import 任何 `@deepseek-ai/*` 包，也可以脱离 Cordis 单独测试。
 * 所有网络访问都收敛到 `createClient()` 内部；路由与工具只消费
 * `user() / aggregates() / sample() / buildDashboard()` 的产物。
 *
 * API 事实（已调研确认，不要在实现里重新猜测）：
 *  - base `https://api.raindrop.io/rest/v1`，头 `Authorization: Bearer <token>`；
 *  - 成功响应的判定只看 `result === true`，错误体形状不统一；
 *  - 收藏夹字段是 `collection.$id`（不是 collectionId）；
 *  - 日期是 UTC ISO 字符串，按月统计时用宿主本地时区切月。
 *
 * @module dsh-raindrop/api
 */

const DEFAULT_BASE_URL = 'https://api.raindrop.io/rest/v1';
const DEFAULT_TIMEOUT_MS = 15000;
const PAGE_SIZE = 50;
const SAMPLE_CONCURRENCY = 3;

/** type 的规范顺序；仪表盘与工具都固定输出这 6 项。 */
export const CANONICAL_TYPES = ['link', 'article', 'image', 'video', 'document', 'audio'];

/** `/tags/0` 在聚合层最多保留多少个标签。 */
const MAX_TAGS = 20;

/** 统一的错误类型：路由/工具据此映射 HTTP 状态与工具错误码。 */
export class RaindropError extends Error {
  /**
   * @param {'invalid-token'|'rate-limited'|'upstream'|'network'|'timeout'} code
   * @param {string} message
   * @param {{ status?: number, retryAfter?: number }} [options]
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'RaindropError';
    this.code = code;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
  }
}

// ------------------------------------------------------------------ 小工具

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function countOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  if (value !== null && typeof value === 'object' && typeof value.count === 'number') {
    return Number.isFinite(value.count) && value.count > 0 ? value.count : 0;
  }
  return 0;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const text = entry.trim();
    if (text !== '') out.push(text);
  }
  return out;
}

function canonicalType(value) {
  if (typeof value === 'string' && CANONICAL_TYPES.includes(value.trim().toLowerCase())) {
    return value.trim().toLowerCase();
  }
  return 'link';
}

/** 收藏项归属域名：优先 `domain`，空则解析 `link` 的 hostname，再空归 unknown。 */
function itemDomain(item) {
  const domain = typeof item?.domain === 'string' ? item.domain.trim() : '';
  if (domain !== '') return domain;
  const link = typeof item?.link === 'string' ? item.link.trim() : '';
  if (link !== '') {
    try {
      const hostname = new URL(link).hostname;
      if (hostname !== '') return hostname;
    } catch {
      /* 非法链接落到 unknown */
    }
  }
  return 'unknown';
}

function collectionIdOf(item) {
  const raw = item?.collection;
  let value = null;
  if (raw !== null && typeof raw === 'object') value = raw.$id;
  else if (typeof raw === 'number' || typeof raw === 'string') value = raw;
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** 本地时区的 `YYYY-MM`。 */
function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------- HTTP 细节

function headerValue(response, name) {
  const headers = response?.headers;
  if (headers === null || headers === undefined) return null;
  const lower = name.toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(lower);
    return value ?? null;
  }
  if (headers instanceof Map) {
    const value = headers.get(lower);
    return value ?? null;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key] ?? null;
  }
  return null;
}

function parseRetryAfter(response, nowMs) {
  const raw = Number(headerValue(response, 'retry-after'));
  if (Number.isFinite(raw) && raw > 0) return Math.max(1, Math.ceil(raw));
  const reset = Number(headerValue(response, 'x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(1, Math.ceil(reset - nowMs / 1000));
  return 1;
}

async function readResponseBody(response) {
  try {
    if (typeof response?.json === 'function') return await response.json();
    if (typeof response?.text === 'function') {
      const text = await response.text();
      return text === undefined || text === '' ? null : JSON.parse(text);
    }
  } catch {
    return null;
  }
  return null;
}

function extractErrorMessage(body) {
  if (body === null || typeof body !== 'object') return null;
  const candidates = [body.errorMessage, body.message, body.error_description, body.error];
  if (body.error !== null && typeof body.error === 'object') candidates.push(body.error.message);
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

// ------------------------------------------------ aggregates 各接口的规范化

function zeroTypes() {
  return CANONICAL_TYPES.map((type) => ({ type, count: 0 }));
}

function normalizeTypes(rawTypes) {
  const counts = new Map(CANONICAL_TYPES.map((type) => [type, 0]));
  for (const entry of Array.isArray(rawTypes) ? rawTypes : []) {
    let type = null;
    if (typeof entry?._id === 'string') {
      const text = entry._id.trim().toLowerCase();
      if (CANONICAL_TYPES.includes(text)) type = text;
    } else if (Number.isInteger(entry?._id) && entry._id >= 0 && entry._id < CANONICAL_TYPES.length) {
      // 防御：个别环境可能用 0..5 的序号；正常接口返回的是类型名。
      type = CANONICAL_TYPES[entry._id];
    }
    if (type === null) continue;
    counts.set(type, counts.get(type) + countOf(entry?.count));
  }
  return CANONICAL_TYPES.map((type) => ({ type, count: counts.get(type) }));
}

function statCount(items, id) {
  for (const item of Array.isArray(items) ? items : []) {
    if (Number(item?._id) === id) return countOf(item?.count);
  }
  return 0;
}

function normalizeCollection(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = Number(raw._id);
  if (!Number.isFinite(id)) return null;

  let parentId = null;
  const parent = raw.parent;
  if (typeof parent === 'number' || typeof parent === 'string') {
    const n = Number(parent);
    if (Number.isFinite(n)) parentId = n;
  } else if (parent !== null && typeof parent === 'object') {
    const n = Number(parent.$id);
    if (Number.isFinite(n)) parentId = n;
  }
  if (parentId === null && raw.parentId !== undefined) {
    const n = Number(raw.parentId);
    if (Number.isFinite(n)) parentId = n;
  }

  return {
    id,
    parentId,
    title: asString(raw.title),
    count: countOf(raw.count),
  };
}

/**
 * 把 `/collections`（根）与 `/collections/childrens`（后代）重建成带 depth 的扁平表。
 * 找不到父节点的按根处理；按 count 降序。
 */
function buildCollectionTree(rootItems, childItems) {
  const map = new Map();
  for (const raw of [...(Array.isArray(rootItems) ? rootItems : []), ...(Array.isArray(childItems) ? childItems : [])]) {
    const node = normalizeCollection(raw);
    if (node !== null) map.set(node.id, node);
  }

  const depthOf = (node, seen = new Set()) => {
    if (node.parentId === null) return 0;
    if (seen.has(node.id)) return 0; // 防御环
    seen.add(node.id);
    const parent = map.get(node.parentId);
    if (parent === undefined) return 0;
    return depthOf(parent, seen) + 1;
  };

  const nodes = [...map.values()].map((node) => ({ ...node, depth: depthOf(node) }));
  nodes.sort((a, b) => b.count - a.count);
  return nodes;
}

/**
 * 顶层分类聚合：把每个收藏夹归到它的根祖先，count 为整棵子树合计。
 * 比「叶子收藏夹 Top」更能回答「我的收藏分成哪几类」。
 */
function topLevelGroups(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const rootOf = (node) => {
    let current = node;
    const seen = new Set();
    while (current.parentId !== null && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
    return current;
  };

  const groups = new Map();
  for (const node of nodes) {
    const root = rootOf(node);
    const group = groups.get(root.id) ?? {
      id: root.id,
      title: root.title,
      count: 0,
      collections: 0,
    };
    group.count += node.count;
    group.collections += 1;
    groups.set(root.id, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

function normalizeTagList(rawTags) {
  const list = [];
  for (const entry of Array.isArray(rawTags) ? rawTags : []) {
    const name =
      typeof entry?._id === 'string'
        ? entry._id.trim()
        : typeof entry?.name === 'string'
          ? entry.name.trim()
          : '';
    if (name === '') continue;
    list.push({ name, count: countOf(entry?.count) });
  }
  list.sort((a, b) => b.count - a.count);
  return list;
}

// ---------------------------------------------------------------- Dashboard

/**
 * Raindrop 自己托管的文件/图片（`up.raindrop.io` 等）不是「内容来源」，
 * 从域名 Top 里排除，避免它长期霸榜。
 */
const OWN_DOMAINS = new Set(['raindrop.io', 'up.raindrop.io', 'assets.raindrop.io', 'cdn.raindrop.io']);

function domainTop(items, limit) {
  const counts = new Map();
  for (const item of items) {
    const domain = itemDomain(item);
    if (OWN_DOMAINS.has(domain)) continue;
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function monthlyTrend(generatedAt, items) {
  const anchor = toDate(generatedAt) ?? new Date();
  const months = [];
  for (let offset = 11; offset >= 0; offset -= 1) {
    months.push(monthKey(new Date(anchor.getFullYear(), anchor.getMonth() - offset, 1)));
  }
  const counts = new Map(months.map((month) => [month, 0]));
  for (const item of items) {
    const date = toDate(item?.created);
    if (date === null) continue;
    const key = monthKey(date);
    if (!counts.has(key)) continue;
    counts.set(key, counts.get(key) + 1);
  }
  return months.map((month) => ({ month, count: counts.get(month) }));
}

function recentItems(items, limit) {
  const ordered = items
    .map((item, index) => ({ item, index, time: toDate(item?.created)?.getTime() ?? null }))
    .sort((a, b) => {
      if (a.time === null && b.time === null) return a.index - b.index;
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      return b.time - a.time || a.index - b.index;
    });
  return ordered.slice(0, limit).map(({ item }) => ({
    id: numberOrZero(item?._id),
    title: asString(item?.title),
    link: asString(item?.link),
    domain: itemDomain(item),
    type: canonicalType(item?.type),
    tags: stringArray(item?.tags),
    created: asString(item?.created),
    important: item?.important === true,
    broken: item?.broken === true,
    collectionId: collectionIdOf(item),
  }));
}

function normalizeSearchItem(raw) {
  const excerptText = typeof raw?.excerpt === 'string' ? raw.excerpt.trim() : '';
  return {
    id: numberOrZero(raw?._id),
    title: asString(raw?.title),
    link: asString(raw?.link),
    domain: itemDomain(raw),
    type: canonicalType(raw?.type),
    tags: stringArray(raw?.tags),
    created: asString(raw?.created),
    important: raw?.important === true,
    broken: raw?.broken === true,
    excerpt: excerptText === '' ? null : excerptText.slice(0, 200),
  };
}

/**
 * 组装 Dashboard 载荷（契约 §4.2）。纯函数式地消费 client 的四个方法，
 * 不直接碰网络，便于用假 client 测试。
 *
 * @param {ReturnType<typeof createClient>} client
 * @param {{ scanPages?: number, generatedAt?: string }} [options]
 * @returns {Promise<object>}
 */
export async function buildDashboard(client, options = {}) {
  const scanPages = Number.isFinite(options.scanPages) ? Math.max(0, Math.trunc(options.scanPages)) : 8;
  const generatedAt =
    typeof options.generatedAt === 'string' && options.generatedAt !== ''
      ? options.generatedAt
      : new Date().toISOString();

  // `/user` 失败只在 401 时致命；其它失败按「用户信息未知」继续。
  const userPromise = (async () => {
    try {
      return await client.user();
    } catch (error) {
      if (error instanceof RaindropError && error.code === 'invalid-token') throw error;
      return { name: null, pro: null };
    }
  })();

  const [user, aggregates, sample] = await Promise.all([
    userPromise,
    client.aggregates(),
    client.sample(scanPages),
  ]);

  const items = Array.isArray(sample?.items) ? sample.items : [];

  return {
    generatedAt,
    user: { name: user?.name ?? null, pro: user?.pro ?? null },
    totals: { ...aggregates.totals },
    types: aggregates.types,
    collections: aggregates.collections,
    groups: Array.isArray(aggregates.groups) ? aggregates.groups : [],
    tags: aggregates.tags,
    domains: domainTop(items, 10),
    monthly: monthlyTrend(generatedAt, items),
    recent: recentItems(items, 12),
    availability: aggregates.availability ?? {
      broken: true,
      duplicates: true,
      important: true,
      untagged: true,
    },
    scan: {
      scanned: items.length,
      total: sample?.total ?? null,
      pages: sample?.pages ?? 0,
      complete: sample?.complete === true,
    },
    warnings: [...aggregates.warnings],
  };
}

// ------------------------------------------------------------------ client

/**
 * 创建 Raindrop API 客户端。
 *
 * 除契约要求的 `user() / aggregates() / sample() / buildDashboard 用的方法` 之外，
 * 额外提供 `search()` 供 `lib/tools.js` 的 `raindrop_search` 复用同一套错误归一化
 * 与 URL 拼装（不改变任何契约要求的字段）。
 *
 * @param {object} [options]
 * @param {string} [options.token]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {string} [options.baseUrl]
 * @param {number} [options.timeoutMs]
 */
export function createClient(options = {}) {
  const token = typeof options.token === 'string' ? options.token : '';
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createClient 需要可用的 fetch 实现');
  }
  const baseUrl = (
    typeof options.baseUrl === 'string' && options.baseUrl.trim() !== ''
      ? options.baseUrl.trim()
      : DEFAULT_BASE_URL
  ).replace(/\/+$/, '');
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  /** 发一个 GET，并把各种失败归一成 RaindropError。 */
  async function request(pathAndQuery) {
    const url = `${baseUrl}${pathAndQuery}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = String(error?.name ?? '');
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new RaindropError('timeout', `Raindrop API 请求超时（${timeoutMs}ms）`);
      }
      const detail = typeof error?.message === 'string' ? error.message : String(error);
      throw new RaindropError('network', `无法连接 Raindrop API：${detail}`);
    }

    const status = Number(response?.status);
    if (status === 401) {
      throw new RaindropError('invalid-token', 'Raindrop Token 无效或已过期', { status: 401 });
    }
    if (status === 429) {
      const retryAfter = parseRetryAfter(response, Date.now());
      throw new RaindropError('rate-limited', `Raindrop API 触发限流，请 ${retryAfter} 秒后重试`, {
        status: 429,
        retryAfter,
      });
    }

    const body = await readResponseBody(response);
    if (!(status >= 200 && status < 300)) {
      const detail = extractErrorMessage(body);
      throw new RaindropError(
        'upstream',
        `Raindrop API 返回 HTTP ${Number.isFinite(status) ? status : 'unknown'}${detail === null ? '' : `：${detail}`}`,
        { status: Number.isFinite(status) ? status : undefined },
      );
    }
    if (body === null || typeof body !== 'object' || body.result !== true) {
      const detail = extractErrorMessage(body);
      throw new RaindropError(
        'upstream',
        `Raindrop API 返回异常（HTTP ${status}）${detail === null ? '' : `：${detail}`}`,
        { status },
      );
    }
    return body;
  }

  async function user() {
    const body = await request('/user');
    const raw = body?.user ?? {};
    return {
      name: typeof raw.fullName === 'string' && raw.fullName.trim() !== '' ? raw.fullName.trim() : null,
      pro: typeof raw.pro === 'boolean' ? raw.pro : null,
    };
  }

  /** 单个接口失败不整体失败；401 视为 token 失效，继续向上抛。 */
  async function attempt(work) {
    try {
      return { ok: true, value: await work() };
    } catch (error) {
      if (error instanceof RaindropError && error.code === 'invalid-token') throw error;
      return { ok: false, error };
    }
  }

  async function aggregates() {
    const [filters, stats, rootCollections, childCollections, tags] = await Promise.all([
      attempt(() => request('/filters/0')),
      attempt(() => request('/user/stats')),
      attempt(() => request('/collections')),
      attempt(() => request('/collections/childrens')),
      attempt(() => request('/tags/0')),
    ]);

    const totals = {
      all: 0,
      unsorted: 0,
      trash: 0,
      collections: 0,
      tags: 0,
      broken: 0,
      duplicates: 0,
      important: 0,
      untagged: 0,
    };

    // 精确总数：只有 /user/stats 有。
    if (stats.ok) {
      const items = stats.value?.items;
      totals.all = statCount(items, 0);
      totals.unsorted = statCount(items, -1);
      totals.trash = statCount(items, -99);
    }

    // 死链/重复/重要/无标签/类型分布：/filters/0，失败时用 stats.meta 兜底。
    let types = zeroTypes();
    if (filters.ok) {
      totals.broken = countOf(filters.value?.broken);
      totals.duplicates = countOf(filters.value?.duplicates);
      totals.important = countOf(filters.value?.important);
      totals.untagged = countOf(filters.value?.notag);
      types = normalizeTypes(filters.value?.types);
    } else if (stats.ok) {
      totals.broken = countOf(stats.value?.meta?.broken);
      totals.duplicates = countOf(stats.value?.meta?.duplicates);
    }

    // 收藏夹：根 + 后代重建；根失败则整体置空（契约要求）。
    let collections = [];
    if (rootCollections.ok) {
      const children = childCollections.ok ? childCollections.value?.items : [];
      collections = buildCollectionTree(rootCollections.value?.items, children);
    }
    totals.collections = collections.length;
    const groups = topLevelGroups(collections);

    // 可用性：免费账号的 /filters/0 不返回 broken / duplicates 字段，
    // /user/stats 的 meta 也可能没有 —— 此时是「没有数据」而不是「0 个」。
    const statsMeta = stats.ok ? stats.value?.meta : null;
    const present = (value) => value !== undefined && value !== null && typeof value === 'object';
    const availability = {
      broken: (filters.ok && present(filters.value?.broken)) || present(statsMeta?.broken),
      duplicates: (filters.ok && present(filters.value?.duplicates)) || present(statsMeta?.duplicates),
      important: filters.ok && present(filters.value?.important),
      untagged: filters.ok && present(filters.value?.notag),
    };

    // 标签：最多保留 20 项，但 totals.tags 是标签种类数（不受截断影响）。
    let tagList = [];
    if (tags.ok) {
      const all = normalizeTagList(tags.value?.items);
      totals.tags = all.length;
      tagList = all.slice(0, MAX_TAGS);
    }

    // 可选接口失败代码；顺序与契约 §3.3 的降级条目一致。
    const warnings = [];
    if (!filters.ok) warnings.push('filters-unavailable');
    if (!tags.ok) warnings.push('tags-unavailable');
    if (!rootCollections.ok) warnings.push('collections-unavailable');
    else if (!childCollections.ok) warnings.push('collections-children-unavailable');
    if (!stats.ok) warnings.push('stats-unavailable');

    return { totals, types, collections, groups, tags: tagList, warnings, availability };
  }

  /**
   * 拉取最近样本：`pages` 页 × 50 条，页间并发度 3。
   * @param {number} pages
   */
  async function sample(pages) {
    const count = Number.isFinite(Number(pages)) ? Math.max(0, Math.trunc(Number(pages))) : 0;
    if (count === 0) return { items: [], total: null, pages: 0, complete: false };

    const results = new Array(count);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= count) return;
        results[index] = await request(
          `/raindrops/0?perpage=${PAGE_SIZE}&page=${index}&sort=-created`,
        );
      }
    };
    const workers = Array.from({ length: Math.min(SAMPLE_CONCURRENCY, count) }, () => worker());
    await Promise.all(workers);

    const items = [];
    let total = null;
    for (const result of results) {
      if (Array.isArray(result?.items)) items.push(...result.items);
      if (total === null && typeof result?.count === 'number' && Number.isFinite(result.count)) {
        total = result.count;
      }
    }
    return { items, total, pages: count, complete: total !== null && items.length >= total };
  }

  /** 供 `raindrop_search` 复用：一次检索，返回规范化后的条目。 */
  async function search(searchOptions = {}) {
    const collectionId = Number.isInteger(searchOptions.collectionId) ? searchOptions.collectionId : 0;
    const requested = Number.isInteger(searchOptions.limit) ? searchOptions.limit : 10;
    const limit = Math.min(20, Math.max(1, requested));
    const searchText = typeof searchOptions.search === 'string' ? searchOptions.search.trim() : '';
    let path = `/raindrops/${collectionId}?perpage=${limit}&page=0&sort=-created`;
    if (searchText !== '') path += `&search=${encodeURIComponent(searchText)}`;
    const body = await request(path);
    const items = Array.isArray(body?.items) ? body.items : [];
    return {
      count: typeof body?.count === 'number' && Number.isFinite(body.count) ? body.count : items.length,
      items: items.map(normalizeSearchItem),
    };
  }

  const api = { user, aggregates, sample, search };

  // 契约 §3.2 把 buildDashboard 列在「返回对象的方法」里，同时签名又是
  // `buildDashboard(client, options)`；这里两种调用形态都给到：模块级函数是主入口，
  // 客户端上挂一个绑定当前 client 的方法以便 `client.buildDashboard(options)`。
  return {
    user,
    aggregates,
    sample,
    search,
    buildDashboard: (dashboardOptions = {}) => buildDashboard(api, dashboardOptions),
  };
}
