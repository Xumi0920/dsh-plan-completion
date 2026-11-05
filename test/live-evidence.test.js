import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceEvidence } from '../host/evidence-budget.js';
import { evidenceForModel } from '../host/legacy-prompt.js';
import { apply } from '../index.js';
import { createHostFixture, sessionFixture, flushJobs, initialOutput } from '../support/host-fixture.js';

test('automatic patch keeps new evidence when plan and receipt metadata exceed the narrative budget', () => {
  const evidence = {
    plan: { version: {gen: 1, rev: 0}, steps: Array.from({length: 7}, (_, i) => ({id: `s${i}`, title: 'Existing milestone '.repeat(8), status: 'doing'})) },
    lastAssistantText: 'Latest result: release completed. Next: monitor the new release.',
    lastUserMessages: ['Proceed with the release'],
    toolCalls: [{name: 'release', ok: true}], failedTools: [{name: 'old-check', error: 'failed'}],
    progressRecords: [{id: 'receipt', text: 'receipt metadata '.repeat(1500)}],
    progressProtocol: {version: 1, marker: 'preserve'},
    retrieval: {mode: 'hybrid', records: [{text: 'retrieved context '.repeat(100)}]},
    recentMessages: [{text: 'duplicate transcript '.repeat(200)}],
  };
  const original = structuredClone(evidence);
  const sliced = sliceEvidence(evidence, 1500);
  const payload = evidenceForModel(sliced);
  assert.match(payload.lastAssistantText, /release completed/);
  assert.equal(payload.toolCalls.length, 1);
  assert.equal(payload.failedTools.length, 1);
  assert.deepEqual(sliced.progressRecords, evidence.progressRecords);
  assert.deepEqual(sliced.progressProtocol, evidence.progressProtocol);
  assert.deepEqual(sliced.plan, evidence.plan);
  assert.deepEqual(evidence, original);
});

for (const protocol of ['legacy', 'strict']) test(`automatic ${protocol} request includes the latest answer after a tool-heavy turn`, async t => {
  const first = initialOutput();
  if (protocol === 'legacy') first.steps = first.steps.map(({acceptance, ...s}) => s);
  const host = createHostFixture(apply, [first, request => {
    const payload = JSON.parse(request.messages[0].content[0].text.match(/```json\s*([\s\S]*?)```/)[1]);
    if (!payload.lastAssistantText.includes('The stage has progressed')) return {op: 'none', progress: {version: 1, events: []}, reason: 'no new evidence', suggestion: 'Repeat the old step'};
    return {op: protocol === 'legacy' ? 'patch' : 'none', changes: [{id: 's2', status: 'done'}], progress: {version: 1, events: []}, reason: 'reviewed', suggestion: 'Monitor the release'};
  }], {persistPlans: false, progressProtocol: protocol});
  t.after(() => host.dispose());
  const session = sessionFixture('budget-' + protocol);
  host.startTurn(session, 1); await flushJobs();
  for (let i = 0; i < 12; i++) {
    session.events.push({type: 'tool/call', seq: 11 + i, data: {turn: 2, callId: 'c' + i, name: 'release-check', arguments: JSON.stringify({text: 'tool payload '.repeat(100)})}});
  }
  session.events.push({type: 'assistant/message', seq: 23, data: {turn: 2, step: 1, message: {role: 'assistant', content: [{type: 'text', text: 'The stage has progressed'}]}}});
  const end = {type: 'turn/end', seq: 24, time: Date.now(), data: {turn: 2, reason: {kind: 'completed'}}};
  session.events.push(end); session.seq = end.seq;
  host.handlers.get('session/event')(session, end); await flushJobs();
  const wire = host.calls[1].messages[0].content[0].text;
  const payload = JSON.parse(wire.match(/```json\s*([\s\S]*?)```/)[1]);
  assert.match(payload.lastAssistantText, /The stage has progressed/);
  assert.ok(payload.toolCalls.length > 0);
  if (protocol === 'strict') assert.ok(payload.progressRecords.length > 0);
  assert.equal(host.state(session.id).suggestion.text, 'Monitor the release');
  assert.equal(host.state(session.id).plan.steps[1].status, protocol === 'legacy' ? 'done' : 'todo');
});

test('long narrative retains the answer conclusion and latest failed tool without trimming acceptance data', () => {
  const evidence = {lastAssistantText: 'START ' + 'x'.repeat(3000) + ' RELEASE FAILED',
    lastUserMessages: ['old request', 'latest request'],
    toolCalls: Array.from({length: 12}, (_, i) => ({name: `tool-${i}`, ok: i !== 11})),
    failedTools: [{name: 'tool-11', error: 'release failed'}], progressRecords: [{receipt: 'x'.repeat(5000)}]};
  const sliced = sliceEvidence(evidence, 400);
  assert.match(sliced.lastAssistantText, /^START .* RELEASE FAILED$/);
  assert.equal(sliced.toolCalls.at(-1).name, 'tool-11');
  assert.equal(sliced.failedTools[0].error, 'release failed');
  assert.equal(sliced.lastUserMessages.at(-1), 'latest request');
  assert.deepEqual(sliced.progressRecords, evidence.progressRecords);
});
