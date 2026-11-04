import {protocolOutput} from '../support/host-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';
import { applyUserEdit } from '../host/plan.js';
import { HOST_KEY, createHostFixture, deferred, flushJobs, initialOutput, patchOutput, sessionFixture, waitFor } from '../support/host-fixture.js';

function setup(t, responses, config) {
  delete globalThis[HOST_KEY];
  const host = createHostFixture(apply, responses, config);
  t.after(() => { host.dispose(); delete globalThis[HOST_KEY]; });
  return host;
}
async function completeTurn(host, session, turn) {
  host.startTurn(session, turn);
  await flushJobs();
  return host.state(session.id).plan;
}

test('production host: cold-start rewrite and next-turn patch advance the same plan', async t => {
  const host = setup(t, [initialOutput(), patchOutput('s2', 'doing')]);
  const session = sessionFixture('normal');
  const first = await completeTurn(host, session, 1);
  assert.deepEqual(first.version, { gen: 1, rev: 0 });
  const second = await completeTurn(host, session, 2);
  assert.deepEqual(second.version, { gen: 1, rev: 0 });
  assert.equal(second.steps[1].status, 'todo');
  assert.equal(host.calls.length, 2);
});

test('production host: /replan forces a rewrite and advances the plan', async t => {
  const rewritten = protocolOutput({
    progress: {version:1,events:[]}, op: 'rewrite',
    reason: '按最新进展重排二期计划',
    intent: '二期收尾',
    steps: [
      { id: 's1', title: '[交付] 计划持久化', status: 'done' },
      { id: 's2', title: '[交付] 核对进度', status: 'done' },
      { id: 's3', title: '[交付] 文本保真', status: 'done' },
      { id: 's4', title: '[二期] 模型设置页', status: 'todo' },
      { id: 's5', title: '[二期] 右栏计划页', status: 'todo' },
    ],
    suggestion: '开始做模型设置页',
  });
  const host = setup(t, [initialOutput(), rewritten]);
  const session = sessionFixture('replan-route');
  const first = await completeTurn(host, session, 1);
  assert.deepEqual(first.version, { gen: 1, rev: 0 });
  assert.equal(first.steps[0].title, 'Inspect requirements');

  const queued = await host.request('/plan-completion/replan', { sessionId: session.id });
  assert.equal(queued.body.ok, true);
  await waitFor(() => host.state(session.id)?.plan?.version?.gen === 2, 'rewrite committed');
  const after = host.state(session.id).plan;
  assert.deepEqual(after.version, { gen: 2, rev: 0 });
  assert.equal(after.steps.length, 5);
  assert.equal(after.steps[3].title, '[二期] 模型设置页');
  assert.equal(after.steps[0].status, 'todo', 'a rewrite has no execution receipts');
  assert.equal(host.state(session.id).suggestion.text, '验收提案有未生效项，请核对版本和条件');
});

test('production host: repeated valid op=none reviews keep the plan current', async t => {
  const noneOutput = { progress: {version:1,events:[]}, op: 'none', reason: '没有实质变化', suggestion: '继续推进当前计划' };
  const host = setup(t, [initialOutput(), noneOutput, noneOutput]);
  const session = sessionFixture('none-streak');
  await completeTurn(host, session, 1);
  await completeTurn(host, session, 2);
  assert.equal(host.state(session.id).suggestion.text, '继续推进当前计划');
  assert.equal(host.state(session.id).stale, false);
  await completeTurn(host, session, 3);
  assert.equal(host.state(session.id).suggestion.text, '继续推进当前计划');
  assert.equal(host.state(session.id).stale, false);
});

test('production host: repeated failed updates still surface an actionable review', async t => {
  const fail = () => { throw new Error('synthetic provider unavailable'); };
  const host = setup(t, [initialOutput(), fail, fail]);
  const session = sessionFixture('failed-update-streak');
  await completeTurn(host, session, 1);
  await completeTurn(host, session, 2);
  assert.equal(host.state(session.id).stale, false);
  await completeTurn(host, session, 3);
  assert.match(host.state(session.id).suggestion.text, /^\/replan/);
  assert.equal(host.state(session.id).stale, true);
});

test('production host: memory-only state is discarded on root unload and never read from a global alias', async t => {
  const host = setup(t, [initialOutput()]);
  const session = sessionFixture('unload-memory');
  await completeTurn(host, session, 1);
  assert.ok(host.state(session.id).plan);
  host.dispose();
  const fresh = createHostFixture(apply, [], { persistPlans: false });
  t.after(() => fresh.dispose());
  assert.equal((await fresh.request('/plan-completion/state?sessionId=unload-memory')).body.plan, null);
  assert.notEqual(host.core.states, fresh.core.states);
});

