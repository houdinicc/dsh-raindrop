/**
 * Raindrop 仪表盘 —— Agent 工具。
 *
 * 两个只读工具，走与面板相同的 `lib/api.js` 数据口径：
 *  - `raindrop_overview`：整个收藏库的聚合统计 + 最近收藏样本；
 *  - `raindrop_search`：按关键词/标签检索具体收藏。
 *
 * 本文件不 import 任何 `@deepseek-ai/*` 包：工具定义用**原始 JSON Schema**，
 * 由 `ctx.tools.register()` 直接接收。工具失败一律返回 `{ok:false,code,message}`，
 * 不把原始异常抛给 Agent。
 *
 * @module dsh-raindrop/tools
 */

import { RaindropError, buildDashboard, createClient } from './api.js';

const text = (value) => [{ type: 'text', text: value }];

const NOT_CONFIGURED_MESSAGE = '尚未配置 Raindrop API Token，请先在 Raindrop 面板里填写。';

/** 工具失败信封：只保留契约要求的三个字段。 */
function toolFailure(error) {
  const code =
    error instanceof RaindropError
      ? error.code
      : typeof error?.code === 'string' && error.code !== ''
        ? error.code
        : 'internal';
  const message =
    typeof error?.message === 'string' && error.message !== '' ? error.message : String(error);
  return { ok: false, code, message };
}

function notConfigured() {
  return { ok: false, code: 'not-configured', message: NOT_CONFIGURED_MESSAGE };
}

function renderFailure(value) {
  const suffix = typeof value?.code === 'string' && value.code !== '' ? `（${value.code}）` : '';
  return text(`读取 Raindrop 数据失败${suffix}：${value?.message ?? '未知错误'}`);
}

// ------------------------------------------------------- raindrop_overview

const OVERVIEW_DESCRIPTION =
  '读取用户 Raindrop.io 收藏库的聚合统计（总数、类型、收藏夹、标签、域名、月度趋势）与最近收藏样本，'
  + '用于分析收藏结构与待清理项。只返回统计与元数据，不返回收藏正文全文。';

const OVERVIEW_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string' },
    message: { type: 'string' },
    generatedAt: { type: 'string' },
    user: { type: 'object' },
    totals: { type: 'object' },
    types: { type: 'array', items: { type: 'object' } },
    collections: { type: 'array', items: { type: 'object' } },
    tags: { type: 'array', items: { type: 'object' } },
    domains: { type: 'array', items: { type: 'object' } },
    monthly: { type: 'array', items: { type: 'object' } },
    recent: { type: 'array', items: { type: 'object' } },
    scan: { type: 'object' },
    availability: { type: 'object' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok'],
};

function renderOverview(_args, value) {
  if (value?.ok !== true) return renderFailure(value);
  const totals = value.totals;
  const lines = [
    `Raindrop 概览：${value.user?.name ?? '未知用户'}${value.user?.pro === true ? '（Pro）' : ''} · 生成于 ${value.generatedAt}`,
    `收藏 ${totals.all} 条（未分类 ${totals.unsorted}，回收站 ${totals.trash}）；`
      + `收藏夹 ${totals.collections}，标签 ${totals.tags}；`
      + `死链 ${totals.broken}，无标签 ${totals.untagged}，重复 ${totals.duplicates}，重要 ${totals.important}`,
    `类型：${value.types.map((entry) => `${entry.type} ${entry.count}`).join(' · ')}`,
  ];
  if (value.collections.length > 0) {
    lines.push(
      `收藏夹 Top：${value.collections.map((entry) => `${entry.title}（${entry.count}）`).join('、')}`,
    );
  }
  if (value.tags.length > 0) {
    lines.push(`标签 Top：${value.tags.map((entry) => `#${entry.name}（${entry.count}）`).join('、')}`);
  }
  if (value.domains.length > 0) {
    lines.push(`域名 Top：${value.domains.map((entry) => `${entry.domain}（${entry.count}）`).join('、')}`);
  }
  lines.push(`月度新增：${value.monthly.map((entry) => `${entry.month} ${entry.count}`).join(' · ')}`);
  if (value.recent.length > 0) {
    lines.push('最近收藏：');
    for (const item of value.recent) {
      lines.push(
        `- ${item.title === '' ? '(无标题)' : item.title} · ${item.domain} · ${item.type} · ${item.created.slice(0, 10)}`,
      );
    }
  } else {
    lines.push('最近收藏：无样本');
  }
  const totalText = value.scan.total === null ? '' : ` / 共 ${value.scan.total} 条`;
  lines.push(
    `样本：已扫描 ${value.scan.scanned} 条${totalText}（${value.scan.complete ? '覆盖全库' : '基于最近样本'}）`,
  );
  if (value.warnings.length > 0) lines.push(`注意：${value.warnings.join('、')}`);
  const availability = value.availability ?? {};
  if (availability.broken === false || availability.duplicates === false) {
    lines.push('死链/重复检测：当前账号不提供该数据（免费版 Raindrop 不含此统计），不要把 0 当成「没有死链」。');
  }
  return text(lines.join('\n'));
}

async function executeOverview(store, options) {
  const token = store.readToken();
  if (token === null) return notConfigured();

  try {
    const client = createClient({ token, fetchImpl: options.fetchImpl });
    const dashboard = await buildDashboard(client, {
      scanPages: store.config?.scanPages,
      generatedAt: options.nowIso(),
    });
    return {
      ok: true,
      generatedAt: dashboard.generatedAt,
      user: dashboard.user,
      totals: dashboard.totals,
      types: dashboard.types,
      collections: dashboard.collections.slice(0, 8).map(({ id, title, count, depth }) => ({
        id,
        title,
        count,
        depth,
      })),
      tags: dashboard.tags.slice(0, 12).map(({ name, count }) => ({ name, count })),
      domains: dashboard.domains.slice(0, 8),
      monthly: dashboard.monthly,
      recent: dashboard.recent.slice(0, 5).map(({ id, title, domain, type, created }) => ({
        id,
        title,
        domain,
        type,
        created,
      })),
      scan: dashboard.scan,
      availability: dashboard.availability ?? {},
      warnings: dashboard.warnings,
    };
  } catch (error) {
    return toolFailure(error);
  }
}

// --------------------------------------------------------- raindrop_search

const SEARCH_DESCRIPTION =
  '在用户 Raindrop.io 收藏库中按关键词/标签检索书签（只读），返回标题、链接、域名、类型、标签、'
  + '收藏时间与摘要片段，用于进一步分析具体收藏。';

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    code: { type: 'string' },
    message: { type: 'string' },
    count: { type: 'integer' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          link: { type: 'string' },
          domain: { type: 'string' },
          type: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          created: { type: 'string' },
          important: { type: 'boolean' },
          broken: { type: 'boolean' },
          // Harness 的 JSON Schema 子集只允许单值 type；联合类型必须写成 oneOf
          // （且 oneOf 旁不能带 properties/required 等关键字）。
          excerpt: {
            description: '摘要片段；没有摘要时为 null。',
            oneOf: [{ type: 'string' }, { type: 'null' }],
          },
        },
      },
    },
  },
  required: ['ok'],
};

