/**
 * Custom Bun entry point.
 *
 * Responsibilities:
 *  1. Validate PI_PASSWORD env var and initialise the bcrypt hash
 *  2. Start the pi coding-agent session (singleton for the process lifetime)
 *  3. Bridge pi SDK events → all connected WebSocket clients via pub/sub
 *  4. Handle WebSocket upgrades at /ws (auth-gated)
 *  5. Handle session switching and model changes
 *  6. Pass all other HTTP requests to the SvelteKit handler
 *
 * Run:  PI_PASSWORD=secret bun run server.ts
 * Build first: bun run build
 */

import handler_default from './build/handler.js';
import { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';
import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, basename, extname } from 'node:path';
import { initPassword, isValidSessionCookie } from './src/lib/auth/password.ts';
import type { ClientMessage, ModelInfo, ProviderInfo, SessionSummary, SkillSummary, PromptSummary } from './src/lib/ws/protocol.ts';

// svelte-adapter-bun exports a factory; call it with true to serve static assets.
const { httpserver: svelteHandler } = handler_default(true);

// ── 1. Validate environment ───────────────────────────────────────────────────

const PI_PASSWORD = Bun.env.PI_PASSWORD;
if (!PI_PASSWORD) {
  console.error('[pi-ui] Error: PI_PASSWORD environment variable is required.');
  console.error('[pi-ui] Usage: PI_PASSWORD=your-password bun run start');
  process.exit(1);
}

await initPassword(PI_PASSWORD);
console.log('[pi-ui] Password initialised.');

// ── 2. Helpers ────────────────────────────────────────────────────────────────

