/**
 * Server-side notification webhook relay.
 *
 * Stores a user-configured webhook URL (ntfy.sh, Pushover, Gotify, etc.)
 * in ~/.pi/agent/pi-ui-webhook.json and provides a fire-and-forget sender.
 *
 * SERVER-ONLY: imported by server.ts. Never import from browser code.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './logger';

const WEBHOOK_DIR = join(homedir(), '.pi', 'agent');
const WEBHOOK_FILE = join(WEBHOOK_DIR, 'pi-ui-webhook.json');

let cachedUrl: string | null | undefined; // undefined = unloaded, null = no url

function load(): string | null {
  if (cachedUrl !== undefined) return cachedUrl;
  try {
    if (existsSync(WEBHOOK_FILE)) {
      const parsed = JSON.parse(readFileSync(WEBHOOK_FILE, 'utf8')) as { url?: string };
      cachedUrl = typeof parsed.url === 'string' && parsed.url.trim() ? parsed.url.trim() : null;
      return cachedUrl;
    }
  } catch (err) {
    log.error('[pifrontier] notification webhook: failed to load:', err);
  }
  cachedUrl = null;
  return null;
}

function save(url: string | null): void {
  cachedUrl = url;
  try {
    mkdirSync(WEBHOOK_DIR, { recursive: true });
    const tmp = `${WEBHOOK_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ url }, null, 2));
    renameSync(tmp, WEBHOOK_FILE);
  } catch (err) {
    log.error('[pifrontier] notification webhook: failed to save:', err);
  }
}

/** Get the configured webhook URL, or null if not set. */
export function getWebhookUrl(): string | null {
  return load();
}

/** Set (or clear by passing null/empty) the webhook URL. */
export function setWebhookUrl(url: string | null | undefined): void {
  save(url && url.trim() ? url.trim() : null);
}

/**
 * Fire-and-forget POST to the configured webhook URL.
 * Returns immediately — failures are logged but never throw.
 *
 * Supported formats:
 *   ntfy.sh       — POST body=message, header Title=title
 *   Pushover      — POST form-encoded token/user/message (not yet, URL encodes it)
 *   Generic       — POST body=message, header X-Title=title
 */
export async function sendWebhookNotification(title: string, message: string): Promise<void> {
  const url = getWebhookUrl();
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      body: message,
      headers: { 'Title': title },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    log.error('[pifrontier] notification webhook: send failed:', err);
  }
}
