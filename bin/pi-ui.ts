#!/usr/bin/env bun
/**
 * pi-ui CLI entry point
 *
 * Usage:
 *   pi-ui [options]
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
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ── Version ───────────────────────────────────────────────────────────────────

const pkgPath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(fileURLToPath(pkgPath), 'utf8')) as { version: string };

// ── Arg parsing ───────────────────────────────────────────────────────────────

const { values } = parseArgs({
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
  allowPositionals: false,
});

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

Examples:
  pi-ui --password secret
  PI_PASSWORD=secret pi-ui --port 8080 --open
  pi-ui -p secret -P 8080 --cwd /path/to/project
`);
  process.exit(0);
}

// ── Password resolution ───────────────────────────────────────────────────────

let password = values.password ?? process.env.PI_PASSWORD;

if (!password) {
  // Prompt interactively when attached to a TTY
  if (process.stdin.isTTY) {
    process.stdout.write('Password: ');
    // Read one line from stdin with echo off
    const { execSync } = await import('child_process');
    try {
      // stty -echo / +echo works on Linux & macOS
      execSync('stty -echo', { stdio: ['inherit', 'inherit', 'inherit'] });
      const chunks: Uint8Array[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Uint8Array);
        if ((chunk as Buffer).includes('\n'.charCodeAt(0))) break;
      }
      execSync('stty echo', { stdio: ['inherit', 'inherit', 'inherit'] });
      process.stdout.write('\n');
      password = Buffer.concat(chunks).toString().trimEnd();
    } catch {
      // stty not available (e.g. CI) — fall through to error below
      execSync('stty echo', { stdio: ['inherit', 'inherit', 'inherit'] });
    }
  }

  if (!password) {
    console.error('Error: password is required.');
    console.error('  Use --password <password>, or set the PI_PASSWORD environment variable.');
    process.exit(1);
  }
}

// ── Environment setup (must happen before importing server.ts) ────────────────

process.env.PI_PASSWORD = password;

if (values.port) process.env.PORT = values.port;

if (values.cwd) process.env.PI_CWD = resolve(values.cwd);

// ── Start server ──────────────────────────────────────────────────────────────

const serverPath = new URL('../server.ts', import.meta.url);
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
