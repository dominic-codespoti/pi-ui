/**
 * Live invalidation for the session catalog's disk scan.
 *
 * Sessions appended by processes pi-ui doesn't hold open (subagent sessions,
 * parallel CLI instances) only surfaced in the sidebar when an unrelated
 * structural change (rename/remove/release) happened to force a rescan —
 * timestamps and ordering jumped at arbitrary moments. A recursive fs.watch
 * on the sessions root turns those appends into prompt, debounced scan
 * invalidations instead.
 */
import { mkdirSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { log } from './logger';

/** Coalesce bursts of appends into one rescan, with a bound for continuous streams. */
const DEBOUNCE_MS = 500;
const MAX_DELAY_MS = 5_000;

/**
 * Watch the sessions root recursively; call `onDirty` (debounced) whenever a
 * session file changes. Fire-and-forget best effort: if the watch cannot be
 * established, log and give up — scans still work, just not live.
 */
export function startSessionWatch(
  getRoot: () => string,
  onDirty: () => void,
  isIgnored?: (absolutePath: string) => boolean
): (() => void) | undefined {
  let root: string;
  try {
    root = getRoot();
  } catch {
    return undefined; // SDK not loaded yet — nothing to watch.
  }
  let timer: Timer | null = null;
  let windowStartedAt: number | null = null;
  let watcher: FSWatcher;
  try {
    mkdirSync(root, { recursive: true });
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename) {
        const name = filename.toString();
        if (!name.endsWith('.jsonl')) return;
        if (isIgnored?.(resolve(root, name))) return;
      }

      const now = Date.now();
      if (windowStartedAt === null) windowStartedAt = now;
      if (timer) clearTimeout(timer);
      const remaining = MAX_DELAY_MS - (now - windowStartedAt);
      if (remaining <= 0) {
        timer = null;
        windowStartedAt = now;
        onDirty();
        return;
      }
      timer = setTimeout(
        () => {
          timer = null;
          windowStartedAt = null;
          onDirty();
        },
        Math.min(DEBOUNCE_MS, remaining)
      );
    });
  } catch (err) {
    log.warn('[pifrontier] session watcher: not watching', root, '-', err);
    return undefined;
  }
  watcher.on('error', (err) => {
    log.warn('[pifrontier] session watcher error:', err);
  });
  return () => {
    if (timer) clearTimeout(timer);
    timer = null;
    windowStartedAt = null;
    watcher.close();
  };
}
