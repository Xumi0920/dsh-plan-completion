/**
 * host/heuristics.js — 启发式建议与降级计划骨架（纯函数，零依赖）。
 *
 * 设计依据：v1.2 §3.5.4（模型不可用 → 启发式）、§3.6（降级链：
 * 「计划下一步 / 失败工具 / 未完成 todo」；无模型 → 首条消息骨架 + todo）。
 *
 * 优先级（与 task 验收一致）：
 *   1. 失败工具 → 修报错
 *   2. 有未完成 todo/doing → 下一个
 *   3. 最后一条 assistant 是提问 → 给倾向性决策
 *   4. 全部 done/dropped → 验收
 *   5. 否则 → 计划下一步 title / 按 intent 起步
 */

import { DEFAULTS } from './config.js';
import { statusFor } from './plan.js';
import { clampChars, looksLikeQuestion, oneLine, sanitizeSuggestion } from './text.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function make(text, kind) {
  const clean = sanitizeSuggestion(text, DEFAULTS.suggestionMaxChars);
  if (!clean.ok) return { ok: false, text: '', kind: 'none' };
  return { ok: true, text: clean.text, kind };
}

function firstFailedTool(evidence) {
  const failed = Array.isArray(evidence?.failedTools) ? evidence.failedTools.filter((tool) => isObj(tool)) : [];
  if (failed.length) return failed[failed.length - 1];
  const calls = Array.isArray(evidence?.toolCalls) ? evidence.toolCalls : [];
  const fromCalls = calls.filter((tool) => isObj(tool) && tool.ok === false);
  return fromCalls.length ? fromCalls[fromCalls.length - 1] : null;
}

function nextOpenStep(plan) {
  if (!isObj(plan) || !Array.isArray(plan.steps)) return null;
  const doing = plan.steps.find((step) => isObj(step) && step.status === 'doing');
  if (doing) return doing;
  const todo = plan.steps.find((step) => isObj(step) && step.status === 'todo');
  return todo ?? null;
}

/**
 * 生成启发式建议（模型不可用/超时/非法输出时的兜底）。
 *
 * @param {object} evidence collectFromEvents 的输出（也可传任意同名字段对象）
 * @returns {{ok:true, text:string, kind:string}|{ok:false, text:'', kind:'none'}}
 */
export function heuristicSuggestion(evidence = {}) {
  try {
    const source = isObj(evidence) ? evidence : {};
    const plan = isObj(source.plan) ? source.plan : null;

    // 1. 失败工具 → 修报错
    const failed = firstFailedTool(source);
    if (failed) {
      const name = clampChars(oneLine(failed.name) || '工具', 14);
      const error = clampChars(oneLine(failed.error), 20);
      if (error) return make(`先修 ${name} 的报错：${error}`, 'fix-error');
      return make(`先修 ${name} 的报错再继续下一步`, 'fix-error');
    }

    // 2. 有未完成步骤 → 下一个
    const next = nextOpenStep(plan);
    if (next) {
      const title = clampChars(oneLine(next.title), 24) || '下一步';
      return make(`接着做「${title}」，先跑通再补细节`, 'next-step');
    }

    // 3. 提问回合 → 给倾向性决策
    if (source.hasQuestion === true || looksLikeQuestion(source.lastAssistantText)) {
      return make('按方案 A 继续，先把最小可用版本跑通', 'decide');
    }

    // 4. 全部完成 → 验收
    if (plan && statusFor(plan.steps) === 'completed') {
      return make('功能已完成，先自测验收再收尾', 'accept');
    }

    // 5. 否则 → 计划下一步 title / intent 起步
    if (plan && Array.isArray(plan.steps) && plan.steps.length) {
      const last = plan.steps[plan.steps.length - 1];
      const title = clampChars(oneLine(last?.title), 22) || clampChars(oneLine(plan.intent), 22);
      if (title) return make(`先收尾「${title}」并确认结果`, 'next-title');
    }
    const intent = clampChars(
      oneLine(plan?.intent) || oneLine(source.intent) || oneLine(source.firstUserMessage) || '',
      22,
    );
    if (intent) return make(`先摸清现状，把「${intent}」拆成 3 步开始`, 'intent');
    return { ok: false, text: '', kind: 'none' };
  } catch {
    return { ok: false, text: '', kind: 'none' };
  }
}

/** 骨架模板：按 intent 关键词选择 3~5 个里程碑。 */
const SKELETONS = [
  {
    match: /(bug|报错|错误|修复|崩溃|异常|失败|fix|error|crash)/i,
    titles: ['复现并定位报错根因', '做最小修复并验证', '补回归测试防止复发'],
  },
  {
    match: /(测试|用例|回归|覆盖率|test|spec)/i,
    titles: ['梳理测试范围与现状', '补关键路径测试用例', '跑通回归并修复问题'],
  },
  {
    match: /(设计|方案|架构|重构|优化|选型)/i,
    titles: ['确认目标、约束与验收标准', '出 2 个方案并对比取舍', '落地最小可行版本', '验证效果并收尾'],
  },
  {
    match: /(文档|readme|说明|注释|doc)/i,
    titles: ['梳理要写的文档范围', '补写核心文档与示例', '校对并验证示例可运行'],
  },
  {
    match: /(接口|api|联调|集成|部署|发布)/i,
    titles: ['确认接口契约与环境', '实现并打通主流程', '联调异常路径', '验收并发布'],
  },
];

/**
 * 降级计划骨架：无模型时按首条消息生成 3~5 步（交给 createSeedPlan 落版本 0.0）。
 *
 * @param {string} [intent] 用户目标（首条消息 / 现计划 intent）
 * @returns {{ok:true, intent:string, steps:Array<{id:string,title:string,status:'todo',source:'model'}>}|{ok:false, code:string, error:string}}
 */
export function fallbackPlan(intent) {
  try {
    const goal = clampChars(oneLine(intent), 24);
    let template = SKELETONS[0];
    if (goal) {
      for (const item of SKELETONS) {
        if (item.match.test(goal)) {
          template = item;
          break;
        }
      }
      if (template === SKELETONS[0] && !SKELETONS[0].match.test(goal)) template = null;
    } else {
      template = null;
    }
    let titles = template ? [...template.titles] : ['摸清现状与约束', '实现核心改动', '自测并修复问题', '补测试与文档'];
    if (goal) {
      // 把目标自然嵌进第一/第二步，让骨架与用户意图相关。
      titles = titles.map((title, index) => (index === 0 && !title.includes(goal) ? `${title}：${goal}` : title));
    }
    const steps = titles.map((title, index) => ({
      id: `s${index + 1}`,
      title: clampChars(title, DEFAULTS.maxTitleChars),
      status: 'todo',
      source: 'model',
    }));
    if (steps.length < DEFAULTS.minSteps || steps.length > DEFAULTS.maxSteps) {
      return { ok: false, code: 'bad-skeleton', error: '骨架步骤数不在 3~5 之间' };
    }
    return { ok: true, intent: clampChars(oneLine(intent), DEFAULTS.maxIntentChars), steps };
  } catch (err) {
    return { ok: false, code: 'internal', error: `骨架生成异常：${err && err.message ? err.message : String(err)}` };
  }
}
