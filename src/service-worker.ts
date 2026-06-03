/**
 * Minimal service worker — no Workbox, no offline cache.
 *
 * Strategy: network-first passthrough. Chat history is never cached —
 * Raspberry Pi storage is limited and the WS stream is the source of truth.
 */

/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Let the browser handle all requests normally — no caching.
  event.respondWith(fetch(event.request));
});
