/**
 * host/job.js — 计划作业队列、全局并发闸与 runJob 编排（零依赖，纯注入）。
 *
 * 设计依据：v1.2 §3.5.1（流水线）、§3.5.2（幂等/合并/并发）、§3.5.3（取消与失效）、
 *            §3.5.4（双截止线）、§3.5.7（rewrite 防抖）。
 *
 * 端口（全部由 index.js 注入，本模块不 import 任何 DSH 包）：
 *   callModel({system, messages, maxTokens, temperature, signal}) → Promise<string>
 *   commit(plan, {cas}) → boolean
 *   publish({plan, suggestion, turn}) → void
 *   now() → number
 *   signal?: AbortSignal
 *
 * 双截止线（确定性、可测；测试用假 now，不需要真 sleep）：
 *   - suggestionDeadlineMs（默认 2500ms）：超过则本回合不发布建议，计划照常落盘；
 *   - commitDeadlineMs（默认 6000ms；强制重写 8000ms）：超过则放弃本回合计划，保留 last-good。
 */

import { DEFAULTS, numberOption } from './config.js';
import {
  createSeedPlan,
  isNextVersion,
  mayRewrite,
  patchPlan,
  rewritePlan,
} from './plan.js';
import { buildPatchPrompt, buildRepairPrompt, buildRewritePrompt, parseModelOutput } from './prompt.js';
import { fallbackPlan, heuristicSuggestion } from './heuristics.js';
import { clampChars, clampSuggestion, oneLine, sanitizeSuggestion } from './text.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFn = (v) => typeof v === 'function';

function errMsg(err) {
  if (err && typeof err.message === 'string') return err.message;
  return String(err);
}

function jobResult(patch) {
  return {
    ok: true,
    committed: false,
    published: false,
    reason: 'error',
    plan: null,
    suggestion: '',
    op: null,
    fallback: false,
    attempts: 0,
    durationMs: 0,
    error: '',
    userMessage: undefined,
    ...patch,
  };
}

/**
 * 幂等键：`sessionId:turn`；强制重写追加 `:replan`，避免和同回合 turn/end 作业撞车。
 * @param {object} job
 * @returns {string}
 */
export function jobKey(job) {
  const sessionId = isObj(job) && typeof job.sessionId === 'string' && job.sessionId ? job.sessionId : 'unknown';
  const turn = isObj(job) && Number.isInteger(job.turn) ? job.turn : 0;
  const force = isObj(job) && (job.kind === 'force-rewrite' || job.forceRewrite === true);
  return `${sessionId}:${turn}${force ? ':replan' : ''}`;
}

/**
 * 合并两个待执行作业：新的覆盖旧的，强制重写优先，watermark 取最新，记录合并次数。
 * @param {object} prev
 * @param {object} next
 * @returns {object}
 */
export function mergeJobs(prev, next) {
  if (!isObj(prev)) return next;
  if (!isObj(next)) return prev;
  const prevForce = prev.kind === 'force-rewrite' || prev.forceRewrite === true;
  const nextForce = next.kind === 'force-rewrite' || next.forceRewrite === true;
  const merged = { ...prev, ...next };
  merged.kind = prevForce || nextForce ? 'force-rewrite' : next.kind ?? prev.kind ?? 'turn';
  merged.forceRewrite = prevForce || nextForce || merged.kind === 'force-rewrite';
  merged.watermark = mergeWatermark(prev.watermark, next.watermark);
  merged.evidence = next.evidence ?? prev.evidence;
  merged.plan = next.plan ?? prev.plan;
  merged.turn = Math.max(Number.isInteger(prev.turn) ? prev.turn : 0, Number.isInteger(next.turn) ? next.turn : 0);
  merged.instruction = next.instruction ?? prev.instruction;
  const prevCount = Number.isInteger(prev.mergedFrom) ? prev.mergedFrom : 1;
  const nextCount = Number.isInteger(next.mergedFrom) ? next.mergedFrom : 1;
  merged.mergedFrom = prevCount + nextCount;
  return merged;
}

