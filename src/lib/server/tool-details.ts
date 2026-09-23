import { MAX_WIRE_BLOCK_CHARS } from './wire-messages.ts';

const BUILT_IN_TOOLS: Record<string, true> = {
  read: true,
  bash: true,
  edit: true,
  grep: true,
  find: true,
  ls: true,
};

/** Project only the built-in SDK fields the UI understands; extension details stay private. */
export function toolDetailsForWire(
  toolName: string,
  value: unknown
): Record<string, unknown> | undefined {
  if (!BUILT_IN_TOOLS[toolName] || !value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const details = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  const truncation = details.truncation;
  if (truncation && typeof truncation === 'object' && !Array.isArray(truncation)) {
    const raw = truncation as Record<string, unknown>;
    const bounded: Record<string, unknown> = {};
    if (typeof raw.truncated === 'boolean') bounded.truncated = raw.truncated;
    if (raw.truncatedBy === 'lines' || raw.truncatedBy === 'bytes' || raw.truncatedBy === null)
      bounded.truncatedBy = raw.truncatedBy;
    for (const key of ['totalLines', 'outputLines', 'totalBytes', 'outputBytes'] as const) {
      if (typeof raw[key] === 'number' && Number.isFinite(raw[key])) bounded[key] = raw[key];
    }
    if (Object.keys(bounded).length) projected.truncation = bounded;
  }
  if (typeof details.fullOutputPath === 'string')
    projected.fullOutputPath = details.fullOutputPath.slice(0, 4096);
  if (typeof details.firstChangedLine === 'number' && Number.isFinite(details.firstChangedLine))
    projected.firstChangedLine = details.firstChangedLine;
  if (typeof details.patch === 'string')
    projected.patch = details.patch.slice(0, MAX_WIRE_BLOCK_CHARS);
  if (typeof details.matchLimitReached === 'number')
    projected.matchLimitReached = details.matchLimitReached;
  if (typeof details.linesTruncated === 'boolean')
    projected.linesTruncated = details.linesTruncated;
  if (typeof details.resultLimitReached === 'number')
    projected.resultLimitReached = details.resultLimitReached;
  if (typeof details.entryLimitReached === 'number')
    projected.entryLimitReached = details.entryLimitReached;
  return Object.keys(projected).length ? projected : undefined;
}
/** Sanitize tool-result details in history and end-of-turn event snapshots. */
export function toolResultsForWire(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const record = message as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role.toLowerCase().replace('_', '') : '';
    if (role !== 'toolresult') return message;
    const toolName = typeof record.toolName === 'string' ? record.toolName : 'tool';
    const rawDetails =
      record.details && typeof record.details === 'object'
        ? (record.details as Record<string, unknown>)
        : undefined;
    const details = toolDetailsForWire(toolName, rawDetails);
    const diff =
      toolName === 'edit' && typeof rawDetails?.diff === 'string'
        ? rawDetails.diff.slice(0, MAX_WIRE_BLOCK_CHARS)
        : undefined;
    const safe = { ...record };
    delete safe.details;
    if (details) safe.details = details;
    if (diff !== undefined) safe.diff = diff;
    return safe;
  });
}
