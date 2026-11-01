import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectFromEvents } from '../host/evidence.js';

function ev(type, data, seq) {
  return { type, seq, time: seq, data };
}

function userEvent(seq, turn, text) {
  return ev('user/message', { role: 'user', content: [{ type: 'text', text }] }, seq);
}

function assistantEvent(seq, turn, text, extraBlocks = []) {
  return ev(
    'assistant/message',
    {
      turn,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }, ...extraBlocks] },
      stream: [],
    },
    seq,
  );
}

function toolCallEvent(seq, turn, callId, name, args) {
  return ev('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args ?? {}) }, seq);
}

function toolResultEvent(seq, turn, callId, { isError = false, content = '', error } = {}) {
  const message = {
    role: 'tool',
    source: { kind: 'tool', callId },
    toolCallId: callId,
    content: content ? [{ type: 'text', text: content }] : [],
  };
  if (isError) message.isError = true;
  const data = { turn, step: 1, message };
  if (error) data.error = error;
  return ev('tool/result', data, seq);
}

function makeEvents() {
  return [
    ev('turn/start', { turn: 1 }, 10),
    userEvent(11, 1, '先给项目加一个登录页'),
    assistantEvent(12, 1, '好的，我先看路由。', [{ type: 'reasoning', text: '不要被当作正文的推理' }]),
    toolCallEvent(13, 1, 'c1', 'read', { file_path: 'src/router.ts' }),
    toolResultEvent(14, 1, 'c1', { content: 'router content' }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 15),
    ev('turn/start', { turn: 2 }, 16),
    userEvent(17, 2, '把它接到现有鉴权上'),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 18),
    ev('turn/start', { turn: 3 }, 19),
    userEvent(20, 3, '登录页要支持 token 刷新'),
    assistantEvent(21, 3, '已创建 Login.vue，并挂上 /login 路由。', [
      { type: 'reasoning', text: '内部推理不应出现在证据里' },
      { type: 'tool-call', id: 'x', name: 'write', arguments: '{}' },
    ]),
    toolCallEvent(22, 3, 'c2', 'write', { file_path: 'src/views/Login.vue' }),
    toolResultEvent(23, 3, 'c2', { content: 'written' }),
    toolCallEvent(24, 3, 'c3', 'bash', { command: 'npm test' }),
    toolResultEvent(25, 3, 'c3', { isError: true, content: 'EACCES: permission denied', error: { name: 'EACCES', code: 'EACCES', reason: 'permission denied' } }),
    ev('turn/end', { turn: 3, reason: { kind: 'completed' } }, 26),
  ];
}

test('collectFromEvents：turn / seq / watermark / 最后 assistant 文本（只取 text block）', () => {
  const events = makeEvents();
  const evidence = collectFromEvents({ events, plan: null });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.turn, 3);
  assert.equal(evidence.seq, 26);
  assert.deepEqual(evidence.watermark, { turn: 3, seq: 26 });
  assert.equal(evidence.lastAssistantText, '已创建 Login.vue，并挂上 /login 路由。');
  assert.equal(evidence.lastAssistantText.includes('内部推理'), false);
  assert.equal(evidence.turnEnded, true);
  assert.equal(evidence.turnEndReason, 'completed');
  assert.equal(evidence.interrupted, false);
});

test('collectFromEvents：最近 2 条用户消息跨回合；首条消息与最近消息', () => {
  const evidence = collectFromEvents({ events: makeEvents(), plan: null });
  assert.deepEqual(evidence.lastUserMessages, ['把它接到现有鉴权上', '登录页要支持 token 刷新']);
  assert.equal(evidence.firstUserMessage, '先给项目加一个登录页');
  assert.equal(evidence.intent, '先给项目加一个登录页');
  assert.ok(evidence.recentMessages.length <= 6);
  assert.deepEqual(evidence.recentMessages[evidence.recentMessages.length - 1].role, 'assistant');
});

