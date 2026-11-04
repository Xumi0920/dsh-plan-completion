import { redactSecrets } from './rag-evidence.js';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
export function normalizeCompletion(value) {
  if (value && own(value, 'all')) {
    if (!Array.isArray(value.all) || value.all.length < 2 || value.all.length > 6 || own(value, 'tool')) return undefined;
    const all = value.all.map(v => v && !own(v, 'all') ? normalizeCompletion(v) : undefined);
    if (all.some(v => !v) || new Set(all.map(v => JSON.stringify([v.tool, Object.entries(v.args).sort()]))).size !== all.length) return undefined;
    return { all };
  }
  if (!value || typeof value.tool !== 'string' || !value.tool.trim() || !value.args || typeof value.args !== 'object' || Array.isArray(value.args)) return undefined;
  const pairs = Object.entries(value.args);
  if (!pairs.length || pairs.length > 6 || pairs.some(([k, v]) => ['__proto__', 'constructor', 'prototype'].includes(k) || k.length > 80 || !['string', 'number', 'boolean'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v)) || String(v).length > 400
    || /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)$/i.test(k)
    || redactSecrets(String(v)) !== String(v) || /\[REDACTED/.test(String(v)))) return undefined;
  const result = { tool: value.tool.trim().slice(0, 80), args: Object.fromEntries(pairs.map(([k, v]) => [k, typeof v === 'string' ? redactSecrets(v) : v])) };
  if (own(value, 'expect')) {
    const e = value.expect;
    if (!e || typeof e.field !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(e.field) || ['__proto__','constructor','prototype'].includes(e.field)
      || !['string','number','boolean'].includes(typeof e.equals) || (typeof e.equals === 'number' && !Number.isFinite(e.equals))
      || String(e.equals).length > 400 || redactSecrets(String(e.equals)) !== String(e.equals) || /\[REDACTED/.test(String(e.equals))) return undefined;
    result.expect = { field: e.field, equals: e.equals };
  }
  return result;
}
export function completionRequirements(value) {
  const normalized = normalizeCompletion(value);
  return normalized ? normalized.all ?? [normalized] : [];
}
// Conservative migration guard: an old single receipt must not certify a
// multi-action title. Ambiguous wording stays pending until split or reviewed.
export function isCompoundTitle(title = '') {
  return /(?<!合)并(?!发)|以及|然后|之后|再|且|同时|[、;；+]|\b(?:and|then|followed by)\b/i.test(title)
    || /(?:写入|写|修改|write|edit).*(?:回读|读取|读回|read\s*back|readback|测试|test|验证|校验)/i.test(title);
}
export function normalizeConstraints(value) {
  return Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string').map(v => redactSecrets(v).replace(/\s+/g, ' ').trim().slice(0, 160)).filter(Boolean))].slice(0, 6) : [];
}
export function matchesCall(call, contract) {
  return contract && call.tool === contract.tool && Object.entries(contract.args).every(([k, v]) => own(call.args ?? {}, k) && call.args[k] === v);
}

// Transport acknowledgement alone has no business acceptance scope. A step
// whose actual goal IS submission may explicitly expect accepted=true; a
// delivery step must instead assert its own delivered/readback fact.
export function unscopedAcknowledgement(receipt, requirement) {
  if (requirement?.expect) return false;
  const facts = receipt?.facts ?? {};
  return facts.accepted === true || ['accepted', 'submitted'].includes(facts.status)
    || ['accepted', 'submitted'].includes(facts.state);
}

