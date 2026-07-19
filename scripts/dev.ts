#!/usr/bin/env bun
/**
 * dev.ts — development orchestrator
 *
 * Runs two processes in parallel:
 *   1. Vite dev server  (port 5173)  — HMR for the frontend
 *   2. Bun WS server   (port 5174)  — pi session WebSocket
 *
 * The browser connects directly to port 5174 for the WebSocket (/ws path);
 * Vite serves the frontend on port 5173. No WS proxy needed.
 *
 * Usage:
 *   PI_PASSWORD=dev bun run dev:full
 *
 * If PI_PASSWORD is unset it defaults to "dev" (suitable for local dev only).
 */

const env: Record<string, string> = {
  ...process.env as Record<string, string>,
  PI_PASSWORD: (process.env.PI_PASSWORD ?? 'dev'),
};

// WS-only server — handles /ws, rejects all other HTTP (Vite serves those).
const wsServer = Bun.spawn(
  ['bun', '--watch', 'server.ts'],
  {
    env: { ...env, PORT: '5174', DEV_WS_ONLY: 'true' },
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

// Vite dev server — full HMR, SvelteKit SSR, proxies /ws to port 5174.
const viteServer = Bun.spawn(
  ['bun', 'run', 'dev'],
  {
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  },
);

function shutdown() {
  wsServer.kill();
  viteServer.kill();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Exit when either child exits.
await Promise.race([wsServer.exited, viteServer.exited]);
shutdown();
