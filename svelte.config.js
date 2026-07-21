import adapter from 'svelte-adapter-bun';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ precompress: true }),
    // trustedOrigins: ['*'] fully disables CSRF origin checking — same intent
    // as the removed checkOrigin: false. Bun's URL construction conflicts
    // with SvelteKit's origin check; the login server action has its own
    // origin check instead (see hooks.server.ts / login +page.server.ts).
    csrf: { trustedOrigins: ['*'] },
  },
};

export default config;
