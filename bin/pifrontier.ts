#!/usr/bin/env bun
/**
 * pi-ui CLI entry point
 *
 * Usage:
 *   pi-ui [options]
 *   pi-ui update
 *
 * Options:
 *   -p, --password <password>  Password to protect the UI (or set PI_PASSWORD env var)
 *   -P, --port <port>          Port to listen on (default: 3000, or PORT env var)
 *       --cwd <dir>            Working directory for the pi session (default: cwd)
 *   -o, --open                 Open the browser after startup
 *   -h, --help                 Show this help message
 *   -V, --version              Print version and exit
 */

import { parseArgs } from 'util';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Version ───────────────────────────────────────────────────────────────────

const pkgPath = new URL('../package.json', import.meta.url);
const packageRoot = dirname(fileURLToPath(pkgPath));
const pkg = JSON.parse(readFileSync(fileURLToPath(pkgPath), 'utf8')) as { name: string; version: string };

type PackageManager = 'npm' | 'bun' | 'pnpm' | 'yarn';

function quoteCommand(args: string[]): string {
  return args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

function shellCommand(command: string): string[] {
  return process.platform === 'win32'
    ? ['cmd', '/d', '/s', '/c', command]
    : ['sh', '-lc', command];
}

async function runUpdateStep(args: string[], cwd = packageRoot): Promise<void> {
  console.log(`$ ${quoteCommand(args)}`);
  const proc = Bun.spawn(args, {
    cwd,
    env: process.env as Record<string, string>,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`${quoteCommand(args)} failed with exit code ${exitCode}`);
}

function ephemeralUpdateHint(root: string): string | null {
  const normalized = root.replaceAll('\\', '/');
  if (normalized.includes('/.bun/install/cache/')) return `bunx ${pkg.name}@latest --password ...`;
  if (normalized.includes('/.npm/_npx/') || normalized.includes('/_npx/')) return `npx -y ${pkg.name}@latest --password ...`;
  if (normalized.includes('/pnpm/dlx/') || normalized.includes('/.pnpm/dlx/')) return `pnpm dlx ${pkg.name}@latest --password ...`;
  if (normalized.includes('/yarn/dlx/')) return `yarn dlx ${pkg.name}@latest --password ...`;
  return null;
}

function detectPackageManager(root: string): PackageManager {
  const override = process.env.PI_UI_PACKAGE_MANAGER?.toLowerCase();
  if (override === 'npm' || override === 'bun' || override === 'pnpm' || override === 'yarn') return override;

  const normalized = root.replaceAll('\\', '/');
  if (normalized.includes('/.bun/install/global/')) return 'bun';
  if (normalized.includes('/pnpm/') || normalized.includes('/.local/share/pnpm/')) return 'pnpm';
  if (normalized.includes('/yarn/global/')) return 'yarn';

  const userAgent = process.env.npm_config_user_agent?.toLowerCase() ?? '';
  if (userAgent.startsWith('bun/')) return 'bun';
  if (userAgent.startsWith('pnpm/')) return 'pnpm';
  if (userAgent.startsWith('yarn/')) return 'yarn';
  return 'npm';
}

function packageManagerUpdateCommand(manager: PackageManager): string[] {
  switch (manager) {
    case 'bun': return ['bun', 'install', '--global', `${pkg.name}@latest`];
    case 'pnpm': return ['pnpm', 'add', '--global', `${pkg.name}@latest`];
    case 'yarn': return ['yarn', 'global', 'add', `${pkg.name}@latest`];
    case 'npm':
    default: return ['npm', 'install', '--global', `${pkg.name}@latest`];
  }
}

async function updatePiUi(): Promise<void> {
  if (process.env.PI_UI_UPDATE_COMMAND?.trim()) {
    const command = process.env.PI_UI_UPDATE_COMMAND.trim();
    console.log(`Using PI_UI_UPDATE_COMMAND: ${command}`);
    await runUpdateStep(shellCommand(command), process.cwd());
    return;
  }

  if (existsSync(resolve(packageRoot, '.git'))) {
    await runUpdateStep(['git', 'pull', '--ff-only']);
    await runUpdateStep(['bun', 'install']);
    await runUpdateStep(['bun', 'run', 'build']);
    await runUpdateStep(['bun', 'run', 'build:server']);
    return;
  }

  const hint = ephemeralUpdateHint(packageRoot);
  if (hint) {
    throw new Error(`This pi-ui run looks ephemeral, so there is no durable install to update. Restart with: ${hint}`);
  }

  const manager = detectPackageManager(packageRoot);
  await runUpdateStep(packageManagerUpdateCommand(manager), process.cwd());
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    password: { type: 'string',  short: 'p' },
    port:     { type: 'string',  short: 'P' },
    cwd:      { type: 'string' },
    open:     { type: 'boolean', short: 'o', default: false },
    help:     { type: 'boolean', short: 'h', default: false },
    version:  { type: 'boolean', short: 'V', default: false },
  },
  strict: true,
  allowPositionals: true,
});

