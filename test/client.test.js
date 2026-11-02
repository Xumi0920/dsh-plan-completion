import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const original = fs.readFileSync(process.env.DSH_CLIENT_TEST_SOURCE || new URL('../client.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const marker = "    return {\n      inject: ['slots', 'locale'],";
assert.equal(original.split(marker).length, 2, 'client test seam must be unique');
const source = original.replace(marker,
  '    globalThis.__clientTest = { store, Dock, handleKeyDown, normalizePlan, fetchPlanState, warmPlanState, requestVerify, handlePlanFetch };\n' + marker);

function fixture() {
  let effects = [], refs = [], plugin;
  let timerId = 0;
  const writes = [], requests = [], timers = new Map();
  const secret = 'PRIVATE_DRAFT_AND_SUGGESTION_123';
  const card = {
    textContent: secret, style: {}, parentElement: null, isConnected: true,
    contains: () => false,
    getBoundingClientRect: () => ({top: 400, bottom: 430, left: 100, right: 700, width: 600, height: 30}),
  };
  const React = {
    Fragment: 'Fragment',
    createElement(type, props, ...children) {
      if (props?.ref) props.ref.current = { ...card };
      return {type, props: {...props, children}};
    },
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
    useRef(initial) { const ref = {current: initial}; refs.push(ref); return ref; },
    useEffect(effect) { effects.push(effect); },
  };
  const context = vm.createContext({
    console, Promise, Set, Date, Object, Array, Number, String, JSON, isFinite, isNaN,
    navigator: {language: 'zh-CN'},
    fetch(url, options) {
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      const entry = {url, options, respond(json, ok = true) { resolve({ok, json: async () => json}); }};
      requests.push(entry);
      return promise;
    },
    getComputedStyle: () => ({display: 'block', backgroundColor: 'white', borderTopWidth: '0', borderTopStyle: 'none', borderTopColor: 'white', borderTopLeftRadius: '0', boxShadow: 'none', fontSize: '14px', lineHeight: '20px'}),
    document: {
      body: {}, documentElement: {}, visibilityState: 'visible',
      querySelector: () => card, querySelectorAll: () => [],
      activeElement: {tagName: 'TEXTAREA', closest: selector => selector === '[data-composer-card]' ? card : null},
      addEventListener() {}, removeEventListener() {},
    },
    window: {
      location: {href: 'https://local.invalid/session/PRIVATE_SESSION_ID?token=PRIVATE_TOKEN'},
      __ModuleLoader__: {load(module) { plugin = module.factory(name => { assert.equal(name, 'react'); return React; }); }},
      setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
      clearTimeout(id) { timers.delete(id); },
      setInterval(fn) { timers.set(++timerId, fn); return timerId; },
      clearInterval(id) { timers.delete(id); },
      requestAnimationFrame: () => ++timerId, cancelAnimationFrame() {},
      addEventListener() {}, removeEventListener() {},
    },
  });
  vm.runInContext(source, context, {filename: 'client.js'});
  const api = context.__clientTest;
  return {
    api, requests, writes, secret,
    mount(sessionId = 'A') {
      effects = []; refs = [];
      const actions = {
        captureInsertion: () => sessionId,
        insertText(text, target) { writes.push({text, target}); return true; },
      };
      api.Dock({sessionId, inputActions: actions,
        useInput: selector => selector({draft: '', phase: 'plain'}),
        useSession: selector => selector({running: false})});
      const cleanups = effects.map(fn => fn()).filter(fn => typeof fn === 'function');
      const mountedRefs = refs.slice();
      return {actions, unmount() { for (const fn of cleanups.reverse()) fn(); for (const ref of mountedRefs) ref.current = null; }};
    },
    request(reason = 'poll', sessionId = 'A') {
      const pending = api.fetchPlanState(sessionId, reason, false).then(result => api.handlePlanFetch(sessionId, result));
      return {pending, wire: requests.at(-1)};
    },
    tab() {
      let prevented = false;
      api.handleKeyDown({key: 'Tab', defaultPrevented: false, isComposing: false,
        preventDefault() { prevented = true; }, stopPropagation() {}});
      return prevented;
    },
    diagnostics() {
      plugin.apply({effect: fn => fn(), get: () => null,
        locale: {register: () => () => {}, bind: () => null},
        slots: {inject() {}, register() {}}});
      return requests.filter(r => r.url === '/plan-completion/diag').map(r => JSON.parse(r.options.body));
    },
  };
}

const plan = (rev, suggestion = 'suggestion', sessionId = 'A', gen = 1) => ({
  sessionId, version: {gen, rev}, status: 'active', intent: 'Private session plan',
  steps: [{id: 's1', title: 'Work', status: 'doing'}], suggestion: {text: suggestion},
});
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Dock unmount removes private plan and stale composer actions; late state cannot restore them', async () => {
  const f = fixture(), dock = f.mount();
  const ready = f.request(); ready.wire.respond(plan(1)); await ready.pending;
  f.api.store.set({suggestionVisible: true});
  const late = f.request();
  dock.unmount();
  assert.equal(f.api.store.get().sessionId, undefined);
  assert.equal(f.api.store.get().plan, null);
  assert.equal(f.api.store.get().inputActions, null);
  assert.equal(f.tab(), false);
  assert.equal(f.writes.length, 0);
  late.wire.respond(plan(2)); await late.pending;
  assert.equal(f.api.store.get().plan, null);
});

