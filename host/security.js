import { createHash } from 'node:crypto';

// DSH owns Host/Origin checking and cookie/API-peer authentication.
// Fail closed during service startup/shutdown and with incompatible hosts.
export function requestRejection(connection, req) {
  try {
    if (typeof connection?.requestRejection !== 'function') return 503;
    const rejection = connection.requestRejection(req);
    if (rejection === undefined) return undefined;
    return rejection === 401 || rejection === 403 ? rejection : 503;
  } catch {
    return 503;
  }
}

const numberKeys = new Set(['turn', 'seq', 'elapsed', 'elapsedMs', 'events', 'maxTokens',
  'textChars', 'total', 'index', 'stepCount', 'at', 'fullEvidenceChars']);
const booleanKeys = new Set(['force', 'ok', 'hasSuggestion', 'suggestion',
  'withinSuggestionDeadline', 'existed', 'cookie']);
const labelKeys = new Set(['phase', 'outcome', 'step', 'source', 'method', 'mode', 'type', 'code']);

// Keep operational metadata only. Raw errors, model text, config, URLs, user agent,
// request bodies and model/provider details may contain conversation data or credentials.
export function safeDebugRecord(record = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(record)) {
    if (numberKeys.has(key) && Number.isFinite(value)) safe[key] = value;
    else if (booleanKeys.has(key) && typeof value === 'boolean') safe[key] = value;
    else if (labelKeys.has(key) && typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,80}$/.test(value)) safe[key] = value;
  }
  if (typeof record.sessionId === 'string' && record.sessionId) {
    safe.sessionHash = createHash('sha256').update(record.sessionId).digest('hex').slice(0, 16);
  }
  if (record.error !== undefined) safe.error = true;
  if (record.usage && typeof record.usage === 'object') {
    safe.usage = Object.fromEntries(Object.entries(record.usage)
      .filter(([key, value]) => /^(input|output|total|prompt|completion|cached|reasoning)(Tokens|_tokens)$/.test(key)
        && Number.isFinite(value) && value >= 0));
  }
  return safe;
}

// Browser diagnostics are untrusted input, including with a valid DSH cookie.
// Retain only layout dimensions/booleans, never arbitrary DOM text or URLs.
export function safeDiagnostics(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = {};
  for (const key of ['hasPill', 'hasEntry', 'suggestVisible', 'dockPresent', 'heroVisible']) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  if (['module-load', 'dom-check'].includes(source.phase)) result.phase = source.phase;
  if (typeof source.build === 'string' && /^[a-zA-Z0-9._:-]{1,80}$/.test(source.build)) result.build = source.build;
  if (Number.isFinite(source.rowHeight)) result.rowHeight = source.rowHeight;
  for (const key of ['heroStyle', 'rowStyle', 'suggestStyle', 'entryStyle', 'composerStyle']) {
    const style = source[key];
    if (!style || typeof style !== 'object') continue;
    result[key] = {};
    for (const dimension of ['left', 'top', 'w', 'h']) {
      if (Number.isFinite(style[dimension])) result[key][dimension] = style[dimension];
    }
    if (['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'contents'].includes(style.display)) {
      result[key].display = style.display;
    }
  }
  return result;
}
