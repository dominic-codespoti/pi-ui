import type { ClientMessage } from '#lib/ws/protocol.js';
import type { NotificationPrefs } from '#lib/notification-prefs.js';
import { NOTIF_NUDGE_SEEN_KEY, urlBase64ToUint8Array } from '#lib/notification-prefs.js';

export interface NotificationStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface NotificationPort {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  show(title: string, options: { body: string; tag: string; icon: string }): void;
}

export interface PushSubscriptionPort {
  readonly endpoint: string;
  readonly expirationTime: number | null;
  toJSON(): { keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerPort {
  getSubscription(): Promise<PushSubscriptionPort | null>;
  subscribe(options: {
    userVisibleOnly: true;
    applicationServerKey: Uint8Array<ArrayBuffer>;
  }): Promise<PushSubscriptionPort>;
}

export interface ServiceWorkerRegistrationPort {
  readonly pushManager: PushManagerPort;
}

export interface ServiceWorkerPort {
  readonly ready: Promise<ServiceWorkerRegistrationPort>;
  readonly controller?: { postMessage(message: unknown): void };
}

export interface NotificationBadgePort {
  setAppBadge(count?: number): Promise<void>;
  clearAppBadge(): Promise<void>;
}

export interface NotificationSessionSummary {
  name?: string;
  firstMessage?: string;
  path: string;
}

export interface NotificationControllerOptions {
  send: (message: ClientMessage) => boolean;
  storage?: NotificationStoragePort;
  notification?: NotificationPort;
  serviceWorker?: ServiceWorkerPort;
  badge?: NotificationBadgePort;
  isHidden?: () => boolean;
  getSessionSummary?: (sessionId: string) => NotificationSessionSummary | undefined;
  showNotice?: (message: string, level: 'info' | 'warning' | 'error') => void;
  onPreferencesChanged?: (prefs: NotificationPrefs) => void;
  onNudgeVisibilityChanged?: (visible: boolean) => void;
  decodeVapidKey?: (key: string) => Uint8Array<ArrayBuffer>;
  logger?: { warn(...args: unknown[]): void };
}

const DEFAULT_PREFS: NotificationPrefs = { enabled: true, onComplete: true };
const ICON = '/pwa-192x192.png';

type PushSubscribeMessage = Extract<ClientMessage, { type: 'push_subscribe' }>;
type PushUnsubscribeMessage = Extract<ClientMessage, { type: 'push_unsubscribe' }>;

function browserStorage(): NotificationStoragePort | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  return localStorage;
}

function browserNotification(): NotificationPort | undefined {
  if (typeof Notification === 'undefined') return undefined;
  return {
    get permission() {
      return Notification.permission;
    },
    requestPermission: () => Notification.requestPermission(),
    show: (title, options) => {
      new Notification(title, options);
    },
  };
}

function browserServiceWorker(): ServiceWorkerPort | undefined {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;
  return navigator.serviceWorker as unknown as ServiceWorkerPort;
}

function browserBadge(): NotificationBadgePort | undefined {
  if (typeof navigator === 'undefined' || !('setAppBadge' in navigator)) return undefined;
  return navigator as unknown as NotificationBadgePort;
}

/** Browser-neutral lifecycle for preferences, push, completion notices, and badge state. */
export class NotificationController {
  private readonly options: NotificationControllerOptions;
  private readonly storage: NotificationStoragePort | undefined;
  private readonly notification: NotificationPort | undefined;
  private readonly serviceWorker: ServiceWorkerPort | undefined;
  private readonly badge: NotificationBadgePort | undefined;
  private readonly decodeVapidKey: (key: string) => Uint8Array<ArrayBuffer>;
  private readonly logger: { warn(...args: unknown[]): void };
  private prefs: NotificationPrefs;
  private nudgeSeen: boolean;
  private pushVapidKey: string | null = null;
  private connectionOpen = false;
  private pushSyncInFlight = false;
  private readonly notifiedCompletions = new Set<string>();

  constructor(options: NotificationControllerOptions) {
    this.options = options;
    this.storage = options.storage ?? browserStorage();
    this.notification = options.notification ?? browserNotification();
    this.serviceWorker = options.serviceWorker ?? browserServiceWorker();
    this.badge = options.badge ?? browserBadge();
    this.decodeVapidKey = options.decodeVapidKey ?? urlBase64ToUint8Array;
    this.logger = options.logger ?? console;
    this.prefs = this.loadPreferences();
    this.nudgeSeen = this.readNudgeSeen();
  }

  get preferences(): NotificationPrefs {
    return { ...this.prefs };
  }

  get isNudgeSeen(): boolean {
    return this.nudgeSeen;
  }

  setPreferences(next: NotificationPrefs): void {
    this.prefs = { enabled: Boolean(next.enabled), onComplete: Boolean(next.onComplete) };
    this.savePreferences();
    this.options.onPreferencesChanged?.(this.preferences);
    void this.reconcilePushSubscription();
  }

  setEnabled(enabled: boolean): void {
    this.setPreferences({ ...this.prefs, enabled });
  }

  setOnComplete(onComplete: boolean): void {
    this.setPreferences({ ...this.prefs, onComplete });
  }

  setPushVapidKey(key: string | null): void {
    this.pushVapidKey = key;
    void this.reconcilePushSubscription();
  }

  setConnectionOpen(open: boolean): void {
    this.connectionOpen = open;
    if (open) void this.reconcilePushSubscription();
  }

  enableNotifications(): void {
    this.hideNudgeAndMarkSeen();
    if (!this.notification || this.notification.permission !== 'default') {
      if (this.notification?.permission === 'granted') void this.reconcilePushSubscription();
      return;
    }
    void this.notification
      .requestPermission()
      .then((permission) => {
        if (permission === 'granted') void this.reconcilePushSubscription();
      })
      .catch(() => {});
  }