function mergeWatermark(a, b) {
  const wa = isObj(a) ? a : null;
  const wb = isObj(b) ? b : null;
  if (!wa) return wb ?? undefined;
  if (!wb) return wa;
  const turnA = Number.isInteger(wa.turn) ? wa.turn : 0;
  const turnB = Number.isInteger(wb.turn) ? wb.turn : 0;
  if (turnB > turnA) return { ...wb };
  if (turnA > turnB) return { ...wa };
  return { turn: turnA, seq: Math.max(Number.isInteger(wa.seq) ? wa.seq : 0, Number.isInteger(wb.seq) ? wb.seq : 0) };
}

/**
 * 全局并发闸：跨会话 in-flight 上限（设计 §3.5.2：默认 ≤2）。
 * @param {number} [limit]
 * @returns {{limit:number, acquire:()=>Promise<()=>void>, run:Function, inFlight:()=>number, pendingCount:()=>number}}
 */
export function globalGate(limit = DEFAULTS.globalConcurrency) {
  const max = Math.max(1, Math.min(32, Math.floor(numberOption(limit, DEFAULTS.globalConcurrency, 1, 32))));
  let active = 0;
  const waiters = [];

  function releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (active > 0) active -= 1;
      dispatch();
    };
  }

  function dispatch() {
    while (active < max && waiters.length > 0) {
      const resolve = waiters.shift();
      active += 1;
      resolve(releaser());
    }
  }

  /** @returns {Promise<() => void>} 释放函数 */
  function acquire() {
    return new Promise((resolve) => {
      waiters.push(resolve);
      dispatch();
    });
  }

  async function run(fn) {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return { limit: max, acquire, run, inFlight: () => active, pendingCount: () => waiters.length };
}

/**
 * rewrite 防抖（设计 §3.5.7）：两次自动 rewrite 需间隔 ≥3 回合且 ≥5 分钟。
 * @param {{lastRewriteTurn?:number, lastRewriteAt?:number}|undefined} gate
 * @param {{turn?:number, now?:number}} [context]
 * @returns {boolean}
 */
export function rewriteAllowed(gate, context = {}) {
  if (!isObj(gate)) return true;
  const { turn, now } = context;
  if (Number.isInteger(gate.lastRewriteTurn) && Number.isInteger(turn)) {
    if (turn - gate.lastRewriteTurn < DEFAULTS.rewriteMinTurns) return false;
  }
  if (Number.isFinite(gate.lastRewriteAt) && Number.isFinite(now)) {
    if (now - gate.lastRewriteAt < DEFAULTS.rewriteMinIntervalMs) return false;
  }
  return true;
}

/**
 * 计算两份步骤列表的差异，用于把「过小的 rewrite diff」降级成 patch。
 *
 * @param {Array} prevSteps
 * @param {Array} nextSteps
 * @returns {{patchable:boolean, changes:Array, added:string[], removed:string[]}}
 */
export function diffToChanges(prevSteps, nextSteps) {
  const result = { patchable: false, changes: [], added: [], removed: [] };
  const prev = Array.isArray(prevSteps) ? prevSteps.filter(isObj) : [];
  const next = Array.isArray(nextSteps) ? nextSteps.filter(isObj) : [];
  const prevById = new Map(prev.map((step) => [step.id, step]));
  const nextById = new Map(next.map((step) => [step.id, step]));
  for (const step of next) if (!prevById.has(step.id)) result.added.push(step.id);
  for (const step of prev) if (!nextById.has(step.id)) result.removed.push(step.id);
  for (const nextStep of next) {
    const prevStep = prevById.get(nextStep.id);
    if (!prevStep) continue;
    const change = { id: nextStep.id };
    let fields = 0;
    if (nextStep.status !== prevStep.status) {
      change.status = nextStep.status;
      fields += 1;
    }
    if (typeof nextStep.title === 'string' && nextStep.title !== prevStep.title) {
      change.title = nextStep.title;
      fields += 1;
    }
    const prevEvidence = JSON.stringify(prevStep.evidence ?? []);
    const nextEvidence = JSON.stringify(nextStep.evidence ?? []);
    if (prevEvidence !== nextEvidence) {
      change.evidence = Array.isArray(nextStep.evidence) ? nextStep.evidence : [];
      fields += 1;
    }
    if (fields > 0) result.changes.push(change);
  }
  result.patchable = result.added.length === 0 && result.removed.length === 0;
  return result;
}

