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

// No fetch handler — skip the SW hop entirely. The browser handles all
// requests natively, which is faster than a no-op passthrough SW.
