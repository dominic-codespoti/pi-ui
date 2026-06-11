/**
 * Custom Bun entry point.
 *
 * Responsibilities:
 *  1. Validate PI_PASSWORD env var and initialise the bcrypt hash
 *  2. Start the pi coding-agent session lazily on first WebSocket connection
 *  3. Bridge pi SDK events → all connected WebSocket clients via pub/sub
 *  4. Handle WebSocket upgrades at /ws (auth-gated)
 *  5. Handle session switching and model changes
 *  6. Pass all other HTTP requests to the SvelteKit handler
 *
 * Run:  PI_PASSWORD=secret bun run server.ts
 * Build first: bun run build
 */

import type * as PiSDKNS from '@earendil-works/pi-coding-agent';
import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, basename, sep, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initPassword, isValidSessionCookie } from './src/lib/auth/password.ts';
import { listProjects, touchProject, removeProject, setProjectPinned, renameProject } from './src/lib/server/project-registry.ts';
import type { ClientMessage, ModelInfo, ProjectInfo, ProviderInfo, SessionSummary, SkillSummary, PromptSummary, ExtensionSummary, UpdatePackageStatus, UpdateStatus, UpdateTarget } from './src/lib/ws/protocol.ts';
import { callFactoryAndParse, stubTui, stubTheme, stripAnsi } from './src/lib/tui-stubs.ts';
import ownPkgJson from './package.json' with { type: 'json' };

const APP_ROOT = dirname(fileURLToPath(import.meta.url));

/** pi-ui version baked in at startup. */
const UI_VERSION: string = (ownPkgJson as { version: string }).version;

const UI_PACKAGE_NAME: string = (ownPkgJson as { name?: string }).name ?? '@thed24/pi-ui';
const PI_SDK_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const PI_AI_PACKAGE_NAME = '@earendil-works/pi-ai';

/** pi SDK version — resolved after lazy SDK load. */
let PI_SDK_VERSION = 'unknown';

// When DEV_WS_ONLY=true the server handles only /ws — HTTP is served by the
// Vite dev server (localhost:VITE_PORT). This enables a dev workflow where
// `vite dev` proxies /ws here while retaining full HMR for the frontend.
const DEV_WS_ONLY = Bun.env.DEV_WS_ONLY === 'true';

// Lazy-load the SvelteKit handler — avoids pulling the ~30 MB SK bundle into
// memory at process start before any HTTP request arrives.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SvelteHandler = (req: Request, server: Bun.Server<any>) => Response | Promise<Response>;
let _svelteHandler: SvelteHandler | null = null;
async function getSvelteHandler(): Promise<SvelteHandler> {
  if (!_svelteHandler) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('./build/handler.js') as any;
    _svelteHandler = mod.getHandler().fetch as SvelteHandler;
  }
  return _svelteHandler;
}

// ── 1. Validate environment ───────────────────────────────────────────────────

const PI_PASSWORD = Bun.env.PI_PASSWORD;
if (!PI_PASSWORD) {
  console.error('[pifrontier] Error: PI_PASSWORD environment variable is required.');
  console.error('[pifrontier] Usage: PI_PASSWORD=your-password bun run start');
  process.exit(1);
}

await initPassword(PI_PASSWORD);
console.log('[pifrontier] Password initialised.');

// ── 2. Helpers ────────────────────────────────────────────────────────────────

import { existsSync } from 'node:fs';

const cwd = Bun.env.PI_CWD ?? process.cwd();
if (!existsSync(cwd)) {
  console.error(`[pifrontier] Error: working directory does not exist: ${cwd}`);
  console.error('[pifrontier] Set PI_CWD to a valid directory or run from the target project.');
  process.exit(1);
}

/**
 * Working directory of the active session — falls back to the startup cwd
 * before the first session exists. Switching projects moves this boundary.
 */
function activeCwd(): string {
  return session?.sessionManager.getCwd() || cwd;
}

/**
 * True when an already-resolved absolute path is inside the ACTIVE project
 * root (the current session's cwd). Separator-suffixed comparison prevents
 * sibling-prefix bypasses (e.g. `/home/x/proj-evil` matching `/home/x/proj`).
 */
function isInsideWorkspace(resolvedPath: string): boolean {
  const root = resolve(activeCwd());
  return resolvedPath === root || resolvedPath.startsWith(root + sep);
}

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return join(homedir(), p.slice(1));
  }
  return p;
}



// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeModel(model: Model<any> | undefined | null): ModelInfo | null {
  if (!model) return null;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
  };
}