test('production host: independent contexts cannot cancel or read each other', async t => {
  const pending = deferred();
  const first = setup(t, [() => pending.promise]);
  const session = sessionFixture('same-id');
  first.startTurn(session, 1);
  await waitFor(() => first.calls.length === 1);
  const second = createHostFixture(apply, [initialOutput()]);
  t.after(() => second.dispose());
  assert.equal(first.calls[0].signal.aborted, false);
  assert.equal(second.state(session.id), undefined);
  pending.resolve(initialOutput()); await flushJobs();
  assert.ok(first.state(session.id).plan);
  assert.equal(second.state(session.id), undefined);
});

test('production host: a delayed abort rejection cannot roll back a replacement job', async t => {
  const old = deferred();
  const host = setup(t, [initialOutput(), () => old.promise, patchOutput('s2', 'done'), patchOutput('s3', 'doing')]);
  const session = sessionFixture('superseded');
  await completeTurn(host, session, 1);
  host.startTurn(session, 2);
  await waitFor(() => host.calls.length === 2, 'old model request');
  const newest = await completeTurn(host, session, 3);
  assert.equal(host.calls[1].signal.aborted, true);
  assert.deepEqual(newest.version, { gen: 1, rev: 0 });
  assert.equal(newest.steps[1].status, 'todo', 'superseding jobs require receipts');
  old.reject(new Error('Delayed stream cancellation'));
  await flushJobs();
  assert.deepEqual(host.state(session.id).plan, newest);
  const next = await completeTurn(host, session, 4);
  assert.deepEqual(next.version, { gen: 1, rev: 0 });
  assert.equal(next.steps[2].status, 'todo');
});

test('production host: a user edit made during generation keeps its version and steps', async t => {
  const pending = deferred();
  const host = setup(t, [initialOutput(), () => pending.promise], { enableDebugRoutes: true });
  const session = sessionFixture('user-edit');
  await completeTurn(host, session, 1);
  host.startTurn(session, 2);
  await waitFor(() => host.calls.length === 2, 'pending model request');
  const edit = await host.request('/plan-completion/steps', { sessionId: session.id, stepId: 's3', status: 'done' });
  assert.equal(edit.status, 200); assert.equal(edit.body.ok, true);
  const edited = structuredClone(host.state(session.id));
  pending.resolve(patchOutput('s2', 'doing'));
  await flushJobs();
  assert.deepEqual(host.state(session.id), edited);
  assert.equal(host.state(session.id).plan.editedByUser, true);
});

test('production host: a store CAS conflict publishes the stored winner, never the old base', async t => {
  const pending = deferred();
  const host = setup(t, [initialOutput(), () => pending.promise]);
  const session = sessionFixture('store-conflict');
  const initial = await completeTurn(host, session, 1);
  host.startTurn(session, 2);
  await waitFor(() => host.calls.length === 2, 'pending model request');
  const winner = applyUserEdit(initial, { steps: initial.steps.map(step => ({ ...step, status: 'done' })) }, { now: Date.now(), watermark: initial.watermark, reason: 'External writer' }).plan;
  assert.ok(globalThis[HOST_KEY].store, 'runtime must retain its shared CAS store');
  assert.equal(globalThis[HOST_KEY].store.put(winner, { cas: initial.version }), true);
  pending.resolve(patchOutput('s2', 'doing'));
  await flushJobs();
  assert.deepEqual(host.state(session.id).plan, winner);
  assert.equal(host.state(session.id).suggestion, null);
  assert.equal(host.state(session.id).stale, true);
});

test('production host: dispose aborts inflight work and ignores a late successful response', async t => {
  const pending = deferred();
  const host = setup(t, [initialOutput(), () => pending.promise]);
  const session = sessionFixture('disposed');
  await completeTurn(host, session, 1);
  host.startTurn(session, 2);
  await waitFor(() => host.calls.length === 2, 'pending model request');
  const previous = structuredClone(host.state(session.id));
  host.dispose();
  assert.equal(host.calls[1].signal.aborted, true);
  pending.resolve(patchOutput('s2', 'done'));
  await flushJobs();
  assert.deepEqual(host.state(session.id).plan, previous.plan);
  assert.deepEqual(host.state(session.id).suggestion, previous.suggestion);
  assert.equal(host.state(session.id).stale, true, 'unloaded observation invalidates freshness');
});

test('production host: disposal of one context cannot roll back another', async t => {
  const pending = deferred();
  const host = setup(t, [initialOutput(), () => pending.promise]);
  const session = sessionFixture('overlap-apply');
  await completeTurn(host, session, 1);
  host.startTurn(session, 2);
  await waitFor(() => host.calls.length === 2, 'old context model request');
  const replacement = createHostFixture(apply, [initialOutput()]);
  t.after(() => replacement.dispose());
  host.dispose();
  const latest = await completeTurn(replacement, session, 3);
  assert.equal(latest.steps[2].status, 'todo', 'new apply retains the completion gate');
  assert.equal(host.calls[1].signal.aborted, true);
  pending.resolve(patchOutput('s2', 'doing'));
  await flushJobs();
  assert.deepEqual(replacement.state(session.id).plan, latest);
  host.dispose();
  assert.deepEqual(replacement.state(session.id).plan, latest);
});
