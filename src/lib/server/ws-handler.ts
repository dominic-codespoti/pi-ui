import { mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, basename, dirname, relative } from 'node:path';
import type { ClientMessage, UpdateTarget, ProviderInfo } from '$lib/ws/protocol';
import type { AgentSession, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { Model } from '@earendil-works/pi-ai';
import {
  expandTilde, isInsideWorkspace, activeCwd, serializeModel, serializeSession,
  resolveGitHubRawUrl, ALLOWED_SKILL_HOSTS, SKIP_DIRS,
} from './ws-helpers';

export interface ManagedSession {
  session: AgentSession;
  forwardingUnsub: (() => void) | null;
  runtimeUnsub: (() => void) | null;
  cwd: string;
  path: string | null;
  createdAt: number;
  isRunning: boolean;
  unseen: boolean;
  lastActivity: number;
}

export interface WSHandlerContext {
  activeSession(): AgentSession;
  activeSessionOrNull(): AgentSession | null;
  ensureSession(): Promise<AgentSession>;
  _sdk: unknown;
  cwd: string;
  activeSessionId: string | null;
  sessionPool: Map<string, ManagedSession>;
  APP_ROOT: string;
  UI_VERSION: string;
  UI_PACKAGE_NAME: string;
  PI_SDK_VERSION: string;
  PI_SDK_PACKAGE_NAME: string;
  broadcast(payload: unknown): void;
  broadcastProjects(): Promise<void>;
  broadcastSessionRuntime(sid: string, entry: ManagedSession): void;
  setActiveSession(session: AgentSession, newCwd?: string): Promise<void>;
  touchProject(path: string): void;
  removeProject(path: string): boolean;
  setProjectPinned(path: string, pinned: boolean): void;
  renameProject(path: string, name: string): void;
  pendingExtensionRequests: Map<string, { resolve: (r: Record<string, unknown>) => void }>;
  pendingEditorTextRequests: Map<string, { resolve: (text: string) => void }>;
  interactiveCustomComponents: Map<string, unknown>;
  autocompleteProviderWrappers: unknown[];
  chainedAutocompleteProvider: unknown | null;
  widgetFactories: Map<string, { factory: (...args: unknown[]) => unknown; intervalId: Timer; placement?: string }>;
  pendingRestartNonce: { current: string | null };
  updateInProgress: { current: boolean };
  getProviders(): ProviderInfo[];
  getUpdateStatus(): Promise<unknown>;
  runUpdate(target: UpdateTarget, ws: { send(data: string): void }): Promise<void>;
  sendSlashResult(ws: { send(data: string): void }, command: string, message: string, level?: 'info' | 'warning' | 'error'): void;
  uiContext: Omit<ExtensionUIContext, 'getEditorText'> & { getEditorText(): Promise<string> };
  broadcastCustomRender(id: string, component: { render(w: number): unknown }): void;
}

// Re-export so server.ts doesn't need to import them separately
export { expandTilde, isInsideWorkspace, activeCwd, serializeModel, serializeSession };
export { ALLOWED_SKILL_HOSTS, SKIP_DIRS };

export async function handleClientMessage(
  msg: ClientMessage,
  ws: { send(data: string): void },
  ctx: WSHandlerContext,
): Promise<void> {
  // Ensure SDK + session are loaded before dispatching any command.
  await ctx.ensureSession();

  switch (msg.type) {
    case 'prompt': {
      try {
        const s = ctx.activeSession();
        if (s.isStreaming) {
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
        await ctx.activeSession().steer(msg.message);
      } catch (err) {
        console.error('[pifrontier] steer error:', err);
        ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
      }
      break;

    case 'follow_up':
      try {
        await ctx.activeSession().followUp(msg.message);
      } catch (err) {
        console.error('[pifrontier] followUp error:', err);
        ws.send(JSON.stringify({ type: 'agent_error', error: String(err) }));
      }
      break;

    case 'abort': {
      const s = ctx.activeSession();
      const cleared = s.clearQueue();
      s.abortBash();
      await s.abort();
      const allQueued = [...cleared.steering, ...cleared.followUp];
      if (allQueued.length > 0) {
        ws.send(JSON.stringify({ type: 'queue_restored', text: allQueued.join('\n\n') }));
      }
      break;
    }

    case 'set_thinking_level':
      ctx.activeSession().setThinkingLevel(msg.level as Parameters<AgentSession['setThinkingLevel']>[0]);
      break;

    case 'set_model': {
      const model = ctx.activeSession().modelRegistry.find(msg.provider, msg.modelId);
      if (!model) {
        console.warn(`[pifrontier] set_model: model not found: ${msg.provider}/${msg.modelId}`);
        break;
      }
      try {
        await ctx.activeSession().setModel(model);
        ctx.broadcast({ type: 'model_changed', model: serializeModel(model) });
      } catch (err) {
        console.error('[pifrontier] set_model error:', err);
      }
      break;
    }

    case 'get_all_sessions': {
      try {
        const sdk = ctx._sdk as { SessionManager: { listAll(): Promise<unknown[]> } };
        const all = await sdk.SessionManager.listAll();
        const sessions = all.map(serializeSession);
        const current = serializeSession({
          id: ctx.activeSession().sessionId,
          path: ctx.activeSession().sessionManager.getSessionFile() ?? '(in-memory)',
          cwd: ctx.activeSession().sessionManager.getCwd() || ctx.cwd,
          name: ctx.activeSession().sessionManager.getSessionName() || undefined,
          created: Date.now(),
          modified: Date.now(),
          messageCount: ctx.activeSession().messages.length,
          firstMessage: (() => {
            const m0 = ctx.activeSession().messages[0] as { content?: string | Array<unknown> } | undefined;
            return m0?.content
              ? (typeof m0.content === 'string' ? m0.content.slice(0, 120) : '(complex)')
              : '';
          })(),
        });
        if (current && !sessions.some((s: { id: string }) => s.id === current.id)) {
          sessions.unshift(current);
        }
        ws.send(JSON.stringify({ type: 'all_sessions_list', sessions }));
      } catch (err) {
        console.error('[pifrontier] get_all_sessions error:', err);
        ws.send(JSON.stringify({ type: 'all_sessions_list', sessions: [] }));
      }
      break;
    }

    case 'get_projects':
      ws.send(JSON.stringify({ type: 'projects_list', projects: await ctx._sdk ? [] : [] }));
      break;

    case 'abort':
    case 'set_thinking_level':
    case 'set_model':
    case 'list_sessions':
    case 'new_session':
    case 'switch_session':
    case 'extension_ui_response':
    case 'extension_custom_input':
    case 'editor_text_response':
    case 'get_providers':
    case 'set_provider_key':
    case 'remove_provider_key':
    case 'rename_session':
    case 'rename_current_session':
    case 'delete_session':
    case 'compact':
    case 'set_auto_compaction':
    case 'set_auto_retry':
    case 'run_builtin':
    case 'get_session_tree':
    case 'get_fork_points':
    case 'get_tools':
    case 'set_active_tools':
    case 'get_resources':
    case 'get_command_completions':
    case 'get_extensions':
    case 'get_commands':
    case 'install_skill':
    case 'fork_session':
    case 'read_file':
    case 'write_file':
    case 'add_project':
    case 'remove_project':
    case 'pin_project':
    case 'rename_project':
    case 'dir_complete':
    case 'file_complete':
    case 'get_extension_autocomplete':
    case 'get_update_status':
    case 'run_update':
    case 'request_restart':
    case 'restart_server':
      // These are handled inline in server.ts or are not yet extracted
      break;

    default:
      break;
  }
}