  dismissNotificationsNudge(): void {
    this.hideNudgeAndMarkSeen();
  }

  handleAgentEnd(willRetry = false): void {
    if (willRetry) return;
    if (this.options.isHidden?.() && this.prefs.onComplete) {
      this.notify('Response Complete', 'pi finished responding.', 'pi-agent-end', {
        kind: 'response_complete',
      });
    }
    if (!this.nudgeSeen && this.prefs.enabled && this.notification?.permission === 'default') {
      this.options.onNudgeVisibilityChanged?.(true);
    }
  }

  notifyBackgroundCompletion(sessionRuntime: { sessionId: string; lastActivity: number }): void {
    const key = `${sessionRuntime.sessionId}:${sessionRuntime.lastActivity}`;
    if (this.notifiedCompletions.has(key)) return;
    this.notifiedCompletions.add(key);
    if (this.notifiedCompletions.size > 64) {
      const oldest = this.notifiedCompletions.values().next().value;
      if (typeof oldest === 'string') this.notifiedCompletions.delete(oldest);
    }

    const summary = this.options.getSessionSummary?.(sessionRuntime.sessionId);
    const name =
      summary?.name?.trim() ||
      summary?.firstMessage?.trim() ||
      summary?.path.split('/').filter(Boolean).pop() ||
      sessionRuntime.sessionId;
    const message = `${name} finished responding.`;
    if (this.options.isHidden?.()) {
      if (this.prefs.onComplete) {
        this.notify(
          'Response Complete',
          message,
          `pi-agent-end-${sessionRuntime.sessionId}-${sessionRuntime.lastActivity}`,
          { kind: 'response_complete', sessionId: sessionRuntime.sessionId }
        );
      }
    } else {
      this.options.showNotice?.(message, 'info');
    }
  }

  updateBadge(count: number): void {
    if (!this.badge) return;
    if (count > 0) {
      this.badge.setAppBadge(count).catch(() => {});
    } else {
      this.badge.clearAppBadge().catch(() => {});
    }
  }

  notify(title: string, body: string, tag: string, data?: Record<string, unknown>): void {
    if (!this.prefs.enabled || this.notification?.permission !== 'granted') return;
    const message = { type: 'show_notification' as const, title, body, tag, data };
    if (this.serviceWorker?.controller) {
      this.serviceWorker.controller.postMessage(message);
      return;
    }
    try {
      this.notification?.show(title, { body, tag, icon: ICON });
    } catch {
      /* browser notification delivery is best effort */
    }
  }

  private loadPreferences(): NotificationPrefs {
    try {
      const raw = this.storage?.getItem('pifrontier:notifications');
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const stored = parsed as Partial<NotificationPrefs>;
          return {
            enabled: typeof stored.enabled === 'boolean' ? stored.enabled : DEFAULT_PREFS.enabled,
            onComplete:
              typeof stored.onComplete === 'boolean' ? stored.onComplete : DEFAULT_PREFS.onComplete,
          };
        }
      }
    } catch {
      /* unavailable or malformed storage */
    }
    return { ...DEFAULT_PREFS };
  }

  private savePreferences(): void {
    try {
      this.storage?.setItem('pifrontier:notifications', JSON.stringify(this.prefs));
    } catch {
      /* storage is optional */
    }
  }

  private readNudgeSeen(): boolean {
    try {
      return this.storage?.getItem(NOTIF_NUDGE_SEEN_KEY) === '1';
    } catch {
      return false;
    }
  }

  private hideNudgeAndMarkSeen(): void {
    this.nudgeSeen = true;
    try {
      this.storage?.setItem(NOTIF_NUDGE_SEEN_KEY, '1');
    } catch {
      /* storage is optional */
    }
    this.options.onNudgeVisibilityChanged?.(false);
  }

  private async reconcilePushSubscription(): Promise<void> {
    if (!this.serviceWorker || !this.connectionOpen || !this.pushVapidKey) return;
    if (this.prefs.enabled && this.notification?.permission === 'granted') {
      await this.syncPushSubscription();
    } else {
      await this.unsubscribePush();
    }
  }

  private async syncPushSubscription(): Promise<void> {
    if (this.pushSyncInFlight || !this.serviceWorker || !this.pushVapidKey) return;
    this.pushSyncInFlight = true;
    try {
      const registration = await this.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        const json = existing.toJSON();
        if (json.keys?.p256dh && json.keys.auth) {
          const message: PushSubscribeMessage = {
            type: 'push_subscribe',
            endpoint: existing.endpoint,
            keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
            expirationTime: existing.expirationTime ?? null,
          };
          this.options.send(message);
        }
        return;
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: this.decodeVapidKey(this.pushVapidKey),
      });
      const json = subscription.toJSON();
      const message: PushSubscribeMessage = {
        type: 'push_subscribe',
        endpoint: subscription.endpoint,
        keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
        expirationTime: subscription.expirationTime ?? null,
      };
      this.options.send(message);
    } catch (error) {
      this.logger.warn('[pi-ui] push subscribe failed:', error);
    } finally {
      this.pushSyncInFlight = false;
    }
  }

  private async unsubscribePush(): Promise<void> {
    if (!this.serviceWorker) return;
    try {
      const registration = await this.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const message: PushUnsubscribeMessage = {
          type: 'push_unsubscribe',
          endpoint: subscription.endpoint,
        };
        this.options.send(message);
        await subscription.unsubscribe();
      }
    } catch {
      /* push removal is best effort */
    }
  }
}
