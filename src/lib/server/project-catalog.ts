/**
 * Project catalog — single source of truth for the merged project list
 * served to the sidebar and project picker.
 *
 * Mirrors the session catalog's shape: all mutations through `apply()`
 * (single write chokepoint), reads through `list()`, change notification
 * via `onChange()` — and it is transport-agnostic (no WebSocket knowledge).
 *
 * Composition:
 * - `project-registry.ts` is the byte-level module: cached load + atomic
 *   sync save of the persisted registry.
 * - This catalog owns the registry semantics (upsert/touch/pin/rename),
 *   debounces persistence so session switches never block the critical
 *   path with a sync write, and merges registry records with live
 *   per-project session counts from the session catalog.
 * - It subscribes to the session catalog's changes so the merged view
 *   (counts, recency) re-derives without server.ts wiring it up.
 */

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { loadProjectRecords, saveProjectRecords, type ProjectRecord } from './project-registry';
import type { ProjectInfo } from '../ws/protocol';
import type { SessionCatalog } from './session-catalog';

export type ProjectCatalogPatch =
  | { kind: 'touch'; path: string }
  | { kind: 'remove'; path: string }
  | { kind: 'setPinned'; path: string; pinned: boolean }
  | { kind: 'rename'; path: string; name: string };

/** How long an existsSync result is trusted — project dirs change rarely. */
const EXISTS_TTL_MS = 30_000;
/** Debounce window for registry persistence (coalesces rapid touches). */
const PERSIST_DEBOUNCE_MS = 500;

export class ProjectCatalog {
  private readonly listeners = new Set<() => void>();
  private persistTimer: Timer | null = null;
  private readonly existsCache = new Map<string, { exists: boolean; at: number }>();

  constructor(private readonly sessions: SessionCatalog) {
    // Session activity changes per-project counts and recency — re-derive
    // and notify so the merged view stays fresh without server.ts wiring.
    this.sessions.onChange(() => this.emit());
  }

  /** Single write chokepoint for all project-registry mutations. */
  apply(patch: ProjectCatalogPatch): void {
    const records = loadProjectRecords();
    const now = Date.now();
    switch (patch.kind) {
      case 'touch': {
        const existing = records.find((r) => r.path === patch.path);
        if (existing) existing.lastOpened = now;
        else records.push({ path: patch.path, pinned: false, lastOpened: now });
        // The touch flow created/confirmed the directory.
        this.existsCache.set(patch.path, { exists: true, at: now });
        break;
      }
      case 'remove': {
        const idx = records.findIndex((r) => r.path === patch.path);
        if (idx !== -1) records.splice(idx, 1);
        this.existsCache.delete(patch.path);
        break;
      }
      case 'setPinned': {
        const existing = records.find((r) => r.path === patch.path);
        if (existing) existing.pinned = patch.pinned;
        else records.push({ path: patch.path, pinned: patch.pinned, lastOpened: now });
        break;
      }
      case 'rename': {
        const existing = records.find((r) => r.path === patch.path);
        if (existing) existing.name = patch.name.trim() ? patch.name : undefined;
        else
          records.push({
            path: patch.path,
            pinned: false,
            lastOpened: now,
            name: patch.name.trim() || undefined,
          });
        break;
      }
    }
    this.schedulePersist(records);
    this.emit();
  }

  /**
   * Merged project list: registry records + live session counts, sorted
   * pinned-first then by most recent activity.
   */
  async list(): Promise<ProjectInfo[]> {
    const sessions = await this.sessions.list();
    const byCwd = new Map<string, { count: number; lastModified: number }>();
    for (const s of sessions) {
      if (!s.cwd) continue;
      const agg = byCwd.get(s.cwd);
      if (agg) {
        agg.count += 1;
        agg.lastModified = Math.max(agg.lastModified, s.modified.getTime());
      } else {
        byCwd.set(s.cwd, { count: 1, lastModified: s.modified.getTime() });
      }
    }

    const map = new Map<string, ProjectInfo>();
    for (const rec of loadProjectRecords()) {
      map.set(rec.path, {
        cwd: rec.path,
        name: rec.name ?? basename(rec.path),
        pinned: rec.pinned,
        exists: this.exists(rec.path),
        registered: true,
        sessionCount: 0,
        lastActivity: rec.lastOpened,
      });
    }
    for (const [dir, agg] of byCwd) {
      const entry = map.get(dir);
      if (entry) {
        entry.sessionCount = agg.count;
        entry.lastActivity = Math.max(entry.lastActivity, agg.lastModified);
      } else {
        map.set(dir, {
          cwd: dir,
          name: basename(dir) || dir,
          pinned: false,
          exists: this.exists(dir),
          registered: false,
          sessionCount: agg.count,
          lastActivity: agg.lastModified,
        });
      }
    }

    // Drop existence probes for paths no longer in the merged set — one-off
    // historical session dirs would otherwise grow the cache without bound.
    for (const key of this.existsCache.keys()) {
      if (!map.has(key)) this.existsCache.delete(key);
    }

    return [...map.values()].sort((a, b) =>
      a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.lastActivity - a.lastActivity
    );
  }

  /** Subscribe to list changes; returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Flush any pending registry write — call on shutdown and in tests. */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      saveProjectRecords(loadProjectRecords());
    }
  }

  private schedulePersist(records: ProjectRecord[]): void {
    if (this.persistTimer) return;
    // All applies mutate the same module-cached array, so capturing the
    // first reference writes the latest state when the timer fires.
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      saveProjectRecords(records);
    }, PERSIST_DEBOUNCE_MS);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  private exists(path: string): boolean {
    const now = Date.now();
    const cached = this.existsCache.get(path);
    if (cached && now - cached.at < EXISTS_TTL_MS) return cached.exists;
    const e = existsSync(path);
    this.existsCache.set(path, { exists: e, at: now });
    return e;
  }
}
