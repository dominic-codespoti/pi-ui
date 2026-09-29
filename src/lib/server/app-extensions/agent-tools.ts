/**
 * Pure app-operation-to-agent-tool adapter for trusted app extensions.
 *
 * SERVER-ONLY but framework-neutral: pure TypeScript with no filesystem,
 * Bun, Pi SDK, TypeBox, or Valibot dependencies so it stays trivially
 * unit-testable. The parent layer adapts these descriptors to the public
 * SDK tool API (TypeBox params, SDK execute signature) after verifying it.
 *
 * Rules enforced here:
 * - Only operations from enabled extensions with `exposeToAgent === true`.
 * - Deterministic tool names (`app_<extension>_<operation>`, lowercased,
 *   non-`[a-z0-9_]` chars replaced with `_`). Empty/overlong results and
 *   collisions across the whole runtime throw instead of silently winning.
 * - Execution calls the same runtime `read`/`invoke` dispatch with an
 *   explicitly supplied scope and `caller: { kind: 'agent', sessionId? }`.
 *   Scope is never inferred from global or focused session state — `execute`
 *   without an explicit scope rejects.
 * - Results and errors pass through unchanged. Size caps/truncation belong
 *   at the transport edge, mirroring the runtime's contract.
 */

import type {
  AppExtensionCallContext,
  AppExtensionScope,
} from '../../app-extensions/types.ts';
import type { AppExtensionRuntime } from './runtime.ts';

export type AppExtensionAgentToolErrorCode =
  | 'invalid-name'
  | 'duplicate-name'
  | 'missing-scope';

export class AppExtensionAgentToolError extends Error {
  readonly code: AppExtensionAgentToolErrorCode;
  constructor(code: AppExtensionAgentToolErrorCode, message: string) {
    super(message);
    this.name = 'AppExtensionAgentToolError';
    this.code = code;
  }
}

/** Session context supplied per execution — scope is always explicit. */
export interface AppExtensionAgentToolSession {
  scope: AppExtensionScope;
  sessionId?: string;
}

/**
 * Optional context factory for descriptor execution.
 *
 * Lets server composition inject the shared validated
 * `AppExtensionExecutionContext` (built via
 * `createAppExtensionExecutionContext`) instead of the default bare
 * `AppExtensionCallContext`. The factory receives the already-validated
 * explicit scope/caller/signal and returns the full call context for the
 * runtime dispatch. `AppExtensionExecutionContext` extends
 * `AppExtensionCallContext`, so returning it type-checks as the base.
 */
export type AppExtensionAgentToolContextFactory = (args: {
  extensionId: string;
  operationId: string;
  scope: AppExtensionScope;
  sessionId?: string;
  signal?: AbortSignal;
}) => AppExtensionCallContext | Promise<AppExtensionCallContext>;

export interface BuildAppExtensionAgentToolsOptions {
  createContext?: AppExtensionAgentToolContextFactory;
}

/**
 * Framework-neutral agent tool descriptor. Generic on purpose: the parent
 * converts `inputSchema` to a TypeBox schema and `execute` to the SDK tool
 * `execute(toolCallId, params, signal, onUpdate, ctx)` shape.
 */
export interface AppExtensionAgentToolDescriptor {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly extensionId: string;
  readonly operationId: string;
  readonly kind: 'read' | 'action';
  readonly scope: 'app' | 'project' | 'session';
  readonly inputSchema: Record<string, unknown>;
  execute(
    input?: Record<string, unknown>,
    signalOrSession?: AbortSignal | AppExtensionAgentToolSession,
    session?: AppExtensionAgentToolSession,
  ): Promise<unknown>;
}

/** Tool names stay well under LLM function-name limits while allowing long ids. */
export const APP_EXTENSION_AGENT_TOOL_MAX_NAME_LENGTH = 128;

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

const FALLBACK_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { aborted?: unknown }).aborted === 'boolean' &&
    typeof (value as { addEventListener?: unknown }).addEventListener === 'function'
  );
}

function isSessionObject(value: unknown): value is AppExtensionAgentToolSession {
  return isRecord(value) && !isAbortSignalLike(value) && 'scope' in value;
}

/**
 * Deterministic, namespaced tool name for an extension operation.
 * Throws `invalid-name` on empty/blank ids or overlong results.
 */
