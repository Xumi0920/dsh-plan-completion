import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectFromEvents } from '../host/evidence.js';
import { parseModelOutput, buildPatchPrompt, buildRewritePrompt } from '../host/prompt.js';
import { runJob } from '../host/job.js';
import { createMemoryStore } from '../host/store.js';
import { applyUserEdit, mayRewrite } from '../host/plan.js';

/* 模拟 SessionEvent（字段按 probe-verify 实测契约：type/seq/time/data） */
function ev(type, data, seq) {
  return { type, seq, time: 1000 + seq, data };
}
function userMsg(seq, text) {
  return ev('user/message', { role: 'user', content: [{ type: 'text', text }] }, seq);
}
function assistantMsg(seq, turn, text) {
  return ev('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }, seq);
}
function turn(events, turnNo, from, to) {
  return events.slice(from, to);
}

test('端到端：冷启动 rewrite → 存储 0.0 → 下一回合 patch → 0.1 → 发布建议', async () => {
  const store = createMemoryStore();
  const published = [];
  let modelCalls = 0;

  const eventsTurn1 = [
    ev('turn/start', { turn: 1 }, 10),
    userMsg(11, '给 Vue 项目加登录页，接入现有鉴权'),
    assistantMsg(12, 1, '先看了路由，还没动手。'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 13),
  ];
  const ports = {
    now: () => 5000,
    callModel: async (arg) => {
      // index.js 约定的端口入参
      assert.equal(typeof arg.system, 'string');
      assert.ok(Array.isArray(arg.messages));
      assert.equal(typeof arg.maxTokens, 'number');
      assert.equal(typeof arg.temperature, 'number');
      modelCalls += 1;
      if (modelCalls === 1) {
        return [
          '```json',
          JSON.stringify({
            op: 'rewrite',
            reason: '冷启动：建立首个计划',
            intent: '给 Vue 项目加登录页，接入现有鉴权',
            steps: [
              { id: 's1', title: '摸清现有路由与鉴权结构', status: 'done' },
              { id: 's2', title: '新增 Login.vue 与路由', status: 'todo' },
              { id: 's3', title: '接入 token 存储与请求拦截器', status: 'todo' },
            ],
            suggestion: '先摸清鉴权实现，再写 Login.vue',
            alternates: ['先看现有拦截器写法'],
          }),
          '```',
        ].join('\n');
      }
      return JSON.stringify({
        op: 'patch',
        reason: '第1步完成',
        changes: [{ id: 's2', status: 'doing' }],
        suggestion: '先把登录页跑起来看看效果',
      });
    },
    commit: async (plan, meta) => store.put(plan, meta),
    publish: async (payload) => published.push(payload),
  };

  // 回合 1：无计划 → cold start rewrite
  const evidence1 = collectFromEvents({ events: eventsTurn1, plan: null, turn: 1 });
  assert.equal(evidence1.turn, 1);
  const res1 = await runJob({
    job: { sessionId: 's1', turn: 1, watermark: evidence1.watermark, evidence: evidence1, plan: null },
    ports,
  });
  assert.equal(res1.committed, true);
  assert.equal(res1.published, true);
  assert.equal(published.length, 1);
  assert.equal(published[0].turn, 1);
  assert.ok(published[0].suggestion.length > 0);
  const stored1 = store.get('s1');
  assert.deepEqual(stored1.version, { gen: 0, rev: 0 });
  assert.equal(stored1.steps.length, 3);
  assert.equal(store.history('s1').length, 1);

  // 回合 2：已有计划 → patch
  const plan1 = store.get('s1');
  const eventsTurn2 = [
    ev('turn/start', { turn: 2 }, 20),
    userMsg(21, '接上 token 拦截器'),
    assistantMsg(22, 2, '已把 Login.vue 挂到路由上。'),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 23),
  ];
  const evidence2 = collectFromEvents({ events: [...eventsTurn1, ...eventsTurn2], plan: plan1, turn: 2 });
  assert.equal(evidence2.turn, 2);
  assert.equal(evidence2.lastUserMessages.length >= 1, true);
  assert.deepEqual(
    evidence2.todoSteps.map((step) => step.id),
    ['s2', 's3'],
  );

  const res2 = await runJob({
    job: {
      sessionId: 's1',
      turn: 2,
      watermark: evidence2.watermark,
      evidence: evidence2,
      plan: plan1,
      lastSuggestion: published[0].suggestion,
    },
    ports,
  });
  assert.equal(res2.committed, true);
  assert.equal(res2.published, true);
  assert.deepEqual(store.get('s1').version, { gen: 0, rev: 1 });
  assert.equal(store.get('s1').steps[1].status, 'doing');
  assert.equal(store.history('s1').length, 2);
  assert.equal(published.length, 2);
});