test('an older Dock cleanup cannot clear the replacement Dock', async () => {
  const f = fixture(), first = f.mount('A'), second = f.mount('B');
  const ready = f.request('poll', 'B'); ready.wire.respond(plan(1, 'B suggestion', 'B')); await ready.pending;
  first.unmount();
  assert.equal(f.api.store.get().sessionId, 'B');
  assert.equal(f.api.store.get().plan.suggestion.text, 'B suggestion');
  assert.equal(f.api.store.get().inputActions, second.actions);
  second.unmount();
});

test('a detached Dock cannot handle Tab before its passive cleanup runs', async () => {
  const f = fixture(); f.mount();
  const ready = f.request(); ready.wire.respond(plan(1)); await ready.pending;
  f.api.store.set({suggestionVisible: true});
  assert.equal(f.tab(), true, 'the active Dock must still support normal completion');
  assert.equal(f.writes.length, 1);
  f.api.store.get().dockRoot.isConnected = false;
  assert.equal(f.tab(), false);
  assert.equal(f.writes.length, 1);
});

test('out-of-order state responses cannot replace a newer plan or suggestion', async () => {
  const f = fixture(); f.mount();
  const old = f.request('turn-end'), newer = f.request('popover');
  newer.wire.respond(plan(2, 'new')); await newer.pending;
  old.wire.respond(plan(1, 'old')); await old.pending;
  assert.equal(f.api.store.get().plan.version.rev, 2);
  assert.equal(f.api.store.get().plan.suggestion.text, 'new');
});

test('an old empty response cannot clear a newer plan', async () => {
  const f = fixture(); f.mount();
  const old = f.request(), newer = f.request('popover');
  newer.wire.respond(plan(2)); await newer.pending;
  old.wire.respond({sessionId: 'A', plan: null}); await old.pending;
  assert.equal(f.api.store.get().plan.version.rev, 2);
});

test('a current empty response clears state; old results cannot resurrect it and reset versions remain valid', async () => {
  const f = fixture(); f.mount();
  const ready = f.request(); ready.wire.respond(plan(9)); await ready.pending;
  const old = f.request(), reset = f.request('popover');
  reset.wire.respond({sessionId: 'A', plan: null}); await reset.pending;
  old.wire.respond(plan(10)); await old.pending;
  assert.equal(f.api.store.get().plan, null);
  const rebuilt = f.request(); rebuilt.wire.respond(plan(0, 'rebuilt', 'A', 0)); await rebuilt.pending;
  assert.equal(f.api.store.get().plan.version.gen, 0);
  assert.equal(f.api.store.get().plan.suggestion.text, 'rebuilt');
});

