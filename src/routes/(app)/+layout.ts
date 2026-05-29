// Disable SSR for all (app) routes — chat state is managed entirely client-side
// via the WebSocket connection established after the page shell loads.
export const ssr = false;
export const prerender = false;
