/**
 * Persisted project registry — low-level persistence for the project catalog.
 *
 * SERVER-ONLY: imported by project-catalog.ts (never directly by server.ts,
 * and never from browser code).
 *
 * Stored as a small JSON file at ~/.pi/agent/pi-ui-projects.json:
 *   { "projects": [{ "path", "name"?, "pinned", "lastOpened" }] }
 *
 * Load is cached in memory; saves are synchronous + atomic (tmp file +
 * rename) and small. Callers own debouncing — the catalog coalesces the
 * sync write so session switches never block the critical path.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/** Load the registry (cached in memory). Corrupt/missing files start empty. */
export function loadProjectRecords(): ProjectRecord[] {
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

/** Atomically persist the given records. */
export function saveProjectRecords(projectRecords: ProjectRecord[]): void {
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true });
    const tmp = `${REGISTRY_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ projects: projectRecords }, null, 2));
    renameSync(tmp, REGISTRY_FILE);
  } catch (err) {
    log.error('[pifrontier] project registry: failed to save:', err);
  }
}