export function toAgentToolName(extensionId: string, operationId: string): string {
  if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
    throw new AppExtensionAgentToolError(
      'invalid-name',
      `agent tool name requires a non-empty extension id (got ${JSON.stringify(extensionId)})`,
    );
  }
  if (typeof operationId !== 'string' || operationId.trim().length === 0) {
    throw new AppExtensionAgentToolError(
      'invalid-name',
      `agent tool name requires a non-empty operation id for extension "${extensionId}"`,
    );
  }
  const name = `app_${extensionId}_${operationId}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (name.length > APP_EXTENSION_AGENT_TOOL_MAX_NAME_LENGTH) {
    throw new AppExtensionAgentToolError(
      'invalid-name',
      `agent tool name "${name}" exceeds ${APP_EXTENSION_AGENT_TOOL_MAX_NAME_LENGTH} characters`,
    );
  }
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new AppExtensionAgentToolError('invalid-name', `agent tool name "${name}" is not usable`);
  }
  return name;
}

function resolveInputSchema(schema: unknown): Record<string, unknown> {
  if (isRecord(schema)) return { ...schema };
  return { ...FALLBACK_INPUT_SCHEMA };
}

function normalizeExecuteArgs(
  signalOrSession?: AbortSignal | AppExtensionAgentToolSession,
  sessionMaybe?: AppExtensionAgentToolSession,
): { signal?: AbortSignal; session?: AppExtensionAgentToolSession } {
  // The session may be passed as the second argument (no signal).
  if (sessionMaybe !== undefined) {
    return { signal: signalOrSession as AbortSignal | undefined, session: sessionMaybe };
  }
  if (isSessionObject(signalOrSession)) {
    return { session: signalOrSession };
  }
  return {
    signal: signalOrSession as AbortSignal | undefined,
    session: undefined,
  };
}

async function executeAgentTool(
  runtime: AppExtensionRuntime,
  extensionId: string,
  operationId: string,
  kind: 'read' | 'action',
  input?: Record<string, unknown>,
  signalOrSession?: AbortSignal | AppExtensionAgentToolSession,
  sessionMaybe?: AppExtensionAgentToolSession,
  createContext?: AppExtensionAgentToolContextFactory,
): Promise<unknown> {
  const { signal, session } = normalizeExecuteArgs(signalOrSession, sessionMaybe);
  if (!session || !isRecord(session.scope)) {
    throw new AppExtensionAgentToolError(
      'missing-scope',
      `agent tool "${toAgentToolName(extensionId, operationId)}" requires an explicit scope — it is never inferred from global or focused session state`,
    );
  }
  const sessionId =
    typeof session.sessionId === 'string' && session.sessionId.length > 0
      ? session.sessionId
      : undefined;
  let ctx: AppExtensionCallContext;
  if (createContext !== undefined) {
    const produced = await createContext({
      extensionId,
      operationId,
      scope: session.scope,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    ctx =
      signal !== undefined && (produced as AppExtensionCallContext).signal === undefined
        ? { ...(produced as AppExtensionCallContext), signal }
        : (produced as AppExtensionCallContext);
  } else {
    ctx = {
      scope: session.scope,
      caller: sessionId !== undefined ? { kind: 'agent', sessionId } : { kind: 'agent' },
      ...(signal !== undefined ? { signal } : {}),
    };
  }
  const args = input ?? {};
  return kind === 'read'
    ? await runtime.read(extensionId, operationId, args, ctx)
    : await runtime.invoke(extensionId, operationId, args, ctx);
}

/**
 * Build deterministic agent tool descriptors for every enabled extension
 * operation with `exposeToAgent === true`. Sorted by tool name so output is
 * stable regardless of registration order. Throws on colliding or invalid
 * generated names.
 */
/** One extension's agent tools could not be built (the rest still register). */
export interface SkippedAppExtensionAgentTools {
  extensionId: string;
  message: string;
}

export interface BuiltAppExtensionAgentTools {
  tools: AppExtensionAgentToolDescriptor[];
  skipped: SkippedAppExtensionAgentTools[];
}

/**
 * Build agent tool descriptors for every enabled extension exposing operations.
 * Isolation is per extension: a bad (colliding/unusable) name skips that
 * extension with a recorded message instead of aborting the whole list, so
 * one broken package can never take down every other extension's tools.
 * First registration wins a colliding name; the loser is skipped.
 */
export function buildAppExtensionAgentTools(
  runtime: AppExtensionRuntime,
  options?: BuildAppExtensionAgentToolsOptions,
): BuiltAppExtensionAgentTools {
  const tools: AppExtensionAgentToolDescriptor[] = [];
  const skipped: SkippedAppExtensionAgentTools[] = [];
  const seen = new Map<string, { extensionId: string; operationId: string }>();
  for (const summary of runtime.list()) {
    if (!summary.enabled) continue;
    const extensionId = summary.id;
    const before = tools.length;
    try {
      for (const op of runtime.operations(extensionId)) {
        if (op.exposeToAgent !== true) continue;
        const name = toAgentToolName(extensionId, op.id);
        const clash = seen.get(name);
        if (clash) {
          throw new AppExtensionAgentToolError(
            'duplicate-name',
            `agent tool name "${name}" collides: ${clash.extensionId}:${clash.operationId} vs ${extensionId}:${op.id} (rename an operation to fix)`,
          );
        }
        seen.set(name, { extensionId, operationId: op.id });
        const kind = op.kind;
        const operationId = op.id;
        const description = op.description;
        const scope = op.scope ?? 'app';
        tools.push({
          name,
          label: `${extensionId} ${operationId}`,
          description,
          extensionId,
          operationId,
          kind,
          scope,
          inputSchema: resolveInputSchema(op.inputSchema),
          execute: (
            input?: Record<string, unknown>,
            signalOrSession?: AbortSignal | AppExtensionAgentToolSession,
            sessionMaybe?: AppExtensionAgentToolSession,
          ) =>
            executeAgentTool(
              runtime,
              extensionId,
              operationId,
              kind,
              input,
              signalOrSession,
              sessionMaybe,
              options?.createContext,
            ),
        });
      }
    } catch (err) {
      // Drop this extension's partial tools and its claimed names so later
      // extensions are unaffected; the failure is recorded, not thrown.
      for (let i = tools.length - 1; i >= before; i--) tools.splice(i, 1);
      for (const [name, ref] of seen) {
        if (ref.extensionId === extensionId) seen.delete(name);
      }
      skipped.push({
        extensionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { tools, skipped };
}
