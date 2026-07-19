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

/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const NOTIFICATION_ICON = '/pwa-192x192.png';

/** Versioned cache — a new deploy activates a new cache and drops the old one. */
const CACHE_NAME = `pi-ui-shell-${version}`;
/** Immutable build chunks + static assets (icons, manifest). */
const PRECACHE_URLS = [...build, ...files];
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
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

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type !== 'show_notification') return;
  // `vibrate` is valid in Chromium but missing from lib.dom's NotificationOptions
  const options: NotificationOptions & { vibrate?: number[] } = {
    body: msg.body,
    tag: msg.tag || 'pi-ui-default',
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    data: msg.data || {},
    requireInteraction: true,
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(msg.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL('/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if (client.url === targetUrl && 'focus' in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});
