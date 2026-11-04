import http from 'node:http';
import https from 'node:https';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { collectRetrievalRecords, redactSecrets } from './rag-evidence.js';

const bounded = (v, d, min, max) => Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : d;
export function ragSettings(raw = {}) {
  return {
    enabled: raw?.enabled === true,
    sendContextToGenerator: raw?.sendContextToGenerator === true,
    endpoint: raw?.endpoint ?? 'http://127.0.0.1:11434/v1/embeddings',
    model: typeof raw?.model === 'string' ? raw.model.slice(0, 120) : 'dsh-qwen3-embedding:q8_0',
    apiKeyFile: typeof raw?.apiKeyFile === 'string' ? raw.apiKeyFile : '',
    dimensions: 1024,
    retrievalTimeoutMs: bounded(raw?.retrievalTimeoutMs, 250, 20, 1000),
    embeddingTimeoutMs: bounded(raw?.embeddingTimeoutMs, 5000, 50, 10000),
    maxRecords: bounded(raw?.maxRecords, 8192, 8, 32768),
    maxSessions: bounded(raw?.maxSessions, 4, 1, 16),
    ttlMs: bounded(raw?.ttlMs, 30 * 60 * 1000, 1000, 60 * 60 * 1000),
    chunkChars: bounded(raw?.chunkChars, 800, 200, 1200),
    topK: bounded(raw?.topK, 5, 1, 8),
    contextChars: bounded(raw?.contextChars, 1800, 200, 4000),
  };
}

export function localEmbeddingURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('invalid-local-embedding-endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/embeddings') {
    throw new Error('invalid-local-embedding-endpoint');
  }
  return url;
}

function normalized(vector, dimensions = 1024) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('invalid-embedding-response');
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error('invalid-embedding-response');
  return Float32Array.from(vector, v => v / norm);
}

/** Direct node transport deliberately ignores HTTP(S)_PROXY and refuses redirects. */
export function createEmbeddingClient(config) {
  const settings = ragSettings(config), url = localEmbeddingURL(settings.endpoint);
  const protocol = url.protocol === 'https:' ? https : http;
  const agent = new protocol.Agent({ keepAlive: true, maxSockets: 2 });
  let closed = false;
  return {
    async embed(texts, signal) {
      if (closed || signal?.aborted) throw new Error('embedding-cancelled');
      if (!Array.isArray(texts) || !texts.length || texts.length > 4 || texts.some(t => typeof t !== 'string' || t.length > 1600)) throw new Error('invalid-embedding-input');
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, settings.embeddingTimeoutMs);
      try {
        let key = '';
        if (settings.apiKeyFile) {
          if (!isAbsolute(settings.apiKeyFile)) throw new Error('invalid-key-file');
          const info = await stat(settings.apiKeyFile);
          if (!info.isFile() || info.size > 4096) throw new Error('invalid-key-file');
          key = (await readFile(settings.apiKeyFile, { encoding: 'utf8', signal: controller.signal })).trim();
          if (!key || /[\r\n]/.test(key)) throw new Error('invalid-key-file');
        }
        if (controller.signal.aborted || closed) throw new Error('embedding-cancelled');
        const body = Buffer.from(JSON.stringify({ model: settings.model, input: texts, encoding_format: 'float' }));
        return await new Promise((resolve, reject) => {
          const req = protocol.request(url, { method: 'POST', agent, signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...(key ? { Authorization: `Bearer ${key}` } : {}) } }, res => {
            if (res.statusCode !== 200) { res.destroy(); reject(new Error('embedding-unavailable')); return; }
            const chunks = []; let size = 0;
            res.on('data', chunk => {
              size += chunk.length;
              if (size > 1024 * 1024) { res.destroy(); reject(new Error('embedding-response-too-large')); }
              else chunks.push(chunk);
            });
            res.on('error', () => reject(new Error('embedding-unavailable')));
            res.on('end', () => {
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!Array.isArray(parsed.data) || parsed.data.length !== texts.length) throw new Error();
                const items = parsed.data.slice().sort((a, b) => a.index - b.index);
                if (items.some((x, i) => x.index !== i)) throw new Error();
                resolve(items.map(x => normalized(x.embedding, settings.dimensions)));
              } catch { reject(new Error('invalid-embedding-response')); }
            });
          });
          req.on('error', () => reject(new Error(controller.signal.aborted ? 'embedding-cancelled' : 'embedding-unavailable')));
          req.end(body);
        });
      } catch { throw new Error('local-embedding-unavailable'); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    close() { closed = true; agent.destroy(); },
  };
}

