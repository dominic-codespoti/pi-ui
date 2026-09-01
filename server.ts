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

import type { Server } from 'bun';
import type * as PiSDKNS from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  TerminalInputHandler,
  ExtensionCommandContextActions,
  ExtensionError,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';
import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import { rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, basename, sep, dirname, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  initPassword,
  isValidSessionCookie,
  extractTokenExp,
  extractJti,
  isJtiRevoked,
  getTokenFromCookies,
} from './src/lib/auth/password.ts';
import {
  getWebhookUrl,
  setWebhookUrl,
  sendWebhookNotification,
} from './src/lib/server/notification-webhook.ts';
import {
  addPushSubscription,
  ensureVapidKeys,
  removePushSubscription,
  sendPushNotification,
} from './src/lib/server/push-notifications.ts';
import { persistProviderApiKey } from './src/lib/server/provider-auth.ts';
import {
  serializeModel,
  serializeSession,
  resolveGitHubRawUrl,
  formatCommand,
  ephemeralUpdateHint,
  ALLOWED_SKILL_HOSTS,
  SKIP_DIRS,
} from './src/lib/server/ws-helpers.ts';
import { ProjectCatalog } from './src/lib/server/project-catalog.ts';
import { readSettings, updateSettings } from './src/lib/server/ui-settings.ts';
import { log } from './src/lib/server/logger.ts';
import { terminalInputRegistry } from './src/lib/server/terminal-input.ts';
import { trimMessagesForWire } from './src/lib/server/wire-messages.ts';
import { createCompactionWatchdog } from './src/lib/server/compaction-watchdog.ts';
import {
  flushSessionScanCache,
  initSessionScanCache,
  firstTextContent,
  type SessionFileInfo,
} from './src/lib/server/session-scan.ts';
import { SessionCatalog } from './src/lib/server/session-catalog.ts';
import { startSessionWatch } from './src/lib/server/session-watcher.ts';
import {
  EXTENSION_UI_SCHEMA_VERSION,
  type ClientMessage,
  type ServerMessage,
  type ModelInfo,
  type ProviderInfo,
  type SkillSummary,
  type PromptSummary,
  type ExtensionSummary,
  type ProjectTrustInfo,
  type ProjectTrustDecision,
  type RuntimeDiagnostic,
  type PackageUpdateInfo,
  type UpdatePackageStatus,
  type UpdateStatus,
  type UpdateTarget,
  type WidgetPayload,
  type WidgetPlacement,
  type ExtensionUiStatePayload,
} from './src/lib/ws/protocol.ts';
import {
  callFactoryAndParse,
  parseComponentTree,
  shouldUseInteractiveCustom,
  StubTui,
  stubKeybindings,
  stubTui,
  stubTheme,
  stripAnsi,
  ansiToHtml,
  renderTerminalLines,
  renderToolCallHtml,
  renderToolResultHtml,
  renderCustomMessage,
  renderCustomMessagesForWire,
  type ParsedComponent,
} from './src/lib/tui-stubs.ts';
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
    const mod = (await import('./build/handler.js')) as any;
    _svelteHandler = mod.getHandler().fetch as SvelteHandler;
  }
  return _svelteHandler;
}

// ── 1. Validate environment ───────────────────────────────────────────────────

const PI_PASSWORD = Bun.env.PI_PASSWORD;
if (!PI_PASSWORD) {
  log.error('[pifrontier] Error: PI_PASSWORD environment variable is required.');
  log.error('[pifrontier] Usage: PI_PASSWORD=your-password bun run start');
  process.exit(1);
}

await initPassword(PI_PASSWORD);
log.info('[pifrontier] Password initialised.');

// ── 2. Helpers ────────────────────────────────────────────────────────────────

import { existsSync, realpathSync } from 'node:fs';

/** Max messages sent on initial connect/session-switch. Older messages can be
 *  loaded on demand. Keeps the WS payload small and the client render fast. */
const MAX_INITIAL_MESSAGES = 100;

/**
 * Per-prefix file_complete cache — the composer re-sends the same query while
 * typing/backspacing; a depth-3 walk per keystroke is wasted I/O on large
 * repos. 5 s TTL bounds staleness; the map is capped and evicts oldest-first.
 */
const FILE_COMPLETE_TTL_MS = 5_000;
const FILE_COMPLETE_CACHE_MAX = 50;
const fileCompleteCache = new Map<string, { at: number; entries: string[] }>();
/** Per-directory completion cache — completion requests repeat while a path is
 *  being typed. Short TTL keeps newly-created directories discoverable. */
const DIR_COMPLETE_TTL_MS = 2_000;
const DIR_COMPLETE_CACHE_MAX = 50;
const dirCompleteCache = new Map<string, { at: number; entries: string[] }>();

/** Truncate messages for initial payload — keeps the WS + client render fast.
 *  Oversized text/thinking blocks are additionally size-capped for transfer. */
function initialMessages(
  messages: unknown[],
  sess: AgentSession
): { msgs: unknown[]; total: number; truncated: boolean } {
  const total = messages.length;
  const tail = total <= MAX_INITIAL_MESSAGES ? messages : messages.slice(-MAX_INITIAL_MESSAGES);
  return {
    msgs: trimMessagesForWire(renderCustomMessagesForWire(sess, tail)),
    total,
    truncated: total > MAX_INITIAL_MESSAGES,
  };
}

/** Current in-memory partial response, capped like history before it crosses the wire. */
function streamingMessageForWire(session: AgentSession): unknown {
  const message = session.agent.state.streamingMessage;
  return message ? trimMessagesForWire([renderCustomMessage(session, message)])[0] : undefined;
}

const cwd = Bun.env.PI_CWD ?? process.cwd();
if (!existsSync(cwd)) {
  log.error(`[pifrontier] Error: working directory does not exist: ${cwd}`);
  log.error('[pifrontier] Set PI_CWD to a valid directory or run from the target project.');
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
  // Resolve symlinks so a symlink inside the workspace pointing outside is caught.
  let realPath: string;
  try {
    realPath = realpathSync(resolvedPath);
  } catch {
    // File may not exist yet (e.g. write_file creating a new file) — use dirname.
    try {
      realPath = realpathSync(dirname(resolvedPath)) + sep + basename(resolvedPath);
    } catch {
      realPath = resolve(resolvedPath);
    }
  }
  const root = resolve(activeCwd());
  const realRoot = realpathSync(root);
  return realPath === realRoot || realPath.startsWith(realRoot + sep);
}

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

