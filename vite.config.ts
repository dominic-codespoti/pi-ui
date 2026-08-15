import adapter from 'svelte-adapter-bun';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ precompress: true }),
      // trustedOrigins: ['*'] fully disables CSRF origin checking — same intent
      // as the removed checkOrigin: false. Bun's URL construction conflicts
      // with SvelteKit's origin check; the login server action has its own
      // origin check instead (see hooks.server.ts / login +page.server.ts).
      csrf: { trustedOrigins: ['*'] },
      // CSP via SvelteKit's provider (mode 'auto' = nonce-based): SvelteKit adds
      // a nonce to its inline bootstrap script and emits the policy header on
      // SSR responses. Kept out of server.ts's manual header so the two policies
      // cannot conflict. `script-src` has no 'unsafe-inline', so injected inline
      // scripts (e.g. markdown XSS payloads) are blocked; `style-src` needs
      // 'unsafe-inline' for the many inline style attributes the UI uses.
      csp: {
        mode: 'auto',
        directives: {
          'default-src': ['self'],
          'script-src': ['self'],
          'style-src': ['self', 'unsafe-inline'],
          'img-src': ['self', 'data:', 'blob:', 'http:', 'https:'],
          'connect-src': ['self', 'ws:', 'wss:'],
          'font-src': ['self', 'data:'],
          'object-src': ['none'],
          'frame-ancestors': ['none'],
          'base-uri': ['self'],
          'form-action': ['self'],
        },
      },
    }),
  ],
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