function getProviders(): ProviderInfo[] {
  const allModels = session!.modelRegistry.getAll();
  const providerCount = new Map<string, number>();
  for (const m of allModels) {
    providerCount.set(m.provider, (providerCount.get(m.provider) ?? 0) + 1);
  }

  const providers: ProviderInfo[] = [];
  for (const [providerId, modelCount] of providerCount) {
    const status = session!.modelRegistry.getProviderAuthStatus(providerId);
    providers.push({
      id: providerId,
      name: session!.modelRegistry.getProviderDisplayName(providerId),
      configured: status.configured,
      source: status.source,
      modelCount,
    });
  }

  // Configured providers first, then alphabetical by name.
  return providers.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function sendSlashResult(
  ws: { send(data: string): void },
  command: string,
  message: string,
  level: 'info' | 'warning' | 'error' = 'info'
) {
  ws.send(JSON.stringify({ type: 'slash_result', command, message, level }));
}

async function fetchNpmLatestVersion(packageName: string): Promise<{ version?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const encoded = encodeURIComponent(packageName);
    const res = await fetch(`https://registry.npmjs.org/${encoded}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { error: `registry returned HTTP ${res.status}` };
    const data = await res.json() as { version?: string };
    return data.version ? { version: data.version } : { error: 'registry response did not include a version' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function packageStatus(name: string, current: string, latest: { version?: string; error?: string }): UpdatePackageStatus {
  return {
    name,
    current,
    latest: latest.version,
    updateAvailable: Boolean(latest.version && current !== 'unknown' && compareSemver(latest.version, current) > 0),
    error: latest.error,
  };
}

function ephemeralUpdateHint(root: string): string | null {
  const normalized = root.replaceAll('\\', '/');
  if (normalized.includes('/.bun/install/cache/')) return `bunx ${UI_PACKAGE_NAME}@latest --password ...`;
  if (normalized.includes('/.npm/_npx/') || normalized.includes('/_npx/')) return `npx -y ${UI_PACKAGE_NAME}@latest --password ...`;
  if (normalized.includes('/pnpm/dlx/') || normalized.includes('/.pnpm/dlx/')) return `pnpm dlx ${UI_PACKAGE_NAME}@latest --password ...`;
  if (normalized.includes('/yarn/dlx/')) return `yarn dlx ${UI_PACKAGE_NAME}@latest --password ...`;
  return null;
}

function piUiUpdateStep(): string[] {
  const cliTs = join(APP_ROOT, 'bin', 'pifrontier.ts');
  if (existsSync(cliTs)) return [process.execPath, cliTs, 'update'];
  const cliShim = join(APP_ROOT, 'bin', 'pifrontier');
  if (existsSync(cliShim)) return [cliShim, 'update'];
  const entry = process.argv[1];
  if (entry && existsSync(entry)) return [process.execPath, entry, 'update'];
  return ['pi-ui', 'update'];
}

async function getUpdateStatus(): Promise<UpdateStatus> {
  const [uiLatest, sdkLatest, gitExists, packageJsonExists] = await Promise.all([
    fetchNpmLatestVersion(UI_PACKAGE_NAME),
    fetchNpmLatestVersion(PI_SDK_PACKAGE_NAME),
    Bun.file(join(APP_ROOT, '.git')).exists(),
    Bun.file(join(APP_ROOT, 'package.json')).exists(),
  ]);
  const ephemeralHint = gitExists ? null : ephemeralUpdateHint(APP_ROOT);
  const mode: UpdateStatus['mode'] = gitExists ? 'source' : ephemeralHint ? 'ephemeral' : 'package';

  const notes: string[] = [];
  if (mode === 'source') notes.push('pi-ui update runs git pull, bun install, and rebuilds the app.');
  if (mode === 'package') notes.push('pi-ui update runs the detected package-manager update for the installed pi-ui package.');
  if (mode === 'ephemeral') notes.push(`This run looks ephemeral. Restart with: ${ephemeralHint}`);
  if (!gitExists) notes.push('SDK-only updates are disabled for package installs; update pi-ui to get the supported SDK version.');
  if (!packageJsonExists) notes.push('Package metadata is not writable in this install location.');
  notes.push('After updating, the server restarts and the page reloads to load the new UI.');

  return {
    appRoot: APP_ROOT,
    mode,
    updateCommand: mode === 'ephemeral' ? ephemeralHint ?? undefined : 'pi-ui update',
    busy: updateInProgress,
    canUpdateUi: mode !== 'ephemeral',
    canUpdateSdk: gitExists && packageJsonExists,
    ui: packageStatus(UI_PACKAGE_NAME, UI_VERSION, uiLatest),
    sdk: packageStatus(PI_SDK_PACKAGE_NAME, PI_SDK_VERSION, sdkLatest),
    notes,
  };
}

function formatCommand(args: string[]): string {
  return args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

async function runUpdateCommand(args: string[]): Promise<{ command: string; exitCode: number; output: string }> {
  const proc = Bun.spawn(args, {
    cwd: APP_ROOT,
    env: process.env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    command: formatCommand(args),
    exitCode,
    output: [stdout, stderr].filter(Boolean).join('\n').trim(),
  };
}

function updateSteps(target: UpdateTarget): string[][] {
  if (target === 'ui') {
    return [piUiUpdateStep()];
  }

  const pkg = ownPkgJson as { devDependencies?: Record<string, string> };
  const steps = [['bun', 'add', `${PI_SDK_PACKAGE_NAME}@latest`]];
  if (pkg.devDependencies?.[PI_AI_PACKAGE_NAME]) {
    steps.push(['bun', 'add', '--dev', `${PI_AI_PACKAGE_NAME}@latest`]);
  }
  return steps;
}

async function runUpdate(target: UpdateTarget, ws: { send(data: string): void }): Promise<void> {
  if (updateInProgress) {
    ws.send(JSON.stringify({ type: 'update_result', target, success: false, message: 'Another update is already running.' }));
    return;
  }

  updateInProgress = true;
  const chunks: string[] = [];
  try {
    const isSourceCheckout = await Bun.file(join(APP_ROOT, '.git')).exists();
    if (target === 'ui' && !isSourceCheckout) {
      const hint = ephemeralUpdateHint(APP_ROOT);
      if (hint) throw new Error(`This pi-ui run looks ephemeral. Restart with: ${hint}`);
    }
    if (target === 'sdk' && !isSourceCheckout) {
      throw new Error('SDK-only updates are only available from a source checkout. Update pi-ui to get the supported SDK version.');
    }

    for (const args of updateSteps(target)) {
      const command = formatCommand(args);
      ws.send(JSON.stringify({ type: 'update_progress', target, command, message: `Running ${command}` }));
      const result = await runUpdateCommand(args);
      chunks.push(`$ ${result.command}`);
      if (result.output) chunks.push(result.output);
      chunks.push(`exit code: ${result.exitCode}`);
      if (result.exitCode !== 0) {
        throw new Error(`${result.command} failed with exit code ${result.exitCode}`);
      }
    }

    ws.send(JSON.stringify({
      type: 'update_result',
      target,
      success: true,
      message: target === 'ui' ? 'pi-ui update completed. Restarting will load the new UI.' : 'pi SDK package updated. Restart the server to load it.',
      output: chunks.join('\n\n'),
      restartRequired: true,
      reloadRequired: target === 'ui',
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'update_result',
      target,
      success: false,
      message: err instanceof Error ? err.message : String(err),
      output: chunks.join('\n\n'),
    }));
  } finally {
    updateInProgress = false;
  }
}

function formatTreeNode(node: { entry: { id: string; type: string; message?: unknown }; children: unknown[]; label?: string }, depth = 0): string[] {
  const indent = '  '.repeat(depth);
  const entry = node.entry;
  let label = entry.type;
  const msg = entry.message as { role?: string; content?: unknown } | undefined;
  if (msg?.role) label = `${msg.role}`;
  if (Array.isArray(msg?.content)) {
    const text = msg.content.find((c) => typeof c === 'object' && c && 'text' in c) as { text?: string } | undefined;
    if (text?.text) label += `: ${text.text.replace(/\s+/g, ' ').slice(0, 64)}`;
  } else if (typeof msg?.content === 'string') {
    label += `: ${msg.content.replace(/\s+/g, ' ').slice(0, 64)}`;
  }
  if (node.label) label += ` [${node.label}]`;
  const lines = [`${indent}- ${label} (${entry.id.slice(0, 8)})`];
  for (const child of node.children as Parameters<typeof formatTreeNode>[0][]) {
    lines.push(...formatTreeNode(child, depth + 1));
  }
  return lines;
}

/** Serialize a raw SDK tree node into the protocol TreeNode format for visual display. */
function serializeTreeNode(node: { entry: { id: string; type: string; message?: unknown }; children: unknown[]; label?: string }): import('./src/lib/ws/protocol.ts').TreeNode {
  const entry = node.entry;
  const msg = entry.message as { role?: string; content?: unknown } | undefined;
  let role: string | undefined;
  let text: string | undefined;
  if (msg?.role) role = msg.role;
  if (Array.isArray(msg?.content)) {
    const t = msg.content.find((c) => typeof c === 'object' && c && 'text' in c) as { text?: string } | undefined;
    if (t?.text) text = t.text.replace(/\s+/g, ' ').slice(0, 64);
  } else if (typeof msg?.content === 'string') {
    text = msg.content.replace(/\s+/g, ' ').slice(0, 64);
  }
  return {
    entryId: entry.id,
    type: entry.type,
    role,
    text,
    label: node.label,
    children: (node.children as typeof node[]).map(serializeTreeNode),
  };
}

/** Pi config directory name — same as CONFIG_DIR_NAME in the SDK. */
const PI_CONFIG_DIR = '.pi';

/**
 * Resolve a GitHub URL (blob/tree UI or raw) to a raw.githubusercontent.com URL.
 * Passes non-GitHub URLs through unchanged.
 *
 * Supported patterns:
 *   https://github.com/owner/repo/blob/branch/path/file.md
 *   https://raw.githubusercontent.com/...  (pass-through)
 *   Any other URL (pass-through — may be a direct .md link)
 */
function resolveGitHubRawUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'github.com') {
      // /owner/repo/blob/branch/...path → raw
      const parts = u.pathname.replace(/^\//, '').split('/');
      if (parts[2] === 'blob' && parts.length >= 5) {
        const [owner, repo, , branch, ...rest] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join('/')}`;
      }
    }
  } catch {
    // invalid URL — will fail at fetch time with a useful error
  }
  return url;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeSession(s: Record<string, any>): SessionSummary {
  return {
    id: s.id,
    path: s.path,
    cwd: s.cwd,
    name: s.name,
    created: s.created instanceof Date ? s.created.getTime() : s.created,
    modified: s.modified instanceof Date ? s.modified.getTime() : s.modified,
    messageCount: s.messageCount,
    firstMessage: s.firstMessage,
  };
}

/**
 * Merge the persisted project registry with directories discovered from
 * session files into the wire-format project list.
 * Sort: pinned first, then most recent activity.
 */
async function buildProjectsList(): Promise<ProjectInfo[]> {
  const byCwd = new Map<string, { count: number; lastModified: number }>();
  try {
    const sessions = await _sdk!.SessionManager.listAll();
    for (const s of sessions) {
      const key = (s as { cwd?: string }).cwd ?? '';
      if (!key) continue;
      const modified = s.modified instanceof Date ? s.modified.getTime() : Number(s.modified) || 0;
      const agg = byCwd.get(key);
      if (agg) {
        agg.count += 1;
        agg.lastModified = Math.max(agg.lastModified, modified);
      } else {
        byCwd.set(key, { count: 1, lastModified: modified });
      }
    }
  } catch (err) {
    console.error('[pifrontier] buildProjectsList: listAll failed:', err);
  }

  const map = new Map<string, ProjectInfo>();
  for (const rec of listProjects()) {
    map.set(rec.path, {
      cwd: rec.path,
      name: rec.name ?? basename(rec.path),
      pinned: rec.pinned,
      exists: existsSync(rec.path),
      registered: true,
      sessionCount: 0,
      lastActivity: rec.lastOpened,
    });
  }
  for (const [dir, agg] of byCwd) {
    const entry = map.get(dir);
    if (entry) {
      entry.sessionCount = agg.count;
      entry.lastActivity = Math.max(entry.lastActivity, agg.lastModified);
    } else {
      map.set(dir, {
        cwd: dir,
        name: basename(dir) || dir,
        pinned: false,
        exists: existsSync(dir),
        registered: false,
        sessionCount: agg.count,
        lastActivity: agg.lastModified,
      });
    }
  }

  return [...map.values()].sort((a, b) =>
    a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.lastActivity - a.lastActivity
  );
}

