/**
 * Valibot schemas for WebSocket messages sent from server to client.
 * Provides safe, non-throwing validation with forward-compatible SDK fallback.
 */

import * as v from 'valibot';
// ── Shared Sub-Schemas ────────────────────────────────────────────────────────

import type { TreeNode } from './protocol.js';

export const ModelInfoSchema = v.looseObject({
  provider: v.string(),
  id: v.string(),
  name: v.string(),
  reasoning: v.boolean(),
  contextWindow: v.optional(v.number()),
  thinkingLevelMap: v.optional(v.record(v.string(), v.nullable(v.string()))),
});

export const ContextUsageSchema = v.looseObject({
  tokens: v.nullable(v.number()),
  contextWindow: v.number(),
  percent: v.nullable(v.number()),
});

export const SessionSummarySchema = v.looseObject({
  id: v.string(),
  path: v.string(),
  cwd: v.string(),
  name: v.optional(v.string()),
  created: v.number(),
  modified: v.number(),
  messageCount: v.number(),
  turns: v.optional(v.number()),
  parentSession: v.optional(v.string()),
  firstMessage: v.string(),
});

export const ProjectInfoSchema = v.looseObject({
  cwd: v.string(),
  name: v.string(),
  pinned: v.boolean(),
  exists: v.boolean(),
  registered: v.boolean(),
  sessionCount: v.number(),
  lastActivity: v.number(),
});

export const ProviderInfoSchema = v.looseObject({
  id: v.string(),
  name: v.string(),
  configured: v.boolean(),
  source: v.optional(v.string()),
  modelCount: v.number(),
});

export const SkillSummarySchema = v.looseObject({
  name: v.string(),
  description: v.string(),
  scope: v.string(),
  isBuiltin: v.boolean(),
  source: v.string(),
});

export const PromptSummarySchema = v.looseObject({
  name: v.string(),
  description: v.string(),
  argumentHint: v.optional(v.string()),
  scope: v.string(),
  isBuiltin: v.boolean(),
  source: v.string(),
});

export const ExtensionFlagInfoSchema = v.looseObject({
  name: v.string(),
  description: v.optional(v.string()),
  type: v.union([v.literal('boolean'), v.literal('string')]),
  default: v.optional(v.union([v.boolean(), v.string()])),
  value: v.optional(v.union([v.boolean(), v.string()])),
});

export const ExtensionShortcutInfoSchema = v.looseObject({
  shortcut: v.string(),
  description: v.optional(v.string()),
  source: v.string(),
});

export const ExtensionDiagnosticSchema = v.looseObject({
  type: v.union([v.literal('warning'), v.literal('error'), v.literal('collision')]),
  message: v.string(),
  path: v.optional(v.string()),
});

export const ProjectTrustDecisionSchema = v.union([
  v.literal('trusted'),
  v.literal('denied'),
  v.literal('session'),
  v.literal('ask'),
]);

export const ProjectTrustInfoSchema = v.looseObject({
  cwd: v.string(),
  decision: ProjectTrustDecisionSchema,
  requiresDecision: v.boolean(),
  persisted: v.boolean(),
});

export const RuntimeDiagnosticSchema = v.looseObject({
  type: v.union([v.literal('info'), v.literal('warning'), v.literal('error')]),
  message: v.string(),
});

export const ExtensionSummarySchema = v.looseObject({
  source: v.string(),
  path: v.string(),
  scope: v.union([v.literal('user'), v.literal('project'), v.literal('temporary')]),
  origin: v.union([v.literal('package'), v.literal('top-level')]),
  tools: v.array(v.looseObject({ name: v.string(), description: v.string() })),
  commands: v.array(v.looseObject({ name: v.string(), description: v.string() })),
  flags: v.optional(v.array(ExtensionFlagInfoSchema)),
  shortcuts: v.optional(v.array(ExtensionShortcutInfoSchema)),
  diagnostics: v.optional(v.array(ExtensionDiagnosticSchema)),
});

export const SessionStatsSchema = v.looseObject({
  sessionId: v.string(),
  sessionFile: v.optional(v.string()),
  userMessages: v.number(),
  assistantMessages: v.number(),
  toolCalls: v.number(),
  toolResults: v.number(),
  totalMessages: v.number(),
  tokens: v.looseObject({
    input: v.number(),
    output: v.number(),
    cacheRead: v.number(),
    cacheWrite: v.number(),
    total: v.number(),
  }),
  cost: v.number(),
});

export const UpdatePackageStatusSchema = v.looseObject({
  name: v.string(),
  current: v.string(),
  latest: v.optional(v.string()),
  updateAvailable: v.optional(v.boolean()),
  error: v.optional(v.string()),
});

