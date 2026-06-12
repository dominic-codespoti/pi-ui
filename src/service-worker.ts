/**
 * Minimal service worker — no Workbox, no offline cache.
 *
 * Strategy: network-first passthrough. Chat history is never cached —
 * Raspberry Pi storage is limited and the WS stream is the source of truth.
 *
 * Notification support:
 *   - Listen for show_notification messages from client pages
 *   - Show native OS notifications via the PWA
 *   - Handle notification clicks to focus/open the app
 */

/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

const NOTIFICATION_ICON = '/pwa-192x192.png';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type !== 'show_notification') return;
  event.waitUntil(
    self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: msg.tag || 'pi-ui-default',
      icon: NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      data: msg.data || {},
      requireInteraction: true,
      vibrate: [200, 100, 200],
    })
  );
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

// No fetch handler — skip the SW hop entirely. The browser handles all
// requests natively, which is faster than a no-op passthrough SW.
