/**
 * Memory-bounded session listing.
 *
 * The SDK's SessionManager.list()/listAll() load every session .jsonl fully
 * and build an `allMessagesText` concatenation of every message — with
 * hundreds of MB of session files (46 MB single files observed) a 10-wide
 * concurrent scan spikes past 1 GB RSS and OOM-kills the server on a
 * Raspberry Pi. pi-ui never uses `allMessagesText`.
 *
 * This scanner replicates the SDK's summary semantics (header, latest
 * session_info name, message count, first user message, last activity)
 * while streaming one line at a time, and caches per-file results keyed by
 * (mtime, size) so unchanged files are never re-parsed across scans. The
 * cache is persisted to disk (opt-in via initSessionScanCache) so restarts
 * are stat-calls-only: a session file is fully read at most once per change,
 * ever — not once per process.
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { log } from './logger';

/** Summary of one session file — field semantics match the SDK's SessionInfo. */
export interface SessionFileInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

/** Concurrent file parses. Deliberately low: bounds peak RSS during a cold scan. */
const MAX_CONCURRENT_PARSES = 4;

/** Cap firstMessage preview length — it only feeds sidebar previews. */
const FIRST_MESSAGE_MAX_CHARS = 500;

interface CachedFileInfo {
  mtimeMs: number;
  size: number;
  info: SessionFileInfo | null;
}

const fileInfoCache = new Map<string, CachedFileInfo>();

// ── Disk persistence ─────────────────────────────────────────────────────────

let cacheFilePath: string | null = null;
let cacheDirty = false;

/**
 * Enable disk persistence of the per-file cache and hydrate it from an
 * earlier run. Atomic tmp+rename writes, same as the project registry.
 * Corrupt or missing cache files start empty — worst case is one re-scan.
 */
export function initSessionScanCache(filePath: string): void {
  cacheFilePath = filePath;
  cacheDirty = false;
  fileInfoCache.clear();
  try {
    if (!existsSync(filePath)) return;
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('entries' in parsed) || !Array.isArray(parsed.entries)) return;
    for (const raw of parsed.entries) {
      if (!Array.isArray(raw) || raw.length !== 4) continue;
      const [path, mtimeMs, size, info] = raw as [unknown, unknown, unknown, unknown];
      if (typeof path !== 'string' || typeof mtimeMs !== 'number' || typeof size !== 'number') continue;
      fileInfoCache.set(path, { mtimeMs, size, info: reviveInfo(info) });
    }
  } catch (err) {
    log.warn('[pifrontier] session-scan cache: failed to load, starting empty:', err);
    fileInfoCache.clear();
  }
}

function reviveInfo(raw: unknown): SessionFileInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  // Parsed-JSON object we persisted ourselves — a string-keyed record view is
  // the honest type; every field is still runtime-checked below.
  const record = raw as Record<string, unknown>;
  if (typeof record.path !== 'string' || typeof record.id !== 'string') return null;
  return {
    path: record.path,
    id: record.id,
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
    name: typeof record.name === 'string' ? record.name : undefined,
    parentSessionPath: typeof record.parentSessionPath === 'string' ? record.parentSessionPath : undefined,
    created: new Date(typeof record.created === 'number' ? record.created : 0),
    modified: new Date(typeof record.modified === 'number' ? record.modified : 0),
    messageCount: typeof record.messageCount === 'number' ? record.messageCount : 0,
    firstMessage: typeof record.firstMessage === 'string' ? record.firstMessage : '',
  };
}

/** Write the cache to disk when enabled and dirty. Sync + atomic; the file is
 *  small (~1 KB per session) and scans are already async. */
