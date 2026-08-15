import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setPushStoreDir,
  addPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
  clearPushSubscriptions,
  sendPushNotification,
} from './push-notifications';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-ui-push-test-'));
  setPushStoreDir(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sub = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'P256DH', auth: 'AUTH' },
});

describe('push subscription store', () => {
  it('adds, lists, and removes subscriptions', () => {
    addPushSubscription(sub('https://push.example/a'));
    addPushSubscription(sub('https://push.example/b'));
    expect(
      listPushSubscriptions()
        .map((s) => s.endpoint)
        .sort()
    ).toEqual(['https://push.example/a', 'https://push.example/b']);

    removePushSubscription('https://push.example/a');
    expect(listPushSubscriptions().map((s) => s.endpoint)).toEqual(['https://push.example/b']);
  });

  it('updates in place for a repeated endpoint instead of duplicating', () => {
    addPushSubscription(sub('https://push.example/a'));
    addPushSubscription(sub('https://push.example/a'));
    expect(listPushSubscriptions()).toHaveLength(1);
  });

  it('persists across a store reload (server restart)', () => {
    addPushSubscription(sub('https://push.example/a'));
    // Simulate restart — cache reset, same dir on disk.
    setPushStoreDir(dir);
    expect(listPushSubscriptions().map((s) => s.endpoint)).toEqual(['https://push.example/a']);
  });

  it('caps the store at MAX_SUBSCRIPTIONS, keeping the newest', () => {
    for (let i = 0; i < 105; i++) {
      addPushSubscription(sub(`https://push.example/device-${i}`));
    }
    const list = listPushSubscriptions();
    expect(list).toHaveLength(100);
    // Newest kept — oldest (device-0..4) evicted.
    expect(list[0].endpoint).toBe('https://push.example/device-5');
    expect(list[99].endpoint).toBe('https://push.example/device-104');
  });

  it('clear removes everything', () => {
    addPushSubscription(sub('https://push.example/a'));
    clearPushSubscriptions();
    expect(listPushSubscriptions()).toHaveLength(0);
  });
});

describe('push sending', () => {
  it('no-op without subscriptions and never throws', async () => {
    await expect(sendPushNotification({ kind: 'response_complete' })).resolves.toBeUndefined();
  });

  it('swallows delivery failures (never throws to the caller)', async () => {
    addPushSubscription(sub('https://127.0.0.1:1/push/x'));
    // Port 1 refuses connections — sendPushNotification must not reject.
    await expect(
      sendPushNotification({
        kind: 'response_complete',
        title: 't',
        body: 'b',
        tag: 'pi-agent-end',
      })
    ).resolves.toBeUndefined();
  });

  it('persists generated VAPID keys for reuse', async () => {
    addPushSubscription(sub('https://127.0.0.1:1/push/x'));
    await sendPushNotification({ kind: 'response_complete' });
    const keyPath = join(dir, 'pi-ui-vapid.json');
    expect(existsSync(keyPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as {
      publicKey: string;
      privateKey: string;
    };
    expect(parsed.publicKey).toBeTruthy();
    expect(parsed.privateKey).toBeTruthy();
  });
});
