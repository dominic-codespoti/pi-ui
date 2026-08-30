#!/usr/bin/env bun
/**
 * Build guard for the E2E webServer: run `vite build` only when some input is
 * newer than everything inside build/. Cuts ~30-60 s off every Playwright
 * invocation on an unchanged tree while staying correct for CI (cold cache →
 * no build/ → always builds).
 */
import { $ } from 'bun';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = 'build';
const INPUTS = ['src', 'static', 'package.json', 'svelte.config.js', 'vite.config.ts'] as const;

async function newestMtimeUnder(paths: readonly string[]): Promise<number> {
  let newest = 0;
  const stack = [...paths];
  while (stack.length > 0) {
    const path = stack.pop() as string;
    const st = await stat(path).catch(() => null);
    if (!st) continue;
    newest = Math.max(newest, st.mtimeMs);
    if (!st.isDirectory()) continue;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.svelte-kit' || entry.name === 'node_modules') continue;
      stack.push(join(path, entry.name));
    }
  }
  return newest;
}

const outSt = await stat(OUT).catch(() => null);
if (outSt) {
  const [outNewest, inNewest] = await Promise.all([
    newestMtimeUnder([OUT]),
    newestMtimeUnder(INPUTS),
  ]);
  if (inNewest <= outNewest) {
    console.log('[maybe-build] build/ is fresh — skipping rebuild');
    process.exit(0);
  }
  console.log('[maybe-build] inputs changed since last build — rebuilding');
}
await $`bun run build`;
