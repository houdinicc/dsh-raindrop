/**
 * Raindrop 仪表盘 —— 数据层（不是收藏库本身，只是插件自己的配置）。
 *
 * 只持久化两样东西：用户的 Raindrop API Token 与「这个 token 对应的用户信息」
 * 缓存。收藏数据不落盘，每次由 api.js 现取。
 *
 * 设计取舍：
 *  - 零依赖：只用 node:* 内置模块，插件因此不需要 pnpm 安装；
 *  - 单文件 `$DSH_HOME/dsh-raindrop/config.json`；
 *  - 写入是「临时文件 + rename」的原子替换，目录 0700、文件 0600；
 *  - 文件缺失或 JSON 损坏**不抛错**，按未配置处理，下次写入直接覆盖。
 *
 * 本模块不依赖 Cordis，可单独测试。
 *
 * @module dsh-raindrop/store
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** patch 未给 config 时的缺省值（与 lib/index.js 的 DEFAULT_CONFIG 保持一致）。 */
const DEFAULT_CONFIG = {
  scanPages: 8,
  cacheTtlSeconds: 300,
  enableTools: true,
};

const FILE_NAME = 'config.json';

/** `$DSH_HOME`（缺省 `~/.dsh`）下的插件私有数据目录。 */
export function resolveDataDir() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-raindrop');
}

function asStringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function asBooleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

/** 把磁盘上的任意结构修成 `{ token, user }`；不认识的内容一律丢弃。 */
function normalizeState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { token: null, user: null };
  }
  const token = asStringOrNull(raw.token);
  let user = null;
  if (raw.user !== null && typeof raw.user === 'object' && !Array.isArray(raw.user)) {
    const name = asStringOrNull(raw.user.name);
    const pro = asBooleanOrNull(raw.user.pro);
    if (name !== null || pro !== null) user = { name, pro };
  }
  return { token, user };
}

/**
 * 打开（或首次创建）插件配置。
 *
 * @param {object} [options]
 * @param {string} [options.dir] 数据目录；缺省 `resolveDataDir()`。
 * @param {object} [options.defaults] 覆盖缺省 config。
 * @returns {{
 *   file: string,
 *   config: { scanPages: number, cacheTtlSeconds: number, enableTools: boolean },
 *   readToken(): string|null,
 *   writeToken(token: string): void,
 *   clearToken(): void,
 *   readUserCache(): { name: string|null, pro: boolean|null } | null,
 *   writeUserCache(user: { name?: string|null, pro?: boolean|null }): void,
 * }}
 */
export function createStore(options = {}) {
  const dir =
    typeof options.dir === 'string' && options.dir.trim() !== '' ? options.dir.trim() : resolveDataDir();
  const file = path.join(dir, FILE_NAME);
  const config = { ...DEFAULT_CONFIG, ...(options.defaults ?? {}) };

  /** 读盘；任何失败都当作未配置，不抛错。 */
  function load() {
    try {
      return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return { token: null, user: null };
    }
  }

  /** 原子写：tmp + rename，目录 0700、文件 0600。 */
  function persist(state) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* 目录权限不是致命问题，继续写 */
    }
    const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        /* 见上 */
      }
      fs.renameSync(tmp, file);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      throw error;
    }
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* 见上 */
    }
  }

  return {
    file,
    config,

    readToken() {
      return load().token;
    },

    /** 保存 token：同时作废旧用户缓存（token 换了，用户信息不再可信）。 */
    writeToken(token) {
      const value = asStringOrNull(typeof token === 'string' ? token.trim() : '');
      persist({ token: value, user: null });
    },

    clearToken() {
      persist({ token: null, user: null });
    },

    readUserCache() {
      const { user } = load();
      return user === null ? null : { name: user.name, pro: user.pro };
    },

    writeUserCache(user) {
      const current = load();
      const name = asStringOrNull(user?.name);
      const pro = asBooleanOrNull(user?.pro);
      persist({ token: current.token, user: name === null && pro === null ? null : { name, pro } });
    },
  };
}
