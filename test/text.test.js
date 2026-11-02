import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clampSuggestion,
  sanitizeSuggestion,
  shortenSuggestion,
  stripMarkdown,
} from '../host/text.js';

const charCount = (s) => Array.from(s).length;

test('stripMarkdown keeps underscores inside identifiers, paths and globs', () => {
  assert.equal(stripMarkdown('采用 transaction_id 作为幂等键'), '采用 transaction_id 作为幂等键');
  assert.equal(stripMarkdown('修改 C:\\work\\my_file_name.js 后重跑'), '修改 C:\\work\\my_file_name.js 后重跑');
  assert.equal(stripMarkdown('检查 src/**/*.js 的覆盖情况'), '检查 src/**/*.js 的覆盖情况');
  assert.equal(stripMarkdown('先看 payment_test.py 再决定'), '先看 payment_test.py 再决定');
});

test('stripMarkdown still removes paired emphasis and keeps inline-code content', () => {
  assert.equal(stripMarkdown('**重要**：先跑 `npm test` 再提交'), '重要：先跑 npm test 再提交');
  assert.equal(stripMarkdown('这是 *斜体* 和 _强调_ 文本'), '这是 斜体 和 强调 文本');
  assert.equal(stripMarkdown('~~废弃~~ 方案'), '废弃 方案');
  assert.equal(stripMarkdown('## 标题\n- 列表项'), '标题 列表项');
});

test('shortenSuggestion prefers clause boundaries and never splits a command/identifier', () => {
  const raw = '先定位 payment.test.js 的 3 个断言失败并修复，再重跑 npm test';
  const short = shortenSuggestion(raw, 40);
  assert.ok(charCount(short) <= 40);
  assert.notEqual(short.trim(), '');
  assert.equal(/npm\s*$/.test(short), false, 'must not end with a truncated command prefix');
  assert.equal(/npm te$/.test(short), false);
  assert.equal(/[，,、;；:：]$/.test(short), false, 'must not end with a dangling separator');
  assert.equal(short.includes('payment.test.js'), true, 'file name must stay intact');

  const identifiers = '请先更新 transaction_id 字段并核对 user_account 的唯一约束，然后重跑回归测试';
  const out = shortenSuggestion(identifiers, 40);
  assert.ok(charCount(out) <= 40);
  assert.equal(out.includes('transaction_i'), out.includes('transaction_id'), 'identifier must not be cut mid-token');
});

test('shortenSuggestion falls back safely for space-free long text (no partial ASCII token)', () => {
  const spaced = 'Please update the transaction_id field and then run npm test before shipping the patch';
  const out = shortenSuggestion(spaced, 40);
  assert.ok(charCount(out) <= 40);
  assert.equal(/[A-Za-z0-9_./\\-]+$/.test(out), true, 'must end on a complete token');
  assert.equal(out.endsWith('transaction_i'), false);
  // no split inside the identifier
  if (out.includes('transaction')) assert.ok(out.includes('transaction_id'), 'identifier must stay whole');
});

test('clampSuggestion keeps the old guarantees (single line, ≤ max, markdown stripped)', () => {
  const long = '建议'.repeat(60);
  const out = clampSuggestion(`**${long}**\n第二行`, 40);
  assert.ok(charCount(out) <= 40);
  assert.equal(out.includes('\n'), false);
  assert.equal(out.includes('*'), false);
});

test('sanitizeSuggestion preserves identifiers and applies semantic shortening', () => {
  const ok = sanitizeSuggestion('采用 transaction_id 幂等键加唯一约束，先写去重实现', 40);
  assert.equal(ok.ok, true);
  assert.equal(ok.text.includes('transaction_id'), true);

  const shortened = sanitizeSuggestion('先定位 payment.test.js 的 3 个断言失败并修复，再重跑 npm test', 40);
  assert.equal(shortened.ok, true);
  assert.ok(charCount(shortened.text) <= 40);
  assert.equal(/npm\s*$/.test(shortened.text), false);

  const dangerous = sanitizeSuggestion('直接 rm -rf / 把项目重来一遍', 40);
  assert.equal(dangerous.ok, false);
  assert.equal(dangerous.filtered, true);
});
