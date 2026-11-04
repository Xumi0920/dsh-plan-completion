/**
 * host/experiment.js — isolated prompt-budget experiment (round 2).
 *
 * Fixed session snapshot + fixed plan; variables:
 *   - evidenceChars: explicit character budget for the serialized evidence object
 *     (truncated from the least important fields first), and
 *   - maxTokens: the output budget for the plan/suggestion JSON.
 *
 * Each variant runs at temperature 0 and is scored by a second (judge) model call.
 * Exposed only through the temporary `/plan-completion/experiment` route.
 */

function parseLooseJson(text) {
  try {
    const cleaned = String(text ?? '').replace(/```(?:json)?/gi, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (error) {
    return null;
  }
}

const JUDGE_SYSTEM = [
  '你是严格但务实的评分员。只输出一个 JSON 对象，不要输出任何解释、markdown 或代码块。',
  '评分维度（1-5 分，5 最好）：',
  '  coherence：计划步骤的状态与实际证据是否一致（无凭空完成、无遗漏明显进度）。',
  '  specificity：下一步建议是否具体可执行（有明确动作和对象），而不是空话。',
  '  consistency：建议是否与计划不矛盾、是否指向计划的下一步。',
  '  usable：该建议是否是一句人可以直接发送的话（<=60 字，单行，无解释）。',
  '重要：若候选输出声称某个步骤完成、而基准计划尚未体现，但候选原始输出给出了具体证据',
  '（工具名/文件/命令结果），视为合理进度更新，不算 coherence 扣分；只有“无证据的完成声明”才扣分。',
  '输出格式：{"coherence":4,"specificity":5,"consistency":4,"usable":true,"issue":"<=20字"}',
].join('\n');

function judgeMessage(basePlan, rawOutput, suggestion) {
  return [
    '【评估对象】一次「维护会话计划 + 生成下一条用户建议」的模型输出。',
    '【基准计划（当前真实状态）】',
    JSON.stringify(
      basePlan
        ? {
            version: basePlan.version,
            intent: basePlan.intent,
            steps: (basePlan.steps || []).map(step => ({ id: step.id, title: step.title, status: step.status })),
          }
        : null,
      null,
      2,
    ),
    '【候选建议】',
    suggestion || '',
    '【候选原始输出前 900 字】',
    String(rawOutput || '').slice(0, 900),
    '【评分要求】对照基准计划评估候选输出，按系统提示的 JSON 格式输出。',
  ].join('\n');
}

export { sliceEvidence } from './evidence-budget.js';
import { sliceEvidence } from './evidence-budget.js';

async function runVariant({ deps, evidenceChars, maxTokens, rep, index, total }) {
  const {
    session,
    sessionId,
    basePlan,
    collectFromEvents,
    buildPatchPrompt,
    parseModelOutput,
    callModel,
    route,
    judgeRoute,
    debugLog,
  } = deps;
  const startedAt = Date.now();
  let seqNow = 0;
  try {
    seqNow = Number(session.seq ?? 0);
  } catch (error) {
    seqNow = 0;
  }
  let events = [];
  try {
    events = Array.from(session.snapshotEvents(0) ?? []);
  } catch (error) {
    events = [];
  }
  const fullEvidence = (() => {
    try {
      return collectFromEvents({ events, plan: basePlan, turn: Number(basePlan?.watermark?.turn ?? 0), sessionId });
    } catch (error) {
      return { ok: false };
    }
  })();
  const evidence = deps.evidenceChars
    ? sliceEvidence(fullEvidence, evidenceChars)
    : fullEvidence;
  const evidenceSize = JSON.stringify(evidence).length;
  const prompt = (() => {
    try {
      return buildPatchPrompt(evidence);
    } catch (error) {
      return null;
    }
  })();

  const result = {
    index,
    total,
    evidenceChars,
    fullEvidenceChars: JSON.stringify(fullEvidence).length,
    slicedEvidenceChars: evidenceSize,
    maxTokens,
    rep,
    parseOk: false,
    suggestion: '',
    suggestionChars: 0,
    changeCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    judge: null,
    judgeRaw: '',
    error: '',
  };
  if (!prompt) {
    result.error = 'no-prompt';
    return result;
  }
  prompt.maxTokens = maxTokens;
  prompt.temperature = 0;

  try {
    const response = await callModel(deps.services, route, prompt, undefined);
    result.inputTokens = response.usage?.inputTokens ?? 0;
    result.outputTokens = response.usage?.outputTokens ?? 0;
    const parsed = parseModelOutput(response.text);
    result.parseOk = parsed?.ok === true;
    if (parsed?.ok) {
      result.suggestion = parsed.output.suggestion || '';
      result.suggestionChars = result.suggestion.length;
      result.changeCount = (parsed.output.changes || []).length + (parsed.output.steps || []).length;
    }
    result.latencyMs = Date.now() - startedAt;

    try {
      const judgePrompt = {
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: judgeMessage(basePlan, response.text, result.suggestion) }],
        maxTokens: 500,
        temperature: 0,
      };
      const judged = await callModel(deps.services, judgeRoute || route, judgePrompt, undefined);
      result.judgeRaw = String(judged.text || '').slice(0, 400);
      result.judgeModel = judgeRoute ? judgeRoute.model : route.model;
      const score = parseLooseJson(judged.text);
      if (score && typeof score === 'object') {
        const clamp = value => (typeof value === 'number' ? Math.max(1, Math.min(5, Math.round(value))) : null);
        result.judge = {
          coherence: clamp(score.coherence),
          specificity: clamp(score.specificity),
          consistency: clamp(score.consistency),
          usable: score.usable === true,
          issue: typeof score.issue === 'string' ? score.issue.slice(0, 40) : '',
        };
      }
    } catch (error) {
      result.error = `judge:${String(error)}`;
    }
  } catch (error) {
    result.error = String(error);
    result.latencyMs = Date.now() - startedAt;
  }
  debugLog({
    phase: 'experiment-variant',
    sessionId,
    evidenceChars,
    maxTokens,
    rep,
    parseOk: result.parseOk,
    suggestionChars: result.suggestionChars,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    judge: result.judge,
  });
  return result;
}

export async function runExperiment(deps) {
  const budgets = Array.isArray(deps.maxTokens) && deps.maxTokens.length
    ? deps.maxTokens.map(Number).filter(value => Number.isFinite(value) && value > 0)
    : [200, 300, 500];
  const slices = Array.isArray(deps.evidenceChars) && deps.evidenceChars.length
    ? deps.evidenceChars.map(Number).filter(value => Number.isFinite(value) && value > 0)
    : [800, 2000, 4000];
  const reps = Math.max(1, Math.min(3, Number(deps.reps) || 3));
  const total = slices.length * budgets.length * reps;
  const results = [];
  let index = 0;
  for (const evidenceChars of slices) {
    for (const maxTokens of budgets) {
      for (let rep = 0; rep < reps; rep += 1) {
        index += 1;
        try {
          const result = await runVariant({ deps, evidenceChars, maxTokens, rep, index, total });
          results.push(result);
          if (deps.onProgress) deps.onProgress(index, total, result);
        } catch (error) {
          results.push({ index, evidenceChars, maxTokens, rep, error: String(error) });
        }
      }
    }
  }
  return {
    finishedAt: new Date().toISOString(),
    mode: 'explicit-evidence-slice',
    temperature: 0,
    model: deps.route ? { provider: deps.route.provider, model: deps.route.model } : null,
    judgeModel: deps.judgeRoute ? { provider: deps.judgeRoute.provider, model: deps.judgeRoute.model } : null,
    slices,
    budgets,
    reps,
    total,
    results,
  };
}
