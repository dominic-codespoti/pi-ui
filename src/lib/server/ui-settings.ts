/**
 * UI settings persistence — stores cross-device preferences on the server
 * so theme, panel widths, and other UI settings survive browser storage clears
 * and are shared across devices.
 *
 * SERVER-ONLY: imported by server.ts. Never import from browser code.
 *
 * Stored as a JSON file at ~/.pi/agent/pi-ui-settings.json:
 *   { "settings": { ... } }
 *
 * Writes are synchronous + atomic (tmp file + rename).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './logger';

const REGISTRY_DIR = join(homedir(), '.pi', 'agent');
const SETTINGS_FILE = join(REGISTRY_DIR, 'pi-ui-settings.json');

let cached: Record<string, unknown> | null = null;

function load(): Record<string, unknown> {
  if (cached) return cached;
  try {
    if (existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as { settings?: unknown };
      if (parsed.settings && typeof parsed.settings === 'object') {
        cached = parsed.settings as Record<string, unknown>;
        return cached;
      }
    }
  } catch (err) {
    log.error('[pifrontier] ui-settings: failed to load, starting empty:', err);
  }
  cached = {};
  return cached;
}

function save(): void {
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true });
    const tmp = `${SETTINGS_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ settings: cached ?? {} }, null, 2));
    renameSync(tmp, SETTINGS_FILE);
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
