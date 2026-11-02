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
  assert.deepEqual(second.version, { gen: 1, rev: 1 });
  assert.equal(second.steps[1].status, 'doing');
  assert.equal(host.calls.length, 2);
});

test('production host: existing plans keep updating after dispose/apply', async t => {
  const host = setup(t, [initialOutput(), patchOutput('s2', 'doing')]);
  const session = sessionFixture('reload');
  await completeTurn(host, session, 1);
  const before = await completeTurn(host, session, 2);
  host.dispose();
  const reloaded = createHostFixture(apply, [patchOutput('s3', 'doing'), patchOutput('s3', 'done')]);
  t.after(() => reloaded.dispose());
  assert.deepEqual(reloaded.state(session.id).plan, before);
  const after = await completeTurn(reloaded, session, 3);
  assert.deepEqual(after.version, { gen: 1, rev: 2 });
  assert.equal(after.steps[2].status, 'doing');
  const later = await completeTurn(reloaded, session, 4);
  assert.deepEqual(later.version, { gen: 1, rev: 3 });
  assert.equal(later.steps[2].status, 'done');
});

test('production host: upgrade adopts a plan retained by a version without shared storage', async t => {
  const host = setup(t, [initialOutput()]);
  const session = sessionFixture('upgrade');
  await completeTurn(host, session, 1);
  host.dispose();
  delete globalThis[HOST_KEY].store;
  const upgraded = createHostFixture(apply, [patchOutput('s2', 'done')]);
  t.after(() => upgraded.dispose());
  const after = await completeTurn(upgraded, session, 2);
  assert.deepEqual(after.version, { gen: 1, rev: 1 });
  assert.equal(after.steps[1].status, 'done');
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
  assert.deepEqual(newest.version, { gen: 1, rev: 1 });
  assert.equal(newest.steps[1].status, 'done');
  old.reject(new Error('Delayed stream cancellation'));
  await flushJobs();
  assert.deepEqual(host.state(session.id).plan, newest);
  const next = await completeTurn(host, session, 4);
  assert.deepEqual(next.version, { gen: 1, rev: 2 });
  assert.equal(next.steps[2].status, 'doing');
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
  assert.deepEqual(host.state(session.id), previous);
});

test('production host: a replacement apply invalidates work before old context disposal', async t => {
  const pending = deferred();
  const host = setup(t, [initialOutput(), () => pending.promise]);
  const session = sessionFixture('overlap-apply');
  await completeTurn(host, session, 1);
  host.startTurn(session, 2);
  await waitFor(() => host.calls.length === 2, 'old context model request');
  const replacement = createHostFixture(apply, [patchOutput('s3', 'done')]);
  t.after(() => replacement.dispose());
  // During a reload the old listener may still receive the event first. It
  // must not consume the shared turn dedupe key or suppress the new instance.
  host.startTurn(session, 3);
  const latest = await completeTurn(replacement, session, 3);
  assert.equal(latest.steps[2].status, 'done');
  assert.equal(host.calls[1].signal.aborted, true);
  pending.resolve(patchOutput('s2', 'doing'));
  await flushJobs();
  assert.deepEqual(replacement.state(session.id).plan, latest);
  host.dispose();
  assert.deepEqual(replacement.state(session.id).plan, latest);
});
