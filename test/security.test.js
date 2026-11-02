import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { requestRejection, safeDebugRecord, safeDiagnostics } from '../host/security.js';
import { HOST_KEY, createHostFixture, initialOutput, patchOutput, sessionFixture, flushJobs, deferred, waitFor } from '../support/host-fixture.js';

function setup(t, responses = [], config = {}) {
  delete globalThis[HOST_KEY];
  const host = createHostFixture(apply, responses, config);
  t.after(() => { host.dispose(); delete globalThis[HOST_KEY]; });
  return host;
}

test('security: fail closed if DSH admission is absent, throws, or has an incompatible result', () => {
  assert.equal(requestRejection(null, {}), 503);
  assert.equal(requestRejection({ requestRejection() { throw Error('secret'); } }, {}), 503);
  assert.equal(requestRejection({ requestRejection: () => null }, {}), 503);
  assert.equal(requestRejection({ requestRejection: () => false }, {}), 503);
  assert.equal(requestRejection({ requestRejection: () => undefined }, {}), undefined);
});

for (const status of [401, 403]) {
  test('security: production routes honor DSH rejection ' + status + ' before reading a body', async t => {
    const host = setup(t);
    let checks = 0;
    host.services.connection.requestRejection = () => { checks++; return status; };
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      let response;
      await host.routes.get('/plan-completion/replan')({
        url: '/plan-completion/replan', method,
        headers: { origin: 'https://attacker.invalid' },
        on() { throw Error('Untrusted body must not be read'); },
      }, {
        writeHead(code, headers) { response = { code, headers }; },
        end(body) { response.body = JSON.parse(body); },
      });
      assert.equal(response.code, status);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['access-control-allow-credentials'], undefined);
    }
    assert.equal(checks, 3);
    assert.equal(host.calls.length, 0);
  });
}

test('security: all registered endpoints, including debug endpoints, pass through admission', async t => {
  const host = setup(t, [], { enableDebugRoutes: true });
  delete host.services.connection;
  for (const [path, handler] of host.routes) {
    let code;
    await handler({ url: path, method: 'POST', headers: {}, on() { throw Error('body read'); } },
      { writeHead(value) { code = value; }, end() {} });
    assert.equal(code, 503, path);
  }
});

test('security: authenticated state request works without reflected CORS headers', async t => {
  const host = setup(t);
  const response = await host.request('/plan-completion/state?sessionId=fixture');
  assert.equal(response.status, 200);
  assert.equal(response.body.sessionId, 'fixture');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('security: diagnostics and all development routes are absent by default', t => {
  const host = setup(t);
  assert.deepEqual([...host.routes.keys()].sort(), [
    '/plan-completion/replan', '/plan-completion/state', '/plan-completion/warm',
  ]);
});

test('privacy: authenticated diagnostics retain layout only, not submitted content', async t => {
  const host = setup(t, [], { enableDebugRoutes: true });
  const secret = 'synthetic-private-draft-and-url';
  await host.request('/plan-completion/diag', {
    phase: 'dom-check', hasEntry: true, href: secret, text: secret,
    composerStyle: { text: secret, error: secret, left: 3, top: 4, w: 100, h: 20, display: 'flex' },
  });
  const response = await host.request('/plan-completion/diag');
  assert.equal(JSON.stringify(response.body).includes(secret), false);
  assert.equal(response.body.lastDiag.body.composerStyle.w, 100);
  assert.equal(response.body.lastDiag.body.hasEntry, true);
  assert.deepEqual(safeDiagnostics(null), {});
});

test('privacy: debug metadata omits raw errors, model text, URLs and configuration', () => {
  const secret = 'synthetic-private-token';
  const record = safeDebugRecord({
    phase: 'model-error', sessionId: secret, turn: 2, error: secret,
    textHead: secret, query: secret, ua: secret, config: { token: secret },
    body: { text: secret }, route: { provider: secret },
    usage: { inputTokens: 40, outputTokens: 8, authorization: secret },
  });
  assert.equal(JSON.stringify(record).includes(secret), false);
  assert.equal(record.error, true);
  assert.equal(record.turn, 2);
  assert.equal(record.sessionHash.length, 16);
  assert.deepEqual(record.usage, { inputTokens: 40, outputTokens: 8 });
});

test('privacy: actual runtime log never writes model response or raw config', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dpc-privacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secret = 'synthetic-private-content-XYZ';
  const host = setup(t, [secret, secret], { debugDir: dir, arbitrarySecret: secret });
  host.startTurn(sessionFixture('session-' + secret), 1);
  await flushJobs();
  const log = await readFile(join(dir, 'plan-completion-runtime.jsonl'), 'utf8');
  assert.equal(log.includes(secret), false);
  assert.ok(log.includes('parse-failed'));
});

test('privacy: automatic generations use only the current default route and do not cache old selection', async t => {
  const host = setup(t, [initialOutput(), patchOutput('s2', 'done')]);
  let selection = { provider: 'selected', model: 'reasoning' };
  host.services.agentDefaultModel.currentSelection = () => selection;
  host.services.llm.listProviders = () => { throw Error('Must not enumerate other providers'); };
  host.services.llm.resolveModelInfo = async () => ({ reasoning: { efforts: [{ id: 'low' }] } });
  const session = sessionFixture('route');
  host.startTurn(session, 1);
  await flushJobs();
  assert.equal(host.calls[0].provider, 'selected');
  assert.equal(host.calls[0].model, 'reasoning');
  selection = { provider: 'new-selection', model: 'new-model' };
  host.startTurn(session, 2);
  await flushJobs();
  assert.equal(host.calls[1].provider, 'new-selection');
  assert.equal(host.calls[1].model, 'new-model');
});

test('privacy: no selected route means heuristics, not an arbitrary provider fallback', async t => {
  const host = setup(t);
  host.services.agentDefaultModel.currentSelection = () => null;
  host.services.llm.listProviders = () => ['other-provider'];
  host.services.llm.listModels = () => [{ id: 'other-model' }];
  host.startTurn(sessionFixture('no-model'), 1);
  await flushJobs();
  assert.equal(host.calls.length, 0);
  assert.ok(host.state('no-model').plan);
});

test('privacy: modelCalls false disables this plugin LLM requests', async t => {
  const host = setup(t, [], { modelCalls: false });
  host.startTurn(sessionFixture('offline'), 1);
  await flushJobs();
  assert.equal(host.calls.length, 0);
  assert.ok(host.state('offline').suggestion);
});

test('security: reset clears storage and prevents an outstanding job resurrecting a plan', async t => {
  const pending = deferred();
  const host = setup(t, [initialOutput(), () => pending.promise, initialOutput()], { enableDebugRoutes: true });
  const session = sessionFixture('reset');
  host.startTurn(session, 1); await flushJobs();
  host.startTurn(session, 2); await waitFor(() => host.calls.length === 2);
  await host.request('/plan-completion/reset', { sessionId: session.id });
  assert.equal(host.state(session.id), undefined);
  assert.equal(globalThis[HOST_KEY].store.get(session.id), null);
  pending.resolve(patchOutput('s2', 'done')); await flushJobs();
  assert.equal(host.state(session.id), undefined);
  host.startTurn(session, 3); await flushJobs();
  assert.ok(host.state(session.id).plan);
});