test('newer responses may refine suggestions without incrementing the plan version', async () => {
  const f = fixture(); f.mount();
  const first = f.request(); first.wire.respond(plan(1, 'heuristic')); await first.pending;
  const next = f.request('turn-end'); next.wire.respond(plan(1, 'model suggestion')); await next.pending;
  assert.equal(f.api.store.get().plan.suggestion.text, 'model suggestion');
});

test('A to B to A switching rejects responses from the previous A lifecycle', async () => {
  const f = fixture(), first = f.mount('A');
  const old = f.request(); first.unmount();
  f.mount('B').unmount(); f.mount('A');
  old.wire.respond(plan(9, 'old A')); await old.pending;
  assert.equal(f.api.store.get().plan, null);
});

test('warm backfill shares response ordering with state refreshes', async () => {
  const f = fixture(); f.mount();
  const initial = f.requests.find(r => r.url.includes('/state?'));
  initial.respond({sessionId: 'A', plan: null}); await flush();
  const warm = f.requests.find(r => r.url === '/plan-completion/warm');
  assert.ok(warm, 'mount must use the actual warm callback');
  const fresh = f.request('stale-poll'); fresh.wire.respond(plan(2, 'fresh')); await fresh.pending;
  warm.respond({...plan(1, 'old warm'), ok: true}); await flush();
  assert.equal(f.api.store.get().plan.version.rev, 2);
  assert.equal(f.api.store.get().plan.suggestion.text, 'fresh');
});

test('a successful warm backfill applies its returned plan', async () => {
  const f = fixture(); f.mount();
  f.requests.find(r => r.url.includes('/state?')).respond({sessionId: 'A', plan: null});
  await flush();
  f.requests.find(r => r.url === '/plan-completion/warm').respond({...plan(0, 'warm result'), ok: true});
  await flush();
  assert.equal(f.api.store.get().plan.suggestion.text, 'warm result');
});

test('verify request posts the session id and returns the host verdict', async () => {
  const f = fixture();
  const pending = f.api.requestVerify('A');
  const wire = f.requests.find(r => r.url === '/plan-completion/verify');
  assert.ok(wire, 'must POST /plan-completion/verify');
  assert.equal(wire.options.method, 'POST');
  assert.deepEqual(JSON.parse(wire.options.body), {sessionId: 'A'});
  wire.respond({ok: true, assessment: 'looks good', mismatches: [{stepId: 's1', issue: 'stale'}], suggestion: 'ship it'});
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.suggestion, 'ship it');
  assert.equal(result.mismatches.length, 1);

  const failed = f.api.requestVerify('A');
  f.requests.at(-1).respond({}, false);
  assert.equal(await failed, null);
  assert.equal(await f.api.requestVerify(''), null);
});

test('a same-session remount owns state even if the old Dock is cleaned up later', async () => {
  const f = fixture(), first = f.mount();
  const old = f.request();
  const second = f.mount();
  const next = f.request(); next.wire.respond(plan(1, 'replacement')); await next.pending;
  first.unmount();
  old.wire.respond(plan(9, 'old lifetime')); await old.pending;
  assert.equal(f.api.store.get().plan.suggestion.text, 'replacement');
  assert.equal(f.api.store.get().inputActions, second.actions);
});

test('diagnostics contain no composer content, suggestion text, or location', () => {
  const f = fixture();
  const payloads = f.diagnostics();
  assert.ok(payloads.length > 0);
  const serialized = JSON.stringify(payloads);
  assert.equal(serialized.includes(f.secret), false);
  assert.equal(serialized.includes('PRIVATE_SESSION_ID'), false);
  assert.equal(serialized.includes('PRIVATE_TOKEN'), false);
  assert.equal(serialized.includes('href'), false);
});
