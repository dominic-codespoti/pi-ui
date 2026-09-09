/**
 * Notification preference persistence and Web Push key decoding. Pure helpers
 * shared by the page's notification settings UI and push subscription flow.
 */

export interface NotificationPrefs {
  enabled: boolean;
  onComplete: boolean;
}
/** localStorage flag marking the post-run permission nudge as seen. */
export const NOTIF_NUDGE_SEEN_KEY = 'pifrontier:notif-nudge-seen';

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  onComplete: true,
};

const STORAGE_KEY = 'pifrontier:notifications';

export function loadNotificationPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const stored = parsed as Partial<NotificationPrefs>;
        return {
          enabled:
            typeof stored.enabled === 'boolean'
              ? stored.enabled
              : DEFAULT_NOTIFICATION_PREFS.enabled,
          onComplete:
            typeof stored.onComplete === 'boolean'
              ? stored.onComplete
              : DEFAULT_NOTIFICATION_PREFS.onComplete,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_NOTIFICATION_PREFS };
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/** VAPID public keys arrive base64url-encoded; pushManager wants bytes. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
