/**
 * Session catalog — single source of truth for the merged session list
 * served to the sidebar, project picker, and resume dialog.
 *
 * Layering:
 * - `session-scan.ts` is the byte-level module: stat/parse every session
 *   .jsonl with a persisted per-file (mtime, size) cache.
 * - This catalog composes the disk scan with a live overlay for pooled
 *   sessions (the ones the server holds AgentSession state for). Overlay
 *   entries win over disk while present, so the active session's file is
 *   never re-read after every message — the old design invalidated the whole
 *   scan on every `message_end` and re-parsed the growing file from byte 0.
 *
 * All mutations flow through `apply()` (single write chokepoint); all reads
 * through `list()`/`listForCwd()`. Consumers subscribe via `onChange()` and
 * own their own broadcast scheduling — the catalog is transport-agnostic.
 */

import { scanAllSessions, type SessionFileInfo } from './session-scan';

export type SessionCatalogPatch =
  | { kind: 'upsert'; session: SessionFileInfo }
  | { kind: 'rename'; path: string; name: string }
  | { kind: 'remove'; path: string }
  | { kind: 'release'; id: string };

/** Marker for pooled sessions that have no file on disk (never persisted). */
const IN_MEMORY_PATH = '(in-memory)';

export class SessionCatalog {
  /** Live summaries for pooled sessions, keyed by session id. */
  private readonly overlay = new Map<string, SessionFileInfo>();
  /**
   * Last-known creation timestamps, keyed by session id. Memory state has no
   * creation time, so upserts preserve the value first seen from disk (or
   * the first upsert), instead of drifting to "now" on every message.
   */
  private readonly createdById = new Map<string, Date>();
  /** Promise-cached disk scan; dropped only on structural changes. */
  private scanPromise: Promise<SessionFileInfo[]> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly sessionsRoot: () => string) {}

  /** Single write chokepoint for all session-list mutations. */
  apply(patch: SessionCatalogPatch): void {
    switch (patch.kind) {
      case 'upsert': {
        const prevCreated = this.createdById.get(patch.session.id);
        if (prevCreated) patch.session.created = prevCreated;
        this.createdById.set(patch.session.id, patch.session.created);
        this.overlay.set(patch.session.id, patch.session);
        break;
      }
      case 'rename': {
        for (const [id, s] of this.overlay) {
          if (s.path === patch.path) this.overlay.set(id, { ...s, name: patch.name });
        }
        // Disk truth changed too (a session_info entry was appended) — the
        // next scan re-parses that one file via the per-file stat cache.
        this.scanPromise = null;
        break;
      }
      case 'remove': {
        for (const [id, s] of this.overlay) {
          if (s.path === patch.path) {
            this.overlay.delete(id);
            this.createdById.delete(id);
          }
        }
        this.scanPromise = null;
        break;
      }
      case 'release': {
        // Disk takes over — drop the cached scan too, or the merged list
        // would keep the stale pre-pool result (or the skip-filtered one
        // that excluded the file entirely). The re-scan is stat-only warm
        // for unchanged files and re-parses just the released one.
        this.overlay.delete(patch.id);
        this.createdById.delete(patch.id);
        this.scanPromise = null;
        break;
      }
    }
    for (const cb of this.listeners) cb();
  }

  /**
   * Merged, sorted session list (most recent activity first).
   * `fresh: true` bypasses the scan cache — used when a caller must not
   * accept stale disk truth (e.g. switch_session security validation).
   */
  async list(opts: { fresh?: boolean } = {}): Promise<SessionFileInfo[]> {
    if (!this.scanPromise || opts.fresh) {
      const promise = scanAllSessions(this.sessionsRoot(), { skipPaths: this.skipPaths() });
      this.scanPromise = promise;
      // Never cache a failed scan.
      promise.catch(() => {
        if (this.scanPromise === promise) this.scanPromise = null;
      });
    }
    const scanned = await this.scanPromise;
    for (const s of scanned) {
      if (!this.createdById.has(s.id)) this.createdById.set(s.id, s.created);
    }
    const merged = new Map(scanned.map((s) => [s.id, s]));
    for (const [id, info] of this.overlay) merged.set(id, info);
    // Prune creation timestamps for sessions that no longer exist on disk or
    // in the overlay — deleted sessions would otherwise accumulate forever.
    for (const id of this.createdById.keys()) {
      if (!merged.has(id)) this.createdById.delete(id);
    }
    return [...merged.values()].sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  /** All sessions for one project directory (derived from the merged list). */
  async listForCwd(cwd: string): Promise<SessionFileInfo[]> {
    const all = await this.list();
    return all.filter((s) => s.cwd === cwd);
  }

  /** Subscribe to list changes; returns an unsubscribe function. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Files the disk scan must skip — pooled sessions are overlay-authoritative. */
  private skipPaths(): Set<string> | undefined {
    const paths = new Set<string>();
    for (const info of this.overlay.values()) {
      if (info.path && info.path !== IN_MEMORY_PATH) paths.add(info.path);
    }
    return paths.size > 0 ? paths : undefined;
  }
}