/**
 * 创建作业队列：同会话串行、期间新作业合并（superseded）、全局并发闸、幂等键去重。
 *
 * @param {{execute: (job:object, runtime:{isSuperseded:()=>boolean})=>Promise<object>, limit?:number, dedupeTtlMs?:number, now?:()=>number, gate?:object}} options
 * @returns {object}
 */
export function createQueue(options = {}) {
  const opts = isObj(options) ? options : {};
  const execute = opts.execute;
  const limit = numberOption(opts.limit, DEFAULTS.globalConcurrency, 1, 32);
  const dedupeTtlMs = numberOption(opts.dedupeTtlMs, DEFAULTS.dedupeTtlMs, 0, 24 * 60 * 60 * 1000);
  const queueNow = isFn(opts.now) ? opts.now : () => Date.now();
  const gate = isObj(opts.gate) && isFn(opts.gate.acquire) ? opts.gate : globalGate(limit);

  const sessions = new Map();
  const seen = new Map();
  let closed = false;
  let started = 0;
  let completed = 0;

  function skip(reason, extra = {}) {
    return { ok: false, skipped: true, reason, ...extra };
  }

  function pruneSeen() {
    if (seen.size < 500) return;
    const before = queueNow() - Math.max(dedupeTtlMs, 60 * 1000);
    for (const [key, entry] of seen) {
      if (entry.state === 'active') continue;
      if (!Number.isFinite(entry.at) || entry.at < before) seen.delete(key);
    }
  }

  function settle(record, value) {
    const waiters = record.waiters ?? [];
    record.waiters = [];
    for (const waiter of waiters) {
      try {
        waiter.resolve(value);
      } catch {
        /* ignore */
      }
    }
  }

  async function runSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    while (session.current) {
      const record = session.current;
      started += 1;
      let value;
      const release = await gate.acquire();
      try {
        const runtime = {
          sessionId,
          isSuperseded: () => session.pending != null || closed,
        };
        value = await execute(record.job, runtime);
      } catch (err) {
        value = jobResult({ ok: false, reason: 'execute-error', error: errMsg(err) });
      } finally {
        release();
      }
      completed += 1;
      const entry = seen.get(record.key);
      if (entry && entry.state === 'active') seen.set(record.key, { state: 'done', at: queueNow() });
      settle(record, value);
      const nextRecord = session.pending;
      session.pending = null;
      session.current = nextRecord;
      if (!nextRecord) break;
    }
    if (sessions.get(sessionId) === session && !session.current) sessions.delete(sessionId);
  }

  /**
   * 入队一个作业。
   * @param {object} job
   * @returns {Promise<object>} 作业结果；重复/关闭时返回 `{skipped:true, reason}`
   */
  function enqueue(job) {
    try {
      if (!isObj(job)) return Promise.resolve(skip('bad-job'));
      const sessionId = typeof job.sessionId === 'string' ? job.sessionId.trim() : '';
      if (!sessionId) return Promise.resolve(skip('bad-session'));
      if (closed) return Promise.resolve(skip('closed'));
      if (!isFn(execute)) return Promise.resolve(skip('no-execute'));
      const key = jobKey(job);
      const existing = seen.get(key);
      if (existing && existing.state === 'active' && existing.promise) return existing.promise;
      if (
        existing &&
        existing.state === 'done' &&
        dedupeTtlMs > 0 &&
        Number.isFinite(existing.at) &&
        queueNow() - existing.at < dedupeTtlMs
      ) {
        return Promise.resolve(skip('duplicate', { key }));
      }
      pruneSeen();

      let resolveFn;
      let rejectFn;
      const promise = new Promise((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      const record = { job, key, waiters: [{ resolve: resolveFn, reject: rejectFn }] };
      seen.set(key, { state: 'active', promise, at: queueNow() });

      let session = sessions.get(sessionId);
      if (!session) {
        session = { id: sessionId, current: null, pending: null };
        sessions.set(sessionId, session);
      }
      if (session.current) {
        if (session.pending) {
          session.pending.job = mergeJobs(session.pending.job, job);
          session.pending.waiters.push({ resolve: resolveFn, reject: rejectFn });
        } else {
          session.pending = record;
        }
        return promise;
      }
      session.current = record;
      Promise.resolve()
        .then(() => runSession(sessionId))
        .catch(() => {});
      return promise;
    } catch (err) {
      return Promise.resolve(skip('enqueue-error', { error: errMsg(err) }));
    }
  }

  /** 关闭队列：不再接受新作业，未开始的合并作业静默取消。 */
  function close() {
    closed = true;
    for (const session of sessions.values()) {
      if (!session.pending) continue;
      settle(session.pending, { ok: false, skipped: true, reason: 'closed' });
      const entry = seen.get(session.pending.key);
      if (entry && entry.state === 'active') seen.set(session.pending.key, { state: 'done', at: queueNow() });
      session.pending = null;
    }
  }

  /** 等待所有会话空闲。 */
  function idle() {
    return new Promise((resolve) => {
      const check = () => {
        if (sessions.size === 0) {
          resolve();
          return;
        }
        const timer = setTimeout(check, 10);
        if (timer && typeof timer.unref === 'function') timer.unref();
      };
      check();
    });
  }

  return {
    enqueue,
    close,
    idle,
    gate,
    size: () => sessions.size,
    stats: () => ({
      sessions: sessions.size,
      seen: seen.size,
      started,
      completed,
      inFlight: isFn(gate.inFlight) ? gate.inFlight() : 0,
      gatePending: isFn(gate.pendingCount) ? gate.pendingCount() : 0,
    }),
  };
}

/* ────────────────────────────────────────────────────────────────
 * runJob 编排
 * ──────────────────────────────────────────────────────────────── */

function extractModelText(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      const text = extractModelText(item);
      if (text) parts.push(text);
    }
    return parts.join('');
  }
  if (!isObj(value)) return '';
  for (const key of ['text', 'content', 'message', 'output', 'raw', 'value', 'delta']) {
    const nested = value[key];
    if (typeof nested === 'string' && nested) return nested;
    if (Array.isArray(nested)) {
      const text = extractModelText(nested);
      if (text) return text;
    } else if (isObj(nested)) {
      const text = extractModelText(nested);
      if (text) return text;
    }
  }
  return '';
}

