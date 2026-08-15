/**
 * Web Push (RFC 8030) — closed-app notifications via FCM/APNs.
 *
 * The page's own notifications only work while the app is alive; the server
 * knows when turns end, so it pushes to every subscribed device instead.
 * Payloads are intentionally minimal (kind/sessionId/sessionPath — never
 * message text): they transit the push service.
 *
 * Persistence mirrors the other ~/.pi/agent JSON stores (atomic tmp+rename).
 * VAPID keys are generated once on first use; subscriptions are keyed by
 * endpoint and dropped when the push service reports the device gone (404/410).
 */
import webpush from 'web-push';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  createdAt: number;
}

const VAPID_SUBJECT = 'mailto:pi@localhost';
/** Sanity cap — a lost client must not grow the store unboundedly. */
const MAX_SUBSCRIPTIONS = 100;

let _storeDir = join(homedir(), '.pi', 'agent');
let _keys: { publicKey: string; privateKey: string } | null = null;
let _subs: PushSubscriptionRecord[] | null = null;

/** Test override — point the store at a temp dir. */
export function setPushStoreDir(dir: string) {
  _storeDir = dir;
  _keys = null;
  _subs = null;
}

function vapidPath(): string {
  return join(_storeDir, 'pi-ui-vapid.json');
}
function subsPath(): string {
  return join(_storeDir, 'pi-ui-push-subscriptions.json');
}

export function ensureVapidKeys(): { publicKey: string; privateKey: string } {
  if (_keys) return _keys;
  try {
    const parsed = JSON.parse(readFileSync(vapidPath(), 'utf8')) as {
      publicKey?: unknown;
      privateKey?: unknown;
    };
    if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      _keys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      return _keys;
    }
  } catch {
    /* not generated yet — fall through */
  }
  const generated = webpush.generateVAPIDKeys();
  _keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  try {
    mkdirSync(_storeDir, { recursive: true });
    writeFileSync(vapidPath(), JSON.stringify(_keys), 'utf8');
  } catch (err) {
    console.error('[pi-ui] failed to persist VAPID keys:', err);
  }
  return _keys;
}

function loadSubscriptions(): PushSubscriptionRecord[] {
  if (_subs) return _subs;
  try {
    const parsed = JSON.parse(readFileSync(subsPath(), 'utf8')) as unknown;
    _subs = Array.isArray(parsed) ? (parsed as PushSubscriptionRecord[]) : [];
  } catch {
    _subs = [];
  }
  return _subs;
}

function persistSubscriptions(): void {
  try {
    mkdirSync(_storeDir, { recursive: true });
    const tmp = subsPath() + '.tmp';
    writeFileSync(tmp, JSON.stringify(_subs ?? []), 'utf8');
    renameSync(tmp, subsPath());
  } catch (err) {
    console.error('[pi-ui] failed to persist push subscriptions:', err);
  }
}

export function addPushSubscription(sub: {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
}): void {
  const list = loadSubscriptions();
  const idx = list.findIndex((s) => s.endpoint === sub.endpoint);
  const record: PushSubscriptionRecord = { ...sub, createdAt: Date.now() };
  if (idx >= 0) {
    list[idx] = record;
  } else {
    list.push(record);
    if (list.length > MAX_SUBSCRIPTIONS) list.splice(0, list.length - MAX_SUBSCRIPTIONS);
  }
  persistSubscriptions();
}

export function removePushSubscription(endpoint: string): void {
  const before = loadSubscriptions().length;
  _subs = _subs!.filter((s) => s.endpoint !== endpoint);
  if (_subs!.length !== before) persistSubscriptions();
}

export function listPushSubscriptions(): PushSubscriptionRecord[] {
  return loadSubscriptions();
}

export function clearPushSubscriptions(): void {
  _subs = [];
  persistSubscriptions();
}

/**
 * Send a payload to every subscribed device. Never throws — failures are
 * logged; endpoints the push service reports gone (404/410) are dropped.
 */
export async function sendPushNotification(payload: Record<string, unknown>): Promise<void> {
  const subs = loadSubscriptions();
  if (subs.length === 0) return;
  const keys = ensureVapidKeys();
  webpush.setVapidDetails(VAPID_SUBJECT, keys.publicKey, keys.privateKey);
  const json = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, json, { TTL: 86400 })
    )
  );
  for (const r of results) {
    if (r.status !== 'rejected') continue;
    const err = r.reason as Error & { statusCode?: number; endpoint?: string };
    if ((err.statusCode === 404 || err.statusCode === 410) && typeof err.endpoint === 'string') {
      // Device gone — the push service dropped the subscription; prune it.
      removePushSubscription(err.endpoint);
      continue;
    }
    if (err.statusCode) {
      console.error(`[pi-ui] push failed (HTTP ${err.statusCode}): ${err.message}`);
    } else {
      console.error(`[pi-ui] push failed: ${err.message}`);
    }
  }
}
