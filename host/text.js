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
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const WRAPPING_QUOTES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g;
const CLAUSE_BOUNDARY = /[，。；！？、,;!?]/;
const ASCII_TOKEN_CHAR = /[A-Za-z0-9_./\\-]/;

/**
 * 去掉常见 Markdown 痕迹，得到适合直接发送的纯文本。
 *
 * 只剥离「成对」的行内标记：`transaction_id`、`C:\a_b\file.js`、`src/**\/*.js`
 * 这类标识符/路径/glob 里的 `_`、`*` 不再被误删；
 * 反引号只去掉包裹符号，代码内容原样保留。
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
  // Protect glob/star patterns (src/**/*.js, *.py, **/) before emphasis stripping.
  const stars = [];
  text = text.replace(/\*\*\/|\*\/|\*\.[A-Za-z0-9_-]+/g, (match) => {
    stars.push(match);
    return `\u0000${stars.length - 1}\u0000`;
  });
  // Inline code: drop the backtick delimiters, keep the code text (underscores intact).
  text = text.replace(/`([^`\n]+)`/g, '$1').replace(/`/g, '');
  // Paired emphasis markers only. Never strip a lone _/* that belongs to an identifier,
  // file name or glob (e.g. transaction_id, foo_bar, *.js).
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?=[^\p{L}\p{N}_]|$)/gu, '$1$2');
  text = text.replace(/\u0000(\d+)\u0000/g, (_match, index) => stars[Number(index)] ?? '');
  return oneLine(text).replace(WRAPPING_QUOTES, '').trim();
}

/**
 * 语义化截短：不把标识符/路径/命令从中间切断。
 *
 * 依次尝试：句子/分句边界（，。；！？、,;!?）→ 空白边界 → 回退到 ASCII token 起点。
 * 实在没有边界时才硬截断，保证返回长度 ≤ max。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function shortenSuggestion(value, max = DEFAULTS.suggestionMaxChars) {
  const text = oneLine(value);
  const limit = Number.isFinite(max) ? Math.floor(max) : 0;
  if (limit <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= limit) return text;

  const prefix = chars.slice(0, limit).join('');
  const minUseful = Math.max(1, Math.floor(limit * 0.4));

  // 1) Prefer the last clause boundary so the returned text stays a complete clause.
  for (let i = prefix.length - 1; i >= minUseful; i -= 1) {
    if (!CLAUSE_BOUNDARY.test(chars[i])) continue;
    // Keep sentence-ending punctuation; drop separators such as ，、；: so the
    // returned suggestion still reads like a message the user can send directly.
    const keep = /[。！？!?]/.test(chars[i]) ? 1 : 0;
    const head = chars.slice(0, i + keep).join('').trim();
    if (head) return head;
  }
  // 2) Whitespace boundary: never leaves a partially copied word after it.
  for (let i = prefix.length - 1; i >= minUseful; i -= 1) {
    if (/\s/.test(chars[i])) {
      let head = chars.slice(0, i).join('').trim();
      // If the cut leaves a lone ASCII command prefix ("…再重跑 npm") and the next
      // character is another ASCII token, drop that dangling token too.
      const next = chars[i + 1] ?? '';
      const tail = head.match(/(?:^|\s)([A-Za-z0-9_./\\-]+)$/);
      if (tail && ASCII_TOKEN_CHAR.test(next)) {
        head = head.slice(0, head.length - tail[1].length).trim().replace(/[\s，。；、,;:：-]+$/, '');
      }
      if (head) return head;
    }
  }
  // 3) Do not split an ASCII identifier/path/command token: cut before the token.
  let cut = limit;
  while (cut > 0 && ASCII_TOKEN_CHAR.test(chars[cut - 1] ?? '') && ASCII_TOKEN_CHAR.test(chars[cut] ?? '')) {
    cut -= 1;
  }
  if (cut > 0) {
    const head = chars.slice(0, cut).join('').trim().replace(/[\s，。；、,;:：-]+$/, '');
    if (head) return head;
  }
  // 4) Single oversized token: hard clamp (still ≤ limit).
  return prefix;
}

/**
 * 建议文本规范化：单行 + 去 Markdown + 语义化截断到 max 字。
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function clampSuggestion(value, max = DEFAULTS.suggestionMaxChars) {
  return shortenSuggestion(stripMarkdown(value), max);
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
