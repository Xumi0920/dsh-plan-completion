/**
 * host/plan.js — Plan 数据模型、校验与版本规则（纯函数，零依赖）。
 *
 * 设计依据：v1.2 §3.4（数据模型）、§3.5.1/§3.5.2（版本与一致性）、§3.8（用户编辑优先）。
 *
 * 约定：
 *  - 所有公共函数「永不 throw」，失败返回 `{ok:false, code, error}`；
 *  - 输入永不被修改，返回的是新对象；
 *  - 版本规则：rewrite → `gen+1, rev=0`；patch → `gen.rev+1`；首个版本 `0.0`；
 *  - 用户编辑 → `gen+1, rev=0`、`editedByUser=true`、改动的步骤 `source='user'`；
 *  - 只保留最近 N 版由存储层（store.js）负责，本模块只打版本号。
 */

import { normalizeCompletion, normalizeConstraints } from './acceptance.js';
import { normalizeAcceptance, normalizeProof } from './progress-schema.js';
import { DEFAULTS } from './config.js';
import { clampChars, oneLine } from './text.js';

/** 计划状态枚举。 */
export const PLAN_STATUSES = Object.freeze(['active', 'completed', 'archived']);
/** 步骤状态枚举。 */
export const STEP_STATUSES = Object.freeze(['todo', 'doing', 'blocked', 'done', 'dropped']);
/** 步骤来源枚举。 */
export const STEP_SOURCES = Object.freeze(['model', 'user']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const isNonEmptyStr = (v) => isStr(v) && v.trim().length > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const fail = (code, error) => ({ ok: false, code, error });

function errMsg(err) {
  if (err && typeof err.message === 'string') return err.message;
  return String(err);
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

function metaNow(meta) {
  return isObj(meta) && isNum(meta.now) ? meta.now : Date.now();
}

function clampReason(value) {
  return clampChars(oneLine(value), DEFAULTS.maxReasonChars);
}

function clampTitle(value) {
  return clampChars(oneLine(value), DEFAULTS.maxTitleChars);
}

function clampIntent(value) {
  return clampChars(oneLine(value), DEFAULTS.maxIntentChars);
}

/**
 * 校验并规范化版本号。
 * @param {unknown} value
 * @returns {{gen:number, rev:number}|null}
 */
export function validVersion(value) {
  if (!isObj(value)) return null;
  if (!isNonNegInt(value.gen) || !isNonNegInt(value.rev)) return null;
  return { gen: value.gen, rev: value.rev };
}

/**
 * 校验并规范化 watermark。
 * @param {unknown} value
 * @returns {{turn:number, seq:number}|null}
 */
export function validWatermark(value) {
  if (!isObj(value)) return null;
  if (!isNonNegInt(value.turn) || !isNonNegInt(value.seq)) return null;
  return { turn: value.turn, seq: value.seq };
}

/**
 * 规范化证据数组（字符串数组，去空、截断、限量）。
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeEvidence(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const text = clampChars(oneLine(item), DEFAULTS.maxEvidenceChars);
    if (text) out.push(text);
    if (out.length >= DEFAULTS.maxEvidencePerStep) break;
  }
  return out;
}

function mergeEvidence(prev, next) {
  const merged = [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(next) ? next : [])];
  const uniq = [];
  for (const item of merged) if (!uniq.includes(item)) uniq.push(item);
  return uniq.slice(-DEFAULTS.maxEvidencePerStep);
}

/**
 * 规范化步骤数组：3~7 条、id 唯一、title 非空、status/source 枚举。
 *
 * @param {unknown} input
 * @returns {{ok:true, steps:Array}|{ok:false, code:string, error:string}}
 */
export function normalizeSteps(input) {
  if (!Array.isArray(input)) return fail('bad-steps', 'steps 必须是数组');
  if (input.length < DEFAULTS.minSteps || input.length > DEFAULTS.maxSteps) {
    return fail(
      'bad-step-count',
      `步骤数必须为 ${DEFAULTS.minSteps}~${DEFAULTS.maxSteps} 条（当前 ${input.length} 条）`,
    );
  }
  const used = new Set();
  const steps = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (!isObj(raw)) return fail('bad-step', `第 ${i + 1} 步必须是对象`);
    if (typeof raw.id !== 'string' || !raw.id.trim()) {
      return fail('bad-step-id', `第 ${i + 1} 步缺少非空 id`);
    }
    const id = clampChars(raw.id.trim(), 64);
    if (used.has(id)) return fail('duplicate-step-id', `步骤 id 重复：${id}`);
    used.add(id);
    if (!isNonEmptyStr(raw.title)) return fail('bad-step-title', `步骤 ${id} 的 title 不能为空`);
    const status = raw.status == null ? 'todo' : raw.status;
    if (!STEP_STATUSES.includes(status)) {
      return fail('bad-step-status', `步骤 ${id} 的 status 非法：${String(status)}`);
    }
    const source = raw.source == null ? 'model' : raw.source;
    if (!STEP_SOURCES.includes(source)) {
      return fail('bad-step-source', `步骤 ${id} 的 source 非法：${String(source)}`);
    }
    const step = { id, title: clampTitle(raw.title), status, source };
    const completion = normalizeCompletion(raw.completion);
    if (completion) step.completion = completion;
    if (raw.acceptance !== undefined) {
      const acceptance = normalizeAcceptance(raw.acceptance);
      if (!acceptance) return fail('bad-acceptance', `步骤 ${id} 的验收版本非法`);
      step.acceptance = acceptance;
    }
    if (source === 'user' && step.acceptance?.scope === 'manual' && raw.confirmation?.actor === 'user'
      && raw.confirmation.revision === step.acceptance.revision && Number.isFinite(raw.confirmation.at)
      && Number.isSafeInteger(raw.confirmation.seq) && raw.confirmation.seq >= 0) {
      step.confirmation = { actor: 'user', revision: raw.confirmation.revision, at: raw.confirmation.at, seq: raw.confirmation.seq };
    }
    const proof = normalizeProof(raw.proof);
    if (proof) step.proof = proof;
    if (typeof raw.lifecycle === 'string') step.lifecycle = raw.lifecycle.slice(0, 40);
    const evidence = normalizeEvidence(raw.evidence);
    if (evidence.length) step.evidence = evidence;
    steps.push(step);
  }
  return { ok: true, steps };
}

/**
 * 计划状态推导：全部 done/dropped → completed，否则 active。
 * @param {Array<{status?:string}>} steps
 * @returns {'active'|'completed'}
 */
export function statusFor(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return 'active';
  for (const step of steps) {
    if (!step || (step.status !== 'done' && step.status !== 'dropped')) return 'active';
  }
  return 'completed';
}

/**
 * 计算下一个版本号。
 * @param {{gen:number,rev:number}|null|undefined} prev
 * @param {'patch'|'rewrite'|'user-edit'} [kind]
 * @returns {{gen:number, rev:number}}
 */
export function nextVersion(prev, kind = 'patch') {
  const base = validVersion(prev);
  if (!base) return { gen: 0, rev: 0 };
  if (kind === 'patch') return { gen: base.gen, rev: base.rev + 1 };
  return { gen: base.gen + 1, rev: 0 };
}

/**
 * 版本是否相等。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function versionEquals(a, b) {
  const va = validVersion(a);
  const vb = validVersion(b);
  if (!va || !vb) return false;
  return va.gen === vb.gen && va.rev === vb.rev;
}

/**
 * 版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const va = validVersion(a);
  const vb = validVersion(b);
  if (!va && !vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;
  if (va.gen !== vb.gen) return va.gen > vb.gen ? 1 : -1;
  if (va.rev !== vb.rev) return va.rev > vb.rev ? 1 : -1;
  return 0;
}

/**
 * next 是否是 prev 的严格下一版本（patch 的 rev+1 或 rewrite 的 gen+1.rev=0）。
 * @param {unknown} prev
 * @param {unknown} next
 * @returns {boolean}
 */
export function isNextVersion(prev, next) {
  const vb = validVersion(next);
  if (!vb) return false;
  const va = validVersion(prev);
  if (!va) return vb.gen === 0 && vb.rev === 0;
  return (vb.gen === va.gen && vb.rev === va.rev + 1) || (vb.gen === va.gen + 1 && vb.rev === 0);
}

function stepsEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * 校验并规范化 Plan（设计 §3.4 字段一个不少；未知字段丢弃）。
 *
 * @param {unknown} input
 * @param {{now?: (() => number), requireReason?: boolean}} [options]
 * @returns {{ok:true, plan:object}|{ok:false, code:string, error:string}}
 */
export function normalizePlan(input, options = {}) {
  try {
    if (!isObj(input)) return fail('not-object', '计划必须是 JSON 对象');
    const requireReason = options.requireReason !== false;
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    if (!isNonEmptyStr(input.sessionId)) return fail('bad-session', 'sessionId 不能为空');
    const sessionId = clampChars(input.sessionId.trim(), 128);

    const stepsRes = normalizeSteps(input.steps);
    if (!stepsRes.ok) return stepsRes;

    const status = input.status == null ? 'active' : input.status;
    if (!PLAN_STATUSES.includes(status)) return fail('bad-status', `status 非法：${String(status)}`);

    let intent = '';
    if (input.intent != null) {
      if (!isStr(input.intent)) return fail('bad-intent', 'intent 必须是字符串');
      intent = clampIntent(input.intent);
    }

    let version = { gen: 0, rev: 0 };
    if (input.version != null) {
      const v = validVersion(input.version);
      if (!v) return fail('bad-version', 'version 必须是 {gen, rev} 非负整数');
      version = v;
    }

    let revisionOf;
    if (input.revisionOf != null) {
      const v = validVersion(input.revisionOf);
      if (!v) return fail('bad-revision-of', 'revisionOf 必须是 {gen, rev} 非负整数');
      revisionOf = v;
    }

    const updatedAt = isNum(input.updatedAt) ? input.updatedAt : now();

    let reason = '';
    if (requireReason) {
      if (!isNonEmptyStr(input.reason)) return fail('missing-reason', 'reason 必填（每次版本变更都要带原因）');
      reason = clampReason(input.reason);
    } else if (isNonEmptyStr(input.reason)) {
      reason = clampReason(input.reason);
    }

    let watermark = { turn: 0, seq: 0 };
    if (input.watermark != null) {
      const w = validWatermark(input.watermark);
      if (!w) return fail('bad-watermark', 'watermark 必须是 {turn, seq} 非负整数');
      watermark = w;
    }

    let editedByUser = false;
    if (input.editedByUser != null) {
      if (typeof input.editedByUser !== 'boolean') return fail('bad-edited-by-user', 'editedByUser 必须是布尔值');
      editedByUser = input.editedByUser;
    }

    const plan = { sessionId, version, status, intent, steps: stepsRes.steps, updatedAt, reason, watermark, editedByUser };
    if (revisionOf) plan.revisionOf = revisionOf;
    if (input.constraints) plan.constraints = normalizeConstraints(input.constraints);

    if (input.stats != null) {
      if (!isObj(input.stats)) return fail('bad-stats', 'stats 必须是对象');
      const stats = {};
      for (const key of ['calls', 'tokensIn', 'tokensOut']) {
        if (isNum(input.stats[key])) stats[key] = input.stats[key];
      }
      if (Object.keys(stats).length) plan.stats = stats;
    }

    return { ok: true, plan };
  } catch (err) {
    return fail('internal', `计划校验异常：${errMsg(err)}`);
  }
}

/**
 * 版本规则：模型只能 patch 的情况返回 false。
 * 用户编辑过的计划（editedByUser）模型不得自动 rewrite 覆盖；/replan 用 `{force:true}` 放行。
 *
 * @param {object|null|undefined} plan
 * @param {{force?: boolean}} [options]
 * @returns {boolean}
 */
export function mayRewrite(plan, options = {}) {
  if (options && options.force === true) return true;
  if (plan == null) return true;
  if (!isObj(plan)) return false;
  if (plan.status === 'archived') return false;
  return plan.editedByUser !== true;
}

function loadPlan(plan, code = 'bad-plan') {
  if (!isObj(plan)) return fail(code, '现有计划必须是对象');
  const res = normalizePlan(plan, { requireReason: false });
  if (!res.ok) return fail(code, `现有计划非法：${res.error}`);
  return res;
}

/**
 * 执行一次 patch：只改指定步骤的字段，版本 `gen.rev+1`。
 *
 * @param {object} plan 当前计划
 * @param {Array<object>} changes `[{id, status?, title?, evidence?, source?}]`
 * @param {{reason?: string, watermark?: {turn:number,seq:number}, now?: number}} meta
 * @returns {{ok:true, plan:object, changed:boolean, previous:object}|{ok:false, code:string, error:string}}
 */
export function patchPlan(plan, changes, meta = {}) {
  try {
    const loaded = loadPlan(plan);
    if (!loaded.ok) return loaded;
    const cur = loaded.plan;
    if (cur.status === 'archived') return fail('archived', '归档计划不可 patch');

    if (!Array.isArray(changes) || changes.length === 0) {
      return fail('empty-changes', 'changes 不能为空');
    }

    const steps = cur.steps.map((step) => {
      const copy = { ...step };
      if (step.evidence) copy.evidence = [...step.evidence];
      return copy;
    });
    const byId = new Map(steps.map((step) => [step.id, step]));

    for (let i = 0; i < changes.length; i += 1) {
      const change = changes[i];
      if (!isObj(change)) return fail('bad-change', `第 ${i + 1} 条变更必须是对象`);
      if (typeof change.id !== 'string' || !change.id.trim()) {
        return fail('bad-change-id', `第 ${i + 1} 条变更缺少非空 id`);
      }
      const id = change.id.trim();
      const step = byId.get(id);
      if (!step) return fail('unknown-step', `changes 引用了不存在的步骤 id：${id}`);
      let applied = false;

      if (change.title && change.title !== step.title) {
        if (step.acceptance) { step.acceptance = { ...step.acceptance, revision: step.acceptance.revision + 1, scope: 'manual', afterSeq: meta.watermark?.seq ?? cur.watermark.seq }; delete step.proof; }
        delete step.completion; delete step.lifecycle; delete step.evidence;
      }
      if (change.completion !== undefined) { step.completion = normalizeCompletion(change.completion); applied = true; }
      if (change.acceptance !== undefined) {
        const acceptance = normalizeAcceptance(change.acceptance);
        if (!acceptance) return fail('bad-change-acceptance', `步骤 ${id} 的验收版本非法`);
        step.acceptance = acceptance; applied = true;
      }
      if (change.proof !== undefined) { const proof = normalizeProof(change.proof); if(proof) step.proof=proof;else delete step.proof; applied=true; }
      if (change.lifecycle !== undefined) { step.lifecycle = String(change.lifecycle).slice(0, 40); applied = true; }
      if (change.status !== undefined) {
        if (!STEP_STATUSES.includes(change.status)) {
          return fail('bad-change-status', `步骤 ${id} 的 status 非法：${String(change.status)}`);
        }
        step.status = change.status;
        applied = true;
      }
      if (change.title !== undefined) {
        if (!isNonEmptyStr(change.title)) return fail('bad-change-title', `步骤 ${id} 的 title 不能为空`);
        step.title = clampTitle(change.title);
        applied = true;
      }
      if (change.source !== undefined) {
        if (!STEP_SOURCES.includes(change.source)) {
          return fail('bad-change-source', `步骤 ${id} 的 source 非法：${String(change.source)}`);
        }
        step.source = change.source;
        applied = true;
      }
      if (change.evidence !== undefined) {
        if (!Array.isArray(change.evidence)) {
          return fail('bad-change-evidence', `步骤 ${id} 的 evidence 必须是字符串数组`);
        }
        const merged = change.lifecycle ? normalizeEvidence(change.evidence) : mergeEvidence(step.evidence, normalizeEvidence(change.evidence));
        if (merged.length) step.evidence = merged;
        else delete step.evidence;
        applied = true;
      }
      if (!applied) return fail('empty-change', `第 ${i + 1} 条变更没有任何可应用字段`);
    }

    if (!isNonEmptyStr(meta.reason)) return fail('missing-reason', 'patch 的 reason 必填');
    const updatedAt = metaNow(meta);
    const watermark = validWatermark(meta.watermark) ?? cur.watermark;
    const status = statusFor(steps);
    const candidate = {
      sessionId: cur.sessionId,
      version: nextVersion(cur.version, 'patch'),
      status,
      intent: cur.intent,
      constraints: normalizeConstraints(cur.constraints),
      steps,
      updatedAt,
      reason: clampReason(meta.reason),
      revisionOf: cur.version,
      watermark,
      editedByUser: cur.editedByUser,
    };
    if (cur.stats) candidate.stats = cur.stats;
    const norm = normalizePlan(candidate, { requireReason: true, now: () => updatedAt });
    if (!norm.ok) return fail('bad-next-plan', `patch 后计划非法：${norm.error}`);

    const changed = !stepsEqual(cur.steps, norm.plan.steps) || cur.status !== norm.plan.status;
    return { ok: true, plan: norm.plan, changed, previous: clone(cur) };
  } catch (err) {
    return fail('internal', `patch 异常：${errMsg(err)}`);
  }
}

/**
 * 执行一次 rewrite：整体替换步骤，版本 `gen+1, rev=0`。
 * 用户编辑过的计划默认拒绝（`meta.force` 为 true 时放行，对应 /replan）。
 *
 * @param {object|null} plan 当前计划（冷启动传 null）
 * @param {{steps:Array, intent?:string, reason?:string}} next
 * @param {{reason?:string, watermark?:object, now?:number, force?:boolean, sessionId?:string}} meta
 * @returns {{ok:true, plan:object, changed:boolean, previous:object|null}|{ok:false, code:string, error:string}}
 */
export function rewritePlan(plan, next, meta = {}) {
  try {
    const curRes = plan == null ? { ok: true, plan: null } : loadPlan(plan);
    if (!curRes.ok) return curRes;
    const cur = curRes.plan;
    const force = meta.force === true;
    if (cur && !mayRewrite(cur, { force })) {
      return fail('locked-by-user', '用户已编辑计划，模型不能自动 rewrite 覆盖（需用户 /replan 强制）');
    }
    if (!isObj(next)) return fail('bad-next', 'rewrite 内容必须是对象');
    const stepsRes = normalizeSteps(next.steps);
    if (!stepsRes.ok) return stepsRes;
    const steps = stepsRes.steps.map((step) => ({ ...step, source: 'model' }));

    let reason = '';
    if (isNonEmptyStr(meta.reason)) reason = clampReason(meta.reason);
    else if (isNonEmptyStr(next.reason)) reason = clampReason(next.reason);
    if (!reason) return fail('missing-reason', 'rewrite 的 reason 必填');

    let sessionId = cur?.sessionId ?? '';
    if (!sessionId && isNonEmptyStr(meta.sessionId)) sessionId = clampChars(meta.sessionId.trim(), 128);
    if (!sessionId) return fail('bad-session', 'rewrite 缺少 sessionId');

    let intent = cur?.intent ?? '';
    if (next.intent != null) {
      if (!isStr(next.intent)) return fail('bad-intent', 'intent 必须是字符串');
      intent = clampIntent(next.intent);
    }

    const updatedAt = metaNow(meta);
    const watermark = validWatermark(meta.watermark) ?? cur?.watermark ?? { turn: 0, seq: 0 };
    const candidate = {
      sessionId,
      version: cur ? nextVersion(cur.version, 'rewrite') : { gen: 0, rev: 0 },
      status: statusFor(steps),
      intent,
      constraints: normalizeConstraints(next.constraints ?? cur?.constraints),
      steps,
      updatedAt,
      reason,
      watermark,
      // /replan 强制重写意味着用户主动要求模型重建计划：覆盖用户编辑标记，后续可再自动 rewrite。
      editedByUser: force ? false : cur?.editedByUser ?? false,
    };
    if (cur) candidate.revisionOf = cur.version;
    if (cur?.stats) candidate.stats = cur.stats;
    const norm = normalizePlan(candidate, { requireReason: true, now: () => updatedAt });
    if (!norm.ok) return fail('bad-next-plan', `rewrite 后计划非法：${norm.error}`);

    const changed = !cur
      ? true
      : !stepsEqual(cur.steps, norm.plan.steps) || cur.intent !== norm.plan.intent || cur.status !== norm.plan.status;
    return { ok: true, plan: norm.plan, changed, previous: cur ? clone(cur) : null };
  } catch (err) {
    return fail('internal', `rewrite 异常：${errMsg(err)}`);
  }
}

/**
 * 用户手动编辑计划：版本 `gen+1, rev=0`、reason 默认 'user edit'、
 * 改动/新增步骤 `source='user'`、`editedByUser=true`（设计 §3.8）。
 *
 * @param {object} plan
 * @param {{steps:Array, intent?:string}} next
 * @param {{reason?:string, watermark?:object, now?:number}} meta
 * @returns {{ok:true, plan:object, changed:boolean, previous:object}|{ok:false, code:string, error:string}}
 */
export function applyUserEdit(plan, next, meta = {}) {
  try {
    const loaded = loadPlan(plan);
    if (!loaded.ok) return loaded;
    const cur = loaded.plan;
    if (cur.status === 'archived') return fail('archived', '归档计划不可编辑');
    if (!isObj(next)) return fail('bad-next', '用户编辑内容必须是对象');
    const stepsRes = normalizeSteps(next.steps);
    if (!stepsRes.ok) return stepsRes;

    const oldById = new Map(cur.steps.map((step) => [step.id, step]));
    const steps = stepsRes.steps.map((step) => {
      const old = oldById.get(step.id);
      // 「未改动」只看用户可编辑字段（标题/状态）；evidence 是模型追加的证据链，不算用户编辑。
      const unchanged = old && old.title === step.title && old.status === step.status;
      if (old?.acceptance) {
        step.acceptance = unchanged ? old.acceptance : { ...old.acceptance, revision: old.acceptance.revision + 1, afterSeq: meta.watermark?.seq ?? cur.watermark.seq };
        if (!unchanged) { delete step.proof; delete step.evidence; }
      }
      return { ...step, source: unchanged ? old.source : 'user' };
    });

    let intent = cur.intent;
    if (next.intent != null) {
      if (!isStr(next.intent)) return fail('bad-intent', 'intent 必须是字符串');
      intent = clampIntent(next.intent);
    }

    const updatedAt = metaNow(meta);
    const candidate = {
      sessionId: cur.sessionId,
      version: { gen: cur.version.gen + 1, rev: 0 },
      status: statusFor(steps),
      intent,
      constraints: normalizeConstraints(next.constraints ?? cur?.constraints),
      steps,
      updatedAt,
      reason: isNonEmptyStr(meta.reason) ? clampReason(meta.reason) : 'user edit',
      revisionOf: cur.version,
      watermark: validWatermark(meta.watermark) ?? cur.watermark,
      editedByUser: true,
    };
    if (cur.stats) candidate.stats = cur.stats;
    const norm = normalizePlan(candidate, { requireReason: true, now: () => updatedAt });
    if (!norm.ok) return fail('bad-next-plan', `用户编辑后计划非法：${norm.error}`);
    return { ok: true, plan: norm.plan, changed: true, previous: clone(cur) };
  } catch (err) {
    return fail('internal', `用户编辑异常：${errMsg(err)}`);
  }
}

/**
 * 归档当前计划（议题剧变 / 全完成后开新计划）。
 *
 * @param {object} plan
 * @param {{reason?:string, watermark?:object, now?:number}} meta
 * @returns {{ok:true, plan:object, changed:boolean, previous:object}|{ok:false, code:string, error:string}}
 */
export function archivePlan(plan, meta = {}) {
  try {
    const loaded = loadPlan(plan);
    if (!loaded.ok) return loaded;
    const cur = loaded.plan;
    const updatedAt = metaNow(meta);
    const candidate = {
      ...cur,
      version: nextVersion(cur.version, 'rewrite'),
      status: 'archived',
      updatedAt,
      reason: isNonEmptyStr(meta.reason) ? clampReason(meta.reason) : 'topic-drift',
      revisionOf: cur.version,
      watermark: validWatermark(meta.watermark) ?? cur.watermark,
    };
    const norm = normalizePlan(candidate, { requireReason: true, now: () => updatedAt });
    if (!norm.ok) return fail('bad-next-plan', `归档后计划非法：${norm.error}`);
    return { ok: true, plan: norm.plan, changed: true, previous: clone(cur) };
  } catch (err) {
    return fail('internal', `归档异常：${errMsg(err)}`);
  }
}

/**
 * 冷启动 / 降级时生成种子计划（首版 `0.0`）。
 *
 * @param {{sessionId: string, intent?: string, steps: Array, watermark?: object, reason?: string}} input
 * @param {{now?: number}} [meta]
 * @returns {{ok:true, plan:object}|{ok:false, code:string, error:string}}
 */
export function createSeedPlan(input, meta = {}) {
  try {
    if (!isObj(input)) return fail('bad-input', '种子计划参数必须是对象');
    if (!isNonEmptyStr(input.sessionId)) return fail('bad-session', 'sessionId 不能为空');
    const stepsRes = normalizeSteps(input.steps);
    if (!stepsRes.ok) return stepsRes;
    const updatedAt = metaNow(meta);
    const candidate = {
      sessionId: clampChars(input.sessionId.trim(), 128),
      version: { gen: 0, rev: 0 },
      status: statusFor(stepsRes.steps),
      intent: isStr(input.intent) ? clampIntent(input.intent) : '',
      steps: stepsRes.steps,
      updatedAt,
      reason: isNonEmptyStr(input.reason) ? clampReason(input.reason) : 'seed',
      watermark: validWatermark(input.watermark ?? meta.watermark) ?? { turn: 0, seq: 0 },
      editedByUser: false,
    };
    const norm = normalizePlan(candidate, { requireReason: true, now: () => updatedAt });
    if (!norm.ok) return fail('bad-next-plan', `种子计划非法：${norm.error}`);
    return { ok: true, plan: norm.plan };
  } catch (err) {
    return fail('internal', `种子计划异常：${errMsg(err)}`);
  }
}