test('collectFromEvents：本回合工具调用与失败项（callId 关联 name）', () => {
  const evidence = collectFromEvents({ events: makeEvents(), plan: null });
  assert.equal(evidence.toolCalls.length, 2, '只应采集本回合（turn 3）的工具调用');
  assert.deepEqual(
    evidence.toolCalls.map((call) => call.name),
    ['write', 'bash'],
  );
  assert.equal(evidence.toolCalls[0].ok, true);
  assert.equal(evidence.toolCalls[1].ok, false);
  assert.ok(evidence.failedTools.length === 1);
  assert.equal(evidence.failedTools[0].name, 'bash');
  assert.ok(evidence.failedTools[0].error.includes('EACCES'));
  assert.deepEqual(evidence.files, ['src/views/Login.vue']);
});

test('collectFromEvents：turn/end 的 error / interrupted 原因', () => {
  const events = [
    ev('turn/start', { turn: 5 }, 100),
    userEvent(101, 5, '跑一下构建'),
    toolCallEvent(102, 5, 'c9', 'bash', {}),
    toolResultEvent(103, 5, 'c9', { isError: true, content: 'build failed' }),
    ev('turn/end', { turn: 5, reason: { kind: 'error', error: { message: 'LLM timeout', code: 'timeout' } } }, 104),
  ];
  const evidence = collectFromEvents({ events });
  assert.equal(evidence.turn, 5);
  assert.equal(evidence.turnEndReason, 'error');
  assert.equal(evidence.turnEndError.includes('LLM timeout'), true);
  assert.equal(evidence.interrupted, true);
});

test('collectFromEvents：提问回合检测', () => {
  const events = [
    ev('turn/start', { turn: 4 }, 50),
    userEvent(51, 4, '帮我选个方案'),
    assistantEvent(52, 4, '方案 A 快，方案 B 稳，你更倾向哪个？'),
    ev('turn/end', { turn: 4, reason: { kind: 'completed' } }, 53),
  ];
  const evidence = collectFromEvents({ events });
  assert.equal(evidence.hasQuestion, true);

  const noQuestion = collectFromEvents({
    events: [
      ev('turn/start', { turn: 4 }, 50),
      assistantEvent(52, 4, '已经按方案 A 实现完了。'),
      ev('turn/end', { turn: 4, reason: { kind: 'completed' } }, 53),
    ],
  });
  assert.equal(noQuestion.hasQuestion, false);
});

test('collectFromEvents：传 plan 时补 intent / todoSteps，且不修改输入', () => {
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
    watermark: { turn: 3, seq: 26 },
    editedByUser: false,
  };
  const events = makeEvents();
  const eventsSnapshot = JSON.stringify(events);
  const planSnapshot = JSON.stringify(plan);
  const evidence = collectFromEvents({ events, plan, sessionId: 's1' });
  assert.equal(evidence.plan.intent, '给 Vue 加登录页');
  assert.equal(evidence.intent, '给 Vue 加登录页');
  assert.deepEqual(
    evidence.todoSteps.map((step) => step.id),
    ['s2', 's3'],
  );
  assert.equal(JSON.stringify(events), eventsSnapshot, '不应修改 events');
  assert.equal(JSON.stringify(plan), planSnapshot, '不应修改 plan');
});

test('collectFromEvents：非数组输入返回结构化失败而不抛异常', () => {
  for (const weird of [null, undefined, 'events', {}, 42]) {
    const evidence = collectFromEvents({ events: weird });
    assert.equal(evidence.ok, false);
    assert.equal(typeof evidence.error, 'string');
  }
  assert.equal(collectFromEvents().ok, false);
});

test('collectFromEvents：兼容 data 缺失、role 直给等宽松形态', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { role: 'user', content: '直接字符串内容' } },
    { type: 'assistant/message', seq: 3, data: { message: { role: 'assistant', content: '字符串正文' } } },
    { type: 'tool/call', seq: 4, name: 'edit', callId: 'k1', arguments: '{"path":"a.js"}' },
    { type: 'tool/result', seq: 5, callId: 'k1', ok: false, error: 'boom' },
    { type: 'turn/end', seq: 6, data: { turn: 1 } },
  ];
  const evidence = collectFromEvents({ events });
  assert.equal(evidence.ok, true);
  assert.equal(evidence.lastUserMessages[0], '直接字符串内容');
  assert.equal(evidence.lastAssistantText, '字符串正文');
  assert.equal(evidence.toolCalls.length, 1);
  assert.equal(evidence.toolCalls[0].ok, false);
  assert.equal(evidence.files[0], 'a.js');
});
