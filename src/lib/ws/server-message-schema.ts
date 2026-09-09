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
  name: v.optional(v.string()),
  reasoning: v.optional(v.boolean()),
  contextWindow: v.optional(v.number()),
  thinkingLevelMap: v.optional(v.record(v.string(), v.nullable(v.string()))),
});

export const ContextUsageSchema = v.looseObject({
  tokens: v.nullable(v.number()),
  contextWindow: v.number(),
  percent: v.optional(v.nullable(v.number())),
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
  firstMessage: v.optional(v.string()),
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
  description: v.optional(v.string()),
  scope: v.string(),
  isBuiltin: v.boolean(),
  source: v.string(),
});

export const PromptSummarySchema = v.looseObject({
  name: v.string(),
  description: v.optional(v.string()),
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
  requiresDecision: v.boolean(),
  persisted: v.optional(v.boolean()),
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
  tools: v.array(v.looseObject({ name: v.string(), description: v.optional(v.string()) })),
  commands: v.array(v.looseObject({ name: v.string(), description: v.optional(v.string()) })),
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
    input: v.optional(v.number()),
    output: v.optional(v.number()),
    cacheRead: v.optional(v.number()),
    cacheWrite: v.optional(v.number()),
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
const ParsedComponentSchema: v.GenericSchema = v.lazy(() =>
  v.union([
    v.looseObject({
      kind: v.literal('container'),
      children: v.array(ParsedComponentSchema),
      direction: v.optional(v.union([v.literal('vertical'), v.literal('horizontal')])),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('select'),
      label: v.optional(v.string()),
      options: v.array(
        v.looseObject({
          value: v.string(),
          label: v.optional(v.string()),
          description: v.optional(v.string()),
        })
      ),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('input'),
      label: v.optional(v.string()),
      placeholder: v.optional(v.string()),
      value: v.optional(v.string()),
      multiline: v.optional(v.boolean()),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('text'),
      label: v.optional(v.string()),
      content: v.string(),
      monoPreserve: v.optional(v.boolean()),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('button'),
      label: v.optional(v.string()),
      variant: v.optional(
        v.union([v.literal('default'), v.literal('primary'), v.literal('danger')])
      ),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('checkbox'),
      label: v.optional(v.string()),
      checked: v.boolean(),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('progress'),
      label: v.optional(v.string()),
      progress: v.optional(v.number()),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('loader'),
      label: v.optional(v.string()),
      cancellable: v.optional(v.boolean()),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('image'),
      label: v.optional(v.string()),
      data: v.string(),
      mimeType: v.string(),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('markdown'),
      content: v.string(),
      path: v.optional(v.array(v.number())),
    }),
    v.looseObject({
      kind: v.literal('settings'),
      items: v.array(
        v.looseObject({
          id: v.string(),
          label: v.optional(v.string()),
          description: v.optional(v.string()),
          currentValue: v.string(),
          values: v.optional(v.array(v.string())),
        })
      ),
      path: v.optional(v.array(v.number())),
    }),
  ])
);

const WidgetPayloadSchema = v.looseObject({
  widgetKey: v.string(),
  widgetType: v.union([
    v.literal('text'),
    v.literal('table'),
    v.literal('badge'),
    v.literal('component'),
  ]),
  widgetLines: v.optional(v.array(v.string())),
  widgetHtmlLines: v.optional(v.array(v.string())),
  widgetData: v.optional(v.record(v.string(), v.unknown())),
  widgetComponent: v.optional(ParsedComponentSchema),
  widgetPlacement: v.optional(v.union([v.literal('aboveEditor'), v.literal('belowEditor')])),
});

const ExtensionUiStatePayloadSchema = v.looseObject({
  statuses: v.optional(v.record(v.string(), v.string())),
  workingMessage: v.optional(v.string()),
  workingVisible: v.optional(v.boolean()),
  workingIndicator: v.optional(
    v.looseObject({
      frames: v.optional(v.array(v.string())),
      intervalMs: v.optional(v.number()),
    })
  ),
  hiddenThinkingLabel: v.optional(v.string()),
  header: v.optional(v.string()),
  footer: v.optional(v.string()),
  editorComponent: v.optional(ParsedComponentSchema),
  title: v.optional(v.string()),
  widgets: v.optional(v.array(WidgetPayloadSchema)),
  pendingDialogs: v.optional(v.array(v.record(v.string(), v.unknown()))),
  terminalInputActive: v.optional(v.boolean()),
  schemaVersion: v.optional(v.number()),
});

const ExtensionErrorNoticeSchema = v.looseObject({
  extensionPath: v.optional(v.string()),
  event: v.optional(v.string()),
  error: v.optional(v.string()),
  stack: v.optional(v.string()),
});

const PackageProgressSchema = v.looseObject({
  phase: v.union([
    v.literal('start'),
    v.literal('progress'),
    v.literal('complete'),
    v.literal('error'),
  ]),
  action: v.optional(
    v.union([
      v.literal('install'),
      v.literal('remove'),
      v.literal('update'),
      v.literal('clone'),
      v.literal('pull'),
    ])
  ),
  source: v.optional(v.string()),
  message: v.optional(v.string()),
});

// ── Connected Message Schema ──────────────────────────────────────────────────

export const ConnectedMessageSchema = v.looseObject({
  type: v.literal('connected'),
  sessionId: v.string(),
  isStreaming: v.boolean(),
  activeToolName: v.optional(v.string()),
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
  contextUsage: v.optional(v.nullable(ContextUsageSchema)),
  webhookUrl: v.optional(v.string()),
  extensionUiState: v.optional(ExtensionUiStatePayloadSchema),
  projectTrust: v.optional(ProjectTrustInfoSchema),
  diagnostics: v.optional(v.array(RuntimeDiagnosticSchema)),
  modelFallbackMessage: v.optional(v.string()),
  tools: v.optional(
    v.array(
      v.looseObject({
        name: v.string(),
        description: v.optional(v.string()),
        isBuiltin: v.boolean(),
        origin: v.optional(v.string()),
      })
    )
  ),
  activeToolNames: v.optional(v.array(v.string())),
});
// ── Custom Server Event Schemas ──────────────────────────────────────────────

export const BashExecutionUpdateSchema = v.looseObject({
  type: v.literal('bash_execution_update'),
  id: v.string(),
  delta: v.string(),
  sessionId: v.string(),
});

export const ExtensionFlagResultSchema = v.looseObject({
  type: v.literal('extension_flag_result'),
  name: v.string(),
  value: v.union([v.boolean(), v.string()]),
  success: v.boolean(),
});

export const ShutdownRequestedSchema = v.looseObject({
  type: v.literal('shutdown_requested'),
  sessionId: v.string(),
});

export const ToolOutputSchema = v.looseObject({
  type: v.literal('tool_output'),
  sessionId: v.string(),
  toolCallId: v.string(),
  content: v.optional(v.string()),
  details: v.optional(v.string()),
  diff: v.optional(v.string()),
  renderedResultHtml: v.optional(v.array(v.string())),
  error: v.optional(v.string()),
  requestId: v.optional(v.string()),
});

export const SessionLoadedSchema = v.looseObject({
  type: v.literal('session_loaded'),
  sessionId: v.string(),
  isStreaming: v.optional(v.boolean()),
  activeToolName: v.optional(v.string()),
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
  contextUsage: v.optional(v.nullable(ContextUsageSchema)),
  tools: v.optional(
    v.array(
      v.looseObject({
        name: v.string(),
        description: v.optional(v.string()),
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
  sessionId: v.optional(v.string()),
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
export const ModelsRefreshResultSchema = v.looseObject({
  type: v.literal('models_refresh_result'),
  success: v.boolean(),
  message: v.string(),
  sessionId: v.optional(v.string()),
});

export const OlderMessagesSchema = v.looseObject({
  type: v.literal('older_messages'),
  messages: v.array(v.unknown()),
  totalMessageCount: v.number(),
  messagesTruncated: v.boolean(),
  sessionId: v.optional(v.string()),
});

export const SessionRuntimeSchema = v.looseObject({
  type: v.literal('session_runtime'),
  sessionId: v.string(),
  phase: v.optional(
    v.union([
      v.literal('idle'),
      v.literal('running'),
      v.literal('awaiting-input'),
      v.literal('error'),
    ])
  ),
  isRunning: v.boolean(),
  lastActivity: v.number(),
  activeToolName: v.optional(v.string()),
  unread: v.optional(v.boolean()),
  needsAttention: v.optional(v.boolean()),
  resident: v.optional(v.boolean()),
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
  sessionId: v.optional(v.string()),
});

export const ForkPointsSchema = v.looseObject({
  type: v.literal('fork_points'),
  entries: v.array(v.looseObject({ entryId: v.string(), text: v.string() })),
  sessionId: v.optional(v.string()),
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
  sessionId: v.optional(v.string()),
});

export const ProjectTrustSchema = v.looseObject({
  type: v.literal('project_trust'),
  trust: ProjectTrustInfoSchema,
  sessionId: v.optional(v.string()),
});

export const RuntimeDiagnosticsSchema = v.looseObject({
  type: v.literal('runtime_diagnostics'),
  diagnostics: v.array(RuntimeDiagnosticSchema),
  sessionId: v.optional(v.string()),
});

export const ExtensionsListSchema = v.looseObject({
  type: v.literal('extensions_list'),
  extensions: v.array(ExtensionSummarySchema),
  errors: v.array(v.looseObject({ path: v.string(), error: v.string() })),
  sessionId: v.optional(v.string()),
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
  sessionId: v.optional(v.string()),
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
  sessionId: v.optional(v.string()),
});

export const ExtensionErrorSchema = v.looseObject({
  type: v.literal('extension_error'),
  error: ExtensionErrorNoticeSchema,
  sessionId: v.optional(v.string()),
});

export const PackageProgressEventSchema = v.looseObject({
  type: v.literal('package_progress'),
  progress: PackageProgressSchema,
  sessionId: v.optional(v.string()),
});

export const PackageResultSchema = v.looseObject({
  type: v.literal('package_result'),
  success: v.boolean(),
  message: v.string(),
  sessionId: v.optional(v.string()),
});

export const ExportResultSchema = v.looseObject({
  type: v.literal('export_result'),
  format: v.union([v.literal('html'), v.literal('jsonl')]),
  path: v.optional(v.string()),
  error: v.optional(v.string()),
  sessionId: v.optional(v.string()),
});

export const SkillInstallResultSchema = v.looseObject({
  type: v.literal('skill_install_result'),
  success: v.boolean(),
  name: v.optional(v.string()),
  error: v.optional(v.string()),
});

export const UpdateProgressSchema = v.looseObject({
  type: v.literal('update_progress'),
  target: v.union([v.literal('ui'), v.literal('sdk')]),
  command: v.optional(v.string()),
  message: v.string(),
});

export const UpdateResultSchema = v.looseObject({
  type: v.literal('update_result'),
  target: v.union([v.literal('ui'), v.literal('sdk')]),
  success: v.boolean(),
  message: v.string(),
});

export const RestartNonceSchema = v.looseObject({
  type: v.literal('restart_nonce'),
  nonce: v.string(),
});

export const ServerRestartingSchema = v.looseObject({
  type: v.literal('server_restarting'),
});

export const CommandCompletionsSchema = v.looseObject({
  type: v.literal('command_completions'),
  command: v.string(),
  prefix: v.string(),
  items: v.array(
    v.looseObject({
      value: v.string(),
      label: v.string(),
      description: v.optional(v.string()),
    })
  ),
  sessionId: v.optional(v.string()),
});

export const ExtensionCompletionsSchema = v.looseObject({
  type: v.literal('extension_completions'),
  trigger: v.string(),
  query: v.string(),
  items: v.array(v.unknown()),
});

export const PongSchema = v.looseObject({
  type: v.literal('pong'),
});

export const AgentErrorSchema = v.looseObject({
  type: v.literal('agent_error'),
  error: v.string(),
  sessionId: v.optional(v.string()),
});

export const QueueRestoredSchema = v.looseObject({
  type: v.literal('queue_restored'),
  text: v.string(),
});

export const ExtensionUiStateSchema = v.looseObject({
  type: v.literal('extension_ui_state'),
  sessionId: v.string(),
  ui: ExtensionUiStatePayloadSchema,
});

export const ExtensionTerminalInputActiveSchema = v.looseObject({
  type: v.literal('extension_terminal_input_active'),
  active: v.boolean(),
  sessionId: v.optional(v.string()),
});

export const ExtensionUiDismissSchema = v.looseObject({
  type: v.literal('extension_ui_dismiss'),
  id: v.string(),
  sessionId: v.optional(v.string()),
});

export const ExtensionUiUpdateSchema = v.looseObject({
  type: v.literal('extension_ui_update'),
  id: v.string(),
  parsed: ParsedComponentSchema,
  sessionId: v.optional(v.string()),
});

export const CustomRenderSchema = v.looseObject({
  type: v.literal('custom_render'),
  id: v.string(),
  lines: v.array(v.string()),
  htmlLines: v.optional(v.array(v.string())),
  sessionId: v.optional(v.string()),
});

export const CompactionEndSchema = v.looseObject({
  type: v.literal('compaction_end'),
  sessionId: v.string(),
  reason: v.string(),
  result: v.optional(v.unknown()),
  aborted: v.optional(v.boolean()),
  willRetry: v.optional(v.boolean()),
  errorMessage: v.optional(v.string()),
});

// The extension_ui_request* payloads are open records, so they intentionally remain on the SDK passthrough path.

/** Registry of custom server events explicitly parsed into kind: 'custom' */
export const customEventSchemas = {
  bash_execution_update: BashExecutionUpdateSchema,
  extension_flag_result: ExtensionFlagResultSchema,
  shutdown_requested: ShutdownRequestedSchema,
  tool_output: ToolOutputSchema,
  extension_error: ExtensionErrorSchema,
  package_progress: PackageProgressEventSchema,
  package_result: PackageResultSchema,
  export_result: ExportResultSchema,
  skill_install_result: SkillInstallResultSchema,
  update_progress: UpdateProgressSchema,
  update_result: UpdateResultSchema,
  restart_nonce: RestartNonceSchema,
  server_restarting: ServerRestartingSchema,
  command_completions: CommandCompletionsSchema,
  extension_completions: ExtensionCompletionsSchema,
  pong: PongSchema,
  agent_error: AgentErrorSchema,
  queue_restored: QueueRestoredSchema,
  extension_ui_state: ExtensionUiStateSchema,
  extension_terminal_input_active: ExtensionTerminalInputActiveSchema,
  extension_ui_dismiss: ExtensionUiDismissSchema,
  extension_ui_update: ExtensionUiUpdateSchema,
  custom_render: CustomRenderSchema,
  compaction_end: CompactionEndSchema,
  session_loaded: SessionLoadedSchema,
  sessions_error: SessionsErrorSchema,
  model_changed: ModelChangedSchema,
  thinking_level_changed: ThinkingLevelChangedSchema,
  available_models_changed: AvailableModelsChangedSchema,
  models_refresh_result: ModelsRefreshResultSchema,
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
