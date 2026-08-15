/**
 * Service worker — app-shell precache + notifications. No Workbox.
 *
 * Strategy: precache the immutable build assets (hashed JS/CSS chunks) and
 * static files at install, serve them cache-first, and let EVERYTHING else
 * (navigations, /ws, API calls) go straight to the network. This makes cold
 * starts fast after the OS discards the backgrounded PWA — the shell paints
 * from disk while the WebSocket reconnects — without caching any chat data:
 * the WS stream stays the single source of truth and Raspberry Pi storage
 * stays untouched (the cache lives on the client).
 *
 * Notification support:
 *   - Listen for show_notification messages from client pages
 *   - Show native OS notifications via the PWA
 *   - Handle notification clicks to focus/open the app
 */

import { self } from '$app/service-worker';
import { version } from '$app/env';
import { immutable, assets } from '$app/manifest';

const NOTIFICATION_ICON = '/pwa-192x192.png';

/** Versioned cache — a new deploy activates a new cache and drops the old one. */
const CACHE_NAME = `pi-ui-shell-${version}`;
/** Immutable build chunks + static assets (icons, manifest). */
const PRECACHE_URLS = [...immutable, ...assets].map(
  (file) => new URL(file.path, self.location.origin).pathname
);
const PRECACHE_SET = new Set(PRECACHE_URLS.map((path) => new URL(path, self.location.origin).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only ever serve precached, immutable assets from cache. Navigations,
  // WebSocket upgrades, and anything dynamic bypass the SW entirely so the
  // auth redirect flow and live data are never staled.
  if (request.method !== 'GET' || !PRECACHE_SET.has(request.url)) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      // Not in cache (e.g. install raced a partial failure) — fetch and backfill.
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
  );
});

/** Shared notification surface — the "response complete" kind gets a Steer action. */
async function showPiNotification(
  title: string,
  body: string,
  tag: string,
  data: Record<string, unknown>
): Promise<void> {
  // `vibrate` and `actions` are valid in Chromium but missing from
  // lib.webworker's NotificationOptions
  const options: NotificationOptions & {
    vibrate?: number[];
    actions?: Array<{ action: string; title: string }>;
  } = {
    body,
    tag: tag || 'pi-ui-default',
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    data,
    requireInteraction: true,
    vibrate: [200, 100, 200],
  };
  if (data.kind === 'response_complete') {
    options.actions = [{ action: 'steer', title: 'Steer pi' }];
  }
  await self.registration.showNotification(title, options);
}

/** Route a notification click: steer action / session deep-link / plain focus. */
async function handleNotificationClick(notification: Notification, action: string) {
  const data = (notification.data ?? {}) as Record<string, unknown>;
  const sessionPath = typeof data.sessionPath === 'string' ? data.sessionPath : undefined;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const target = clients.find((c) => 'focus' in c);

  if (action === 'steer') {
    if (target) {
      target.focus();
      target.postMessage({ type: 'pi_steer' });
      return;
    }
    // App closed — can't steer without a page; just reopen it.
    await self.clients.openWindow('/');
    return;
  }
  if (sessionPath && target) {
    target.focus();
    target.postMessage({ type: 'pi_focus_session', sessionPath });
    return;
  }
  if (sessionPath) {
    await self.clients.openWindow(`/?session=${encodeURIComponent(sessionPath)}`);
    return;
  }
  if (target) {
    target.focus();
    return;
  }
  await self.clients.openWindow('/');
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'show_notification') {
    event.waitUntil(
      showPiNotification(msg.title, msg.body, msg.tag, (msg.data as Record<string, unknown>) ?? {})
    );
    return;
  }
  // Test hook — drives the push path as if the app were backgrounded.
  if (msg.type === 'push_simulate') {
    event.waitUntil(
      showPiNotification(msg.title, msg.body, msg.tag, (msg.data as Record<string, unknown>) ?? {})
    );
    return;
  }
  // Test hook — drives notification-click routing without a real OS
  // notification (headless Chromium cannot grant notification permission).
  if (msg.type === 'click_simulate') {
    const stub = { close: () => {}, data: msg.data ?? {} } as unknown as Notification;
    event.waitUntil(
      handleNotificationClick(stub, typeof msg.action === 'string' ? msg.action : '')
    );
  }
});

self.addEventListener('push', (event) => {
  let data: Record<string, unknown> = {};
  try {
    data = (event.data?.json() ?? {}) as Record<string, unknown>;
  } catch {
    /* malformed payload — notify with defaults */
  }
  event.waitUntil(
    (async () => {
      // The running app IS the notification — never pop OS notifications over it.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (clients.some((c) => 'visibilityState' in c && c.visibilityState === 'visible')) return;
      await showPiNotification(
        typeof data.title === 'string' ? data.title : 'pi',
        typeof data.body === 'string' ? data.body : '',
        typeof data.tag === 'string' ? data.tag : 'pi-ui-default',
        data
      );
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event.notification, event.action ?? ''));
});
