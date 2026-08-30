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
import { log } from './logger';

/** Coalesce bursts of appends (a turn writes many lines) into one rescan. */
const DEBOUNCE_MS = 500;

/**
 * Watch the sessions root recursively; call `onDirty` (debounced) whenever a
 * session file changes. Fire-and-forget best effort: if the watch cannot be
 * established, log and give up — scans still work, just not live.
 */
export function startSessionWatch(getRoot: () => string, onDirty: () => void): void {
  let root: string;
  try {
    root = getRoot();
  } catch {
    return; // SDK not loaded yet — nothing to watch.
  }
  let timer: Timer | null = null;
  let watcher: FSWatcher;
  try {
    // Fresh installs have no sessions dir until the first session is created.
    mkdirSync(root, { recursive: true });
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && !filename.endsWith('.jsonl')) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        onDirty();
      }, DEBOUNCE_MS);
    });
  } catch (err) {
    log.warn('[pifrontier] session watcher: not watching', root, '-', err);
    return;
  }
  watcher.on('error', (err) => {
    log.warn('[pifrontier] session watcher error:', err);
  });
}
