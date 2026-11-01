import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore, createFileStore } from '../host/store.js';

function makePlan(version, overrides = {}) {
  return {
    sessionId: 's1',
    version,
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

test('createMemoryStore：put/get 往返，返回副本（改副本不影响存储）', () => {
  const store = createMemoryStore();
  const plan = makePlan({ gen: 1, rev: 0 });
  assert.equal(store.put(plan), true);
  const got = store.get('s1');
  assert.deepEqual(got.version, { gen: 1, rev: 0 });
  got.steps[0].title = '被外部改了';
  assert.equal(store.get('s1').steps[0].title, '摸清路由与鉴权');
  assert.equal(store.get('nope'), null);
});

test('createMemoryStore：CAS —— null 仅新建、{gen,rev} 版本匹配、失配返回 false', () => {
  const store = createMemoryStore();
  assert.equal(store.put(makePlan({ gen: 0, rev: 0 }), { cas: null }), true);
  assert.equal(store.put(makePlan({ gen: 0, rev: 1 }), { cas: null }), false, '已存在时 cas:null 应失败');

  assert.equal(store.put(makePlan({ gen: 0, rev: 1 }), { cas: { gen: 0, rev: 0 } }), true);
  assert.equal(store.put(makePlan({ gen: 0, rev: 2 }), { cas: { gen: 0, rev: 0 } }), false, '过期 CAS 应失败');
  assert.equal(store.get('s1').version.rev, 1);

  assert.equal(store.put(makePlan({ gen: 0, rev: 2 }), { cas: { gen: 0, rev: 1 } }), true);
  assert.equal(store.put(makePlan({ gen: 1, rev: 0 })), true, '无条件写');
});

test('createMemoryStore：history / prune / clear / listSessions', () => {
  const store = createMemoryStore();
  for (let rev = 0; rev < 8; rev += 1) {
    store.put(makePlan({ gen: 1, rev }));
  }
  assert.equal(store.history('s1').length, 8);
  const pruned = store.prune(5);
  assert.equal(pruned.removed, 3);
  const history = store.history('s1');
  assert.equal(history.length, 5);
  assert.equal(history[history.length - 1].version.rev, 7, 'prune 保留最新版本');
  assert.equal(store.get('s1').version.rev, 7, '当前计划不受 prune 影响');

  assert.deepEqual(store.listSessions(), ['s1']);
  assert.equal(store.clear('s1'), true);
  assert.equal(store.get('s1'), null);
  assert.equal(store.clear('s1'), false);
});

test('createFileStore：异步往返 + CAS + history + prune + clear（原子写）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plan-store-'));
  const store = createFileStore(dir);
  try {
    assert.equal(store.enabled, true);
    assert.equal(await store.get('s1'), null);
    assert.equal(await store.put(makePlan({ gen: 0, rev: 0 }), { cas: null }), true);
    assert.equal(await store.put(makePlan({ gen: 0, rev: 1 }), { cas: null }), false);
    assert.equal(await store.put(makePlan({ gen: 0, rev: 1 }), { cas: { gen: 0, rev: 0 } }), true);

    const got = await store.get('s1');
    assert.deepEqual(got.version, { gen: 0, rev: 1 });
    got.steps[0].title = '外部修改';
    assert.equal((await store.get('s1')).steps[0].title, '摸清路由与鉴权');

    for (let rev = 2; rev < 8; rev += 1) await store.put(makePlan({ gen: 0, rev }));
    assert.equal((await store.history('s1')).length, 8);
    const pruned = await store.prune(5);
    assert.equal(pruned.removed, 3);
    assert.equal((await store.history('s1')).length, 5);

    // 中文 sessionId 也能安全落文件名并读回
    assert.equal(await store.put(makePlan({ gen: 0, rev: 0 }, { sessionId: '会话/一' })), true);
    assert.equal((await store.get('会话/一')).sessionId, '会话/一');
    assert.ok((await store.listSessions()).includes('会话/一'));

    assert.equal(await store.clear('s1'), true);
    assert.equal(await store.get('s1'), null);
    assert.deepEqual(await store.listSessions(), ['会话/一']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createFileStore：非法目录/非法计划返回 false/null，不抛异常', async () => {
  const store = createFileStore('');
  assert.equal(store.enabled, false);
  assert.equal(await store.get('s1'), null);
  assert.equal(await store.put(makePlan({ gen: 0, rev: 0 })), false);
  assert.deepEqual(await store.history('s1'), []);
  assert.deepEqual(await store.listSessions(), []);

  const dir = await mkdtemp(join(tmpdir(), 'dsh-plan-store-bad-'));
  try {
    const store2 = createFileStore(dir);
    assert.equal(await store2.put(null), false);
    assert.equal(await store2.put({ sessionId: 's1' }), false, '缺 version 应拒绝');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