const command = positionals[0];

// ── Help / version ────────────────────────────────────────────────────────────

if (values.version) {
  console.log(`pi-ui v${pkg.version}`);
  process.exit(0);
}

if (values.help) {
  console.log(`
pi-ui v${pkg.version}

  Web UI for the pi coding agent.

Usage:
  pi-ui [options]
  pi-ui update

Options:
  -p, --password <password>  Password to protect the UI
                             (or set PI_PASSWORD env var)
  -P, --port <port>          Port to listen on (default: 3000)
                             (or set PORT env var)
      --cwd <dir>            Working directory for the pi session
                             (defaults to current directory)
  -o, --open                 Open http://localhost:<port> in the browser
  -h, --help                 Show this help message
  -V, --version              Print version and exit

Commands:
  update                     Update pi-ui using the detected install method

Examples:
  pi-ui --password secret
  PI_PASSWORD=secret pi-ui --port 8080 --open
  pi-ui -p secret -P 8080 --cwd /path/to/project
`);
  process.exit(0);
}

if (positionals.length > 1 || (command && command !== 'update')) {
  console.error(`Unknown command: ${positionals.join(' ')}`);
  console.error('Run `pi-ui --help` for usage.');
  process.exit(1);
}

if (command === 'update') {
  try {
    await updatePiUi();
    console.log('pi-ui update completed. Restart pi-ui to load the new version.');
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// ── Password resolution ───────────────────────────────────────────────────────

let password = values.password ?? process.env.PI_PASSWORD;

if (!password) {
  // Prompt interactively — works in any TTY, no stty required.
  // terminal:false suppresses echo (ideal for passwords) and is
  // natively supported by Bun's readline implementation.
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, terminal: false });

  process.stdout.write('Password: ');
  password = await new Promise<string>((resolve) => {
    rl.once('line', (line) => {
      process.stdout.write('\n');
      rl.close();
      resolve(line.trim());
    });
  });

  if (!password) {
    console.error('Error: password cannot be empty.');
    process.exit(1);
  }
}

// ── Environment setup (must happen before importing server.ts) ────────────────

process.env.PI_PASSWORD = password;

if (values.port) process.env.PORT = values.port;

if (values.cwd) process.env.PI_CWD = resolve(values.cwd);

// ── Start server ──────────────────────────────────────────────────────────────

// Prefer the pre-built bundle (present in npm-installed packages) over the raw
// TypeScript source (used during development / after `bun run build:server`).
const bundlePath = new URL('../server.bundle.js', import.meta.url);
const serverPath = (await Bun.file(bundlePath).exists())
  ? bundlePath
  : new URL('../server.ts', import.meta.url);

await import(serverPath.href);

// ── Open browser (optional) ───────────────────────────────────────────────────

if (values.open) {
  const port = values.port ?? process.env.PORT ?? '3000';
  const url  = `http://localhost:${port}`;
  const platform = process.platform;
  const cmd = platform === 'darwin'  ? ['open', url]
            : platform === 'win32'   ? ['cmd', '/c', 'start', url]
            :                         ['xdg-open', url];

  Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
}
