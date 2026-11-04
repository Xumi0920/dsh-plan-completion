import { EventEmitter } from 'node:events';

export const HOST_KEY = '__dsh_plan_completion_host__';
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function flushJobs() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}
export async function waitFor(predicate, label = 'condition') {
  for (let i = 0; i < 100; i++) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
export function initialOutput() {
  return {
    progress: { version: 1, events: [] }, op: 'rewrite', reason: 'Initial plan', intent: 'Build the fixture',
    steps: [
      { id: 's1', title: 'Inspect requirements', status: 'done', acceptance: { scope: 'manual', dependsOn: [] } },
      { id: 's2', title: 'Implement changes', status: 'todo', acceptance: { scope: 'manual', dependsOn: [] } },
      { id: 's3', title: 'Verify changes', status: 'todo', acceptance: { scope: 'manual', dependsOn: [] } },
    ], suggestion: 'Implement the next step',
  };
}
export function patchOutput(id, status) {
  return { progress: { version: 1, events: [] }, op: 'patch', reason: 'Progress recorded', changes: [{ id, status }], suggestion: 'Verify the next step' };
}

/** Real apply() receives mocked host services; no sockets or model calls are used. */
export function createHostFixture(apply, responses, config = {}) {
  const handlers = new Map(), routes = new Map(), cleanups = [], calls = [];
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    connection: { requestRejection: () => undefined },
    llm: {
      listProviders: () => [],
      resolveModelInfo: async () => ({ reasoning: false }),
      async *stream(request) {
        const response = responses.shift();
        calls.push(request);
        if (response === undefined) throw new Error('Unexpected model call');
        const value = typeof response === 'function' ? await response(request) : response;
        yield { type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) };
      },
    },
    webServer: {
      register: ({ path, handler }) => {
        routes.set(path, handler);
        return () => { if (routes.get(path) === handler) routes.delete(path); };
      },
    },
  };
  const ctx = {
    get: name => services[name],
    provide: (name, value) => { services[name] = value },
    on: (name, fn) => handlers.set(name, fn),
    effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
    inject: (_deps, fn) => fn({ ...services, effect: ctx.effect, get: ctx.get }),
  };
  const core = apply(ctx, { warmBackfill: false, progressProtocol: 'strict', ...config });
  globalThis[HOST_KEY] = core
  return {
    calls, ctx, services, handlers, routes,
    core, state: id => core.states.get(id),
    dispose() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); handlers.clear(); },
    startTurn(session, turn) {
      const seq = turn * 10;
      session.events.push(
        { type: 'user/message', seq: seq - 2, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text: 'Continue the next stage' }] } },
        { type: 'assistant/message', seq: seq - 1, time: Date.now(), data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'The stage has progressed' }] } } },
      );
      const end = { type: 'turn/end', seq, time: Date.now(), data: { turn, reason: { kind: 'completed' } } };
      session.events.push(end); session.seq = seq;
      handlers.get('session/event')(session, end);
    },
    async request(path, body) {
      const req = new EventEmitter();
      req.url = path; req.method = body === undefined ? 'GET' : 'POST';
      req.headers = { host: '127.0.0.1:39001', origin: 'http://127.0.0.1:39001', 'content-type': 'application/json' };
      req.socket = { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1', localPort: 39001 };
      req.destroy = () => {};
      const response = { status: null, headers: null, body: null };
      const route = routes.get(path.split('?')[0]);
      if (!route) throw new Error(`Missing fixture route: ${path}`);
      const running = route(req, {
        writeHead(status, headers) { response.status = status; response.headers = headers; },
        end(value) { response.body = value ? JSON.parse(value) : null; },
      });
      if (body !== undefined) {
        await flushJobs();
        req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end');
      }
      await running;
      return response;
    },
  };
}
export function sessionFixture(id) {
  return { id, seq: 0, events: [], snapshotEvents(from) { return this.events.filter(event => event.seq >= from); } };
}

// Explicit synthetic output factory for host tests. Tests of malformed model
// output deliberately bypass this helper.
export function protocolOutput(value) {
  return { ...value, progress: value.progress ?? { version: 1, events: [] },
    ...(value.op === 'rewrite' ? { steps: value.steps.map(s => ({ ...s,
      acceptance: s.acceptance ?? { scope: s.completion ? 'execution' : 'manual', dependsOn: [] },
    })) } : {}) }
}
