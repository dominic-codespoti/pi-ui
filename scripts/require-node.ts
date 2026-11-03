/**
 * Preflight for Node-run tooling (vitest). The app runs on Bun, but vitest's
 * bin runs on the `node` found on PATH, and undici 8 (pulled in by jsdom and
 * the pi SDK) needs Node >= 22.19 — older Nodes fail every test file with
 * `webidl.util.markAsUncloneable is not a function`. Fail fast with a fix
 * instead. Version pin: `.nvmrc`.
 */
const MIN = [22, 19, 0] as const;

const proc = Bun.spawnSync(['node', '--version'], { stdout: 'pipe', stderr: 'pipe' });
const raw = proc.success ? proc.stdout.toString().trim() : '';
const parts = raw.replace(/^v/, '').split('.').map(Number);

function atLeast(version: number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const v = version[i] ?? 0;
    if (v !== min[i]) return v > min[i];
  }
  return true;
}

if (!raw || parts.some((n) => !Number.isFinite(n)) || !atLeast(parts, MIN)) {
  console.error(
    `\n✖ Unit tests need Node >= ${MIN.join('.')} on PATH (found ${raw || 'no node'}).\n` +
      `  vitest runs on Node, and undici 8 requires >= 22.19.\n` +
      `  Fix: \`nvm use\` (reads .nvmrc) or prepend a newer Node to PATH, e.g.\n` +
      `    PATH="$HOME/.nvm/versions/node/v24.x/bin:$PATH" bun run test:unit\n`
  );
  process.exit(1);
}