test('端到端：用户编辑后 → 模型自动 rewrite 被锁住（不覆盖用户版）', async () => {
  const store = createMemoryStore();
  const published = [];
  const ports = {
    now: () => 5000,
    callModel: async () => JSON.stringify({ op: 'rewrite', reason: '模型想整体重排', steps: [
      { id: 's1', title: '新1', status: 'done' },
      { id: 's2', title: '新2', status: 'doing' },
      { id: 's9', title: '新3', status: 'todo' },
    ], suggestion: '重新开始' }),
    commit: async (plan, meta) => store.put(plan, meta),
    publish: async (payload) => published.push(payload),
  };

  const first = {
    sessionId: 's1',
    version: { gen: 0, rev: 0 },
    status: 'active',
    intent: '给 Vue 加登录页',
    steps: [
      { id: 's1', title: '摸清路由', status: 'done', source: 'model' },
      { id: 's2', title: '写 Login.vue', status: 'todo', source: 'model' },
      { id: 's3', title: '接鉴权', status: 'todo', source: 'model' },
    ],
    updatedAt: 1,
    reason: 'seed',
    watermark: { turn: 1, seq: 10 },
    editedByUser: false,
  };
  assert.equal(store.put(first, { cas: null }), true);

  const edited = applyUserEdit(first, { steps: [
    { id: 's1', title: '摸清路由', status: 'done', source: 'model' },
    { id: 's2', title: '写 Login.vue（用户改）', status: 'doing', source: 'model' },
    { id: 's3', title: '接鉴权', status: 'todo', source: 'model' },
  ], intent: '给 Vue 加登录页' }, { reason: 'user edit' });
  assert.equal(edited.ok, true);
  assert.equal(store.put(edited.plan, { cas: { gen: 0, rev: 0 } }), true);
  assert.equal(mayRewrite(store.get('s1')), false);

  const events = [
    ev('turn/start', { turn: 2 }, 20),
    userMsg(21, '把登录页样式调一下'),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 22),
  ];
  const plan = store.get('s1');
  const evidence = collectFromEvents({ events, plan, turn: 2 });
  const res = await runJob({
    job: { sessionId: 's1', turn: 2, watermark: evidence.watermark, evidence, plan },
    ports,
  });
  assert.equal(res.committed, false);
  assert.equal(res.reason, 'rewrite-locked');
  assert.equal(store.get('s1').editedByUser, true);
  assert.equal(store.get('s1').steps[1].title, '写 Login.vue（用户改）', '用户版不被模型覆盖');
  assert.equal(published.length, 1, '建议仍可发布');
});

test('buildPatchPrompt / buildRewritePrompt 与 parseModelOutput 闭环', () => {
  const plan = {
    sessionId: 's1',
    version: { gen: 1, rev: 0 },
    status: 'active',
    intent: '给 Vue 加登录页',
    steps: [
      { id: 's1', title: 'A', status: 'done', source: 'model' },
      { id: 's2', title: 'B', status: 'doing', source: 'model' },
      { id: 's3', title: 'C', status: 'todo', source: 'model' },
    ],
    updatedAt: 1,
    reason: 'x',
    watermark: { turn: 2, seq: 20 },
    editedByUser: false,
  };
  const evidence = collectFromEvents({
    events: [
      ev('turn/start', { turn: 2 }, 20),
      userMsg(21, '继续'),
      assistantMsg(22, 2, '已完成 B'),
      ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 23),
    ],
    plan,
    turn: 2,
  });
  const patchPrompt = buildPatchPrompt(evidence);
  assert.equal(patchPrompt.op, 'patch');
  assert.ok(patchPrompt.system.includes('只输出'));
  const rewritePrompt = buildRewritePrompt(evidence, { force: true });
  assert.equal(rewritePrompt.op, 'rewrite');

  const parsed = parseModelOutput(
    JSON.stringify({ op: 'patch', reason: 'B 完成', changes: [{ id: 's2', status: 'done' }], suggestion: '接着做 C' }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.output.changes[0].id, 's2');
  assert.equal(typeof parsed.output.suggestion, 'string');
});

test('collectFromEvents 的实际 turn/end 事件推导 watermark（供 HTTP GET /state 用）', () => {
  const events = [
    ev('turn/start', { turn: 9 }, 900),
    userMsg(901, '最后一条'),
    ev('turn/end', { turn: 9, reason: { kind: 'completed' } }, 902),
  ];
  const evidence = collectFromEvents({ events, plan: null, sessionId: 's9' });
  assert.deepEqual(evidence.watermark, { turn: 9, seq: 902 });
  assert.equal(evidence.sessionId, 's9');
  assert.equal(evidence.turnEndReason, 'completed');
});
