/**
 * host/store.js — 计划存储：内存实现（默认）+ 文件实现（预留、异步、原子写）。
 *
 * 设计依据：v1.2 §3.4（Host 私有存储域，key=sessionId，保留最近 5 版）、§3.5.2（CAS 提交）。
 *
 * 语义（两个 store 一致）：
 *   get(sessionId)              → plan | null（返回副本，改它不影响存储）
 *   getState(sessionId)         → { plan, suggestion } | null（持久化恢复用）
 *   put(plan, {cas,suggestion}) → boolean；cas 省略=无条件写，null=仅新建，{gen,rev}=期望当前版本；
 *                                 suggestion 存在时一并保存最近一次建议（undefined=保持不变）
 *   history(sessionId)          → plan[]（旧 → 新，含当前版本）
 *   prune(n = 5)                → 每会话只保留最近 n 版
 *   clear(sessionId?)           → boolean | number
 *   listSessions()              → sessionId[]
 *
 * createMemoryStore 同步；createFileStore 的方法全部为 async，但同样「永不 throw」：
 * 出错时返回 null/false/[]，并把原因记录到 `store.lastError`（字符串）。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULTS } from './config.js';
import { validVersion, versionEquals } from './plan.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;

function hasOwn(obj, key) {
  return isObj(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function clone(value) {
  if (value == null) return value;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch {
    /* fall through */
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function lightValidate(plan) {
  if (!isObj(plan)) return false;
  if (!isNonEmptyStr(plan.sessionId)) return false;
  if (!validVersion(plan.version)) return false;
  return true;
}

function casMatches(cas, state) {
  const current = state && state.plan ? state.plan : null;
  if (cas === undefined) return true;
  if (cas === null) return current == null;
  if (!validVersion(cas)) return false;
  if (!current) return false;
  return versionEquals(cas, current.version);
}

function pushHistory(state, plan) {
  const last = state.history[state.history.length - 1];
  if (last && versionEquals(last.version, plan.version)) {
    state.history[state.history.length - 1] = clone(plan);
  } else {
    state.history.push(clone(plan));
  }
}

/**
 * 创建内存计划存储。
 * @returns {object}
 */
export function createMemoryStore() {
  /** @type {Map<string, {plan: object, suggestion: object|null, history: object[]}>} */
  const states = new Map();

  function get(sessionId) {
    if (!isNonEmptyStr(sessionId)) return null;
    const state = states.get(sessionId);
    return state && state.plan ? clone(state.plan) : null;
  }

  function getState(sessionId) {
    if (!isNonEmptyStr(sessionId)) return null;
    const state = states.get(sessionId);
    if (!state || !state.plan) return null;
    return { plan: clone(state.plan), suggestion: state.suggestion ?? null };
  }

  function put(plan, options = {}) {
    if (!lightValidate(plan)) return false;
    const cas = hasOwn(options, 'cas') ? options.cas : undefined;
    const sessionId = plan.sessionId;
    const state = states.get(sessionId) ?? { plan: null, suggestion: null, history: [] };
    if (!casMatches(cas, state)) return false;
    state.plan = clone(plan);
    if (hasOwn(options, 'suggestion')) state.suggestion = clone(options.suggestion) ?? null;
    pushHistory(state, plan);
    states.set(sessionId, state);
    return true;
  }

  function history(sessionId) {
    if (!isNonEmptyStr(sessionId)) return [];
    const state = states.get(sessionId);
    return state ? state.history.map((plan) => clone(plan)) : [];
  }

  function prune(n = DEFAULTS.keepVersions) {
    const keep = Math.max(1, Math.floor(Number.isFinite(n) ? n : DEFAULTS.keepVersions));
    let removed = 0;
    let sessions = 0;
    for (const state of states.values()) {
      sessions += 1;
      if (state.history.length > keep) {
        removed += state.history.length - keep;
        state.history = state.history.slice(-keep);
      }
    }
    return { ok: true, removed, sessions, keep };
  }

  function clear(sessionId) {
    if (sessionId === undefined) {
      const count = states.size;
      states.clear();
      return count;
    }
    if (!isNonEmptyStr(sessionId)) return false;
    return states.delete(sessionId);
  }

  function listSessions() {
    return [...states.keys()];
  }

  return { get, getState, put, history, prune, clear, listSessions, size: () => states.size };
}

/* ──────────────────────────────────────────────────────────────
 * 文件存储（预留；运行时不强依赖）
 * ────────────────────────────────────────────────────────────── */

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function encodeSessionId(sessionId) {
  return Buffer.from(sessionId, 'utf8').toString('base64url');
}

