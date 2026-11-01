import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePlan,
  normalizeSteps,
  patchPlan,
  rewritePlan,
  applyUserEdit,
  archivePlan,
  createSeedPlan,
  statusFor,
  mayRewrite,
  nextVersion,
  versionEquals,
  isNextVersion,
  compareVersions,
} from '../host/plan.js';

function makePlan(overrides = {}) {
  return {
    sessionId: 's_7f3a',
    version: { gen: 2, rev: 3 },
    status: 'active',
    intent: '给 Vue 项目加登录页，接入现有鉴权',
    steps: [
      { id: 's1', title: '摸清现有路由与鉴权结构', status: 'done', source: 'model', evidence: ['read:src/router.ts'] },
      { id: 's2', title: '新增 Login.vue 与路由', status: 'doing', source: 'model' },
      { id: 's3', title: '接入 token 存储与请求拦截器', status: 'todo', source: 'model' },
    ],
    updatedAt: 1762000000000,
    reason: '第2步进行中',
    revisionOf: { gen: 2, rev: 2 },
    watermark: { turn: 7, seq: 214 },
    editedByUser: false,
    ...overrides,
  };
}

test('normalizePlan 接受合法计划并保留设计文档 §3.4 的字段名', () => {
  const res = normalizePlan(makePlan());
  assert.equal(res.ok, true);
  assert.equal(res.plan.sessionId, 's_7f3a');
  assert.deepEqual(res.plan.version, { gen: 2, rev: 3 });
  assert.equal(res.plan.status, 'active');
  assert.equal(res.plan.steps.length, 3);
  assert.equal(res.plan.steps[0].evidence[0], 'read:src/router.ts');
  assert.deepEqual(res.plan.watermark, { turn: 7, seq: 214 });
  assert.equal(res.plan.editedByUser, false);
  assert.deepEqual(res.plan.revisionOf, { gen: 2, rev: 2 });
  assert.equal(res.plan.reason, '第2步进行中');
});

test('normalizePlan 未知字段丢弃、缺省字段补默认值', () => {
  const res = normalizePlan({
    sessionId: 's1',
    steps: [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', status: 'doing' },
      { id: 'c', title: 'C' },
    ],
    reason: '初始',
    unknownField: 'should-be-dropped',
  });
  assert.equal(res.ok, true);
  assert.equal(res.plan.unknownField, undefined);
  assert.deepEqual(res.plan.version, { gen: 0, rev: 0 });
  assert.equal(res.plan.status, 'active');
  assert.equal(res.plan.steps[0].status, 'todo');
  assert.equal(res.plan.steps[0].source, 'model');
  assert.deepEqual(res.plan.watermark, { turn: 0, seq: 0 });
  assert.equal(res.plan.editedByUser, false);
});

test('normalizePlan 拒绝非法输入且不抛异常', () => {
  const base = makePlan();

  const twoSteps = normalizePlan(makePlan({ steps: base.steps.slice(0, 2) }));
  assert.equal(twoSteps.ok, false);
  assert.equal(twoSteps.code, 'bad-step-count');

  const eightSteps = normalizePlan(
    makePlan({
      steps: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `T${i}`, status: 'todo' })),
    }),
  );
  assert.equal(eightSteps.ok, false);
  assert.equal(eightSteps.code, 'bad-step-count');

  const dupId = normalizePlan(makePlan({ steps: [base.steps[0], base.steps[0], base.steps[2]] }));
  assert.equal(dupId.ok, false);
  assert.equal(dupId.code, 'duplicate-step-id');

  const badStatus = normalizePlan(makePlan({ status: 'paused' }));
  assert.equal(badStatus.ok, false);
  assert.equal(badStatus.code, 'bad-status');

  const badStepStatus = normalizePlan(makePlan({ steps: [base.steps[0], { ...base.steps[1], status: 'wip' }, base.steps[2]] }));
  assert.equal(badStepStatus.ok, false);
  assert.equal(badStepStatus.code, 'bad-step-status');

  const emptyTitle = normalizePlan(makePlan({ steps: [base.steps[0], { ...base.steps[1], title: '   ' }, base.steps[2]] }));
  assert.equal(emptyTitle.ok, false);
  assert.equal(emptyTitle.code, 'bad-step-title');

  const missingReason = normalizePlan(makePlan({ reason: '' }));
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.code, 'missing-reason');

  const badVersion = normalizePlan(makePlan({ version: { gen: -1, rev: 0 } }));
  assert.equal(badVersion.ok, false);
  assert.equal(badVersion.code, 'bad-version');

  for (const weird of [null, undefined, 42, 'x', [], {}]) {
    const res = normalizePlan(weird);
    assert.equal(res.ok, false);
  }
});

