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
import { callFactoryAndParse, StubTui, stubTui, stubTheme, stripAnsi } from './src/lib/tui-stubs.ts';
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
  return activeSessionOrNull()?.sessionManager.getCwd() || cwd;
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
  const allModels = activeSession().modelRegistry.getAll();
  const providerCount = new Map<string, number>();
  for (const m of allModels) {
    providerCount.set(m.provider, (providerCount.get(m.provider) ?? 0) + 1);
  }

  const providers: ProviderInfo[] = [];
  for (const [providerId, modelCount] of providerCount) {
    const status = activeSession().modelRegistry.getProviderAuthStatus(providerId);
    providers.push({
      id: providerId,
      name: activeSession().modelRegistry.getProviderDisplayName(providerId),
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

/** Build a SessionSummary for the active session. */
function currentSessionSummary(): SessionSummary | null {
  const s = activeSessionOrNull();
  if (!s) return null;
  const msg = s.messages[0] as { content?: string | Array<unknown> } | undefined;
  const firstMsg = msg?.content
    ? (typeof msg.content === 'string' ? msg.content.slice(0, 120) : '(complex)')
    : '';
  return {
    id: s.sessionId,
    path: s.sessionManager.getSessionFile() ?? '(in-memory)',
    cwd: s.sessionManager.getCwd() || cwd,
    name: s.sessionManager.getSessionName() || undefined,
    created: Date.now(),
    modified: Date.now(),
    messageCount: s.messages.length,
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
  // No browser client connected — resolve immediately so the agent doesn't hang.
  if (connectedClients === 0) {
    return Promise.resolve(parseResponse({ cancelled: true }));
  }
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
  // Clean up interactive custom components
  for (const [, component] of interactiveCustomComponents) {
    try { component.dispose?.(); } catch { /* ignore */ }
  }
  interactiveCustomComponents.clear();
  for (const [, interval] of interactiveRenderIntervals) {
    clearInterval(interval);
  }
  interactiveRenderIntervals.clear();
  // Clean up widget refresh intervals
  for (const [, entry] of widgetFactories) {
    clearInterval(entry.intervalId);
  }
  widgetFactories.clear();
}

// Server-side state for extension UI context
let toolsExpanded = false;

// Interactive custom component instances (keyed by dialog ID)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const interactiveCustomComponents = new Map<string, any>();
// Render-polling intervals for interactive components (keyed by same dialog ID)
const interactiveRenderIntervals = new Map<string, Timer>();

function broadcastCustomRender(id: string, component: { render(w: number): unknown }) {
  try {
    const rawLines = component.render(80) as string[];
    const cleanLines = Array.isArray(rawLines) ? rawLines.map((l: string) => stripAnsi(l)) : [];
    broadcast({ type: 'custom_render', id, lines: cleanLines });
  } catch { /* component may have disposed */ }
}

// Widget factories with refresh intervals
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const widgetFactories = new Map<string, { factory: (...args: any[]) => any; intervalId: Timer; placement?: string }>();

function clearWidgetInterval(key: string) {
  const existing = widgetFactories.get(key);
  if (existing) {
    clearInterval(existing.intervalId);
    widgetFactories.delete(key);
  }
}

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

    const tui = new StubTui() as any;
    const done = (val: any) => {
      const pending = pendingExtensionRequests.get(id);
      if (pending) pending.resolve({ value: val });
    };

    // Try to detect interactive components (render + handleInput)
    let parsed = null;
    if (factory) {
      try {
        const component = await factory(tui, stubTheme, stubKeybindings, done);
        if (component && typeof component === 'object') {
          // If factory returns a component, it's the root of our TUI tree
          tui.addChild(component);

          // We treat any component with a render() function as potentially interactive
          if (typeof component.render === 'function') {
            if (connectedClients === 0) {
              try { component.dispose?.(); } catch { /* ignore */ }
              return undefined;
            }
            interactiveCustomComponents.set(id, tui); // Store the TUI wrapper so we can route keys
            
            // Poll render every 200ms so sub-session events update the display
            const pollId = setInterval(() => {
              try {
                const rawLines = tui.render();
                const cleanLines = Array.isArray(rawLines) ? rawLines.map((l: string) => stripAnsi(l)) : [];
                broadcast({ type: 'custom_render', id, lines: cleanLines });
              } catch { /* disposed */ }
            }, 200);
            interactiveRenderIntervals.set(id, pollId);

            const rawLines = tui.render();
            const cleanLines = Array.isArray(rawLines) ? rawLines.map((l: string) => stripAnsi(l)) : [];

            return new Promise<string | undefined>((resolve) => {
              pendingExtensionRequests.set(id, {
                resolve: (r) => {
                  interactiveCustomComponents.delete(id);
                  const pi = interactiveRenderIntervals.get(id);
                  if (pi) { clearInterval(pi); interactiveRenderIntervals.delete(id); }
                  try { component.dispose?.(); } catch { /* ignore */ }
                  pendingExtensionRequests.delete(id);
                  resolve('cancelled' in r && r.cancelled ? undefined : 'value' in r ? (r.value as string) : undefined);
                },
              });
              broadcast({
                type: 'extension_ui_request',
                id,
                method: 'custom',
                title,
                lines: cleanLines,
                interactive: true,
              });
            });
          }
          // Not interactive — parse as component tree
          parsed = parseComponentTree(component, 80);
        }
      } catch (err) {
        console.error('[pifrontier] custom factory error:', err);
        // Fallback to static parsing
        parsed = await callFactoryAndParse(factory, title, options);
      }
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
      clearWidgetInterval(key);
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
      clearWidgetInterval(key);
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
      // Factory function — store and poll for live updates
      clearWidgetInterval(key);
      const tick = () => {
        try {
          const result = content(stubTui, stubTheme);
          if (result && typeof result === 'object' && typeof result.render === 'function') {
            const rawLines = result.render(80) as string[];
            if (!Array.isArray(rawLines)) return;
            const cleanLines = rawLines.map((l: string) => stripAnsi(l));
            broadcast({
              type: 'extension_ui_request',
              id: crypto.randomUUID(),
              method: 'setWidget',
              widgetKey: key,
              widgetType: 'text',
              widgetLines: cleanLines,
              widgetPlacement: options?.placement,
            });
          } else if (Array.isArray(result)) {
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
        } catch { /* factory may fail */ }
      };
      tick(); // initial render
      const intervalId = setInterval(tick, 80);
      widgetFactories.set(key, { factory: content, intervalId, placement: options?.placement });
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

// ── Multi-session pool ──────────────────────────────────────────────────────────
//
// Sessions are created and kept alive in the pool. Only the "active" session
// forwards events to the browser. Inactive sessions remain live (and their
// agent continues running if mid-stream). Switching back broadcasts a fresh
// snapshot from the live in-memory session.

interface ManagedSession {
  session: AgentSession;
  /** Unsubscribe from the active-event-forwarding subscription (null when inactive). */
  forwardingUnsub: (() => void) | null;
  /** Unsubscribe from the runtime-status subscription (always active). */
  runtimeUnsub: (() => void) | null;
  cwd: string;
  path: string | null;
  createdAt: number;
  /** True while the agent is generating (agent_start … agent_end). */
  isRunning: boolean;
  /** True if the session has new result(s) since the user last looked at it. */
  unseen: boolean;
  /** Unix ms of the most recent agent_end / message_end. */
  lastActivity: number;
}

const sessionPool = new Map<string, ManagedSession>();
let activeSessionId: string | null = null;
// Promise lock — prevents concurrent first-connection races from creating duplicate sessions.
let _sessionInitPromise: Promise<string> | null = null;

/** The currently-active AgentSession (throws if none). */
function activeSession(): AgentSession {
  const m = activeSessionId ? sessionPool.get(activeSessionId) : undefined;
  if (!m) throw new Error('No active session');
  return m.session;
}
/** The currently-active AgentSession or null. */
function activeSessionOrNull(): AgentSession | null {
  const m = activeSessionId ? sessionPool.get(activeSessionId) : undefined;
  return m?.session ?? null;
}

/** Look up a managed session by its session-file path. */
function findManagedSessionByPath(path: string): ManagedSession | undefined {
  for (const m of sessionPool.values()) {
    if (m.path === path) return m;
  }
  return undefined;
}

/**
 * Initialise (or return) the active pi session. Loads the SDK and creates a
 * session on demand. Concurrent calls share the same initialisation promise.
 *
 * Uses SessionManager.continueRecent() to resume the most recent persisted
 * session, or create a new one. Sessions are saved to disk as .jsonl files
 * under ~/.pi/agent/sessions/.
 */
async function ensureSession(): Promise<AgentSession> {
  // If the promise resolved to an id that's been cleaned up, reset it
  if (_sessionInitPromise) {
    const sid = await Promise.resolve(_sessionInitPromise).then(
      (id) => (sessionPool.has(id) ? id : null),
      () => null,
    );
    if (sid) return sessionPool.get(sid)!.session;
    // Stale promise — reset and fall through to create a new session
    _sessionInitPromise = null;
  }
  if (activeSessionId && sessionPool.has(activeSessionId)) return activeSession();
  if (!_sessionInitPromise) {
    _sessionInitPromise = (async () => {
      const sdk = await getSDK();
      console.log(`[pifrontier] Starting pi session in ${cwd} …`);
      const sm = sdk.SessionManager.continueRecent(cwd);
      const result = await sdk.createAgentSession({
        cwd,
        sessionManager: sm,
      });
      const sess = result.session;
      touchProject(sess.sessionManager.getCwd() || cwd);
      console.log(`[pifrontier] Pi session ready: ${sess.sessionId} (${sm.isPersisted() ? 'persisted' : 'in-memory'})`);
      await sess.bindExtensions({ uiContext: uiContext as unknown as ExtensionUIContext });
      console.log('[pifrontier] Extension UI context bound.');
      patchHasUI(sess);

      // Store in pool and mark active
      const sid = sess.sessionId;
      const cwdV = sess.sessionManager.getCwd() || cwd;
      registerSession(sid, sess, cwdV, false);
      activeSessionId = sid;

      return sid;
    })();
  }
  const sid = await _sessionInitPromise;
  return sessionPool.get(sid)!.session;
}

/** Register a session in the pool, subscribe runtime tracking, and optionally bind extensions. */
function registerSession(sid: string, sess: AgentSession, cwdV: string, bindExt: boolean) {
  const path = sess.sessionManager.getSessionFile() ?? null;
  const entry: ManagedSession = {
    session: sess,
    forwardingUnsub: null,
    runtimeUnsub: null,
    cwd: cwdV,
    path,
    createdAt: Date.now(),
    isRunning: sess.isStreaming,
    unseen: false,
    lastActivity: Date.now(),
  };
  sessionPool.set(sid, entry);

  // Subscribe runtime-status tracking for ALL pooled sessions (always on)
  entry.runtimeUnsub = sess.subscribe((event) => {
    switch (event.type) {
      case 'agent_start':
        entry.isRunning = true;
        entry.unseen = activeSessionId !== sid;
        break;
      case 'agent_end':
        entry.isRunning = false;
        if (activeSessionId !== sid) entry.unseen = true;
        entry.lastActivity = Date.now();
        break;
      case 'message_end':
        entry.lastActivity = Date.now();
        if (activeSessionId !== sid) entry.unseen = true;
        break;
    }
    // Broadcast runtime-status snapshot so sidebar can show live dots
    broadcastSessionRuntime(sid, entry);
  });

  // Subscribe event-forwarding (only active session gets this)
  const fwdUnsub = sess.subscribe((event) => {
    if (activeSessionId !== sid) return; // not active — skip forwarding
    if (event.type === 'message_end') {
      try { broadcast({ ...event, contextUsage: sess.getContextUsage() }); }
      catch { broadcast(event); }
    } else {
      broadcast(event);
    }
  });
  entry.forwardingUnsub = fwdUnsub;

  if (bindExt) {
    // Bind with our uiContext so ctx.ui.select() etc. still work for extension fallbacks
    sess.bindExtensions({ uiContext: uiContext as unknown as ExtensionUIContext }).catch((err) => {
      console.error('[pifrontier] bindExtensions (non-fatal):', err);
    });
    // Patch hasUI to false so extensions use the fallback ui.select/ui.input path
    // instead of the TUI custom() path which doesn't render well in the browser.
    patchHasUI(sess);
  }
}

/** Patch the extension runner's hasUI() to return false, so extensions use native browser dialogs. */
function patchHasUI(sess: AgentSession) {
  try {
    const runner = (sess as unknown as { _extensionRunner?: { hasUI: () => boolean } })._extensionRunner;
    if (runner) {
      const orig = runner.hasUI.bind(runner);
      runner.hasUI = () => false;
      // If the runner exposes createContext, the context's hasUI getter reads from runner.hasUI,
      // so this patch propagates to all future contexts.
    }
  } catch {
    // Non-fatal — some SDK versions may structure internals differently
  }
}

/** Broadcast a runtime-status update for a single pooled session. */
function broadcastSessionRuntime(sid: string, entry: ManagedSession) {
  broadcast({
    type: 'session_runtime',
    sessionId: sid,
    isRunning: entry.isRunning,
    unseen: entry.unseen,
    lastActivity: entry.lastActivity,
  });
}

/**
 * Switch the active session. The old session stays alive in the pool (its
 * agent continues running if mid-stream). The new session gets event-forwarding
 * to the browser and a session_loaded broadcast.
 *
 * If the session is already in the pool (previously active) it is reused
 * without re-creating from disk. This preserves in-progress state.
 */
async function setActiveSession(newSession: AgentSession, newCwd?: string) {
  const newId = newSession.sessionId;

  // Stop forwarding for the previously-active session
  if (activeSessionId) {
    const prev = sessionPool.get(activeSessionId);
    if (prev?.forwardingUnsub) {
      prev.forwardingUnsub();
      prev.forwardingUnsub = null;
    }
  }

  // Register if first time seeing this session
  const alreadyPooled = sessionPool.has(newId);
  if (!alreadyPooled) {
    registerSession(newId, newSession, newCwd || newSession.sessionManager.getCwd() || cwd, true);
  }

  // Clear extension autocomplete providers (extensions re-register via bindExtensions)
  autocompleteProviderWrappers.length = 0;
  chainedAutocompleteProvider = null;

  activeSessionId = newId;

  // Re-bind extensions only for newly-created sessions (to avoid duplicate handlers)
  if (!alreadyPooled) {
    try {
      await newSession.bindExtensions({ uiContext: uiContext as unknown as ExtensionUIContext });
      patchHasUI(newSession);
    } catch (err) {
      console.error('[pifrontier] bindExtensions (non-fatal):', err);
      broadcast({ type: 'agent_error', error: `Extension install failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  // Re-enable forwarding for the now-active session
  const entry = sessionPool.get(newId)!;
  if (!entry.forwardingUnsub) {
    const fwdUnsub = newSession.subscribe((event) => {
      if (activeSessionId !== newId) return; // no longer active — skip
      if (event.type === 'message_end') {
        try { broadcast({ ...event, contextUsage: newSession.getContextUsage() }); }
        catch { broadcast(event); }
      } else {
        broadcast(event);
      }
    });
    entry.forwardingUnsub = fwdUnsub;
  }

  // Clear unseen when switching to this session
  entry.unseen = false;

  broadcast({
    type: 'session_loaded',
    sessionId: newSession.sessionId,
    isStreaming: newSession.isStreaming,
    thinkingLevel: newSession.thinkingLevel,
    model: serializeModel(newSession.model),
    availableModels: newSession.modelRegistry.getAvailable().map(serializeModel),
    messages: newSession.messages,
    cwd: newSession.sessionManager.getCwd() || cwd,
    sessionName: newSession.sessionManager.getSessionName(),
    isCompacting: newSession.isCompacting,
    autoCompactionEnabled: newSession.autoCompactionEnabled,
    autoRetryEnabled: newSession.autoRetryEnabled,
    piVersion: PI_SDK_VERSION,
    uiVersion: UI_VERSION,
    sessionMode: newSession.sessionManager.isPersisted() ? 'persisted' : 'in-memory',
    contextUsage: newSession.getContextUsage(),
  });

  // Register/touch the project for the session's directory.
  touchProject(newSession.sessionManager.getCwd() || cwd);

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

      try {
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

        // Send runtime snapshots for all pooled sessions so reconnecting clients
        // get correct sidebar state (background running, unseen, etc.)
        for (const [sid, entry] of sessionPool) {
          broadcastSessionRuntime(sid, entry);
        }
      } catch (err) {
        console.error('[pifrontier] Failed to initialise session for new client:', err);
        try { ws.close(1011, 'Session initialisation failed'); } catch { /* ws may already be closed */ }
      }
    },

    async message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
      } catch {
        return;
      }

      try {
        // Ensure SDK + session are loaded before dispatching any command.
        await ensureSession();
      switch (msg.type) {
        case 'prompt': {
          try {
            const s = activeSession();
            if (s.isStreaming) {
              // Agent is busy — route as steer/followUp instead of throwing
              if (msg.images?.length) {
                ws.send(JSON.stringify({ type: 'agent_error', error: 'Cannot send images while the agent is already processing. Wait for it to finish.' }));
                break;
              }
              await s.steer(msg.message);
            } else {
              const imageContent = msg.images?.length
                ? msg.images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }))
                : undefined;
              await s.prompt(msg.message, imageContent ? { images: imageContent } : undefined);
            }
          } catch (err) {
            console.error('[pifrontier] prompt error:', err);
            ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
          }
          break;
        }

        case 'steer':
          try {
            await activeSession().steer(msg.message);
          } catch (err) {
            console.error('[pifrontier] steer error:', err);
            ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
          }
          break;

        case 'follow_up':
          try {
            await activeSession().followUp(msg.message);
          } catch (err) {
            console.error('[pifrontier] followUp error:', err);
            ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
          }
          break;

        case 'abort':
          await activeSession().abort();
          break;

        case 'set_thinking_level':
          activeSession().setThinkingLevel(msg.level as Parameters<AgentSession['setThinkingLevel']>[0]);
          break;

        case 'set_model': {
          const model = activeSession().modelRegistry.find(msg.provider, msg.modelId);
          if (!model) {
            console.warn(`[pifrontier] set_model: model not found: ${msg.provider}/${msg.modelId}`);
            break;
          }
          try {
            await activeSession().setModel(model);
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
            const src = activeSessionOrNull();
            const { session: newSession } = await _sdk!.createAgentSession({
              cwd: targetCwd,
              sessionManager: sm,
              modelRegistry: src?.modelRegistry ?? (await ensureSession()).modelRegistry,
              model: src?.model ?? (await ensureSession()).model,
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
            // If the user selects the current session path, we proceed anyway to refresh client state.
            const resolvedPath = resolve(cwd, expandTilde(msg.path));
            // Check pool first — reuse live session if already loaded
            const existing = findManagedSessionByPath(resolvedPath);
            if (existing) {
              await setActiveSession(existing.session, existing.cwd);
              break;
            }
            // Security: only open known session files — never raw client paths.
            const knownSessions = await _sdk!.SessionManager.listAll();
            if (!knownSessions.some((s) => s.path === resolvedPath)) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Session not found.' }));
              break;
            }
            const sm = _sdk!.SessionManager.open(resolvedPath);
            const src = activeSessionOrNull();
            const { session: newSession } = await _sdk!.createAgentSession({
              cwd: sm.getCwd() || cwd,
              sessionManager: sm,
              modelRegistry: src?.modelRegistry ?? (await ensureSession()).modelRegistry,
              model: src?.model ?? (await ensureSession()).model,
            });
            await setActiveSession(newSession);
          } catch (err) {
            console.error('[pifrontier] switch_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
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

        case 'extension_custom_input': {
          const customId = msg.id as string | undefined;
          if (!customId) break;
          const component = interactiveCustomComponents.get(customId);
          if (!component) break;
          try {
            const keystroke = {
              key: msg.key as string,
              alt: !!msg.alt,
              ctrl: !!msg.ctrl,
              meta: !!msg.meta,
              shift: !!msg.shift,
            };
            // If it's our StubTui wrapper, it has the routing logic
            if (typeof component.handleInput === 'function') {
              component.handleInput(keystroke);
            }
            // Re-render and broadcast updated lines
            const rawLines = typeof component.render === 'function' ? component.render(80) : [];
            const cleanLines = Array.isArray(rawLines) ? rawLines.map((l: string) => stripAnsi(l)) : [];
            broadcast({ type: 'custom_render', id: customId, lines: cleanLines });
          } catch (err) {
            console.error('[pifrontier] extension_custom_input error:', err);
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
            activeSession().modelRegistry.authStorage.set(msg.provider, { type: 'api_key', key: msg.key });
            activeSession().modelRegistry.refresh();
            ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
            broadcast({
              type: 'available_models_changed',
              availableModels: activeSession().modelRegistry.getAvailable().map(serializeModel),
            });
          } catch (err) {
            console.error('[pifrontier] set_provider_key error:', err);
            ws.send(JSON.stringify({ type: 'providers_error', message: String(err) }));
          }
          break;
        }

        case 'remove_provider_key': {
          try {
            activeSession().modelRegistry.authStorage.remove(msg.provider);
            activeSession().modelRegistry.refresh();
            ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
            broadcast({
              type: 'available_models_changed',
              availableModels: activeSession().modelRegistry.getAvailable().map(serializeModel),
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
            if (msg.path === activeSession().sessionFile) {
              activeSession().setSessionName(msg.name);
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
            activeSession().setSessionName(msg.name);
            // Also persist it to the session file if available
            if (activeSession().sessionFile) {
              const sm = _sdk!.SessionManager.open(activeSession().sessionFile);
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
            if (target.id === activeSession().sessionId) {
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
          if (target === (activeSessionOrNull()?.sessionManager.getCwd() || cwd)) {
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
            const root = activeSession().sessionManager.getCwd() || cwd;
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
          activeSession().compact().catch((err) => {
            console.error('[pifrontier] compact error:', err);
          });
          break;
        }

        case 'set_auto_compaction': {
          activeSession().setAutoCompactionEnabled(msg.enabled);
          break;
        }

        case 'set_auto_retry': {
          activeSession().setAutoRetryEnabled(msg.enabled);
          break;
        }

        case 'run_builtin': {
          const command = String((msg as { type: 'run_builtin'; command: string; args?: string }).command ?? '').toLowerCase();
          const args = String((msg as { type: 'run_builtin'; command: string; args?: string }).args ?? '').trim();
          try {
            switch (command) {
              case 'reload': {
                await activeSession().reload();
                sendSlashResult(ws, command, 'Reloaded extensions, skills, prompts, and tools.');
                ws.send(JSON.stringify({
                  type: 'tools_list',
                  tools: activeSession().getAllTools().map((t) => ({
                    name: t.name,
                    description: t.description,
                    isBuiltin: t.sourceInfo.origin === 'package',
                  })),
                  activeToolNames: activeSession().getActiveToolNames(),
                }));
                break;
              }
              case 'login': {
                if (args) {
                  // If a specific provider was passed, try prompt so extensions can handle it
                  try { await activeSession().prompt(`/login ${args}`); } catch (e) {
                    // If prompt fails (e.g. no extension handles it), fall through to built-in flow
                    console.error('[pifrontier] login prompt error:', e);
                  }
                  break;
                }
                // Built-in login flow: show provider selector
                const loginProviders = getProviders().filter(p => !p.configured);
                if (loginProviders.length === 0) {
                  sendSlashResult(ws, command, 'All providers are already configured.', 'info');
                  break;
                }
                const loginLabels = loginProviders.map(p => `${p.name} (${p.id})`);
                const selectedLogin = await uiContext.select('Select a provider to log in', loginLabels);
                if (!selectedLogin) break;
                const loginIdx = loginLabels.indexOf(selectedLogin);
                if (loginIdx === -1) break;
                const loginProvider = loginProviders[loginIdx];

                // Check if provider uses OAuth
                const all = activeSession().modelRegistry.getAll();
                const oauthModel = all.find(m => m.provider === loginProvider.id && activeSession().modelRegistry.isUsingOAuth(m));
                if (oauthModel) {
                  // OAuth flow — trigger via prompt() which routes through the extension UI
                  try { await activeSession().prompt(`/login ${loginProvider.id}`); } catch (e) {
                    sendSlashResult(ws, command, String(e), 'error');
                  }
                } else {
                  // API key — prompt for key
                  const key = await uiContext.input(`API key for ${loginProvider.name}`, 'Paste your API key…');
                  if (!key) break;
                  activeSession().modelRegistry.authStorage.set(loginProvider.id, { type: 'api_key', key });
                  activeSession().modelRegistry.refresh();
                  ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
                  broadcast({
                    type: 'available_models_changed',
                    availableModels: activeSession().modelRegistry.getAvailable().map(serializeModel),
                  });
                  sendSlashResult(ws, command, `Logged in to ${loginProvider.name}.`);
                }
                break;
              }
              case 'logout': {
                const provider = args || activeSession().model?.provider;
                if (!provider) {
                  sendSlashResult(ws, command, 'No provider selected. Pass a provider name, e.g. /logout openai.', 'warning');
                  break;
                }
                activeSession().modelRegistry.authStorage.remove(provider);
                activeSession().modelRegistry.refresh();
                ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
                broadcast({
                  type: 'available_models_changed',
                  availableModels: activeSession().modelRegistry.getAvailable().map(serializeModel),
                });
                sendSlashResult(ws, command, `Removed stored credentials for ${provider}.`);
                break;
              }
              case 'clone': {
                const leafId = activeSession().sessionManager.getLeafId();
                if (!leafId) {
                  sendSlashResult(ws, command, 'No session branch to clone yet.', 'warning');
                  break;
                }
                const newPath = activeSession().sessionManager.createBranchedSession(leafId);
                if (!newPath) {
                  // Fallback — create a fresh persisted session
                  const clonedSm = _sdk!.SessionManager.create(cwd);
                  const { session: clonedSession } = await _sdk!.createAgentSession({
                    cwd,
                    sessionManager: clonedSm,
                    modelRegistry: activeSession().modelRegistry,
                    model: activeSession().model,
                        });
                  await setActiveSession(clonedSession);
                  sendSlashResult(ws, command, 'Cloned to a fresh session.');
                  break;
                }
                const clonedSm = _sdk!.SessionManager.open(newPath);
                const { session: clonedSession } = await _sdk!.createAgentSession({
                  cwd: clonedSm.getCwd() || cwd,
                  sessionManager: clonedSm,
                  modelRegistry: activeSession().modelRegistry,
                  model: activeSession().model,
                    });
                await setActiveSession(clonedSession);
                sendSlashResult(ws, command, `Cloned current branch to ${newPath}.`);
                break;
              }
              case 'tree': {
                const tree = activeSession().sessionManager.getTree();
                const lines = tree.flatMap((node) => formatTreeNode(node as Parameters<typeof formatTreeNode>[0]));
                sendSlashResult(ws, command, lines.length ? `Session tree:\n${lines.join('\n')}` : 'Session tree is empty.');
                break;
              }
              case 'session': {
                const stats = activeSession().getSessionStats();
                const context = activeSession().getContextUsage();
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
                const out = format === 'jsonl' ? activeSession().exportToJsonl() : await activeSession().exportToHtml();
                sendSlashResult(ws, command, `Exported current session to ${out}.`);
                break;
              }
              case 'share': {
                const out = await activeSession().exportToHtml();
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
                  sendSlashResult(ws, command, activeSession().sessionName ? `Session name: ${activeSession().sessionName}` : 'No session name set.');
                  break;
                }
                activeSession().setSessionName(args);
                sendSlashResult(ws, command, `Session renamed to ${args}.`);
                break;
              }
              case 'shell': {
                if (!args) {
                  sendSlashResult(ws, command, 'Usage: ! <command>', 'warning');
                  break;
                }
                const shellResult = Bun.spawnSync(['bash', '-c', args], {
                  cwd: activeSessionOrNull()?.sessionManager.getCwd() || cwd,
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
              case 'extension':
                // Extension commands — route through prompt() which handles them via _tryExecuteExtensionCommand
                // Use prompt() even during streaming (SDK handles extension commands during streaming)
                try { await activeSession().prompt(args); } catch (e) {
                  sendSlashResult(ws, command, String(e), 'error');
                }
                break;
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
            const tree = activeSession().sessionManager.getTree();
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
            const entries = activeSession().getUserMessagesForForking();
            ws.send(JSON.stringify({ type: 'fork_points', entries }));
          } catch (err) {
            console.error('[pifrontier] get_fork_points error:', err);
            ws.send(JSON.stringify({ type: 'fork_points', entries: [] }));
          }
          break;
        }

        case 'get_tools': {
          try {
            const allTools = activeSession().getAllTools();
            const activeNames = activeSession().getActiveToolNames();
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
            activeSession().setActiveToolsByName(msg.toolNames as string[]);
          } catch (err) {
            console.error('[pifrontier] set_active_tools error:', err);
          }
          break;
        }

        case 'get_resources': {
          try {
            const sessionCwd = activeSession().sessionManager.getCwd() || cwd;
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

        case 'get_command_completions': {
          try {
            const { command, prefix } = msg as { type: string; command: string; prefix: string };
            const sessionCwd = activeSession().sessionManager.getCwd() || cwd;
            const agentDir = _sdk!.getAgentDir();
            const loader = new _sdk!.DefaultResourceLoader({ cwd: sessionCwd, agentDir });
            await loader.reload();
            const { extensions } = loader.getExtensions();
            for (const ext of extensions) {
              const cmd = ext.commands.get(command);
              if (cmd?.getArgumentCompletions) {
                const items = await cmd.getArgumentCompletions(prefix);
                ws.send(JSON.stringify({ type: 'command_completions', command, prefix, items: items ?? [] }));
                return;
              }
            }
            ws.send(JSON.stringify({ type: 'command_completions', command, prefix, items: [] }));
          } catch (err) {
            console.error('[pifrontier] get_command_completions error:', err);
            ws.send(JSON.stringify({ type: 'command_completions', command: '', prefix: '', items: [] }));
          }
          break;
        }

        case 'get_extensions': {
          try {
            const sessionCwd = activeSession().sessionManager.getCwd() || cwd;
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
            const sessionCwd = activeSession().sessionManager.getCwd() || cwd;
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
            const sessionCwd = activeSession().sessionManager.getCwd() || cwd;
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
            if (!activeSession().sessionFile) throw new Error('Active session is not persisted');
            const sm = _sdk!.SessionManager.open(activeSession().sessionFile);
            const forkPath = sm.createBranchedSession(entryId);
            const sm2 = _sdk!.SessionManager.open(forkPath);
            const { session: forkedSession } = await _sdk!.createAgentSession({
              cwd,
              sessionManager: sm2,
              modelRegistry: activeSession().modelRegistry,
              model: activeSession().model,
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
        try { ws.send(JSON.stringify({ type: 'agent_error', error: String(err) })); } catch { /* ws may be closed */ }
      }
    },

    close(ws) {
      ws.unsubscribe(WS_TOPIC);
      connectedClients = Math.max(0, connectedClients - 1);
      // Only cancel pending extension dialogs when the LAST client disconnects —
      // other open tabs may still answer them.
      // We do NOT dispose or clear pooled sessions — background agent work must
      // continue running even when no browser client is connected.
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