function terms(text) {
  const tokens = String(text).toLowerCase().match(/[a-z0-9_./-]+|[\p{Script=Han}]+/gu) ?? [];
  return new Set(tokens.flatMap(t => /\p{Script=Han}/u.test(t) && t.length > 1
    ? Array.from({ length: t.length - 1 }, (_, i) => t.slice(i, i + 2)) : [t]));
}
function lexical(query, text) {
  const q = terms(query), d = terms(text);
  let hits = 0; for (const t of q) if (d.has(t)) hits += 1;
  return hits / Math.sqrt(Math.max(1, q.size * d.size));
}
const digest = text => createHash('sha256').update(text).digest('hex');
const instruction = query => `Instruct: Given a user question, retrieve relevant conversation records or reasoning summaries that answer the question.\nQuery: ${query}`;

/** Apply-scoped, session-scoped, bounded RAM index. Never writes transcripts/vectors to disk. */
export function createRag(config = {}, dependencies = {}) {
  const settings = ragSettings(config), now = dependencies.now ?? Date.now, sessions = new Map();
  let closed = false, worker = null, client = null, invalidConfig = false, retryTimer = null;
  if (settings.enabled) {
    try { client = dependencies.client ?? createEmbeddingClient(settings); }
    catch { invalidConfig = true; }
  }
  const empty = mode => ({ mode, records: [], elapsedMs: 0, indexed: 0 });
  function forget(sessionId) {
    const state = sessions.get(sessionId);
    if (!state) return;
    sessions.delete(sessionId);
    for (const c of state.controllers) c.abort();
    state.records.clear(); state.queries.clear();
  }
  function sweep() {
    for (const [id, state] of sessions) if (now() - state.at > settings.ttlMs) forget(id);
  }
  const ttlTimer = settings.enabled ? setInterval(sweep, Math.min(settings.ttlMs, 60000)) : null;
  ttlTimer?.unref?.();
  async function work() {
    for (;;) {
      if (closed || !client) return;
      sweep();
      const pair = [...sessions].find(([, s]) => s.retries < 3 && now() >= s.retryAt && [...s.records.values()].some(r => !r.vector));
      if (!pair) return;
      const [id, state] = pair;
      const batch = [...state.records.values()].filter(r => !r.vector).slice(0, 4);
      const controller = new AbortController(); state.controllers.add(controller);
      try {
        const vectors = await client.embed(batch.map(r => r.text), controller.signal);
        if (closed || sessions.get(id) !== state || controller.signal.aborted) continue;
        for (let i = 0; i < batch.length; i++) {
          if (state.records.get(batch[i].id) === batch[i]) batch[i].vector = vectors[i];
        }
        state.error = false; state.retries = 0;
      } catch { if (sessions.get(id) === state) {
        state.error = true; state.retries++; state.retryAt = now() + 1000;
        if (!closed && state.retries < 3 && !retryTimer) { retryTimer = setTimeout(() => { retryTimer = null; schedule(); }, 1100); retryTimer.unref?.(); }
      } }
      finally { state.controllers.delete(controller); }
    }
  }
  function schedule() {
    if (worker || closed || !client) return;
    worker = Promise.resolve().then(work).finally(() => { worker = null; });
  }
  function sync(sessionId, events) {
    if (!settings.enabled || closed || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) return [];
    sweep();
    let state = sessions.get(sessionId);
    if (!state) {
      while (sessions.size >= settings.maxSessions) {
        const oldest = [...sessions].sort((a, b) => a[1].at - b[1].at)[0]; forget(oldest[0]);
      }
      state = { records: new Map(), queries: new Map(), controllers: new Set(), at: now(), retryAt: 0, retries: 0, error: false };
      sessions.set(sessionId, state);
    }
    const records = collectRetrievalRecords(sessionId, events, settings);
    const next = new Map(records.map(r => [r.id, state.records.get(r.id) ?? r]));
    // Same text can acquire a failure/interruption classification on turn/end.
    for (const r of records) Object.assign(next.get(r.id), r);
    if ([...next.keys()].join('|') !== [...state.records.keys()].join('|')) { state.queries.clear(); state.retries = 0; }
    state.records = next; state.at = now();
    schedule();
    return records;
  }
  async function retrieve(sessionId, query, { signal } = {}) {
    const started = now(); sweep();
    const state = sessions.get(sessionId);
    if (!settings.enabled || closed || !state || signal?.aborted) return empty('disabled');
    state.at = now();
    const text = redactSecrets(query).trim().slice(0, 1000);
    if (!text) return empty('empty');
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); state.controllers.add(controller);
    const timer = setTimeout(abort, settings.retrievalTimeoutMs);
    let vector = state.queries.get(digest(text)), mode = 'lexical';
    try {
      if (!vector && client && [...state.records.values()].some(r => r.vector)) {
        [vector] = await client.embed([instruction(text)], controller.signal);
        if (!controller.signal.aborted && sessions.get(sessionId) === state && !closed) {
          if (state.queries.size >= 16) state.queries.delete(state.queries.keys().next().value);
          state.queries.set(digest(text), vector);
        }
      }
      if (vector) mode = 'hybrid';
    } catch { mode = 'lexical'; }
    finally { clearTimeout(timer); state.controllers.delete(controller); signal?.removeEventListener('abort', abort); }
    if (closed || sessions.get(sessionId) !== state || signal?.aborted) return empty('cancelled');
    const candidates = [...state.records.values()];
    const ranks = new Map();
    const rankedLexical = candidates.map(r => [r, lexical(text, r.text)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
    // Equal-weight RRF gave every weak Chinese lexical hit two votes, drowning
    // out cross-language matches (English reasoning has no Chinese word overlap).
    // Cosine supplies the primary semantic score; lexical overlap is a bounded
    // bonus. Without a vector the same lexical scores remain the fallback.
    rankedLexical.forEach(([r, score]) => ranks.set(r.id, vector ? score * 0.25 : score));
    if (vector) {
      const semantic = candidates.filter(r => r.vector).map(r => [r, r.vector.reduce((sum, v, i) => sum + v * vector[i], 0)])
        .filter(([, s]) => s >= 0.2).sort((a, b) => b[1] - a[1]);
      semantic.forEach(([r, score]) => ranks.set(r.id, (ranks.get(r.id) ?? 0) + score));
    }
    let remaining = settings.contextChars;
    const records = candidates.filter(r => ranks.has(r.id)).sort((a, b) => ranks.get(b.id) - ranks.get(a.id) || b.seq - a.seq)
      .slice(0, settings.topK).flatMap(({ vector: _vector, ...r }) => {
        if (remaining <= 0) return [];
        const part = { ...r, text: r.text.slice(0, remaining) }; remaining -= part.text.length;
        return [part];
      });
    return { mode, records, elapsedMs: now() - started, indexed: candidates.filter(r => r.vector).length };
  }
  return {
    settings, sync, retrieve, forget,
    clear() { for (const id of [...sessions.keys()]) forget(id); },
    records(sessionId) { sweep(); return [...(sessions.get(sessionId)?.records.values() ?? [])].map(({ vector, ...r }) => ({ ...r })); },
    stats() { sweep(); return { enabled: settings.enabled, invalidConfig, sessions: sessions.size,
      records: [...sessions.values()].reduce((n, s) => n + s.records.size, 0),
      vectors: [...sessions.values()].reduce((n, s) => n + [...s.records.values()].filter(r => r.vector).length, 0) }; },
    async idle() { if (worker) await worker; },
    close() { closed = true; if (ttlTimer) clearInterval(ttlTimer); if (retryTimer) clearTimeout(retryTimer); for (const id of [...sessions.keys()]) forget(id); client?.close?.(); },
  };
}