function renderSearch(_args, value) {
  if (value?.ok !== true) return renderFailure(value);
  if (value.count === 0 || value.items.length === 0) return text('没有匹配的收藏。');
  const lines = [`在 Raindrop 中检索到 ${value.count} 条（返回 ${value.items.length} 条）：`];
  for (const item of value.items) {
    const title = item.title === '' ? item.link : item.title;
    const bits = [item.domain, item.type];
    if (item.tags.length > 0) bits.push(item.tags.map((tag) => `#${tag}`).join(' '));
    if (item.created !== '') bits.push(`收藏于 ${item.created.slice(0, 10)}`);
    if (item.broken) bits.push('死链');
    if (item.important) bits.push('重要');
    lines.push(`- [${title}](${item.link}) · ${bits.join(' · ')}`);
  }
  return text(lines.join('\n'));
}

async function executeSearch(store, options, args) {
  const token = store.readToken();
  if (token === null) return notConfigured();

  const query = typeof args?.query === 'string' ? args.query.trim() : '';
  const tag = typeof args?.tag === 'string' ? args.tag.trim().replace(/^#+/, '') : '';
  const parts = [];
  if (query !== '') parts.push(query);
  if (tag !== '') parts.push(`#${tag}`);

  try {
    const client = createClient({ token, fetchImpl: options.fetchImpl });
    const result = await client.search({
      search: parts.join(' '),
      collectionId: Number.isInteger(args?.collectionId) ? args.collectionId : 0,
      limit: Number.isInteger(args?.limit) ? args.limit : 10,
    });
    return { ok: true, count: result.count, items: result.items };
  } catch (error) {
    return toolFailure(error);
  }
}

// ------------------------------------------------------------------- 工具表

/**
 * 组装工具定义数组。
 *
 * @param {ReturnType<typeof import('./store.js').createStore>} store
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] 便于离线测试注入。
 * @param {() => Date} [options.now] 便于离线测试注入。
 * @returns {Array<object>} 可直接交给 `ctx.tools.register()` 的定义。
 */
export function createTools(store, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const resolved = {
    fetchImpl: options.fetchImpl,
    nowIso: () => {
      const value = now();
      const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
      return date.toISOString();
    },
  };

  return [
    {
      name: 'raindrop_overview',
      description: OVERVIEW_DESCRIPTION,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      output: {
        schema: OVERVIEW_SCHEMA,
        render: renderOverview,
      },
      execute: () => executeOverview(store, resolved),
    },
    {
      name: 'raindrop_search',
      description: SEARCH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '关键词，匹配标题、摘要、域名等（Raindrop 搜索语法）。',
          },
          tag: { type: 'string', description: '标签名（不带 #）。' },
          collectionId: {
            type: 'integer',
            description: '0=全部（默认），-1=未分类，其它为收藏夹 id。',
          },
          limit: { type: 'integer', description: '1-20，默认 10。' },
        },
        additionalProperties: false,
      },
      timeoutMs: 30000,
      isConcurrencySafe: () => false,
      output: {
        schema: SEARCH_SCHEMA,
        render: renderSearch,
      },
      execute: (args) => executeSearch(store, resolved, args),
    },
  ];
}