/** Broadcast the merged project list to all connected tabs. */
async function broadcastProjects(): Promise<void> {
  try {
    broadcast({ type: 'projects_list', projects: await buildProjectsList() });
  } catch (err) {
    console.error('[pifrontier] broadcastProjects failed:', err);
  }
}

/** Build a SessionSummary for the current session. */
function currentSessionSummary(): SessionSummary | null {
  if (!session) return null;
  const msg = session.messages[0] as { content?: string | Array<unknown> } | undefined;
  const firstMsg = msg?.content
    ? (typeof msg.content === 'string' ? msg.content.slice(0, 120) : '(complex)')
    : '';
  return {
    id: session.sessionId,
    path: session.sessionManager.getSessionFile() ?? '(in-memory)',
    cwd: session.sessionManager.getCwd() || cwd,
    name: session.sessionManager.getSessionName() || undefined,
    created: Date.now(),
    modified: Date.now(),
    messageCount: session.messages.length,
    firstMessage: firstMsg,
  };
}

// ── 3. Restart nonce ──────────────────────────────────────────────────────────
// Single-use nonce for restart_server. Prevents replay and ensures the user
// explicitly confirmed the restart via a request_restart → restart_server flow.
let pendingRestartNonce: string | null = null;

// Only one package update may run at a time; update commands mutate package files.
let updateInProgress = false;

// ── 4. Extension UI — pending request map ─────────────────────────────────────

type PendingRequest = { resolve: (response: Record<string, unknown>) => void };
const pendingExtensionRequests = new Map<string, PendingRequest>();
const pendingEditorTextRequests = new Map<string, { resolve: (text: string) => void }>();

// broadcast is a thin wrapper; reassigned once the Bun server is live.
let broadcast: (payload: unknown) => void = () => {};

function createDialogPromise<T>(
  id: string,
  requestPayload: Record<string, unknown>,
  parseResponse: (r: Record<string, unknown>) => T
): Promise<T> {
  return new Promise<T>((resolve) => {
    pendingExtensionRequests.set(id, {
      resolve: (response) => {
        pendingExtensionRequests.delete(id);
        resolve(parseResponse(response));
      },
    });
    broadcast({ type: 'extension_ui_request', id, ...requestPayload });
  });
}

/** Number of currently-connected WS clients (browser tabs). */
let connectedClients = 0;

function cancelAllPendingExtensionRequests() {
  for (const [, entry] of pendingExtensionRequests) {
    entry.resolve({ cancelled: true });
  }
  pendingExtensionRequests.clear();
  for (const [, entry] of pendingEditorTextRequests) {
    entry.resolve('');
  }
  pendingEditorTextRequests.clear();
}

// Server-side state for extension UI context
let toolsExpanded = false;

const uiContext: Omit<ExtensionUIContext, 'getEditorText'> & { getEditorText(): Promise<string> } = {
  select(title, options) {
    const id = crypto.randomUUID();
    return createDialogPromise<string | undefined>(
      id,
      { method: 'select', title, options },
      (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? (r.value as string) : undefined)
    );
  },

  confirm(title, message) {
    const id = crypto.randomUUID();
    return createDialogPromise<boolean>(
      id,
      { method: 'confirm', title, message },
      (r) => ('cancelled' in r && r.cancelled ? false : 'confirmed' in r ? Boolean(r.confirmed) : false)
    );
  },

  input(title, placeholder) {
    const id = crypto.randomUUID();
    return createDialogPromise<string | undefined>(
      id,
      { method: 'input', title, placeholder },
      (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? (r.value as string) : undefined)
    );
  },

  editor(title, prefill) {
    const id = crypto.randomUUID();
    return createDialogPromise<string | undefined>(
      id,
      { method: 'editor', title, prefill },
      (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? (r.value as string) : undefined)
    );
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async custom(...args: any[]): Promise<any> {
    // Extensions call: ctx.ui.custom(factory, { overlay, overlayOptions, onHandle })
    // Parse arguments: first arg might be factory (function) or title (string)
    const id = crypto.randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let factory: ((...a: any[]) => any) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let options: Record<string, any> | undefined;
    let title = 'Extension Request';

    if (args.length > 0 && typeof args[0] === 'function') {
      factory = args[0];
      if (args.length > 1 && typeof args[1] === 'object' && args[1] !== null) {
        options = args[1];
      }
    } else if (args.length > 0 && typeof args[0] === 'string') {
      title = args[0];
      if (args.length > 1 && typeof args[1] === 'function') {
        factory = args[1];
      }
      if (args.length > 2 && typeof args[2] === 'object' && args[2] !== null) {
        options = args[2];
      }
    }

    // Try to call the factory and parse the component tree
    let parsed = null;
    if (factory) {
      parsed = await callFactoryAndParse(factory, title, options);
    }

    return createDialogPromise<string | undefined>(
      id,
      {
        method: 'custom',
        title,
        ...(parsed ? { parsed } : {}),
      },
      (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? (r.value as string) : undefined)
    );
  },

  notify(message, type) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'notify', message, notifyType: type });
  },

  onTerminalInput() {
    return () => {};
  },

  setStatus(key, text) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'setStatus', statusKey: key, statusText: text });
  },

  setWorkingMessage(message) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'setWorkingMessage', message });
  },
  setWorkingVisible(visible) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'setWorkingVisible', visible });
  },
  setWorkingIndicator(options) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'setWorkingIndicator', frames: options?.frames, intervalMs: options?.intervalMs });
  },
  setHiddenThinkingLabel(label) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'setHiddenThinkingLabel', label });
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setWidget(key: string, content: any, options?: { placement?: string }) {
    if (content === undefined) {
      broadcast({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setWidget',
        widgetKey: key,
        widgetType: 'text',
        widgetLines: [],
        widgetPlacement: options?.placement,
      });
    } else if (Array.isArray(content)) {
      broadcast({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setWidget',
        widgetKey: key,
        widgetType: 'text',
        widgetLines: content,
        widgetPlacement: options?.placement,
      });
    } else if (typeof content === 'function') {
      // Factory function — call it with stubs and try to get string[] content.
      // Extensions pass: (tui, theme) => ({ render(width): string[], invalidate() })
      try {
        const result = content(stubTui, stubTheme);
        if (result && typeof result === 'object' && typeof result.render === 'function') {
          // { render(width): string[] } pattern — call render to get lines
          const lines = result.render(80) as string[];
          if (Array.isArray(lines) && lines.length > 0) {
            // Strip ANSI escape codes
            const cleanLines = lines.map((l) => stripAnsi(l));
            broadcast({
              type: 'extension_ui_request',
              id: crypto.randomUUID(),
              method: 'setWidget',
              widgetKey: key,
              widgetType: 'text',
              widgetLines: cleanLines,
              widgetPlacement: options?.placement,
            });
          }
        } else if (Array.isArray(result)) {
          // Factory returned string[] directly
          broadcast({
            type: 'extension_ui_request',
            id: crypto.randomUUID(),
            method: 'setWidget',
            widgetKey: key,
            widgetType: 'text',
            widgetLines: result,
            widgetPlacement: options?.placement,
          });
        }
        // If result is a Component (Container/Box), we can't render it without a real TUI.
        // The component's render() output is ANSI terminal text — not useful for web.
      } catch {
        // Factory failed — ignore silently (extension may need real TUI)
      }
    }
  },

  setFooter(factory) {
    if (!factory) {
      broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'set_footer', content: '' });
      return;
    }
    void callFactoryAndParse(factory, '', undefined)
      .then((parsed) => {
        broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'set_footer', content: parsed?.kind === 'text' ? parsed.content : '' });
      })
      .catch(() => { /* factory may fail without real TUI */ });
  },
  setHeader(factory) {
    if (!factory) {
      broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'set_header', content: '' });
      return;
    }
    void callFactoryAndParse(factory, '', undefined)
      .then((parsed) => {
        broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'set_header', content: parsed?.kind === 'text' ? parsed.content : '' });
      })
      .catch(() => { /* factory may fail without real TUI */ });
  },

  setTitle(title) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'setTitle', title });
  },

  pasteToEditor(text) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'paste_to_editor', text });
  },

  setEditorText(text) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'set_editor_text', text });
  },

  getEditorText() {
    const id = crypto.randomUUID();
    return new Promise<string>((resolve) => {
      pendingEditorTextRequests.set(id, { resolve });
      broadcast({ type: 'extension_ui_request', id, method: 'request_editor_text' });
      // Timeout after 5 seconds to avoid hanging forever
      setTimeout(() => {
        if (pendingEditorTextRequests.has(id)) {
          pendingEditorTextRequests.delete(id);
          resolve('');
        }
      }, 5000);
    });
  },

  addAutocompleteProvider(factory) {
    if (factory) {
      autocompleteProviderWrappers.push(factory);
      chainAutocompleteProviders();
    }
  },
  setEditorComponent(factory) {
    if (!factory) {
      broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'set_editor_component', parsed: null });
      return;
    }
    void callFactoryAndParse(factory, '', undefined)
      .then((parsed) => {
        broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'set_editor_component', parsed });
      })
      .catch(() => { /* factory may fail without real TUI */ });
  },
  getEditorComponent() {
    // Web doesn't have a custom editor; return undefined so extensions fall back to default.
    return undefined;
  },

  // TUI-only stubs — no meaningful web equivalent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  theme: undefined as any,
  getAllThemes() { return []; },
  getTheme() { return undefined; },
  setTheme() { return { success: true }; },

  getToolsExpanded() {
    return toolsExpanded;
  },
  setToolsExpanded(expanded: boolean) {
    toolsExpanded = expanded;
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'setToolsExpanded', expanded });
  },
};