function persistCache(): void {
  if (!cacheFilePath || !cacheDirty) return;
  try {
    mkdirSync(dirname(cacheFilePath), { recursive: true });
    const entries = [...fileInfoCache].map(([path, c]) => [
      path,
      c.mtimeMs,
      c.size,
      c.info
        ? { ...c.info, created: c.info.created.getTime(), modified: c.info.modified.getTime() }
        : null,
    ]);
    const tmp = `${cacheFilePath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
    renameSync(tmp, cacheFilePath);
    cacheDirty = false;
  } catch (err) {
    log.error('[pifrontier] session-scan cache: failed to save:', err);
  }
}

/**
 * Directory name the SDK encodes a project cwd into under the sessions root
 * (see getDefaultSessionDirPath in the SDK's session-manager).
 */
export function encodeSessionDirName(cwd: string): string {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function firstTextContent(message: object): string {
  const content = 'content' in message ? message.content : undefined;
  if (typeof content === 'string') return content.slice(0, FIRST_MESSAGE_MAX_CHARS);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  let length = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (!('text' in block) || typeof block.text !== 'string') continue;
    if (!('type' in block) || block.type !== 'text') continue;
    parts.push(block.text);
    length += block.text.length;
    if (length >= FIRST_MESSAGE_MAX_CHARS) break;
  }
  return parts.join(' ').slice(0, FIRST_MESSAGE_MAX_CHARS);
}

function strField(obj: object, key: string): string | undefined {
  // Parsed-JSON object with arbitrary keys — a string-keyed record view is the
  // honest type here; every read is still runtime-checked below.
  const record = obj as Record<string, unknown>;
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/** Parse one session .jsonl streaming; returns null for non-session files. */
async function parseSessionFile(filePath: string): Promise<SessionFileInfo | null> {
  let headerId: string | undefined;
  let headerCwd = '';
  let headerTimestamp: string | undefined;
  let parentSessionPath: string | undefined;
  let sawHeader = false;
  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = '';
  let lastActivityTime: number | undefined;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry || typeof entry === 'boolean' || typeof entry !== 'object') continue;
      const type = strField(entry, 'type');
      if (!sawHeader) {
        if (type !== 'session') return null;
        sawHeader = true;
        headerId = strField(entry, 'id');
        headerCwd = strField(entry, 'cwd') ?? '';
        headerTimestamp = strField(entry, 'timestamp');
        parentSessionPath = strField(entry, 'parentSession');
        continue;
      }
      if (type === 'session_info') {
        name = strField(entry, 'name')?.trim() || undefined;
        continue;
      }
      if (type !== 'message') continue;
      const message = 'message' in entry ? entry.message : undefined;
      if (!message || typeof message !== 'object') continue;
      const role = strField(message, 'role');
      if (role !== 'user' && role !== 'assistant') continue;
      messageCount++;
      // Activity time — prefer the message's own timestamp, fall back to the entry's.
      const msgTs = 'timestamp' in message ? message.timestamp : undefined;
      const activity =
        typeof msgTs === 'number' ? msgTs : new Date(strField(entry, 'timestamp') ?? '').getTime();
      if (!Number.isNaN(activity)) {
        lastActivityTime = Math.max(lastActivityTime ?? 0, activity);
      }
      if (!firstMessage && role === 'user') {
        firstMessage = firstTextContent(message);
      }
    }
  } finally {
    rl.close();
  }

  if (!sawHeader || !headerId) return null;
  const headerTime = headerTimestamp ? new Date(headerTimestamp).getTime() : NaN;
  const fallbackCreated = Number.isNaN(headerTime) ? Date.now() : headerTime;
  return {
    path: filePath,
    id: headerId,
    cwd: headerCwd,
    name,
    parentSessionPath,
    created: new Date(fallbackCreated),
    modified: new Date(
      lastActivityTime && lastActivityTime > 0 ? lastActivityTime : fallbackCreated
    ),
    messageCount,
    firstMessage: firstMessage || '(no messages)',
  };
}

/** Stat-validated, cached info for one file; re-parses only when the file changed. */
async function fileInfo(filePath: string): Promise<SessionFileInfo | null> {
  let mtimeMs: number;
  let size: number;
  try {
    const stats = await stat(filePath);
    mtimeMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    if (fileInfoCache.delete(filePath)) cacheDirty = true;
    return null;
  }
  const cached = fileInfoCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.info;
  let info: SessionFileInfo | null;
  try {
    info = await parseSessionFile(filePath);
  } catch {
    info = null;
  }
  fileInfoCache.set(filePath, { mtimeMs, size, info });
  cacheDirty = true;
  return info;
}

async function collectInfos(files: string[]): Promise<SessionFileInfo[]> {
  const results: (SessionFileInfo | null)[] = new Array(files.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_PARSES, files.length) }, async () => {
    while (next < files.length) {
      const idx = next++;
      results[idx] = await fileInfo(files[idx]);
    }
  });
  await Promise.all(workers);
  const infos = results.filter((info): info is SessionFileInfo => info !== null);
  infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return infos;
}

async function jsonlFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/** List sessions for one project cwd (default SDK session-dir layout). */
export async function scanSessionsForCwd(
  sessionsRoot: string,
  cwd: string
): Promise<SessionFileInfo[]> {
  const infos = await collectInfos(await jsonlFilesIn(join(sessionsRoot, encodeSessionDirName(cwd))));
  persistCache();
  return infos;
}

/** List sessions across every project directory under the sessions root. */
export async function scanAllSessions(sessionsRoot: string): Promise<SessionFileInfo[]> {
  let dirs: string[];
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsRoot, e.name));
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const dir of dirs) {
    files.push(...(await jsonlFilesIn(dir)));
  }
  // Drop cache entries for files that vanished so the cache can't grow unbounded.
  const live = new Set(files);
  for (const cachedPath of fileInfoCache.keys()) {
    if (!live.has(cachedPath)) {
      fileInfoCache.delete(cachedPath);
      cacheDirty = true;
    }
  }
  const infos = await collectInfos(files);
  persistCache();
  return infos;
}

/** Test hook — clears the per-file stat cache and disables persistence. */
export function clearSessionScanCache(): void {
  fileInfoCache.clear();
  cacheFilePath = null;
  cacheDirty = false;
}
