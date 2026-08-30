import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_PREFS,
  loadNotificationPrefs,
  saveNotificationPrefs,
  urlBase64ToUint8Array,
} from '../notification-prefs';

/**
 * Minimal Map-backed localStorage stand-in — the unit env runs on plain Node
 * without jsdom, and the module guards storage access internally.
 */
function installStorageShim(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  });
}

import { vi } from 'vitest';

describe('notification prefs persistence', () => {
  beforeEach(() => installStorageShim());

  it('returns defaults when nothing is stored', () => {
    expect(loadNotificationPrefs()).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('merges a stored partial over the defaults', () => {
    localStorage.setItem('pifrontier:notifications', '{"onComplete":false}');
    expect(loadNotificationPrefs()).toEqual({ ...DEFAULT_NOTIFICATION_PREFS, onComplete: false });
  });

  it('survives corrupt storage and round-trips through save', () => {
    localStorage.setItem('pifrontier:notifications', '{oops');
    expect(loadNotificationPrefs()).toEqual(DEFAULT_NOTIFICATION_PREFS);

    saveNotificationPrefs({ ...DEFAULT_NOTIFICATION_PREFS, enabled: false });
    expect(loadNotificationPrefs().enabled).toBe(false);
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes standard base64url characters', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
  });

  it('completes missing padding for unpadded input', () => {
    // 'QQ' === 'QQ==' → single byte 0x41
    expect(Array.from(urlBase64ToUint8Array('QQ'))).toEqual([0x41]);
  });
});
