import { test } from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';
import { buildVerifyPrompt, parseVerifyOutput } from '../host/prompt.js';
import { HOST_KEY, createHostFixture, flushJobs, initialOutput, sessionFixture, waitFor } from '../support/host-fixture.js';

const PLAN = {
  sessionId: 'verify-session',
  version: { gen: 1, rev: 0 },
  status: 'active',
  intent: 'persist plans',
  steps: [
    { id: 's1', title: 'Store API', status: 'done' },
    { id: 's2', title: 'Hydrate on mount', status: 'todo' },
    { id: 's3', title: 'Regression tests', status: 'todo' },
  ],
  updatedAt: 1700000000000,
  reason: 'seed',
  watermark: { turn: 1, seq: 10 },
};

function setup(t, responses, config = {}) {
  delete globalThis[HOST_KEY];
  const host = createHostFixture(apply, responses, config);
  t.after(() => {
    host.dispose();
    delete globalThis[HOST_KEY];
  });
  return host;
}

const verifyJson = JSON.stringify({
  ok: true,
  assessment: '计划落后于实际：持久化已完成但步骤仍为 todo。',
  mismatches: [
    { stepId: 's2', issue: 'mount hydration 已实现，但计划仍标记 todo' },
    { stepId: 's3', issue: '120 个测试已通过，计划未记录完成' },
  ],
  suggestion: '把 s2/s3 标记完成并进入发布',
});

test('verify prompt: carries the plan and the mismatch schema', () => {
  const prompt = buildVerifyPrompt({ plan: PLAN, turn: 3, lastAssistantText: 'done' });
  assert.equal(prompt.op, 'verify');
  assert.equal(prompt.temperature, 0);
  const content = prompt.messages[0].content;
  assert.match(content, /核对计划进度/);
  assert.match(content, /"mismatches"/);
  assert.match(content, /"s2"/);
  assert.equal(content.includes('"op"'), false);
});

test('verify parser: accepts fenced JSON and clamps the mismatch list', () => {
  const parsed = parseVerifyOutput('```json\n' + verifyJson + '\n```');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.output.assessment.includes('计划落后于实际'), true);
  assert.equal(parsed.output.mismatches.length, 2);
  assert.equal(parsed.output.mismatches[0].stepId, 's2');
  assert.equal(parsed.output.suggestion, '把 s2/s3 标记完成并进入发布');

  const empty = parseVerifyOutput('{"ok":true,"assessment":"一致","mismatches":[],"suggestion":""}');
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.output.mismatches, []);
});

test('verify parser: rejects output without an assessment', () => {
  const parsed = parseVerifyOutput('{"mismatches":[]}');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'missing-assessment');
});

async function seedPlan(host, session) {
  host.startTurn(session, 1);
  await flushJobs();
  await waitFor(() => host.state(session.id)?.plan, 'seed plan');
}

test('verify route: returns the model verdict for an existing plan', async t => {
  const host = setup(t, [initialOutput(), verifyJson]);
  const session = sessionFixture('verify-route');
  await seedPlan(host, session);
  const response = await host.request('/plan-completion/verify', { sessionId: session.id });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.mismatches.length, 2);
  assert.equal(response.body.assessment.length > 0, true);
  // The route must not mutate the plan.
  assert.deepEqual(host.state(session.id).plan.version, { gen: 1, rev: 0 });
});

test('verify route: no plan / model disabled are reported without calling the model', async t => {
  const emptyHost = setup(t, []);
  const emptySession = sessionFixture('verify-noplan');
  const noPlan = await emptyHost.request('/plan-completion/verify', { sessionId: emptySession.id });
  assert.equal(noPlan.body.ok, false);
  assert.equal(noPlan.body.error, 'no-plan');

  const host = setup(t, [initialOutput()]);
  const session = sessionFixture('verify-disabled');
  await seedPlan(host, session);
  // Same process-wide host state, but the new apply disables model calls.
  const disabledHost = createHostFixture(apply, [], { modelCalls: false });
  t.after(() => {
    try {
      disabledHost.dispose();
    } catch {
      /* ignore */
    }
  });
  const disabled = await disabledHost.request('/plan-completion/verify', { sessionId: session.id });
  assert.equal(disabled.body.ok, false);
  assert.equal(disabled.body.error, 'model-disabled');
});
