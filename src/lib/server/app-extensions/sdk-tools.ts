/**
 * Pi SDK `customTools` adapter for trusted app-extension agent tools.
 *
 * SERVER-ONLY: pure TypeScript with no filesystem, Bun, or WS dependencies.
 * Only the public SDK tool shape (`ToolDefinition`, `ExtensionContext`,
 * `AgentToolResult` as type-only imports) and TypeBox are used, so this stays
 * trivially unit-testable. Server composition passes the resulting definitions
 * to `createAgentSession*({ customTools })` after verifying them.
 *
 * Rules enforced here (mirroring `agent-tools.ts` and `app-extension-handlers.ts`):
 * - Only operations with `exposeToAgent === true` are mapped (via descriptors).
 * - `parameters` is a TypeBox schema preserving the descriptor's JSON-schema
 *   shape through `Type.Unsafe` — the SDK validates tool params against it.
 * - Scope is derived exclusively from the live `ctx.sessionManager`
 *   (`getCwd()`/`getSessionId()`) according to the descriptor's declared
 *   `scope` (`app` default). Tool params and global/selected/focused session
 *   state are never consulted — missing live context rejects instead of
 *   falling back.
 * - `signal` is honored like the built-in tools: pre-aborted calls reject
 *   without dispatching, the signal is forwarded to the descriptor context,
 *   and an abort racing the dispatch rejects with `Operation aborted` even
 *   when the handler ignores the signal.
 * - Success returns the SDK `AgentToolResult` shape with bounded JSON text
 *   output; failures throw a bounded `Error` (the SDK surfaces throws as
 *   error tool results). Size caps live here because this is the LLM-transport
 *   edge for agent calls.
 */

import { Type } from 'typebox';
import type { TSchema } from 'typebox';
import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { AppExtensionScope } from '../../app-extensions/types.ts';
import {
  buildAppExtensionAgentTools,
  type AppExtensionAgentToolDescriptor,
  type BuildAppExtensionAgentToolsOptions,
} from './agent-tools.ts';
import type { AppExtensionRuntime } from './runtime.ts';

/** JSON-encoded tool output is capped so one operation cannot blow up LLM context. */
export const APP_EXTENSION_SDK_TOOL_OUTPUT_LIMIT_BYTES = 128 * 1024;

/** Error strings thrown to the SDK are capped like the WS transport edge. */
export const APP_EXTENSION_SDK_TOOL_ERROR_LIMIT_CHARS = 2000;

const TRUNCATION_MARKER = '…(truncated)';

export type BuildSdkAppExtensionToolsOptions = BuildAppExtensionAgentToolsOptions;

