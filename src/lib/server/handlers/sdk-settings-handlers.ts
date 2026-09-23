import type { AgentSession, SettingsManager } from '@earendil-works/pi-coding-agent';
type SettingsScope = 'global' | 'project';

export interface SdkSettingsHandlerSession extends AgentSession {
  settingsManager: SettingsManager;
}

const supportedKeys: Record<string, true> = {
  steeringMode: true,
  followUpMode: true,
  defaultProvider: true,
  defaultModel: true,
  defaultThinkingLevel: true,
  transport: true,
  'compaction.enabled': true,
  'retry.enabled': true,
  hideThinkingBlock: true,
  shellPath: true,
  shellCommandPrefix: true,
  'images.autoResize': true,
  'images.blockImages': true,
  httpIdleTimeoutMs: true,
  enableSkillCommands: true,
};

// These settings belong to a terminal UI and are intentionally not exposed:
// terminal.*, editorPaddingX, outputPad, autocompleteMaxVisible,
// showHardwareCursor, markdown.*, tuiMode, fullscreenExitOutput,
// fullscreenScrollbar, fullscreenCopyOnSelect, doubleEscapeAction,
// treeFilterMode, quietStartup, and externalEditor.

const settingsDescriptions: Record<string, string> = {
  steeringMode: 'How queued steering messages are delivered.',
  followUpMode: 'How queued follow-up messages are delivered.',
  defaultProvider: 'AI provider selected for new sessions by default.',
  defaultModel: 'Model selected for new sessions by default.',
  defaultThinkingLevel: 'Thinking level selected for new sessions.',
  transport: 'Preferred transport when a provider supports multiple transports.',
  'compaction.enabled': 'Enable automatic context compaction.',
  'compaction.reserveTokens': 'Tokens reserved for the model response during compaction.',
  'compaction.keepRecentTokens': 'Recent tokens retained without summarization.',
  'branchSummary.reserveTokens': 'Tokens reserved when summarizing branch history.',
  'branchSummary.skipPrompt': 'Skip the branch-summary prompt and default to no summary.',
  'retry.enabled': 'Enable automatic retries for transient agent failures.',
  'retry.maxRetries': 'Maximum agent-level retry attempts.',
  'retry.baseDelayMs': 'Initial exponential-backoff delay in milliseconds.',
  'retry.maxAgentDelayMs': 'Maximum agent-level retry delay in milliseconds.',
  'retry.provider.timeoutMs': 'Provider request timeout in milliseconds.',
  'retry.provider.maxRetries': 'Provider-level retry attempts.',
  'retry.provider.maxRetryDelayMs': 'Maximum provider-requested retry delay in milliseconds.',
  hideThinkingBlock: 'Hide thinking blocks in the transcript.',
  'images.autoResize': 'Resize images to at most 2000 by 2000 pixels before sending.',
  'images.blockImages': 'Prevent images from being sent to models.',
  httpIdleTimeoutMs: 'HTTP header and body idle timeout in milliseconds; zero disables it.',
  websocketConnectTimeoutMs: 'WebSocket connection timeout in milliseconds; zero disables it.',
  shellPath: 'Custom shell executable path; supports a leading tilde.',
  shellCommandPrefix: 'Prefix prepended to every shell command.',
  enableSkillCommands: 'Register skills as slash commands.',
  defaultTools: 'Built-in tools enabled at startup; this is read-only in the web UI.',
};

function readValue(settings: object, key: string): unknown {
  const record = settings as Record<string, unknown>;
  if (key.includes('.')) {
    const [outer, inner] = key.split('.');
    const section = outer ? record[outer] : undefined;
    return section && typeof section === 'object' && inner
      ? (section as Record<string, unknown>)[inner]
      : undefined;
  }
  return record[key];
}

export function getSdkSettings(manager: SettingsManager) {
  const global = manager.getGlobalSettings();
  const project = manager.getProjectSettings();
  const keys = [
    'steeringMode',
    'followUpMode',
    'defaultProvider',
    'defaultModel',
    'defaultThinkingLevel',
    'transport',
    'compaction.enabled',
    'compaction.reserveTokens',
    'compaction.keepRecentTokens',
    'branchSummary.reserveTokens',
    'branchSummary.skipPrompt',
    'retry.enabled',
    'retry.maxRetries',
    'retry.baseDelayMs',
    'retry.maxAgentDelayMs',
    'retry.provider.timeoutMs',
    'retry.provider.maxRetries',
    'retry.provider.maxRetryDelayMs',
    'hideThinkingBlock',
    'images.autoResize',
    'images.blockImages',
    'httpIdleTimeoutMs',
    'websocketConnectTimeoutMs',
    'shellPath',
    'shellCommandPrefix',
    'enableSkillCommands',
    'defaultTools',
  ];
  const settings: Record<string, unknown> = {};
  const projectOverrides: Record<string, unknown> = {};
  for (const key of keys) {
    const globalValue = readValue(global, key);
    const projectValue = readValue(project, key);
    if (globalValue !== undefined) settings[key] = globalValue;
    if (projectValue !== undefined) projectOverrides[key] = projectValue;
  }
  // Getter values include SDK defaults when the persisted setting is absent.
  Object.assign(settings, {
    steeringMode: manager.getSteeringMode(),
    followUpMode: manager.getFollowUpMode(),
    transport: manager.getTransport(),
    'compaction.enabled': manager.getCompactionEnabled(),
    'retry.enabled': manager.getRetryEnabled(),
    'retry.maxRetries': manager.getRetrySettings().maxRetries,
    'retry.baseDelayMs': manager.getRetrySettings().baseDelayMs,
    'retry.maxAgentDelayMs': manager.getRetrySettings().maxAgentDelayMs,
    hideThinkingBlock: manager.getHideThinkingBlock(),
    httpIdleTimeoutMs: manager.getHttpIdleTimeoutMs(),
    'images.autoResize': manager.getImageAutoResize(),
    'images.blockImages': manager.getBlockImages(),
    enableSkillCommands: manager.getEnableSkillCommands(),
    defaultTools: manager.getDefaultTools() ?? ['read', 'bash', 'edit', 'write'],
  });
  return { type: 'sdk_settings', settings, projectOverrides, descriptions: settingsDescriptions };
}