export const UpdateStatusSchema = v.looseObject({
  appRoot: v.string(),
  mode: v.union([v.literal('source'), v.literal('package'), v.literal('ephemeral')]),
  updateCommand: v.optional(v.string()),
  busy: v.boolean(),
  canUpdateUi: v.boolean(),
  canUpdateSdk: v.boolean(),
  ui: UpdatePackageStatusSchema,
  sdk: UpdatePackageStatusSchema,
  notes: v.array(v.string()),
});

export const TreeNodeSchema: v.GenericSchema<TreeNode> = v.looseObject({
  entryId: v.string(),
  type: v.string(),
  role: v.optional(v.string()),
  text: v.optional(v.string()),
  label: v.optional(v.string()),
  children: v.array(v.lazy(() => TreeNodeSchema)),
});

// ── Connected Message Schema ──────────────────────────────────────────────────

export const ConnectedMessageSchema = v.looseObject({
  type: v.literal('connected'),
  sessionId: v.string(),
  isStreaming: v.boolean(),
  thinkingLevel: v.string(),
  model: v.nullable(ModelInfoSchema),
  availableModels: v.array(ModelInfoSchema),
  messages: v.array(v.unknown()),
  streamingMessage: v.optional(v.unknown()),
  totalMessageCount: v.optional(v.number()),
  messagesTruncated: v.optional(v.boolean()),
  cwd: v.optional(v.string()),
  sessionName: v.optional(v.string()),
  isCompacting: v.optional(v.boolean()),
  autoCompactionEnabled: v.optional(v.boolean()),
  autoRetryEnabled: v.optional(v.boolean()),
  pushVapidKey: v.optional(v.nullable(v.string())),
  piVersion: v.optional(v.string()),
  uiVersion: v.optional(v.string()),
  sessionMode: v.optional(v.union([v.literal('in-memory'), v.literal('persisted')])),
  sessionPath: v.optional(v.string()),
  contextUsage: v.optional(ContextUsageSchema),
  webhookUrl: v.optional(v.string()),
  extensionUiState: v.optional(v.unknown()),
  projectTrust: v.optional(ProjectTrustInfoSchema),
  diagnostics: v.optional(v.array(RuntimeDiagnosticSchema)),
  modelFallbackMessage: v.optional(v.string()),
  tools: v.optional(
    v.array(
      v.looseObject({
        name: v.string(),
        description: v.string(),
        isBuiltin: v.boolean(),
        origin: v.optional(v.string()),
      })
    )
  ),
  activeToolNames: v.optional(v.array(v.string())),
});
// ── Custom Server Event Schemas ──────────────────────────────────────────────

export const SessionLoadedSchema = v.looseObject({
  type: v.literal('session_loaded'),
  sessionId: v.string(),
  isStreaming: v.boolean(),
  thinkingLevel: v.string(),
  model: v.nullable(ModelInfoSchema),
  availableModels: v.array(ModelInfoSchema),
  messages: v.array(v.unknown()),
  streamingMessage: v.optional(v.unknown()),
  totalMessageCount: v.optional(v.number()),
  messagesTruncated: v.optional(v.boolean()),
  cwd: v.optional(v.string()),
  sessionName: v.optional(v.string()),
  isCompacting: v.optional(v.boolean()),
  autoCompactionEnabled: v.optional(v.boolean()),
  autoRetryEnabled: v.optional(v.boolean()),
  queuedSteering: v.optional(v.array(v.string())),
  queuedFollowUp: v.optional(v.array(v.string())),
  piVersion: v.optional(v.string()),
  uiVersion: v.optional(v.string()),
  sessionMode: v.optional(v.union([v.literal('in-memory'), v.literal('persisted')])),
  sessionPath: v.optional(v.string()),
  requestId: v.optional(v.string()),
  projectTrust: v.optional(ProjectTrustInfoSchema),
  diagnostics: v.optional(v.array(RuntimeDiagnosticSchema)),
  modelFallbackMessage: v.optional(v.string()),
  contextUsage: v.optional(ContextUsageSchema),
  tools: v.optional(
    v.array(
      v.looseObject({
        name: v.string(),
        description: v.string(),
        isBuiltin: v.boolean(),
        origin: v.optional(v.string()),
      })
    )
  ),
  activeToolNames: v.optional(v.array(v.string())),
});

export const SessionsErrorSchema = v.looseObject({
  type: v.literal('sessions_error'),
  message: v.string(),
  requestId: v.optional(v.string()),
});

export const ModelChangedSchema = v.looseObject({
  type: v.literal('model_changed'),
  model: v.nullable(ModelInfoSchema),
  thinkingLevel: v.optional(v.string()),
});

