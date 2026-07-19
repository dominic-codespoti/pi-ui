import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    // In `dev:full` mode the Bun WS server runs on port 5174. The client
    // connects directly in dev mode, bypassing Vite's proxy — Bun.serve's
    // `server.upgrade()` is incompatible with http-proxy's WS forwarding.
  },
  ssr: {
    // Bundle SvelteKit's runtime deps into the SSR output so the package is
    // self-contained when installed from npm (no devDependencies needed at runtime).
    noExternal: ['@sveltejs/kit', 'devalue', 'cookie', 'set-cookie-parser', 'clsx'],
  },
});
