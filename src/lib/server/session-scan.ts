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

import { createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { open, readdir, rename, stat, writeFile } from 'node:fs/promises';
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
  lastModel?: { provider: string; modelId: string };
  totalCost?: number;
  totalTokens?: number;
  labelCount?: number;
}

/** Concurrent file parses. Deliberately low: bounds peak RSS during a cold scan. */
const MAX_CONCURRENT_PARSES = 4;

/** Cap firstMessage preview length — it only feeds sidebar previews. */
const FIRST_MESSAGE_MAX_CHARS = 500;

interface CachedFileInfo {
  mtimeMs: number;
  size: number;
  info: SessionFileInfo | null;
  /** Device/inode/fold captured the last time this process fully parsed the
   *  file. Undefined right after loading the persisted cache (a restart) —
   *  the first change to the file after a restart always does one full
   *  re-parse, which populates these and enables incremental appends again. */
  dev?: number;
  ino?: number;
  fold?: SessionScanFold;
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
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('version' in parsed) ||
      parsed.version !== 2 ||
      !('entries' in parsed) ||
      !Array.isArray(parsed.entries)
    )
      return;
    for (const raw of parsed.entries) {
      if (!Array.isArray(raw) || raw.length !== 7) continue;
      const [path, mtimeMs, size, dev, ino, info, foldValue] = raw;
      if (typeof path !== 'string' || typeof mtimeMs !== 'number' || typeof size !== 'number')
        continue;
      const revived = reviveInfo(info);
      if (revived) {
        revived.path = resolve(path);
        revived.modified = new Date(mtimeMs);
      }
      fileInfoCache.set(resolve(path), {
        mtimeMs,
        size,
        info: revived,
        dev: typeof dev === 'number' ? dev : undefined,
        ino: typeof ino === 'number' ? ino : undefined,
        fold: reviveFold(foldValue) ?? undefined,
      });
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
  const lastModel =
    record.lastModel &&
    typeof record.lastModel === 'object' &&
    typeof (record.lastModel as Record<string, unknown>).provider === 'string' &&
    typeof (record.lastModel as Record<string, unknown>).modelId === 'string'
      ? {
          provider: (record.lastModel as Record<string, string>).provider,
          modelId: (record.lastModel as Record<string, string>).modelId,
        }
      : undefined;
  return {
    path: record.path,
    id: record.id,
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
    name: typeof record.name === 'string' ? record.name : undefined,
    parentSessionPath:
      typeof record.parentSessionPath === 'string' ? record.parentSessionPath : undefined,
    created: new Date(typeof record.created === 'number' ? record.created : 0),
    modified: new Date(typeof record.modified === 'number' ? record.modified : 0),
    messageCount: typeof record.messageCount === 'number' ? record.messageCount : 0,
    firstMessage: typeof record.firstMessage === 'string' ? record.firstMessage : '',
    lastModel,
    totalCost: typeof record.totalCost === 'number' ? record.totalCost : undefined,
    totalTokens: typeof record.totalTokens === 'number' ? record.totalTokens : undefined,
    labelCount: typeof record.labelCount === 'number' ? record.labelCount : undefined,
  };
}
function reviveFold(raw: unknown): SessionScanFold | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.headerCwd !== 'string' ||
    typeof value.sawHeader !== 'boolean' ||
    typeof value.rejected !== 'boolean' ||
    typeof value.messageCount !== 'number' ||
    typeof value.firstMessage !== 'string' ||
    typeof value.totalCost !== 'number' ||
    typeof value.totalTokens !== 'number' ||
    typeof value.labelCount !== 'number' ||
    !value.labels ||
    typeof value.labels !== 'object'
  )
    return null;
  const lastModel =
    value.lastModel &&
    typeof value.lastModel === 'object' &&
    typeof (value.lastModel as Record<string, unknown>).provider === 'string' &&
    typeof (value.lastModel as Record<string, unknown>).modelId === 'string'
      ? {
          provider: (value.lastModel as Record<string, string>).provider,
          modelId: (value.lastModel as Record<string, string>).modelId,
        }
      : undefined;
  return {
    headerId: typeof value.headerId === 'string' ? value.headerId : undefined,
    headerCwd: value.headerCwd,
    headerTimestamp: typeof value.headerTimestamp === 'string' ? value.headerTimestamp : undefined,
    parentSessionPath:
      typeof value.parentSessionPath === 'string' ? value.parentSessionPath : undefined,
    sawHeader: value.sawHeader,
    rejected: value.rejected,
    name: typeof value.name === 'string' ? value.name : undefined,
    messageCount: value.messageCount,
    firstMessage: value.firstMessage,
    lastModel,
    totalCost: value.totalCost,
    totalTokens: value.totalTokens,
    labels: value.labels as Record<string, string>,
    labelCount: value.labelCount,
  };
}