test('normalizeSteps 校验 3~7 且 id 唯一', () => {
  assert.equal(normalizeSteps([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]).ok, true);
  assert.equal(normalizeSteps([]).ok, false);
  assert.equal(
    normalizeSteps([{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }, { id: 'c', title: 'C' }]).ok,
    false,
  );
});

test('statusFor：全部 done/dropped 才是 completed', () => {
  assert.equal(statusFor([]), 'active');
  assert.equal(statusFor([{ status: 'done' }, { status: 'dropped' }]), 'completed');
  assert.equal(statusFor([{ status: 'done' }, { status: 'todo' }]), 'active');
  assert.equal(statusFor([{ status: 'doing' }]), 'active');
});

test('版本规则：patch → rev+1；rewrite → gen+1.0；初始 0.0', () => {
  assert.deepEqual(nextVersion({ gen: 2, rev: 3 }, 'patch'), { gen: 2, rev: 4 });
  assert.deepEqual(nextVersion({ gen: 2, rev: 3 }, 'rewrite'), { gen: 3, rev: 0 });
  assert.deepEqual(nextVersion(null, 'rewrite'), { gen: 0, rev: 0 });
  assert.equal(isNextVersion({ gen: 2, rev: 3 }, { gen: 2, rev: 4 }), true);
  assert.equal(isNextVersion({ gen: 2, rev: 3 }, { gen: 3, rev: 0 }), true);
  assert.equal(isNextVersion({ gen: 2, rev: 3 }, { gen: 2, rev: 5 }), false);
  assert.equal(isNextVersion({ gen: 2, rev: 3 }, { gen: 1, rev: 0 }), false);
  assert.equal(isNextVersion(null, { gen: 0, rev: 0 }), true);
  assert.equal(versionEquals({ gen: 1, rev: 2 }, { gen: 1, rev: 2 }), true);
  assert.equal(compareVersions({ gen: 2, rev: 0 }, { gen: 1, rev: 9 }), 1);
});

test('patchPlan：版本 rev+1、revisionOf、证据合并、输入不被修改', () => {
  const plan = makePlan();
  const before = JSON.stringify(plan);
  const res = patchPlan(
    plan,
    [
      { id: 's2', status: 'done', evidence: ['write:src/views/Login.vue'] },
      { id: 's3', status: 'doing' },
    ],
    { reason: '第2步完成（已创建 Login.vue）', watermark: { turn: 8, seq: 240 }, now: 1762000100000 },
  );
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.deepEqual(res.plan.version, { gen: 2, rev: 4 });
  assert.deepEqual(res.plan.revisionOf, { gen: 2, rev: 3 });
  assert.equal(res.plan.reason, '第2步完成（已创建 Login.vue）');
  assert.equal(res.plan.steps[1].status, 'done');
  assert.deepEqual(res.plan.steps[1].evidence, ['write:src/views/Login.vue']);
  assert.equal(res.plan.steps[2].status, 'doing');
  assert.deepEqual(res.plan.watermark, { turn: 8, seq: 240 });
  assert.equal(res.plan.updatedAt, 1762000100000);
  assert.equal(JSON.stringify(plan), before, 'patchPlan 不应修改输入计划');
});

test('patchPlan：全部完成推导 status=completed；无实质变化 changed=false', () => {
  const plan = makePlan({
    steps: [
      { id: 's1', title: 'A', status: 'done', source: 'model' },
      { id: 's2', title: 'B', status: 'done', source: 'model' },
      { id: 's3', title: 'C', status: 'todo', source: 'model' },
    ],
  });
  const done = patchPlan(plan, [{ id: 's3', status: 'done' }], { reason: '全部完成' });
  assert.equal(done.ok, true);
  assert.equal(done.plan.status, 'completed');

  const plan2 = makePlan();
  const same = patchPlan(plan2, [{ id: 's1', status: 'done' }], { reason: '重报一次' });
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  assert.equal(same.plan.version.rev, plan2.version.rev + 1, '版本仍按 patch 前进');
});