// ── 4. Pi SDK — lazy-loaded singleton ────────────────────────────────────────
//
// The SDK static import alone costs ~136 MB of RSS. By deferring the dynamic
// import until the first WebSocket connection, idle memory stays at ~32 MB
// (bare Bun + auth). First connection may wait ~10 s during SDK + session init.

let _sdk: typeof PiSDKNS | null = null;

// ── Autocomplete provider wrappers (extension-registered) ─────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AutocompleteProviderFactory = (current: any) => any;
const autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let chainedAutocompleteProvider: any = null;

function chainAutocompleteProviders() {
  // Start with a no-op base provider
  let provider = {
    async getSuggestions() { return null; },
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
      return { lines, cursorLine, cursorCol };
    },
  };
  for (const wrap of autocompleteProviderWrappers) {
    try { provider = wrap(provider); } catch { /* ignore broken providers */ }
  }
  chainedAutocompleteProvider = provider;
}
async function getSDK(): Promise<typeof PiSDKNS> {
  if (!_sdk) {
    console.log('[pifrontier] Loading pi SDK (first connection)…');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _sdk = await import('@earendil-works/pi-coding-agent') as any;
    console.log('[pifrontier] Pi SDK loaded.');
    // Resolve SDK version from its package.json (best-effort)
    try {
      const piPkgSpecifier = '@earendil-works/pi-coding-agent/package.json';
      const piPkg = await import(piPkgSpecifier, { with: { type: 'json' } }) as {
        default?: { version?: string };
        version?: string;
      };
      PI_SDK_VERSION = piPkg.default?.version ?? piPkg.version ?? 'unknown';
    } catch {
      // Not critical — version display stays 'unknown'
    }
  }
  return _sdk!;
}

// Mutable session singleton — null until ensureSession() is first called.
let session: AgentSession | null = null;
let unsubscribePi: (() => void) | null = null;
// Promise lock — prevents concurrent first-connection races from creating duplicate sessions.
let _sessionInitPromise: Promise<AgentSession> | null = null;

/**
 * Initialise (or return) the pi session. Loads the SDK and creates a session
 * on demand. Concurrent calls share the same initialisation promise.
 *
 * Uses SessionManager.continueRecent() to resume the most recent persisted
 * session, or create a new one. Sessions are saved to disk as .jsonl files
 * under ~/.pi/agent/sessions/.
 */
async function ensureSession(): Promise<AgentSession> {
  if (session) return session;
  if (!_sessionInitPromise) {
    _sessionInitPromise = (async () => {
      const sdk = await getSDK();
      console.log(`[pifrontier] Starting pi session in ${cwd} …`);
      const sm = sdk.SessionManager.continueRecent(cwd);
      const result = await sdk.createAgentSession({
        cwd,
        sessionManager: sm,
      });
      session = result.session;
      touchProject(session.sessionManager.getCwd() || cwd);
      console.log(`[pifrontier] Pi session ready: ${session.sessionId} (${sm.isPersisted() ? 'persisted' : 'in-memory'})`);
      await session.bindExtensions({ uiContext: uiContext as unknown as ExtensionUIContext });
      console.log('[pifrontier] Extension UI context bound.');
      unsubscribePi = session.subscribe((event) => {
        broadcast(event);
      });
      return session;
    })();
  }
  return _sessionInitPromise;
}

/**
 * Switch the active session, rebind extensions, resubscribe, and broadcast state.
 * Called for both new-session and switch-session commands.
 */
async function setActiveSession(newSession: AgentSession) {
  // Detach from the old session and dispose it to free memory
  if (unsubscribePi) {
    unsubscribePi();
    unsubscribePi = null;
  }
  const oldSession = session;
  if (oldSession && oldSession !== newSession) {
    oldSession.dispose();
  }

  // Clear extension autocomplete providers (extensions re-register via bindExtensions)
  autocompleteProviderWrappers.length = 0;
  chainedAutocompleteProvider = null;

  session = newSession;

  await session.bindExtensions({ uiContext: uiContext as unknown as ExtensionUIContext });

  unsubscribePi = session.subscribe((event) => {
    broadcast(event);
  });

  broadcast({
    type: 'session_loaded',
    sessionId: session.sessionId,
    isStreaming: session.isStreaming,
    thinkingLevel: session.thinkingLevel,
    model: serializeModel(session.model),
    availableModels: session.modelRegistry.getAvailable().map(serializeModel),
    messages: session.messages,
    cwd: session.sessionManager.getCwd() || cwd,
    sessionName: session.sessionManager.getSessionName(),
    isCompacting: session.isCompacting,
    autoCompactionEnabled: session.autoCompactionEnabled,
    autoRetryEnabled: session.autoRetryEnabled,
    piVersion: PI_SDK_VERSION,
    uiVersion: UI_VERSION,
    // Flag on session_loaded so UI shows the session mode
    sessionMode: session.sessionManager.isPersisted() ? 'persisted' : 'in-memory',
    contextUsage: session.getContextUsage(),
  });

  // Register/touch the project for the session's directory.
  touchProject(session.sessionManager.getCwd() || cwd);

  // Refresh sidebar session + project lists so all connected tabs see the change
  try {
    const all = await _sdk!.SessionManager.listAll();
    const sessions = all.map(serializeSession);
    const current = currentSessionSummary();
    if (current && !sessions.some((s) => s.id === current.id)) {
      sessions.unshift(current);
    }
    broadcast({ type: 'all_sessions_list', sessions });
  } catch (err) {
    console.error('[pifrontier] setActiveSession: failed to broadcast session list:', err);
  }
  await broadcastProjects();
}

// ── 5. Start server ───────────────────────────────────────────────────────────

const PORT = parseInt(Bun.env.PORT ?? '3000');

/** Bun pub/sub topic shared by all connected WebSocket clients. */
const WS_TOPIC = 'pi';

