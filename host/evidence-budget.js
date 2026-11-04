/** Trim the serialized evidence down to `targetChars`, dropping the least important parts first. */
export function sliceEvidence(evidence, targetChars) {
  const copy = (() => {
    try {
      return JSON.parse(JSON.stringify(evidence ?? {}));
    } catch (error) {
      return { ok: false };
    }
  })();
  const size = () => JSON.stringify(copy).length;
  if (size() <= targetChars) return copy;

  // 1. Trim the long assistant tail.
  if (typeof copy.lastAssistantText === 'string') {
    const overflow = size() - targetChars;
    copy.lastAssistantText = copy.lastAssistantText.slice(0, Math.max(0, copy.lastAssistantText.length - overflow - 40));
    if (!copy.lastAssistantText) delete copy.lastAssistantText;
  }
  // 2. Drop recent messages from the oldest end.
  while (size() > targetChars && Array.isArray(copy.recentMessages) && copy.recentMessages.length > 1) {
    copy.recentMessages.shift();
  }
  // 3. Drop tool calls from the oldest end.
  while (size() > targetChars && Array.isArray(copy.toolCalls) && copy.toolCalls.length > 1) {
    copy.toolCalls.shift();
  }
  // 4. Drop secondary fields entirely.
  for (const field of ['failedTools', 'files', 'todoSteps', 'counts', 'recentMessages', 'toolCalls', 'evidence', 'lastUserMessages']) {
    if (size() <= targetChars) break;
    if (field in copy) delete copy[field];
  }
  // 5. Hard cap as a last resort.
  if (size() > targetChars && typeof copy.lastAssistantText === 'string') {
    copy.lastAssistantText = copy.lastAssistantText.slice(0, Math.max(0, targetChars - 160));
  }
  return copy;
}

