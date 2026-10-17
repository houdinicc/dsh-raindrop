/**
 * Raindrop 仪表盘（dsh-raindrop）—— 宿主半入口。
 *
 * 本文件不 import 任何 `@deepseek-ai/*` 包：Raindrop 数据、token 存储与
 * HTTP 路由都由插件自管。可选服务用 `ctx.inject([...], cb)` 声明，缺了它的
 * profile 里插件只是少一块能力，而不是抛错。
 *
 * 模块分工见 CONTRACT.md：store（token/配置）→ api（Raindrop 客户端 + 聚合）
 * → routes（HTTP）与 tools（Agent 工具）。
 *
 * @module dsh-raindrop
 */

import { createStore, resolveDataDir } from './store.js';
import { createRoutes } from './routes.js';
import { createTools } from './tools.js';

/** profile 的 cordis.patch.yml 未给 config 时的缺省值。 */
const DEFAULT_CONFIG = {
  scanPages: 8,
  cacheTtlSeconds: 300,
  enableTools: true,
};

/**
 * 插件入口。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - patch 行的 `config:` 对象。
 */
export function apply(ctx, config) {
  const resolved = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const store = createStore({ dir: resolveDataDir(), defaults: resolved });

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const routes = createRoutes(store);
      const disposers = routes.map((route) => webCtx.webServer.register(route));
      webCtx.logger?.info?.(`dsh-raindrop: 已注册 ${disposers.length} 条路由`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-raindrop: web routes');
  });

  if (resolved.enableTools !== false) {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => {
        const definitions = createTools(store);
        const disposers = definitions.map((definition) => toolCtx.tools.register(definition));
        toolCtx.logger?.info?.(
          `dsh-raindrop: 已注册 ${definitions.length} 个 Agent 工具（${definitions
            .map((definition) => definition.name)
            .join(', ')}）`,
        );
        return () => {
          for (const dispose of disposers) if (typeof dispose === 'function') dispose();
        };
      }, 'dsh-raindrop: agent tools');
    });
  }

  ctx.logger?.info?.(`dsh-raindrop: 宿主半已激活（数据文件 ${store.file}）`);
}
