import { createHash } from 'node:crypto';
import { isCompactionCheckpoint, isGeneratedUserMessage, isDerivedToolResult } from './event-source.js';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

// Best-effort credential minimization, not a general PII anonymizer. Apply before
// chunking, embedding, caching or forwarding any newly retrieved material.
export function redactSecrets(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|(?:ghp|github_pat|hf)_[A-Za-z0-9_]{16,})\b/g, '[REDACTED TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie|密码|密钥)\s*["']?\s*[:=]\s*)["']?[^\s,"';}]+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|key|secret|password|signature)=)[^&#\s]+/gi, '$1[REDACTED]');
}

export function redactData(value) {
  return JSON.parse(JSON.stringify(value, (key, item) =>
    /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)$/i.test(key)
      ? '[REDACTED]' : typeof item === 'string' ? redactSecrets(item) : item));
}

function blocks(message, kind) {
  if (typeof message === 'string') return kind === 'text' ? message : '';
  const content = Array.isArray(message) ? message : message?.content;
  if (typeof content === 'string') return kind === 'text' ? content : '';
  return Array.isArray(content) ? content.filter(b => b?.type === kind)
    .map(b => typeof b.text === 'string' ? b.text : kind === 'reasoning' && typeof b.reasoning === 'string' ? b.reasoning : '').join('\n') : '';
}

function resultStatus(data, text) {
  const message = data.message ?? {};
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* ordinary text result */ }
  const values = [data, message, data.result, data.output, parsed].filter(object);
  const exit = values.map(v => v.exitCode ?? v.exit_code).find(Number.isFinite);
  const failed = values.some(v => v.isError === true || v.ok === false || v.success === false || v.error != null)
    || (exit !== undefined && exit !== 0)
    || /(?:exited? (?:with )?(?:exit )?code|exit[_ ]code)\s*[:=]?\s*[1-9]\d*\b|\b[1-9]\d* (?:tests? failed|failures)\b/i.test(text);
  if (failed) return 'failure';
  if (values.some(v => v.dryRun === true || v.executed === false || v.simulated === true)) return 'unknown';
  if (/session (?:id|ID)|still running|in progress|pending|仍在运行|等待回执/i.test(text) && exit === undefined) return 'unknown';
  return exit === 0 || values.some(v => v.ok === true || v.success === true || v.isError === false)
    || /(?:exit(?:ed)? (?:with )?(?:exit )?code|exit[_ ]code)\s*[:=]?\s*0\b/i.test(text) ? 'success' : 'unknown';
}

/** Only committed DSH event types are accepted; assistant prose cannot forge a tool result. */
export function collectRetrievalRecords(sessionId, events, { chunkChars = 800, maxRecords = 8192 } = {}) {
  if (!sessionId || !Array.isArray(events)) return [];
  const sorted = events.filter(e => Number.isInteger(e?.seq) && e.seq >= 0).slice().sort((a, b) => a.seq - b.seq);
  const calls = new Map(), incompleteTurns = new Set(), records = [];
  let turn = 0;
  for (const e of sorted) if (e.type === 'turn/end' && e.data?.reason?.kind !== 'completed') incompleteTurns.add(e.data?.turn);
  function add(event, kind, text, extra = {}) {
    const cleaned = redactSecrets(text).trim().slice(0, kind.startsWith('tool_') ? chunkChars : chunkChars * maxRecords);
    for (let at = 0; at < cleaned.length; at += chunkChars) {
      const part = cleaned.slice(at, at + chunkChars);
      const id = 'rag:' + hash(JSON.stringify([sessionId, event.seq, kind, at, part]));
      records.push({ id, sessionId, seq: event.seq, turn, kind, text: part, completionEligible: false, ...extra });
    }
  }
  for (const e of sorted) {
    // A pruned surface copy is not a second execution result. Its abbreviated
    // content can omit the original exit code; retain the raw receipt instead.
    if (isDerivedToolResult(e)) continue;
    const d = object(e.data) ? e.data : {};
    if (Number.isInteger(d.turn)) turn = d.turn;
    if (e.type === 'user/message') add(e, isCompactionCheckpoint(e) ? 'compaction_summary' : isGeneratedUserMessage(e) ? 'context_record' : 'user_message', blocks(d, 'text'));
    if (e.type === 'assistant/message') {
      add(e, 'assistant_claim', blocks(d.message, 'text'));
      add(e, 'reasoning_intent', blocks(d.message, 'reasoning'));
    }
    if (e.type === 'tool/call' && typeof d.callId === 'string') {
      let args = d.arguments ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
      try { args = JSON.stringify(args).length <= 4000 ? redactData(args) : {}; } catch { args = {}; }
      const call = { tool: String(d.name ?? 'tool').slice(0, 80), callId: d.callId, seq: e.seq, args,
        interrupted: incompleteTurns.has(turn) };
      // Ambiguous duplicate IDs cannot establish a trusted receipt.
      const key = `${turn}:${d.callId}`;
      if (calls.has(key)) calls.set(key, null); else calls.set(key, call);
      add(e, 'tool_call', `Tool: ${call.tool}\nArguments: ${JSON.stringify(args)}`, call);
    }
    if (e.type === 'tool/result') {
      const callId = d.message?.toolCallId ?? d.message?.source?.callId ?? d.callId;
      const call = calls.get(`${turn}:${callId}`);
      const text = blocks(d.message ?? d.content, 'text');
      const outcome = resultStatus(d, text);
      add(e, 'tool_result', `Tool: ${call?.tool ?? 'unmatched-tool'}\nResult: ${text}`, {
        tool: call?.tool ?? 'unmatched-tool', callSeq: call?.seq, callId, outcome,
        completionEligible: Boolean(call && call.seq < e.seq && outcome === 'success' && !incompleteTurns.has(turn)),
      });
    }
  }
  return records.slice(-maxRecords);
}

