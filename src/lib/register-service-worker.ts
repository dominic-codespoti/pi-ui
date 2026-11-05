import { browser, dev, version } from '$app/env';

let registered = false;

export function registerServiceWorker() {
  if (!browser || dev || registered || !('serviceWorker' in navigator)) return;

  registered = true;
  // A build-specific URL bypasses stale CDN copies of the unversioned worker.
  navigator.serviceWorker
    .register(`/service-worker.js?v=${encodeURIComponent(version)}`, {
      scope: '/',
      updateViaCache: 'none',
    })
    .catch((error) => {
      console.warn('[pi-ui] Service worker registration failed:', error);
    });
}
