/**
 * host/config.js — 插件 Host 侧默认参数（集中一处，便于 index.js 用插件 Config 覆盖）。
 *
 * 纯数据模块：零依赖、无副作用，Node 可直接 import。
 * 所有数值均来自设计文档 v1.2 §3.5.4 / §3.5.5 / §3.8。
 */

export const DEFAULTS = Object.freeze({
  // ── 截止线与并发（§3.5.4）──────────────────────────────
  /** 建议展示截止线：超过则本回合不弹建议，但计划继续落盘。 */
  suggestionDeadlineMs: 2500,
  /** 计划落盘截止线：超过则放弃本回合计划，保留 last-good。 */
  planDeadlineMs: 6000,
  /** 强制重写（/replan）截止线。 */
  forceRewriteDeadlineMs: 8000,
  /** 全局并发闸：跨会话同时 in-flight 的作业数上限（§3.5.2）。 */
  globalConcurrency: 2,
  /** 每会话每日模型调用上限；超出只走启发式（§3.5.5）。 */
  dailyCallLimit: 300,
  /** 连续失败次数达到该值熔断（§3.5.4）。 */
  maxConsecutiveFailures: 3,
  /** 熔断时长：5 分钟（§3.5.4）。 */
  circuitBreakerMs: 5 * 60 * 1000,
  /** 两次自动 rewrite 之间的最小回合间隔（§3.5.7 防抖）。 */
  rewriteMinTurns: 3,
  /** 两次自动 rewrite 之间的最小时间间隔（§3.5.7 防抖）。 */
  rewriteMinIntervalMs: 5 * 60 * 1000,
  /** JSON 非法后修复重发次数（§3.5.4：1 次）。 */
  repairRetryMax: 1,
  /** 幂等键 (sessionId, turn) 的去重窗口。 */
  dedupeTtlMs: 10 * 60 * 1000,

  // ── 计划数据约束（§3.4）────────────────────────────────
  /** 步骤数下限 / 上限。 */
  minSteps: 3,
  maxSteps: 7,
  /** 每个会话保留的历史版本数（§3.8 版本保留数）。 */
  keepVersions: 5,
  /** 每条步骤最多挂多少条证据。 */
  maxEvidencePerStep: 8,
  /** 步骤标题最大字符数（防御性截断）。 */
  maxTitleChars: 120,
  /** 单条证据最大字符数（防御性截断）。 */
  maxEvidenceChars: 200,
  /** 计划 intent 最大字符数。 */
  maxIntentChars: 300,
  /** 更新原因 reason 最大字符数。 */
  maxReasonChars: 200,

  // ── 建议文本（§3.6）────────────────────────────────────
  /** suggestion 最大字符数：≤40 字、单行。 */
  suggestionMaxChars: 40,
  /** 备选建议最多条数。 */
  alternatesMax: 3,

  // ── 证据采集（§3.5.5 / task 验收）──────────────────────
  /** 最后一条 assistant 文本截断长度。 */
  assistantTextMaxChars: 1500,
  /** 单条用户消息截断长度。 */
  userMessageMaxChars: 500,
  /** 证据里保留的最近消息条数（rewrite 用）。 */
  recentMessagesMax: 6,
  /** 最近消息单条截断长度。 */
  recentMessageChars: 300,
  /** 证据里最多保留的工具调用条数。 */
  maxToolRecords: 20,

  // ── 模型调用参数（§3.5.5；设计预算输出 <300 tokens，但实测 7 步 JSON 会截断，故上调）──
  // 真机实测（Lead index.js，2026-11）：rewrite 700 会被截断 → 至少 1200；patch 建议至少 800。
  maxTokensPatch: 800,
  maxTokensRewrite: 1200,
  temperaturePatch: 0.2,
  temperatureRewrite: 0.3,
});

/**
 * 数字参数安全取值：非法/缺失时回落默认值并夹在给定区间内。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number}
 */
export function numberOption(value, fallback, min = -Infinity, max = Infinity) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}
