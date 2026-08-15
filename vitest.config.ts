import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    // SvelteKit 3's Vite plugin requires its SSR runner to be Vite's
    // RunnableDevEnvironment, which only holds when vitest runs against the
    // same Vite instance as the app (see the `vite` override in package.json
    // — vitest otherwise bundles a nested copy and the instanceof check in
    // kit's runner.js fails). Workspace-project shape mirrors `sv add vitest`.
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/routes/**/*.ts', 'src/hooks.server.ts'],
      exclude: [
        'src/lib/components/ui/**',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/test-setup.ts',
        'src/service-worker/**',
        'src/lib/register-service-worker.ts',
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'jsdom',
          globals: true,
          include: ['src/**/*.{test,spec}.{ts,js,svelte}'],
          exclude: ['src/**/*.e2e.test.ts', 'node_modules', 'build', '.svelte-kit'],
          setupFiles: ['./src/test-setup.ts'],
          sequence: {
            // Tests must not share mutable global state
            concurrent: false,
          },
        },
      },
    ],
  },
  resolve: {
    conditions: ['browser'],
  },
});
