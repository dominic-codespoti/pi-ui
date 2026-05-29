import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    // Bundle SvelteKit's runtime deps into the SSR output so the package is
    // self-contained when installed from npm (no devDependencies needed at runtime).
    noExternal: ['@sveltejs/kit', 'devalue', 'cookie', 'set-cookie-parser', 'clsx'],
  },
});