function callModelOnce(prompt, ctx) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer != null && isFn(ctx.clearTimeoutFn)) {
        try {
          ctx.clearTimeoutFn(timer);
        } catch {
          /* ignore */
        }
      }
      resolve(value);
    };
    const remaining = ctx.deadlineMs;
    if (isFn(ctx.setTimeoutFn) && Number.isFinite(remaining) && remaining > 0) {
      timer = ctx.setTimeoutFn(() => {
        try {
          if (ctx.signal && isFn(ctx.signal.abort)) ctx.signal.abort();
        } catch {
          /* ignore */
        }
        finish({ timedOut: true });
      }, remaining);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    let call;
    const arg = {
      system: prompt.system,
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
      temperature: prompt.temperature,
    };
    if (ctx.signal) arg.signal = ctx.signal;
    try {
      call = ctx.callModel(arg, { deadlineAt: ctx.deadlineAt, deadlineMs: remaining });
    } catch (err) {
      finish({ error: errMsg(err) });
      return;
    }
    Promise.resolve(call).then(
      (value) => finish({ value }),
      (err) => finish({ error: errMsg(err) }),
    );
  });
}

function heuristicTextFor(evidence, plan) {
  const res = heuristicSuggestion({ ...(isObj(evidence) ? evidence : {}), plan: plan ?? evidence?.plan ?? null });
  return res && res.ok ? res.text : '';
}

function buildSeed({ job, evidence, watermark, nowMs }) {
  const intent = oneLine(evidence?.intent ?? evidence?.firstUserMessage ?? job?.intent ?? '');
  const fallback = fallbackPlan(intent);
  if (!fallback.ok) return { ok: false, error: fallback.error };
  const seed = createSeedPlan(
    {
      sessionId: job.sessionId,
      intent,
      steps: fallback.steps,
      watermark,
      reason: 'seed-fallback',
    },
    { now: nowMs },
  );
  if (!seed.ok) return { ok: false, error: seed.error };
  return { ok: true, plan: seed.plan };
}

