/**
 * host/text.js — 文本清洗与安全过滤工具（纯函数，零依赖）。
 *
 * 主要用途：
 *  - suggestion 文本规范化：单行、去 Markdown、≤40 字、可直接发送；
 *  - 危险建议过滤：明显破坏性命令一律拦掉（设计 §3.6 护栏 4、§3.8「危险建议过滤」）；
 *  - 提问回合识别（启发式与证据共用）。
 */

import { DEFAULTS } from './config.js';

/**
 * 把任意值安全地转成字符串（只接受基础类型，对象/数组返回 ''）。
 * @param {unknown} value
 * @returns {string}
 */
export function toText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * 按「字符（code point）」截断，不会切断 surrogate pair。
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function clampChars(value, max) {
  const text = toText(value);
  const limit = Number.isFinite(max) ? Math.floor(max) : 0;
  if (limit <= 0) return '';
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit).join('');
}

/**
 * 折叠为单行：换行/制表 → 空格，压缩连续空白，trim。
 * @param {unknown} value
 * @returns {string}
 */
export function oneLine(value) {
  return toText(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const MD_LINE_PREFIX = /^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/;
const MD_INLINE = /(\*\*|__|\*|_|`)/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const WRAPPING_QUOTES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g;

/**
 * 去掉常见 Markdown 痕迹，得到适合直接发送的纯文本。
 * @param {unknown} value
 * @returns {string}
 */
export function stripMarkdown(value) {
  let text = toText(value);
  text = text.replace(/```[a-zA-Z0-9_+-]*/g, ' ');
  text = text
    .split(/\r?\n/)
    .map((line) => line.replace(MD_LINE_PREFIX, ''))
    .join(' ');
  text = text.replace(MD_LINK, '$1');
  text = text.replace(MD_INLINE, '');
  return oneLine(text).replace(WRAPPING_QUOTES, '').trim();
}

/**
 * 建议文本规范化：单行 + 去 Markdown + 截断到 max 字。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function clampSuggestion(value, max = DEFAULTS.suggestionMaxChars) {
  return clampChars(stripMarkdown(value), max);
}

/**
 * 明显破坏性命令形态（设计 §3.6 护栏 4、§3.8 危险建议过滤）。
 * 只拦「明显」形态，避免误伤正常开发建议。
 * @type {ReadonlyArray<{name: string, re: RegExp}>}
 */
export const DANGEROUS_PATTERNS = Object.freeze([
  { name: 'rm-recursive-force', re: /(?:^|[\s;|&])rm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/ },
  { name: 'windows-del-force', re: /\b(?:del|erase)\s+\/[fsq]/i },
  { name: 'windows-rmdir-force', re: /\brmdir\s+\/s/i },
  { name: 'format-drive', re: /\bformat\s+[a-z]:/i },
  { name: 'mkfs', re: /\bmkfs(?:\.\w+)?\b/i },
  { name: 'dd-write', re: /\bdd\s+if=/i },
  { name: 'git-reset-hard', re: /\bgit\s+reset\s+--hard\b/i },
  { name: 'git-clean-force', re: /\bgit\s+clean\s+-[a-z]*f/i },
  { name: 'shutdown-reboot', re: /\b(?:shutdown|reboot)\b/i },
  { name: 'drop-database', re: /\bdrop\s+(?:database|table)\b/i },
  { name: 'curl-pipe-shell', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|d)?sh\b/i },
  { name: 'powershell-remove-recurse', re: /remove-item\b[^\n]*-recurse/i },
  { name: 'powershell-encode', re: /powershell(?:\.exe)?\s+-(?:enc|encodedcommand)/i },
  { name: 'invoke-expression', re: /\b(?:invoke-expression|iex)\b/i },
  { name: 'fork-bomb', re: /:\(\)\s*\{/ },
  { name: 'chmod-root', re: /chmod\s+-R\s+777\s+\//i },
  { name: 'raw-device-write', re: />\s*\/dev\/(?:sd|nvme)/i },
  { name: 'recursive-remove-item', re: /\b(?:Remove-Item|ri|rm)\b[^\n]*(?:-Recurse|-r)\b[^\n]*(?:\/|\*)/i },
]);

/**
 * 检测文本里是否有明显破坏性命令形态。
 * @param {unknown} value
 * @returns {string|null} 命中的规则名，未命中返回 null
 */
export function findDangerousCommand(value) {
  const text = oneLine(value);
  if (!text) return null;
  for (const item of DANGEROUS_PATTERNS) {
    if (item.re.test(text)) return item.name;
  }
  return null;
}

/**
 * suggestion 安全清洗：过滤危险形态、单行化、≤max 字。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {{ok: boolean, text: string, filtered: boolean, reason: string}}
 */
export function sanitizeSuggestion(value, max = DEFAULTS.suggestionMaxChars) {
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, text: '', filtered: false, reason: 'empty' };
  }
  const danger = findDangerousCommand(value);
  if (danger) return { ok: false, text: '', filtered: true, reason: `dangerous:${danger}` };
  const text = clampSuggestion(value, max);
  if (!text) return { ok: false, text: '', filtered: false, reason: 'empty' };
  return { ok: true, text, filtered: false, reason: '' };
}

const QUESTION_TAIL = /(?:要不要|是否|选哪|哪个方案|需要我|可以吗|行不行|同意吗|还是说|你觉得|确认一下|要我|需要的话|好不好)/;

/**
 * 判断一段 assistant 文本是否是「向用户提问」的回合。
 * 依据：末尾问号，或结尾一段出现典型提问句式。
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeQuestion(value) {
  const text = oneLine(value);
  if (!text) return false;
  if (/[?？]\s*$/.test(text)) return true;
  const tail = Array.from(text).slice(-120).join('');
  return QUESTION_TAIL.test(tail);
}

/**
 * 安全取 JSON 字符串（解析异常返回 fallback），给需要稳定对比的地方用。
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function stableJson(value, fallback = '') {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}
