/**
 * Minimal service worker — no Workbox, no offline cache.
 *
 * Bundled as IIFE (see vite.config.ts rollupFormat: 'iife') for iOS Safari
 * compatibility. The __WB_MANIFEST placeholder is replaced by vite-plugin-pwa
 * with the asset manifest so the SW is correctly versioned.
 *
 * Strategy: network-first passthrough. Chat history is never cached —
 * Raspberry Pi storage is limited and the WS stream is the source of truth.
 */

/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope;

// Required by vite-plugin-pwa injectManifest strategy — do not remove.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _manifest = (self as any).__WB_MANIFEST;

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
