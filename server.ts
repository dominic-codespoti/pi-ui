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
import { join, resolve, basename } from 'node:path';
import { initPassword, isValidSessionCookie } from './src/lib/auth/password.ts';
import type { ClientMessage, HistoryWindow, ModelInfo, ProviderInfo, SessionSummary, SkillSummary, PromptSummary } from './src/lib/ws/protocol.ts';
import ownPkgJson from './package.json' with { type: 'json' };

/** pi-ui version baked in at startup. */
const UI_VERSION: string = (ownPkgJson as { version: string }).version;

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

const MAX_HISTORY_PAGE_LIMIT = 300;

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

const HISTORY_PAGE_LIMIT = boundedInt(Bun.env.PI_UI_HISTORY_LIMIT, 80, 20, MAX_HISTORY_PAGE_LIMIT);

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

function getHistoryPage(
  allMessages: readonly unknown[],
  options: { offset?: number; limit?: number } = {}
): { messages: unknown[]; history: HistoryWindow } {
  const total = allMessages.length;
  const limit = boundedInt(options.limit, HISTORY_PAGE_LIMIT, 1, MAX_HISTORY_PAGE_LIMIT);
  const offset = options.offset === undefined
    ? Math.max(0, total - limit)
    : boundedInt(options.offset, 0, 0, total);
  const end = Math.min(total, offset + limit);

  return {
    messages: allMessages.slice(offset, end),
    history: {
      total,
      offset,
      limit,
      hasMore: offset > 0,
    },
  };
}

// ── 3. Restart nonce ──────────────────────────────────────────────────────────
// Single-use nonce for restart_server. Prevents replay and ensures the user
// explicitly confirmed the restart via a request_restart → restart_server flow.
let pendingRestartNonce: string | null = null;

// ── 4. Extension UI — pending request map ─────────────────────────────────────

type PendingRequest = { resolve: (response: Record<string, unknown>) => void };
const pendingExtensionRequests = new Map<string, PendingRequest>();

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

// Server-side state for extension UI context
let toolsExpanded = false;

const uiContext: ExtensionUIContext = {
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
    if (content === undefined || Array.isArray(content)) {
      broadcast({
        type: 'extension_ui_request',
        id: crypto.randomUUID(),
        method: 'setWidget',
        widgetKey: key,
        widgetLines: content,
        widgetPlacement: options?.placement,
      });
    }
  },

  setFooter() {},
  setHeader() {},

  setTitle(title) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'setTitle', title });
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async custom(): Promise<any> {
    return undefined;
  },

  pasteToEditor(text) {
    this.setEditorText(text);
  },

  setEditorText(text) {
    broadcast({ type: 'extension_ui_request', id: crypto.randomUUID(), method: 'set_editor_text', text });
  },

  getEditorText() {
    return '';
  },

  addAutocompleteProvider() {},
  setEditorComponent() {},
  getEditorComponent() {
    return undefined;
  },

  // TUI-only stubs — no-op in RPC/WebSocket context
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
 */
