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
import type { SessionCatalog, SessionCatalogPatch } from './session-catalog';

export type ProjectCatalogPatch =
  | { kind: 'touch'; path: string }
  | { kind: 'remove'; path: string }
  | { kind: 'setPinned'; path: string; pinned: boolean }
  | { kind: 'rename'; path: string; name: string };

/** How long an existsSync result is trusted — project dirs change rarely. */
const EXISTS_TTL_MS = 30_000;
/** Debounce window for registry persistence (coalesces rapid touches). */
const PERSIST_DEBOUNCE_MS = 500;
type SessionAggregate = { count: number; lastModified: number; maxSessionId: string };
type SessionIdentity = { cwd: string; modified: number };

export class ProjectCatalog {
  private readonly listeners = new Set<() => void>();
  private persistTimer: Timer | null = null;
  private readonly existsCache = new Map<string, { exists: boolean; at: number }>();
  /** Cached session-derived values used by project list merges. */
  private readonly sessionAggregates = new Map<string, SessionAggregate>();
  /** Session identities let exact upsert/remove patches update only affected cwds. */
  private readonly sessionById = new Map<string, SessionIdentity>();
  private readonly sessionTimesByCwd = new Map<string, Map<string, number>>();
  private aggregatesInitialized = false;
  private aggregatesDirty = true;
  private aggregateRevision = 0;
  private aggregateRebuild: Promise<void> | null = null;

  constructor(private readonly sessions: SessionCatalog) {
    this.sessions.onChange((patch) => this.handleSessionChange(patch));
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
    await this.ensureAggregates();

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
    for (const [dir, agg] of this.sessionAggregates) {
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

  private handleSessionChange(patch?: SessionCatalogPatch): void {
    this.aggregateRevision++;
    if (!patch || !this.aggregatesInitialized || this.aggregatesDirty || this.aggregateRebuild) {
      this.aggregatesDirty = true;
    } else if (patch.kind === 'upsert') {
      this.applySessionUpsert(patch.session);
    } else if (patch.kind === 'remove') {
      const previous = this.sessionById.get(patch.id);
      if (!previous) this.aggregatesDirty = true;
      else {
        this.removeSession(patch.id, previous);
        this.sessionById.delete(patch.id);
      }
    } else {
      // Rename and release change disk/overlay truth in ways that cannot be
      // derived from the patch alone.
      this.aggregatesDirty = true;
    }
    this.emit();
  }

  private applySessionUpsert(session: { id: string; cwd: string; modified: Date }): void {
    const previous = this.sessionById.get(session.id);
    if (previous) this.removeSession(session.id, previous, previous.cwd !== session.cwd);
    const identity = { cwd: session.cwd, modified: session.modified.getTime() };
    this.sessionById.set(session.id, identity);
    if (!identity.cwd) return;
    let times = this.sessionTimesByCwd.get(identity.cwd);
    if (!times) {
      times = new Map();
      this.sessionTimesByCwd.set(identity.cwd, times);
    }
    times.set(session.id, identity.modified);
    this.updateAggregate(identity.cwd, times, session.id);
  }

  private removeSession(id: string, identity: SessionIdentity, updateAggregate = true): void {
    if (!identity.cwd) return;
    const times = this.sessionTimesByCwd.get(identity.cwd);
    if (!times) return;
    times.delete(id);
    if (times.size === 0) {
      this.sessionTimesByCwd.delete(identity.cwd);
      this.sessionAggregates.delete(identity.cwd);
      return;
    }
    if (updateAggregate) this.updateAggregate(identity.cwd, times);
  }

  private updateAggregate(cwd: string, times: Map<string, number>, changedId?: string): void {
    const previous = this.sessionAggregates.get(cwd);
    const changedTime = changedId === undefined ? undefined : times.get(changedId);
    if (!previous && changedId !== undefined && changedTime !== undefined) {
      this.sessionAggregates.set(cwd, {
        count: times.size,
        lastModified: changedTime,
        maxSessionId: changedId,
      });
      return;
    }
    if (
      previous &&
      changedId !== undefined &&
      changedTime !== undefined &&
      changedTime >= previous.lastModified
    ) {
      this.sessionAggregates.set(cwd, {
        count: times.size,
        lastModified: changedTime,
        maxSessionId: changedId,
      });
      return;
    }
    if (previous && times.get(previous.maxSessionId) === previous.lastModified) {
      this.sessionAggregates.set(cwd, { ...previous, count: times.size });
      return;
    }
    let maxSessionId = '';
    let lastModified = -Infinity;
    for (const [id, modified] of times) {
      if (modified > lastModified) {
        lastModified = modified;
        maxSessionId = id;
      }
    }
    this.sessionAggregates.set(cwd, { count: times.size, lastModified, maxSessionId });
  }

  private async ensureAggregates(): Promise<void> {
    while (!this.aggregatesInitialized || this.aggregatesDirty) {
      if (!this.aggregateRebuild) {
        const revision = this.aggregateRevision;
        const rebuild = (async () => {
          const sessions = await this.sessions.list();
          if (revision !== this.aggregateRevision) return;

          this.sessionAggregates.clear();
          this.sessionById.clear();
          this.sessionTimesByCwd.clear();
          for (const session of sessions) this.applySessionUpsert(session);
          this.aggregatesInitialized = true;
          this.aggregatesDirty = false;
        })();
        this.aggregateRebuild = rebuild;
        void rebuild.then(
          () => {
            if (this.aggregateRebuild === rebuild) this.aggregateRebuild = null;
          },
          () => {
            if (this.aggregateRebuild === rebuild) this.aggregateRebuild = null;
          }
        );
      }
      await this.aggregateRebuild;
    }
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
