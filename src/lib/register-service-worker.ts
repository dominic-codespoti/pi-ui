import { browser, dev } from '$app/environment';

let registered = false;

export function registerServiceWorker() {
  if (!browser || dev || registered || !('serviceWorker' in navigator)) return;

  registered = true;
  navigator.serviceWorker.register('/service-worker.js').catch((error) => {
    console.warn('[pi-ui] Service worker registration failed:', error);
  });
}
