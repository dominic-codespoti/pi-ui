import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('svelte-adapter-bun vendored module resolution', () => {
  it('includes built distribution files required for Vite bundling', () => {
    const adapterDir = path.resolve(__dirname, '../../../adapters/svelte-adapter-bun');
    const distIndex = path.join(adapterDir, 'dist', 'index.js');
    const handler = path.join(adapterDir, 'dist', 'files', 'handler.js');
    const env = path.join(adapterDir, 'dist', 'files', 'env.js');

    expect(fs.existsSync(distIndex)).toBe(true);
    expect(fs.existsSync(handler)).toBe(true);
    expect(fs.existsSync(env)).toBe(true);
  });

  it('exports valid entry points in package.json', () => {
    const adapterDir = path.resolve(__dirname, '../../../adapters/svelte-adapter-bun');
    const pkg = JSON.parse(fs.readFileSync(path.join(adapterDir, 'package.json'), 'utf8'));

    expect(pkg.name).toBe('svelte-adapter-bun');
    expect(pkg.exports['.']['import']).toBe('./dist/index.js');
    expect(fs.existsSync(path.join(adapterDir, pkg.exports['.']['import']))).toBe(true);
  });
});