export const ThinkingLevelChangedSchema = v.looseObject({
  type: v.literal('thinking_level_changed'),
  level: v.string(),
});

export const AvailableModelsChangedSchema = v.looseObject({
  type: v.literal('available_models_changed'),
  availableModels: v.array(ModelInfoSchema),
  sessionId: v.optional(v.string()),
});

export const OlderMessagesSchema = v.looseObject({
  type: v.literal('older_messages'),
  messages: v.array(v.unknown()),
  totalMessageCount: v.number(),
  messagesTruncated: v.boolean(),
});

export const SessionRuntimeSchema = v.looseObject({
  type: v.literal('session_runtime'),
  sessionId: v.string(),
  isRunning: v.boolean(),
  unseen: v.boolean(),
  lastActivity: v.number(),
});

export const ExtensionTerminalInputResultSchema = v.looseObject({
  type: v.literal('extension_terminal_input_result'),
  id: v.string(),
  consumed: v.boolean(),
  data: v.optional(v.string()),
  sessionId: v.optional(v.string()),
});

export const FileContentSchema = v.looseObject({
  type: v.literal('file_content'),
  path: v.string(),
  content: v.string(),
  error: v.optional(v.string()),
});

export const FileSavedSchema = v.looseObject({
  type: v.literal('file_saved'),
  path: v.string(),
  error: v.optional(v.string()),
});

export const SlashResultSchema = v.looseObject({
  type: v.literal('slash_result'),
  command: v.string(),
  message: v.string(),
  level: v.optional(v.union([v.literal('info'), v.literal('warning'), v.literal('error')])),
});

export const SettingsSchema = v.looseObject({
  type: v.literal('settings'),
  settings: v.record(v.string(), v.unknown()),
});

export const NotificationWebhookUrlSchema = v.looseObject({
  type: v.literal('notification_webhook_url'),
  url: v.nullable(v.string()),
});

// Additional custom events defined in protocol.ts
export const SessionsListSchema = v.looseObject({
  type: v.literal('sessions_list'),
  sessions: v.array(SessionSummarySchema),
});

export const AllSessionsListSchema = v.looseObject({
  type: v.literal('all_sessions_list'),
  sessions: v.array(SessionSummarySchema),
});

export const SessionUpdatedSchema = v.looseObject({
  type: v.literal('session_updated'),
  session: SessionSummarySchema,
});

export const ProjectsListSchema = v.looseObject({
  type: v.literal('projects_list'),
  projects: v.array(ProjectInfoSchema),
});

export const DirCompletionsSchema = v.looseObject({
  type: v.literal('dir_completions'),
  prefix: v.string(),
  entries: v.array(v.string()),
});

export const FileCompletionsSchema = v.looseObject({
  type: v.literal('file_completions'),
  query: v.string(),
  entries: v.array(v.string()),
});

export const ProvidersListSchema = v.looseObject({
  type: v.literal('providers_list'),
  providers: v.array(ProviderInfoSchema),
});

export const ForkPointsSchema = v.looseObject({
  type: v.literal('fork_points'),
  entries: v.array(v.looseObject({ entryId: v.string(), text: v.string() })),
});

export const ToolsListSchema = v.looseObject({
  type: v.literal('tools_list'),
  tools: v.array(
    v.looseObject({
      name: v.string(),
      description: v.string(),
      isBuiltin: v.boolean(),
      origin: v.optional(v.string()),
    })
  ),
  activeToolNames: v.array(v.string()),
});

export const ProjectTrustSchema = v.looseObject({
  type: v.literal('project_trust'),
  trust: ProjectTrustInfoSchema,
});

export const RuntimeDiagnosticsSchema = v.looseObject({
  type: v.literal('runtime_diagnostics'),
  diagnostics: v.array(RuntimeDiagnosticSchema),
});

export const ExtensionsListSchema = v.looseObject({
  type: v.literal('extensions_list'),
  extensions: v.array(ExtensionSummarySchema),
  errors: v.array(v.looseObject({ path: v.string(), error: v.string() })),
});

export const PackagesListSchema = v.looseObject({
  type: v.literal('packages_list'),
  packages: v.array(
    v.looseObject({
      source: v.string(),
      scope: v.union([v.literal('user'), v.literal('project')]),
      filtered: v.boolean(),
      installedPath: v.optional(v.string()),
    })
  ),
  updates: v.optional(
    v.array(
      v.looseObject({
        source: v.string(),
        displayName: v.string(),
        type: v.union([v.literal('npm'), v.literal('git')]),
        scope: v.union([v.literal('user'), v.literal('project')]),
      })
    )
  ),
});