/** Per-connection WebSocket data. */
interface WSData {
  connectedAt: number;
}

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve<WSData>({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/ws') {
      const cookieHeader = req.headers.get('cookie') ?? '';
      if (!(await isValidSessionCookie(cookieHeader))) {
        return new Response('Unauthorized', { status: 401 });
      }
      const ok = server.upgrade(req, { data: { connectedAt: Date.now() } });
      if (ok) return undefined as unknown as Response;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    return DEV_WS_ONLY
      ? new Response('Use Vite dev server for HTTP in dev mode', { status: 404 })
      : (await getSvelteHandler())(req, server);
  },

  websocket: {
    async open(ws) {
      ws.subscribe(WS_TOPIC);
      connectedClients++;

      // Load SDK + session on first connection; subsequent calls return instantly.
      const sess = await ensureSession();

      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: sess.sessionId,
          isStreaming: sess.isStreaming,
          thinkingLevel: sess.thinkingLevel,
          model: serializeModel(sess.model),
          availableModels: sess.modelRegistry.getAvailable().map(serializeModel),
          messages: sess.messages,
          cwd: sess.sessionManager.getCwd() || cwd,
          sessionName: sess.sessionManager.getSessionName(),
          isCompacting: sess.isCompacting,
          autoCompactionEnabled: sess.autoCompactionEnabled,
          autoRetryEnabled: sess.autoRetryEnabled,
          piVersion: PI_SDK_VERSION,
          uiVersion: UI_VERSION,
          sessionMode: sess.sessionManager.isPersisted() ? 'persisted' : 'in-memory',
          contextUsage: sess.getContextUsage(),
        })
      );

      // Send extension commands immediately after connected
      try {
        const sessionCwd = sess.sessionManager.getCwd() || cwd;
        const agentDir = _sdk!.getAgentDir();
        const loader = new _sdk!.DefaultResourceLoader({ cwd: sessionCwd, agentDir });
        await loader.reload();
        const { extensions } = loader.getExtensions();
        const allCommands: { name: string; description?: string; source: string }[] = [];
        for (const ext of extensions) {
          for (const [name, cmd] of ext.commands) {
            allCommands.push({
              name,
              description: cmd.description,
              source: ext.sourceInfo.source,
            });
          }
        }
        ws.send(JSON.stringify({ type: 'commands_list', commands: allCommands }));
      } catch (err) {
        console.error('[pifrontier] Failed to send extension commands:', err);
      }
    },

    async message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }

      // Ensure SDK + session are loaded before dispatching any command.
      await ensureSession();

      try {
      switch (msg.type) {
        case 'prompt': {
          try {
            const imageContent = msg.images?.length
              ? msg.images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }))
              : undefined;
            await session!.prompt(msg.message, imageContent ? { images: imageContent } : undefined);
          } catch (err) {
            console.error('[pifrontier] prompt error:', err);
            ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
          }
          break;
        }

        case 'steer':
          try {
            await session!.steer(msg.message);
          } catch (err) {
            console.error('[pifrontier] steer error:', err);
            ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
          }
          break;

        case 'follow_up':
          try {
            await session!.followUp(msg.message);
          } catch (err) {
            console.error('[pifrontier] followUp error:', err);
            ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
          }
          break;

        case 'abort':
          await session!.abort();
          break;

        case 'set_thinking_level':
          session!.setThinkingLevel(msg.level as Parameters<AgentSession['setThinkingLevel']>[0]);
          break;

        case 'set_model': {
          const model = session!.modelRegistry.find(msg.provider, msg.modelId);
          if (!model) {
            console.warn(`[pifrontier] set_model: model not found: ${msg.provider}/${msg.modelId}`);
            break;
          }
          try {
            await session!.setModel(model);
            broadcast({ type: 'model_changed', model: serializeModel(model) });
          } catch (err) {
            console.error('[pifrontier] set_model error:', err);
          }
          break;
        }

        case 'list_sessions': {
          try {
            const list = await _sdk!.SessionManager.list(cwd);
            const sessions = list.slice(0, 30).map(serializeSession);
            // Prepend the current session — deduplicate if it already appears in the list
            const current = currentSessionSummary();
            if (current) {
              const alreadyListed = sessions.some((s) => s.id === current.id);
              if (!alreadyListed) sessions.unshift(current);
            }
            ws.send(JSON.stringify({ type: 'sessions_list', sessions }));
          } catch (err) {
            console.error('[pifrontier] list_sessions error:', err);
            ws.send(JSON.stringify({ type: 'sessions_list', sessions: [] }));
          }
          break;
        }

        case 'new_session': {
          try {
            const rawTargetCwd = (msg as { type: 'new_session'; targetCwd?: string }).targetCwd ?? cwd;
            const targetCwd = resolve(expandTilde(rawTargetCwd));
            // Create the directory if it doesn't exist (brand new folder).
            await mkdir(targetCwd, { recursive: true });
            const sm = _sdk!.SessionManager.create(targetCwd);
            const { session: newSession } = await _sdk!.createAgentSession({
              cwd: targetCwd,
              sessionManager: sm,
              modelRegistry: session!.modelRegistry,
              model: session!.model,
            });
            await setActiveSession(newSession);
          } catch (err) {
            console.error('[pifrontier] new_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }

        case 'switch_session': {
          try {
            // If the user selects the current session path, just ignore it.
            const resolvedPath = resolve(cwd, expandTilde(msg.path));
            if (session?.sessionManager.getSessionFile() === resolvedPath) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Already on this session.' }));
              break;
            }
            // Security: only open known session files — never raw client paths.
            const knownSessions = await _sdk!.SessionManager.listAll();
            if (!knownSessions.some((s) => s.path === resolvedPath)) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Session not found.' }));
              break;
            }
            const sm = _sdk!.SessionManager.open(resolvedPath);
            const { session: newSession } = await _sdk!.createAgentSession({
              cwd: sm.getCwd() || cwd,
              sessionManager: sm,
              modelRegistry: session!.modelRegistry,
              model: session!.model,
            });
            await setActiveSession(newSession);
          } catch (err) {
            console.error('[pifrontier] switch_session error:', err);
          }
          break;
        }

        case 'extension_ui_response': {
          const pending = pendingExtensionRequests.get(msg.id);
          if (pending) {
            pending.resolve(msg as unknown as Record<string, unknown>);
          }
          break;
        }

        case 'editor_text_response': {
          const pendingEditor = pendingEditorTextRequests.get(msg.id);
          if (pendingEditor) {
            pendingEditorTextRequests.delete(msg.id);
            pendingEditor.resolve(msg.text ?? '');
          }
          break;
        }

        case 'get_providers': {
          ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
          break;
        }

        case 'set_provider_key': {
          try {
            session!.modelRegistry.authStorage.set(msg.provider, { type: 'api_key', key: msg.key });
            session!.modelRegistry.refresh();
            ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
            broadcast({
              type: 'available_models_changed',
              availableModels: session!.modelRegistry.getAvailable().map(serializeModel),
            });
          } catch (err) {
            console.error('[pifrontier] set_provider_key error:', err);
            ws.send(JSON.stringify({ type: 'providers_error', message: String(err) }));
          }
          break;
        }

        case 'remove_provider_key': {
          try {
            session!.modelRegistry.authStorage.remove(msg.provider);
            session!.modelRegistry.refresh();
            ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
            broadcast({
              type: 'available_models_changed',
              availableModels: session!.modelRegistry.getAvailable().map(serializeModel),
            });
          } catch (err) {
            console.error('[pifrontier] remove_provider_key error:', err);
            ws.send(JSON.stringify({ type: 'providers_error', message: String(err) }));
          }
          break;
        }

        case 'rename_session': {
          try {
            // Security: only accept paths of known sessions — never trust raw user paths.
            // (Session files live under ~/.pi, outside cwd, so containment checks don't apply.)
            const known = await _sdk!.SessionManager.listAll();
            const target = known.find((s) => s.path === msg.path);
            if (!target) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Session not found.' }));
              break;
            }
            const sm = _sdk!.SessionManager.open(target.path);
            sm.appendSessionInfo(msg.name);
            // If renaming the active session, also fire the SDK event so all
            // connected browsers see the name change via session_info_changed.
            if (msg.path === session!.sessionFile) {
              session!.setSessionName(msg.name);
            }
            const all = await _sdk!.SessionManager.listAll();
            broadcast({ type: 'all_sessions_list', sessions: all.map(serializeSession) });
            ws.send(JSON.stringify({ type: 'sessions_list', sessions: [] }));
          } catch (err) {
            console.error('[pifrontier] rename_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }

        case 'rename_current_session': {
          try {
            // Set the name on the live session (emits session_info_changed to all browsers)
            session!.setSessionName(msg.name);
            // Also persist it to the session file if available
            if (session!.sessionFile) {
              const sm = _sdk!.SessionManager.open(session!.sessionFile);
              sm.appendSessionInfo(msg.name);
            }
          } catch (err) {
            console.error('[pifrontier] rename_current_session error:', err);
          }
          break;
        }

        case 'delete_session': {
          try {
            // Validate the path is a known session file — never trust raw user paths.
            // listAll() because the sidebar offers deletion across all projects.
            const list = await _sdk!.SessionManager.listAll();
            const target = list.find((s) => s.path === msg.path);
            if (!target) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Session not found.' }));
              break;
            }
            if (target.id === session!.sessionId) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Cannot delete the active session.' }));
              break;
            }
            // Path came from SessionManager.listAll() — already validated by SDK.
            await rm(target.path);
            const all = await _sdk!.SessionManager.listAll();
            broadcast({ type: 'all_sessions_list', sessions: all.map(serializeSession) });
            await broadcastProjects();
            ws.send(JSON.stringify({ type: 'sessions_list', sessions: [] }));
          } catch (err) {
            console.error('[pifrontier] delete_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }

        case 'get_all_sessions': {
          try {
            const all = await _sdk!.SessionManager.listAll();
            const sessions = all.map(serializeSession);
            const current = currentSessionSummary();
            if (current && !sessions.some((s) => s.id === current.id)) {
              sessions.unshift(current);
            }
            ws.send(JSON.stringify({ type: 'all_sessions_list', sessions }));
          } catch (err) {
            console.error('[pifrontier] get_all_sessions error:', err);
            ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
          }
          break;
        }

        case 'get_projects': {
          ws.send(JSON.stringify({ type: 'projects_list', projects: await buildProjectsList() }));
          break;
        }

        case 'add_project': {
          try {
            const raw = (msg as { type: 'add_project'; path: string }).path ?? '';
            if (!raw.trim() || raw.includes('\0')) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Invalid project path.' }));
              break;
            }
            const target = resolve(expandTilde(raw.trim()));
            // Same trust level as new_session: create the folder if it's brand new.
            await mkdir(target, { recursive: true });
            touchProject(target);
            await broadcastProjects();
          } catch (err) {
            console.error('[pifrontier] add_project error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }

        case 'remove_project': {
          const target = (msg as { type: 'remove_project'; cwd: string }).cwd ?? '';
          if (target === (session?.sessionManager.getCwd() || cwd)) {
            ws.send(JSON.stringify({ type: 'sessions_error', message: 'Cannot forget the active project.' }));
            break;
          }
          removeProject(target);
          await broadcastProjects();
          break;
        }

        case 'pin_project': {
          const { cwd: target, pinned } = msg as { type: 'pin_project'; cwd: string; pinned: boolean };
          if (typeof target === 'string' && target.trim()) {
            setProjectPinned(target, Boolean(pinned));
            await broadcastProjects();
          }
          break;
        }

        case 'rename_project': {
          const { cwd: target, name } = msg as { type: 'rename_project'; cwd: string; name: string };
          if (typeof target === 'string' && target.trim()) {
            renameProject(target, typeof name === 'string' ? name : '');
            await broadcastProjects();
          }
          break;
        }

        case 'dir_complete': {
          try {
            const prefix = expandTilde((msg as { type: 'dir_complete'; prefix: string }).prefix);
            const { readdir } = await import('node:fs/promises');
            const { dirname, basename: pathBasename, join: pathJoin } = await import('node:path');
            const isDir = prefix.endsWith('/');
            const dir = isDir ? prefix : dirname(prefix);
            const resolvedDir = resolve(dir);
            const fragment = isDir ? '' : pathBasename(prefix).toLowerCase();
            let entries: string[] = [];
            try {
              const dirents = await readdir(resolvedDir, { withFileTypes: true });
              entries = dirents
                .filter((d) => d.isDirectory() && (fragment === '' || d.name.toLowerCase().startsWith(fragment)))
                .map((d) => pathJoin(dir, d.name) + '/')
                .slice(0, 20);
            } catch {
              entries = [];
            }
            ws.send(JSON.stringify({ type: 'dir_completions', prefix, entries }));
          } catch (err) {
            console.error('[pifrontier] dir_complete error:', err);
          }
          break;
        }

        case 'file_complete': {
          try {
            const query = ((msg as { type: 'file_complete'; query: string }).query ?? '').toLowerCase();
            const { readdir } = await import('node:fs/promises');
            const { join, relative } = await import('node:path');
            const root = session!.sessionManager.getCwd() || cwd;
            const skip = new Set(['.git', 'node_modules', '.svelte-kit', 'build', 'dist', '.cache']);
            const entries: string[] = [];
            const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

            while (queue.length > 0 && entries.length < 40) {
              const item = queue.shift()!;
              let dirents: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
              try {
                dirents = await readdir(item.dir, { withFileTypes: true }) as typeof dirents;
              } catch {
                continue;
              }

              for (const dirent of dirents) {
                if (dirent.name.startsWith('.') && dirent.name !== '.env') continue;
                if (skip.has(dirent.name)) continue;
                const abs = join(item.dir, dirent.name);
                const rel = relative(root, abs);
                if (dirent.isFile() && (!query || rel.toLowerCase().includes(query))) {
                  entries.push(rel);
                  if (entries.length >= 40) break;
                } else if (dirent.isDirectory() && item.depth < 3) {
                  queue.push({ dir: abs, depth: item.depth + 1 });
                }
              }
            }

            ws.send(JSON.stringify({ type: 'file_completions', query, entries }));
          } catch (err) {
            console.error('[pifrontier] file_complete error:', err);
            ws.send(JSON.stringify({ type: 'file_completions', query: '', entries: [] }));
          }
          break;
        }

        case 'get_extension_autocomplete': {
          try {
            const { trigger, query } = msg as { type: 'get_extension_autocomplete'; trigger: string; query: string };
            if (!chainedAutocompleteProvider) {
              ws.send(JSON.stringify({ type: 'extension_completions', trigger, query, items: [] }));
              break;
            }
            // Synthesize lines/cursor from the trigger + query
            const inputText = `${trigger}${query ?? ''}`;
            const lines = [inputText];
            const cursorLine = 0;
            const cursorCol = inputText.length;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const result = await chainedAutocompleteProvider.getSuggestions(lines, cursorLine, cursorCol, {
              signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const items = result?.items ?? [];
            ws.send(JSON.stringify({ type: 'extension_completions', trigger, query, items }));
          } catch (err) {
            console.error('[pifrontier] get_extension_autocomplete error:', err);
            const { trigger: fallbackTrigger = '', query: fallbackQuery = '' } = msg as { trigger?: string; query?: string };
            ws.send(JSON.stringify({ type: 'extension_completions', trigger: fallbackTrigger, query: fallbackQuery, items: [] }));
          }
          break;
        }

        case 'compact': {
          session!.compact().catch((err) => {
            console.error('[pifrontier] compact error:', err);
          });
          break;
        }

        case 'set_auto_compaction': {
          session!.setAutoCompactionEnabled(msg.enabled);
          break;
        }

        case 'set_auto_retry': {
          session!.setAutoRetryEnabled(msg.enabled);
          break;
        }

        case 'run_builtin': {
          const command = String((msg as { type: 'run_builtin'; command: string; args?: string }).command ?? '').toLowerCase();
          const args = String((msg as { type: 'run_builtin'; command: string; args?: string }).args ?? '').trim();
          try {
            switch (command) {
              case 'reload': {
                await session!.reload();
                sendSlashResult(ws, command, 'Reloaded extensions, skills, prompts, and tools.');
                ws.send(JSON.stringify({
                  type: 'tools_list',
                  tools: session!.getAllTools().map((t) => ({
                    name: t.name,
                    description: t.description,
                    isBuiltin: t.sourceInfo.origin === 'package',
                  })),
                  activeToolNames: session!.getActiveToolNames(),
                }));
                break;
              }
              case 'logout': {
                const provider = args || session!.model?.provider;
                if (!provider) {
                  sendSlashResult(ws, command, 'No provider selected. Pass a provider name, e.g. /logout openai.', 'warning');
                  break;
                }
                session!.modelRegistry.authStorage.remove(provider);
                session!.modelRegistry.refresh();
                ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
                broadcast({
                  type: 'available_models_changed',
                  availableModels: session!.modelRegistry.getAvailable().map(serializeModel),
                });
                sendSlashResult(ws, command, `Removed stored credentials for ${provider}.`);
                break;
              }
              case 'clone': {
                const leafId = session!.sessionManager.getLeafId();
                if (!leafId) {
                  sendSlashResult(ws, command, 'No session branch to clone yet.', 'warning');
                  break;
                }
                const newPath = session!.sessionManager.createBranchedSession(leafId);
                if (!newPath) {
                  // Fallback — create a fresh persisted session
                  const clonedSm = _sdk!.SessionManager.create(cwd);
                  const { session: clonedSession } = await _sdk!.createAgentSession({
                    cwd,
                    sessionManager: clonedSm,
                    modelRegistry: session!.modelRegistry,
                    model: session!.model,
                        });
                  await setActiveSession(clonedSession);
                  sendSlashResult(ws, command, 'Cloned to a fresh session.');
                  break;
                }
                const clonedSm = _sdk!.SessionManager.open(newPath);
                const { session: clonedSession } = await _sdk!.createAgentSession({
                  cwd: clonedSm.getCwd() || cwd,
                  sessionManager: clonedSm,
                  modelRegistry: session!.modelRegistry,
                  model: session!.model,
                    });
                await setActiveSession(clonedSession);
                sendSlashResult(ws, command, `Cloned current branch to ${newPath}.`);
                break;
              }
              case 'tree': {
                const tree = session!.sessionManager.getTree();
                const lines = tree.flatMap((node) => formatTreeNode(node as Parameters<typeof formatTreeNode>[0]));
                sendSlashResult(ws, command, lines.length ? `Session tree:\n${lines.join('\n')}` : 'Session tree is empty.');
                break;
              }
              case 'session': {
                const stats = session!.getSessionStats();
                const context = session!.getContextUsage();
                const lines = [
                  `Session: ${stats.sessionId}`,
                  `File: ${stats.sessionFile ?? '(not persisted)'}`,
                  `Messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant)`,
                  `Tools: ${stats.toolCalls} calls, ${stats.toolResults} results`,
                  `Tokens: ${stats.tokens.total.toLocaleString()} total (${stats.tokens.input.toLocaleString()} in, ${stats.tokens.output.toLocaleString()} out)`,
                  `Cost: $${stats.cost.toFixed(4)}`,
                  ...(context ? [`Context: ${context.tokens == null ? 'unknown' : context.tokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens${context.percent == null ? '' : ` (${context.percent}%)`}`] : []),
                ];
                sendSlashResult(ws, command, lines.join('\n'));
                break;
              }
              case 'export': {
                const format = args.toLowerCase().includes('json') ? 'jsonl' : 'html';
                const out = format === 'jsonl' ? session!.exportToJsonl() : await session!.exportToHtml();
                sendSlashResult(ws, command, `Exported current session to ${out}.`);
                break;
              }
              case 'share': {
                const out = await session!.exportToHtml();
                sendSlashResult(ws, command, `Created a local share/export at ${out}. GitHub gist sharing is not configured in pi-ui.`);
                break;
              }
              case 'changelog': {
                const { readFile } = await import('node:fs/promises');
                const text = await readFile(join(process.cwd(), 'node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md'), 'utf8');
                sendSlashResult(ws, command, text.split('\n').slice(0, 80).join('\n'));
                break;
              }
              case 'name': {
                if (!args) {
                  sendSlashResult(ws, command, session!.sessionName ? `Session name: ${session!.sessionName}` : 'No session name set.');
                  break;
                }
                session!.setSessionName(args);
                sendSlashResult(ws, command, `Session renamed to ${args}.`);
                break;
              }
              case 'shell': {
                if (!args) {
                  sendSlashResult(ws, command, 'Usage: ! <command>', 'warning');
                  break;
                }
                const shellResult = Bun.spawnSync(['bash', '-c', args], {
                  cwd: session?.sessionManager.getCwd() || cwd,
                  env: { ...process.env as Record<string, string>, PI_CWD: cwd },
                });
                const shellOutput = [
                  ...(shellResult.stdout?.length ? [new TextDecoder().decode(shellResult.stdout)] : []),
                  ...(shellResult.stderr?.length ? [new TextDecoder().decode(shellResult.stderr)] : []),
                  ...(shellResult.exitCode !== 0 ? [`\nexit code: ${shellResult.exitCode}`] : []),
                ].join('').trim();
                sendSlashResult(ws, command, shellOutput || '(no output)', shellResult.exitCode === 0 ? 'info' : 'error');
                break;
              }
              default:
                sendSlashResult(ws, command, `Unsupported built-in command: /${command}`, 'warning');
                break;
            }
          } catch (err) {
            console.error(`[pifrontier] run_builtin ${command} error:`, err);
            sendSlashResult(ws, command, String(err), 'error');
          }
          break;
        }

        case 'get_session_tree': {
          try {
            const tree = session!.sessionManager.getTree();
            const serialized = tree.map((node) => serializeTreeNode(node as Parameters<typeof serializeTreeNode>[0]));
            ws.send(JSON.stringify({ type: 'session_tree', tree: serialized }));
          } catch (err) {
            console.error('[pifrontier] get_session_tree error:', err);
            ws.send(JSON.stringify({ type: 'session_tree', tree: [] }));
          }
          break;
        }

        case 'get_fork_points': {
          try {
            const entries = session!.getUserMessagesForForking();
            ws.send(JSON.stringify({ type: 'fork_points', entries }));
          } catch (err) {
            console.error('[pifrontier] get_fork_points error:', err);
            ws.send(JSON.stringify({ type: 'fork_points', entries: [] }));
          }
          break;
        }

        case 'get_tools': {
          try {
            const allTools = session!.getAllTools();
            const activeNames = session!.getActiveToolNames();
            ws.send(JSON.stringify({
              type: 'tools_list',
              tools: allTools.map((t) => ({
                name: t.name,
                description: t.description,
                isBuiltin: t.sourceInfo.origin === 'package',
              })),
              activeToolNames: activeNames,
            }));
          } catch (err) {
            console.error('[pifrontier] get_tools error:', err);
          }
          break;
        }

        case 'set_active_tools': {
          try {
            session!.setActiveToolsByName(msg.toolNames as string[]);
          } catch (err) {
            console.error('[pifrontier] set_active_tools error:', err);
          }
          break;
        }

        case 'get_resources': {
          try {
            const sessionCwd = session!.sessionManager.getCwd() || cwd;
            const agentDir = _sdk!.getAgentDir();
            const loader = new _sdk!.DefaultResourceLoader({ cwd: sessionCwd, agentDir });
            await loader.reload();
            const { skills } = loader.getSkills();
            const { prompts } = loader.getPrompts();
            const skillSummaries: SkillSummary[] = skills.map((s) => ({
              name: s.name,
              description: s.description,
              scope: s.sourceInfo.scope,
              isBuiltin: s.sourceInfo.origin === 'package',
              source: s.sourceInfo.source,
            }));
            const promptSummaries: PromptSummary[] = prompts.map((p) => ({
              name: p.name,
              description: p.description,
              argumentHint: p.argumentHint,
              scope: p.sourceInfo.scope,
              isBuiltin: p.sourceInfo.origin === 'package',
              source: p.sourceInfo.source,
            }));
            ws.send(JSON.stringify({ type: 'resources_list', skills: skillSummaries, prompts: promptSummaries }));
          } catch (err) {
            console.error('[pifrontier] get_resources error:', err);
            ws.send(JSON.stringify({ type: 'resources_list', skills: [], prompts: [] }));
          }
          break;
        }

        case 'get_extensions': {
          try {
            const sessionCwd = session!.sessionManager.getCwd() || cwd;
            const agentDir = _sdk!.getAgentDir();
            const loader = new _sdk!.DefaultResourceLoader({ cwd: sessionCwd, agentDir });
            await loader.reload();
            const { extensions, errors } = loader.getExtensions();
            const summaries: ExtensionSummary[] = extensions.map((e) => ({
              source: e.sourceInfo.source,
              path: e.sourceInfo.path,
              scope: e.sourceInfo.scope,
              origin: e.sourceInfo.origin,
              tools: [...e.tools.values()].map((t) => ({
                name: t.definition.name,
                description: t.definition.description ?? '',
              })),
              commands: [...e.commands.values()].map((c) => ({
                name: c.name,
                description: c.description ?? '',
              })),
              flags: [...e.flags.keys()],
            }));
            ws.send(JSON.stringify({ type: 'extensions_list', extensions: summaries, errors }));
          } catch (err) {
            console.error('[pifrontier] get_extensions error:', err);
            ws.send(JSON.stringify({ type: 'extensions_list', extensions: [], errors: [] }));
          }
          break;
        }

        case 'get_commands': {
          try {
            const sessionCwd = session!.sessionManager.getCwd() || cwd;
            const agentDir = _sdk!.getAgentDir();
            const loader = new _sdk!.DefaultResourceLoader({ cwd: sessionCwd, agentDir });
            await loader.reload();
            const { extensions } = loader.getExtensions();
            const allCommands: { name: string; description?: string; source: string }[] = [];
            for (const ext of extensions) {
              for (const [name, cmd] of ext.commands) {
                allCommands.push({
                  name,
                  description: cmd.description,
                  source: ext.sourceInfo.source,
                });
              }
            }
            ws.send(JSON.stringify({ type: 'commands_list', commands: allCommands }));
          } catch (err) {
            console.error('[pifrontier] get_commands error:', err);
            ws.send(JSON.stringify({ type: 'commands_list', commands: [] }));
          }
          break;
        }

        case 'install_skill': {
          try {
            const rawUrl = resolveGitHubRawUrl(msg.url as string);
            // Security: only allow fetching from trusted hosts to prevent SSRF.
            const ALLOWED_HOSTS = ['github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com'];
            try {
              const parsedUrl = new URL(rawUrl);
              if (!ALLOWED_HOSTS.includes(parsedUrl.hostname)) {
                ws.send(JSON.stringify({ type: 'skill_install_result', success: false, error: `Blocked: only GitHub URLs are allowed (got ${parsedUrl.hostname}).` }));
                break;
              }
            } catch {
              ws.send(JSON.stringify({ type: 'skill_install_result', success: false, error: 'Invalid URL.' }));
              break;
            }
            // redirect:'error' — the host whitelist above is checked pre-fetch only,
            // so following redirects could smuggle content from arbitrary hosts.
            const res = await fetch(rawUrl, { redirect: 'error' });
            if (!res.ok) {
              ws.send(JSON.stringify({ type: 'skill_install_result', success: false, error: `HTTP ${res.status}: ${res.statusText}` }));
              break;
            }
            const content = await res.text();
            const fileName = basename(rawUrl.split('?')[0]);
            const safeFileName = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
            const sessionCwd = session!.sessionManager.getCwd() || cwd;
            const destDir = (msg.scope as string) === 'user'
              ? join(_sdk!.getAgentDir(), 'skills')
              : resolve(sessionCwd, PI_CONFIG_DIR, 'skills');
            await mkdir(destDir, { recursive: true });
            const destPath = join(destDir, safeFileName);
            await writeFile(destPath, content, 'utf8');
            // Extract skill name from frontmatter or filename
            const nameMatch = content.match(/^---[\s\S]*?^name:\s*(.+)$/m);
            const skillName = nameMatch ? nameMatch[1].trim() : safeFileName.replace(/\.md$/, '');
            ws.send(JSON.stringify({ type: 'skill_install_result', success: true, name: skillName }));
          } catch (err) {
            console.error('[pifrontier] install_skill error:', err);
            ws.send(JSON.stringify({ type: 'skill_install_result', success: false, error: String(err) }));
          }
          break;
        }

        case 'fork_session': {
          try {
            const entryId = (msg as { type: 'fork_session'; entryId: string }).entryId;
            if (!session!.sessionFile) throw new Error('Active session is not persisted');
            const sm = _sdk!.SessionManager.open(session!.sessionFile);
            const forkPath = sm.createBranchedSession(entryId);
            const sm2 = _sdk!.SessionManager.open(forkPath);
            const { session: forkedSession } = await _sdk!.createAgentSession({
              cwd,
              sessionManager: sm2,
              modelRegistry: session!.modelRegistry,
              model: session!.model,
            });
            await setActiveSession(forkedSession);
          } catch (err) {
            console.error('[pifrontier] fork_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }

        case 'read_file': {
          try {
            const filePath = (msg as { type: 'read_file'; path: string }).path;
            // Security: reject null bytes (path traversal via null injection).
            if (filePath.includes('\0')) {
              ws.send(JSON.stringify({ type: 'file_content', path: filePath, content: '', error: 'Invalid path' }));
              break;
            }
            // Security: resolve relative to the active project root and ensure it doesn't escape
            const resolved = resolve(activeCwd(), filePath);
            if (!isInsideWorkspace(resolved)) {
              ws.send(JSON.stringify({ type: 'file_content', path: filePath, content: '', error: 'Path escapes workspace root' }));
              break;
            }
            const file = Bun.file(resolved);
            if (await file.exists()) {
              // Cap reads — loading huge logs/binaries into memory would hurt the Pi.
              const MAX_READ_BYTES = 2 * 1024 * 1024;
              if (file.size > MAX_READ_BYTES) {
                ws.send(JSON.stringify({ type: 'file_content', path: filePath, content: '', error: `File too large to view (${(file.size / 1024 / 1024).toFixed(1)} MB > 2 MB)` }));
                break;
              }
              const content = await file.text();
              ws.send(JSON.stringify({ type: 'file_content', path: filePath, content }));
            } else {
              ws.send(JSON.stringify({ type: 'file_content', path: filePath, content: '', error: 'File not found' }));
            }
          } catch (err) {
            console.error('[pifrontier] read_file error:', err);
            ws.send(JSON.stringify({ type: 'file_content', path: (msg as { type: 'read_file'; path: string }).path, content: '', error: String(err) }));
          }
          break;
        }

        case 'write_file': {
          try {
            const { path: filePath, content: fileContent } = msg as { type: 'write_file'; path: string; content: string };
            if (filePath.includes('\0')) {
              ws.send(JSON.stringify({ type: 'file_saved', path: filePath, error: 'Invalid path' }));
              break;
            }
            const resolved = resolve(activeCwd(), filePath);
            if (!isInsideWorkspace(resolved)) {
              ws.send(JSON.stringify({ type: 'file_saved', path: filePath, error: 'Path escapes workspace root' }));
              break;
            }
            await Bun.write(resolved, fileContent);
            ws.send(JSON.stringify({ type: 'file_saved', path: filePath }));
          } catch (err) {
            console.error('[pifrontier] write_file error:', err);
            ws.send(JSON.stringify({ type: 'file_saved', path: (msg as { type: 'write_file'; path: string }).path, error: String(err) }));
          }
          break;
        }

        case 'get_update_status': {
          try {
            const status = await getUpdateStatus();
            ws.send(JSON.stringify({ type: 'update_status', ...status }));
          } catch (err) {
            console.error('[pifrontier] get_update_status error:', err);
            ws.send(JSON.stringify({
              type: 'update_status',
              appRoot: APP_ROOT,
              mode: 'package',
              busy: updateInProgress,
              canUpdateUi: false,
              canUpdateSdk: false,
              ui: { name: UI_PACKAGE_NAME, current: UI_VERSION, error: String(err) },
              sdk: { name: PI_SDK_PACKAGE_NAME, current: PI_SDK_VERSION, error: String(err) },
              notes: ['Unable to check for updates.'],
            }));
          }
          break;
        }

        case 'run_update': {
          await runUpdate((msg as { type: 'run_update'; target: UpdateTarget }).target, ws);
          break;
        }

        case 'request_restart': {
          // Issue a single-use nonce — the client must send it back in restart_server.
          pendingRestartNonce = crypto.randomUUID();
          ws.send(JSON.stringify({ type: 'restart_nonce', nonce: pendingRestartNonce }));
          break;
        }

        case 'restart_server': {
          // Restart requires a valid nonce obtained from a 'request_restart'
          // message. This prevents replay attacks and ensures intentionality.
          const nonce = (msg as { type: 'restart_server'; nonce?: string }).nonce;
          if (!nonce || nonce !== pendingRestartNonce) {
            ws.send(JSON.stringify({ type: 'sessions_error', message: 'Invalid or missing restart nonce.' }));
            break;
          }
          pendingRestartNonce = null; // consume the nonce — single use
          console.log('[pifrontier] Restart confirmed — broadcasting and re-execing…');
          broadcast({ type: 'server_restarting' });
          setTimeout(() => {
            Bun.spawn([process.execPath, ...process.argv.slice(1)], {
              env: process.env as Record<string, string>,
              detached: true,
              stdio: ['inherit', 'inherit', 'inherit'],
            });
            process.exit(0);
          }, 400);
          break;
        }
      } // end switch
      } catch (err) {
        console.error('[pifrontier] WS message handler error:', err);
      }
    },

    close(ws) {
      ws.unsubscribe(WS_TOPIC);
      connectedClients = Math.max(0, connectedClients - 1);
      // Only cancel pending extension dialogs when the LAST client disconnects —
      // other open tabs may still answer them.
      if (connectedClients === 0) {
        cancelAllPendingExtensionRequests();
      }
    },

    idleTimeout: 120,
    maxPayloadLength: 4 * 1024 * 1024, // 4 MB — prevents OOM from oversized messages
    perMessageDeflate: true,
  },
});
} catch (err: unknown) {
  const error = err as { code?: string; message?: string };
  if (error.code === 'EADDRINUSE') {
    console.error(`[pifrontier] Port ${PORT} is already in use.`);
    console.error(`[pifrontier] Use a different port: pi-ui --port ${PORT + 1}`);
  } else {
    console.error('[pifrontier] Failed to start server:', error.message ?? err);
  }
  process.exit(1);
}

// ── 6. Wire up broadcast ──────────────────────────────────────────────────────
// Session subscription is set up inside ensureSession() on first WS connection.

broadcast = (payload) => server.publish(WS_TOPIC, JSON.stringify(payload));

console.log(`[pifrontier] Listening on http://localhost:${PORT}`);
