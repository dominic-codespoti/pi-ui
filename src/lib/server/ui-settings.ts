/**
 * UI settings persistence — stores cross-device preferences on the server
 * so theme, panel widths, and other UI settings survive browser storage clears
 * and are shared across devices.
 *
 * SERVER-ONLY: imported by server.ts. Never import from browser code.
 *
 * Stored as a JSON file at ~/.pi/agent/pi-ui-settings.json:
 *   { "settings": { ... }, "lastSession": { "path": "...", "cwd": "..." } }
 *
 * Writes are synchronous + atomic (tmp file + rename).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './logger';

let registryDir = join(homedir(), '.pi', 'agent');
let settingsFile = join(registryDir, 'pi-ui-settings.json');

let cached: Record<string, unknown> | null = null;
let lastSession: { path: string; cwd?: string } | undefined;

/** Test override — point the settings store at a temporary directory. */
export function setUISettingsStoreDir(dir: string): void {
  registryDir = dir;
  settingsFile = join(dir, 'pi-ui-settings.json');
  cached = null;
  lastSession = undefined;
}

function load(): Record<string, unknown> {
  if (cached) return cached;
  try {
    if (existsSync(settingsFile)) {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
        settings?: unknown;
        lastSession?: unknown;
      };
      if (parsed.settings && typeof parsed.settings === 'object') {
        cached = parsed.settings as Record<string, unknown>;
      }
      if (isLastSession(parsed.lastSession)) {
        lastSession = parsed.lastSession;
      }
      if (cached) return cached;
    }
  } catch (err) {
    log.error('[pifrontier] ui-settings: failed to load, starting empty:', err);
  }
  cached = {};
  return cached;
}

function isLastSession(value: unknown): value is { path: string; cwd?: string } {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { path?: unknown; cwd?: unknown };
  return (
    typeof entry.path === 'string' && (entry.cwd === undefined || typeof entry.cwd === 'string')
  );
}

function save(): void {
  try {
    mkdirSync(registryDir, { recursive: true });
    const tmp = `${settingsFile}.tmp`;
    const payload: {
      settings: Record<string, unknown>;
      lastSession?: { path: string; cwd?: string };
    } = {
      settings: cached ?? {},
    };
    if (lastSession) payload.lastSession = lastSession;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, settingsFile);
  } catch (err) {
    log.error('[pifrontier] ui-settings: failed to save:', err);
  }
}

/** Read all persisted UI settings. */
export function readSettings(): Record<string, unknown> {
  return { ...load() };
}

/** Merge values into the persisted settings (shallow merge). */
export function updateSettings(values: Record<string, unknown>): Record<string, unknown> {
  const store = load();
  Object.assign(store, values);
  save();
  return { ...store };
}

/** Read the server-side pointer to the last active persisted session. */
export function getLastSession(): { path: string; cwd?: string } | undefined {
  load();
  return lastSession ? { ...lastSession } : undefined;
}

/** Persist or clear the server-side pointer to the last active persisted session. */
export function setLastSession(entry: { path: string; cwd?: string } | undefined): void {
  load();
  lastSession = entry ? { ...entry } : undefined;
  save();
}
