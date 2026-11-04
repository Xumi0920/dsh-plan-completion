/**
 * host/evidence.js — 从 SessionEvent 数组采集「证据」（纯函数，零依赖）。
 *
 * 事件契约已按 probe-verify 的实测结果（`research/p0-contract.md` §9）对齐：
 *   SessionEvent = { type: string, seq: number, time: number, data: <按 type 映射>, ignorable? }
 *   turn/start   data = { turn }
 *   turn/end     data = { turn, reason: { kind, error? } }
 *   user/message data = UserMessage { role:'user', content: ContentBlock[] }
 *   assistant/message data = { turn, step, message: AssistantMessage { content: ContentBlock[] }, stream, usage? }
 *   tool/call    data = { turn, step, callId, name, arguments: JSON string }
 *   tool/result  data = { turn, step, message: ToolResultMessage { toolCallId, isError?, content }, error?: {name,code,reason?} }
 * 文本只取 `type === 'text'` 的 block（reasoning / tool-call 等块不算正文）。
 *
 * 输出字段（与 index.js 接线约定一致）：
 *   turn               本回合编号（number）
 *   lastAssistantText  最后一条 assistant 正文（截断 1500 字）
 *   toolCalls          本回合工具调用 [{name, ok, callId?, error?, path?}]（失败结果按 callId 回填）
 *   failedTools        其中失败的项
 *   lastUserMessages   最近 2 条用户消息（string[]，各截断 500 字）
 *   todoSteps          当前计划里未完成步骤 [{id,title,status}]
 * 另附：sessionId、seq、watermark、intent、firstUserMessage、recentMessages、files、
 *       hasQuestion、turnEnded、turnEndReason、turnEndError、interrupted、plan、counts。
 *
 * 纯函数：不修改 events 数组、不修改数组元素、不修改传入的 plan。
 */

import { DEFAULTS } from './config.js';
import { clampChars, looksLikeQuestion, oneLine, toText } from './text.js';
import { isGeneratedUserMessage, isDerivedToolResult } from './event-source.js';

const TYPE_SETS = {
  turnStart: new Set(['turn/start', 'turn.start', 'turn_start', 'turn/started']),
  turnEnd: new Set(['turn/end', 'turn.end', 'turn_end', 'turn/ended', 'turn/complete', 'turn/completed']),
  user: new Set(['user/message', 'user.message', 'user_message', 'message/user']),
  assistant: new Set(['assistant/message', 'assistant.message', 'assistant_message', 'message/assistant']),
  toolCall: new Set(['tool/call', 'tool.call', 'tool_call', 'tool/start', 'tool/begin']),
  toolResult: new Set(['tool/result', 'tool.result', 'tool_result', 'tool/end', 'tool/done', 'tool/finish']),
};

