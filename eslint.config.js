import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  prettier,
  ...svelte.configs['flat/prettier'],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        parser: ts.parser,
      },
    },
  },
  {
    ignores: [
      'build/',
      '.svelte-kit/',
      'node_modules/',
      'coverage/',
      'test-results/',
      '.opencode/',
      '.pi/',
      '.playwright-mcp/',
      'vitest.config.ts',
      'playwright.config.ts',
      'e2e/',
      'benchmark.ts',
      'server.bundle.js',
      'adapters/',
    ],
  },
  // ── Architecture boundaries ─────────────────────────────────────────────────
  // Enforces the layering the decomposition targets: client realms (components,
  // state, routes app group) never reach into server-only modules, stores never
  // import components, and the server realm stays self-contained behind shared
  // + protocol. Routes stay permissive because the same directory mixes .svelte
  // client code with legitimate .server.ts files. The root server.ts entry is
  // classified separately as a server-entry file so it can depend only on
  // protocol/shared/server runtime/handler elements.
  {
    plugins: { boundaries },
    settings: {
      // boundaries v7 delegates module resolution to the standard import
      // resolver — required so TS files (and #lib subpath imports) resolve
      // and element classification actually applies.
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
        node: {
          extensions: ['.js', '.ts', '.svelte'],
        },
      },
      'boundaries/elements': [
        { type: 'protocol', pattern: ['src/lib/ws/**'] },
        { type: 'state', pattern: ['src/lib/state/**'] },
        { type: 'components', pattern: ['src/lib/components/**'] },
        { type: 'server-runtime', pattern: ['src/lib/server/runtime/**'] },
        { type: 'server-handlers', pattern: ['src/lib/server/handlers/**'] },
        { type: 'client-controllers', pattern: ['src/lib/controllers/**'] },
        {
          type: 'server',
          pattern: ['src/lib/server/**', 'src/lib/auth/**', 'bin/**', 'scripts/**'],
        },
        { type: 'routes', pattern: ['src/routes/**'] },
        // Everything else under src/lib (utils, markdown, client-messages,
        // tui-stubs, …) is dual-use glue both realms may depend on.
        { type: 'shared', pattern: ['src/lib/**'] },
      ],
      'boundaries/files': [{ category: 'server-entry', pattern: 'server.ts' }],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message: '{{from.type}} is not allowed to import {{to.type}}',
          policies: [
            {
              from: { element: { type: 'protocol' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'state' } } },
                { to: { element: { type: 'components' } } },
                { to: { element: { type: 'routes' } } },
                { to: { element: { type: 'server' } } },
              ],
            },
            {
              from: { element: { type: 'shared' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
              ],
            },
            {
              from: { element: { type: 'state' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'state' } } },
              ],
            },
            {
              from: { element: { type: 'components' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'state' } } },
                { to: { element: { type: 'components' } } },
              ],
            },
            {
              from: { element: { type: 'client-controllers' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'state' } } },
                { to: { element: { type: 'client-controllers' } } },
              ],
            },
            {
              from: { element: { type: 'routes' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'state' } } },
                { to: { element: { type: 'components' } } },
                { to: { element: { type: 'client-controllers' } } },
                { to: { element: { type: 'server' } } },
              ],
            },
            {
              from: { element: { type: 'server-runtime' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'server' } } },
                { to: { element: { type: 'server-runtime' } } },
              ],
            },
            {
              from: { element: { type: 'server-handlers' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'server' } } },
                { to: { element: { type: 'server-runtime' } } },
                { to: { element: { type: 'server-handlers' } } },
              ],
            },
            {
              from: { file: { categories: 'server-entry' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'server' } } },
                { to: { element: { type: 'server-runtime' } } },
                { to: { element: { type: 'server-handlers' } } },
              ],
            },
            {
              from: { element: { type: 'server' } },
              allow: [
                { to: { element: { type: 'protocol' } } },
                { to: { element: { type: 'shared' } } },
                { to: { element: { type: 'server' } } },
                { to: { element: { type: 'server-runtime' } } },
                { to: { element: { type: 'server-handlers' } } },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    rules: {
      // New in eslint-plugin-svelte 3 — keep no-at-html-tags off (intentional @html for syntax highlighting)
      'svelte/no-at-html-tags': 'off',
    },
  },
  {
    files: ['src/lib/components/ui/button/button.svelte'],
    rules: {
      // Generic button primitive supports plain anchors, including external URLs.
      'svelte/no-navigation-without-resolve': 'off',
    },
  },
];
