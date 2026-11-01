import { test } from 'node:test';
import assert from 'node:assert/strict';

import { heuristicSuggestion, fallbackPlan } from '../host/heuristics.js';
import { createSeedPlan } from '../host/plan.js';

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
    watermark: { turn: 7, seq: 214 },
    editedByUser: false,
    ...overrides,
  };
}

test('启发式分支 1：失败工具 → 修报错', () => {
  const res = heuristicSuggestion({
    plan: makePlan(),
    failedTools: [{ name: 'write', ok: false, error: 'EACCES: permission denied' }],
  });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'fix-error');
  assert.ok(res.text.includes('write'));
  assert.ok(res.text.includes('EACCES') || res.text.includes('报错'));
  assert.ok(Array.from(res.text).length <= 40);
  assert.equal(res.text.includes('\n'), false);
});

test('启发式分支 2：有未完成步骤 → 下一个', () => {
  const res = heuristicSuggestion({ plan: makePlan() });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'next-step');
  assert.ok(res.text.includes('新增 Login.vue'));
  assert.ok(Array.from(res.text).length <= 40);
});

test('启发式分支 3：提问回合 → 给倾向性决策', () => {
  // 无失败、无未完成步骤时，提问回合才走「给决策」分支（优先级见分支顺序）。
  const completedPlan = makePlan({
    steps: [
      { id: 's1', title: '摸清路由与鉴权', status: 'done', source: 'model' },
      { id: 's2', title: '新增 Login.vue 与路由', status: 'done', source: 'model' },
      { id: 's3', title: '接入 token 拦截器', status: 'done', source: 'model' },
    ],
  });
  const res = heuristicSuggestion({
    plan: completedPlan,
    lastAssistantText: '要不要我先接入刷新 token 的逻辑？',
    hasQuestion: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'decide');
  assert.ok(res.text.length > 4);
  assert.equal(/^(继续|好的|可以)$/.test(res.text), false);
});

test('启发式分支 4：全部完成 → 验收', () => {
  const res = heuristicSuggestion({
    plan: makePlan({
      steps: [
        { id: 's1', title: 'A', status: 'done', source: 'model' },
        { id: 's2', title: 'B', status: 'done', source: 'model' },
        { id: 's3', title: 'C', status: 'dropped', source: 'model' },
      ],
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'accept');
  assert.ok(res.text.includes('验收') || res.text.includes('完成'));
});

test('启发式分支 5：无计划按 intent 起步；完全没上下文返回 ok:false', () => {
  const withIntent = heuristicSuggestion({ intent: '给项目加暗色主题' });
  assert.equal(withIntent.ok, true);
  assert.ok(withIntent.text.includes('暗色主题'));

  const none = heuristicSuggestion({});
  assert.equal(none.ok, false);
  assert.equal(none.kind, 'none');

  assert.equal(heuristicSuggestion(null).ok, false);
});

test('启发式优先级：失败工具 > 未完成 todo > 提问 > 验收', () => {
  const evidence = {
    plan: makePlan(),
    failedTools: [{ name: 'bash', ok: false, error: 'exit 1' }],
    lastAssistantText: '要采用方案 A 还是方案 B？',
    hasQuestion: true,
  };
  assert.equal(heuristicSuggestion(evidence).kind, 'fix-error');
  assert.equal(heuristicSuggestion({ ...evidence, failedTools: [] }).kind, 'next-step');
});

test('fallbackPlan：3~5 步骨架，可被 createSeedPlan 接受', () => {
  const res = fallbackPlan('给 Vue 项目加登录页，接入现有鉴权');
  assert.equal(res.ok, true);
  assert.ok(res.steps.length >= 3 && res.steps.length <= 5);
  assert.equal(new Set(res.steps.map((step) => step.id)).size, res.steps.length);
  for (const step of res.steps) {
    assert.ok(step.title.trim().length > 0);
    assert.equal(step.status, 'todo');
    assert.equal(step.source, 'model');
  }
  const seed = createSeedPlan({
    sessionId: 's1',
    intent: res.intent,
    steps: res.steps,
    reason: 'seed-fallback',
  });
  assert.equal(seed.ok, true, `骨架应能通过 createSeedPlan 校验：${seed.error || ''}`);
});

test('fallbackPlan：按 intent 关键词选择骨架', () => {
  const bug = fallbackPlan('修复登录接口报错');
  assert.ok(bug.steps.some((step) => step.title.includes('报错') || step.title.includes('修复')));

  const design = fallbackPlan('设计新的鉴权方案架构');
  assert.ok(design.steps.some((step) => step.title.includes('方案') || step.title.includes('约束')));

  const empty = fallbackPlan('');
  assert.equal(empty.ok, true);
  assert.ok(empty.steps.length >= 3 && empty.steps.length <= 5);
});
