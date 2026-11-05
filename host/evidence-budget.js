/** Budget recent narrative separately from the plan and bounded acceptance/retrieval data.
 * The target is soft: retain a minimum useful answer and the latest tool/failure even
 * when required context exceeds it. Never erase all new evidence to fit old state.
 */
export function sliceEvidence(evidence, targetChars) {
  const copy = (() => {
    try {
      return JSON.parse(JSON.stringify(evidence ?? {}));
    } catch (error) {
      return { ok: false };
    }
  })();
  const reserved = new Set(['plan', 'progressRecords', 'progressProtocol', 'retrieval']);
  const size = () => JSON.stringify(Object.fromEntries(Object.entries(copy).filter(([key]) => !reserved.has(key)))).length;
  if (size() <= targetChars) return copy;

  // Drop duplicated history and derived fields before touching the latest answer.
  for (const field of ['recentMessages', 'evidence', 'files', 'todoSteps', 'counts', 'firstUserMessage']) {
    delete copy[field];
  }
  // Keep both the beginning and the conclusion of a long answer.
  if (typeof copy.lastAssistantText === 'string') {
    const overflow = Math.max(0, size() - targetChars);
    const length = Math.max(240, copy.lastAssistantText.length - overflow);
    if (copy.lastAssistantText.length > length) {
      const head = Math.floor((length - 3) / 2);
      copy.lastAssistantText = copy.lastAssistantText.slice(0, head) + ' … ' + copy.lastAssistantText.slice(-(length - 3 - head));
    }
  }
  // Preserve at least one fresh tool result, failure and human instruction.
  for (const field of ['toolCalls', 'failedTools', 'lastUserMessages']) {
    while (size() > targetChars && Array.isArray(copy[field]) && copy[field].length > 1) copy[field].shift();
  }
  return copy;
}

