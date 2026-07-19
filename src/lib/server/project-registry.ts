/**
 * Persisted project registry — makes projects first-class on the server
 * instead of an emergent client-side grouping of session cwds.
 *
 * SERVER-ONLY: imported by server.ts. Never import from browser code.
 *
 * Stored as a small JSON file at ~/.pi/agent/pi-ui-projects.json:
 *   { "projects": [{ "path", "name"?, "pinned", "lastOpened" }] }
 *
 * Writes are synchronous + atomic (tmp file + rename) — the file is tiny and
 * mutations are rare (open/pin/rename/forget), so this is cheap even on a Pi.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './logger';

export interface ProjectRecord {
  /** Absolute, resolved path of the project directory. */
  path: string;
  /** Optional custom display name (falls back to basename when absent). */
  name?: string;
  pinned: boolean;
  /** Unix ms when the project was last opened in pi-ui. */
  lastOpened: number;
}

const REGISTRY_DIR = join(homedir(), '.pi', 'agent');
const REGISTRY_FILE = join(REGISTRY_DIR, 'pi-ui-projects.json');

let records: ProjectRecord[] | null = null;

function load(): ProjectRecord[] {
  if (records) return records;
  try {
    if (existsSync(REGISTRY_FILE)) {
      const parsed = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as { projects?: unknown };
      if (Array.isArray(parsed.projects)) {
        records = (parsed.projects as Record<string, unknown>[])
          .filter((p) => typeof p.path === 'string' && p.path.length > 0)
          .map((p) => ({
            path: p.path as string,
            name: typeof p.name === 'string' && p.name.trim() ? (p.name as string) : undefined,
            pinned: Boolean(p.pinned),
            lastOpened: typeof p.lastOpened === 'number' ? (p.lastOpened as number) : 0,
          }));
        return records;
      }
    }
  } catch (err) {
    log.error('[pifrontier] project registry: failed to load, starting empty:', err);
  }
  records = [];
  return records;
}

function save(): void {
  if (!records) return;
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true });
    const tmp = `${REGISTRY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ projects: records }, null, 2));
    renameSync(tmp, REGISTRY_FILE);
  } catch (err) {
    log.error('[pifrontier] project registry: failed to save:', err);
  }
}

/** All registered projects (no particular order — callers sort). */
export function listProjects(): readonly ProjectRecord[] {
  return load();
}

/**
 * Upsert a project and stamp lastOpened. Called whenever a session is
 * created or switched into a directory, so opening a folder registers it.
 */
export function touchProject(path: string): ProjectRecord {
  const all = load();
  let rec = all.find((r) => r.path === path);
  if (rec) {
    rec.lastOpened = Date.now();
  } else {
    rec = { path, pinned: false, lastOpened: Date.now() };
    all.push(rec);
  }
  save();
  return rec;
}

/** Remove a project from the registry. Returns false when it wasn't registered. */
export function removeProject(path: string): boolean {
  const all = load();
  const idx = all.findIndex((r) => r.path === path);
  if (idx === -1) return false;
  all.splice(idx, 1);
  save();
  return true;
}

/** Pin/unpin a project — upserts so pinning an unregistered project registers it. */
export function setProjectPinned(path: string, pinned: boolean): void {
  const all = load();
  const rec = all.find((r) => r.path === path);
  if (rec) {
    rec.pinned = pinned;
  } else {
    all.push({ path, pinned, lastOpened: Date.now() });
  }
  save();
}

/** Set a custom display name — upserts. An empty name clears the override. */
export function renameProject(path: string, name: string): void {
  const all = load();
  const trimmed = name.trim();
  const rec = all.find((r) => r.path === path);
  if (rec) {
    rec.name = trimmed || undefined;
  } else {
    all.push({ path, name: trimmed || undefined, pinned: false, lastOpened: Date.now() });
  }
  save();
}