function applyOutput({ out, plan, job, force, evidence, watermark, nowMs }) {
  const sessionId = job.sessionId ?? evidence?.sessionId ?? plan?.sessionId ?? '';
  const seed = (baseReason) => {
    const built = buildSeed({ job: { ...job, sessionId }, evidence, watermark, nowMs });
    if (!built.ok) return { ok: false, baseReason: 'seed-invalid', error: built.error };
    return { ok: true, plan: built.plan, changed: true, baseReason };
  };

  switch (out.op) {
    case 'none':
      return plan ? { ok: true, plan: null, changed: false, baseReason: 'no-op' } : seed('seed');
    case 'patch': {
      if (!plan) return seed('patch-without-plan');
      const res = patchPlan(plan, out.changes, { reason: out.reason, watermark, now: nowMs });
      if (!res.ok) return { ok: false, baseReason: 'plan-invalid', error: res.error };
      return { ok: true, plan: res.plan, changed: res.changed !== false, baseReason: res.changed === false ? 'no-op' : 'ok' };
    }
    case 'rewrite': {
      if (!plan) {
        const created = createSeedPlan(
          {
            sessionId,
            intent: out.intent || evidence?.intent || '',
            steps: out.steps,
            watermark,
            reason: out.reason,
          },
          { now: nowMs },
        );
        if (!created.ok) return { ok: false, baseReason: 'plan-invalid', error: created.error };
        return { ok: true, plan: created.plan, changed: true, baseReason: 'ok', seeded: true };
      }
      const turn = job.turn ?? watermark.turn;
      const locked = !mayRewrite(plan, { force });
      const gateOk = force || rewriteAllowed(job.rewriteGate, { turn, now: nowMs });
      if (locked || !gateOk) {
        // 用户版只允许 patch；防抖期也把「小 diff」降级成 patch（设计 §3.5.7）。
        const diff = diffToChanges(plan.steps, out.steps);
        if (diff.patchable && diff.changes.length > 0) {
          const res = patchPlan(plan, diff.changes, { reason: out.reason, watermark, now: nowMs });
          if (!res.ok) return { ok: false, baseReason: 'plan-invalid', error: res.error };
          return { ok: true, plan: res.plan, changed: res.changed !== false, baseReason: res.changed === false ? 'no-op' : 'ok', downgraded: 'patch' };
        }
        return {
          ok: false,
          baseReason: locked ? 'rewrite-locked' : 'rewrite-debounced',
          error: locked ? '用户已编辑计划，模型不能自动 rewrite 覆盖' : '两次 rewrite 间隔不足，本次不重写',
        };
      }
      const res = rewritePlan(plan, out, { reason: out.reason, watermark, now: nowMs, force });
      if (!res.ok) {
        return { ok: false, baseReason: res.code === 'locked-by-user' ? 'rewrite-locked' : 'plan-invalid', error: res.error };
      }
      return { ok: true, plan: res.plan, changed: res.changed !== false, baseReason: res.changed === false ? 'no-op' : 'ok' };
    }
    default:
      return { ok: false, baseReason: 'bad-op', error: `未知 op：${String(out.op)}` };
  }
}

async function commitPlan(ports, plan, cas, meta = {}) {
  if (!isFn(ports.commit)) return { ok: false, missing: true, error: '缺少 commit 端口' };
  try {
    const value = await ports.commit(plan, { ...meta, cas });
    return { ok: value === true, error: '' };
  } catch (err) {
    return { ok: false, threw: true, error: errMsg(err) };
  }
}

/**
 * Legacy runner for unversioned plans only. Production uses index.js.
 * This runner does not own the raw-journal/progress-protocol trust boundary and
 * must not be substituted for the production pipeline during modularization.
 *
 * @param {{job:object, ports:object, suggestionDeadlineMs?:number, commitDeadlineMs?:number}} params
 * @returns {Promise<{ok:boolean, committed:boolean, published:boolean, reason:string, plan:object|null, suggestion:string, op:string|null, version:object|null, fallback:boolean, attempts:number, durationMs:number, error:string, userMessage?:string}>}
 */
