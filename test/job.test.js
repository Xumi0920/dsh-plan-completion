import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runJob,
  createQueue,
  createRunner,
  globalGate,
  mergeJobs,
  jobKey,
  rewriteAllowed,
  diffToChanges,
} from '../host/job.js';
import { DEFAULTS } from '../host/config.js';

/* ─────────────────────────── helpers ─────────────────────────── */

function createClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function makePlan(overrides = {}) {
  return {
    sessionId: 's1',
    version: { gen: 1, rev: 0 },
    status: 'active',
    intent: '给 Vue 项目加登录页',
    steps: [
      { id: 's1', title: '摸清路由与鉴权', status: 'done', source: 'model' },
      { id: 's2', title: '新增 Login.vue 与路由', status: 'doing', source: 'model' },
      { id: 's3', title: '接入 token 拦截器', status: 'todo', source: 'model' },
    ],
    updatedAt: 1762000000000,
    reason: '第2步进行中',
    watermark: { turn: 1, seq: 10 },
    editedByUser: false,
    ...overrides,
  };
}

function makeEvidence(overrides = {}) {
  const plan = overrides.plan === undefined ? makePlan() : overrides.plan;
  return {
    ok: true,
    sessionId: 's1',
    turn: 2,
    seq: 20,
    watermark: { turn: 2, seq: 20 },
    intent: '给 Vue 项目加登录页',
    plan,
    lastAssistantText: '已创建 Login.vue，并挂上 /login 路由。',
    toolCalls: [{ name: 'write', ok: true }],
    failedTools: [],
    lastUserMessages: ['把它接到现有鉴权上'],
    firstUserMessage: '给 Vue 项目加登录页',
    recentMessages: [],
    todoSteps: [],
    hasQuestion: false,
    turnEnded: true,
    counts: { events: 5, toolCalls: 1, failedTools: 0, messages: 2, userMessages: 1 },
    ...overrides,
  };
}

function patchJson(overrides = {}) {
  return JSON.stringify({
    op: 'patch',
    reason: '第2步完成（已创建 Login.vue）',
    changes: [{ id: 's2', status: 'done' }],
    suggestion: '接着接入 token 拦截器',
    ...overrides,
  });
}

function rewriteJson(overrides = {}) {
  return JSON.stringify({
    op: 'rewrite',
    reason: '阶段边界：页面完成',
    intent: '给 Vue 项目加登录页',
    steps: [
      { id: 's1', title: '摸清路由与鉴权', status: 'done' },
      { id: 's2', title: '新增 Login.vue 与路由', status: 'done' },
      { id: 's3', title: '接入 token 拦截器', status: 'todo' },
    ],
    suggestion: '接着接入 token 拦截器',
    ...overrides,
  });
}

function recorder() {
  const calls = { commits: [], publishes: [], models: [] };
  return {
    calls,
    ports: {
      commit: async (plan, meta) => {
        calls.commits.push({ plan, meta });
        return true;
      },
      publish: async (payload) => {
        calls.publishes.push(payload);
      },
    },
  };
}

function baseJob(overrides = {}) {
  return {
    sessionId: 's1',
    turn: 2,
    kind: 'turn',
    watermark: { turn: 2, seq: 20 },
    plan: makePlan(),
    evidence: makeEvidence(),
    ...overrides,
  };
}

/* ─────────────────────── 双截止线 / 提交 ─────────────────────── */

test('legacy runJob refuses versioned plans instead of bypassing receipt validation',async()=>{
 const plan=makePlan();plan.steps[1].acceptance={scope:'manual',revision:1,afterSeq:10,dependsOn:[]};
 for(const source of ['plan','evidence']){
  const rec=recorder();let calls=0;
  const result=await runJob({job:baseJob({plan:source==='plan'?plan:null,evidence:makeEvidence({plan})}),ports:{...rec.ports,callModel:async()=>{calls++;return patchJson();}}});
  assert.equal(result.reason,'unsupported-versioned-plan');assert.equal(result.committed,false);assert.equal(calls,0);
  assert.equal(rec.calls.commits.length,0);assert.equal(rec.calls.publishes.length,0);
 }
});