function validate(key: string, value: unknown): string | undefined {
  if (key === 'steeringMode' || key === 'followUpMode') {
    return value === 'all' || value === 'one-at-a-time'
      ? undefined
      : 'Choose all or one-at-a-time.';
  }
  if (key === 'transport') {
    return ['auto', 'sse', 'websocket', 'websocket-cached'].includes(String(value))
      ? undefined
      : 'Choose auto, sse, websocket, or websocket-cached.';
  }
  if (key === 'defaultThinkingLevel') {
    return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value))
      ? undefined
      : 'Choose a supported thinking level.';
  }
  if (
    key === 'compaction.enabled' ||
    key === 'retry.enabled' ||
    key === 'hideThinkingBlock' ||
    key === 'images.autoResize' ||
    key === 'images.blockImages' ||
    key === 'enableSkillCommands'
  ) {
    return typeof value === 'boolean' ? undefined : 'Value must be true or false.';
  }
  if (
    key.startsWith('compaction.') ||
    key.startsWith('branchSummary.') ||
    key.startsWith('retry.') ||
    key === 'httpIdleTimeoutMs' ||
    key === 'websocketConnectTimeoutMs'
  ) {
    return Number.isSafeInteger(value) && (value as number) >= 0
      ? undefined
      : 'Enter a non-negative whole number.';
  }
  if (['defaultProvider', 'defaultModel', 'shellPath', 'shellCommandPrefix'].includes(key)) {
    return typeof value === 'string' ? undefined : 'Value must be text.';
  }
  return 'This setting cannot be edited from the web UI.';
}

/** Writes only through the SDK's public typed SettingsManager setters. */
export async function setSdkSetting(
  session: SdkSettingsHandlerSession,
  key: string,
  value: unknown,
  scope: SettingsScope = 'global'
): Promise<{ ok: true } | { ok: false; error: string }> {
  const manager = session.settingsManager;
  const invalid = validate(key, value);
  if (invalid) return { ok: false, error: invalid };
  if (scope !== 'global')
    return { ok: false, error: 'This setting is writable only in global settings by the SDK.' };
  if (!supportedKeys[key])
    return {
      ok: false,
      error: 'This setting is read-only because the SDK has no public setter for it.',
    };
  try {
    switch (key) {
      case 'steeringMode':
        manager.setSteeringMode(value as 'all' | 'one-at-a-time');
        session.setSteeringMode(value as 'all' | 'one-at-a-time');
        break;
      case 'followUpMode':
        manager.setFollowUpMode(value as 'all' | 'one-at-a-time');
        session.setFollowUpMode(value as 'all' | 'one-at-a-time');
        break;
      case 'defaultProvider':
        manager.setDefaultProvider(value as string);
        break;
      case 'defaultModel':
        manager.setDefaultModel(value as string);
        break;
      case 'defaultThinkingLevel':
        manager.setDefaultThinkingLevel(
          value as Parameters<SettingsManager['setDefaultThinkingLevel']>[0]
        );
        break;
      case 'transport':
        manager.setTransport(value as Parameters<SettingsManager['setTransport']>[0]);
        break;
      case 'compaction.enabled':
        manager.setCompactionEnabled(value as boolean);
        session.setAutoCompactionEnabled(value as boolean);
        break;
      case 'retry.enabled':
        manager.setRetryEnabled(value as boolean);
        session.setAutoRetryEnabled(value as boolean);
        break;
      case 'hideThinkingBlock':
        manager.setHideThinkingBlock(value as boolean);
        break;
      case 'shellPath':
        manager.setShellPath(value as string);
        break;
      case 'shellCommandPrefix':
        manager.setShellCommandPrefix(value as string);
        break;
      case 'images.autoResize':
        manager.setImageAutoResize(value as boolean);
        break;
      case 'images.blockImages':
        manager.setBlockImages(value as boolean);
        break;
      case 'httpIdleTimeoutMs':
        manager.setHttpIdleTimeoutMs(value as number);
        break;
      case 'enableSkillCommands':
        manager.setEnableSkillCommands(value as boolean);
        break;
    }
    await manager.flush();
    const errors = manager.drainErrors();
    return errors.length
      ? { ok: false, error: errors.map((e) => e.error.message).join('; ') }
      : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