test('patchPlan：未知 id / 空 changes / 缺 reason 都返回结构化错误', () => {
  const plan = makePlan();
  const unknown = patchPlan(plan, [{ id: 'nope', status: 'done' }], { reason: 'x' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'unknown-step');
  const noChange = patchPlan(plan, [{ id: 's1', status: 'done' }], { reason: '重复上报' });
  assert.equal(noChange.ok, true, '合法但无实质变化的 patch 仍应成功');
  assert.equal(noChange.changed, false);
  assert.equal(patchPlan(plan, [], { reason: 'x' }).code, 'empty-changes');
  assert.equal(patchPlan(plan, [{ id: 's1', status: 'done' }], {}).code, 'missing-reason');
  assert.equal(patchPlan(plan, [{ id: 's1', status: 'bad' }], { reason: 'x' }).code, 'bad-change-status');
  assert.equal(patchPlan(plan, [{ id: 's1' }], { reason: 'x' }).code, 'empty-change');
  assert.equal(patchPlan(null, [{ id: 's1', status: 'done' }], { reason: 'x' }).ok, false);
});

test('rewritePlan：gen+1、rev=0、整体替换 steps', () => {
  const plan = makePlan();
  const res = rewritePlan(plan, {
    reason: '阶段边界：鉴权层完成',
    intent: '给 Vue 项目加登录页，接入现有鉴权',
    steps: [
      { id: 's1', title: '路由与鉴权结构', status: 'done' },
      { id: 's2', title: '登录页与 token 拦截器', status: 'doing' },
      { id: 's3', title: '补测试并验收', status: 'todo' },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.changed, true);
  assert.deepEqual(res.plan.version, { gen: 3, rev: 0 });
  assert.deepEqual(res.plan.revisionOf, { gen: 2, rev: 3 });
  assert.equal(res.plan.steps.length, 3);
  assert.equal(res.plan.steps[1].title, '登录页与 token 拦截器');
  assert.equal(res.plan.steps[0].source, 'model');
});

test('用户编辑优先：editedByUser=true 后模型不得自动 rewrite，force 才放行', () => {
  const edited = applyUserEdit(
    makePlan(),
    {
      steps: [
        { id: 's1', title: '摸清现有路由与鉴权结构', status: 'done', source: 'model' },
        { id: 's2', title: '新增 Login.vue（用户改）', status: 'doing', source: 'model' },
        { id: 's3', title: '接入 token 存储与请求拦截器', status: 'todo', source: 'model' },
      ],
    },
    { reason: 'user edit' },
  );
  assert.equal(edited.ok, true);
  assert.equal(edited.plan.editedByUser, true);
  assert.deepEqual(edited.plan.version, { gen: 3, rev: 0 });
  assert.equal(edited.plan.reason, 'user edit');
  assert.equal(edited.plan.steps[1].source, 'user', '改动过的步骤 source=user');
  assert.equal(edited.plan.steps[0].source, 'model', '未改动步骤保留原 source');

  assert.equal(mayRewrite(edited.plan), false);
  assert.equal(mayRewrite(edited.plan, { force: true }), true);
  assert.equal(mayRewrite(makePlan()), true);
  assert.equal(mayRewrite(null), true);

  const nextSteps = [
    { id: 's1', title: '路由与鉴权', status: 'done' },
    { id: 's2', title: '登录页', status: 'doing' },
    { id: 's3', title: '测试', status: 'todo' },
  ];
  const blocked = rewritePlan(edited.plan, { reason: '模型想重写', steps: nextSteps });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'locked-by-user');

  const forced = rewritePlan(edited.plan, { reason: '用户 /replan', steps: nextSteps }, { force: true });
  assert.equal(forced.ok, true);
  assert.deepEqual(forced.plan.version, { gen: 4, rev: 0 });
  assert.equal(forced.plan.editedByUser, false, '/replan 强制重写后解除用户编辑锁');
});

test('rewritePlan：冷启动（plan=null）产出 0.0 首版；缺 sessionId 报错', () => {
  const cold = rewritePlan(null, { reason: '首个计划', steps: makePlan().steps }, { sessionId: 's1' });
  assert.equal(cold.ok, true);
  assert.deepEqual(cold.plan.version, { gen: 0, rev: 0 });
  assert.equal(cold.plan.sessionId, 's1');

  const bad = rewritePlan(null, { reason: '首个计划', steps: makePlan().steps });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad-session');
});

test('applyUserEdit / archivePlan 的版本规则', () => {
  const edited = applyUserEdit(makePlan(), { steps: makePlan().steps }, {});
  assert.equal(edited.plan.version.gen, 3);
  assert.equal(edited.plan.version.rev, 0);
  assert.equal(edited.plan.reason, 'user edit');

  const archived = archivePlan(makePlan(), { reason: 'topic-drift' });
  assert.equal(archived.ok, true);
  assert.equal(archived.plan.status, 'archived');
  assert.deepEqual(archived.plan.version, { gen: 3, rev: 0 });

  const archivedPatch = patchPlan(archived.plan, [{ id: 's3', status: 'doing' }], { reason: 'x' });
  assert.equal(archivedPatch.ok, false);
  assert.equal(archivedPatch.code, 'archived');
});

test('createSeedPlan：0.0、3~5 步、来源 model', () => {
  const res = createSeedPlan({
    sessionId: 's1',
    intent: '给 Vue 加登录页',
    steps: [
      { id: 'a', title: '摸清现状', status: 'todo', source: 'model' },
      { id: 'b', title: '实现核心改动', status: 'todo', source: 'model' },
      { id: 'c', title: '自测验收', status: 'todo', source: 'model' },
    ],
    reason: 'seed-fallback',
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.plan.version, { gen: 0, rev: 0 });
  assert.equal(res.plan.status, 'active');
  assert.equal(res.plan.steps.length, 3);
});
