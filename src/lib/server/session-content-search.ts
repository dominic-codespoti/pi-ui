/**
 * Full-text search over session message content.
 *
 * Streams each session .jsonl line by line (never loading a whole file),
 * newest sessions first, with a cheap raw-line pre-filter before JSON
 * parsing. Bounded by result count, a wall-clock deadline and an abort
 * signal, so a broad query on a large store returns partial results instead
 * of pinning the Pi.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type {
  SessionSearchMatch as ContentSearchMatch,
  SessionSearchResponse as ContentSearchResponse,
  SessionSearchResult as ContentSearchResult,
} from '../ws/protocol';

export type { ContentSearchMatch, ContentSearchResponse, ContentSearchResult };

export interface ContentSearchFile {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  modified: Date;
}

export const MIN_QUERY_CHARS = 2;
export const MAX_QUERY_CHARS = 200;

export interface ContentSearchOptions {
  maxSessions?: number;
  maxMatchesPerSession?: number;
  deadlineMs?: number;
  snippetRadius?: number;
  signal?: AbortSignal;
  now?: () => number;
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('\n');
}

function snippetAround(text: string, index: number, length: number, radius: number) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const body = text.slice(start, end).replace(/\s+/g, ' ');
  // Whitespace collapsing can move the match; locate it again in the body.
  const local = body.toLowerCase().indexOf(text.slice(index, index + length).toLowerCase());
  return {
    snippet: prefix + body + suffix,
    matchStart: prefix.length + Math.max(0, local),
    matchLength: length,
  };
}

async function searchFile(
  file: ContentSearchFile,
  needle: string,
  rawNeedle: string,
  maxMatches: number,
  radius: number,
  shouldStop: () => boolean
): Promise<{ matches: ContentSearchMatch[]; matchCount: number; stopped: boolean }> {
  const matches: ContentSearchMatch[] = [];
  let matchCount = 0;
  let stopped = false;
  const rl = createInterface({
    input: createReadStream(file.path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (shouldStop()) {
        stopped = true;
        break;
      }
      // Pre-filter on the JSON-escaped needle before paying for JSON.parse.
      if (!line.toLowerCase().includes(rawNeedle)) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== 'message') continue;
      const message = record.message as Record<string, unknown> | undefined;
      const role = message?.role;
      if (!message || (role !== 'user' && role !== 'assistant')) continue;
      const text = messageText(message);
      const index = text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      matchCount++;
      if (matches.length >= maxMatches) continue;
      const timestamp =
        typeof record.timestamp === 'string'
          ? Date.parse(record.timestamp)
          : typeof message.timestamp === 'number'
            ? message.timestamp
            : undefined;
      matches.push({
        role,
        ...snippetAround(text, index, needle.length, radius),
        ...(typeof record.id === 'string' ? { entryId: record.id } : {}),
        ...(timestamp !== undefined && Number.isFinite(timestamp) ? { timestamp } : {}),
      });
    }
  } catch {
    /* unreadable / vanished file: skip */
  } finally {
    rl.close();
  }
  return { matches, matchCount, stopped };
}

export function normalizeSearchQuery(query: unknown): string | null {
  if (typeof query !== 'string') return null;
  const trimmed = query.trim().slice(0, MAX_QUERY_CHARS);
  return trimmed.length >= MIN_QUERY_CHARS ? trimmed : null;
}

export async function searchSessionContent(
  files: readonly ContentSearchFile[],
  query: string,
  options: ContentSearchOptions = {}
): Promise<ContentSearchResponse> {
  const {
    maxSessions = 30,
    maxMatchesPerSession = 3,
    deadlineMs = 8_000,
    snippetRadius = 60,
    signal,
    now = Date.now,
  } = options;
  const started = now();
  const needle = query.toLowerCase();
  const rawNeedle = JSON.stringify(query).slice(1, -1).toLowerCase();
  const ordered = [...files].sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const results: ContentSearchResult[] = [];
  let scannedFiles = 0;
  let truncated = false;
  const shouldStop = () => signal?.aborted === true || now() - started > deadlineMs;

  for (const file of ordered) {
    if (results.length >= maxSessions || shouldStop()) {
      truncated = true;
      break;
    }
    const { matches, matchCount, stopped } = await searchFile(
      file,
      needle,
      rawNeedle,
      maxMatchesPerSession,
      snippetRadius,
      shouldStop
    );
    if (stopped) {
      truncated = true;
      break;
    }
    scannedFiles++;
    if (matchCount === 0) continue;
    results.push({
      path: file.path,
      sessionId: file.id,
      cwd: file.cwd,
      ...(file.name ? { name: file.name } : {}),
      firstMessage: file.firstMessage,
      modified: file.modified.getTime(),
      matches,
      matchCount,
    });
  }
  return {
    query,
    results,
    scannedFiles,
    totalFiles: files.length,
    truncated,
    durationMs: now() - started,
  };
}
