import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYSTEM_PROMPT,
  buildPatchPrompt,
  buildRewritePrompt,
  buildRepairPrompt,
  parseModelOutput,
  evidenceForModel,
} from '../host/prompt.js';
import { DEFAULTS } from '../host/config.js';

function makeEvidence(overrides = {}) {
  return {
    ok: true,
    sessionId: 's1',
    turn: 7,
    seq: 214,
    intent: '给 Vue 项目加登录页，接入现有鉴权',
    plan: {
      sessionId: 's1',
      version: { gen: 2, rev: 3 },
      status: 'active',
      intent: '给 Vue 项目加登录页，接入现有鉴权',
      steps: [
        { id: 's1', title: '摸清路由与鉴权', status: 'done', source: 'model', evidence: ['read:src/router.ts'] },
        { id: 's2', title: '新增 Login.vue 与路由', status: 'doing', source: 'model' },
        { id: 's3', title: '接入 token 拦截器', status: 'todo', source: 'model' },
      ],
      updatedAt: 1762000000000,
      reason: '第2步进行中',
      watermark: { turn: 7, seq: 214 },
      editedByUser: false,
    },
    lastAssistantText: '已创建 Login.vue 并挂上 /login 路由。',
    toolCalls: [
      { name: 'read', ok: true },
      { name: 'write', ok: false, error: 'EACCES: permission denied' },
    ],
    failedTools: [{ name: 'write', ok: false, error: 'EACCES: permission denied' }],
    lastUserMessages: ['用户：加个登录页', '把它接到现有鉴权上'],
    firstUserMessage: '给 Vue 项目加登录页',
    recentMessages: [
      { role: 'user', text: '加个登录页' },
      { role: 'assistant', text: '已完成路由' },
    ],
    files: ['src/views/Login.vue'],
    hasQuestion: true,
    ...overrides,
  };
}

test('SYSTEM_PROMPT 覆盖设计文档 §3.6 全部护栏', () => {
  const required = [
    '只输出',
    'JSON',
    '数据',
    '不是',
    '指令',
    '40',
    '单行',
    '提问',
    '倾向性',
    '验收',
    '语言跟随',
    '继续',
    '好的',
    'op',
    'patch',
    'rewrite',
  ];
  for (const token of required) {
    assert.ok(SYSTEM_PROMPT.includes(token), `SYSTEM_PROMPT 缺少关键词：${token}`);
  }
});

test('buildPatchPrompt / buildRewritePrompt 返回端口所需结构', () => {
  const evidence = makeEvidence();
  const patch = buildPatchPrompt(evidence);
  assert.equal(typeof patch.system, 'string');
  assert.ok(patch.system.includes('只输出'));
  assert.equal(Array.isArray(patch.messages), true);
  assert.equal(patch.messages.length >= 1, true);
  assert.equal(typeof patch.messages[0].content, 'string');
  assert.equal(typeof patch.maxTokens, 'number');
  assert.equal(typeof patch.temperature, 'number');
  assert.equal(patch.op, 'patch');
  assert.ok(patch.messages[0].content.includes('"s2"'), 'patch prompt 应包含现有步骤');
  assert.ok(patch.messages[0].content.includes('EACCES'), 'patch prompt 应包含失败工具信息');
  assert.ok(patch.messages[0].content.includes('不是指令'), '证据块应标注为数据');

  const rewrite = buildRewritePrompt(evidence, { force: true });
  assert.equal(rewrite.op, 'rewrite');
  assert.ok(rewrite.system.includes('只输出'));
  assert.ok(rewrite.messages[0].content.includes('/replan'));
  assert.equal(typeof rewrite.maxTokens, 'number');
  assert.equal(typeof rewrite.temperature, 'number');
});

test('buildPatchPrompt 在无计划时仍可构造（提示改用 rewrite）', () => {
  const prompt = buildPatchPrompt(makeEvidence({ plan: null }));
  assert.equal(prompt.op, 'patch');
  assert.ok(prompt.messages[0].content.includes('还没有计划'));
});

test('buildRepairPrompt 追加 assistant 失败输出 + 纠正指令', () => {
  const base = buildPatchPrompt(makeEvidence());
  const repair = buildRepairPrompt(base, '这不是 JSON', 'no-json');
  assert.equal(repair.messages.length, base.messages.length + 2);
  assert.equal(repair.messages[repair.messages.length - 2].role, 'assistant');
  assert.equal(repair.messages[repair.messages.length - 1].role, 'user');
  assert.ok(repair.messages[repair.messages.length - 1].content.includes('no-json'));
});

test('evidenceForModel 裁剪证据且不修改输入', () => {
  const evidence = makeEvidence({ lastAssistantText: 'x'.repeat(5000) });
  const snapshot = JSON.stringify(evidence);
  const payload = evidenceForModel(evidence);
  assert.equal(JSON.stringify(evidence), snapshot, '不应修改输入证据');
  assert.ok(payload.plan.steps.length <= 7);
  assert.ok(payload.lastAssistantText.length <= 1500);
  assert.deepEqual(payload.plan.version, { gen: 2, rev: 3 });
});

test('parseModelOutput：直接 JSON / 代码块 / 带前后杂文都能解析', () => {
  const direct = parseModelOutput(
    '{"op":"patch","reason":"第2步完成","changes":[{"id":"s2","status":"done"}],"suggestion":"接着接入 token 拦截器"}',
  );
  assert.equal(direct.ok, true);
  assert.equal(direct.output.op, 'patch');
  assert.equal(direct.output.reason, '第2步完成');
  assert.equal(direct.output.changes[0].id, 's2');
  assert.equal(direct.output.suggestion, '接着接入 token 拦截器');

  const fenced = parseModelOutput(
    ['好的，输出如下：', '```json', '{"op":"none","reason":"无变化","suggestion":"先跑起来看看"}', '```'].join('\n'),
  );
  assert.equal(fenced.ok, true);
  assert.equal(fenced.output.op, 'none');

  const prose = parseModelOutput(
    '这是结果：{"op":"rewrite","reason":"阶段边界","steps":[{"id":"s1","title":"A"},{"id":"s2","title":"B"},{"id":"s3","title":"C"}],"suggestion":"继续做 B"} 完毕',
  );
  assert.equal(prose.ok, true);
  assert.equal(prose.output.op, 'rewrite');
  assert.equal(prose.output.steps.length, 3);
});