let persistTimer: Timer | null = null;
let cacheWritePromise: Promise<void> | null = null;
let cacheGeneration = 0;
let cacheInvalidationGeneration = 0;

/**
 * Mark the cache dirty and schedule an atomic write. Debounced so a burst of
 * scans (e.g. one per message_end) coalesces into a single disk write, and
 * async so the write never blocks the scan path (the old sync write could
 * serialize a multi-MB cache file on the refresh path).
 */
function schedulePersist(): void {
  cacheDirty = true;
  cacheGeneration++;
  if (persistTimer || cacheWritePromise) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistCache();
  }, 500);
}

/** Atomic tmp+rename write. The file is small (~1 KB per session). */
async function persistCache(): Promise<void> {
  if (cacheWritePromise) return cacheWritePromise;
  if (!cacheFilePath || !cacheDirty) return;

  const run = (async () => {
    let failed = false;
    try {
      do {
        const generation = cacheGeneration;
        const filePath = cacheFilePath;
        if (!filePath) break;
        const entries = [...fileInfoCache].map(([path, c]) => [
          path,
          c.mtimeMs,
          c.size,
          c.dev,
          c.ino,
          c.info
            ? { ...c.info, created: c.info.created.getTime(), modified: c.info.modified.getTime() }
            : null,
          c.fold,
        ]);
        mkdirSync(dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp`;
        await writeFile(tmp, JSON.stringify({ version: 2, entries }));
        await rename(tmp, filePath);
        // A scan can mutate the cache while the write is awaited. Keep the
        // dirty bit set for that newer generation so the loop persists it too.
        if (cacheGeneration === generation) cacheDirty = false;
      } while (cacheDirty);
    } catch (err) {
      failed = true;
      log.error('[pifrontier] session-scan cache: failed to save:', err);
    } finally {
      cacheWritePromise = null;
      if (!failed && cacheDirty && !persistTimer) {
        persistTimer = setTimeout(() => {
          persistTimer = null;
          void persistCache();
        }, 500);
      }
    }
  })();
  cacheWritePromise = run;
  await run;
}

/** Flush any pending cache write — call on shutdown and in tests. */
export async function flushSessionScanCache(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistCache();
}

/**
 * Directory name the SDK encodes a project cwd into under the sessions root
 * (see getDefaultSessionDirPath in the SDK's session-manager).
 */
export function encodeSessionDirName(cwd: string): string {
  const resolved = resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

export function firstTextContent(message: object): string {
  const record = message as Record<string, unknown>;
  const content = record.content;
  if (typeof content === 'string') {
    const text = content.replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, FIRST_MESSAGE_MAX_CHARS);
  }
  const candidates: string[] = [];
  const addCandidate = (value: unknown) => {
    if (typeof value !== 'string') return;
    const text = value.replace(/\s+/g, ' ').trim();
    if (text) candidates.push(text);
  };
  addCandidate(record.text);
  addCandidate(record.thinking);
  addCandidate(record.reasoning);
  addCandidate(record.summary);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const blockRecord = block as Record<string, unknown>;
      if (blockRecord.type === 'thinking') addCandidate(blockRecord.thinking);
      else if (blockRecord.type === 'text') addCandidate(blockRecord.text);
    }
  }
  return candidates[0]?.slice(0, FIRST_MESSAGE_MAX_CHARS) ?? '';
}
interface SessionScanFold {
  headerId: string | undefined;
  headerCwd: string;
  headerTimestamp: string | undefined;
  parentSessionPath: string | undefined;
  sawHeader: boolean;
  rejected: boolean;
  name: string | undefined;
  messageCount: number;
  firstMessage: string;
  lastModel: { provider: string; modelId: string } | undefined;
  totalCost: number;
  totalTokens: number;
  labels: Record<string, string>;
  labelCount: number;
}

function createEmptyFold(): SessionScanFold {
  return {
    headerId: undefined,
    headerCwd: '',
    headerTimestamp: undefined,
    parentSessionPath: undefined,
    sawHeader: false,
    rejected: false,
    name: undefined,
    messageCount: 0,
    firstMessage: '',
    lastModel: undefined,
    totalCost: 0,
    totalTokens: 0,
    labels: {},
    labelCount: 0,
  };
}

function strField(obj: object, key: string): string | undefined {
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Fold one line into `fold`, mutating it in place. */
function foldSessionLine(fold: SessionScanFold, line: string): void {
  if (fold.rejected || !line.trim()) return;
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (!entry || typeof entry === 'boolean' || typeof entry !== 'object') return;
  const type = strField(entry, 'type');
  if (!fold.sawHeader) {
    if (type !== 'session') {
      fold.rejected = true;
      return;
    }
    fold.sawHeader = true;
    fold.headerId = strField(entry, 'id');
    fold.headerCwd = strField(entry, 'cwd') ?? '';
    fold.headerTimestamp = strField(entry, 'timestamp');
    fold.parentSessionPath = strField(entry, 'parentSession');
    return;
  }
  if (type === 'session_info') {
    fold.name = strField(entry, 'name')?.trim() || undefined;
    return;
  }
  if (type === 'model_change') {
    const provider = strField(entry, 'provider');
    const modelId = strField(entry, 'modelId');
    if (provider && modelId) fold.lastModel = { provider, modelId };
    return;
  }
  if (type === 'label') {
    const targetId = strField(entry, 'targetId');
    if (!targetId) return;
    const label = strField(entry, 'label');
    const hadLabel = Object.hasOwn(fold.labels, targetId);
    if (label) {
      fold.labels[targetId] = label;
      if (!hadLabel) fold.labelCount++;
    } else if (hadLabel) {
      delete fold.labels[targetId];
      fold.labelCount--;
    }
    return;
  }
  if (type !== 'message') return;
  const message = 'message' in entry ? entry.message : undefined;
  if (!message || typeof message !== 'object') return;
  const role = strField(message, 'role');
  if (role !== 'user' && role !== 'assistant') return;
  fold.messageCount++;
  if (!fold.firstMessage && role === 'user') fold.firstMessage = firstTextContent(message);
  if (role !== 'assistant') return;
  const provider = strField(message, 'provider');
  const modelId = strField(message, 'model');
  if (provider && modelId) fold.lastModel = { provider, modelId };
  const usage = 'usage' in message ? message.usage : undefined;
  if (!usage || typeof usage !== 'object') return;
  const cost = 'cost' in usage ? usage.cost : undefined;
  if (cost && typeof cost === 'object' && 'total' in cost) {
    const total = cost.total;
    if (typeof total === 'number' && Number.isFinite(total)) fold.totalCost += total;
  }
  if ('totalTokens' in usage && typeof usage.totalTokens === 'number')
    fold.totalTokens += usage.totalTokens;
}
/** Stream `filePath` from `startByte` (default 0) through `fold`, mutating
 *  it in place. Stops as soon as the file is rejected — matching the
 *  original single-return-null behavior — instead of reading the rest of
 *  a non-session file. */
async function foldSessionFileFrom(
  filePath: string,
  fold: SessionScanFold,
  startByte = 0
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8', start: startByte }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      foldSessionLine(fold, line);
      if (fold.rejected) break;
    }
  } finally {
    rl.close();
  }
}

/** Build the public summary from a completed fold, or null when the file
 *  was never a valid session (no header, or the first line rejected it). */
function summaryFromFold(
  fold: SessionScanFold,
  filePath: string,
  mtimeMs: number
): SessionFileInfo | null {
  if (fold.rejected || !fold.sawHeader || !fold.headerId) return null;
  const headerTime = fold.headerTimestamp ? new Date(fold.headerTimestamp).getTime() : NaN;
  const fallbackCreated = Number.isNaN(headerTime) ? Date.now() : headerTime;
  return {
    path: filePath,
    id: fold.headerId,
    cwd: fold.headerCwd,
    name: fold.name,
    parentSessionPath: fold.parentSessionPath,
    created: new Date(fallbackCreated),
    modified: new Date(mtimeMs),
    messageCount: fold.messageCount,
    firstMessage: fold.firstMessage || '(no messages)',
    lastModel: fold.lastModel,
    totalCost: fold.totalCost || undefined,
    totalTokens: fold.totalTokens || undefined,
    labelCount: fold.labelCount || undefined,
  };
}

/** Parse one session .jsonl streaming from byte 0; returns null info for
 *  non-session files. Always returns the fold so the caller can cache it
 *  for a future incremental extension. */
async function parseSessionFile(
  filePath: string,
  mtimeMs: number
): Promise<{ info: SessionFileInfo | null; fold: SessionScanFold }> {
  const fold = createEmptyFold();
  await foldSessionFileFrom(filePath, fold);
  return { info: summaryFromFold(fold, filePath, mtimeMs), fold };
}

/** Stat-validated, cached info for one file. An append-only change (same
 *  device/inode, larger size) extends the cached fold from its previous
 *  end-of-file instead of re-parsing from byte 0; any other change (new
 *  file, shrink, identity change, or a failed extension attempt) does a
 *  full re-parse. */
async function fileInfo(filePath: string): Promise<SessionFileInfo | null> {
  const canonicalPath = resolve(filePath);
  const operationGeneration = cacheInvalidationGeneration;
  let stats: { dev: number; ino: number; mtimeMs: number; size: number };
  try {
    const s = await stat(canonicalPath);
    stats = { dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    // A transient stat failure must not discard a previously valid entry.
    return null;
  }
  const cached = fileInfoCache.get(canonicalPath);
  if (
    cached &&
    cached.mtimeMs === stats.mtimeMs &&
    cached.size === stats.size &&
    cached.dev === stats.dev &&
    cached.ino === stats.ino
  ) {
    return cached.info;
  }

  if (
    cached?.fold &&
    cached.dev === stats.dev &&
    cached.ino === stats.ino &&
    stats.size > cached.size
  ) {
    const cachedWithFold = cached as CachedFileInfo & {
      fold: SessionScanFold;
      dev: number;
      ino: number;
    };
    const extended = await tryExtendFold(canonicalPath, cachedWithFold, stats);
    if (extended) {
      if (cacheInvalidationGeneration === operationGeneration) {
        fileInfoCache.set(canonicalPath, extended);
        schedulePersist();
      }
      return extended.info;
    }
  }

  let result: { info: SessionFileInfo | null; fold: SessionScanFold };
  try {
    result = await parseSessionFile(canonicalPath, stats.mtimeMs);
  } catch {
    // Do not poison a good cache entry with a transient read/parse failure.
    return null;
  }
  if (cacheInvalidationGeneration === operationGeneration) {
    fileInfoCache.set(canonicalPath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      info: result.info,
      dev: stats.dev,
      ino: stats.ino,
      fold: result.fold,
    });
    schedulePersist();
  }
  return result.info;
}
/**
 * Attempt to extend a cached fold with only the bytes appended since
 * `cached.size`. Verifies the byte immediately before that offset is a
 * newline, proving the cached prefix still ends on a line boundary in the
 * file's current content — the one case identity+size cannot rule out on
 * their own. Returns undefined (caller falls back to a full re-parse)
 * when the fold is already permanently rejected, the boundary check
 * fails, the handle can't be opened, or the read comes back short.
 */
async function tryExtendFold(
  filePath: string,
  cached: CachedFileInfo & { fold: SessionScanFold; dev: number; ino: number },
  stats: { dev: number; ino: number; mtimeMs: number; size: number }
): Promise<CachedFileInfo | undefined> {
  if (cached.fold.rejected) return undefined;
  if (cached.size > 0) {
    let handle;
    try {
      handle = await open(filePath, 'r');
    } catch {
      return undefined;
    }
    try {
      const boundary = Buffer.alloc(1);
      const { bytesRead } = await handle.read(boundary, 0, 1, cached.size - 1);
      if (bytesRead !== 1 || boundary[0] !== 0x0a) return undefined;
    } finally {
      await handle.close();
    }
  }
  const fold: SessionScanFold = { ...cached.fold, labels: { ...cached.fold.labels } };
  try {
    await foldSessionFileFrom(filePath, fold, cached.size);
  } catch {
    return undefined;
  }
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    info: summaryFromFold(fold, filePath, stats.mtimeMs),
    dev: stats.dev,
    ino: stats.ino,
    fold,
  };
}

/**
 * Targeted lookup for ONE session file — stat + parse of a single path with
 * the same per-file cache. Validates a switch target without forcing a full
 * store rescan (the old fallback re-read every project directory).
 */
export async function sessionFileInfo(filePath: string): Promise<SessionFileInfo | null> {
  return fileInfo(filePath);
}

/**
 * Invalidate cached per-file summaries. A generation fence prevents an
 * in-flight parse from repopulating an entry after its path was invalidated.
 */
export function invalidateSessionScanCache(paths?: readonly string[]): void {
  cacheInvalidationGeneration++;
  if (!paths) {
    fileInfoCache.clear();
  } else {
    for (const path of paths) fileInfoCache.delete(resolve(path));
  }
  schedulePersist();
}

async function collectInfos(files: string[]): Promise<SessionFileInfo[]> {
  const results: (SessionFileInfo | null)[] = new Array(files.length).fill(null);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_PARSES, files.length) },
    async () => {
      while (next < files.length) {
        const idx = next++;
        results[idx] = await fileInfo(files[idx]);
      }
    }
  );
  await Promise.all(workers);
  const infos = results.filter((info): info is SessionFileInfo => info !== null);
  infos.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return infos;
}

async function jsonlFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => join(dir, e.name));
    // Subagent task sessions live beside their parent file: a directory
    // named after the parent's file stem holds one tasks/ subdir with one
    // file per spawned task. Without this walk those sessions never reach
    // the sidebar at all.
    const taskLists = await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          try {
            const taskDir = join(dir, e.name, 'tasks');
            return (await readdir(taskDir))
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => join(taskDir, f));
          } catch (nestedErr) {
            if ((nestedErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
              log.error(
                `[pifrontier] cannot scan task sessions in ${join(dir, e.name)}:`,
                nestedErr
              );
            }
            return [];
          }
        })
    );
    for (const list of taskLists) files.push(...list);
    return files;
  } catch (err) {
    // Deleted-between-scans is a normal race; anything else is an operator
    // error (permissions) — log it instead of silently dropping the project.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    log.error(`[pifrontier] cannot scan sessions in ${dir}:`, err);
    return [];
  }
}

/**
 * List sessions across every project directory under the sessions root.
 * `skipPaths` excludes files from the scan entirely (no stat, no parse) —
 * the session catalog uses it for pooled sessions whose live summaries are
 * authoritative; their per-file cache entries are kept so a later release
 * falls back to a cheap stat-only re-check.
 */
export async function scanAllSessions(
  sessionsRoot: string,
  opts?: { skipPaths?: Set<string> }
): Promise<SessionFileInfo[]> {
  let dirs: string[];
  try {
    const entries = await readdir(sessionsRoot, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsRoot, e.name));
  } catch (err) {
    // A missing root is a fresh install (legitimately no sessions); anything
    // else (permissions, corrupt mount) must surface instead of silently
    // masquerading as an empty sidebar.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  let files: string[] = [];
  // Project dirs are independent — read them concurrently (the per-file stat
  // cache keeps the work cheap, but serial readdirs add latency on cold scans
  // with many projects).
  const dirFileLists = await Promise.all(dirs.map((dir) => jsonlFilesIn(dir)));
  for (const list of dirFileLists) files.push(...list);
  const skipPaths = opts?.skipPaths;
  const canonicalSkipPaths = skipPaths && new Set([...skipPaths].map((path) => resolve(path)));
  if (canonicalSkipPaths?.size) files = files.filter((f) => !canonicalSkipPaths.has(resolve(f)));
  // Drop cache entries for files that vanished so the cache can't grow
  // unbounded. Skipped (pooled) files still exist on disk — keep their
  // entries so a release falls back to a stat-only check.
  const live = new Set(files.map((file) => resolve(file)));
  if (canonicalSkipPaths) {
    for (const p of canonicalSkipPaths) live.add(p);
  }
  for (const cachedPath of fileInfoCache.keys()) {
    if (!live.has(cachedPath)) {
      fileInfoCache.delete(cachedPath);
      schedulePersist();
    }
  }
  return collectInfos(files);
}
export function clearSessionScanCache(): void {
  cacheInvalidationGeneration++;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  fileInfoCache.clear();
  cacheFilePath = null;
  cacheDirty = false;
}