async function ensureSession(): Promise<AgentSession> {
  if (session) return session;
  if (!_sessionInitPromise) {
    _sessionInitPromise = (async () => {
      const sdk = await getSDK();
      console.log(`[pifrontier] Starting pi session in ${cwd} …`);
      const sm = sdk.SessionManager.continueRecent(cwd);
      const result = await sdk.createAgentSession({ cwd, sessionManager: sm });
      session = result.session;
      console.log(`[pifrontier] Pi session ready: ${session.sessionId}`);
      await session.bindExtensions({ uiContext });
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
  // Detach from old session (don't dispose — may still be in use)
  if (unsubscribePi) {
    unsubscribePi();
    unsubscribePi = null;
  }

  session = newSession;

  await session.bindExtensions({ uiContext });

  unsubscribePi = session.subscribe((event) => {
    broadcast(event);
  });

  const page = getHistoryPage(session.messages as unknown[]);
  broadcast({
    type: 'session_loaded',
    sessionId: session.sessionId,
    isStreaming: session.isStreaming,
    thinkingLevel: session.thinkingLevel,
    model: serializeModel(session.model),
    availableModels: session.modelRegistry.getAvailable().map(serializeModel),
    messages: page.messages,
    history: page.history,
    cwd,
    sessionName: session.sessionManager.getSessionName(),
    isCompacting: session.isCompacting,
    autoCompactionEnabled: session.autoCompactionEnabled,
    autoRetryEnabled: session.autoRetryEnabled,
    piVersion: PI_SDK_VERSION,
    uiVersion: UI_VERSION,
  });
}

// ── 5. TTS summarisation helper ───────────────────────────────────────────────

/**
 * Spin up a temporary pi session, prompt it to summarise `content` into
 * 1-2 spoken sentences, collect the streamed text, and send
 * { type: 'tts_summary', text } back to the requesting WebSocket client.
 *
 * The session is immediately disposed on completion or error so it does not
 * linger in memory. Tools are disabled to prevent any tool-use overhead.
 */
async function summarizeForTTS(content: string, ws: { send(data: string): void }): Promise<void> {
  const sdk = await getSDK();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sumSession: any = null;
  try {
    const sm = sdk.SessionManager.create(cwd);
    const { session: s } = await sdk.createAgentSession({
      cwd,
      sessionManager: sm,
      modelRegistry: session!.modelRegistry,
    });
    sumSession = s;

    // Disable all tools — this is a pure text completion
    sumSession.setActiveToolsByName([]);

    let summary = '';
    const done = new Promise<void>((resolve) => {
      const unsub = sumSession!.subscribe((event: Record<string, unknown>) => {
        if (event.type === 'message_update') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const inner = (event as any).assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (inner?.type === 'text_delta' && typeof inner.delta === 'string') {
            summary += inner.delta;
          }
        } else if (event.type === 'agent_end') {
          unsub();
          resolve();
        }
      });
    });

    const prompt =
      `Summarize the following AI assistant response in 1-2 short spoken sentences suitable for text-to-speech. ` +
      `Skip all code snippets and technical specifics. Be natural and conversational.\n\nResponse:\n${content.slice(0, 3000)}`;

    await sumSession.prompt(prompt);

    // Await agent_end with a 30 s safety timeout
    await Promise.race([done, new Promise<void>((r) => setTimeout(r, 30_000))]);

    ws.send(JSON.stringify({ type: 'tts_summary', text: summary.trim() }));
  } catch (err) {
    console.error('[pifrontier] summarizeForTTS error:', err);
    ws.send(JSON.stringify({ type: 'tts_summary', text: '' }));
  } finally {
    sumSession?.dispose();
  }
}

// ── 6. Start server ───────────────────────────────────────────────────────────

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

      // Load SDK + session on first connection; subsequent calls return instantly.
      const sess = await ensureSession();
      const page = getHistoryPage(sess.messages as unknown[]);

      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: sess.sessionId,
          isStreaming: sess.isStreaming,
          thinkingLevel: sess.thinkingLevel,
          model: serializeModel(sess.model),
          availableModels: sess.modelRegistry.getAvailable().map(serializeModel),
          messages: page.messages,
          history: page.history,
          cwd,
          sessionName: sess.sessionManager.getSessionName(),
          isCompacting: sess.isCompacting,
          autoCompactionEnabled: sess.autoCompactionEnabled,
          autoRetryEnabled: sess.autoRetryEnabled,
          piVersion: PI_SDK_VERSION,
          uiVersion: UI_VERSION,
        })
      );
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
            // Security: targetCwd must resolve within the server's cwd.
            const targetCwd = resolve(rawTargetCwd);
            if (!targetCwd.startsWith(resolve(cwd))) {
              console.warn(`[pifrontier] new_session blocked: targetCwd escapes workspace: ${rawTargetCwd}`);
              break;
            }
            const sm = _sdk!.SessionManager.create(targetCwd);
            const { session: newSession } = await _sdk!.createAgentSession({
              cwd: targetCwd,
              sessionManager: sm,
              modelRegistry: session!.modelRegistry,
            });
            await setActiveSession(newSession);
          } catch (err) {
            console.error('[pifrontier] new_session error:', err);
          }
          break;
        }

        case 'switch_session': {
          try {
            // Security: validate path is inside cwd before opening.
            const resolvedPath = resolve(msg.path);
            if (!resolvedPath.startsWith(resolve(cwd))) {
              console.warn(`[pifrontier] switch_session blocked: path escapes workspace: ${msg.path}`);
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Path escapes workspace.' }));
              break;
            }
            const sm = _sdk!.SessionManager.open(msg.path);
            const { session: newSession } = await _sdk!.createAgentSession({
              cwd: sm.getCwd() || cwd,
              sessionManager: sm,
              modelRegistry: session!.modelRegistry,
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

        case 'get_providers': {
          ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
          break;
        }

        case 'load_history': {
          const req = msg as Extract<ClientMessage, { type: 'load_history' }>;
          if (req.sessionId !== session!.sessionId) {
            ws.send(JSON.stringify({
              type: 'history_page',
              sessionId: req.sessionId,
              messages: [],
              history: { total: 0, offset: 0, limit: boundedInt(req.limit, HISTORY_PAGE_LIMIT, 1, MAX_HISTORY_PAGE_LIMIT), hasMore: false },
            }));
            break;
          }

          const page = getHistoryPage(session!.messages as unknown[], {
            offset: req.offset,
            limit: req.limit,
          });
          ws.send(JSON.stringify({ type: 'history_page', sessionId: session!.sessionId, ...page }));
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
            // Security: validate path is inside cwd.
            const resolvedPath = resolve(msg.path);
            if (!resolvedPath.startsWith(resolve(cwd))) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Path escapes workspace.' }));
              break;
            }
            const sm = _sdk!.SessionManager.open(msg.path);
            sm.appendSessionInfo(msg.name);
            // If renaming the active session, also fire the SDK event so all
            // connected browsers see the name change via session_info_changed.
            if (msg.path === session!.sessionFile) {
              session!.setSessionName(msg.name);
            }
            const list = await _sdk!.SessionManager.list(cwd);
            ws.send(JSON.stringify({ type: 'sessions_list', sessions: list.slice(0, 30).map(serializeSession) }));
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
            const list = await _sdk!.SessionManager.list(cwd);
            const target = list.find((s) => s.path === msg.path);
            if (!target) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Session not found.' }));
              break;
            }
            if (target.id === session!.sessionId) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Cannot delete the active session.' }));
              break;
            }
            // Double-check: resolved path must be inside the resolved cwd.
            const resolvedPath = resolve(target.path);
            if (!resolvedPath.startsWith(resolve(cwd))) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Path escapes workspace.' }));
              break;
            }
            await rm(resolvedPath);
            const updated = await _sdk!.SessionManager.list(cwd);
            ws.send(JSON.stringify({ type: 'sessions_list', sessions: updated.slice(0, 30).map(serializeSession) }));
          } catch (err) {
            console.error('[pifrontier] delete_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }

        case 'get_all_sessions': {
          try {
            const all = await _sdk!.SessionManager.listAll();
            ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: all.map(serializeSession) }));
          } catch (err) {
            console.error('[pifrontier] get_all_sessions error:', err);
            ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
          }
          break;
        }

        case 'dir_complete': {
          try {
            const prefix = (msg as { type: 'dir_complete'; prefix: string }).prefix;
            const { readdir } = await import('node:fs/promises');
            const { dirname, basename: pathBasename, join: pathJoin } = await import('node:path');
            const isDir = prefix.endsWith('/');
            const dir = isDir ? prefix : dirname(prefix);
            // Security: only complete directories within the server's cwd.
            const resolvedDir = resolve(dir);
            if (!resolvedDir.startsWith(resolve(cwd))) {
              ws.send(JSON.stringify({ type: 'dir_completions', prefix, entries: [] }));
              break;
            }
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
                  sendSlashResult(ws, command, 'Could not clone this in-memory session.', 'warning');
                  break;
                }
                const clonedSm = _sdk!.SessionManager.open(newPath);
                const { session: clonedSession } = await _sdk!.createAgentSession({
                  cwd: clonedSm.getCwd() || cwd,
                  sessionManager: clonedSm,
                  modelRegistry: session!.modelRegistry,
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
            const res = await fetch(rawUrl);
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
            const newPath = session!.sessionManager.createBranchedSession(msg.entryId);
            if (!newPath) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Fork failed: session is not persisted.' }));
              break;
            }
            const forkedSm = _sdk!.SessionManager.open(newPath);
            const { session: forkedSession } = await _sdk!.createAgentSession({
              cwd: forkedSm.getCwd() || cwd,
              sessionManager: forkedSm,
              modelRegistry: session!.modelRegistry,
            });
            await setActiveSession(forkedSession);
          } catch (err) {
            console.error('[pifrontier] fork_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }

        case 'summarize_for_tts': {
          // Fire-and-forget — response is sent asynchronously via ws.send inside summarizeForTTS
          summarizeForTTS((msg as { type: 'summarize_for_tts'; content: string }).content, ws).catch(
            (err) => console.error('[pifrontier] summarize_for_tts unhandled:', err)
          );
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
            // Security: resolve relative to cwd and ensure it doesn't escape
            const resolved = resolve(cwd, filePath);
            if (!resolved.startsWith(resolve(cwd))) {
              ws.send(JSON.stringify({ type: 'file_content', path: filePath, content: '', error: 'Path escapes workspace root' }));
              break;
            }
            const file = Bun.file(resolved);
            if (await file.exists()) {
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
