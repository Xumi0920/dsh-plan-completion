import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';
import { HOST_KEY, createHostFixture, flushJobs, initialOutput, patchOutput, sessionFixture, waitFor } from '../support/host-fixture.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dpc-persist-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function bootHost(t, responses, dir, extra = {}) {
  delete globalThis[HOST_KEY];
  const host = createHostFixture(apply, responses, {
    storageDir: dir,
    persistPlans: true,
    warmBackfill: false,
    ...extra,
  });
  t.after(() => {
    try {
      host.dispose();
    } catch {
      /* ignore */
    }
    delete globalThis[HOST_KEY];
  });
  return host;
}

async function completeTurn(host, session, turn, isDone) {
  host.startTurn(session, turn);
  await flushJobs();
  await waitFor(() => {
    const plan = host.state(session.id)?.plan;
    return plan && (isDone ? isDone(plan) : true);
  }, 'plan committed');
  return host.state(session.id).plan;
}

const isGenOne = plan => plan.version.gen === 1 && plan.version.rev === 0;
const isFirstPatch = plan => plan.version.gen === 1 && plan.version.rev === 1;

/** Dispose a host and drop the process-wide registry = DSH restart. */
function restart(host) {
  host.dispose();
  delete globalThis[HOST_KEY];
}

test('persistence: a restart restores the last plan and suggestion before the next turn', async t => {
  const dir = await tempDir(t);
  const firstHost = bootHost(t, [initialOutput()], dir);
  const session = sessionFixture('persist-restore');
  const first = await completeTurn(firstHost, session, 1, isGenOne);
  assert.deepEqual(first.version, { gen: 1, rev: 0 });
  restart(firstHost);

  const secondHost = bootHost(t, [], dir);
  const response = await secondHost.request('/plan-completion/state?sessionId=persist-restore');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.version, { gen: 1, rev: 0 });
  assert.equal(response.body.stale, false);
  assert.equal(response.body.steps.length, 3);
  assert.equal(response.body.suggestion.text, '先核对实际执行回执，再更新完成状态');
  // No model call was needed: the persisted plan is shown immediately.
  assert.equal(secondHost.calls.length, 0);
});

test('persistence: after a restart the next turn patches the persisted plan', async t => {
  const dir = await tempDir(t);
  const firstHost = bootHost(t, [initialOutput(), patchOutput('s2', 'doing')], dir);
  const session = sessionFixture('persist-next-turn');
  await completeTurn(firstHost, session, 1, isGenOne);
  restart(firstHost);

  const secondHost = bootHost(t, [patchOutput('s2', 'doing')], dir);
  const restored = await secondHost.request('/plan-completion/state?sessionId=persist-next-turn');
  assert.deepEqual(restored.body.version, { gen: 1, rev: 0 });

  const sessionAfterRestart = sessionFixture('persist-next-turn');
  const second = await completeTurn(secondHost, sessionAfterRestart, 2, isFirstPatch);
  assert.deepEqual(second.version, { gen: 1, rev: 1 });
  assert.equal(second.steps[1].status, 'doing');
  assert.equal(secondHost.calls.length, 1);

  // The new version is on disk too.
  restart(secondHost);
  const thirdHost = bootHost(t, [], dir);
  const third = await thirdHost.request('/plan-completion/state?sessionId=persist-next-turn');
  assert.deepEqual(third.body.version, { gen: 1, rev: 1 });
  assert.equal(third.body.steps[1].status, 'doing');
});

test('persistence: reset removes both the memory and disk state', async t => {
  const dir = await tempDir(t);
  const host = bootHost(t, [initialOutput()], dir, { enableDebugRoutes: true });
  const session = sessionFixture('persist-reset');
  await completeTurn(host, session, 1, isGenOne);

  const reset = await host.request('/plan-completion/reset', { sessionId: 'persist-reset' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.ok, true);

  const afterReset = await host.request('/plan-completion/state?sessionId=persist-reset');
  assert.equal(afterReset.body.plan, null);

  restart(host);
  const secondHost = bootHost(t, [], dir);
  const afterRestart = await secondHost.request('/plan-completion/state?sessionId=persist-reset');
  assert.equal(afterRestart.body.plan, null);
});