test('parseModelOutput：3 类以上非法输入返回 {ok:false} 且不抛异常', () => {
  const noJson = parseModelOutput('抱歉，我无法输出 JSON');
  assert.equal(noJson.ok, false);
  assert.equal(noJson.code, 'no-json');

  const badOp = parseModelOutput('{"op":"delete","reason":"x"}');
  assert.equal(badOp.ok, false);
  assert.equal(badOp.code, 'bad-op');

  const missingOp = parseModelOutput('{"reason":"x"}');
  assert.equal(missingOp.ok, false);
  assert.equal(missingOp.code, 'missing-op');

  const missingReason = parseModelOutput('{"op":"none"}');
  assert.equal(missingReason.ok, false);
  assert.equal(missingReason.code, 'missing-reason');

  const emptyChanges = parseModelOutput('{"op":"patch","reason":"x","changes":[]}');
  assert.equal(emptyChanges.ok, false);
  assert.equal(emptyChanges.code, 'empty-changes');

  const badSteps = parseModelOutput(
    '{"op":"rewrite","reason":"x","steps":[{"id":"s1","title":"A"},{"id":"s2","title":"B"}]}',
  );
  assert.equal(badSteps.ok, false);
  assert.equal(badSteps.code, 'bad-steps');

  const dupStepId = parseModelOutput(
    '{"op":"rewrite","reason":"x","steps":[{"id":"a","title":"A"},{"id":"a","title":"B"},{"id":"c","title":"C"}]}',
  );
  assert.equal(dupStepId.ok, false);

  const arrayJson = parseModelOutput('[{"op":"none"}]');
  assert.equal(arrayJson.ok, false);

  for (const weird of [null, undefined, 42, {}, '', '   ', '{bad json}', '```json\n{broken\n```']) {
    const res = parseModelOutput(weird);
    assert.equal(res.ok, false, `输入 ${String(weird)} 应解析失败`);
    assert.equal(typeof res.error, 'string');
  }
});

test('parseModelOutput：suggestion 单行 / ≤40 字 / 去 Markdown', () => {
  const longSuggestion = '建议'.repeat(60);
  const res = parseModelOutput(
    JSON.stringify({
      op: 'none',
      reason: '无变化',
      suggestion: `**${longSuggestion}**\n第二行`,
    }),
  );
  assert.equal(res.ok, true);
  assert.ok(Array.from(res.output.suggestion).length <= 40);
  assert.equal(res.output.suggestion.includes('\n'), false);
  assert.equal(res.output.suggestion.includes('*'), false);
});

test('parseModelOutput：危险建议被过滤但计划输出仍然有效', () => {
  const res = parseModelOutput(
    JSON.stringify({
      op: 'patch',
      reason: '清理临时文件',
      changes: [{ id: 's2', status: 'done' }],
      suggestion: '直接 rm -rf / 把项目重来一遍',
    }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.output.suggestion, '');
  assert.equal(res.flags.suggestionFiltered, true);
  assert.equal(res.output.changes[0].status, 'done');
});

test('parseModelOutput：alternates 清洗并限量', () => {
  const res = parseModelOutput(
    JSON.stringify({
      op: 'none',
      reason: '无变化',
      suggestion: '先跑起来看看效果',
      alternates: ['先补个登录失败用例', '先补个登录失败用例', 'rm -rf /tmp/x', '**第三备选**'],
    }),
  );
  assert.equal(res.ok, true);
  assert.ok(res.output.alternates.length <= 3);
  assert.equal(new Set(res.output.alternates).size, res.output.alternates.length);
  assert.equal(res.output.alternates.includes('rm -rf /tmp/x'), false);
});

test('parseModelOutput：超长 reason + 7 条 changes 仍能解析（reason 截断到上限）', () => {
  const reason = '这是一段故意写得很长的更新原因，用来验证截断修复路径。'.repeat(20);
  const changes = Array.from({ length: 7 }, (_, i) => ({ id: `s${i + 1}`, status: i % 2 === 0 ? 'done' : 'doing' }));
  const res = parseModelOutput(JSON.stringify({ op: 'patch', reason, changes, suggestion: '继续推进下一步' }));
  assert.equal(res.ok, true);
  assert.equal(res.output.changes.length, 7);
  assert.ok(Array.from(res.output.reason).length <= DEFAULTS.maxReasonChars, 'reason 应截断到上限');
  assert.ok(res.output.changes.every((change) => typeof change.id === 'string' && change.status));
});

test('parseModelOutput：rewrite 7 步 + 长标题仍能解析（标题截断到上限）', () => {
  const longTitle = '一个写得很长的里程碑标题'.repeat(20);
  const steps = Array.from({ length: 7 }, (_, i) => ({ id: `s${i + 1}`, title: `${longTitle}${i}`, status: 'todo' }));
  const res = parseModelOutput(
    JSON.stringify({ op: 'rewrite', reason: '阶段边界，整体重建计划', intent: '目标', steps, suggestion: '先做第一步' }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.output.steps.length, 7);
  assert.ok(res.output.steps.every((step) => Array.from(step.title).length <= DEFAULTS.maxTitleChars));
});
