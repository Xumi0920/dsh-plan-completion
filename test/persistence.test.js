import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFileStore, createMemoryStore } from '../host/store.js';

function makePlan(sessionId, gen = 1, rev = 0, status = 'todo') {
  return {
    sessionId,
    version: { gen, rev },
    status: 'active',
    intent: 'fixture',
    steps: [
      { id: 's1', title: 'First', status: 'done' },
      { id: 's2', title: 'Second', status },
      { id: 's3', title: 'Third', status: 'todo' },
    ],
    updatedAt: 1700000000000,
    reason: 'fixture reason',
    watermark: { turn: 1, seq: 1 },
    editedByUser: false,
  };
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dpc-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('memory store: persists the latest suggestion next to the plan', () => {
  const store = createMemoryStore();
  const plan = makePlan('mem-1');
  assert.equal(store.put(plan, { cas: null, suggestion: { text: 'next', alternates: [] } }), true);

  const state = store.getState('mem-1');
  assert.deepEqual(state.plan.version, { gen: 1, rev: 0 });
  assert.equal(state.suggestion.text, 'next');

  // getState returns a clone: mutating it must not affect the store.
  state.plan.steps[1].status = 'done';
  assert.equal(store.getState('mem-1').plan.steps[1].status, 'todo');

  // A write without `suggestion` keeps the previous suggestion.
  const next = makePlan('mem-1', 1, 1, 'done');
  assert.equal(store.put(next, { cas: plan.version }), true);
  assert.equal(store.getState('mem-1').suggestion.text, 'next');

  assert.equal(store.put(makePlan('mem-1'), { cas: plan.version }), false, 'stale CAS must fail');
  assert.equal(store.clear('mem-1'), true);
  assert.equal(store.getState('mem-1'), null);
});

test('memory store: getState is null without a plan', () => {
  const store = createMemoryStore();
  assert.equal(store.getState('missing'), null);
  assert.equal(store.getState(''), null);
});

test('file store: plan and suggestion survive a new store instance (restart)', async t => {
  const dir = await tempDir(t);
  const first = createFileStore(dir);
  const plan = makePlan('file-1');
  assert.equal(await first.put(plan, { cas: null, suggestion: { text: 'next', alternates: ['alt'] } }), true);
  assert.equal(await first.put(plan, { cas: null }), false, 'only-new CAS must fail once stored');

  // Simulate a process restart: a brand new store over the same directory.
  const second = createFileStore(dir);
  const restored = await second.getState('file-1');
  assert.deepEqual(restored.plan.version, { gen: 1, rev: 0 });
  assert.equal(restored.suggestion.text, 'next');
  assert.deepEqual(restored.suggestion.alternates, ['alt']);

  // Patch-style update keeps the suggestion unless explicitly replaced.
  const patched = makePlan('file-1', 1, 1, 'done');
  assert.equal(await second.put(patched, { cas: plan.version }), true);
  assert.equal((await second.getState('file-1')).suggestion.text, 'next');
  assert.equal((await createFileStore(dir).getState('file-1')).plan.steps[1].status, 'done');
});

test('file store: clear removes the persisted session', async t => {
  const dir = await tempDir(t);
  const store = createFileStore(dir);
  await store.put(makePlan('file-2'), { cas: null, suggestion: { text: 'x' } });
  assert.equal(await store.clear('file-2'), true);
  assert.deepEqual(await createFileStore(dir).listSessions(), []);
  assert.equal(await createFileStore(dir).getState('file-2'), null);
});

test('file store: a corrupt record is tolerated (returns null, never throws)', async t => {
  const dir = await tempDir(t);
  const store = createFileStore(dir);
  await store.put(makePlan('file-3'), { cas: null, suggestion: { text: 'x' } });

  const files = await readdir(join(dir, 'plans'));
  assert.equal(files.length, 1);
  await writeFile(join(dir, 'plans', files[0]), '{not-json', 'utf8');

  const broken = createFileStore(dir);
  assert.equal(await broken.getState('file-3'), null);
  assert.equal(await broken.get('file-3'), null);
  assert.equal(typeof broken.lastError, 'string');
});

test('file store: disabled store is a safe no-op', async () => {
  const store = createFileStore('');
  assert.equal(store.enabled, false);
  assert.equal(await store.getState('x'), null);
  assert.equal(await store.put(makePlan('x'), { cas: null }), false);
  assert.deepEqual(await store.listSessions(), []);
});
