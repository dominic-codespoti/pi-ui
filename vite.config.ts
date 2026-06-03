import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    // In `dev:full` mode the WS server runs on port 5174 so Vite can proxy /ws
    // there while the frontend gets HMR from the Vite dev server on 5173.
    proxy: {
      '/ws': {
        target: 'ws://localhost:5174',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  ssr: {
    // Bundle SvelteKit's runtime deps into the SSR output so the package is
    // self-contained when installed from npm (no devDependencies needed at runtime).
    noExternal: ['@sveltejs/kit', 'devalue', 'cookie', 'set-cookie-parser', 'clsx'],
  },
});
