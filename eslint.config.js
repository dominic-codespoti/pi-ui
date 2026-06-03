import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
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
    files: ['**/*.svelte'],
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
      '.opencode/',
      '.playwright-mcp/',
      'server.bundle.js',
    ],
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