const cwd = Bun.env.PI_CWD ?? process.cwd();

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
  const allModels = session.modelRegistry.getAll();
  const providerCount = new Map<string, number>();
  for (const m of allModels) {
    providerCount.set(m.provider, (providerCount.get(m.provider) ?? 0) + 1);
  }

  const providers: ProviderInfo[] = [];
  for (const [providerId, modelCount] of providerCount) {
    const status = session.modelRegistry.getProviderAuthStatus(providerId);
    providers.push({
      id: providerId,
      name: session.modelRegistry.getProviderDisplayName(providerId),
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

function serializeSession(s: Awaited<ReturnType<typeof SessionManager.list>>[number]): SessionSummary {
  return {
    id: s.id,
    path: s.path,
    cwd: s.cwd,
    name: s.name,
    created: s.created.getTime(),
    modified: s.modified.getTime(),
    messageCount: s.messageCount,
    firstMessage: s.firstMessage,
  };
}

// ── 3. Extension UI — pending request map ─────────────────────────────────────

type PendingRequest = { resolve: (response: Record<string, unknown>) => void };
const pendingExtensionRequests = new Map<string, PendingRequest>();

// broadcast is a thin wrapper; reassigned once the Bun server is live.
let broadcast: (payload: unknown) => void = () => {};

function createDialogPromise<T>(
  id: string,
  requestPayload: Record<string, unknown>,
  parseResponse: (r: Record<string, unknown>) => T,
  defaultValue: T
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
      (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? (r.value as string) : undefined),
      undefined
    );
  },

  confirm(title, message) {
    const id = crypto.randomUUID();
    return createDialogPromise<boolean>(
      id,
      { method: 'confirm', title, message },
      (r) => ('cancelled' in r && r.cancelled ? false : 'confirmed' in r ? Boolean(r.confirmed) : false),
      false
    );
  },

  input(title, placeholder) {
    const id = crypto.randomUUID();
    return createDialogPromise<string | undefined>(
      id,
      { method: 'input', title, placeholder },
      (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? (r.value as string) : undefined),
      undefined
    );
  },

  editor(title, prefill) {
    const id = crypto.randomUUID();
    return createDialogPromise<string | undefined>(
      id,
      { method: 'editor', title, prefill },
      (r) => ('cancelled' in r && r.cancelled ? undefined : 'value' in r ? (r.value as string) : undefined),
      undefined
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ── 4. Pi session — mutable singleton ────────────────────────────────────────

console.log(`[pi-ui] Starting pi session in ${cwd} …`);

// Resume the most recent session for this cwd (creates new one if none exists).
const sm = SessionManager.continueRecent(cwd);
let session: AgentSession = (await createAgentSession({ cwd, sessionManager: sm })).session;
let unsubscribePi: (() => void) | null = null;
console.log(`[pi-ui] Pi session ready: ${session.sessionId}`);

await session.bindExtensions({ uiContext });
console.log('[pi-ui] Extension UI context bound.');

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

  broadcast({
    type: 'session_loaded',
    sessionId: session.sessionId,
    isStreaming: session.isStreaming,
    thinkingLevel: session.thinkingLevel,
    model: serializeModel(session.model),
    availableModels: session.modelRegistry.getAvailable().map(serializeModel),
    messages: session.messages,
    cwd,
    sessionName: session.sessionManager.getSessionName(),
    isCompacting: session.isCompacting,
    autoCompactionEnabled: session.autoCompactionEnabled,
    autoRetryEnabled: session.autoRetryEnabled,
  });
}

// ── 5. Start server ───────────────────────────────────────────────────────────

const PORT = parseInt(Bun.env.PORT ?? '3000');
const WS_TOPIC = 'pi';

type WSData = { connectedAt: number };

const server = Bun.serve<WSData>({
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

    return svelteHandler(req, server);
  },

  websocket: {
    open(ws) {
      ws.subscribe(WS_TOPIC);

      ws.send(
        JSON.stringify({
          type: 'connected',
          sessionId: session.sessionId,
          isStreaming: session.isStreaming,
          thinkingLevel: session.thinkingLevel,
          model: serializeModel(session.model),
          availableModels: session.modelRegistry.getAvailable().map(serializeModel),
          messages: session.messages,
          cwd,
          sessionName: session.sessionManager.getSessionName(),
          isCompacting: session.isCompacting,
          autoCompactionEnabled: session.autoCompactionEnabled,
          autoRetryEnabled: session.autoRetryEnabled,
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

      try {
      switch (msg.type) {
        case 'prompt': {
          const imageContent = msg.images?.length
            ? msg.images.map((img) => ({ type: 'image' as const, data: img.data, mimeType: img.mimeType }))
            : undefined;
          await session.prompt(msg.message, imageContent ? { images: imageContent } : undefined);
          break;
        }

        case 'steer':
          await session.steer(msg.message);
          break;

        case 'follow_up':
          await session.followUp(msg.message);
          break;

        case 'abort':
          await session.abort();
          break;

        case 'set_thinking_level':
          session.setThinkingLevel(msg.level as Parameters<typeof session.setThinkingLevel>[0]);
          break;

        case 'set_model': {
          const model = session.modelRegistry.find(msg.provider, msg.modelId);
          if (!model) {
            console.warn(`[pi-ui] set_model: model not found: ${msg.provider}/${msg.modelId}`);
            break;
          }
          try {
            await session.setModel(model);
            broadcast({ type: 'model_changed', model: serializeModel(model) });
          } catch (err) {
            console.error('[pi-ui] set_model error:', err);
          }
          break;
        }

        case 'list_sessions': {
          try {
            const list = await SessionManager.list(cwd);
            const sessions = list.slice(0, 30).map(serializeSession);
            ws.send(JSON.stringify({ type: 'sessions_list', sessions }));
          } catch (err) {
            console.error('[pi-ui] list_sessions error:', err);
            ws.send(JSON.stringify({ type: 'sessions_list', sessions: [] }));
          }
          break;
        }

        case 'new_session': {
          try {
            const targetCwd = (msg as { type: 'new_session'; targetCwd?: string }).targetCwd ?? cwd;
            const sm = SessionManager.create(targetCwd);
            const { session: newSession } = await createAgentSession({
              cwd: targetCwd,
              sessionManager: sm,
              modelRegistry: session.modelRegistry,
            });
            await setActiveSession(newSession);
          } catch (err) {
            console.error('[pi-ui] new_session error:', err);
          }
          break;
        }

        case 'switch_session': {
          try {
            const sm = SessionManager.open(msg.path);
            const { session: newSession } = await createAgentSession({
              cwd: sm.getCwd() || cwd,
              sessionManager: sm,
              modelRegistry: session.modelRegistry,
            });
            await setActiveSession(newSession);
          } catch (err) {
            console.error('[pi-ui] switch_session error:', err);
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

        case 'set_provider_key': {
          try {
            session.modelRegistry.authStorage.set(msg.provider, { type: 'api_key', key: msg.key });
            session.modelRegistry.refresh();
            ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
            broadcast({
              type: 'available_models_changed',
              availableModels: session.modelRegistry.getAvailable().map(serializeModel),
            });
          } catch (err) {
            console.error('[pi-ui] set_provider_key error:', err);
            ws.send(JSON.stringify({ type: 'providers_error', message: String(err) }));
          }
          break;
        }

        case 'remove_provider_key': {
          try {
            session.modelRegistry.authStorage.remove(msg.provider);
            session.modelRegistry.refresh();
            ws.send(JSON.stringify({ type: 'providers_list', providers: getProviders() }));
            broadcast({
              type: 'available_models_changed',
              availableModels: session.modelRegistry.getAvailable().map(serializeModel),
            });
          } catch (err) {
            console.error('[pi-ui] remove_provider_key error:', err);
            ws.send(JSON.stringify({ type: 'providers_error', message: String(err) }));
          }
          break;
        }

        case 'rename_session': {
          try {
            const sm = SessionManager.open(msg.path);
            sm.appendSessionInfo(msg.name);
            // If renaming the active session, also fire the SDK event so all
            // connected browsers see the name change via session_info_changed.
            if (msg.path === session.sessionFile) {
              session.setSessionName(msg.name);
            }
            const list = await SessionManager.list(cwd);
            ws.send(JSON.stringify({ type: 'sessions_list', sessions: list.slice(0, 30).map(serializeSession) }));
          } catch (err) {
            console.error('[pi-ui] rename_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }

        case 'rename_current_session': {
          try {
            // Set the name on the live session (emits session_info_changed to all browsers)
            session.setSessionName(msg.name);
            // Also persist it to the session file if available
            if (session.sessionFile) {
              const sm = SessionManager.open(session.sessionFile);
              sm.appendSessionInfo(msg.name);
            }
          } catch (err) {
            console.error('[pi-ui] rename_current_session error:', err);
          }
          break;
        }

        case 'delete_session': {
          try {
            // Guard against deleting the active session
            const list = await SessionManager.list(cwd);
            const target = list.find((s) => s.path === msg.path);
            if (target && target.id === session.sessionId) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Cannot delete the active session.' }));
              break;
            }
            await rm(msg.path);
            const updated = await SessionManager.list(cwd);
            ws.send(JSON.stringify({ type: 'sessions_list', sessions: updated.slice(0, 30).map(serializeSession) }));
          } catch (err) {
            console.error('[pi-ui] delete_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }

        case 'get_all_sessions': {
          try {
            const all = await SessionManager.listAll();
            ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: all.map(serializeSession) }));
          } catch (err) {
            console.error('[pi-ui] get_all_sessions error:', err);
            ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
          }
          break;
        }

        case 'dir_complete': {
          try {
            const prefix = (msg as { type: 'dir_complete'; prefix: string }).prefix;
            const { readdir } = await import('node:fs/promises');
            const { dirname, basename, join } = await import('node:path');
            const isDir = prefix.endsWith('/');
            const dir = isDir ? prefix : dirname(prefix);
            const fragment = isDir ? '' : basename(prefix).toLowerCase();
            let entries: string[] = [];
            try {
              const dirents = await readdir(dir, { withFileTypes: true });
              entries = dirents
                .filter((d) => d.isDirectory() && (fragment === '' || d.name.toLowerCase().startsWith(fragment)))
                .map((d) => join(dir, d.name) + '/')
                .slice(0, 20);
            } catch {
              entries = [];
            }
            ws.send(JSON.stringify({ type: 'dir_completions', prefix, entries }));
          } catch (err) {
            console.error('[pi-ui] dir_complete error:', err);
          }
          break;
        }

        case 'compact': {
          session.compact().catch((err) => {
            console.error('[pi-ui] compact error:', err);
          });
          break;
        }

        case 'set_auto_compaction': {
          session.setAutoCompactionEnabled(msg.enabled);
          break;
        }

        case 'set_auto_retry': {
          session.setAutoRetryEnabled(msg.enabled);
          break;
        }

        case 'get_fork_points': {
          try {
            const entries = session.getUserMessagesForForking();
            ws.send(JSON.stringify({ type: 'fork_points', entries }));
          } catch (err) {
            console.error('[pi-ui] get_fork_points error:', err);
            ws.send(JSON.stringify({ type: 'fork_points', entries: [] }));
          }
          break;
        }

        case 'get_tools': {
          try {
            const allTools = session.getAllTools();
            const activeNames = session.getActiveToolNames();
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
            console.error('[pi-ui] get_tools error:', err);
          }
          break;
        }

        case 'set_active_tools': {
          try {
            session.setActiveToolsByName(msg.toolNames as string[]);
          } catch (err) {
            console.error('[pi-ui] set_active_tools error:', err);
          }
          break;
        }

        case 'get_resources': {
          try {
            const sessionCwd = session.sessionManager.getCwd() || cwd;
            const agentDir = getAgentDir();
            const loader = new DefaultResourceLoader({ cwd: sessionCwd, agentDir });
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
            console.error('[pi-ui] get_resources error:', err);
            ws.send(JSON.stringify({ type: 'resources_list', skills: [], prompts: [] }));
          }
          break;
        }

        case 'install_skill': {
          try {
            const rawUrl = resolveGitHubRawUrl(msg.url as string);
            const res = await fetch(rawUrl);
            if (!res.ok) {
              ws.send(JSON.stringify({ type: 'skill_install_result', success: false, error: `HTTP ${res.status}: ${res.statusText}` }));
              break;
            }
            const content = await res.text();
            const fileName = basename(rawUrl.split('?')[0]);
            const safeFileName = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
            const sessionCwd = session.sessionManager.getCwd() || cwd;
            const destDir = (msg.scope as string) === 'user'
              ? join(getAgentDir(), 'skills')
              : resolve(sessionCwd, PI_CONFIG_DIR, 'skills');
            await mkdir(destDir, { recursive: true });
            const destPath = join(destDir, safeFileName);
            await writeFile(destPath, content, 'utf8');
            // Extract skill name from frontmatter or filename
            const nameMatch = content.match(/^---[\s\S]*?^name:\s*(.+)$/m);
            const skillName = nameMatch ? nameMatch[1].trim() : safeFileName.replace(/\.md$/, '');
            ws.send(JSON.stringify({ type: 'skill_install_result', success: true, name: skillName }));
          } catch (err) {
            console.error('[pi-ui] install_skill error:', err);
            ws.send(JSON.stringify({ type: 'skill_install_result', success: false, error: String(err) }));
          }
          break;
        }

        case 'fork_session': {
          try {
            const newPath = session.sessionManager.createBranchedSession(msg.entryId);
            if (!newPath) {
              ws.send(JSON.stringify({ type: 'sessions_error', message: 'Fork failed: session is not persisted.' }));
              break;
            }
            const forkedSm = SessionManager.open(newPath);
            const { session: forkedSession } = await createAgentSession({
              cwd: forkedSm.getCwd() || cwd,
              sessionManager: forkedSm,
              modelRegistry: session.modelRegistry,
            });
            await setActiveSession(forkedSession);
          } catch (err) {
            console.error('[pi-ui] fork_session error:', err);
            ws.send(JSON.stringify({ type: 'sessions_error', message: String(err) }));
          }
          break;
        }
      } // end switch
      } catch (err) {
        console.error('[pi-ui] WS message handler error:', err);
      }
    },

    close(ws) {
      ws.unsubscribe(WS_TOPIC);
    },

    idleTimeout: 120,
    perMessageDeflate: true,
  },
});

// ── 6. Wire up broadcast and initial subscription ─────────────────────────────

broadcast = (payload) => server.publish(WS_TOPIC, JSON.stringify(payload));

unsubscribePi = session.subscribe((event) => {
  broadcast(event);
});

console.log(`[pi-ui] Listening on http://localhost:${PORT}`);