/** Narrow live-session view used for scope derivation (subset of `ReadonlySessionManager`). */
export interface SdkAgentSessionManager {
  getCwd(): string;
  getSessionId(): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, Math.max(0, limit - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

function toErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message || String(err) : String(err);
  return boundText(raw, APP_EXTENSION_SDK_TOOL_ERROR_LIMIT_CHARS);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function readSessionManager(ctx: ExtensionContext): SdkAgentSessionManager {
  const manager = (ctx as ExtensionContext | undefined)?.sessionManager as
    | SdkAgentSessionManager
    | undefined;
  if (
    !manager ||
    typeof manager.getCwd !== 'function' ||
    typeof manager.getSessionId !== 'function'
  ) {
    throw new Error(
      'app extension agent tool requires a live ExtensionContext.sessionManager — scope is never inferred from tool params or global focus',
    );
  }
  return manager;
}

function readSessionId(manager: SdkAgentSessionManager): string | undefined {
  try {
    const id = manager.getSessionId();
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Derive the explicit call scope for one declared operation mode from the live
 * session manager. `app` needs nothing; `project` needs `getCwd()`;
 * `session` needs `getSessionId()` (plus `getCwd()` when available, mirroring
 * the WS handler's `{ sessionId }` vs `{ projectId, sessionId }` shape).
 * Throws instead of inventing a fallback.
 */
export function resolveSdkScope(
  declared: 'app' | 'project' | 'session' | undefined,
  sessionManager: SdkAgentSessionManager,
): AppExtensionScope {
  const mode = declared ?? 'app';
  if (mode === 'app') return {};
  if (mode === 'project') {
    const cwd = sessionManager.getCwd();
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new Error(
        'project-scoped app extension operation requires a live session cwd — it is never inferred from global or focused state',
      );
    }
    return { projectId: cwd };
  }
  const sessionId = sessionManager.getSessionId();
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(
      'session-scoped app extension operation requires a live session id — it is never inferred from global or focused state',
    );
  }
  const cwd = sessionManager.getCwd();
  if (typeof cwd === 'string' && cwd.length > 0) {
    return { projectId: cwd, sessionId };
  }
  return { sessionId };
}

/**
 * Convert a descriptor `inputSchema` (JSON-schema-shaped metadata) to a
 * TypeBox `parameters` schema without re-interpreting it. The fallback
 * descriptor schema (`{ type: 'object', additionalProperties: true }`) stays a
 * generic object.
 */
export function toSdkToolParameters(inputSchema: Record<string, unknown>): TSchema {
  return Type.Unsafe(inputSchema) as unknown as TSchema;
}

/**
 * Format a raw handler result as a bounded SDK `AgentToolResult`. Text output
 * is the JSON encoding (truncated with a marker above the byte cap); details
 * carry the raw value when small, otherwise a bounded preview so neither the
 * LLM text nor structured details can grow without bound. Throws a bounded
 * error for unserializable values.
 */
export function toSdkAgentToolResult(
  descriptor: Pick<AppExtensionAgentToolDescriptor, 'extensionId' | 'operationId' | 'name'>,
  raw: unknown,
): AgentToolResult<unknown> {
  let encoded: string;
  try {
    encoded = JSON.stringify(raw) ?? 'null';
  } catch (err) {
    throw new Error(
      boundText(
        `app extension "${descriptor.extensionId}:${descriptor.operationId}" result is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
        APP_EXTENSION_SDK_TOOL_ERROR_LIMIT_CHARS,
      ),
      { cause: err },
    );
  }
  const bytes = byteLength(encoded);
  if (bytes <= APP_EXTENSION_SDK_TOOL_OUTPUT_LIMIT_BYTES) {
    return { content: [{ type: 'text', text: encoded }], details: raw as unknown };
  }
  const text = boundText(encoded, APP_EXTENSION_SDK_TOOL_OUTPUT_LIMIT_BYTES);
  return {
    content: [{ type: 'text', text }],
    details: { truncated: true, preview: text } as unknown,
  };
}

function toSdkError(
  descriptor: Pick<AppExtensionAgentToolDescriptor, 'extensionId' | 'operationId'>,
  err: unknown,
): Error {
  if (err instanceof Error && err.message === 'Operation aborted') return err;
  return new Error(
    boundText(
      `app extension "${descriptor.extensionId}:${descriptor.operationId}" failed: ${toErrorMessage(err)}`,
      APP_EXTENSION_SDK_TOOL_ERROR_LIMIT_CHARS + 120,
    ),
    { cause: err },
  );
}

function toSdkTool(
  descriptor: AppExtensionAgentToolDescriptor,
): ToolDefinition<TSchema, unknown> {
  return {
    name: descriptor.name,
    label: descriptor.label,
    description: descriptor.description,
    parameters: toSdkToolParameters(descriptor.inputSchema),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> => {
      if (signal?.aborted) throw new Error('Operation aborted');
      const sessionManager = readSessionManager(ctx);
      let scope: AppExtensionScope;
      try {
        scope = resolveSdkScope(descriptor.scope ?? 'app', sessionManager);
      } catch (err) {
        throw new Error(toSdkError(descriptor, err).message, { cause: err });
      }
      const sessionId = readSessionId(sessionManager);
      const input = isRecord(params) ? (params as Record<string, unknown>) : {};
      const session = { scope, ...(sessionId !== undefined ? { sessionId } : {}) };

      let onAbort: (() => void) | undefined;
      const abortPromise =
        signal !== undefined
          ? new Promise<never>((_, reject) => {
              onAbort = () => reject(new Error('Operation aborted'));
              signal.addEventListener('abort', onAbort, { once: true });
            })
          : undefined;
      try {
        const dispatch = descriptor.execute(input, signal, session);
        const raw =
          abortPromise !== undefined ? await Promise.race([dispatch, abortPromise]) : await dispatch;
        if (signal?.aborted) throw new Error('Operation aborted');
        return toSdkAgentToolResult(descriptor, raw);
      } catch (err) {
        if (signal?.aborted) throw new Error('Operation aborted', { cause: err });
        throw new Error(toSdkError(descriptor, err).message, { cause: err });
      } finally {
        if (signal !== undefined && onAbort !== undefined) {
          signal.removeEventListener('abort', onAbort);
        }
      }
    },
  } as unknown as ToolDefinition<TSchema, unknown>;
}

/**
 * Build live SDK `customTools` definitions for every agent-visible extension
 * operation. Sorted by tool name (descriptors already are) so output is stable
 * regardless of registration order. Pass `createContext` through to let server
 * composition inject the shared validated `AppExtensionExecutionContext`.
 */
export interface BuiltSdkAppExtensionTools {
  tools: ToolDefinition[];
  /** Human-readable per-extension skip notices for session diagnostics. */
  warnings: string[];
}

export function buildSdkAppExtensionTools(
  runtime: AppExtensionRuntime,
  options?: BuildSdkAppExtensionToolsOptions,
): BuiltSdkAppExtensionTools {
  const { tools: descriptors, skipped } = buildAppExtensionAgentTools(
    runtime,
    options?.createContext !== undefined ? { createContext: options.createContext } : undefined,
  );
  return {
    tools: descriptors.map((descriptor) => toSdkTool(descriptor) as unknown as ToolDefinition),
    warnings: skipped.map(
      (entry) => `App extension "${entry.extensionId}" agent tools skipped: ${entry.message}`
    ),
  };
}