export async function runJob(params = {}) {
  const input = isObj(params) ? params : {};
  const job = isObj(input.job) ? input.job : null;
  const ports = isObj(input.ports) ? input.ports : {};

  if (!job) return jobResult({ ok: false, reason: 'bad-job', error: 'job 必须是对象' });
  if (!isFn(ports.callModel)) return jobResult({ ok: false, reason: 'bad-ports', error: '缺少 callModel 端口' });

  const now = isFn(ports.now) ? ports.now : () => Date.now();
  const t0 = now();
  const force = job.kind === 'force-rewrite' || job.forceRewrite === true;
  const commitDeadlineMs = numberOption(
    input.commitDeadlineMs ?? job.commitDeadlineMs ?? job.planDeadlineMs,
    force ? DEFAULTS.forceRewriteDeadlineMs : DEFAULTS.planDeadlineMs,
    1,
    120000,
  );
  const suggestionDeadlineMs = numberOption(
    input.suggestionDeadlineMs ?? job.suggestionDeadlineMs,
    DEFAULTS.suggestionDeadlineMs,
    0,
    120000,
  );
  const setTimeoutFn = isFn(ports.setTimeout) ? ports.setTimeout : typeof setTimeout === 'function' ? setTimeout : null;
  const clearTimeoutFn = isFn(ports.clearTimeout) ? ports.clearTimeout : typeof clearTimeout === 'function' ? clearTimeout : null;
  const externalSignal = input.signal ?? ports.signal ?? job.signal ?? null;

  let controller = null;
  if (typeof AbortController === 'function') {
    controller = new AbortController();
    if (externalSignal && typeof externalSignal === 'object') {
      if (externalSignal.aborted) controller.abort();
      else if (isFn(externalSignal.addEventListener)) {
        try {
          externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
        } catch {
          /* ignore */
        }
      }
    }
  }
  const signal = controller ? controller.signal : externalSignal;
  const aborted = () => Boolean(signal && signal.aborted);
  const isSuperseded = isFn(job.isSuperseded) ? job.isSuperseded : () => false;
  const finish = (patch) => {
    const result = jobResult({ ...patch, durationMs: Math.max(0, now() - t0) });
    return result;
  };

  try {
    if (aborted()) return finish({ ok: true, reason: 'aborted', userMessage: force ? '重写已取消' : undefined });
    if (isSuperseded()) return finish({ ok: true, reason: 'superseded' });

    const evidence = isObj(job.evidence) ? job.evidence : {};
    let plan = isObj(job.plan) ? job.plan : isObj(evidence.plan) ? evidence.plan : null;
    if (Array.isArray(plan?.steps) && plan.steps.some(step => step?.acceptance !== undefined)) {
      return finish({ ok: false, reason: 'unsupported-versioned-plan', error: 'Legacy runJob cannot validate versioned acceptance; use the production progress pipeline' });
    }
    const watermark = isObj(job.watermark)
      ? job.watermark
      : isObj(evidence.watermark)
        ? evidence.watermark
        : { turn: Number.isInteger(job.turn) ? job.turn : Number.isInteger(evidence.turn) ? evidence.turn : 0, seq: Number.isInteger(evidence.seq) ? evidence.seq : 0 };
    const turn = Number.isInteger(job.turn) ? job.turn : Number.isInteger(evidence.turn) ? evidence.turn : watermark.turn;
    const sessionId = job.sessionId ?? evidence.sessionId ?? plan?.sessionId ?? '';

    // ── 1. 构造提示（已有计划 → patch；冷启动/强制 → rewrite）──────────
    const useRewrite = force || !plan;
    let prompt;
    try {
      prompt = useRewrite ? buildRewritePrompt(evidence, { force }) : buildPatchPrompt(evidence);
    } catch (err) {
      return finish({ ok: false, reason: 'prompt-error', error: errMsg(err) });
    }

    // ── 2. 调模型（双截止线 + JSON 非法修复重发 1 次）────────────────
    const callDeadlineAt = t0 + commitDeadlineMs;
    const maxAttempts = 1 + DEFAULTS.repairRetryMax;
    let attempts = 0;
    let lastText = '';
    let callError = '';
    let timedOut = false;
    let parsed = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      if (aborted()) return finish({ ok: true, reason: 'aborted', attempts: attempts, userMessage: force ? '重写已取消' : undefined });
      const remaining = callDeadlineAt - now();
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      const call = await callModelOnce(prompt, {
        callModel: ports.callModel,
        signal,
        deadlineAt: callDeadlineAt,
        deadlineMs: remaining,
        setTimeoutFn,
        clearTimeoutFn,
      });
      if (call.timedOut) {
        timedOut = true;
        break;
      }
      if (call.error) callError = call.error;
      lastText = extractModelText(call.value);
      parsed = parseModelOutput(lastText);
      if (parsed.ok) break;
      if (attempt >= maxAttempts) break;
      prompt = buildRepairPrompt(prompt, lastText, parsed.error || callError || 'invalid');
    }

    // ── 3. 计划落盘截止线 ───────────────────────────────────────────
    if (timedOut || now() - t0 > commitDeadlineMs) {
      return finish({ ok: true, reason: 'plan-deadline', attempts, userMessage: force ? '重写失败，已保留原计划' : undefined });
    }
    if (aborted()) return finish({ ok: true, reason: 'aborted', attempts, userMessage: force ? '重写已取消' : undefined });
    if (isSuperseded()) return finish({ ok: true, reason: 'superseded', attempts });

    // ── 4. 模型输出非法 → 保留 last-good（无计划则种子骨架）+ 启发式建议 ──
    if (!parsed || !parsed.ok) {
      const result = finish({
        ok: true,
        reason: callError ? 'model-error' : 'model-invalid',
        fallback: true,
        attempts,
        error: parsed?.error || callError || '',
      });
      if (!plan) {
        const built = buildSeed({ job: { ...job, sessionId }, evidence, watermark, nowMs: now() });
        if (built.ok) {
          const committed = await commitPlan(ports, built.plan, null, { previous: null, now: now() });
          if (committed.ok) {
            result.committed = true;
            result.plan = built.plan;
            result.version = built.plan.version;
            plan = built.plan;
          } else {
            result.reason = committed.threw ? 'commit-error' : 'cas-conflict';
            result.error = committed.error;
          }
        }
      }
      const suggestion = heuristicTextFor(evidence, plan);
      const published = await maybePublish({
        ports,
        job,
        evidence,
        plan,
        out: null,
        suggestion,
        turn,
        sessionId,
        watermark,
        elapsedMs: now() - t0,
        suggestionDeadlineMs,
        isSuperseded,
        aborted,
        result,
      });
      result.published = published;
      if (!result.suggestion && published) result.suggestion = suggestion;
      return result;
    }

    // ── 5. 应用 op → 版本 bump → CAS 落盘 ───────────────────────────
    const out = parsed.output;
    const result = finish({ ok: true, op: out.op, attempts });
    let committed = false;
    let nextPlan = null;
    let baseReason = 'ok';

    try {
      const applied = applyOutput({ out, plan, job: { ...job, sessionId }, force, evidence, watermark, nowMs: now() });
      if (!applied.ok) {
        baseReason = applied.baseReason || 'plan-invalid';
        result.error = applied.error || '';
      } else {
        if (applied.downgraded) result.downgraded = applied.downgraded;
        if (applied.seeded) result.seeded = true;
        if (applied.plan) {
          if (plan && !isNextVersion(plan.version, applied.plan.version)) {
            baseReason = 'version-monotonic';
            result.error = '新版本不是当前版本的严格下一版';
          } else if (applied.changed === false) {
            baseReason = 'no-op';
          } else {
            const commitRes = await commitPlan(ports, applied.plan, plan ? plan.version : null, { previous: plan, now: now() });
            if (commitRes.ok) {
              committed = true;
              nextPlan = applied.plan;
              result.committed = true;
              result.plan = applied.plan;
              result.version = applied.plan.version;
            } else {
              baseReason = commitRes.threw ? 'commit-error' : 'cas-conflict';
              result.error = commitRes.error || '';
            }
          }
        } else {
          baseReason = applied.baseReason || 'no-op';
        }
      }
    } catch (err) {
      baseReason = 'apply-error';
      result.error = errMsg(err);
    }

    // ── 6. 建议：模型给了就用模型；没给则启发式兜底 ─────────────────
    let suggestion = typeof out.suggestion === 'string' ? out.suggestion : '';
    let suggestionSource = suggestion ? 'model' : '';
    if (!suggestion) {
      suggestion = heuristicTextFor(evidence, nextPlan ?? plan);
      suggestionSource = suggestion ? 'heuristic' : '';
      if (suggestion) result.fallback = true;
    }
    const published = await maybePublish({
      ports,
      job,
      evidence,
      plan: nextPlan ?? plan,
      out,
      suggestion,
      turn,
      sessionId,
      watermark,
      elapsedMs: now() - t0,
      suggestionDeadlineMs,
      isSuperseded,
      aborted,
      result,
    });
    result.published = published;
    if (published) {
      result.suggestion = suggestion;
      result.suggestionSource = suggestionSource;
    }

    // ── 7. 汇总 reason ─────────────────────────────────────────────
    if (!committed) {
      result.reason = baseReason;
    } else if (published) {
      result.reason = 'ok';
    } else {
      result.reason = result.publishSkip || 'committed-no-suggestion';
    }
    return result;
  } catch (err) {
    return finish({ ok: false, reason: 'internal', error: errMsg(err) });
  }
}

