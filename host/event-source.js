/** Native DSH compaction changes the request surface, not execution history. */
export function isCompactionCheckpoint(event) {
  return event?.type === 'user/message' && event?.data?.source?.kind === 'compact-checkpoint';
}

export function isGeneratedUserMessage(event) {
  const kind = event?.data?.source?.kind;
  return event?.type === 'user/message' && typeof kind === 'string' && kind !== 'user';
}

export function isDerivedToolResult(event) {
  return event?.type === 'tool/result' && event?.surfaceOp?.op === 'replace';
}
