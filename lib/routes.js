/**
 * Raindrop 仪表盘 —— Web GUI 的 HTTP 路由。
 *
 * 客户端半用**文档相对路径** `fetch('api/dsh-raindrop/...')` 调这里
 * （GUI 用 `<base href="./">`，根绝对路径会在子路径部署下逃出前缀）。
 * 注册时相反，必须是带前导斜杠的绝对路径。
 *
 * 安全：所有路由都过 `isLoopbackRequest` —— 只接受本机回环连接、
 * 回环 Host 头、且非 cross-site 的请求。Token 只存在 Host 侧，
 * 浏览器拿到的永远是掩码。
 *
 * @module dsh-raindrop/routes
 */

import { RaindropError, buildDashboard, createClient } from './api.js';

const ROUTE_PREFIX = '/api/dsh-raindrop';
const MAX_BODY_BYTES = 16 * 1024;

/** 只有本机页面能调这些路由（与 dsh-todos 同款围栏）。 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? '';
  const loopback =
    address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
  if (!loopback) return false;

  let hostname;
  try {
    hostname = new URL(`http://${req.headers.host ?? ''}`).hostname;
  } catch {
    return false;
  }
  if (!(hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname))) return false;

  return req.headers['sec-fetch-site'] !== 'cross-site';
}

/** 路由层自己的错误：直接带 HTTP 状态与信封错误码。 */
class RouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.code = code;
  }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

function fail(res, status, code, message, extra = {}) {
  const error = { code, message };
  if (extra.retryAfter !== undefined) error.retryAfter = extra.retryAfter;
  writeJson(res, status, { ok: false, error });
}

function maskToken(token) {
  return `••••${token.slice(-4)}`;
}

/** 从 RaindropError 映射到 HTTP 状态与信封错误码。 */
function respondError(res, error) {
  if (error instanceof RouteError) {
    fail(res, error.status, error.code, error.message);
    return;
  }
  if (error instanceof RaindropError) {
    switch (error.code) {
      case 'invalid-token':
        fail(res, 401, 'invalid-token', error.message);
        return;
      case 'rate-limited':
        fail(res, 429, 'rate-limited', error.message, { retryAfter: error.retryAfter });
        return;
      case 'timeout':
        fail(res, 504, 'timeout', error.message);
        return;
      default:
        fail(res, 502, 'upstream', error.message);
        return;
    }
  }
  fail(res, 500, 'internal', String(error?.message ?? error));
}

function isJsonContentType(req) {
  const raw = req.headers?.['content-type'];
  return typeof raw === 'string' && /^application\/json\b/i.test(raw.trim());
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new RouteError(400, 'invalid-body', '请求体过大（上限 16 KiB）');
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new RouteError(400, 'invalid-body', '请求体不能为空');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RouteError(400, 'invalid-body', '请求体不是合法 JSON');
  }
}

/**
 * 组装路由表。
 *
 * @param {ReturnType<typeof import('./store.js').createStore>} store
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] 便于离线测试注入。
 * @param {() => Date} [options.now] 便于离线测试注入。
 * @returns {Array<{kind:'exact',path:string,handler:(req:object,res:object)=>Promise<void>}>}
 */
export function createRoutes(store, options = {}) {
  const fetchImpl = options.fetchImpl;
  const now = typeof options.now === 'function' ? options.now : () => new Date();

  /** 内存缓存：token 变了自然失效；TTL 取 store.config.cacheTtlSeconds。 */
  let cache = null;

  function statusValue() {
    const token = store.readToken();
    if (token === null) return { configured: false, masked: null, user: null };
    return {
      configured: true,
      masked: maskToken(token),
      user: store.readUserCache() ?? null,
    };
  }

  async function handleStatus() {
    return statusValue();
  }

  async function handleSaveToken(req) {
    if (!isJsonContentType(req)) {
      throw new RouteError(400, 'invalid-body', '请求体必须是 application/json');
    }
    const body = await readJsonBody(req);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (token === '') {
      throw new RouteError(400, 'invalid-body', '请在 body 里提供非空 token 字符串');
    }

    // 先向 Raindrop 验证 token，成功后才落盘。
    const client = createClient({ token, fetchImpl });
    const user = await client.user();
    store.writeToken(token);
    store.writeUserCache(user);
    return { configured: true, masked: maskToken(token), user };
  }

  async function handleDeleteToken() {
    store.clearToken();
    cache = null;
    return { configured: false, masked: null, user: null };
  }

  async function handleDashboard(req) {
    const token = store.readToken();
    if (token === null) {
      throw new RouteError(400, 'not-configured', '尚未配置 Raindrop API Token，请先在面板里填写。');
    }

    let force = false;
    try {
      const url = new URL(`http://${req.headers?.host ?? 'localhost'}${req.url ?? ''}`);
      force = url.searchParams.get('force') === '1';
    } catch {
      force = false;
    }

    const current = now();
    const at = current instanceof Date && !Number.isNaN(current.getTime()) ? current.getTime() : Date.now();
    const ttlSeconds = Number(store.config?.cacheTtlSeconds);
    const ttlMs = Number.isFinite(ttlSeconds) ? Math.max(0, ttlSeconds) * 1000 : 0;

    if (!force && cache !== null && cache.token === token && ttlMs > 0 && at - cache.at < ttlMs) {
      return cache.payload;
    }

    const client = createClient({ token, fetchImpl });
    const payload = await buildDashboard(client, {
      scanPages: store.config?.scanPages,
      generatedAt: new Date(at).toISOString(),
    });
    cache = { token, at, payload };
    return payload;
  }

  /**
   * 把一个路径包成 WebRoute：围栏 → 按 `req.method` 分发 → JSON 信封 → 错误归一。
   *
   * ⚠️ `webServer.register` 以 `(kind, path)` 判重，同一路径只能注册一条 WebRoute。
   * 所以 `/token` 的 POST 与 DELETE 必须合并在这**一条**路由里分发；否则第二次
   * register 会抛错，并中断后续路由与工具注册。
   *
   * @param {string} path 路由子路径。
   * @param {Record<string, (req: object) => Promise<unknown>>} methods 方法 → 处理函数。
   */
  function endpoint(path, methods) {
    return {
      kind: 'exact',
      path: `${ROUTE_PREFIX}${path}`,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          fail(res, 403, 'forbidden', '只允许本机回环请求');
          return;
        }
        // 契约：非预期方法/未知子路径统一 404 not-found（不做 405）。
        const handle = Object.hasOwn(methods, req.method) ? methods[req.method] : null;
        if (typeof handle !== 'function') {
          fail(res, 404, 'not-found', '未找到该接口');
          return;
        }
        try {
          const value = await handle(req);
          writeJson(res, 200, { ok: true, value });
        } catch (error) {
          respondError(res, error);
        }
      },
    };
  }

  // 3 条路由：(kind, path) 组合唯一，可安全逐个 webServer.register()。
  return [
    endpoint('/status', { GET: handleStatus }),
    endpoint('/token', { POST: handleSaveToken, DELETE: handleDeleteToken }),
    endpoint('/dashboard', { GET: handleDashboard }),
  ];
}