export const SessionStatsEventSchema = v.looseObject({
  type: v.literal('session_stats'),
  stats: SessionStatsSchema,
});

export const UpdateStatusEventSchema = v.looseObject({
  type: v.literal('update_status'),
  appRoot: v.string(),
  mode: v.union([v.literal('source'), v.literal('package'), v.literal('ephemeral')]),
  updateCommand: v.optional(v.string()),
  busy: v.boolean(),
  canUpdateUi: v.boolean(),
  canUpdateSdk: v.boolean(),
  ui: UpdatePackageStatusSchema,
  sdk: UpdatePackageStatusSchema,
  notes: v.array(v.string()),
});

export const SessionTreeSchema = v.looseObject({
  type: v.literal('session_tree'),
  tree: v.array(TreeNodeSchema),
});

/** Registry of custom server events explicitly parsed into kind: 'custom' */
export const customEventSchemas = {
  session_loaded: SessionLoadedSchema,
  sessions_error: SessionsErrorSchema,
  model_changed: ModelChangedSchema,
  thinking_level_changed: ThinkingLevelChangedSchema,
  available_models_changed: AvailableModelsChangedSchema,
  older_messages: OlderMessagesSchema,
  session_runtime: SessionRuntimeSchema,
  extension_terminal_input_result: ExtensionTerminalInputResultSchema,
  file_content: FileContentSchema,
  file_saved: FileSavedSchema,
  slash_result: SlashResultSchema,
  settings: SettingsSchema,
  notification_webhook_url: NotificationWebhookUrlSchema,
  sessions_list: SessionsListSchema,
  all_sessions_list: AllSessionsListSchema,
  session_updated: SessionUpdatedSchema,
  projects_list: ProjectsListSchema,
  dir_completions: DirCompletionsSchema,
  file_completions: FileCompletionsSchema,
  providers_list: ProvidersListSchema,
  fork_points: ForkPointsSchema,
  tools_list: ToolsListSchema,
  project_trust: ProjectTrustSchema,
  runtime_diagnostics: RuntimeDiagnosticsSchema,
  extensions_list: ExtensionsListSchema,
  packages_list: PackagesListSchema,
  session_stats: SessionStatsEventSchema,
  update_status: UpdateStatusEventSchema,
  session_tree: SessionTreeSchema,
} as const;

export type CustomEventType = keyof typeof customEventSchemas;

// ── SDK Passthrough Schema ────────────────────────────────────────────────────

export const SdkEventSchema = v.looseObject({
  type: v.pipe(v.string(), v.minLength(1)),
});

// ── Validation Result Types ───────────────────────────────────────────────────

export type ParsedServerMessage =
  | { ok: true; kind: 'connected'; value: v.InferOutput<typeof ConnectedMessageSchema> }
  | { ok: true; kind: 'custom'; value: Record<string, unknown> }
  | { ok: true; kind: 'sdk'; value: Record<string, unknown> }
  | { ok: false; issues: string[] };

function formatIssues(issues: v.BaseIssue<unknown>[]): string[] {
  return issues.map((issue) => {
    const path = issue.path
      ? issue.path
          .map((p) => p.key)
          .filter((k) => k !== undefined)
          .join('.')
      : '';
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

/**
 * Parses any incoming WebSocket payload into a typed result.
 * Never throws — returns `{ ok: false, issues: [...] }` on invalid structure.
 */
export function parseServerMessage(raw: unknown): ParsedServerMessage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      issues: ['Expected object payload for server message'],
    };
  }

  const rawType = (raw as { type?: unknown }).type;
  if (typeof rawType !== 'string' || rawType.length === 0) {
    return {
      ok: false,
      issues: ['Expected non-empty string "type" field'],
    };
  }

  if (rawType === 'connected') {
    const res = v.safeParse(ConnectedMessageSchema, raw);
    if (res.success) {
      return { ok: true, kind: 'connected', value: res.output };
    }
    return { ok: false, issues: formatIssues(res.issues) };
  }

  if (rawType in customEventSchemas) {
    const schema = customEventSchemas[rawType as CustomEventType];
    const res = v.safeParse(schema, raw);
    if (res.success) {
      return { ok: true, kind: 'custom', value: res.output as Record<string, unknown> };
    }
    return { ok: false, issues: formatIssues(res.issues) };
  }

  // SDK forwarded events or unknown/future event types pass through as kind: 'sdk'.
  // Fast path: `raw` is already verified as an object with a non-empty string
  // `type` field (lines above), which is exactly what SdkEventSchema checks.
  // Skip the valibot allocation — this path handles the highest-frequency
  // frames (message_update per token, tool_execution_update, session_runtime).
  return { ok: true, kind: 'sdk', value: raw as Record<string, unknown> };
}
