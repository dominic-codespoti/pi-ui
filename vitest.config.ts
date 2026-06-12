import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  test: {
    include: ['src/**/*.{test,spec}.{ts,js,svelte}'],
    exclude: ['src/**/*.e2e.test.ts', 'node_modules', 'build', '.svelte-kit'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts', 'src/routes/**/*.ts', 'src/hooks.server.ts'],
      exclude: [
        'src/lib/components/ui/**',
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/test-setup.ts',
        'src/service-worker.ts',
        'src/lib/register-service-worker.ts',
      ],
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
    sequence: {
      // Tests must not share mutable global state
      concurrent: false,
    },
  },
  resolve: {
    conditions: ['browser'],
  },
});