const BLOCK_IGNORED_TYPES = new Set(['reasoning', 'image', 'file', 'tool-call', 'tool-addition', 'tool-removal']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOf(event) {
  if (!isObj(event)) return '';
  const raw = event.type ?? event.kind ?? event.event ?? event.name;
  return toText(raw).toLowerCase();
}

function payloadOf(event) {
  if (!isObj(event)) return {};
  const candidates = [event.data, event.payload, event.detail, event.value];
  for (const candidate of candidates) {
    if (isObj(candidate)) return candidate;
  }
  return event;
}

function seqOf(event, index) {
  const direct = event?.seq ?? event?.sequence ?? payloadOf(event).seq;
  if (Number.isInteger(direct) && direct >= 0) return direct;
  return index + 1;
}

function intOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 从消息节点里提取正文：只取 `type === 'text'` 的 ContentBlock。
 * @param {unknown} node
 * @param {number} [depth]
 * @returns {string}
 */
function extractText(node, depth = 0) {
  if (depth > 6 || node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) {
    return node
      .map((item) => extractText(item, depth + 1))
      .filter(Boolean)
      .join('');
  }
  if (!isObj(node)) return '';
  const blockType = typeof node.type === 'string' ? node.type : '';
  if (blockType) {
    if (blockType === 'text') return typeof node.text === 'string' ? node.text : '';
    if (BLOCK_IGNORED_TYPES.has(blockType)) return '';
  }
  if (typeof node.text === 'string') return node.text;
  if (typeof node.value === 'string') return node.value;
  if (typeof node.delta === 'string') return node.delta;
  for (const key of ['content', 'message', 'parts', 'blocks', 'body', 'output']) {
    if (node[key] != null) {
      const text = extractText(node[key], depth + 1);
      if (text) return text;
    }
  }
  return '';
}

function messageOf(payload) {
  const message = payload?.message ?? payload?.msg ?? payload?.content ?? payload;
  const text = oneLine(extractText(message));
  const roleRaw = payload?.role ?? message?.role ?? payload?.message?.role;
  return { text, role: toText(roleRaw).toLowerCase(), message };
}

function errorTextOf(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return oneLine(raw);
  if (Array.isArray(raw)) {
    return raw
      .map((item) => errorTextOf(item))
      .filter(Boolean)
      .join('; ');
  }
  if (!isObj(raw)) return oneLine(String(raw));
  const parts = [raw.message, raw.reason, raw.error?.message, raw.name, raw.code, raw.status]
    .map((part) => toText(part))
    .filter(Boolean);
  if (parts.length) return oneLine(parts.join(' '));
  return oneLine(extractText(raw));
}

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function inputPathOf(input) {
  const parsed = parseMaybeJson(input);
  if (!isObj(parsed)) return '';
  for (const key of ['file_path', 'filePath', 'path', 'file', 'target', 'filename']) {
    const value = parsed[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function toolCallOf(payload) {
  const call = isObj(payload?.call)
    ? payload.call
    : isObj(payload?.toolCall)
      ? payload.toolCall
      : isObj(payload?.tool)
        ? payload.tool
        : payload;
  const name =
    toText(call?.name ?? call?.toolName ?? call?.tool_name ?? payload?.name ?? payload?.toolName ?? '') || '(unknown)';
  const callId =
    toText(
      call?.callId ??
        call?.call_id ??
        call?.id ??
        call?.toolCallId ??
        payload?.callId ??
        payload?.call_id ??
        payload?.toolCallId ??
        payload?.id ??
        '',
    ) || '';
  const input = parseMaybeJson(
    call?.input ?? call?.args ?? call?.arguments ?? payload?.input ?? payload?.args ?? payload?.arguments ?? null,
  );
  return { name, callId, input };
}

function isErrorResult(payload) {
  if (!isObj(payload)) return false;
  const message = payload.message;
  if (isObj(message) && message.isError === true) return true;
  if (payload.isError === true || payload.is_error === true) return true;
  if (payload.ok === false || payload.success === false || payload.failed === true) return true;
  const status = toText(payload.status).toLowerCase();
  if (status === 'error' || status === 'failed' || status === 'failure') return true;
  return payload.error != null;
}

function resultErrorText(payload) {
  const message = isObj(payload?.message) ? payload.message : null;
  if (message && message.isError === true) {
    const fromBlock = oneLine(extractText(message.content));
    if (fromBlock) return fromBlock;
  }
  const raw = payload?.error ?? payload?.result?.error ?? payload?.output?.error ?? message?.error ?? null;
  const fromError = errorTextOf(raw);
  if (fromError) return fromError;
  return oneLine(extractText(message?.content));
}

function todoStepsOf(plan) {
  if (!isObj(plan) || !Array.isArray(plan.steps)) return [];
  return plan.steps
    .filter((step) => isObj(step) && step.status !== 'done' && step.status !== 'dropped')
    .map((step) => ({ id: toText(step.id), title: toText(step.title), status: toText(step.status) || 'todo' }));
}

function emptyEvidence(error) {
  return {
    ok: false,
    error,
    sessionId: '',
    turn: 0,
    seq: 0,
    watermark: { turn: 0, seq: 0 },
    intent: '',
    plan: null,
    lastAssistantText: '',
    toolCalls: [],
    failedTools: [],
    lastUserMessages: [],
    firstUserMessage: '',
    recentMessages: [],
    todoSteps: [],
    files: [],
    hasQuestion: false,
    turnEnded: false,
    turnEndReason: '',
    turnEndError: '',
    interrupted: false,
    counts: { events: 0, toolCalls: 0, failedTools: 0, messages: 0, userMessages: 0 },
  };
}

function messageRecord(payload) {
  return messageOf(payload);
}

/**
 * 从 SessionEvent 数组采集证据。
 *
 * @param {{events?: unknown, plan?: object|null, turn?: number, sessionId?: string}} params
 * @returns {object} 证据对象（见文件头注释；`ok:false` 表示入参不是事件数组）
 */
export function collectFromEvents(params = {}) {
  try {
    const events = params?.events;
    if (!Array.isArray(events)) return emptyEvidence('events 必须是数组');
    const basePlan = isObj(params?.plan) ? params.plan : null;

    // ── 1. 水位：全量事件的最大 seq；回合：最后一个 turn/start 之后 ──────
    let seq = 0;
    let lastTurnStartIndex = -1;
    let turnFromEvents = null;
    let turnEnded = false;
    let turnEndReason = '';
    let turnEndError = '';
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const type = typeOf(event);
      const eventSeq = seqOf(event, i);
      if (eventSeq > seq) seq = eventSeq;
      if (TYPE_SETS.turnStart.has(type)) {
        lastTurnStartIndex = i;
        const data = payloadOf(event);
        turnFromEvents = intOrNull(data.turn) ?? turnFromEvents;
        turnEnded = false;
        turnEndReason = '';
        turnEndError = '';
      } else if (TYPE_SETS.turnEnd.has(type)) {
        turnEnded = true;
        const data = payloadOf(event);
        turnFromEvents = intOrNull(data.turn) ?? turnFromEvents;
        const reason = isObj(data.reason) ? data.reason : null;
        turnEndReason = toText(reason?.kind) || toText(data.reason);
        turnEndError = errorTextOf(reason?.error ?? data.error);
      }
    }
    const scopeStart = lastTurnStartIndex >= 0 ? lastTurnStartIndex : 0;
    const explicitTurn = intOrNull(params?.turn);
    const turn = explicitTurn ?? turnFromEvents ?? 0;

    // ── 2. 消息：全量扫描（最近 2 条用户消息可能跨回合）──────────────
    let lastAssistantText = '';
    let firstUserMessage = '';
    const userTexts = [];
    const recentMessages = [];

    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (isGeneratedUserMessage(event)) continue;
      const type = typeOf(event);
      const payload = payloadOf(event);
      const isUser = TYPE_SETS.user.has(type) || (!TYPE_SETS.assistant.has(type) && messageRecord(payload).role === 'user');
      const isAssistant = TYPE_SETS.assistant.has(type) || messageRecord(payload).role === 'assistant';
      if (!isUser && !isAssistant) continue;
      const record = messageRecord(payload);
      if (!record.text) continue;
      if (isUser) {
        const text = clampChars(record.text, DEFAULTS.userMessageMaxChars);
        userTexts.push(text);
        if (!firstUserMessage) firstUserMessage = text;
        recentMessages.push({ role: 'user', text: clampChars(record.text, DEFAULTS.recentMessageChars) });
      } else {
        lastAssistantText = clampChars(record.text, DEFAULTS.assistantTextMaxChars);
        recentMessages.push({ role: 'assistant', text: clampChars(record.text, DEFAULTS.recentMessageChars) });
      }
    }

    // ── 3. 工具调用：只取本回合（last turn/start 之后）──────────────
    const toolCalls = [];
    const callIndex = new Map();
    for (let i = scopeStart; i < events.length; i += 1) {
      const event = events[i];
      if (isDerivedToolResult(event)) continue;
      const type = typeOf(event);
      const payload = payloadOf(event);
      if (TYPE_SETS.toolCall.has(type)) {
        const call = toolCallOf(payload);
        const record = { name: call.name, ok: true };
        if (call.callId) record.callId = call.callId;
        const path = inputPathOf(call.input);
        if (path) record.path = path;
        toolCalls.push(record);
        if (call.callId) callIndex.set(call.callId, toolCalls.length - 1);
        continue;
      }
      if (TYPE_SETS.toolResult.has(type)) {
        const message = isObj(payload?.message) ? payload.message : null;
        const callId = toText(
          payload?.callId ??
            payload?.call_id ??
            payload?.toolCallId ??
            payload?.id ??
            message?.toolCallId ??
            message?.source?.callId ??
            '',
        );
        const ok = !isErrorResult(payload);
        let record = callId ? toolCalls[callIndex.get(callId)] : undefined;
        if (!record) {
          const fallbackName = toText(payload?.name ?? payload?.toolName) || toolCallOf(payload).name;
          record = { name: fallbackName && fallbackName !== '(unknown)' ? fallbackName : 'tool', ok: true };
          toolCalls.push(record);
          if (callId) record.callId = callId;
        }
        record.ok = ok;
        if (!ok) record.error = resultErrorText(payload) || '工具执行失败';
      }
    }

    // ── 4. 汇总 ────────────────────────────────────────────────
    const failedTools = toolCalls.filter((call) => call.ok === false);
    const dedupedUserTexts = [];
    for (const text of userTexts) {
      if (dedupedUserTexts[dedupedUserTexts.length - 1] !== text) dedupedUserTexts.push(text);
    }
    const lastUserMessages = dedupedUserTexts.slice(-2);
    const plan = basePlan;
    const files = [...new Set(toolCalls.filter((call) => call.path).map((call) => call.path))].slice(-DEFAULTS.maxToolRecords);
    const intent = isObj(plan) && typeof plan.intent === 'string' && plan.intent ? plan.intent : firstUserMessage;

    return {
      ok: true,
      error: '',
      sessionId: toText(params?.sessionId) || (isObj(plan) ? toText(plan.sessionId) : ''),
      turn,
      seq,
      watermark: { turn, seq },
      intent: clampChars(intent, DEFAULTS.maxIntentChars),
      plan,
      lastAssistantText,
      toolCalls: toolCalls.slice(0, DEFAULTS.maxToolRecords),
      failedTools,
      lastUserMessages,
      firstUserMessage,
      recentMessages: recentMessages.slice(-DEFAULTS.recentMessagesMax),
      todoSteps: todoStepsOf(plan),
      files,
      hasQuestion: looksLikeQuestion(lastAssistantText),
      turnEnded,
      turnEndReason,
      turnEndError,
      interrupted: turnEndReason === 'interrupted' || turnEndReason === 'aborted' || turnEndReason === 'error',
      counts: {
        events: events.length,
        toolCalls: toolCalls.length,
        failedTools: failedTools.length,
        messages: recentMessages.length,
        userMessages: dedupedUserTexts.length,
      },
    };
  } catch (err) {
    return emptyEvidence(`证据采集异常：${err && err.message ? err.message : String(err)}`);
  }
}
