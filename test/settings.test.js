import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';
import { HOST_KEY, createHostFixture } from '../support/host-fixture.js';
import { expandStorageDir } from '../host/settings.js';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

test('default storage follows isolated DSH_HOME without importing the shared legacy directory', () => {
  const isolated=join(tmpdir(),'synthetic-dsh-home');
  assert.equal(expandStorageDir('~/.dsh/plan-completion-data',undefined,isolated),join(resolve(isolated),'plan-completion-data'));
  assert.equal(expandStorageDir('~/.dsh/plan-completion-data',undefined,''),join(homedir(),'.dsh/plan-completion-data'));
  assert.equal(expandStorageDir(join(tmpdir(),'explicit-plan-store'),undefined,isolated),join(tmpdir(),'explicit-plan-store'));
  assert.equal(expandStorageDir('',undefined,isolated),'');
});

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dpc-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function boot(t, dir) {
  delete globalThis[HOST_KEY];
  const host = createHostFixture(apply, [], { persistPlans: false, warmBackfill: false, storageDir: dir });
  t.after(() => {
    host.dispose();
    delete globalThis[HOST_KEY];
  });
  return host;
}

test('settings: defaults follow host model and persist changes to settings.json', async t => {
  const dir = await tempDir(t);
  const host = boot(t, dir);

  const initial = await host.request('/plan-completion/settings');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.ok, true);
  assert.equal(initial.body.settings.modelPolicy, 'default');
  assert.equal(initial.body.settings.modelCalls, true);
  assert.equal(initial.body.settings.defaultSelection.provider, 'fixture');

  const updated = await host.request('/plan-completion/settings', {
    modelPolicy: 'fixed',
    fixedProvider: 'fixture',
    fixedModel: 'fixture-model',
    modelCalls: false,
  });
  assert.equal(updated.body.ok, true);
  assert.equal(updated.body.saved, true);
  assert.equal(updated.body.settings.modelPolicy, 'fixed');
  assert.equal(updated.body.settings.fixedModel, 'fixture-model');
  assert.equal(updated.body.settings.modelCalls, false);

  const onDisk = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
  assert.equal(onDisk.modelPolicy, 'fixed');
  assert.equal(onDisk.modelCalls, false);

  const reread = await host.request('/plan-completion/settings');
  assert.equal(reread.body.settings.modelPolicy, 'fixed');
  assert.equal(reread.body.settings.fixedProvider, 'fixture');
});

test('settings: survives a restart with the same storage directory', async t => {
  const dir = await tempDir(t);
  const first = boot(t, dir);
  await first.request('/plan-completion/settings', { modelPolicy: 'auto' });
  first.dispose();
  delete globalThis[HOST_KEY];

  const second = boot(t, dir);
  const restored = await second.request('/plan-completion/settings');
  assert.equal(restored.body.settings.modelPolicy, 'auto');
});

test('settings: invalid policy and fixed policy without a route are rejected', async t => {
  const dir = await tempDir(t);
  const host = boot(t, dir);

  const badPolicy = await host.request('/plan-completion/settings', { modelPolicy: 'whatever' });
  assert.equal(badPolicy.body.ok, false);
  assert.equal(badPolicy.body.error, 'bad-model-policy');

  const missingRoute = await host.request('/plan-completion/settings', { modelPolicy: 'fixed' });
  assert.equal(missingRoute.body.ok, false);
  assert.equal(missingRoute.body.error, 'missing-fixed-route');

  const unchanged = await host.request('/plan-completion/settings');
  assert.equal(unchanged.body.settings.modelPolicy, 'default');
});