function decodeSessionId(name) {
  try {
    return Buffer.from(name, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 创建文件计划存储（异步）。每个会话一个 JSON 文件，写入走「tmp 文件 + rename」的原子替换。
 *
 * 说明：这是为 P2+ 预留的持久化接口，单进程假设、无跨进程锁；运行时不强依赖。
 *
 * @param {string} dir 存储目录（不存在会自动创建）
 * @returns {object} 所有方法 async 且不 throw；出错返回 null/false/[] 并写 `lastError`
 */
export function createFileStore(dir) {
  const enabled = isNonEmptyStr(dir);
  const root = enabled ? dir.trim() : '';
  const plansDir = enabled ? join(root, 'plans') : '';
  let lastError = '';

  const store = {
    kind: 'file',
    dir: root,
    enabled,
    get lastError() {
      return lastError;
    },
    async get(sessionId) {
      if (!enabled || !isNonEmptyStr(sessionId)) return null;
      const data = await readState(sessionId);
      return data && isObj(data.plan) ? clone(data.plan) : null;
    },
    async getState(sessionId) {
      if (!enabled || !isNonEmptyStr(sessionId)) return null;
      const data = await readState(sessionId);
      if (!data || !isObj(data.plan)) return null;
      return { plan: clone(data.plan), suggestion: isObj(data.suggestion) ? clone(data.suggestion) : null };
    },
    async put(plan, options = {}) {
      if (!enabled || !lightValidate(plan)) return false;
      try {
        const cas = hasOwn(options, 'cas') ? options.cas : undefined;
        const sessionId = plan.sessionId;
        const data = (await readState(sessionId)) ?? { sessionId, plan: null, suggestion: null, history: [] };
        if (!casMatches(cas, data)) return false;
        data.plan = clone(plan);
        data.sessionId = sessionId;
        if (hasOwn(options, 'suggestion')) data.suggestion = clone(options.suggestion) ?? null;
        if (!Array.isArray(data.history)) data.history = [];
        const last = data.history[data.history.length - 1];
        if (last && versionEquals(last.version, plan.version)) data.history[data.history.length - 1] = clone(plan);
        else data.history.push(clone(plan));
        await writeState(sessionId, data);
        return true;
      } catch (err) {
        lastError = errText(err);
        return false;
      }
    },
    async history(sessionId) {
      if (!enabled || !isNonEmptyStr(sessionId)) return [];
      const data = await readState(sessionId);
      return data && Array.isArray(data.history) ? data.history.map((plan) => clone(plan)) : [];
    },
    async prune(n = DEFAULTS.keepVersions) {
      if (!enabled) return { ok: false, removed: 0, sessions: 0, keep: 0 };
      const keep = Math.max(1, Math.floor(Number.isFinite(n) ? n : DEFAULTS.keepVersions));
      let removed = 0;
      let sessions = 0;
      const ids = await listSessions();
      for (const sessionId of ids) {
        const data = await readState(sessionId);
        if (!data || !Array.isArray(data.history)) continue;
        sessions += 1;
        if (data.history.length > keep) {
          removed += data.history.length - keep;
          data.history = data.history.slice(-keep);
          await writeState(sessionId, data);
        }
      }
      return { ok: true, removed, sessions, keep };
    },
    async clear(sessionId) {
      if (!enabled) return false;
      try {
        if (sessionId === undefined) {
          const ids = await listSessions();
          let count = 0;
          for (const id of ids) {
            if (await removeState(id)) count += 1;
          }
          return count;
        }
        if (!isNonEmptyStr(sessionId)) return false;
        return removeState(sessionId);
      } catch (err) {
        lastError = errText(err);
        return false;
      }
    },
    async listSessions() {
      return listSessions();
    },
    async size() {
      return (await listSessions()).length;
    },
  };

  function errText(err) {
    return err && typeof err.message === 'string' ? err.message : String(err);
  }

  function fileFor(sessionId) {
    return join(plansDir, `${encodeSessionId(sessionId)}.json`);
  }

  async function readState(sessionId) {
    if (!enabled || !isNonEmptyStr(sessionId)) return null;
    try {
      const raw = await readFile(fileFor(sessionId), 'utf8');
      const data = JSON.parse(raw);
      return isObj(data) ? data : null;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      lastError = errText(err);
      return null;
    }
  }

  async function writeState(sessionId, data) {
    await mkdir(plansDir, { recursive: true });
    const target = fileFor(sessionId);
    const tmp = `${target}.${process.pid}.${randomUUID().replace(/-/g, '').slice(0, 12)}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(data)}\n`, 'utf8');
      await rename(tmp, target);
    } catch (err) {
      try {
        await rm(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  async function removeState(sessionId) {
    try {
      await rm(fileFor(sessionId), { force: true });
      return true;
    } catch (err) {
      lastError = errText(err);
      return false;
    }
  }

  async function listSessions() {
    if (!enabled) return [];
    try {
      const names = await readdir(plansDir);
      const ids = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const base = name.slice(0, -5);
        if (!BASE64URL_RE.test(base)) continue;
        const sessionId = decodeSessionId(base);
        if (sessionId) ids.push(sessionId);
      }
      return ids;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
      lastError = errText(err);
      return [];
    }
  }

  return store;
}