test('双截止线：建议超时（3000ms > 2500ms）但计划仍提交', async () => {
  const clock = createClock();
  const rec = recorder();
  const res = await runJob({
    job: baseJob(),
    ports: {
      now: clock.now,
      callModel: async () => {
        clock.advance(3000);
        return patchJson();
      },
      ...rec.ports,
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.committed, true);
  assert.equal(res.published, false);
  assert.equal(res.reason, 'suggestion-deadline');
  assert.equal(rec.calls.commits.length, 1);
  assert.equal(rec.calls.publishes.length, 0);
  assert.deepEqual(rec.calls.commits[0].plan.version, { gen: 1, rev: 1 });
  assert.equal(rec.calls.commits[0].meta.cas.gen, 1);
});

test('计划落盘截止线：7000ms > 6000ms → 放弃、保留 last-good', async () => {
  const clock = createClock();
  const rec = recorder();
  const res = await runJob({
    job: baseJob(),
    ports: {
      now: clock.now,
      callModel: async () => {
        clock.advance(7000);
        return patchJson();
      },
      ...rec.ports,
    },
  });
  assert.equal(res.committed, false);
  assert.equal(res.published, false);
  assert.equal(res.reason, 'plan-deadline');
  assert.equal(rec.calls.commits.length, 0);
  assert.equal(res.plan, null);
});

test('强制重写截止线 8000ms：7000ms 仍可提交（且建议因超 2.5s 不发布）', async () => {
  const clock = createClock();
  const rec = recorder();
  const res = await runJob({
    job: baseJob({ kind: 'force-rewrite', forceRewrite: true }),
    ports: {
      now: clock.now,
      callModel: async () => {
        clock.advance(7000);
        return rewriteJson();
      },
      ...rec.ports,
    },
  });
  assert.equal(res.committed, true);
  assert.equal(res.published, false);
  assert.equal(res.reason, 'suggestion-deadline');
  assert.equal(rec.calls.commits.length, 1);
});

test('CAS 冲突：commit 返回 false → 不落盘、保留 last-good、建议仍可发布', async () => {
  const rec = recorder();
  const res = await runJob({
    job: baseJob(),
    ports: {
      now: () => 1000,
      callModel: async () => patchJson(),
      commit: async () => false,
      publish: async (payload) => rec.calls.publishes.push(payload),
    },
  });
  assert.equal(res.committed, false);
  assert.equal(res.reason, 'cas-conflict');
  assert.equal(res.plan, null);
  assert.equal(res.published, true);
  assert.equal(rec.calls.publishes.length, 1);
});

test('commit 抛异常 → reason=commit-error，不抛出', async () => {
  const res = await runJob({
    job: baseJob(),
    ports: {
      now: () => 1000,
      callModel: async () => patchJson(),
      commit: async () => {
        throw new Error('disk full');
      },
      publish: async () => {},
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.committed, false);
  assert.equal(res.reason, 'commit-error');
  assert.equal(res.error, 'disk full');
});

test('模型输出非法：修复重发 1 次后仍失败 → 不提交、启发式建议兜底', async () => {
  let modelCalls = 0;
  const rec = recorder();
  const res = await runJob({
    job: baseJob(),
    ports: {
      now: () => 1000,
      callModel: async () => {
        modelCalls += 1;
        return modelCalls === 1 ? '抱歉，这不是 JSON' : '还是不是 JSON';
      },
      ...rec.ports,
    },
  });
  assert.equal(modelCalls, 2, 'JSON 非法应修复重发 1 次');
  assert.equal(res.attempts, 2);
  assert.equal(res.committed, false);
  assert.equal(res.reason, 'model-invalid');
  assert.equal(res.fallback, true);
  assert.equal(res.published, true);
  assert.ok(rec.calls.publishes[0].suggestion.includes('接着做'));
  assert.equal(rec.calls.commits.length, 0);
});

test('截断修复路径：首轮 JSON 截断 → buildRepairPrompt 重发后成功提交（长 reason + 多 changes）', async () => {
  const modelCalls = [];
  const rec = recorder();
  // 首轮：JSON 在字符串中间被 maxTokens 截断 → no-json
  const truncated = '{"op":"patch","reason":"第2步完成（已创建 Login.vue），但因为';
  const longReason = '本回合完成了登录页路由接入并验证了 token 读取路径，'.repeat(12);
  const fullPatch = JSON.stringify({
    op: 'patch',
    reason: longReason,
    changes: [
      { id: 's1', status: 'done' },
      { id: 's2', status: 'done' },
      { id: 's3', status: 'doing' },
    ],
    suggestion: '接着接入 token 拦截器',
  });

  const res = await runJob({
    job: baseJob(),
    ports: {
      now: () => 1000,
      callModel: async (arg) => {
        modelCalls.push(arg);
        return modelCalls.length === 1 ? truncated : fullPatch;
      },
      ...rec.ports,
    },
  });

  assert.equal(modelCalls.length, 2, 'JSON 截断应修复重发 1 次');
  assert.equal(res.attempts, 2);
  assert.equal(res.committed, true);
  assert.equal(res.published, true);
  assert.equal(res.reason, 'ok');
  assert.deepEqual(rec.calls.commits[0].plan.version, { gen: 1, rev: 1 });
  assert.ok(
    Array.from(rec.calls.commits[0].plan.reason).length <= DEFAULTS.maxReasonChars,
    '超长 reason 应被截断到上限而不是导致失败',
  );
  assert.equal(rec.calls.commits[0].plan.steps[1].status, 'done');
  assert.equal(rec.calls.commits[0].plan.steps[2].status, 'doing');
  assert.equal(
    modelCalls[1].messages.length,
    modelCalls[0].messages.length + 2,
    '修复轮应追加 assistant 失败输出 + 纠正指令',
  );
  assert.equal(modelCalls[0].maxTokens, DEFAULTS.maxTokensPatch);
});

test('模型调用抛异常 → reason=model-error，保留 last-good', async () => {
  const res = await runJob({
    job: baseJob(),
    ports: {
      now: () => 1000,
      callModel: async () => {
        throw new Error('network down');
      },
      commit: async () => true,
      publish: async () => {},
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.committed, false);
  assert.equal(res.reason, 'model-error');
  assert.equal(res.published, true);
});

test('op=none：不 bump 版本、不提交，但发布建议', async () => {
  const rec = recorder();
  const res = await runJob({
    job: baseJob(),
    ports: {
      now: () => 1000,
      callModel: async () => JSON.stringify({ op: 'none', reason: '本回合无实质变化', suggestion: '先跑起来看看效果' }),
      ...rec.ports,
    },
  });
  assert.equal(res.op, 'none');
  assert.equal(res.committed, false);
  assert.equal(res.reason, 'no-op');
  assert.equal(res.published, true);
  assert.equal(rec.calls.commits.length, 0);
});

test('冷启动（无计划）：rewrite 产出 0.0 首版，CAS=null', async () => {
  const rec = recorder();
  const res = await runJob({
    job: baseJob({ plan: null, evidence: makeEvidence({ plan: null }) }),
    ports: {
      now: () => 1000,
      callModel: async () => rewriteJson(),
      ...rec.ports,
    },
  });
  assert.equal(res.committed, true);
  assert.deepEqual(res.plan.version, { gen: 0, rev: 0 });
  assert.equal(rec.calls.commits[0].meta.cas, null);
});

test('冷启动 + 模型非法：种子骨架（fallbackPlan）落盘', async () => {
  const rec = recorder();
  const res = await runJob({
    job: baseJob({ plan: null, evidence: makeEvidence({ plan: null }) }),
    ports: {
      now: () => 1000,
      callModel: async () => 'not json',
      ...rec.ports,
    },
  });
  assert.equal(res.committed, true);
  assert.deepEqual(res.plan.version, { gen: 0, rev: 0 });
  assert.ok(res.plan.steps.length >= 3 && res.plan.steps.length <= 7);
  assert.equal(rec.calls.commits[0].meta.cas, null);
});

test('强制重写：用户编辑过的计划也允许覆盖（force 放行）', async () => {
  const editedPlan = makePlan({ editedByUser: true, version: { gen: 2, rev: 0 } });
  const rec = recorder();
  const res = await runJob({
    job: baseJob({ kind: 'force-rewrite', forceRewrite: true, plan: editedPlan, evidence: makeEvidence({ plan: editedPlan }) }),
    ports: {
      now: () => 1000,
      callModel: async () => rewriteJson(),
      ...rec.ports,
    },
  });
  assert.equal(res.committed, true);
  assert.deepEqual(res.plan.version, { gen: 3, rev: 0 });
  assert.equal(rec.calls.commits[0].meta.cas.gen, 2);
});

test('自动 rewrite 被用户版锁住且无法降级 patch → rewrite-locked', async () => {
  const editedPlan = makePlan({ editedByUser: true });
  const rec = recorder();
  const rewriteWithNewStep = JSON.stringify({
    op: 'rewrite',
    reason: '模型想整体重排',
    steps: [
      { id: 's1', title: '摸清路由与鉴权', status: 'done' },
      { id: 's2', title: '新增 Login.vue 与路由', status: 'doing' },
      { id: 's4', title: '补测试', status: 'todo' },
    ],
    suggestion: '接着接入 token 拦截器',
  });
  const res = await runJob({
    job: baseJob({ plan: editedPlan, evidence: makeEvidence({ plan: editedPlan }) }),
    ports: {
      now: () => 1000,
      callModel: async () => rewriteWithNewStep,
      ...rec.ports,
    },
  });
  assert.equal(res.committed, false);
  assert.equal(res.reason, 'rewrite-locked');
  assert.equal(rec.calls.commits.length, 0);
  assert.equal(res.published, true);
});

test('rewrite 防抖：间隔不足且 diff 小 → 降级为 patch 提交', async () => {
  const rec = recorder();
  const res = await runJob({
    job: baseJob({ rewriteGate: { lastRewriteTurn: 1 }, turn: 2 }),
    ports: {
      now: () => 1000,
      callModel: async () => rewriteJson(),
      ...rec.ports,
    },
  });
  assert.equal(res.committed, true);
  assert.equal(res.downgraded, 'patch');
  assert.deepEqual(res.plan.version, { gen: 1, rev: 1 });
  assert.equal(res.reason, 'ok');
});

test('建议去重：与上一条相同则不发布', async () => {
  const rec = recorder();
  const res = await runJob({
    job: baseJob({ lastSuggestion: '接着接入 token 拦截器' }),
    ports: {
      now: () => 1000,
      callModel: async () => patchJson(),
      ...rec.ports,
    },
  });
  assert.equal(res.committed, true);
  assert.equal(res.published, false);
  assert.equal(res.reason, 'suggestion-duplicate');
});

test('suggestionDeadlineMs / commitDeadlineMs 可由参数覆盖', async () => {
  const clock = createClock();
  const rec = recorder();
  const res = await runJob({
    job: baseJob(),
    ports: {
      now: clock.now,
      callModel: async () => {
        clock.advance(3000);
        return patchJson();
      },
      ...rec.ports,
    },
    suggestionDeadlineMs: 5000,
    commitDeadlineMs: 5000,
  });
  assert.equal(res.committed, true);
  assert.equal(res.published, true);
  assert.equal(res.reason, 'ok');
  assert.equal(rec.calls.publishes.length, 1);
});

test('signal 已 abort / 作业已被 superseded → 不调模型直接返回', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = 0;
  const aborted = await runJob({
    job: baseJob(),
    ports: {
      callModel: async () => {
        called += 1;
        return patchJson();
      },
      signal: controller.signal,
    },
  });
  assert.equal(aborted.reason, 'aborted');
  assert.equal(called, 0);

  const superseded = await runJob({
    job: baseJob({ isSuperseded: () => true }),
    ports: { callModel: async () => patchJson() },
  });
  assert.equal(superseded.reason, 'superseded');
  assert.equal(superseded.committed, false);
});

test('非法入参返回结构化失败，不抛异常', async () => {
  const noJob = await runJob({});
  assert.equal(noJob.ok, false);
  assert.equal(noJob.reason, 'bad-job');

  const noPorts = await runJob({ job: { sessionId: 's1' } });
  assert.equal(noPorts.ok, false);
  assert.equal(noPorts.reason, 'bad-ports');
});

/* ─────────────────────────── 队列 ─────────────────────────── */

test('jobKey：幂等键 sessionId:turn，强制重写追加 :replan', () => {
  assert.equal(jobKey({ sessionId: 's1', turn: 7 }), 's1:7');
  assert.equal(jobKey({ sessionId: 's1', turn: 7, kind: 'force-rewrite' }), 's1:7:replan');
  assert.equal(jobKey({ sessionId: 's1', turn: 7, forceRewrite: true }), 's1:7:replan');
});

test('mergeJobs：新作业覆盖、watermark 取最新、强制重写优先、记录合并次数', () => {
  const merged = mergeJobs(
    { sessionId: 's1', turn: 1, watermark: { turn: 1, seq: 10 } },
    { sessionId: 's1', turn: 3, watermark: { turn: 3, seq: 30 }, instruction: '重新规划' },
  );
  assert.equal(merged.turn, 3);
  assert.deepEqual(merged.watermark, { turn: 3, seq: 30 });
  assert.equal(merged.mergedFrom, 2);
  assert.equal(merged.instruction, '重新规划');

  const forced = mergeJobs({ sessionId: 's1', turn: 2 }, { sessionId: 's1', turn: 2, kind: 'force-rewrite' });
  assert.equal(forced.kind, 'force-rewrite');
  assert.equal(forced.forceRewrite, true);
});

test('createQueue：同会话串行 + superseded 合并（新事件只跑一次最新作业）', async () => {
  const executions = [];
  let active = 0;
  let maxActive = 0;
  let observedSuperseded = null;
  const queue = createQueue({
    limit: 2,
    execute: async (job, runtime) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (job.turn === 1) observedSuperseded = runtime.isSuperseded();
      executions.push(job.turn);
      active -= 1;
      return { ok: true, turn: job.turn };
    },
  });

  const p1 = queue.enqueue({ sessionId: 'a', turn: 1 });
  const p2 = queue.enqueue({ sessionId: 'a', turn: 2 });
  const p3 = queue.enqueue({ sessionId: 'a', turn: 3 });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assert.equal(maxActive, 1, '同会话必须串行');
  assert.deepEqual(executions, [1, 3], 'turn2 被 turn3 合并，只跑 turn1 与最新 turn3');
  assert.equal(r1.turn, 1);
  assert.equal(r2.turn, 3);
  assert.equal(r3.turn, 3);
  assert.equal(observedSuperseded, true);
  await queue.idle();
  assert.equal(queue.stats().sessions, 0);
});

test('createQueue：幂等键去重（进行中返回同一 Promise；完成后窗口内跳过）', async () => {
  let count = 0;
  const queue = createQueue({
    execute: async () => {
      count += 1;
      return { ok: true };
    },
    dedupeTtlMs: 60 * 1000,
  });
  const job = { sessionId: 's1', turn: 5 };
  const p1 = queue.enqueue(job);
  const p1b = queue.enqueue({ ...job });
  assert.equal(p1, p1b, '进行中的同 key 作业应返回同一 Promise');
  const r1 = await p1;
  assert.equal(r1.ok, true);
  assert.equal(count, 1);

  const r2 = await queue.enqueue({ ...job });
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'duplicate');
  assert.equal(count, 1);
});

test('createQueue：全局并发闸 in-flight ≤ 2', async () => {
  let active = 0;
  let maxActive = 0;
  const queue = createQueue({
    limit: 2,
    execute: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { ok: true };
    },
  });
  await Promise.all([
    queue.enqueue({ sessionId: 's1', turn: 1 }),
    queue.enqueue({ sessionId: 's2', turn: 1 }),
    queue.enqueue({ sessionId: 's3', turn: 1 }),
    queue.enqueue({ sessionId: 's4', turn: 1 }),
  ]);
  assert.equal(maxActive, 2);
  await queue.idle();
});

test('createQueue：close 时合并中的作业静默取消，运行中的继续完成', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const queue = createQueue({
    execute: async (job) => {
      if (job.turn === 1) await gate;
      return { ok: true, turn: job.turn };
    },
  });
  const p1 = queue.enqueue({ sessionId: 'a', turn: 1 });
  const p2 = queue.enqueue({ sessionId: 'a', turn: 2 });
  queue.close();
  const r2 = await p2;
  assert.equal(r2.skipped, true);
  assert.equal(r2.reason, 'closed');
  const r3 = await queue.enqueue({ sessionId: 'a', turn: 3 });
  assert.equal(r3.reason, 'closed');
  release();
  const r1 = await p1;
  assert.equal(r1.ok, true);
  assert.equal(r1.turn, 1);
  await queue.idle();
});

test('createQueue：execute 抛异常时 resolve 结构化结果，不 reject', async () => {
  const queue = createQueue({
    execute: async () => {
      throw new Error('boom');
    },
  });
  const res = await queue.enqueue({ sessionId: 'a', turn: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'execute-error');
  assert.equal(res.error, 'boom');
  await queue.idle();
});

test('globalGate：acquire/release 与 run 的并发上限', async () => {
  const gate = globalGate(2);
  assert.equal(gate.limit, 2);
  const releases = [await gate.acquire(), await gate.acquire()];
  assert.equal(gate.inFlight(), 2);
  let acquired = false;
  const pending = gate.acquire().then((release) => {
    acquired = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(acquired, false, '超过上限应排队');
  releases[0]();
  const third = await pending;
  assert.equal(gate.inFlight(), 2);
  releases[1]();
  third();
  assert.equal(gate.inFlight(), 0);
});

test('createRunner：把 queue 与 runJob 串起来（端到端）', async () => {
  const commits = [];
  const publishes = [];
  const plan = makePlan();
  const runner = createRunner({
    limit: 2,
    ports: {
      now: () => 1000,
      callModel: async () => patchJson(),
      commit: async (next, meta) => {
        commits.push({ next, meta });
        return true;
      },
      publish: async (payload) => publishes.push(payload),
    },
  });
  const res = await runner.submit({
    sessionId: 's1',
    turn: 2,
    watermark: { turn: 2, seq: 20 },
    plan,
    evidence: makeEvidence({ plan }),
  });
  assert.equal(res.committed, true);
  assert.equal(commits.length, 1);
  assert.equal(publishes.length, 1);
  await runner.queue.idle();
});