async function maybePublish(params) {
  const {
    ports,
    job,
    out,
    suggestion,
    turn,
    sessionId,
    watermark,
    elapsedMs,
    suggestionDeadlineMs,
    isSuperseded,
    aborted,
    result,
    plan,
  } = params;
  const sanitized = sanitizeSuggestion(suggestion);
  if (!sanitized.ok) {
    result.publishSkip = sanitized.filtered ? 'suggestion-filtered' : 'suggestion-invalid';
    return false;
  }
  result.publishSkip = '';
  if (aborted()) {
    result.publishSkip = 'aborted';
    return false;
  }
  if (elapsedMs > suggestionDeadlineMs) {
    result.publishSkip = 'suggestion-deadline';
    return false;
  }
  if (isSuperseded()) {
    result.publishSkip = 'superseded';
    return false;
  }
  const previousSuggestion = job.lastSuggestion ?? job.previousSuggestion;
  if (typeof previousSuggestion === 'string' && previousSuggestion && oneLine(previousSuggestion) === sanitized.text) {
    result.publishSkip = 'suggestion-duplicate';
    return false;
  }
  if (!isFn(ports.publish)) {
    result.publishSkip = 'no-publish-port';
    return false;
  }
  try {
    await ports.publish({
      plan: plan ?? null,
      suggestion: sanitized.text,
      turn,
      sessionId,
      version: plan?.version ?? null,
      watermark,
      alternates: Array.isArray(out?.alternates) ? out.alternates : [],
      op: out?.op ?? 'none',
      fallback: result.fallback === true,
      kind: job.kind ?? 'turn',
      at: Date.now(),
    });
    return true;
  } catch (err) {
    result.publishSkip = 'publish-error';
    result.error = errMsg(err);
    return false;
  }
}

/**
 * Legacy convenience runner. Production index.js must not switch to this
 * without extracting and preserving its current receipt/protocol validation.
 *
 * @param {{ports:object, limit?:number, dedupeTtlMs?:number, now?:()=>number, gate?:object, suggestionDeadlineMs?:number, commitDeadlineMs?:number}} options
 * @returns {{queue:object, submit:(job:object)=>Promise<object>}}
 */
export function createRunner(options = {}) {
  const opts = isObj(options) ? options : {};
  const ports = isObj(opts.ports) ? opts.ports : {};
  const queue = createQueue({
    limit: opts.limit,
    dedupeTtlMs: opts.dedupeTtlMs,
    now: opts.now,
    gate: opts.gate,
    execute: (job, runtime) =>
      runJob({
        job: { ...job, isSuperseded: () => runtime.isSuperseded() },
        ports,
        suggestionDeadlineMs: opts.suggestionDeadlineMs,
        commitDeadlineMs: opts.commitDeadlineMs,
      }),
  });
  return { queue, submit: (job) => queue.enqueue(job) };
}