async function getProviders(runtime = activeSession().modelRuntime): Promise<ProviderInfo[]> {
  let storedProviderIds: Set<string> | undefined;
  try {
    storedProviderIds = new Set(
      (await runtime.listCredentials()).map((credential) => credential.providerId)
    );
  } catch (err) {
    // Status snapshots are still useful when the credential store cannot be read.
    log.warn('[pifrontier] Failed to read stored provider credentials:', err);
  }

  const modelCounts = new Map<string, number>();
  for (const model of runtime.getModels()) {
    modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
  }

  const providers: ProviderInfo[] = [];
  for (const provider of runtime.getProviders()) {
    const modelCount = modelCounts.get(provider.id);
    if (!modelCount) continue;
    const status = runtime.getProviderAuthStatus(provider.id);
    // ModelRuntime's async availability snapshot can be stale when an
    // unrelated provider auth check fails. Credential metadata is authoritative
    // for a just-completed login/logout, so use it as a narrow fallback.
    const effectiveStatus =
      !status.configured && storedProviderIds?.has(provider.id)
        ? { configured: true, source: 'stored' }
        : status;
    providers.push({
      id: provider.id,
      name: provider.name,
      configured: effectiveStatus.configured,
      source: effectiveStatus.source,
      modelCount,
    });
  }

  // Configured providers first, then alphabetical by name.
  return providers.sort((a, b) => {
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function availableModelsForBroadcast(
  runtime: AgentSession['modelRuntime'],
  changedProviderId?: string
): Promise<ModelInfo[]> {
  const serializeAvailable = (models: readonly Parameters<typeof serializeModel>[0][]) =>
    models.map(serializeModel).filter((model): model is ModelInfo => model !== null);

  try {
    return serializeAvailable(await runtime.getAvailable());
  } catch (err) {
    log.warn('[pifrontier] Provider availability refresh failed:', err);
    if (changedProviderId) {
      try {
        // A single broken provider must not hide a successful login for another
        // provider. Re-check the changed provider and merge it into the last
        // good snapshot.
        return serializeAvailable([
          ...runtime.getAvailableSnapshot().filter((model) => model.provider !== changedProviderId),
          ...(await runtime.getAvailable(changedProviderId)),
        ]);
      } catch (changedErr) {
        log.warn(
          `[pifrontier] Failed to refresh changed provider ${changedProviderId}:`,
          changedErr
        );
      }
    }
    return serializeAvailable(runtime.getAvailableSnapshot());
  }
}

/** Broadcast the authoritative provider/auth and available-model snapshots. */
async function broadcastProviderState(
  runtime: AgentSession['modelRuntime'],
  changedProviderId?: string
): Promise<void> {
  const availableModels = await availableModelsForBroadcast(runtime, changedProviderId);
  broadcast({ type: 'providers_list', providers: await getProviders(runtime) });
  broadcast({ type: 'available_models_changed', availableModels });
}

let providerAuthMutationQueue: Promise<void> = Promise.resolve();

/** Serialize credential mutations so refresh snapshots cannot complete out of order. */
function enqueueProviderAuthMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = providerAuthMutationQueue.then(operation);
  providerAuthMutationQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function mutateProviderAuth(
  providerId: string,
  mutation: (runtime: AgentSession['modelRuntime']) => Promise<void>
): Promise<void> {
  return enqueueProviderAuthMutation(async () => {
    const runtime = activeSession().modelRuntime;
    try {
      await mutation(runtime);
    } finally {
      // A persisted credential is useful even when a model catalog or an
      // unrelated provider's availability check fails during SDK refresh.
      try {
        await broadcastProviderState(runtime, providerId);
      } catch (err) {
        log.error('[pifrontier] Failed to broadcast provider state:', err);
      }
    }
  });
}

function browserAuthInteraction(ownerSessionId: string | null): AuthInteraction {
  return {
    prompt: async (prompt: AuthPrompt) => {
      if (prompt.type === 'select') {
        const selected = await uiContext.select(
          prompt.message,
          prompt.options.map((option) => option.label),
          undefined,
          ownerSessionId
        );
        if (!selected) throw new Error('Login cancelled');
        const option = prompt.options.find((candidate) => candidate.label === selected);
        if (!option) throw new Error('Login cancelled');
        return option.id;
      }

      const value = await createDialogPromise<string | undefined>(
        crypto.randomUUID(),
        {
          method: 'input',
          title: prompt.message,
          placeholder: prompt.placeholder,
          ...(prompt.type === 'secret' ? { secret: true } : {}),
        },
        (response) =>
          'cancelled' in response && response.cancelled
            ? undefined
            : 'value' in response && typeof response.value === 'string'
              ? response.value
              : undefined,
        ownerSessionId
      );
      if (value === undefined) throw new Error('Login cancelled');
      return value;
    },
    notify: (event: AuthEvent) => {
      switch (event.type) {
        case 'info':
          uiContext.notify(event.message, 'info', ownerSessionId);
          break;
        case 'progress':
          uiContext.notify(event.message, 'info', ownerSessionId);
          break;
        case 'auth_url':
          uiContext.notify(
            `${event.instructions ? `${event.instructions}\n` : ''}${event.url}`,
            'info',
            ownerSessionId
          );
          break;
        case 'device_code':
          uiContext.notify(
            `Enter ${event.userCode} at ${event.verificationUri}`,
            'info',
            ownerSessionId
          );
          break;
      }
    },
  };
}

function sendSlashResult(
  ws: { send(data: string): void },
  command: string,
  message: string,
  level: 'info' | 'warning' | 'error' = 'info'
) {
  ws.send(JSON.stringify({ type: 'slash_result', command, message, level }));
}

async function fetchNpmLatestVersion(
  packageName: string
): Promise<{ version?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const encoded = encodeURIComponent(packageName);
    const res = await fetch(`https://registry.npmjs.org/${encoded}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return { error: `registry returned HTTP ${res.status}` };
    const data = (await res.json()) as { version?: string };
    return data.version
      ? { version: data.version }
      : { error: 'registry response did not include a version' };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

function packageStatus(
  name: string,
  current: string,
  latest: { version?: string; error?: string }
): UpdatePackageStatus {
  return {
    name,
    current,
    latest: latest.version,
    updateAvailable: Boolean(
      latest.version && current !== 'unknown' && compareSemver(latest.version, current) > 0
    ),
    error: latest.error,
  };
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
  const [uiLatest, sdkLatest, packageJsonExists] = await Promise.all([
    fetchNpmLatestVersion(UI_PACKAGE_NAME),
    fetchNpmLatestVersion(PI_SDK_PACKAGE_NAME),
    Bun.file(join(APP_ROOT, 'package.json')).exists(),
  ]);
  // `.git` is a directory — `Bun.file(...).exists()` always reports false
  // for directories, so this must use `existsSync`, not `Bun.file`.
  const gitExists = existsSync(join(APP_ROOT, '.git'));
  const ephemeralHint = gitExists ? null : ephemeralUpdateHint(APP_ROOT, UI_PACKAGE_NAME);
  const mode: UpdateStatus['mode'] = gitExists ? 'source' : ephemeralHint ? 'ephemeral' : 'package';

  const notes: string[] = [];
  if (mode === 'source')
    notes.push('pi-ui update runs git pull, bun install, and rebuilds the app.');
  if (mode === 'package')
    notes.push(
      'pi-ui update runs the detected package-manager update for the installed pi-ui package.'
    );
  if (mode === 'ephemeral') notes.push(`This run looks ephemeral. Restart with: ${ephemeralHint}`);
  if (!gitExists)
    notes.push(
      'SDK-only updates are disabled for package installs; update pi-ui to get the supported SDK version.'
    );
  if (!packageJsonExists) notes.push('Package metadata is not writable in this install location.');
  notes.push('After updating, the server restarts and the page reloads to load the new UI.');

  return {
    appRoot: APP_ROOT,
    mode,
    updateCommand: mode === 'ephemeral' ? (ephemeralHint ?? undefined) : 'pi-ui update',
    busy: updateInProgress,
    canUpdateUi: mode !== 'ephemeral',
    canUpdateSdk: gitExists && packageJsonExists,
    ui: packageStatus(UI_PACKAGE_NAME, UI_VERSION, uiLatest),
    sdk: packageStatus(PI_SDK_PACKAGE_NAME, PI_SDK_VERSION, sdkLatest),
    notes,
  };
}

function sanitizeEnv(): Record<string, string> {
  // Only pass through safe env vars — exclude secrets like PI_PASSWORD and
  // provider API keys that could be exfiltrated by package lifecycle scripts.
  const safe = [
    'PATH',
    'HOME',
    'USER',
    'BUN_INSTALL',
    'NPM_CONFIG_USERCONFIG',
    'npm_config_user_agent',
    'PI_UI_PACKAGE_MANAGER',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'npm_config_registry',
  ];
  const env: Record<string, string> = {};
  for (const key of safe) {
    const val = process.env[key];
    if (val !== undefined) env[key] = val;
  }
  return env;
}

async function runUpdateCommand(
  args: string[]
): Promise<{ command: string; exitCode: number; output: string }> {
  const proc = Bun.spawn(args, {
    cwd: APP_ROOT,
    env: sanitizeEnv(),
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
    ws.send(
      JSON.stringify({
        type: 'update_result',
        target,
        success: false,
        message: 'Another update is already running.',
      })
    );
    return;
  }

  updateInProgress = true;
  const chunks: string[] = [];
  try {
    const isSourceCheckout = existsSync(join(APP_ROOT, '.git'));
    if (target === 'ui' && !isSourceCheckout) {
      const hint = ephemeralUpdateHint(APP_ROOT, UI_PACKAGE_NAME);
      if (hint) throw new Error(`This pi-ui run looks ephemeral. Restart with: ${hint}`);
    }
    if (target === 'sdk' && !isSourceCheckout) {
      throw new Error(
        'SDK-only updates are only available from a source checkout. Update pi-ui to get the supported SDK version.'
      );
    }

    for (const args of updateSteps(target)) {
      const command = formatCommand(args);
      ws.send(
        JSON.stringify({ type: 'update_progress', target, command, message: `Running ${command}` })
      );
      const result = await runUpdateCommand(args);
      chunks.push(`$ ${result.command}`);
      if (result.output) chunks.push(result.output);
      chunks.push(`exit code: ${result.exitCode}`);
      if (result.exitCode !== 0) {
        throw new Error(`${result.command} failed with exit code ${result.exitCode}`);
      }
    }

    ws.send(
      JSON.stringify({
        type: 'update_result',
        target,
        success: true,
        message:
          target === 'ui'
            ? 'pi-ui update completed. Restarting will load the new UI.'
            : 'pi SDK package updated. Restart the server to load it.',
        output: chunks.join('\n\n'),
        restartRequired: true,
        reloadRequired: target === 'ui',
      })
    );
  } catch (err) {
    ws.send(
      JSON.stringify({
        type: 'update_result',
        target,
        success: false,
        message: err instanceof Error ? err.message : String(err),
        output: chunks.join('\n\n'),
      })
    );
  } finally {
    updateInProgress = false;
  }
}

function formatTreeNode(
  node: {
    entry: { id: string; type: string; message?: unknown };
    children: unknown[];
    label?: string;
  },
  depth = 0
): string[] {
  const indent = '  '.repeat(depth);
  const entry = node.entry;
  let label = entry.type;
  const msg = entry.message as { role?: string; content?: unknown } | undefined;
  if (msg?.role) label = `${msg.role}`;
  if (Array.isArray(msg?.content)) {
    const text = msg.content.find((c) => typeof c === 'object' && c && 'text' in c) as
      { text?: string } | undefined;
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
function serializeTreeNode(node: {
  entry: { id: string; type: string; message?: unknown };
  children: unknown[];
  label?: string;
}): import('./src/lib/ws/protocol.ts').TreeNode {
  const entry = node.entry;
  const msg = entry.message as { role?: string; content?: unknown } | undefined;
  let role: string | undefined;
  let text: string | undefined;
  if (msg?.role) role = msg.role;
  if (Array.isArray(msg?.content)) {
    const t = msg.content.find((c) => typeof c === 'object' && c && 'text' in c) as
      { text?: string } | undefined;
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
    children: (node.children as (typeof node)[]).map(serializeTreeNode),
  };
}

/** Pi config directory name — same as CONFIG_DIR_NAME in the SDK. */
const PI_CONFIG_DIR = '.pi';

/**
 * Build a session summary from a pooled session's live memory state — the
 * catalog's overlay authority for everything the server currently holds.
 * Mirrors the scanner's SessionFileInfo shape so the merge is seamless.
 */
function poolSummary(sess: AgentSession, entry: ManagedSession): SessionFileInfo {
  let firstMsg = '';
  for (const message of sess.messages) {
    if (!message || typeof message !== 'object' || !('role' in message)) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = firstTextContent(message);
    if (text) {
      firstMsg = text.slice(0, 120);
      break;
    }
  }
  return {
    id: sess.sessionId,
    path: entry.path ?? '(in-memory)',
    cwd: entry.cwd,
    name: entry.sessionName || undefined,
    created: new Date(entry.createdAt),
    modified: new Date(entry.lastActivity),
    messageCount: sess.messages.length,
    firstMessage: firstMsg,
  };
}
type WireExtensionCommand = { name: string; description?: string; source: string };

/** Read the already-bound session command catalog without reloading resources. */
function extensionCommandsFor(sess: AgentSession): WireExtensionCommand[] {
  return sess.extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName || command.name,
    description: command.description,
    source: command.sourceInfo.source,
  }));
}

// ── 3. Restart nonce ──────────────────────────────────────────────────────────
// Single-use nonce for restart_server. Prevents replay and ensures the user
// explicitly confirmed the restart via a request_restart → restart_server flow.
let pendingRestartNonce: string | null = null;

// Only one package update may run at a time; update commands mutate package files.
let updateInProgress = false;

/**
 * Session ids with a prompt() call in flight. The SDK forbids concurrent
 * prompt() calls on the SAME AgentSession (two tabs racing), but different
 * sessions run independently — a per-process flag would wrongly reroute a
 * prompt for an idle session as a steer while another session is generating.
 */
const _promptsInFlight = new Set<string>();

// ── 4. Extension UI — session-owned state ─────────────────────────────────────
// Every extension UI surface is owned by the session whose extension produced
// it. Serializable state (widget payloads, pending dialog payloads) lives in
// per-session buckets so `connected`/`session_loaded` can replay it; live
// resources (interactive custom() TUI instances, render polls, widget factory
// intervals) live in the same bucket so they pause/resume with the active
// session and are disposed with the session. Server-internal UI calls (login
// dialogs) have no owning session and use `ownerlessUiState` — unstamped,
// global, never replayed.

type PendingRequest = {
  requestPayload: Record<string, unknown>;
  resolve: (response: Record<string, unknown>) => void;
  /** Dialog timeout handle — cleared when the request resolves early. */
  timeoutId?: Timer;
};

/**
 * Live component tree for an open custom() dialog, keyed by dialog id.
 * `nodeMap` maps a path (e.g. "0.2") to the LIVE pi-tui component instance at
 * that position, so `extension_component_event` can invoke the extension's
 * real callback (onSelect/onClick/onToggle/...) instead of just returning a
 * value — and `pollId` re-parses + diffs the tree so loaders/progress/live
 * state changes reach the browser without the extension re-prompting.
 */
interface ActiveCustomDialog {
  root: Record<string, unknown>;
  nodeMap: Map<string, Record<string, unknown>>;
  lastParsedJson: string;
  pollId: Timer;
}

/** All extension UI state + live resources owned by one session. */
interface SessionUiState {
  statuses: Map<string, string>;
  workingMessage?: string;
  workingVisible: boolean;
  workingIndicatorFrames: string[];
  workingIndicatorMs: number;
  hiddenThinkingLabel: string;
  header: string;
  footer: string;
  editorComponent?: ParsedComponent;
  title: string;
  editorText: string;
  widgets: Map<string, WidgetStoreEntry>;
  pendingDialogs: Map<string, PendingRequest>;
  /** Live pi-tui instance for an interactive custom() dialog, keyed by dialog id. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interactiveCustomComponents: Map<string, any>;
  /** Render-polling intervals for interactive custom() dialogs (keyed by dialog id). */
  interactiveRenderIntervals: Map<string, Timer>;
  /** Last broadcast clean-line snapshot for interactive custom() dialogs. */
  interactiveLastRender: Map<string, string>;
  activeCustomDialogs: Map<string, ActiveCustomDialog>;
}

function createSessionUiState(): SessionUiState {
  return {
    statuses: new Map(),
    workingVisible: true,
    workingIndicatorFrames: [],
    workingIndicatorMs: 80,
    hiddenThinkingLabel: 'thinking',
    header: '',
    footer: '',
    title: 'pi UI',
    editorText: '',
    widgets: new Map(),
    pendingDialogs: new Map(),
    interactiveCustomComponents: new Map(),
    interactiveRenderIntervals: new Map(),
    interactiveLastRender: new Map(),
    activeCustomDialogs: new Map(),
  };
}

/** Per-session UI buckets — created lazily on the first UI call from a session. */
const uiStateBuckets = new Map<string, SessionUiState>();
/** Bucket for server-internal (ownerless) UI calls — unstamped, global, never replayed. */
const ownerlessUiState = createSessionUiState();
/** Request id → owning session id (or null) — routes response messages to the right bucket. */
const pendingRequestOwners = new Map<string, string | null>();

/** Bucket for an owner, created on demand. `null` → the ownerless bucket. */
function uiStateFor(owner: string | null): SessionUiState {
  if (owner == null) return ownerlessUiState;
  let ui = uiStateBuckets.get(owner);
  if (!ui) {
    ui = createSessionUiState();
    uiStateBuckets.set(owner, ui);
  }
  return ui;
}

/** Bucket for an owner if it exists — never creates one (used by cleanup paths). */
function existingUiStateFor(owner: string | null): SessionUiState | undefined {
  return owner == null ? ownerlessUiState : uiStateBuckets.get(owner);
}

/** Session stamp for a session-owned broadcast — omitted for ownerless calls. */
function stampOwner(owner: string | null): Record<string, string> {
  return owner ? { sessionId: owner } : {};
}

/** Find the bucket owning a widget key — prefers the active session's bucket,
 *  since the client dismisses what it currently sees. Returns undefined when
 *  the key is unknown. */
function widgetOwnerFor(key: string): string | null | undefined {
  if (activeSessionId && uiStateBuckets.get(activeSessionId)?.widgets.has(key)) {
    return activeSessionId;
  }
  for (const [sid, ui] of uiStateBuckets) {
    if (ui.widgets.has(key)) return sid;
  }
  return ownerlessUiState.widgets.has(key) ? null : undefined;
}

/** Releases everything tracked for a resolved/dismissed extension UI request. */
function cleanupCustomDialog(id: string): void {
  const owner = pendingRequestOwners.get(id) ?? null;
  const ui = existingUiStateFor(owner);
  if (!ui) return;
  const dlg = ui.activeCustomDialogs.get(id);
  if (dlg) {
    clearInterval(dlg.pollId);
    ui.activeCustomDialogs.delete(id);
  }
  ui.interactiveCustomComponents.delete(id);
  const pollId = ui.interactiveRenderIntervals.get(id);
  if (pollId) {
    clearInterval(pollId);
    ui.interactiveRenderIntervals.delete(id);
  }
  ui.interactiveLastRender.delete(id);
}
/** Render, deduplicate, and broadcast an interactive custom() snapshot. */
function flushInteractiveRender(id: string): void {
  const owner = pendingRequestOwners.get(id) ?? null;
  const ui = existingUiStateFor(owner);
  if (!ui) return;
  const tui = ui.interactiveCustomComponents.get(id);
  if (!tui) return;
  const rendered = renderTerminalLines(tui);
  if (!rendered) return;
  const json = JSON.stringify(rendered.cleanLines);
  if (json === ui.interactiveLastRender.get(id)) return;
  ui.interactiveLastRender.set(id, json);
  broadcast({
    type: 'custom_render',
    id,
    lines: rendered.cleanLines,
    htmlLines: rendered.htmlLines,
    ...stampOwner(owner),
  });
  const pending = ui.pendingDialogs.get(id);
  if (pending) {
    pending.requestPayload.lines = rendered.cleanLines;
    pending.requestPayload.htmlLines = rendered.htmlLines;
  }
}

/**
 * Single choke point for "this extension UI request is over, for any
 * reason" — user responded, the extension self-resolved via done(), it
 * timed out, or all clients disconnected. Closes the dialog in EVERY
 * connected tab, not just the one that answered.
 */
function finalizeExtensionResponse(id: string): void {
  const owner = pendingRequestOwners.get(id) ?? null;
  cleanupCustomDialog(id);
  broadcast({ type: 'extension_ui_dismiss', id, ...stampOwner(owner) });
}

// broadcast is a thin wrapper; reassigned once the Bun server is live.
let broadcast: (payload: ServerMessage) => void = () => {};

function createDialogPromise<T>(
  id: string,
  requestPayload: Record<string, unknown>,
  parseResponse: (r: Record<string, unknown>) => T,
  ownerSessionId: string | null = null
): Promise<T> {
  return new Promise<T>((resolve) => {
    const ui = uiStateFor(ownerSessionId);
    const entry: PendingRequest = {
      requestPayload,
      resolve: (response) => {
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        ui.pendingDialogs.delete(id);
        finalizeExtensionResponse(id);
        pendingRequestOwners.delete(id);
        resolve(parseResponse(response));
      },
    };
    ui.pendingDialogs.set(id, entry);
    pendingRequestOwners.set(id, ownerSessionId);
    broadcast({
      type: 'extension_ui_request',
      id,
      ...requestPayload,
      ...stampOwner(ownerSessionId),
    });
    // Timeout — prevents the agent from hanging forever if the browser
    // never responds (e.g. tab was closed without notifying the server).
    // The 15s grace timer (close handler) may cancel it earlier.
    entry.timeoutId = setTimeout(() => {
      const pending = ui.pendingDialogs.get(id);
      if (pending) pending.resolve({ cancelled: true });
    }, EXTENSION_DIALOG_TIMEOUT_MS);
  });
}

/** Number of currently-connected WS clients (browser tabs). */
let connectedClients = 0;
/** Timer that fires when the grace period for pending extension UI requests expires. */
let _pendingRequestsTimeout: Timer | null = null;
const PENDING_REQUESTS_GRACE_MS = 15_000;
/** Max time a blocking extension dialog can wait for a browser response. */
const EXTENSION_DIALOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Max wall-clock time a compaction may run before it is considered stuck.
 * Summaries of very large contexts legitimately take minutes; anything past
 * this bound means the SDK promise is wedged and we abort + seal the client
 * spinner. See src/lib/server/compaction-watchdog.ts.
 */
const COMPACTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Dispose one bucket's live resources and pending requests. The dialog
 * resolve wrappers broadcast extension_ui_dismiss and clean up their own live
 * resources; widget factories and editor-text requests are cleaned here
 * (editor-text resolves are raw, so their owner-index entries are dropped
 * explicitly). No widget teardown broadcasts fire — a disposed session is
 * never the active session, so no client displays its UI.
 */
function disposeUiState(ui: SessionUiState): void {
  for (const entry of ui.pendingDialogs.values()) {
    entry.resolve({ cancelled: true });
  }
  // Clean up interactive custom components
  for (const component of ui.interactiveCustomComponents.values()) {
    try {
      component.dispose?.();
    } catch {
      /* ignore */
    }
  }
  for (const interval of ui.interactiveRenderIntervals.values()) {
    clearInterval(interval);
  }
  for (const dlg of ui.activeCustomDialogs.values()) {
    clearInterval(dlg.pollId);
  }
  // Clean up widget refresh intervals and component instances
  for (const entry of ui.widgets.values()) {
    if (entry.factory) disposeWidgetFactory(entry.factory);
  }
}

function cancelAllPendingExtensionRequests() {
  if (_pendingRequestsTimeout) {
    clearTimeout(_pendingRequestsTimeout);
    _pendingRequestsTimeout = null;
  }
  for (const ui of [...uiStateBuckets.values(), ownerlessUiState]) {
    disposeUiState(ui);
  }
  uiStateBuckets.clear();
  pendingRequestOwners.clear();
}

// Server-side state for extension UI context
let toolsExpanded = false;

interface WidgetFactoryState {
  fn: (tui: unknown, theme: unknown) => { render(w: number): unknown; dispose?(): void } | string[];
  intervalId?: Timer;
  lastPayloadJson?: string;
  lastResult?: { dispose?(): void };
}

/** One widget's store entry — the owning session is the bucket it lives in. */
interface WidgetStoreEntry {
  payload: WidgetPayload;
  factory?: WidgetFactoryState;
  failures: number;
}

/**
 * Flatten a parsed component tree to plain text for footer/header display
 * (a single-line/short-block bar, not a rich interactive surface). Text and
 * markdown content pass through; containers join their children's text with
 * newlines; everything else (select/button/checkbox/progress/...) has no
 * textual representation and contributes nothing.
 */
function flattenParsedText(parsed: ParsedComponent | null): string {
  if (!parsed) return '';
  if (parsed.kind === 'text' || parsed.kind === 'markdown') return parsed.content;
  if (parsed.kind === 'container') {
    return parsed.children.map(flattenParsedText).filter(Boolean).join('\n');
  }
  return '';
}
type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;

type ServerExtensionUIContext = Omit<
  ExtensionUIContext,
  | 'getEditorText'
  | 'onTerminalInput'
  | 'setWidget'
  | 'select'
  | 'confirm'
  | 'input'
  | 'editor'
  | 'custom'
  | 'setStatus'
  | 'setWorkingMessage'
  | 'setWorkingVisible'
  | 'setWorkingIndicator'
  | 'setHiddenThinkingLabel'
  | 'setFooter'
  | 'setHeader'
  | 'setTitle'
  | 'setEditorComponent'
  | 'notify'
  | 'pasteToEditor'
  | 'setEditorText'
  | 'diagnostic'
  | 'getEditorComponent'
  | 'getToolsExpanded'
  | 'setToolsExpanded'
  | 'addAutocompleteProvider'
> & {
  getEditorText(ownerSessionId?: string | null): string;
  addAutocompleteProvider(
    factory: AutocompleteProviderFactory,
    ownerSessionId?: string | null
  ): void;
  onTerminalInput(handler: TerminalInputHandler, ownerSessionId?: string | null): () => void;
  setWidget(
    key: string,
    content: unknown,
    options?: { placement?: WidgetPlacement },
    ownerSessionId?: string | null
  ): void;
  select(
    title: string,
    options: string[],
    _opts?: ExtensionUIDialogOptions,
    ownerSessionId?: string | null
  ): Promise<string | undefined>;
  confirm(
    title: string,
    message: string,
    _opts?: ExtensionUIDialogOptions,
    ownerSessionId?: string | null
  ): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    _opts?: ExtensionUIDialogOptions,
    ownerSessionId?: string | null
  ): Promise<string | undefined>;
  editor(
    title: string,
    prefill?: string,
    ownerSessionId?: string | null
  ): Promise<string | undefined>;
  custom(
    arg1?: unknown,
    arg2?: unknown,
    arg3?: unknown,
    ownerSessionId?: string | null
  ): Promise<unknown>;
  setStatus(key: string, text: string | undefined, ownerSessionId?: string | null): void;
  setWorkingMessage(message?: string, ownerSessionId?: string | null): void;
  setWorkingVisible(visible: boolean, ownerSessionId?: string | null): void;
  setWorkingIndicator(
    options?: Parameters<ExtensionUIContext['setWorkingIndicator']>[0],
    ownerSessionId?: string | null
  ): void;
  setHiddenThinkingLabel(label?: string, ownerSessionId?: string | null): void;
  setFooter(
    factory: Parameters<ExtensionUIContext['setFooter']>[0],
    ownerSessionId?: string | null
  ): void;
  setHeader(
    factory: Parameters<ExtensionUIContext['setHeader']>[0],
    ownerSessionId?: string | null
  ): void;
  setTitle(title: string, ownerSessionId?: string | null): void;
  setEditorComponent(
    factory: Parameters<ExtensionUIContext['setEditorComponent']>[0],
    ownerSessionId?: string | null
  ): void;
  notify(
    message: string,
    type?: Parameters<ExtensionUIContext['notify']>[1],
    ownerSessionId?: string | null
  ): void;
  pasteToEditor(text: string, ownerSessionId?: string | null): void;
  setEditorText(text: string, ownerSessionId?: string | null): void;
  diagnostic(
    message: string,
    level?: string,
    details?: string,
    source?: string,
    ownerSessionId?: string | null
  ): void;
  getEditorComponent(): undefined;
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean, ownerSessionId?: string | null): void;
};

const uiContext: ServerExtensionUIContext = {
  select(title, options, _opts, ownerSessionId) {
    const id = crypto.randomUUID();
    return createDialogPromise<string | undefined>(
      id,
      { method: 'select', title, options },
      (r) =>
        'cancelled' in r && r.cancelled
          ? undefined
          : 'value' in r
            ? (r.value as string)
            : undefined,
      ownerSessionId
    );
  },

  confirm(title, message, _opts, ownerSessionId) {
    const id = crypto.randomUUID();
    return createDialogPromise<boolean>(
      id,
      { method: 'confirm', title, message },
      (r) =>
        'cancelled' in r && r.cancelled ? false : 'confirmed' in r ? Boolean(r.confirmed) : false,
      ownerSessionId
    );
  },

  input(title, placeholder, _opts, ownerSessionId) {
    const id = crypto.randomUUID();
    return createDialogPromise<string | undefined>(
      id,
      { method: 'input', title, placeholder },
      (r) =>
        'cancelled' in r && r.cancelled
          ? undefined
          : 'value' in r
            ? (r.value as string)
            : undefined,
      ownerSessionId
    );
  },

  editor(title, prefill, ownerSessionId) {
    const id = crypto.randomUUID();
    return createDialogPromise<string | undefined>(
      id,
      { method: 'editor', title, prefill },
      (r) =>
        'cancelled' in r && r.cancelled
          ? undefined
          : 'value' in r
            ? (r.value as string)
            : undefined,
      ownerSessionId
    );
  },

  async custom(
    arg1?: unknown,
    arg2?: unknown,
    arg3?: unknown,
    ownerSessionId?: string | null
  ): Promise<unknown> {
    const id = crypto.randomUUID();
    const owner = ownerSessionId ?? null;
    const ui = uiStateFor(owner);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let factory: ((...a: any[]) => any) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let options: Record<string, any> | undefined;
    let title = 'Extension Request';

    if (typeof arg1 === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      factory = arg1 as (...a: any[]) => any;
      if (arg2 && typeof arg2 === 'object') options = arg2;
    } else if (typeof arg1 === 'string') {
      title = arg1;
      if (typeof arg2 === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        factory = arg2 as (...a: any[]) => any;
        if (arg3 && typeof arg3 === 'object') options = arg3;
      }
    }

    const tui = new StubTui();
    const done = (val: unknown) => {
      const pending = ui.pendingDialogs.get(id);
      if (pending) pending.resolve({ value: val });
    };

    // Try to parse as a static component tree for rich web rendering;
    // only fall back to interactive terminal emulation for genuinely
    // keyboard-driven components that cannot be statically parsed.
    let parsed: ParsedComponent | null = null;
    if (factory) {
      try {
        const component = await factory(tui, stubTheme, stubKeybindings, done);
        if (component && typeof component === 'object') {
          // If factory returns a component, it's the root of our TUI tree
          tui.addChild(component);

          // First, attempt static parse for rich web UI. nodeMap records
          // path -> live component so extension_component_event can invoke
          // the extension's REAL callback later instead of just returning a
          // value (see server-side switch case below).
          const nodeMap = new Map<string, Record<string, unknown>>();
          try {
            parsed = parseComponentTree(component, 80, [], nodeMap);
          } catch {
            /* parsing may fail for non-standard layouts */
          }

          const parsedMeaningful = parsed && !(parsed.kind === 'text' && !parsed.content);

          // Terminal wrappers can render meaningful text while hiding their real
          // input control in a closure, so structured parsing cannot drive them.
          if (shouldUseInteractiveCustom(component, parsed)) {
            ui.interactiveCustomComponents.set(id, tui); // Store the TUI wrapper so we can route keys
            tui.onRequestRender = () => flushInteractiveRender(id);
            tui.terminal.start(
              () => {},
              () => flushInteractiveRender(id)
            );

            // Poll render every 200ms as a safety net for updates that do not
            // trigger requestRender() or a terminal resize.
            const pollId = setInterval(() => flushInteractiveRender(id), 200);
            ui.interactiveRenderIntervals.set(id, pollId);

            const rawLines = tui.render();
            const cleanLines = Array.isArray(rawLines)
              ? rawLines.map((l: string) => stripAnsi(l))
              : [];
            const htmlLines = Array.isArray(rawLines)
              ? rawLines.map((l: string) => ansiToHtml(l))
              : [];

            return new Promise<string | undefined>((resolve) => {
              const requestPayload = {
                method: 'custom',
                title,
                lines: cleanLines,
                htmlLines,
                interactive: true,
                ...(parsed ? { parsed } : {}),
              };
              ui.pendingDialogs.set(id, {
                requestPayload,
                resolve: (r) => {
                  try {
                    component.dispose?.();
                  } catch {
                    /* ignore */
                  }
                  ui.pendingDialogs.delete(id);
                  finalizeExtensionResponse(id);
                  pendingRequestOwners.delete(id);
                  resolve(
                    'cancelled' in r && r.cancelled
                      ? undefined
                      : 'value' in r
                        ? (r.value as string)
                        : undefined
                  );
                },
              });
              pendingRequestOwners.set(id, owner);
              broadcast({
                type: 'extension_ui_request',
                id,
                ...requestPayload,
                ...stampOwner(owner),
              });
              ui.interactiveLastRender.set(id, JSON.stringify(cleanLines));
              // Timeout parity with createDialogPromise — prevents the agent
              // hanging forever if no browser ever responds (e.g. dialog was
              // created while no client was connected and none reconnects).
              setTimeout(() => {
                const pending = ui.pendingDialogs.get(id);
                if (pending) pending.resolve({ cancelled: true });
              }, EXTENSION_DIALOG_TIMEOUT_MS);
            });
          }

          // Component parsed into a meaningful, non-keyboard-driven tree —
          // register it as a live dialog: extension_component_event can
          // invoke its real callbacks, and a 200ms poll re-parses + diffs
          // so loaders/progress/live state reach the browser without the
          // extension having to re-prompt.
          if (parsedMeaningful) {
            const pollId = setInterval(() => {
              const dlg = ui.activeCustomDialogs.get(id);
              if (!dlg) return;
              try {
                const reparsed = parseComponentTree(dlg.root, 80, [], dlg.nodeMap);
                const json = JSON.stringify(reparsed);
                if (json !== dlg.lastParsedJson) {
                  dlg.lastParsedJson = json;
                  broadcast({
                    type: 'extension_ui_update',
                    id,
                    parsed: reparsed,
                    ...stampOwner(owner),
                  });
                  const pending = ui.pendingDialogs.get(id);
                  if (pending) pending.requestPayload.parsed = reparsed;
                }
              } catch {
                /* component may be disposed */
              }
            }, 200);
            ui.activeCustomDialogs.set(id, {
              root: component,
              nodeMap,
              lastParsedJson: JSON.stringify(parsed),
              pollId,
            });
          }
        }
      } catch (err) {
        log.error('[pifrontier] custom factory error:', err);
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
      (r) =>
        'cancelled' in r && r.cancelled
          ? undefined
          : 'value' in r
            ? (r.value as string)
            : undefined,
      owner
    );
  },

  notify(message, type, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'notify',
      message,
      notifyType: type,
      ...stampOwner(owner),
    });
    // When no browser tab is connected, fire the webhook instead of the
    // in-app notification (which would go nowhere). This avoids double
    // notifications when the PWA is open.
    if (connectedClients === 0) {
      sendWebhookNotification(type === 'error' ? 'pi Error' : 'pi', message);
    }
  },

  onTerminalInput(handler, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    const wasActive = terminalInputRegistry.has(owner);
    terminalInputRegistry.register(owner, handler);
    if (!wasActive) {
      broadcast({
        type: 'extension_terminal_input_active',
        active: true,
        ...stampOwner(owner),
      });
    }
    return () => {
      const had = terminalInputRegistry.has(owner);
      terminalInputRegistry.unregister(owner, handler);
      if (had && !terminalInputRegistry.has(owner)) {
        broadcast({
          type: 'extension_terminal_input_active',
          active: false,
          ...stampOwner(owner),
        });
      }
    };
  },

  setStatus(key, text, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    const ui = uiStateFor(owner);
    if (text === undefined) ui.statuses.delete(key);
    else ui.statuses.set(key, text);
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'setStatus',
      statusKey: key,
      statusText: text,
      ...stampOwner(owner),
    });
  },

  setWorkingMessage(message, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    uiStateFor(owner).workingMessage = message;
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'setWorkingMessage',
      message,
      ...stampOwner(owner),
    });
  },
  setWorkingVisible(visible, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    uiStateFor(owner).workingVisible = visible;
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'setWorkingVisible',
      visible,
      ...stampOwner(owner),
    });
  },
  setWorkingIndicator(options, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    const ui = uiStateFor(owner);
    ui.workingIndicatorFrames = options?.frames ?? [];
    ui.workingIndicatorMs = options?.intervalMs ?? 80;
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'setWorkingIndicator',
      frames: options?.frames,
      intervalMs: options?.intervalMs,
      ...stampOwner(owner),
    });
  },
  setHiddenThinkingLabel(label, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    uiStateFor(owner).hiddenThinkingLabel = label ?? 'thinking';
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'setHiddenThinkingLabel',
      label,
      ...stampOwner(owner),
    });
  },
  diagnostic(
    message: string,
    level?: string,
    details?: string,
    source?: string,
    ownerSessionId?: string | null
  ) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    // Persist to the owning session so diagnostics do not cross-contaminate
    // pooled sessions.
    try {
      const sess = owner ? sessionPool.get(owner)?.session : activeSessionOrNull();
      sess?.sessionManager.appendCustomMessageEntry('pi-ui:diagnostic', message, true, {
        level,
        details,
        source,
      });
    } catch {
      /* session may not be ready — still broadcast to live clients */
    }
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'diagnostic',
      message,
      level: level ?? 'info',
      details,
      source,
      timestamp: Date.now(),
      ...stampOwner(owner),
    });
  },

  setWidget(
    key: string,
    content: unknown,
    options?: { placement?: WidgetPlacement },
    ownerSessionId?: string | null
  ) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    if (content === undefined) {
      teardownWidget(key, owner);
      return;
    }

    const existing = uiStateFor(owner).widgets.get(key);
    if (existing?.factory) {
      clearInterval(existing.factory.intervalId);
      existing.factory.intervalId = undefined;
      existing.factory.lastResult?.dispose?.();
      existing.factory.lastResult = undefined;
    }

    if (Array.isArray(content)) {
      const lines = (content as unknown[]).filter(
        (line): line is string => typeof line === 'string'
      );
      const payload: WidgetPayload = {
        widgetKey: key,
        widgetType: 'text',
        widgetLines: lines.map((line) => stripAnsi(line)),
        widgetHtmlLines: lines.map((line) => ansiToHtml(line)),
        widgetPlacement: options?.placement,
      };
      const ui = uiStateFor(owner);
      ui.widgets.set(key, { payload, failures: 0 });
      broadcast({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setWidget',
        ...stampOwner(owner),
        ...payload,
      });
    } else if (typeof content === 'function') {
      const widgetFactory = content as WidgetFactoryState['fn'];
      const factory: WidgetFactoryState = { fn: widgetFactory };
      const entry: WidgetStoreEntry = {
        payload: {
          widgetKey: key,
          widgetType: 'text',
          widgetLines: [],
          widgetPlacement: options?.placement,
        },
        factory,
        failures: 0,
      };
      const ui = uiStateFor(owner);
      ui.widgets.set(key, entry);
      tickWidgetFactory(key, owner);
      if (owner === activeSessionId && ui.widgets.get(key) === entry) {
        factory.intervalId = setInterval(() => tickWidgetFactory(key, owner), 250);
      }
    }
  },

  setFooter(factory, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    const apply = (content: string) => {
      uiStateFor(owner).footer = content;
      broadcast({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'set_footer',
        content,
        ...stampOwner(owner),
      });
    };
    if (!factory) {
      apply('');
      return;
    }
    void callFactoryAndParse(factory, '', undefined)
      .then((parsed) => apply(flattenParsedText(parsed)))
      .catch(() => {
        /* factory may fail without real TUI */
      });
  },
  setHeader(factory, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    const apply = (content: string) => {
      uiStateFor(owner).header = content;
      broadcast({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'set_header',
        content,
        ...stampOwner(owner),
      });
    };
    if (!factory) {
      apply('');
      return;
    }
    void callFactoryAndParse(factory, '', undefined)
      .then((parsed) => apply(flattenParsedText(parsed)))
      .catch(() => {
        /* factory may fail without real TUI */
      });
  },

  setTitle(title, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    uiStateFor(owner).title = title;
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'setTitle',
      title,
      ...stampOwner(owner),
    });
  },

  pasteToEditor(text, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'paste_to_editor',
      text,
      ...stampOwner(owner),
    });
  },

  setEditorText(text, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'set_editor_text',
      text,
      ...stampOwner(owner),
    });
  },

  getEditorText(ownerSessionId?: string | null) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    return uiStateFor(owner).editorText;
  },

  addAutocompleteProvider(factory, ownerSessionId) {
    if (!factory) return;
    const owner = ownerSessionId ?? activeSessionId;
    if (!owner) return;
    const providers = autocompleteProviderWrappers.get(owner) ?? [];
    providers.push(factory);
    autocompleteProviderWrappers.set(owner, providers);
    chainAutocompleteProviders(owner);
  },
  setEditorComponent(factory, ownerSessionId) {
    const owner = ownerSessionId ?? activeSessionId ?? null;
    const apply = (parsed: ParsedComponent | null) => {
      uiStateFor(owner).editorComponent = parsed ?? undefined;
      broadcast({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'set_editor_component',
        parsed,
        ...stampOwner(owner),
      });
    };
    if (!factory) {
      apply(null);
      return;
    }
    void callFactoryAndParse(factory, '', undefined)
      .then((parsed) => apply(parsed))
      .catch(() => {
        /* factory may fail without real TUI */
      });
  },
  getEditorComponent() {
    // Web doesn't have a custom editor; return undefined so extensions fall back to default.
    return undefined;
  },

  // TUI-only stubs — no meaningful web equivalent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  theme: undefined as any,
  getAllThemes() {
    return [];
  },
  getTheme() {
    return undefined;
  },
  setTheme() {
    return { success: true };
  },

  getToolsExpanded() {
    return toolsExpanded;
  },
  setToolsExpanded(expanded: boolean) {
    toolsExpanded = expanded;
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'setToolsExpanded',
      expanded,
    });
  },
};

/**
 * Per-session ExtensionUIContext wrapper — tags every session-owned UI call
 * (dialogs, editor-text requests, widgets) with the owning session id so the
 * server can bucket state and stamp broadcasts.
 */
function uiContextForSession(sid: string): ExtensionUIContext {
  return {
    ...uiContext,
    notify: (message: string, type?: Parameters<ExtensionUIContext['notify']>[1]) =>
      uiContext.notify(message, type, sid),
    pasteToEditor: (text: string) => uiContext.pasteToEditor(text, sid),
    setEditorText: (text: string) => uiContext.setEditorText(text, sid),
    diagnostic: (message: string, level?: string, details?: string, source?: string) =>
      uiContext.diagnostic(message, level, details, source, sid),
    setStatus: (key: string, text: string | undefined) => uiContext.setStatus(key, text, sid),
    setWorkingMessage: (message?: string) => uiContext.setWorkingMessage(message, sid),
    setWorkingVisible: (visible: boolean) => uiContext.setWorkingVisible(visible, sid),
    setWorkingIndicator: (options?: Parameters<ExtensionUIContext['setWorkingIndicator']>[0]) =>
      uiContext.setWorkingIndicator(options, sid),
    setHiddenThinkingLabel: (label?: string) => uiContext.setHiddenThinkingLabel(label, sid),
    setWidget: (key: string, content: unknown, options?: { placement?: WidgetPlacement }) =>
      uiContext.setWidget(key, content, options, sid),
    setFooter: (factory: Parameters<ExtensionUIContext['setFooter']>[0]) =>
      uiContext.setFooter(factory, sid),
    setHeader: (factory: Parameters<ExtensionUIContext['setHeader']>[0]) =>
      uiContext.setHeader(factory, sid),
    setTitle: (title: string) => uiContext.setTitle(title, sid),
    setEditorComponent: (factory: Parameters<ExtensionUIContext['setEditorComponent']>[0]) =>
      uiContext.setEditorComponent(factory, sid),
    select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
      uiContext.select(title, options, opts, sid),
    confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
      uiContext.confirm(title, message, opts, sid),
    input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
      uiContext.input(title, placeholder, opts, sid),
    editor: (title: string, prefill?: string) => uiContext.editor(title, prefill, sid),
    custom: (arg1?: unknown, arg2?: unknown, arg3?: unknown) =>
      uiContext.custom(arg1, arg2, arg3, sid),
    getEditorText: () => uiContext.getEditorText(sid),
    addAutocompleteProvider: (factory: AutocompleteProviderFactory) =>
      uiContext.addAutocompleteProvider(factory, sid),
    onTerminalInput: (handler: TerminalInputHandler) => uiContext.onTerminalInput(handler, sid),
  } as unknown as ExtensionUIContext;
}

function disposeWidgetResult(result: unknown): void {
  if (
    result &&
    typeof result === 'object' &&
    'dispose' in result &&
    typeof result.dispose === 'function'
  ) {
    result.dispose();
  }
}

function disposeWidgetFactory(factory: WidgetFactoryState): void {
  clearInterval(factory.intervalId);
  factory.intervalId = undefined;
  factory.lastResult?.dispose?.();
  factory.lastResult = undefined;
}

function teardownWidget(key: string, owner: string | null): void {
  const ui = existingUiStateFor(owner);
  const entry = ui?.widgets.get(key);
  if (entry?.factory) disposeWidgetFactory(entry.factory);
  ui?.widgets.delete(key);
  broadcast({
    type: 'extension_ui_request',
    id: crypto.randomUUID(),
    method: 'setWidget',
    widgetKey: key,
    widgetType: 'text',
    widgetLines: [],
    ...stampOwner(owner),
  });
}

/**
 * Dispose every resource and pending request owned by a session. Silent — no
 * broadcasts: a disposed session is never the active session, so no client
 * displays its UI (multi-tab: disposal skips any session a tab has active
 * because the server's active session gates disposal).
 */
function disposeUi(sid: string): void {
  // Clear the terminal-input registry FIRST — a session whose extension only
  // registered an onTerminalInput handler may never have created a UI bucket,
  // and the early return below would otherwise leak its handlers.
  terminalInputRegistry.clear(sid);
  const ui = uiStateBuckets.get(sid);
  if (!ui) return;
  disposeUiState(ui);
  uiStateBuckets.delete(sid);
}

function widgetsForSession(sid: string): WidgetPayload[] {
  const ui = uiStateBuckets.get(sid);
  if (!ui) return [];
  const out: WidgetPayload[] = [];
  for (const entry of ui.widgets.values()) out.push(entry.payload);
  return out;
}

function extensionUiStateForSession(sid: string): ExtensionUiStatePayload {
  const ui = uiStateBuckets.get(sid) ?? createSessionUiState();
  return {
    schemaVersion: EXTENSION_UI_SCHEMA_VERSION,
    statuses: Object.fromEntries(ui.statuses),
    terminalInputActive: terminalInputRegistry.has(sid),
    ...(ui.workingMessage !== undefined ? { workingMessage: ui.workingMessage } : {}),
    workingVisible: ui.workingVisible,
    ...(ui.workingIndicatorFrames.length > 0 || ui.workingIndicatorMs !== 80
      ? {
          workingIndicator: {
            frames: ui.workingIndicatorFrames,
            intervalMs: ui.workingIndicatorMs,
          },
        }
      : {}),
    hiddenThinkingLabel: ui.hiddenThinkingLabel,
    ...(ui.header ? { header: ui.header } : {}),
    ...(ui.footer ? { footer: ui.footer } : {}),
    ...(ui.editorComponent ? { editorComponent: ui.editorComponent } : {}),
    ...(ui.title !== 'pi UI' ? { title: ui.title } : {}),
    widgets: widgetsForSession(sid),
    pendingDialogs: Array.from(ui.pendingDialogs, ([id, pending]) => ({
      id,
      ...pending.requestPayload,
    })),
  };
}

function syncWidgetFactories(activeSid: string | null): void {
  for (const [sid, ui] of uiStateBuckets) {
    for (const [key, entry] of ui.widgets) {
      const factory = entry.factory;
      if (!factory) continue;
      if (sid === activeSid) {
        if (!factory.intervalId) {
          tickWidgetFactory(key, sid);
          const current = ui.widgets.get(key);
          if (current !== entry || current.factory !== factory) continue;
          factory.intervalId = setInterval(() => tickWidgetFactory(key, sid), 250);
        }
      } else if (factory.intervalId) {
        clearInterval(factory.intervalId);
        factory.intervalId = undefined;
      }
    }
  }
}

function isWidgetComponent(
  value: unknown
): value is { render(width: number): unknown; dispose?(): void } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'render' in value &&
    typeof value.render === 'function'
  );
}

function tickWidgetFactory(key: string, owner: string | null): void {
  const ui = existingUiStateFor(owner);
  const entry = ui?.widgets.get(key);
  const factory = entry?.factory;
  if (!entry || !factory) return;

  try {
    const result = factory.fn(stubTui, stubTheme);
    entry.failures = 0;
    let payload: WidgetPayload | null = null;
    const widgetPlacement = entry.payload.widgetPlacement;

    if (isWidgetComponent(result)) {
      // Try to parse as a structured component tree first.
      const parsed = parseComponentTree(result as Record<string, unknown>, 80);
      const isRich =
        parsed.kind === 'container' ||
        parsed.kind === 'select' ||
        parsed.kind === 'input' ||
        parsed.kind === 'button' ||
        parsed.kind === 'checkbox' ||
        parsed.kind === 'progress' ||
        parsed.kind === 'loader' ||
        (parsed.kind === 'text' && parsed.label && parsed.content);
      if (isRich) {
        payload = {
          widgetKey: key,
          widgetType: 'component',
          widgetComponent: parsed,
          widgetPlacement,
        };
      } else {
        // Fallback: render as plain text lines. Preserve theme.fg()/bold()
        // styling as HTML — widgetLines stays ANSI-stripped for accessibility
        // and JSON-diffing; widgetHtmlLines carries the styled rendering.
        const rawLines = result.render(80);
        if (!Array.isArray(rawLines)) return;
        const lines = rawLines.filter((line): line is string => typeof line === 'string');
        payload = {
          widgetKey: key,
          widgetType: 'text',
          widgetLines: lines.map((line) => stripAnsi(line)),
          widgetHtmlLines: lines.map((line) => ansiToHtml(line)),
          widgetPlacement,
        };
      }
    } else if (Array.isArray(result)) {
      const lines = result.filter((line): line is string => typeof line === 'string');
      payload = {
        widgetKey: key,
        widgetType: 'text',
        widgetLines: lines.map((line) => stripAnsi(line)),
        widgetHtmlLines: lines.map((line) => ansiToHtml(line)),
        widgetPlacement,
      };
    }

    if (!payload) return;
    const json = JSON.stringify(payload);
    if (factory.lastPayloadJson === json) {
      disposeWidgetResult(result);
      return;
    }
    factory.lastPayloadJson = json;
    factory.lastResult?.dispose?.();
    const disposableResult = result as unknown as { dispose?(): void };
    factory.lastResult = disposableResult;
    entry.payload = payload;
    broadcast({
      type: 'extension_ui_request',
      id: crypto.randomUUID(),
      method: 'setWidget',
      ...stampOwner(owner),
      ...payload,
    });
  } catch {
    entry.failures++;
    if (entry.failures >= 5) {
      log.warn(`[pifrontier] Widget factory '${key}' failed 5 times — tearing down`);
      teardownWidget(key, owner);
    }
  }
}

// ── 4. Pi SDK — lazy-loaded singleton ────────────────────────────────────────
//
// The SDK static import alone costs ~136 MB of RSS. By deferring the dynamic
// import until the first WebSocket connection, idle memory stays at ~32 MB
// (bare Bun + auth). First connection may wait ~10 s during SDK + session init.

let _sdk: typeof PiSDKNS | null = null;
let _projectTrustStore: PiSDKNS.ProjectTrustStore | null = null;
let _stopSessionWatch: (() => void) | undefined;

// ── Autocomplete provider wrappers (extension-registered) ─────────────────
// Providers belong to the session that registered them. This prevents a
// background session from replacing the active session's completion chain.
const autocompleteProviderWrappers = new Map<string, AutocompleteProviderFactory[]>();
const chainedAutocompleteProviders = new Map<string, AutocompleteProvider>();

function chainAutocompleteProviders(sid: string) {
  const provider: AutocompleteProvider = {
    async getSuggestions() {
      return null;
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  };
  let chained: AutocompleteProvider = provider;
  for (const wrap of autocompleteProviderWrappers.get(sid) ?? []) {
    try {
      chained = wrap(chained);
    } catch (err) {
      log.warn(`[pifrontier] autocomplete provider failed for ${sid}:`, err);
    }
  }
  chainedAutocompleteProviders.set(sid, chained);
}

function autocompleteProviderFor(sid: string): AutocompleteProvider | null {
  return chainedAutocompleteProviders.get(sid) ?? null;
}

function clearAutocompleteProviders(sid: string): void {
  autocompleteProviderWrappers.delete(sid);
  chainedAutocompleteProviders.delete(sid);
}

async function getSDK(): Promise<typeof PiSDKNS> {
  if (!_sdk) {
    log.info('[pifrontier] Loading pi SDK (first connection)…');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _sdk = (await import('@earendil-works/pi-coding-agent')) as any;
    log.info('[pifrontier] Pi SDK loaded.');
    // Real pi-coding-agent interactive components (ToolExecutionComponent,
    // AssistantMessageComponent, …) read a module-level theme singleton
    // (`@earendil-works/pi-coding-agent`'s theme.ts `get theme()`) that
    // throws "Theme not initialized" until `initTheme()` has run once —
    // normally done by the real interactive-mode CLI entry points we never
    // execute. Extensions that mount those components via `ui.custom()`
    // (e.g. pi-subagents' `/subagents:sessions` transcript overlay) crash
    // without this. Safe headless: falls back to the 'dark' theme via env
    // detection, no TTY required.
    _sdk!.initTheme();
    // Resolve SDK version from its package.json (best-effort)
    try {
      const piPkgSpecifier = '@earendil-works/pi-coding-agent/package.json';
      const piPkg = (await import(piPkgSpecifier, { with: { type: 'json' } })) as {
        default?: { version?: string };
        version?: string;
      };
      PI_SDK_VERSION = piPkg.default?.version ?? piPkg.version ?? 'unknown';
    } catch {
      // Not critical — version display stays 'unknown'
    }
    // Start watching the session root exactly once, now that the SDK's agent
    // dir (and therefore sessionsRoot()) is resolvable. External appends
    // (subagents, a concurrent pi CLI process) invalidate the cached scan and
    // trigger a coalesced sidebar/projects refresh instead of staying hidden
    // until an unrelated structural change forces a rescan.
    _stopSessionWatch = startSessionWatch(sessionsRoot, () => {
      sessionCatalog.invalidateScan();
      scheduleSessionListRefresh();
      scheduleProjectsRefresh();
    });
  }
  return _sdk!;
}

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
  /** Pending navigated-away disposal timer (null when none scheduled). */
  disposeTimer: Timer | null;
  /** Pending coalesced session_runtime broadcast timer (null when none scheduled). */
  runtimeBroadcastTimer: Timer | null;
  /** Diagnostics from service/session creation. */
  diagnostics: RuntimeDiagnostic[];
  /** Whether the host contract has completed for this session. */
  hostBound: boolean;
  /** Pending graceful extension shutdown request. */
  shutdownRequested: boolean;
  modelFallbackMessage?: string;
  /** Cached session display name — refreshed only on session_info_changed,
   *  not recomputed from sessionManager.getSessionName() on every message
   *  (that call scans every entry the session has ever had). */
  sessionName: string | undefined;
}

/** Grace before a navigated-away idle session is dropped from memory. Long
 *  enough that hopping between recent sessions never re-reads from disk or
 *  re-creates an SDK session (the dominant switch-lag cost); short enough
 *  that a whale session doesn't sit in RAM for the 30-min LRU window. */
const NAV_OUT_DISPOSE_GRACE_MS = 5 * 60 * 1000;
/** Hard cap on resident pooled sessions (the active session is always exempt).
 *  Configurable via PI_UI_MAX_POOLED_SESSIONS for deployments with more
 *  available memory. Sessions with unseen results, queued work, or that
 *  are in-memory-only are never evicted to honor this cap — see
 *  isSessionSafeToDispose — so it is a best-effort bound, not a hard limit. */
const MAX_POOLED_SESSIONS = Number(Bun.env.PI_UI_MAX_POOLED_SESSIONS) || 12;

/**
 * True when a pooled entry may be safely disposed right now: not active,
 * not running, no unseen results, no queued steering/follow-up messages,
 * and persisted to disk (in-memory sessions would lose data). Shared by
 * the navigated-away timer and the idle sweep so both apply identical
 * guarantees.
 */
function isSessionSafeToDispose(sid: string, entry: ManagedSession): boolean {
  if (sid === activeSessionId) return false;
  if (entry.isRunning || entry.unseen) return false;
  if (!entry.path) return false; // in-memory session — disposal would lose data
  try {
    if (entry.session.getSteeringMessages().length || entry.session.getFollowUpMessages().length) {
      return false;
    }
  } catch {
    return false; // session state unreadable — leave it to a later sweep
  }
  return true;
}

/** Mechanical teardown of one pooled entry: unsubscribe, dispose the SDK
 *  session, drop UI state, and remove it (and its path index entry) from
 *  the pool. Callers that need eligibility checks run isSessionSafeToDispose
 *  first; delete_session disposes unconditionally on explicit user request
 *  and does not use this helper. */
function releaseManagedSession(sid: string, entry: ManagedSession, reason: string): void {
  try {
    entry.forwardingUnsub?.();
    entry.runtimeUnsub?.();
    entry.session.dispose();
  } catch (err) {
    log.error(`[pifrontier] Error disposing session ${sid}:`, err);
  }
  disposeUi(sid);
  sessionPool.delete(sid);
  if (entry.path) pathToSessionId.delete(entry.path);
  sessionCatalog.apply({ kind: 'release', id: sid });
  log.info(`[pifrontier] Released session ${sid} from memory (${reason}).`);
}

/**
 * Schedule disposal of a session the user navigated away from. Sessions are
 * exempt while they can't be safely or cheaply recreated from disk:
 * still running, holding queued steering/follow-up, carrying unseen results,
 * or not persisted at all (in-memory sessions would lose data). The disk file
 * is the source of truth for everything else — switching back re-opens it.
 */
function scheduleNavOutDisposal(sid: string): void {
  const entry = sessionPool.get(sid);
  if (!entry || entry.disposeTimer) return;
  if (!entry.path) return; // in-memory session — disposal would lose data
  entry.disposeTimer = setTimeout(() => {
    entry.disposeTimer = null;
    if (sessionPool.get(sid) !== entry || !isSessionSafeToDispose(sid, entry)) return;
    releaseManagedSession(sid, entry, 'navigated-away');
  }, NAV_OUT_DISPOSE_GRACE_MS);
}

/** Cancel a pending nav-out disposal (session became active or started running). */
function cancelNavOutDisposal(entry: ManagedSession): void {
  if (entry.disposeTimer) {
    clearTimeout(entry.disposeTimer);
    entry.disposeTimer = null;
  }
}

/** Path→session-id index kept in sync with `sessionPool` so switching to an
 *  already-pooled session by file path is O(1) instead of scanning the pool. */
const pathToSessionId = new Map<string, string>();
const sessionPool = new Map<string, ManagedSession>();
let activeSessionId: string | null = null;
// Promise lock — prevents concurrent first-connection races from creating duplicate sessions.
let _sessionInitPromise: Promise<string> | null = null;
/** Serializes session-creating/switching operations (new_session,
 *  switch_session, fork_session, and the matching extension command
 *  actions) so concurrent requests cannot race to create duplicate SDK
 *  sessions or interleave activeSessionId updates. A rejected operation
 *  does not jam the queue for the next one. */
let _sessionMutationQueue: Promise<unknown> = Promise.resolve();
function withSessionMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = _sessionMutationQueue.then(operation, operation);
  _sessionMutationQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ── Session catalog ───────────────────────────────────────────────────────────
// Single source of truth for the merged session list (sidebar, project
// picker, resume dialog). The SDK's SessionManager.list()/listAll() load
// every session .jsonl fully AND build a concatenated allMessagesText per
// file — with hundreds of MB of sessions a scan both takes seconds and can
// OOM the process, so listing goes through the streaming per-file-mtime-
// cached scanner (src/lib/server/session-scan.ts) composed with a live
// overlay for pooled sessions (src/lib/server/session-catalog.ts). Pooled
// summaries win over disk while resident, so the active session's file is
// never re-read after every message. All mutations go through
// sessionCatalog.apply() (single write chokepoint); the onChange
// subscription below turns them into coalesced sidebar refreshes.

/** Root directory holding per-project session dirs (~/.pi/agent/sessions). */
function sessionsRoot(): string {
  return join(_sdk!.getAgentDir(), 'sessions');
}

const sessionCatalog = new SessionCatalog(sessionsRoot);

sessionCatalog.onChange(() => {
  // Pooled-session upserts (message_end per message in a turn) are broadcast
  // as coalesced session_updated deltas by the runtime subscription — a full
  // merged-list rescan + serialize per message is the O(sessions) churn this
  // avoids. Structural changes (rename/remove/release) still need the full
  // list pushed to every client.
  if (sessionCatalog.lastPatch === 'upsert') return;
  scheduleSessionListRefresh();
});

// Merged project list: persisted registry + live session counts (see
// project-catalog.ts). Mutations flow through projectCatalog.apply(); the
// onChange subscription below turns them (and session-catalog changes it
// observes internally) into coalesced projects_list broadcasts.
const projectCatalog = new ProjectCatalog(sessionCatalog);

projectCatalog.onChange(() => scheduleProjectsRefresh());

// ── LRU idle session cleanup ──────────────────────────────────────────────────
// Dispose inactive pooled sessions after 30 min of inactivity so the Pi doesn't
// run out of memory over time. The active session and any still-running session
// are exempt.

const IDLE_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
let _idleCleanupTimer: Timer | null = null;

function startIdleCleanup(): void {
  if (_idleCleanupTimer) return;
  _idleCleanupTimer = setInterval(() => {
    const now = Date.now();
    const eligible: [string, ManagedSession][] = [];
    for (const [sid, entry] of sessionPool) {
      if (isSessionSafeToDispose(sid, entry)) eligible.push([sid, entry]);
    }
    // Oldest-activity-first: the size cap below trims the least-recently-used
    // eligible entries; a session past the flat idle timeout is disposed
    // regardless of the cap.
    eligible.sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    let poolSize = sessionPool.size;
    for (const [sid, entry] of eligible) {
      const overCap = poolSize > MAX_POOLED_SESSIONS;
      const idleTooLong = now - entry.lastActivity >= IDLE_SESSION_TIMEOUT_MS;
      if (!overCap && !idleTooLong) continue;
      cancelNavOutDisposal(entry);
      releaseManagedSession(sid, entry, overCap ? 'pool-cap' : 'idle-timeout');
      poolSize--;
    }
  }, 60_000); // check every 60s
}

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
  const sid = pathToSessionId.get(path);
  return sid ? sessionPool.get(sid) : undefined;
}
function extensionFlagValuesFor(): Map<string, boolean | string> {
  const stored = readSettings().extensionFlags;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return new Map();
  return new Map(
    Object.entries(stored as Record<string, unknown>).filter(
      (entry): entry is [string, boolean | string] =>
        typeof entry[1] === 'boolean' || typeof entry[1] === 'string'
    )
  );
}

function persistExtensionFlag(name: string, value: boolean | string): void {
  const stored = readSettings().extensionFlags;
  const flags =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? { ...(stored as Record<string, unknown>) }
      : {};
  flags[name] = value;
  updateSettings({ extensionFlags: flags });
}

function trustStore(): PiSDKNS.ProjectTrustStore {
  if (!_sdk) throw new Error('Pi SDK is not loaded');
  return (_projectTrustStore ??= new _sdk.ProjectTrustStore(_sdk.getAgentDir()));
}

function projectTrustInfoFor(targetCwd: string): ProjectTrustInfo {
  if (!_sdk) {
    return { cwd: targetCwd, decision: 'ask', requiresDecision: true, persisted: false };
  }
  const stored = trustStore().get(targetCwd);
  // Session-only trust ("trust this session") lives on the in-memory settings
  // manager of the active session — surface it so the UI reflects it.
  const sess = activeSessionOrNull();
  const sessionTrusted =
    sess !== null &&
    resolve(sess.sessionManager.getCwd() || cwd) === resolve(targetCwd) &&
    sess.settingsManager.isProjectTrusted();
  return {
    cwd: targetCwd,
    decision:
      stored === true
        ? 'trusted'
        : stored === false
          ? 'denied'
          : sessionTrusted
            ? 'trusted'
            : 'ask',
    requiresDecision: _sdk.hasTrustRequiringProjectResources(targetCwd),
    persisted: stored !== null,
  };
}

async function resolveProjectTrust(
  targetCwd: string,
  settingsManager: PiSDKNS.SettingsManager
): Promise<boolean> {
  const info = projectTrustInfoFor(targetCwd);
  if (!info.requiresDecision) {
    settingsManager.setProjectTrusted(true);
    return true;
  }
  const stored = trustStore().get(targetCwd);
  if (stored !== null) {
    settingsManager.setProjectTrusted(stored);
    return stored;
  }
  // Undecided — keep project resources out for now and let the client's
  // trust banner (decision 'ask') offer Trust project / Trust this session.
  // Deliberately non-blocking: never gate session creation on a dialog here.
  settingsManager.setProjectTrusted(false);
  return false;
}

interface CreatedSdkSession {
  session: AgentSession;
  diagnostics: RuntimeDiagnostic[];
  modelFallbackMessage?: string;
}

async function createSdkSession(
  targetCwd: string,
  sessionManager: PiSDKNS.SessionManager,
  reason: PiSDKNS.SessionStartEvent['reason'],
  previousSessionFile?: string
): Promise<CreatedSdkSession> {
  const tCreate = Date.now();
  const sdk = await getSDK();
  const source = activeSessionOrNull();
  const settingsManager = sdk.SettingsManager.create(targetCwd, sdk.getAgentDir(), {
    projectTrusted: false,
  });
  const services = await sdk.createAgentSessionServices({
    cwd: targetCwd,
    agentDir: sdk.getAgentDir(),
    settingsManager,
    modelRuntime: source?.modelRuntime,
    extensionFlagValues: extensionFlagValuesFor(),
    resourceLoaderReloadOptions: {
      resolveProjectTrust: async () => resolveProjectTrust(targetCwd, settingsManager),
    },
  });
  const result = await sdk.createAgentSessionFromServices({
    services,
    sessionManager,
    sessionStartEvent: {
      type: 'session_start',
      reason,
      ...(previousSessionFile ? { previousSessionFile } : {}),
    },
  });
  const diagnostics: RuntimeDiagnostic[] = [...services.diagnostics];
  for (const error of result.extensionsResult.errors) {
    diagnostics.push({ type: 'error', message: `${error.path}: ${error.error}` });
  }
  if (result.modelFallbackMessage) {
    diagnostics.push({ type: 'warning', message: result.modelFallbackMessage });
  }
  log.info(`[pifrontier] createSdkSession ${reason} done in ${Date.now() - tCreate}ms`);
  return {
    session: result.session,
    diagnostics,
    modelFallbackMessage: result.modelFallbackMessage,
  };
}

type HostReplacementContext = PiSDKNS.ExtensionCommandContext & {
  sendMessage: AgentSession['sendCustomMessage'];
  sendUserMessage: AgentSession['sendUserMessage'];
};

function replacementContextFor(session: AgentSession): HostReplacementContext {
  const commandContext = session.extensionRunner.createCommandContext();
  return {
    ...commandContext,
    sendMessage: (
      message: Parameters<AgentSession['sendCustomMessage']>[0],
      options: Parameters<AgentSession['sendCustomMessage']>[1]
    ) => session.sendCustomMessage(message, options),
    sendUserMessage: (
      content: Parameters<AgentSession['sendUserMessage']>[0],
      options: Parameters<AgentSession['sendUserMessage']>[1]
    ) => session.sendUserMessage(content, options),
  } as unknown as HostReplacementContext;
}

function requestExtensionShutdown(sid: string): void {
  const entry = sessionPool.get(sid);
  if (!entry || entry.shutdownRequested) return;
  entry.shutdownRequested = true;
  const finish = () => {
    if (sessionPool.get(sid) !== entry) return;
    broadcast({ type: 'shutdown_requested', sessionId: sid });
    void _shutdown();
  };
  if (entry.session.isIdle) finish();
  else void entry.session.waitForIdle().then(finish, finish);
}

function commandContextActionsFor(
  sid: string,
  session: AgentSession
): ExtensionCommandContextActions {
  return {
    waitForIdle: () => session.waitForIdle(),
    newSession: (options) =>
      withSessionMutationLock(async () => {
        const sdk = await getSDK();
        const previousSessionFile = session.sessionFile;
        const targetCwd = session.sessionManager.getCwd() || cwd;
        const manager = sdk.SessionManager.create(targetCwd);
        await options?.setup?.(manager);
        const created = await createSdkSession(targetCwd, manager, 'new', previousSessionFile);
        await bindRpcHost(created.session);
        await setActiveSession(created.session, targetCwd, created);
        await options?.withSession?.(replacementContextFor(created.session));
        return { cancelled: false };
      }),
    fork: (entryId, options) =>
      withSessionMutationLock(async () => {
        const sessionFile = session.sessionFile;
        if (!sessionFile) throw new Error('Cannot fork an in-memory session');
        const manager = sdkOrThrow().SessionManager.open(sessionFile);
        const forkPath = manager.createBranchedSession(entryId);
        if (!forkPath) throw new Error('Failed to create branched session');
        const forkManager = sdkOrThrow().SessionManager.open(forkPath);
        const created = await createSdkSession(
          forkManager.getCwd() || session.sessionManager.getCwd() || cwd,
          forkManager,
          'fork',
          session.sessionFile
        );
        await bindRpcHost(created.session);
        await setActiveSession(created.session, forkManager.getCwd(), created);
        await options?.withSession?.(replacementContextFor(created.session));
        return { cancelled: false };
      }),
    navigateTree: (targetId, options) => session.navigateTree(targetId, options),
    switchSession: (sessionPath, options) =>
      withSessionMutationLock(async () => {
        const target = findManagedSessionByPath(resolve(sessionPath));
        if (target) {
          await setActiveSession(target.session, target.cwd);
          await options?.withSession?.(replacementContextFor(target.session));
          return { cancelled: false };
        }
        const known = await sessionCatalog.list();
        const resolvedPath = resolve(sessionPath);
        if (
          !known.some((item) => item.path === resolvedPath) &&
          !(await sessionCatalog.hasFile(resolvedPath))
        ) {
          throw new Error('Session not found');
        }
        const manager = sdkOrThrow().SessionManager.open(resolvedPath);
        const created = await createSdkSession(
          manager.getCwd() || cwd,
          manager,
          'resume',
          session.sessionFile
        );
        await bindRpcHost(created.session);
        await setActiveSession(created.session, manager.getCwd(), created);
        await options?.withSession?.(replacementContextFor(created.session));
        return { cancelled: false };
      }),
    reload: async () => {
      await reloadSessionHost(sid, session);
    },
  };
}

function sdkOrThrow(): typeof PiSDKNS {
  if (!_sdk) throw new Error('Pi SDK is not loaded');
  return _sdk;
}

async function bindRpcHost(session: AgentSession): Promise<void> {
  const sid = session.sessionId;
  await session.bindExtensions({
    mode: 'rpc',
    uiContext: uiContextForSession(sid),
    commandContextActions: commandContextActionsFor(sid, session),
    abortHandler: () => {
      void session.abort();
    },
    shutdownHandler: () => requestExtensionShutdown(sid),
    onError: (error: ExtensionError) => {
      broadcast({ type: 'extension_error', error });
      uiContext.diagnostic(
        error.error,
        'error',
        error.stack,
        `${error.extensionPath}:${error.event}`,
        sid
      );
    },
  });
}

async function reloadSessionHost(sid: string, session: AgentSession): Promise<void> {
  terminalInputRegistry.clear(sid);
  clearAutocompleteProviders(sid);
  broadcast({ type: 'extension_terminal_input_active', active: false, ...stampOwner(sid) });
  await session.reload();
  const entry = sessionPool.get(sid);
  if (entry) {
    entry.diagnostics = session.resourceLoader.getExtensions().errors.map((error) => ({
      type: 'error',
      message: `${error.path}: ${error.error}`,
    }));
    entry.hostBound = true;
  }
  broadcastSessionLoaded(session);
  broadcast({ type: 'runtime_diagnostics', diagnostics: entry?.diagnostics ?? [] });
  broadcast({ type: 'commands_list', commands: extensionCommandsFor(session) });
  broadcast({
    type: 'tools_list',
    tools: session.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      isBuiltin: tool.sourceInfo.source === 'builtin',
      origin: tool.sourceInfo.source,
    })),
    activeToolNames: session.getActiveToolNames(),
  });
}
function packageManagerFor(session: AgentSession): {
  manager: PackageManagerWithUpdates;
  settings: PiSDKNS.SettingsManager;
} {
  const sdk = sdkOrThrow();
  const targetCwd = session.sessionManager.getCwd() || cwd;
  const settings = sdk.SettingsManager.create(targetCwd, sdk.getAgentDir(), {
    projectTrusted: session.settingsManager.isProjectTrusted(),
  });
  const manager = new sdk.DefaultPackageManager({
    cwd: targetCwd,
    agentDir: sdk.getAgentDir(),
    settingsManager: settings,
  });
  return { manager, settings };
}
function packageSourceName(source: PiSDKNS.PackageSource): string {
  return typeof source === 'string' ? source : source.source;
}
type PackageManagerWithUpdates = PiSDKNS.PackageManager & {
  checkForAvailableUpdates(): Promise<PackageUpdateInfo[]>;
};

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
      () => null
    );
    if (sid) return sessionPool.get(sid)!.session;
    // Stale promise — reset and fall through to create a new session
    _sessionInitPromise = null;
  }
  if (activeSessionId && sessionPool.has(activeSessionId)) return activeSession();
  if (!_sessionInitPromise) {
    _sessionInitPromise = (async () => {
      const start = Date.now();
      const sdk = await getSDK();
      const t0 = Date.now();
      log.info(`[pifrontier] Starting pi session in ${cwd} …`);
      const sm = sdk.SessionManager.continueRecent(cwd);
      const created = await createSdkSession(cwd, sm, 'startup');
      const sess = created.session;
      const sid = sess.sessionId;
      const cwdV = sess.sessionManager.getCwd() || cwd;
      // Register immediately without waiting for bind — bindExtensions can be
      // slow with 34+ tools/extensions and previously blocked the cold-start
      // session_loaded for seconds. See setActiveSession for the same pattern.
      registerSession(sid, sess, cwdV, false, created);
      activeSessionId = sid;
      syncWidgetFactories(sid);
      const bindStart = Date.now();
      void bindRpcHost(sess)
        .then(() => {
          const e = sessionPool.get(sid);
          if (e) e.hostBound = true;
          log.info(
            `[pifrontier] bindRpcHost startup done in ${Date.now() - bindStart}ms (createSdkSession ${bindStart - t0}ms, total ${Date.now() - start}ms)`
          );
          broadcast({ type: 'tools_list', ...toolsPayloadFor(sess) });
          broadcast({ type: 'commands_list', commands: extensionCommandsFor(sess) });
          const diag = sessionPool.get(sid)?.diagnostics ?? [];
          broadcast({ type: 'runtime_diagnostics', diagnostics: diag });
        })
        .catch((err) => log.error('[pifrontier] bindRpcHost startup failed:', err));
      projectCatalog.apply({ kind: 'touch', path: sess.sessionManager.getCwd() || cwd });
      log.info(
        `[pifrontier] Pi session ready: ${sess.sessionId} (${sm.isPersisted() ? 'persisted' : 'in-memory'}) in ${Date.now() - start}ms (bind in background)`
      );

      return sid;
    })();
  }
  const sid = await _sessionInitPromise;
  return sessionPool.get(sid)!.session;
}

/**
 * Event forwarder for the active session's SDK events → all browser tabs.
 *
 * - Tags every event with sessionId so clients can drop late-arriving events
 *   from a previously-active session after a switch.
 * - `message_update`: the SDK includes the FULL partial message on every
 *   delta — on long reasoning turns that is quadratic WS traffic and the
 *   primary cause of huge-chat meltdowns. The client applies deltas
 *   incrementally and only needs `assistantMessageEvent`, so the message is
 *   reduced to its role.
 * - `message_end`: enriched with live context usage.
 */
function makeEventForwarder(
  sid: string,
  sess: AgentSession
): (event: PiSDKNS.AgentSessionEvent) => void {
  const pendingToolArgs = new Map<string, unknown>();
  return (event) => {
    // Normal completion/turn-end events must release argument payloads even
    // when forwarding is disabled or the session is no longer active.
    if (event.type === 'agent_end') pendingToolArgs.clear();
    if (activeSessionId !== sid || connectedClients === 0) {
      if (event.type === 'tool_execution_end') pendingToolArgs.delete(event.toolCallId);
      return;
    }
    if (event.type === 'message_update') {
      broadcast({ ...event, sessionId: sid, message: { role: event.message.role } });
    } else if (event.type === 'message_end') {
      try {
        broadcast({ ...event, sessionId: sid, contextUsage: sess.getContextUsage() });
      } catch {
        broadcast({ ...event, sessionId: sid });
      }
    } else if (event.type === 'tool_execution_start') {
      pendingToolArgs.set(event.toolCallId, event.args);
      const renderedCallHtml = renderToolCallHtml(
        sess,
        event.toolName,
        event.args,
        event.toolCallId
      );
      broadcast({ ...event, sessionId: sid, ...(renderedCallHtml ? { renderedCallHtml } : {}) });
    } else if (event.type === 'tool_execution_update') {
      const args = pendingToolArgs.get(event.toolCallId);
      const renderedResultHtml = renderToolResultHtml(
        sess,
        event.toolName,
        event.partialResult,
        args,
        event.toolCallId,
        true
      );
      broadcast({
        ...event,
        sessionId: sid,
        ...(renderedResultHtml ? { renderedResultHtml } : {}),
      });
    } else if (event.type === 'tool_execution_end') {
      const args = pendingToolArgs.get(event.toolCallId);
      pendingToolArgs.delete(event.toolCallId);
      const renderedResultHtml = renderToolResultHtml(
        sess,
        event.toolName,
        event.result,
        args,
        event.toolCallId,
        false
      );
      broadcast({
        ...event,
        sessionId: sid,
        ...(renderedResultHtml ? { renderedResultHtml } : {}),
      });
    } else {
      broadcast({ ...event, sessionId: sid });
    }
  };
}
/** Register a session in the pool after its RPC host binding completed. */
function registerSession(
  sid: string,
  sess: AgentSession,
  cwdV: string,
  _bindExt: boolean,
  created?: CreatedSdkSession
) {
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
    disposeTimer: null,
    runtimeBroadcastTimer: null,
    diagnostics: created?.diagnostics ?? [],
    sessionName: sess.sessionManager.getSessionName(),
    hostBound: _bindExt || created !== undefined,
    shutdownRequested: false,
    ...(created?.modelFallbackMessage
      ? { modelFallbackMessage: created.modelFallbackMessage }
      : {}),
  };
  sessionPool.set(sid, entry);
  if (path) pathToSessionId.set(path, sid);
  // Pooled sessions are overlay-authoritative while resident — register the
  // live summary immediately so the sidebar sees the session without any
  // file scan (and without waiting for the first message_end).
  sessionCatalog.apply({ kind: 'upsert', session: poolSummary(sess, entry) });

  // Subscribe runtime-status tracking for ALL pooled sessions (always on)
  entry.runtimeUnsub = sess.subscribe((event) => {
    switch (event.type) {
      case 'agent_start':
        entry.isRunning = true;
        entry.unseen = activeSessionId !== sid;
        // A run started (e.g. queued follow-up) — keep the session in memory.
        cancelNavOutDisposal(entry);
        break;
      case 'agent_end': {
        entry.isRunning = false;
        const backgroundEnd = activeSessionId !== sid;
        if (backgroundEnd) entry.unseen = true;
        entry.lastActivity = Date.now();
        // Closed-app notification (Web Push). The SW suppresses pushes when a
        // page is visible, and tags dedupe against the page's own hidden-tab
        // notifications — payloads carry no message text.
        void sendPushNotification(
          backgroundEnd
            ? {
                kind: 'session_finished',
                title: 'Session Finished',
                body: `Session ${sid.slice(0, 8)} has new results.`,
                tag: `pi-session-${sid}`,
                sessionId: sid,
                ...(entry.path ? { sessionPath: entry.path } : {}),
              }
            : {
                kind: 'response_complete',
                title: 'Response Complete',
                body: 'pi finished responding.',
                tag: 'pi-agent-end',
                sessionId: sid,
                ...(entry.path ? { sessionPath: entry.path } : {}),
              }
        );
        break;
      }
      case 'message_end':
        entry.lastActivity = Date.now();
        if (activeSessionId !== sid) entry.unseen = true;
        // Live summary replaces the disk parse — the file is not re-read.
        sessionCatalog.apply({ kind: 'upsert', session: poolSummary(sess, entry) });
        break;
      case 'session_info_changed':
        // Rename via any path (slash command, WS handler, SDK) — refresh the
        // live summary so the sidebar name is never stale. The WS rename
        // handler's explicit apply stays for non-pooled targets (no
        // AgentSession → no event); for pooled ones this is the chokepoint.
        entry.sessionName = sess.sessionManager.getSessionName();
        sessionCatalog.apply({ kind: 'upsert', session: poolSummary(sess, entry) });
        break;
      case 'compaction_start': {
        compactionWatchdog.start(sid);
        const reason = (event as { reason?: string }).reason ?? '';
        log.info(`[pifrontier] session ${sid}: compaction_start (reason: ${reason || 'auto'})`);
        break;
      }
      case 'compaction_end': {
        compactionWatchdog.clear(sid);
        const ce = event as {
          aborted?: boolean;
          willRetry?: boolean;
          reason?: string;
          errorMessage?: string;
        };
        log.info(
          `[pifrontier] session ${sid}: compaction_end (reason: ${ce.reason ?? 'auto'}, ` +
            `aborted: ${ce.aborted ?? false}, willRetry: ${ce.willRetry ?? false}` +
            `${ce.errorMessage ? `, error: ${ce.errorMessage}` : ''})`
        );
        // A successful compaction rewrites the session's context. The client's
        // message list and token estimate are stale (they still reflect the
        // pre-compaction history) — re-broadcast session_loaded so the UI
        // shows the compacted conversation. Deferred a tick so the SDK's
        // finally block has cleared isCompacting before we read it.
        if (!ce.aborted && !ce.willRetry && !ce.errorMessage && activeSessionId === sid) {
          setTimeout(() => {
            if (activeSessionId !== sid) return; // user switched away mid-compaction
            const sess = sessionPool.get(sid)?.session;
            if (!sess) return;
            broadcastSessionLoaded(sess);
          }, 0);
        }
        // Compaction rewrote the session — memory is already the compacted
        // truth (the SDK reassigns agent.state.messages before emitting
        // compaction_end), so refresh the live summary. The old code left
        // the sidebar on pre-compaction counts until the next message.
        entry.lastActivity = Date.now();
        sessionCatalog.apply({ kind: 'upsert', session: poolSummary(sess, entry) });
        break;
      }
    }
    // Broadcast runtime-status snapshot so sidebar can show live dots. A turn
    // emits message_end per message, so coalesce trailing — the client only
    // needs the settled state, and the frame storm on long turns is pure
    // overhead (mirrors the 300ms session/project list coalescers).
    if (entry.runtimeBroadcastTimer) return;
    entry.runtimeBroadcastTimer = setTimeout(() => {
      entry.runtimeBroadcastTimer = null;
      // Session disposed/re-registered under the timer — never broadcast a
      // stale entry's state for a live session (or a removed one).
      if (sessionPool.get(sid) !== entry) return;
      broadcastSessionRuntime(sid, entry);
      // Live summary delta — keeps the sidebar's counts/name/firstMessage
      // fresh without re-serializing the full session list per message.
      broadcast({
        type: 'session_updated',
        session: serializeSession(poolSummary(sess, entry)),
        ...stampOwner(sid),
      });
    }, 300);
  });

  // Subscribe event-forwarding (only active session gets this)
  entry.forwardingUnsub = sess.subscribe(makeEventForwarder(sid, sess));
}
function sessionRuntimePayload(sid: string, entry: ManagedSession) {
  return {
    type: 'session_runtime' as const,
    sessionId: sid,
    isRunning: entry.isRunning,
    unseen: entry.unseen,
    lastActivity: entry.lastActivity,
  };
}

function sendSessionRuntime(
  sink: { send(data: string): unknown },
  sid: string,
  entry: ManagedSession
): void {
  sink.send(JSON.stringify(sessionRuntimePayload(sid, entry)));
}

/** Broadcast a runtime-status update for a single pooled session. */
function broadcastSessionRuntime(sid: string, entry: ManagedSession): void {
  broadcast(sessionRuntimePayload(sid, entry));
}

/**
 * Abort a wedged compaction and synthesize the compaction_end the SDK should
 * have emitted, so the client seals its spinner and isCompacting clears.
 * If abortCompaction() succeeds the SDK emits its own compaction_end — the
 * synthetic broadcast is then a harmless no-op on the client (the notice is
 * already sealed). If the SDK stays wedged (e.g. an extension hook ignoring
 * the abort signal), the synthetic broadcast is the only way out.
 */
function handleCompactionTimeout(sid: string): void {
  const entry = sessionPool.get(sid);
  if (!entry) return;
  log.error(
    `[pifrontier] Compaction for session ${sid} did not finish within ${COMPACTION_TIMEOUT_MS / 60_000} min — aborting.`
  );
  try {
    entry.session.abortCompaction();
  } catch (err) {
    log.error(`[pifrontier] abortCompaction error for session ${sid}:`, err);
  }
  broadcast({
    type: 'compaction_end',
    sessionId: sid,
    reason: 'manual',
    result: undefined,
    aborted: true,
    willRetry: false,
    errorMessage: `Compaction timed out after ${COMPACTION_TIMEOUT_MS / 60_000} min and was aborted.`,
  });
}

/** Watchdog for stuck compactions — see src/lib/server/compaction-watchdog.ts. */
const compactionWatchdog = createCompactionWatchdog({
  timeoutMs: COMPACTION_TIMEOUT_MS,
  onTimeout: handleCompactionTimeout,
});

/**
 * Switch the active session. The old session stays alive in the pool (its
 * agent continues running if mid-stream). The new session gets event-forwarding
 * to the browser and a session_loaded broadcast.
 *
 * If the session is already in the pool (previously active) it is reused
 * without re-creating from disk. This preserves in-progress state.
 */
/**
 * Non-blocking snapshot of the runtime's model list; refreshes in the
 * background and pushes the fresh list via available_models_changed when it
 * settles. Keeps provider auth checks (network round trips per provider) off
 * the session-switch critical path — the snapshot is fresh enough for the
 * picker, and the refresh result arrives a moment later.
 */
function snapshotModels(sess: AgentSession): ModelInfo[] {
  const snap = sess.modelRuntime
    .getAvailableSnapshot()
    .map(serializeModel)
    .filter((m): m is ModelInfo => m !== null);
  sess.modelRuntime
    .getAvailable() // coalesced by the runtime; never blocks
    .then(() => {
      const fresh = sess.modelRuntime
        .getAvailableSnapshot()
        .map(serializeModel)
        .filter((m): m is ModelInfo => m !== null);
      if (fresh.length) {
        broadcast({ type: 'available_models_changed', availableModels: fresh });
      }
    })
    .catch((err) => {
      log.error('[pifrontier] model availability refresh failed:', err);
    });
  return snap;
}

function toolsPayloadFor(sess: AgentSession): {
  tools: Array<{ name: string; description: string; isBuiltin: boolean; origin?: string }>;
  activeToolNames: string[];
} {
  return {
    tools: sess.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      isBuiltin: tool.sourceInfo.source === 'builtin',
      origin: tool.sourceInfo.source,
    })),
    activeToolNames: sess.getActiveToolNames(),
  };
}

/** Broadcast a full session_loaded payload for `sess` — used on session switch
 *  and to refresh the client after a successful compaction. */
function broadcastSessionLoaded(sess: AgentSession, requestId?: string): void {
  const init = initialMessages(sess.messages, sess);
  broadcast({
    type: 'session_loaded',
    sessionId: sess.sessionId,
    ...(requestId !== undefined ? { requestId } : {}),
    isStreaming: sess.isStreaming,
    thinkingLevel: sess.thinkingLevel,
    model: serializeModel(sess.model),
    availableModels: snapshotModels(sess),
    messages: init.msgs,
    streamingMessage: streamingMessageForWire(sess),
    totalMessageCount: init.total,
    messagesTruncated: init.truncated,
    cwd: sess.sessionManager.getCwd() || cwd,
    sessionName: sess.sessionManager.getSessionName(),
    isCompacting: sess.isCompacting,
    autoCompactionEnabled: sess.autoCompactionEnabled,
    autoRetryEnabled: sess.autoRetryEnabled,
    queuedSteering: sess.getSteeringMessages(),
    queuedFollowUp: sess.getFollowUpMessages(),
    piVersion: PI_SDK_VERSION,
    uiVersion: UI_VERSION,
    sessionMode: sess.sessionManager.isPersisted() ? 'persisted' : 'in-memory',
    sessionPath: sess.sessionManager.getSessionFile() ?? undefined,
    contextUsage: sess.getContextUsage(),
    projectTrust: projectTrustInfoFor(sess.sessionManager.getCwd() || cwd),
    diagnostics: sessionPool.get(sess.sessionId)?.diagnostics ?? [],
    modelFallbackMessage: sessionPool.get(sess.sessionId)?.modelFallbackMessage,
    extensionUiState: extensionUiStateForSession(sess.sessionId),
    widgets: widgetsForSession(sess.sessionId),
    ...toolsPayloadFor(sess),
  });
}
let _sessionListRefreshTimer: Timer | null = null;
/** Last serialized all_sessions_list payload — identical re-broadcasts are
 *  skipped (mutations that don't change the merged output, e.g. no-op renames
 *  or touch-only patches, would otherwise re-push the whole list). */
let _lastSessionListJson: string | null = null;

/**
 * Refresh sidebar data after the active session is visible.
 *
 * The merged list is cheap now (catalog overlay + stat-only scan), but the
 * broadcast itself scales with session count, so bursts of mutations
 * (message_end per message in a turn) coalesce into one refresh. It must
 * also never sit on the new-session/session-switch response path: the
 * browser can render the session immediately, while the sidebar catches up
 * on a later tick.
 */
async function refreshSessionLists(): Promise<void> {
  // No browser attached — the scan + serialize + broadcast would be pure churn
  // (background sessions keep mutating the catalogs). The next connect replays
  // runtime snapshots and the client re-requests the lists itself.
  if (connectedClients === 0) return;
  try {
    const all = await sessionCatalog.list();
    const payload: ServerMessage = {
      type: 'all_sessions_list',
      sessions: all.map(serializeSession),
    };
    const json = JSON.stringify(payload);
    if (json === _lastSessionListJson) return;
    _lastSessionListJson = json;
    server.publish(WS_TOPIC, json);
  } catch (err) {
    log.error('[pifrontier] refreshSessionLists: failed to broadcast session list:', err);
  }
}

let _projectsRefreshTimer: Timer | null = null;

/** Coalesced projects_list broadcast — the project catalog emits on registry
 *  patches and on session-catalog changes (counts/recency it observes). */
function scheduleProjectsRefresh(): void {
  if (_projectsRefreshTimer) return;
  _projectsRefreshTimer = setTimeout(() => {
    _projectsRefreshTimer = null;
    void (async () => {
      // Same idle guard as refreshSessionLists — no clients, no work.
      if (connectedClients === 0) return;
      try {
        broadcast({ type: 'projects_list', projects: await projectCatalog.list() });
      } catch (err) {
        log.error('[pifrontier] failed to broadcast project list:', err);
      }
    })();
  }, 300);
}

function scheduleSessionListRefresh(): void {
  if (_sessionListRefreshTimer) return;
  _sessionListRefreshTimer = setTimeout(() => {
    _sessionListRefreshTimer = null;
    void refreshSessionLists();
  }, 300);
}

async function setActiveSession(
  newSession: AgentSession,
  newCwd?: string,
  created?: CreatedSdkSession,
  requestId?: string
) {
  const newId = newSession.sessionId;
  const previousSessionId = activeSessionId;

  if (previousSessionId && previousSessionId !== newId) {
    const prev = sessionPool.get(previousSessionId);
    if (prev?.forwardingUnsub) {
      prev.forwardingUnsub();
      prev.forwardingUnsub = null;
    }
    if (prev) scheduleNavOutDisposal(previousSessionId);
  }

  const alreadyPooled = sessionPool.has(newId);
  if (!alreadyPooled) {
    // Register immediately without waiting for bind — bindExtensions can be
    // slow with 34+ tools/extensions and previously blocked the new-chat
    // response for seconds. The session is usable for messaging before the
    // RPC host is ready; host-bound details (extension tools/commands) are
    // pushed incrementally once bind completes.
    registerSession(
      newId,
      newSession,
      newCwd || newSession.sessionManager.getCwd() || cwd,
      false,
      created
    );
    const entryAtBind = sessionPool.get(newId)!;
    void bindRpcHost(newSession)
      .then(() => {
        // A nav-out or pool-cap release may have removed this entry while
        // extension binding was in flight. Never publish stale tool state or
        // retain the old session graph after that replacement.
        if (sessionPool.get(newId) !== entryAtBind) return;
        entryAtBind.hostBound = true;
        if (connectedClients === 0) return;
        broadcast({ type: 'tools_list', ...toolsPayloadFor(newSession) });
        broadcast({ type: 'commands_list', commands: extensionCommandsFor(newSession) });
        broadcast({ type: 'runtime_diagnostics', diagnostics: entryAtBind.diagnostics });
      })
      .catch((err) => log.error('[pifrontier] bindRpcHost for new session failed:', err));
  }

  activeSessionId = newId;
  syncWidgetFactories(newId);

  const entry = sessionPool.get(newId)!;
  cancelNavOutDisposal(entry);
  if (!entry.forwardingUnsub) {
    entry.forwardingUnsub = newSession.subscribe(makeEventForwarder(newId, newSession));
  }
  entry.unseen = false;
  entry.lastActivity = Date.now();

  broadcastSessionLoaded(newSession, requestId);
  if (previousSessionId && previousSessionId !== newId) {
    const previous = sessionPool.get(previousSessionId);
    if (previous) broadcastSessionRuntime(previousSessionId, previous);
  }
  broadcastSessionRuntime(newId, entry);
  broadcast({ type: 'commands_list', commands: extensionCommandsFor(newSession) });
  projectCatalog.apply({ kind: 'touch', path: newSession.sessionManager.getCwd() || cwd });
  scheduleSessionListRefresh();
}

// ── 5. Start server ───────────────────────────────────────────────────────────

const PORT = parseInt(Bun.env.PORT ?? '3000');

/** Bind address — localhost by default; set HOST=0.0.0.0 (or a LAN IP) only
 *  when remote access is intended. Remote exposure without TLS lets on-path
 *  attackers read the password and session cookie in plaintext. */
const HOSTNAME = Bun.env.HOST ?? '127.0.0.1';

/** Match svelte-adapter-bun's BODY_SIZE_LIMIT — bounds per-request memory on
 *  unauthenticated endpoints (e.g. /login form parsing) against the 128 MB
 *  Bun default. */
const MAX_REQUEST_BODY_BYTES = 512 * 1024;

/** Bun pub/sub topic shared by all connected WebSocket clients. */
const WS_TOPIC = 'pi';

/**
 * Browser hardening headers for every HTTP response. No CSP existed before;
 * its absence turned the markdown XSS into a full RCE chain. The app is
 * self-contained (assets from same origin; images may be remote https/http
 * or data: URIs for pasted pictures; the microphone is used for STT).
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: http: https:; " +
    "connect-src 'self' ws: wss:; " +
    "font-src 'self' data:; " +
    "object-src 'none'; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self'",
  'X-Frame-Options': 'DENY',
  // NOT 'no-referrer': Chromium suppresses the Origin header to `null` on
  // form navigations under that policy, which breaks the login action's
  // origin check. 'strict-origin-when-cross-origin' keeps full URLs
  // same-origin and sends only the origin cross-origin — same privacy win.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), payment=()',
};

/** Build the hardening headers; HSTS only when the request is TLS-terminated
 *  (browsers ignore it over plain HTTP, so the header cannot break HTTP
 *  access while still applying to HTTPS deployments). */
function securityHeaders(isTls: boolean): Headers {
  const headers = new Headers(SECURITY_HEADERS);
  if (isTls) headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return headers;
}

/** Per-connection WebSocket data. */
interface WSData {
  connectedAt: number;
  /** JWT expiry (seconds since epoch) — checked periodically to close expired sockets. */
  tokenExp: number;
  /** JTI of the session token — checked periodically and per message so a
   *  revoked (logged-out) token cannot keep driving an established socket. */
  jti?: string;
  /** Periodic expiry-check interval (60s), cleared on close. */
  _expTimer?: Timer;
  /** True once the close handler ran — guards the async open() against installing timers on a dead socket. */
  closed?: boolean;
}

let server: Server<WSData>;
try {
  server = Bun.serve<WSData>({
    port: PORT,
    hostname: HOSTNAME,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,

    async fetch(req, server) {
      const url = new URL(req.url);
      const isTls = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';

      if (url.pathname === '/ws') {
        const cookieHeader = req.headers.get('cookie') ?? '';
        if (!(await isValidSessionCookie(cookieHeader))) {
          return new Response('Unauthorized', { status: 401, headers: securityHeaders(isTls) });
        }
        // Origin validation — prevent cross-origin WebSocket hijacking.
        // SameSite=strict ignores ports, so even localhost origins must match
        // the Host header's port: a page served from another localhost port
        // would otherwise hijack the authenticated socket (CSWSH).
        // In dev (DEV_WS_ONLY) the page legitimately comes from the Vite dev
        // server (localhost:5173 by default) while /ws runs on 5174, so port
        // equality is relaxed there — the loopback hostname check below still
        // blocks foreign-origin hijacking.
        const origin = req.headers.get('origin');
        if (origin) {
          try {
            const originUrl = new URL(origin);
            const host = req.headers.get('host');
            if (host) {
              const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(originUrl.hostname);
              if (!DEV_WS_ONLY) {
                const hostPort = new URL(`${originUrl.protocol}//${host}`).port;
                if (originUrl.port !== hostPort) {
                  return new Response('Origin mismatch', {
                    status: 403,
                    headers: securityHeaders(isTls),
                  });
                }
              }
              if (!isLoopback && originUrl.host !== host) {
                return new Response('Origin mismatch', {
                  status: 403,
                  headers: securityHeaders(isTls),
                });
              }
            }
          } catch {
            return new Response('Invalid origin', { status: 400, headers: securityHeaders(isTls) });
          }
        }
        // Extract token identity for periodic revalidation (expiry + revocation).
        const token = getTokenFromCookies(cookieHeader) ?? '';
        const tokenExp = extractTokenExp(token) ?? Infinity;
        const jti = await extractJti(token);
        const ok = server.upgrade(req, { data: { connectedAt: Date.now(), tokenExp, jti } });
        if (ok) return undefined as unknown as Response;
        return new Response('WebSocket upgrade failed', {
          status: 400,
          headers: securityHeaders(isTls),
        });
      }

      const res = DEV_WS_ONLY
        ? new Response('Use Vite dev server for HTTP in dev mode', { status: 404 })
        : ((await (
            await getSvelteHandler()
          )(req, server)) as Response);
      // Merge hardening headers into the SvelteKit response. `new Headers(res.headers)`
      // copies the full list including Set-Cookie (the iterator may omit it).
      const headers = new Headers(res.headers);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        if (!headers.has(name)) headers.set(name, value);
      }
      if (isTls && !headers.has('Strict-Transport-Security')) {
        headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    },

    websocket: {
      async open(ws) {
        ws.subscribe(WS_TOPIC);
        connectedClients++;
        // A client reconnected — cancel the pending-request grace timer so existing
        // extension UI requests survive the disconnect.
        if (_pendingRequestsTimeout) {
          clearTimeout(_pendingRequestsTimeout);
          _pendingRequestsTimeout = null;
        }

        try {
          const sess = await ensureSession();
          const init = initialMessages(sess.messages, sess);
          // Non-blocking snapshot; background refresh pushes fresh list via
          // available_models_changed. Avoids stalling connected on provider
          // network round trips (each 15s timeout).
          const availableModels = snapshotModels(sess);
          // The client may have disconnected while the SDK/model snapshot loaded —
          // don't send to (or install a timer on) a dead socket.
          if (ws.data.closed) return;

          // Serialization/send of a pathological history must not kill the
          // connection — closing here would loop the client through reconnects.
          // Fall back to a payload without history; the client can load more.
          const sendConnected = (messages: unknown[], truncated: boolean) =>
            ws.send(
              JSON.stringify({
                type: 'connected',
                sessionId: sess.sessionId,
                isStreaming: sess.isStreaming,
                thinkingLevel: sess.thinkingLevel,
                model: serializeModel(sess.model),
                availableModels,
                messages,
                streamingMessage: streamingMessageForWire(sess),
                totalMessageCount: init.total,
                messagesTruncated: truncated,
                cwd: sess.sessionManager.getCwd() || cwd,
                sessionName: sess.sessionManager.getSessionName(),
                isCompacting: sess.isCompacting,
                autoCompactionEnabled: sess.autoCompactionEnabled,
                autoRetryEnabled: sess.autoRetryEnabled,
                queuedSteering: sess.getSteeringMessages(),
                queuedFollowUp: sess.getFollowUpMessages(),
                pushVapidKey: ensureVapidKeys().publicKey,
                piVersion: PI_SDK_VERSION,
                contextUsage: sess.getContextUsage(),
                projectTrust: projectTrustInfoFor(sess.sessionManager.getCwd() || cwd),
                diagnostics: sessionPool.get(sess.sessionId)?.diagnostics ?? [],
                modelFallbackMessage: sessionPool.get(sess.sessionId)?.modelFallbackMessage,
                webhookUrl: getWebhookUrl() || undefined,
                extensionUiState: extensionUiStateForSession(sess.sessionId),
                widgets: widgetsForSession(sess.sessionId),
                ...toolsPayloadFor(sess),
              })
            );
          try {
            sendConnected(init.msgs, init.truncated);
          } catch (err) {
            log.error(
              '[pifrontier] connected payload send failed — retrying without history:',
              err
            );
            sendConnected([], true);
          }

          // The session has already bound its extensions before connected is sent.
          // Read the live runner directly instead of reloading all resources here;
          // reload() was the source of the visible slash-command delay.
          try {
            ws.send(
              JSON.stringify({ type: 'commands_list', commands: extensionCommandsFor(sess) })
            );
          } catch (err) {
            log.error('[pifrontier] Failed to send extension commands:', err);
          }

          // Replay only ownerless requests and requests for the active
          // session. Replaying every pooled session's dialogs leaks stale UI
          // into the newly connected tab and duplicates modal queues.
          const replayBuckets: Array<[string | null, SessionUiState]> = [[null, ownerlessUiState]];
          const activeUi = uiStateBuckets.get(sess.sessionId);
          if (activeUi) replayBuckets.push([sess.sessionId, activeUi]);
          for (const [owner, ui] of replayBuckets) {
            for (const [id, pending] of ui.pendingDialogs) {
              ws.send(
                JSON.stringify({
                  type: 'extension_ui_request_replay',
                  id,
                  ...pending.requestPayload,
                  ...stampOwner(owner),
                })
              );
            }
          }

          // Send runtime snapshots only to the reconnecting socket. Publishing
          // each pooled session to every existing client makes one reconnect
          // cost O(pool × clients) and duplicates unchanged sidebar state.
          for (const [sid, entry] of sessionPool) {
            sendSessionRuntime(ws, sid, entry);
          }

          // Periodic token check (every 60s) — closes expired or revoked
          // sockets even when the client is idle.
          ws.data._expTimer = setInterval(() => {
            if (
              (ws.data.jti && isJtiRevoked(ws.data.jti)) ||
              Date.now() / 1000 > ws.data.tokenExp
            ) {
              clearInterval(ws.data._expTimer!);
              try {
                ws.close(4001, 'Session expired');
              } catch {
                /* already closed */
              }
            }
          }, 60_000);
        } catch (err) {
          log.error('[pifrontier] Failed to initialise session for new client:', err);
          try {
            ws.close(1011, 'Session initialisation failed');
          } catch {
            /* ws may already be closed */
          }
        }
      },

      async message(ws, raw) {
        // Per-message auth revalidation — close sockets whose token expired or
        // was revoked (logged out) so they cannot continue using the socket.
        const wsData = ws.data as WSData;
        if (
          (wsData.jti && isJtiRevoked(wsData.jti)) ||
          (wsData.tokenExp && Date.now() / 1000 > wsData.tokenExp)
        ) {
          try {
            ws.close(4001, 'Session expired');
          } catch {
            /* already closed */
          }
          return;
        }

        let msg: ClientMessage;
        try {
          msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
        } catch {
          return;
        }

        try {
          switch (msg.type) {
            case 'prompt': {
              try {
                const s = activeSession();
                const imageContent = msg.images?.length
                  ? msg.images.map((img) => ({
                      type: 'image' as const,
                      data: img.data,
                      mimeType: img.mimeType,
                    }))
                  : undefined;
                const options = {
                  ...(imageContent ? { images: imageContent } : {}),
                  ...(s.isStreaming && msg.streamingBehavior
                    ? { streamingBehavior: msg.streamingBehavior }
                    : {}),
                } satisfies Parameters<AgentSession['prompt']>[1];
                if (s.isStreaming && !msg.streamingBehavior) {
                  ws.send(
                    JSON.stringify({
                      type: 'agent_error',
                      error: 'Streaming input requires a steer or follow-up mode.',
                    })
                  );
                  break;
                }
                if (_promptsInFlight.has(s.sessionId) && !s.isStreaming) {
                  ws.send(
                    JSON.stringify({
                      type: 'agent_error',
                      error: 'Prompt already in progress on another tab.',
                    })
                  );
                  break;
                }
                _promptsInFlight.add(s.sessionId);
                try {
                  await s.prompt(msg.message, options);
                } finally {
                  _promptsInFlight.delete(s.sessionId);
                }
              } catch (err) {
                log.error('[pifrontier] prompt error:', err);
                ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
              }
              break;
            }

            case 'steer': {
              try {
                const s = activeSession();
                const images = msg.images?.map((img) => ({
                  type: 'image' as const,
                  data: img.data,
                  mimeType: img.mimeType,
                }));
                if (s.isStreaming || _promptsInFlight.has(s.sessionId)) {
                  await s.steer(msg.message, images);
                } else {
                  _promptsInFlight.add(s.sessionId);
                  try {
                    await s.prompt(msg.message, images ? { images } : undefined);
                  } finally {
                    _promptsInFlight.delete(s.sessionId);
                  }
                }
              } catch (err) {
                log.error('[pifrontier] steer error:', err);
                ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
              }
              break;
            }

            case 'follow_up': {
              try {
                const s = activeSession();
                const images = msg.images?.map((img) => ({
                  type: 'image' as const,
                  data: img.data,
                  mimeType: img.mimeType,
                }));
                if (s.isStreaming) {
                  await s.followUp(msg.message, images);
                } else {
                  _promptsInFlight.add(s.sessionId);
                  try {
                    await s.prompt(msg.message, images ? { images } : undefined);
                  } finally {
                    _promptsInFlight.delete(s.sessionId);
                  }
                }
              } catch (err) {
                log.error('[pifrontier] followUp error:', err);
                ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
              }
              break;
            }

            case 'abort': {
              const s = activeSession();
              // Clear queued steering/follow-up messages before abort so they
              // don't continue processing after the abort takes effect.
              const cleared = s.clearQueue();
              s.abortBash();
              await s.abort();
              // Restore any queued text to the requesting tab's composer so the
              // user can re-submit it.
              const allQueued = [...cleared.steering, ...cleared.followUp];
              if (allQueued.length > 0) {
                ws.send(
                  JSON.stringify({
                    type: 'queue_restored',
                    text: allQueued.join('\n\n'),
                  })
                );
              }
              break;
            }

            case 'set_thinking_level':
              activeSession().setThinkingLevel(
                msg.level as Parameters<AgentSession['setThinkingLevel']>[0]
              );
              break;

            case 'set_model': {
              const model = activeSession().modelRuntime.getModel(msg.provider, msg.modelId);
              if (!model) {
                log.warn(`[pifrontier] set_model: model not found: ${msg.provider}/${msg.modelId}`);
                break;
              }
              try {
                await activeSession().setModel(model);
                broadcast({ type: 'model_changed', model: serializeModel(model) });
              } catch (err) {
                log.error('[pifrontier] set_model error:', err);
              }
              break;
            }

            case 'new_session': {
              const requestId = msg.requestId;
              await withSessionMutationLock(async () => {
                try {
                  const rawTargetCwd =
                    (msg as { type: 'new_session'; targetCwd?: string }).targetCwd ?? cwd;
                  const targetCwd = resolve(expandTilde(rawTargetCwd));
                  // Create the directory if it doesn't exist (brand new folder).
                  await mkdir(targetCwd, { recursive: true });
                  const sm = _sdk!.SessionManager.create(targetCwd);
                  const created = await createSdkSession(
                    targetCwd,
                    sm,
                    'new',
                    activeSessionOrNull()?.sessionFile
                  );
                  await setActiveSession(created.session, targetCwd, created, requestId);
                } catch (err) {
                  log.error('[pifrontier] new_session error:', err);
                  ws.send(
                    JSON.stringify({ type: 'sessions_error', requestId, message: String(err) })
                  );
                }
              });
              break;
            }

            case 'switch_session': {
              const requestId = msg.requestId;
              await withSessionMutationLock(async () => {
                try {
                  // If the user selects the current session path, we proceed anyway to refresh client state.
                  const resolvedPath = resolve(cwd, expandTilde(msg.path));
                  // Check pool first — reuse live session if already loaded
                  const existing = findManagedSessionByPath(resolvedPath);
                  if (existing) {
                    await setActiveSession(existing.session, existing.cwd, undefined, requestId);
                    return;
                  }
                  // Security: only open known session files — never raw client paths.
                  // Cache-miss falls back to a targeted stat of the exact file — a
                  // session created moments ago (e.g. by the pi TUI) must not be
                  // rejected on a stale cache, but validating it must not re-scan
                  // the whole store either (seconds of lag on large stores).
                  const knownSessions = await sessionCatalog.list();
                  if (
                    !knownSessions.some((s) => s.path === resolvedPath) &&
                    !(await sessionCatalog.hasFile(resolvedPath))
                  ) {
                    ws.send(
                      JSON.stringify({
                        type: 'sessions_error',
                        requestId,
                        message: 'Session not found.',
                      })
                    );
                    return;
                  }
                  const sm = _sdk!.SessionManager.open(resolvedPath);
                  const created = await createSdkSession(
                    sm.getCwd() || cwd,
                    sm,
                    'resume',
                    activeSessionOrNull()?.sessionFile
                  );
                  await setActiveSession(created.session, sm.getCwd() || cwd, created, requestId);
                } catch (err) {
                  log.error('[pifrontier] switch_session error:', err);
                  ws.send(
                    JSON.stringify({ type: 'sessions_error', requestId, message: String(err) })
                  );
                }
              });
              break;
            }
            case 'extension_ui_response': {
              const owner = pendingRequestOwners.get(msg.id) ?? null;
              const pending = existingUiStateFor(owner)?.pendingDialogs.get(msg.id);
              if (pending) {
                pending.resolve(msg as unknown as Record<string, unknown>);
              }
              break;
            }

            case 'dismiss_widget': {
              const key = msg.key as string | undefined;
              if (!key) break;
              const owner = widgetOwnerFor(key);
              if (owner === undefined) break;
              teardownWidget(key, owner);
              break;
            }

            case 'extension_custom_input': {
              const customId = msg.id as string | undefined;
              const data = msg.data as string | undefined;
              if (!customId || data === undefined) break;
              const owner = pendingRequestOwners.get(customId) ?? null;
              const ui = existingUiStateFor(owner);
              const component = ui?.interactiveCustomComponents.get(customId);
              if (!component) break;
              try {
                // `data` is the raw terminal byte sequence the browser encoded for
                // this keystroke/paste (see src/lib/terminal-key-encoder.ts) — pass
                // it straight through, exactly as real stdin would deliver it.
                if (typeof component.handleInput === 'function') {
                  component.handleInput(data);
                }
                flushInteractiveRender(customId);
              } catch (err) {
                log.error('[pifrontier] extension_custom_input error:', err);
              }
              break;
            }
            case 'extension_custom_resize': {
              const resizeId = msg.id as string | undefined;
              if (!resizeId) break;
              const owner = pendingRequestOwners.get(resizeId) ?? null;
              const tui = existingUiStateFor(owner)?.interactiveCustomComponents.get(resizeId);
              if (!tui?.terminal?.setSize) break;
              const columns = typeof msg.columns === 'number' ? msg.columns : 80;
              const rows = typeof msg.rows === 'number' ? msg.rows : 24;
              tui.terminal.setSize(columns, rows);
              break;
            }
            case 'extension_terminal_input': {
              const inputId = msg.id as string | undefined;
              const data = msg.data as string | undefined;
              if (!inputId || typeof data !== 'string') break;
              const owner = (msg.sessionId as string | undefined) || activeSessionId || null;
              const verdict = terminalInputRegistry.dispatch(owner, data);
              broadcast({
                type: 'extension_terminal_input_result',
                id: inputId,
                consumed: verdict.consumed,
                ...(verdict.data !== undefined ? { data: verdict.data } : {}),
                ...stampOwner(owner),
              });
              break;
            }

            case 'extension_editor_text_change': {
              const text = msg.text as string | undefined;
              if (typeof text !== 'string') break;
              const owner = (msg.sessionId as string | undefined) || activeSessionId || null;
              uiStateFor(owner).editorText = text;
              break;
            }

            case 'extension_component_event': {
              const dialogId = msg.id as string | undefined;
              if (!dialogId) break;
              const path = (msg.path as number[] | undefined) ?? [];
              const event = msg.event as string;
              const value = msg.value as string | undefined;
              const owner = pendingRequestOwners.get(dialogId) ?? null;
              const dlg = existingUiStateFor(owner)?.activeCustomDialogs.get(dialogId);
              const node = dlg?.nodeMap.get(path.join('.'));
              let handled = false;
              try {
                if (node) {
                  if (
                    event === 'select' &&
                    Array.isArray(node.items) &&
                    typeof node.onSelect === 'function'
                  ) {
                    const item = (node.items as Array<{ value: string }>).find(
                      (i) => i.value === value
                    );
                    if (item) {
                      (node.onSelect as (i: unknown) => void)(item);
                      handled = true;
                    }
                  } else if (event === 'click' && typeof node.onClick === 'function') {
                    (node.onClick as () => void)();
                    handled = true;
                  } else if (event === 'toggle' && typeof node.onToggle === 'function') {
                    (node.onToggle as (v: boolean) => void)(!node.checked);
                    handled = true;
                  } else if (event === 'submit') {
                    if (typeof node.setValue === 'function')
                      (node.setValue as (v: string) => void)(value ?? '');
                    if (typeof node.onSubmit === 'function') {
                      (node.onSubmit as (v: string) => void)(value ?? '');
                      handled = true;
                    }
                  } else if (event === 'setting' && typeof node.updateValue === 'function') {
                    const sepIdx = (value ?? '').indexOf('::');
                    if (sepIdx !== -1) {
                      (node.updateValue as (settingId: string, v: string) => void)(
                        (value as string).slice(0, sepIdx),
                        (value as string).slice(sepIdx + 2)
                      );
                      handled = true;
                    }
                  }
                }
                if (handled && dlg) {
                  // Re-parse and only broadcast if the tree actually changed —
                  // avoids redundant traffic when the callback is a pure no-op.
                  const reparsed = parseComponentTree(dlg.root, 80, [], dlg.nodeMap);
                  const json = JSON.stringify(reparsed);
                  if (json !== dlg.lastParsedJson) {
                    dlg.lastParsedJson = json;
                    broadcast({
                      type: 'extension_ui_update',
                      id: dialogId,
                      parsed: reparsed,
                      ...stampOwner(owner),
                    });
                    const ui = existingUiStateFor(pendingRequestOwners.get(dialogId) ?? null);
                    const pending = ui?.pendingDialogs.get(dialogId);
                    if (pending) pending.requestPayload.parsed = reparsed;
                  }
                } else if (!handled) {
                  // No live callback on this node (static tree, or a component
                  // the extension built without wiring a callback) — fall back
                  // to resolving the dialog directly with the raw value, same
                  // as before callback bridging existed.
                  const ui = existingUiStateFor(pendingRequestOwners.get(dialogId) ?? null);
                  const pending = ui?.pendingDialogs.get(dialogId);
                  if (pending) pending.resolve({ value });
                }
              } catch (err) {
                log.error('[pifrontier] extension_component_event error:', err);
              }
              break;
            }

            case 'get_providers': {
              // Panel fetches can arrive as soon as the socket opens — before
              // `connected`. Wait for session creation (including any pending
              // project-trust prompt) instead of throwing "No active session".
              const sess = await ensureSession();
              ws.send(
                JSON.stringify({
                  type: 'providers_list',
                  providers: await getProviders(sess.modelRuntime),
                })
              );
              break;
            }

            case 'set_provider_key': {
              try {
                await mutateProviderAuth(msg.provider, (runtime) =>
                  persistProviderApiKey(runtime, msg.provider, msg.key)
                );
              } catch (err) {
                log.error('[pifrontier] set_provider_key error:', err);
                ws.send(JSON.stringify({ type: 'providers_error', message: String(err) }));
              }
              break;
            }
            case 'remove_provider_key': {
              try {
                await mutateProviderAuth(msg.provider, (runtime) => runtime.logout(msg.provider));
              } catch (err) {
                log.error('[pifrontier] remove_provider_key error:', err);
                ws.send(JSON.stringify({ type: 'providers_error', message: String(err) }));
              }
              break;
            }

            case 'rename_session': {
              try {
                // Security: only accept paths of known sessions — never trust raw user paths.
                // (Session files live under ~/.pi, outside cwd, so containment checks don't apply.)
                const known = await sessionCatalog.list();
                const target = known.find((s) => s.path === msg.path);
                if (!target) {
                  ws.send(
                    JSON.stringify({ type: 'sessions_error', message: 'Session not found.' })
                  );
                  break;
                }
                const sm = _sdk!.SessionManager.open(target.path);
                sm.appendSessionInfo(msg.name);
                // Patch the overlay (if pooled) and force the next scan to
                // re-parse that one file; onChange broadcasts the new list.
                sessionCatalog.apply({ kind: 'rename', path: msg.path, name: msg.name });
                // If renaming the active session, also fire the SDK event so all
                // connected browsers see the name change via session_info_changed.
                if (msg.path === activeSession().sessionFile) {
                  activeSession().setSessionName(msg.name);
                }
                ws.send(JSON.stringify({ type: 'sessions_list', sessions: [] }));
              } catch (err) {
                log.error('[pifrontier] rename_session error:', err);
                ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
              }
              break;
            }

            case 'delete_session': {
              try {
                // Validate the path is a known session file — never trust raw user paths.
                // list() because the sidebar offers deletion across all projects.
                const list = await sessionCatalog.list();
                const target = list.find((s) => s.path === msg.path);
                if (!target) {
                  ws.send(
                    JSON.stringify({ type: 'sessions_error', message: 'Session not found.' })
                  );
                  break;
                }
                if (target.id === activeSession().sessionId) {
                  ws.send(
                    JSON.stringify({
                      type: 'sessions_error',
                      message: 'Cannot delete the active session.',
                    })
                  );
                  break;
                }
                // Path came from the scan/catalog — already validated.
                await rm(target.path);

                // Clean up pooled session (if still in memory) to prevent leaks
                const pooled = sessionPool.get(target.id);
                if (pooled) {
                  cancelNavOutDisposal(pooled);
                  pooled.forwardingUnsub?.();
                  pooled.runtimeUnsub?.();
                  try {
                    pooled.session.dispose();
                  } catch {
                    /* session may have already been disposed */
                  }
                  sessionPool.delete(target.id);
                  if (pooled.path) pathToSessionId.delete(pooled.path);
                }
                // Drop the overlay entry and force the next scan; onChange
                // broadcasts the new list (sidebar + projects).
                sessionCatalog.apply({ kind: 'remove', path: target.path });
                ws.send(JSON.stringify({ type: 'sessions_list', sessions: [] }));
              } catch (err) {
                log.error('[pifrontier] delete_session error:', err);
                ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
              }
              break;
            }

            case 'get_all_sessions': {
              try {
                // The active session is pooled, so the overlay guarantees it
                // is in the merged list — no manual prepend needed.
                const all = await sessionCatalog.list();
                const sessions = all.map(serializeSession);
                ws.send(JSON.stringify({ type: 'all_sessions_list', sessions }));
              } catch (err) {
                log.error('[pifrontier] get_all_sessions error:', err);
                ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
              }
              break;
            }

            case 'get_projects': {
              ws.send(
                JSON.stringify({ type: 'projects_list', projects: await projectCatalog.list() })
              );
              break;
            }

            case 'add_project': {
              try {
                const raw = (msg as { type: 'add_project'; path: string }).path ?? '';
                if (!raw.trim() || raw.includes('\0')) {
                  ws.send(
                    JSON.stringify({ type: 'sessions_error', message: 'Invalid project path.' })
                  );
                  break;
                }
                const target = resolve(expandTilde(raw.trim()));
                // Same trust level as new_session: create the folder if it's brand new.
                await mkdir(target, { recursive: true });
                projectCatalog.apply({ kind: 'touch', path: target });
              } catch (err) {
                log.error('[pifrontier] add_project error:', err);
                ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
              }
              break;
            }

            case 'remove_project': {
              const target = (msg as { type: 'remove_project'; cwd: string }).cwd ?? '';
              if (target === (activeSessionOrNull()?.sessionManager.getCwd() || cwd)) {
                ws.send(
                  JSON.stringify({
                    type: 'sessions_error',
                    message: 'Cannot forget the active project.',
                  })
                );
                break;
              }
              projectCatalog.apply({ kind: 'remove', path: target });
              break;
            }

            case 'pin_project': {
              const { cwd: target, pinned } = msg as {
                type: 'pin_project';
                cwd: string;
                pinned: boolean;
              };
              if (typeof target === 'string' && target.trim()) {
                projectCatalog.apply({ kind: 'setPinned', path: target, pinned: Boolean(pinned) });
              }
              break;
            }

            case 'rename_project': {
              const { cwd: target, name } = msg as {
                type: 'rename_project';
                cwd: string;
                name: string;
              };
              if (typeof target === 'string' && target.trim()) {
                projectCatalog.apply({
                  kind: 'rename',
                  path: target,
                  name: typeof name === 'string' ? name : '',
                });
              }
              break;
            }

            case 'dir_complete': {
              try {
                const prefix = expandTilde(
                  (msg as { type: 'dir_complete'; prefix: string }).prefix
                );
                const isDir = prefix.endsWith('/');
                const dir = isDir ? prefix : dirname(prefix);
                const resolvedDir = resolve(dir);
                const fragment = isDir ? '' : basename(prefix).toLowerCase();
                const cacheKey = `${resolvedDir}\u0000${dir}\u0000${fragment}`;
                const cachedHit = dirCompleteCache.get(cacheKey);
                if (cachedHit && Date.now() - cachedHit.at < DIR_COMPLETE_TTL_MS) {
                  ws.send(
                    JSON.stringify({ type: 'dir_completions', prefix, entries: cachedHit.entries })
                  );
                  break;
                }
                let entries: string[] = [];
                try {
                  const dirents = await readdir(resolvedDir, { withFileTypes: true });
                  entries = dirents
                    .filter(
                      (d) =>
                        d.isDirectory() &&
                        (fragment === '' || d.name.toLowerCase().startsWith(fragment))
                    )
                    .map((d) => join(dir, d.name) + '/')
                    .slice(0, 20);
                } catch {
                  entries = [];
                }
                dirCompleteCache.set(cacheKey, { at: Date.now(), entries });
                if (dirCompleteCache.size > DIR_COMPLETE_CACHE_MAX) {
                  let oldestKey: string | null = null;
                  let oldestAt = Infinity;
                  for (const [key, value] of dirCompleteCache) {
                    if (value.at < oldestAt) {
                      oldestAt = value.at;
                      oldestKey = key;
                    }
                  }
                  if (oldestKey) dirCompleteCache.delete(oldestKey);
                }
                ws.send(JSON.stringify({ type: 'dir_completions', prefix, entries }));
              } catch (err) {
                log.error('[pifrontier] dir_complete error:', err);
              }
              break;
            }

            case 'file_complete': {
              try {
                const query = (
                  (msg as { type: 'file_complete'; query: string }).query ?? ''
                ).toLowerCase();
                const root = activeSession().sessionManager.getCwd() || cwd;
                // Per-prefix cache — the client re-sends the same query while
                // typing/backspacing, and a depth-3 walk per keystroke is
                // wasted I/O on large repos. 5 s TTL keeps results fresh enough
                // for completion; the cache is bounded and evicts oldest-first.
                const cacheKey = `${root}\u0000${query}`;
                const cachedHit = fileCompleteCache.get(cacheKey);
                if (cachedHit && Date.now() - cachedHit.at < FILE_COMPLETE_TTL_MS) {
                  ws.send(
                    JSON.stringify({ type: 'file_completions', query, entries: cachedHit.entries })
                  );
                  break;
                }
                const entries: string[] = [];
                const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

                while (queue.length > 0 && entries.length < 40) {
                  const item = queue.shift()!;
                  let dirents: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
                  try {
                    dirents = (await readdir(item.dir, { withFileTypes: true })) as typeof dirents;
                  } catch {
                    continue;
                  }

                  for (const dirent of dirents) {
                    if (dirent.name.startsWith('.') && dirent.name !== '.env') continue;
                    if (SKIP_DIRS.has(dirent.name)) continue;
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

                // Store (bounded, oldest-evicted) so retypes hit the cache.
                fileCompleteCache.set(cacheKey, { at: Date.now(), entries });
                if (fileCompleteCache.size > FILE_COMPLETE_CACHE_MAX) {
                  let oldestKey: string | null = null;
                  let oldestAt = Infinity;
                  for (const [k, v] of fileCompleteCache) {
                    if (v.at < oldestAt) {
                      oldestAt = v.at;
                      oldestKey = k;
                    }
                  }
                  if (oldestKey) fileCompleteCache.delete(oldestKey);
                }
                ws.send(JSON.stringify({ type: 'file_completions', query, entries }));
              } catch (err) {
                log.error('[pifrontier] file_complete error:', err);
                ws.send(JSON.stringify({ type: 'file_completions', query: '', entries: [] }));
              }
              break;
            }
            case 'get_extension_autocomplete': {
              let timeoutId: Timer | undefined;
              try {
                const { trigger, query } = msg as {
                  type: 'get_extension_autocomplete';
                  trigger: string;
                  query: string;
                };
                const provider = activeSessionId ? autocompleteProviderFor(activeSessionId) : null;
                if (!provider) {
                  ws.send(
                    JSON.stringify({ type: 'extension_completions', trigger, query, items: [] })
                  );
                  break;
                }
                const inputText = `${trigger}${query ?? ''}`;
                const controller = new AbortController();
                timeoutId = setTimeout(() => controller.abort(), 2000);
                const result = await provider.getSuggestions([inputText], 0, inputText.length, {
                  signal: controller.signal,
                });
                ws.send(
                  JSON.stringify({
                    type: 'extension_completions',
                    trigger,
                    query,
                    items: result?.items ?? [],
                  })
                );
              } catch (err) {
                log.error('[pifrontier] get_extension_autocomplete error:', err);
                const { trigger = '', query = '' } = msg as {
                  trigger?: string;
                  query?: string;
                };
                ws.send(
                  JSON.stringify({ type: 'extension_completions', trigger, query, items: [] })
                );
              } finally {
                clearTimeout(timeoutId);
              }
              break;
            }

            case 'compact': {
              const sess = activeSession();
              if (sess.isStreaming) {
                sendSlashResult(
                  ws,
                  'compact',
                  'Wait for the agent to finish before compacting.',
                  'warning'
                );
                break;
              }
              if (sess.isCompacting) {
                sendSlashResult(ws, 'compact', 'Compaction is already in progress.', 'warning');
                break;
              }
              // The SDK's compaction watchdog (see compaction-watchdog.ts) bounds
              // this call: a wedged compaction is aborted after COMPACTION_TIMEOUT_MS
              // and the client spinner is sealed with a synthetic compaction_end.
              const t0 = Date.now();
              sess
                .compact()
                .then((result) => {
                  log.info(
                    `[pifrontier] compact: finished in ${Date.now() - t0}ms` +
                      `${result ? ` (tokensBefore=${result.tokensBefore}, after=${result.estimatedTokensAfter})` : ''}`
                  );
                })
                .catch((err) => {
                  log.error(`[pifrontier] compact error after ${Date.now() - t0}ms:`, err);
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
              const command = String(
                (msg as { type: 'run_builtin'; command: string; args?: string }).command ?? ''
              ).toLowerCase();
              const args = String(
                (msg as { type: 'run_builtin'; command: string; args?: string }).args ?? ''
              ).trim();
              // These mutate live session/agent state (context, tools/prompts,
              // model auth, branch files) in ways that can race an in-flight
              // turn — block them while streaming instead of letting them run
              // concurrently with agent.prompt(). Read-only/independent commands
              // (session, export, share, changelog, name, tree, shell, extension
              // commands) are unaffected and stay allowed mid-stream.
              if (
                ['reload', 'clone', 'login', 'logout'].includes(command) &&
                activeSession().isStreaming
              ) {
                sendSlashResult(
                  ws,
                  command,
                  'Wait for the agent to finish before running this command.',
                  'warning'
                );
                break;
              }
              try {
                switch (command) {
                  case 'reload': {
                    // Extensions re-run their factories inside reload() and
                    // register fresh onTerminalInput handlers. The old
                    // factories' handlers are never unsubscribed (the SDK
                    // provides no reload hook to us), so drop them now —
                    // mirroring pi-tui, which clears its terminal listeners on
                    // session shutdown before re-registering on session_start.
                    // Keystrokes during the reload window fall back to native
                    // composer behavior, and the re-registration broadcasts
                    // active:true again.
                    const reloadSid = activeSessionId ?? null;
                    if (reloadSid && terminalInputRegistry.has(reloadSid)) {
                      terminalInputRegistry.clear(reloadSid);
                      broadcast({
                        type: 'extension_terminal_input_active',
                        active: false,
                        ...stampOwner(reloadSid),
                      });
                    }
                    await activeSession().reload();
                    sendSlashResult(
                      ws,
                      command,
                      'Reloaded extensions, skills, prompts, and tools.'
                    );
                    ws.send(
                      JSON.stringify({
                        type: 'tools_list',
                        tools: activeSession()
                          .getAllTools()
                          .map((t) => ({
                            name: t.name,
                            description: t.description,
                            isBuiltin: t.sourceInfo.source === 'builtin',
                            origin: t.sourceInfo.source,
                          })),
                        activeToolNames: activeSession().getActiveToolNames(),
                      })
                    );
                    ws.send(
                      JSON.stringify({
                        type: 'commands_list',
                        commands: extensionCommandsFor(activeSession()),
                      })
                    );
                    break;
                  }
                  case 'login': {
                    const runtime = activeSession().modelRuntime;
                    const providerInfos = await getProviders(runtime);
                    const providerRef = args?.trim().toLowerCase();
                    const loginCandidates = runtime.getProviders().filter((provider) => {
                      if (!provider.auth.oauth && !provider.auth.apiKey) return false;
                      if (providerRef) {
                        return (
                          provider.id.toLowerCase() === providerRef ||
                          provider.name.toLowerCase() === providerRef
                        );
                      }
                      const info = providerInfos.find((candidate) => candidate.id === provider.id);
                      return !info?.configured;
                    });

                    if (loginCandidates.length === 0) {
                      sendSlashResult(
                        ws,
                        command,
                        providerRef
                          ? `Unknown provider or no login method: ${args}`
                          : 'All providers are already configured.',
                        providerRef ? 'error' : 'info'
                      );
                      break;
                    }

                    let loginProvider = loginCandidates[0];
                    if (!providerRef) {
                      const labels = loginCandidates.map(
                        (provider) => `${provider.name} (${provider.id})`
                      );
                      const selected = await uiContext.select(
                        'Select a provider to log in',
                        labels,
                        undefined,
                        activeSessionId
                      );
                      if (!selected) break;
                      const index = labels.indexOf(selected);
                      if (index === -1) break;
                      loginProvider = loginCandidates[index];
                    }

                    const authChoices: Array<{ type: 'oauth' | 'api_key'; label: string }> = [];
                    if (loginProvider.auth.oauth) {
                      authChoices.push({
                        type: 'oauth',
                        label: loginProvider.auth.oauth.loginLabel ?? 'Sign in with account',
                      });
                    }
                    if (loginProvider.auth.apiKey) {
                      authChoices.push({ type: 'api_key', label: 'Sign in with API key' });
                    }
                    if (authChoices.length === 0) break;

                    let authType = authChoices[0].type;
                    if (authChoices.length > 1) {
                      const selected = await uiContext.select(
                        `Select authentication method for ${loginProvider.name}`,
                        authChoices.map((choice) => choice.label),
                        undefined,
                        activeSessionId
                      );
                      if (!selected) break;
                      const choice = authChoices.find((candidate) => candidate.label === selected);
                      if (!choice) break;
                      authType = choice.type;
                    }

                    if (authType === 'api_key' && !loginProvider.auth.apiKey?.login) {
                      sendSlashResult(
                        ws,
                        command,
                        `${loginProvider.name} is configured outside pi.`,
                        'warning'
                      );
                      break;
                    }

                    try {
                      await mutateProviderAuth(loginProvider.id, (providerRuntime) =>
                        providerRuntime
                          .login(
                            loginProvider.id,
                            authType,
                            browserAuthInteraction(activeSessionId)
                          )
                          .then(() => undefined)
                      );
                      sendSlashResult(ws, command, `Logged in to ${loginProvider.name}.`);
                    } catch (err) {
                      sendSlashResult(ws, command, String(err), 'error');
                    }
                    break;
                  }
                  case 'logout': {
                    const providerRef = args?.trim();
                    const runtime = activeSession().modelRuntime;
                    const provider = providerRef || activeSession().model?.provider;
                    if (!provider) {
                      sendSlashResult(
                        ws,
                        command,
                        'No provider selected. Pass a provider name, e.g. /logout openai.',
                        'warning'
                      );
                      break;
                    }
                    const providerDefinition = runtime
                      .getProviders()
                      .find(
                        (candidate) =>
                          candidate.id.toLowerCase() === provider.toLowerCase() ||
                          candidate.name.toLowerCase() === provider.toLowerCase()
                      );
                    const providerId = providerDefinition?.id ?? provider;
                    try {
                      await mutateProviderAuth(providerId, (providerRuntime) =>
                        providerRuntime.logout(providerId)
                      );
                      sendSlashResult(ws, command, `Removed stored credentials for ${providerId}.`);
                    } catch (err) {
                      sendSlashResult(ws, command, String(err), 'error');
                    }
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
                        modelRuntime: activeSession().modelRuntime,
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
                      modelRuntime: activeSession().modelRuntime,
                      model: activeSession().model,
                    });
                    await setActiveSession(clonedSession);
                    sendSlashResult(ws, command, `Cloned current branch to ${newPath}.`);
                    break;
                  }
                  case 'tree': {
                    const tree = activeSession().sessionManager.getTree();
                    const lines = tree.flatMap((node) =>
                      formatTreeNode(node as Parameters<typeof formatTreeNode>[0])
                    );
                    sendSlashResult(
                      ws,
                      command,
                      lines.length ? `Session tree:\n${lines.join('\n')}` : 'Session tree is empty.'
                    );
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
                      ...(context
                        ? [
                            `Context: ${context.tokens == null ? 'unknown' : context.tokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens${context.percent == null ? '' : ` (${context.percent}%)`}`,
                          ]
                        : []),
                    ];
                    sendSlashResult(ws, command, lines.join('\n'));
                    break;
                  }
                  case 'export': {
                    const format = args.toLowerCase().includes('json') ? 'jsonl' : 'html';
                    const out =
                      format === 'jsonl'
                        ? activeSession().exportToJsonl()
                        : await activeSession().exportToHtml();
                    sendSlashResult(ws, command, `Exported current session to ${out}.`);
                    break;
                  }
                  case 'share': {
                    const out = await activeSession().exportToHtml();
                    sendSlashResult(
                      ws,
                      command,
                      `Created a local share/export at ${out}. GitHub gist sharing is not configured in pi-ui.`
                    );
                    break;
                  }
                  case 'changelog': {
                    const { readFile } = await import('node:fs/promises');
                    const text = await readFile(
                      join(
                        process.cwd(),
                        'node_modules/@earendil-works/pi-coding-agent/CHANGELOG.md'
                      ),
                      'utf8'
                    );
                    sendSlashResult(ws, command, text.split('\n').slice(0, 80).join('\n'));
                    break;
                  }
                  case 'name': {
                    if (!args) {
                      sendSlashResult(
                        ws,
                        command,
                        activeSession().sessionName
                          ? `Session name: ${activeSession().sessionName}`
                          : 'No session name set.'
                      );
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
                    try {
                      const sess = activeSession();
                      const result = await sess.executeBash(
                        args,
                        (chunk) =>
                          broadcast({
                            type: 'bash_execution_update',
                            id: `shell-${sess.sessionId}`,
                            delta: chunk,
                            sessionId: sess.sessionId,
                          }),
                        { id: `shell-${sess.sessionId}`, excludeFromContext: false }
                      );
                      const output = result.output.trim() || '(no output)';
                      sendSlashResult(
                        ws,
                        command,
                        output +
                          (result.truncated ? '\n… (output truncated)' : '') +
                          (result.cancelled
                            ? '\n(process cancelled)'
                            : result.exitCode !== undefined && result.exitCode !== 0
                              ? `\nexit code: ${result.exitCode}`
                              : ''),
                        result.cancelled || (result.exitCode !== undefined && result.exitCode !== 0)
                          ? 'error'
                          : 'info'
                      );
                    } catch (err) {
                      log.error('[pifrontier] shell error:', err);
                      sendSlashResult(ws, command, String(err), 'error');
                    }
                    break;
                  }
                  case 'extension':
                    // Extension commands — route through prompt() which handles them via _tryExecuteExtensionCommand
                    // Use prompt() even during streaming (SDK handles extension commands during streaming)
                    try {
                      await activeSession().prompt(args);
                    } catch (e) {
                      sendSlashResult(ws, command, String(e), 'error');
                    }
                    break;
                  default:
                    sendSlashResult(
                      ws,
                      command,
                      `Unsupported built-in command: /${command}`,
                      'warning'
                    );
                    break;
                }
              } catch (err) {
                log.error(`[pifrontier] run_builtin ${command} error:`, err);
                sendSlashResult(ws, command, String(err), 'error');
              }
              break;
            }

            case 'get_session_stats': {
              try {
                ws.send(
                  JSON.stringify({
                    type: 'session_stats',
                    stats: (await ensureSession()).getSessionStats(),
                  })
                );
              } catch (err) {
                log.error('[pifrontier] get_session_stats error:', err);
                ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
              }
              break;
            }

            case 'export_session': {
              try {
                const session = activeSession();
                const path =
                  msg.format === 'html' ? await session.exportToHtml() : session.exportToJsonl();
                ws.send(JSON.stringify({ type: 'export_result', format: msg.format, path }));
              } catch (err) {
                log.error('[pifrontier] export_session error:', err);
                ws.send(
                  JSON.stringify({ type: 'export_result', format: msg.format, error: String(err) })
                );
              }
              break;
            }

            case 'get_session_tree': {
              try {
                const tree = activeSession().sessionManager.getTree();
                const serialized = tree.map((node) =>
                  serializeTreeNode(node as Parameters<typeof serializeTreeNode>[0])
                );
                ws.send(JSON.stringify({ type: 'session_tree', tree: serialized }));
              } catch (err) {
                log.error('[pifrontier] get_session_tree error:', err);
                ws.send(JSON.stringify({ type: 'session_tree', tree: [] }));
              }
              break;
            }

            case 'get_fork_points': {
              try {
                const entries = activeSession().getUserMessagesForForking();
                ws.send(JSON.stringify({ type: 'fork_points', entries }));
              } catch (err) {
                log.error('[pifrontier] get_fork_points error:', err);
                ws.send(JSON.stringify({ type: 'fork_points', entries: [] }));
              }
              break;
            }

            case 'get_tools': {
              try {
                const t0 = Date.now();
                const sess = activeSessionOrNull();
                if (!sess) {
                  ws.send(JSON.stringify({ type: 'tools_list', tools: [], activeToolNames: [] }));
                  break;
                }
                const payload = toolsPayloadFor(sess);
                const dt = Date.now() - t0;
                if (dt > 50)
                  log.info(
                    `[pifrontier] get_tools serialize ${dt}ms for ${payload.tools.length} tools`
                  );
                ws.send(
                  JSON.stringify({
                    type: 'tools_list',
                    ...payload,
                  })
                );
              } catch (err) {
                log.error('[pifrontier] get_tools error:', err);
              }
              break;
            }

            case 'set_active_tools': {
              try {
                activeSession().setActiveToolsByName(msg.toolNames as string[]);
              } catch (err) {
                log.error('[pifrontier] set_active_tools error:', err);
              }
              break;
            }

            case 'get_resources': {
              try {
                const sess = await ensureSession();
                const { skills } = sess.resourceLoader.getSkills();
                const { prompts } = sess.resourceLoader.getPrompts();
                const skillSummaries: SkillSummary[] = skills.map((skill) => ({
                  name: skill.name,
                  description: skill.description,
                  scope: skill.sourceInfo.scope,
                  isBuiltin: skill.sourceInfo.origin === 'package',
                  source: skill.sourceInfo.source,
                }));
                const promptSummaries: PromptSummary[] = prompts.map((prompt) => ({
                  name: prompt.name,
                  description: prompt.description,
                  argumentHint: prompt.argumentHint,
                  scope: prompt.sourceInfo.scope,
                  isBuiltin: prompt.sourceInfo.origin === 'package',
                  source: prompt.sourceInfo.source,
                }));
                ws.send(
                  JSON.stringify({
                    type: 'resources_list',
                    skills: skillSummaries,
                    prompts: promptSummaries,
                  })
                );
              } catch (err) {
                log.error('[pifrontier] get_resources error:', err);
                ws.send(JSON.stringify({ type: 'resources_list', skills: [], prompts: [] }));
              }
              break;
            }
            case 'get_project_trust': {
              try {
                const targetCwd = resolve(
                  (msg as { type: 'get_project_trust'; cwd?: string }).cwd ??
                    activeSession().sessionManager.getCwd() ??
                    cwd
                );
                ws.send(
                  JSON.stringify({ type: 'project_trust', trust: projectTrustInfoFor(targetCwd) })
                );
              } catch (err) {
                log.error('[pifrontier] get_project_trust error:', err);
                ws.send(
                  JSON.stringify({
                    type: 'project_trust',
                    trust: {
                      cwd,
                      decision: 'ask',
                      requiresDecision: true,
                      persisted: false,
                    },
                  })
                );
              }
              break;
            }

            case 'set_project_trust': {
              try {
                const request = msg as {
                  type: 'set_project_trust';
                  cwd: string;
                  decision: ProjectTrustDecision;
                };
                const targetCwd = resolve(request.cwd);
                // 'session' trusts the active session in memory only — the store
                // is left untouched so the next startup still asks. 'ask' resets
                // to undecided (store cleared + session untrusted).
                if (request.decision !== 'session') {
                  trustStore().set(
                    targetCwd,
                    request.decision === 'trusted'
                      ? true
                      : request.decision === 'denied'
                        ? false
                        : null
                  );
                }
                const sess = activeSessionOrNull();
                if (sess && resolve(sess.sessionManager.getCwd() || cwd) === targetCwd) {
                  // Trust level is a per-session in-memory flag on the settings
                  // manager; persisted decisions already landed in the store above.
                  sess.settingsManager.setProjectTrusted(
                    request.decision === 'trusted' || request.decision === 'session'
                  );
                  await reloadSessionHost(sess.sessionId, sess);
                }
                broadcast({ type: 'project_trust', trust: projectTrustInfoFor(targetCwd) });
              } catch (err) {
                log.error('[pifrontier] set_project_trust error:', err);
                ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
              }
              break;
            }

            case 'get_command_completions': {
              try {
                const { command, prefix } = msg as {
                  type: string;
                  command: string;
                  prefix: string;
                };
                const { extensions } = activeSession().resourceLoader.getExtensions();
                for (const extension of extensions) {
                  const registered = extension.commands.get(command);
                  if (registered?.getArgumentCompletions) {
                    const items = await registered.getArgumentCompletions(prefix);
                    ws.send(
                      JSON.stringify({
                        type: 'command_completions',
                        command,
                        prefix,
                        items: items ?? [],
                      })
                    );
                    return;
                  }
                }
                ws.send(
                  JSON.stringify({ type: 'command_completions', command, prefix, items: [] })
                );
              } catch (err) {
                log.error('[pifrontier] get_command_completions error:', err);
                ws.send(
                  JSON.stringify({
                    type: 'command_completions',
                    command: '',
                    prefix: '',
                    items: [],
                  })
                );
              }
              break;
            }

            case 'get_extensions': {
              try {
                const sess = await ensureSession();
                const { extensions, errors } = sess.resourceLoader.getExtensions();
                const runner = sess.extensionRunner;
                const diagnostics = [
                  ...runner.getShortcutDiagnostics(),
                  ...runner.getCommandDiagnostics(),
                  ...sess.resourceLoader.getSkills().diagnostics,
                  ...sess.resourceLoader.getPrompts().diagnostics,
                ];
                const shortcuts = runner.getShortcuts({}) as Map<string, PiSDKNS.ExtensionShortcut>;
                const summaries: ExtensionSummary[] = extensions.map((extension) => ({
                  source: extension.sourceInfo.source,
                  path: extension.sourceInfo.path,
                  scope: extension.sourceInfo.scope,
                  origin: extension.sourceInfo.origin,
                  tools: [...extension.tools.values()].map((tool) => ({
                    name: tool.definition.name,
                    description: tool.definition.description ?? '',
                  })),
                  commands: [...extension.commands.values()].map((command) => ({
                    name: command.name,
                    description: command.description ?? '',
                  })),
                  flags: [...extension.flags.values()].map((flag) => ({
                    name: flag.name,
                    description: flag.description,
                    type: flag.type,
                    default: flag.default,
                    value: runner.getFlagValues().get(flag.name),
                  })),
                  shortcuts: [...extension.shortcuts.values()].map((shortcut) => ({
                    shortcut: String(shortcut.shortcut),
                    description: shortcut.description,
                    source: shortcut.extensionPath,
                  })),
                  diagnostics: diagnostics.filter((diagnostic) =>
                    diagnostic.path ? diagnostic.path === extension.path : false
                  ),
                }));
                ws.send(JSON.stringify({ type: 'extensions_list', extensions: summaries, errors }));
                ws.send(
                  JSON.stringify({
                    type: 'runtime_diagnostics',
                    diagnostics: sessionPool.get(sess.sessionId)?.diagnostics ?? [],
                  })
                );
                void shortcuts;
              } catch (err) {
                log.error('[pifrontier] get_extensions error:', err);
                ws.send(JSON.stringify({ type: 'extensions_list', extensions: [], errors: [] }));
              }
              break;
            }
            case 'get_packages': {
              try {
                const { manager } = packageManagerFor(await ensureSession());
                const packages = manager.listConfiguredPackages().map((pkg) => ({
                  source: pkg.source,
                  scope: pkg.scope,
                  filtered: pkg.filtered,
                  installedPath: pkg.installedPath,
                }));
                const updates = await manager.checkForAvailableUpdates();
                ws.send(JSON.stringify({ type: 'packages_list', packages, updates }));
              } catch (err) {
                log.error('[pifrontier] get_packages error:', err);
                ws.send(JSON.stringify({ type: 'packages_list', packages: [], updates: [] }));
              }
              break;
            }

            case 'install_package':
            case 'remove_package':
            case 'update_packages': {
              try {
                const sess = activeSession();
                const { manager } = packageManagerFor(sess);
                manager.setProgressCallback((progress) =>
                  broadcast({ type: 'package_progress', progress })
                );
                if (msg.type === 'install_package') {
                  await manager.installAndPersist(msg.source, { local: msg.scope === 'project' });
                } else if (msg.type === 'remove_package') {
                  await manager.removeAndPersist(msg.source, { local: msg.scope === 'project' });
                } else {
                  await manager.update(msg.source);
                }
                await reloadSessionHost(sess.sessionId, sess);
                ws.send(
                  JSON.stringify({
                    type: 'package_result',
                    success: true,
                    message: 'Package operation completed.',
                  })
                );
              } catch (err) {
                log.error('[pifrontier] package mutation error:', err);
                ws.send(
                  JSON.stringify({ type: 'package_result', success: false, message: String(err) })
                );
              }
              break;
            }

            case 'check_package_updates': {
              try {
                const { manager } = packageManagerFor(activeSession());
                const updates = await manager.checkForAvailableUpdates();
                ws.send(
                  JSON.stringify({
                    type: 'packages_list',
                    packages: manager.listConfiguredPackages(),
                    updates,
                  })
                );
              } catch (err) {
                log.error('[pifrontier] check_package_updates error:', err);
                ws.send(JSON.stringify({ type: 'packages_list', packages: [], updates: [] }));
              }
              break;
            }

            case 'set_package_filter': {
              try {
                const sess = activeSession();
                const { settings } = packageManagerFor(sess);
                const projectScope = msg.source.startsWith('project:');
                const packages = projectScope
                  ? (settings.getProjectSettings().packages ?? [])
                  : settings.getPackages();
                const source = msg.source.replace(/^project:/, '');
                const updated: PiSDKNS.PackageSource[] = packages.map(
                  (pkg: PiSDKNS.PackageSource) =>
                    packageSourceName(pkg) === source ? { source, ...msg.filter } : pkg
                );
                if (projectScope) settings.setProjectPackages(updated);
                else settings.setPackages(updated);
                await reloadSessionHost(sess.sessionId, sess);
                ws.send(
                  JSON.stringify({
                    type: 'package_result',
                    success: true,
                    message: 'Package filter updated.',
                  })
                );
              } catch (err) {
                log.error('[pifrontier] set_package_filter error:', err);
                ws.send(
                  JSON.stringify({
                    type: 'package_result',
                    success: false,
                    message: String(err),
                  })
                );
              }
              break;
            }
            case 'set_extension_flag': {
              try {
                const sess = activeSession();
                const flag = sess.extensionRunner.getFlags().get(msg.name);
                if (!flag) throw new Error(`Unknown extension flag: ${msg.name}`);
                if (
                  (flag.type === 'boolean' && typeof msg.value !== 'boolean') ||
                  (flag.type === 'string' && typeof msg.value !== 'string')
                ) {
                  throw new Error(`Invalid value for ${msg.name}; expected ${flag.type}`);
                }
                sess.extensionRunner.setFlagValue(msg.name, msg.value);
                persistExtensionFlag(msg.name, msg.value);
                await reloadSessionHost(sess.sessionId, sess);
                ws.send(
                  JSON.stringify({
                    type: 'extension_flag_result',
                    name: msg.name,
                    value: msg.value,
                    success: true,
                  })
                );
              } catch (err) {
                log.error('[pifrontier] set_extension_flag error:', err);
                ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
              }
              break;
            }

            case 'invoke_extension_shortcut': {
              try {
                const sess = activeSession();
                const shortcuts = sess.extensionRunner.getShortcuts({});
                const shortcut = [...shortcuts.values()].find(
                  (entry) => String(entry.shortcut) === msg.shortcut
                );
                if (!shortcut) throw new Error(`Shortcut not found: ${msg.shortcut}`);
                await shortcut.handler(sess.extensionRunner.createContext());
              } catch (err) {
                log.error('[pifrontier] invoke_extension_shortcut error:', err);
                ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
              }
              break;
            }

            case 'get_commands': {
              try {
                ws.send(
                  JSON.stringify({
                    type: 'commands_list',
                    commands: extensionCommandsFor(activeSession()),
                  })
                );
              } catch (err) {
                log.error('[pifrontier] get_commands error:', err);
                ws.send(JSON.stringify({ type: 'commands_list', commands: [] }));
              }
              break;
            }

            case 'install_skill': {
              try {
                const rawUrl = resolveGitHubRawUrl(msg.url as string);
                // Security: only allow fetching from trusted hosts to prevent SSRF.
                try {
                  const parsedUrl = new URL(rawUrl);
                  if (!ALLOWED_SKILL_HOSTS.includes(parsedUrl.hostname)) {
                    ws.send(
                      JSON.stringify({
                        type: 'skill_install_result',
                        success: false,
                        error: `Blocked: only GitHub URLs are allowed (got ${parsedUrl.hostname}).`,
                      })
                    );
                    break;
                  }
                } catch {
                  ws.send(
                    JSON.stringify({
                      type: 'skill_install_result',
                      success: false,
                      error: 'Invalid URL.',
                    })
                  );
                  break;
                }
                // redirect:'error' — the host whitelist above is checked pre-fetch only,
                // so following redirects could smuggle content from arbitrary hosts.
                if (
                  msg.scope === 'project' &&
                  !activeSession().settingsManager.isProjectTrusted()
                ) {
                  throw new Error('Project resources are not trusted for this session.');
                }
                const res = await fetch(rawUrl, { redirect: 'error' });
                if (!res.ok) {
                  ws.send(
                    JSON.stringify({
                      type: 'skill_install_result',
                      success: false,
                      error: `HTTP ${res.status}: ${res.statusText}`,
                    })
                  );
                  break;
                }
                const content = await res.text();
                const fileName = basename(rawUrl.split('?')[0]);
                const safeFileName = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
                const sessionCwd = activeSession().sessionManager.getCwd() || cwd;
                const destDir =
                  (msg.scope as string) === 'user'
                    ? join(_sdk!.getAgentDir(), 'skills')
                    : resolve(sessionCwd, PI_CONFIG_DIR, 'skills');
                await mkdir(destDir, { recursive: true });
                const destPath = join(destDir, safeFileName);
                await writeFile(destPath, content, 'utf8');
                const sess = activeSession();
                await reloadSessionHost(sess.sessionId, sess);
                // Extract skill name from frontmatter or filename
                const nameMatch = content.match(/^---[\s\S]*?^name:\s*(.+)$/m);
                const skillName = nameMatch
                  ? nameMatch[1].trim()
                  : safeFileName.replace(/\.md$/, '');
                ws.send(
                  JSON.stringify({ type: 'skill_install_result', success: true, name: skillName })
                );
              } catch (err) {
                log.error('[pifrontier] install_skill error:', err);
                ws.send(
                  JSON.stringify({
                    type: 'skill_install_result',
                    success: false,
                    error: String(err),
                  })
                );
              }
              break;
            }

            case 'fork_session': {
              await withSessionMutationLock(async () => {
                try {
                  const entryId = (msg as { type: 'fork_session'; entryId: string }).entryId;
                  const sessionFile = activeSession().sessionFile;
                  if (!sessionFile) throw new Error('Active session is not persisted');
                  const sm = _sdk!.SessionManager.open(sessionFile);
                  const forkPath = sm.createBranchedSession(entryId);
                  if (!forkPath) throw new Error('Failed to create branched session');
                  const sm2 = _sdk!.SessionManager.open(forkPath);
                  const created = await createSdkSession(
                    activeCwd(),
                    sm2,
                    'fork',
                    activeSession().sessionFile
                  );
                  await setActiveSession(created.session, activeCwd(), created);
                } catch (err) {
                  log.error('[pifrontier] fork_session error:', err);
                  ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
                }
              });
              break;
            }

            case 'edit_message': {
              try {
                const s = activeSession();
                if (s.isStreaming) {
                  ws.send(
                    JSON.stringify({
                      type: 'agent_error',
                      error: 'Cannot edit while the agent is streaming.',
                    })
                  );
                  break;
                }
                const { originalMessage, newMessage } = msg as {
                  type: 'edit_message';
                  originalMessage: string;
                  newMessage: string;
                };
                if (!s.sessionManager.isPersisted())
                  throw new Error('Cannot edit in an in-memory session');
                const userMsgs = s.getUserMessagesForForking();
                // Find the last matching entry (most recent occurrence of the original text)
                const match = [...userMsgs].reverse().find((m) => m.text === originalMessage);
                if (!match) throw new Error('Could not find the original message to edit');
                await s.navigateTree(match.entryId);
                await s.prompt(newMessage);
              } catch (err) {
                log.error('[pifrontier] edit_message error:', err);
                ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
              }
              break;
            }

            case 'read_file': {
              try {
                const filePath = (msg as { type: 'read_file'; path: string }).path;
                // Security: reject null bytes (path traversal via null injection).
                if (filePath.includes('\0')) {
                  ws.send(
                    JSON.stringify({
                      type: 'file_content',
                      path: filePath,
                      content: '',
                      error: 'Invalid path',
                    })
                  );
                  break;
                }
                // Security: resolve relative to the active project root and ensure it doesn't escape
                const resolved = resolve(activeCwd(), filePath);
                if (!isInsideWorkspace(resolved)) {
                  ws.send(
                    JSON.stringify({
                      type: 'file_content',
                      path: filePath,
                      content: '',
                      error: 'Path escapes workspace root',
                    })
                  );
                  break;
                }
                const file = Bun.file(resolved);
                if (await file.exists()) {
                  // Cap reads — loading huge logs/binaries into memory would hurt the Pi.
                  const MAX_READ_BYTES = 2 * 1024 * 1024;
                  if (file.size > MAX_READ_BYTES) {
                    ws.send(
                      JSON.stringify({
                        type: 'file_content',
                        path: filePath,
                        content: '',
                        error: `File too large to view (${(file.size / 1024 / 1024).toFixed(1)} MB > 2 MB)`,
                      })
                    );
                    break;
                  }
                  const content = await file.text();
                  ws.send(JSON.stringify({ type: 'file_content', path: filePath, content }));
                } else {
                  ws.send(
                    JSON.stringify({
                      type: 'file_content',
                      path: filePath,
                      content: '',
                      error: 'File not found',
                    })
                  );
                }
              } catch (err) {
                log.error('[pifrontier] read_file error:', err);
                ws.send(
                  JSON.stringify({
                    type: 'file_content',
                    path: (msg as { type: 'read_file'; path: string }).path,
                    content: '',
                    error: String(err),
                  })
                );
              }
              break;
            }

            case 'write_file': {
              try {
                const { path: filePath, content: fileContent } = msg as {
                  type: 'write_file';
                  path: string;
                  content: string;
                };
                if (filePath.includes('\0')) {
                  ws.send(
                    JSON.stringify({ type: 'file_saved', path: filePath, error: 'Invalid path' })
                  );
                  break;
                }
                const resolved = resolve(activeCwd(), filePath);
                if (!isInsideWorkspace(resolved)) {
                  ws.send(
                    JSON.stringify({
                      type: 'file_saved',
                      path: filePath,
                      error: 'Path escapes workspace root',
                    })
                  );
                  break;
                }
                await Bun.write(resolved, fileContent);
                ws.send(JSON.stringify({ type: 'file_saved', path: filePath }));
              } catch (err) {
                log.error('[pifrontier] write_file error:', err);
                ws.send(
                  JSON.stringify({
                    type: 'file_saved',
                    path: (msg as { type: 'write_file'; path: string }).path,
                    error: String(err),
                  })
                );
              }
              break;
            }

            case 'get_update_status': {
              try {
                const status = await getUpdateStatus();
                ws.send(JSON.stringify({ type: 'update_status', ...status }));
              } catch (err) {
                log.error('[pifrontier] get_update_status error:', err);
                ws.send(
                  JSON.stringify({
                    type: 'update_status',
                    appRoot: APP_ROOT,
                    mode: 'package',
                    busy: updateInProgress,
                    canUpdateUi: false,
                    canUpdateSdk: false,
                    ui: { name: UI_PACKAGE_NAME, current: UI_VERSION, error: String(err) },
                    sdk: { name: PI_SDK_PACKAGE_NAME, current: PI_SDK_VERSION, error: String(err) },
                    notes: ['Unable to check for updates.'],
                  })
                );
              }
              break;
            }

            case 'load_messages': {
              try {
                const count = Math.min(
                  (msg as { count?: number }).count ?? 50,
                  MAX_INITIAL_MESSAGES
                );
                const s = activeSession();
                const all = s.messages;
                const total = all.length;
                const alreadyHasCount = Math.min(
                  (msg as { alreadyHasCount?: number }).alreadyHasCount ?? 0,
                  total
                );
                // alreadyHasCount is how many messages the client already shows (the tail).
                // Send `count` messages just before that tail.
                const end = Math.max(0, total - alreadyHasCount);
                const start = Math.max(0, end - count);
                const older = all.slice(start, end);
                ws.send(
                  JSON.stringify({
                    type: 'older_messages',
                    messages: trimMessagesForWire(renderCustomMessagesForWire(s, older)),
                    totalMessageCount: total,
                    messagesTruncated: start > 0,
                  })
                );
              } catch (err) {
                log.error('[pifrontier] load_messages error:', err);
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
                ws.send(
                  JSON.stringify({
                    type: 'sessions_error',
                    message: 'Invalid or missing restart nonce.',
                  })
                );
                break;
              }
              pendingRestartNonce = null; // consume the nonce — single use
              log.info('[pifrontier] Restart confirmed — broadcasting and re-execing…');
              broadcast({ type: 'server_restarting' });
              // Cleanup idle cleanup timer
              if (_idleCleanupTimer) {
                clearInterval(_idleCleanupTimer);
                _idleCleanupTimer = null;
              }
              setTimeout(() => {
                Bun.spawn([process.execPath, ...process.argv.slice(1)], {
                  env: sanitizeEnv(),
                  detached: true,
                  stdio: ['inherit', 'inherit', 'inherit'],
                });
                process.exit(0);
              }, 400);
              break;
            }
            case 'set_notification_webhook_url': {
              setWebhookUrl(msg.url);
              broadcast({ type: 'notification_webhook_url', url: getWebhookUrl() });
              break;
            }

            case 'ping': {
              // Client heartbeat — keeps the socket alive past idleTimeout and
              // lets the client detect zombie (dead-but-open) connections.
              ws.send('{"type":"pong"}');
              break;
            }
            case 'get_settings': {
              ws.send(JSON.stringify({ type: 'settings', settings: readSettings() }));
              break;
            }
            case 'push_subscribe': {
              const { endpoint, keys } = msg as {
                type: 'push_subscribe';
                endpoint: string;
                keys: { p256dh: string; auth: string };
                expirationTime?: number | null;
              };
              if (
                typeof endpoint === 'string' &&
                endpoint.startsWith('https://') &&
                keys &&
                typeof keys.p256dh === 'string' &&
                typeof keys.auth === 'string'
              ) {
                addPushSubscription({ endpoint, keys, expirationTime: msg.expirationTime ?? null });
              }
              break;
            }
            case 'push_unsubscribe': {
              const { endpoint } = msg as { type: 'push_unsubscribe'; endpoint: string };
              if (typeof endpoint === 'string') removePushSubscription(endpoint);
              break;
            }
            case 'set_settings': {
              const updated = updateSettings(msg.settings as Record<string, unknown>);
              broadcast({ type: 'settings', settings: updated });
              break;
            }
          } // end switch
        } catch (err) {
          log.error('[pifrontier] WS message handler error:', err);
          try {
            ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
          } catch {
            /* ws may be closed */
          }
        }
      },

      close(ws) {
        ws.data.closed = true;
        ws.unsubscribe(WS_TOPIC);
        // Clear the periodic token expiry check
        if (ws.data._expTimer) {
          clearInterval(ws.data._expTimer);
          ws.data._expTimer = undefined;
        }
        connectedClients = Math.max(0, connectedClients - 1);
        // When the last client disconnects, give a 15s grace period before
        // cancelling pending extension dialogs. This prevents transient PWA
        // reconnects (tab hidden, mobile wake) from dropping active prompts.
        // We do NOT dispose or clear pooled sessions — background agent work must
        // continue running even when no browser client is connected.
        if (connectedClients === 0) {
          if (_pendingRequestsTimeout) clearTimeout(_pendingRequestsTimeout);
          _pendingRequestsTimeout = setTimeout(() => {
            _pendingRequestsTimeout = null;
            cancelAllPendingExtensionRequests();
          }, PENDING_REQUESTS_GRACE_MS);
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
    log.error(`[pifrontier] Port ${PORT} is already in use.`);
    log.error(`[pifrontier] Use a different port: pi-ui --port ${PORT + 1}`);
  } else {
    log.error('[pifrontier] Failed to start server:', error.message ?? err);
  }
  process.exit(1);
}

// ── 6. Wire up broadcast ──────────────────────────────────────────────────────
// Session subscription is set up inside ensureSession() on first WS connection.

broadcast = (payload) => {
  // No subscribers — skip stringify/publish entirely. The open handler replays
  // full state snapshots to the next client that connects.
  if (connectedClients === 0) return;
  server.publish(WS_TOPIC, JSON.stringify(payload));
};
startIdleCleanup();
// Hydrate session summaries from the previous run — sidebar loads become
// stat-calls-only; files are fully read at most once per change.
initSessionScanCache(join(homedir(), '.pi', 'agent', 'pi-ui-session-scan.json'));

log.info(`[pifrontier] Listening on http://localhost:${PORT}`);

// ── 7. Graceful shutdown ───────────────────────────────────────────────────────
// On SIGTERM/SIGINT, give agent runs a chance to complete and let clients know.

const _shutdown = async () => {
  try {
    server?.stop(false);
  } catch {
    /* ignore */
  }
  _stopSessionWatch?.();
  // Dispose all pooled sessions so background agent work stops cleanly
  for (const [, entry] of sessionPool) {
    try {
      if (entry.session.isStreaming) {
        try {
          entry.session.abort();
        } catch {
          /* agent may already be done */
        }
      }
      entry.session.dispose();
    } catch {
      /* session may already be disposed */
    }
  }
  sessionPool.clear();
  // Flush any debounced session-scan cache write so the next start is
  // stat-only for unchanged files.
  try {
    await flushSessionScanCache();
  } catch {
    /* best effort — worst case is one re-scan */
  }
  // Flush any debounced project-registry write.
  try {
    await projectCatalog.flush();
  } catch {
    /* best effort — worst case is one re-registration */
  }
  process.exit(0);
};

process.on('SIGTERM', () => _shutdown());
process.on('SIGINT', () => _shutdown());

// ── 8. Crash containment ──────────────────────────────────────────────────────
// Without these handlers Bun terminates the process on any uncaught error —
// one bad SDK event or WS send loops the service under systemd Restart=.
// Log loudly (journald picks up the <3> priority), tell connected clients,
// and keep serving; the HTTP/WS server and session pool remain valid.

function reportCrash(kind: string, err: unknown): void {
  log.error(`${kind}:`, err instanceof Error ? err : new Error(String(err)));
  try {
    broadcast({
      type: 'agent_error',
      error: `Internal server error (${kind}): ${err instanceof Error ? err.message : String(err)}`,
    });
  } catch {
    /* broadcast unavailable during startup/shutdown */
  }
}

process.on('uncaughtException', (err) => reportCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => reportCrash('unhandledRejection', reason));
