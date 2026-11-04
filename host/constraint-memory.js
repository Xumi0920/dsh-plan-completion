import { createHash } from 'node:crypto';
import { isGeneratedUserMessage } from './event-source.js';
import { redactSecrets } from './rag-evidence.js';

// A bounded source ledger, separate from the FIFO vector index and its top-K.
// This is conservative cue extraction, not semantic resolution of permissions.
const cue = /关键约束|硬约束|约束[:：]|必须|禁止|不得|不允许|不要|不能|仅(?:限|在|可)|只(?:能|在|操作|读|允许|讨论|生成)|保留|不(?:写|改|修改|执行|触碰|合并|上传|发送|删除)|撤销|取消|改为|允许|\b(?:must|never|only|do not|don't|constraint|revoke|instead|allow)\b/i;
export const CONSTRAINT_LIMITS = Object.freeze({ records: 24, chars: 6000, clauseChars: 400 });

export function collectConstraintAnchors(sessionId, events) {
  const kept = new Map(); let first = true, omitted = 0, truncated = 0, size = 0;
  function add(e, text) {
    const full = text.trim(); if (!full) return;
    const cueAt = full.search(cue);
    const at = full.length > CONSTRAINT_LIMITS.clauseChars ? Math.max(0, cueAt - 80) : 0;
    const part = full.slice(at, at + CONSTRAINT_LIMITS.clauseChars);
    if (full.length > part.length) truncated++;
    if (kept.has(part)) { size -= kept.get(part).text.length; kept.delete(part); }
    const id = 'constraint:' + createHash('sha256').update(JSON.stringify([sessionId, e.seq, part])).digest('hex').slice(0, 24);
    kept.set(part, { id, sessionId, seq: e.seq, kind: 'user_constraint', text: part, completionEligible: false }); size += part.length;
    while (kept.size > CONSTRAINT_LIMITS.records || size > CONSTRAINT_LIMITS.chars) {
      // Keep the earliest eight anchors plus the newest amendments. Overflow
      // is surfaced to the user and generator rather than silently claiming recall.
      const key = [...kept.keys()][Math.min(8, kept.size - 2)];
      size -= kept.get(key).text.length; kept.delete(key); omitted++;
    }
  }
  for (const e of events.filter(e => Number.isInteger(e?.seq) && e.seq >= 0).slice().sort((a, b) => a.seq - b.seq)) {
    if (e.type !== 'user/message' || isGeneratedUserMessage(e)) continue;
    const content = e.data?.content;
    const text = redactSecrets(typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n') : '');
    let matched = false;
    for (const match of text.matchAll(/[^\n。！？;；]+[。！？;；]?/gu)) {
      if (cue.test(match[0])) { add(e, match[0]); matched = true; }
    }
    if (first && !matched && text.trim()) add(e, text);
    if (text.trim()) first = false;
  }
  return { records: [...kept.values()].sort((a, b) => a.seq - b.seq), omitted, truncated, incomplete: omitted > 0 || truncated > 0 };
}
