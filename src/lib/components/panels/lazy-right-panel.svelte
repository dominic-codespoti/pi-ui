<script lang="ts">
  import type { AppExtensionCall, AppExtensionEventListener } from '#lib/app-extensions/transport.js';
  import type {
    AppExtensionHostPrompt,
    AppExtensionHostDraft,
    AppExtensionHostConfirm,
    AppExtensionHostOpenFile,
    AppExtensionHostSwitchSession,
  } from '#lib/app-extensions/client-loader.js';
  import type { AppExtensionScope, AppExtensionSlot, AppExtensionSummary } from '#lib/app-extensions/types.js';
  import type { AppExtensionViewRef } from '#lib/state/app-extensions-state.svelte.js';
  import type {
    ModelInfo,
    ProviderInfo,
    SkillSummary,
    PromptSummary,
    ResourceDiagnosticSummary,
  } from '#lib/ws/protocol.js';

  /**
   * Lazy-mounting wrapper for the right panel — the real component (and its
   * heavy models/providers/tools/skills lists) is loaded on first open (or
   * prefetched on idle), keeping the always-mounted sidebar shell light on
   * first paint. Props mirror right-panel.svelte exactly; the bindable set
   * is re-declared here so the page binds through the wrapper unchanged.
   */
  let {
    open,
    isMobile,
    width,
    resizing,
    tab,
    appExtensions,
    activeAppViews,
    pinnedSidebarViews,
    appScope,
    appCall,
    appSubscribe,
    appPrompt,
    appDraft,
    appConfirm,
    appOpenFile,
    appSwitchSession,
    appSetEnabled,
    appReload,
    appRefresh,
    onSelectAppView,
    onClearAppView,
    onToggleSidebarPin,
    onAppNotify,
    modelTab = $bindable(),
    model,
    modelRefreshLoading,
    modelRefreshFeedback,
    toolsList,
    activeToolNames,
    resourcesLoaded,
    resourceDiagnostics,
    contextFiles,
    thinkingLevel,
    availableThinkingLevels,
    providers,
    providerError = $bindable(),
    providerKeyInputs = $bindable(),
    providerFilter = $bindable(),
    modelFilter = $bindable(),
    toolFilter = $bindable(),
    skillFilter = $bindable(),
    filteredProviders,
    configuredProviderCount,
    filteredModelsByProvider,
    providerLoginPending,
    filteredTools,
    filteredSkills,
    onUsePrompt,
    onOpenResourceFile,
    skillInstallUrl = $bindable(),
    skillInstallScope = $bindable(),
    skillInstalling,
    skillInstallFeedback = $bindable(),
    onClose,
    onResizeStart,
    onResizeMove,
    onResizeStop,
    onTabChange,
    onSelectModel,
    onPickThinkingLevel,
    onProviderLogin,
    onToggleTool,
    onSetProviderKey,
    onRemoveProviderKey,
    onSetActiveTools,
    onInstallSkill,
    onUseSkill,
    onDismissProviderError,
    onRefreshModels,
  }: {
    open: boolean;
    isMobile: boolean;
    width: number;
    resizing: boolean;
    tab: 'models' | 'tools' | 'skills' | 'apps';
    appExtensions: AppExtensionSummary[];
    activeAppViews: Record<AppExtensionSlot, AppExtensionViewRef | null>;
    pinnedSidebarViews: AppExtensionViewRef[];
    appScope: AppExtensionScope;
    appCall: AppExtensionCall;
    appPrompt: AppExtensionHostPrompt;
    appDraft: AppExtensionHostDraft;
    appConfirm: AppExtensionHostConfirm;
    appOpenFile: AppExtensionHostOpenFile;
    appSwitchSession: AppExtensionHostSwitchSession;
    appSetEnabled: (extensionId: string, enabled: boolean) => boolean;
    appReload: (extensionId: string) => boolean;
    appRefresh: () => boolean;
    appSubscribe: (
      extensionId: string,
      eventName: string,
      listener: AppExtensionEventListener,
      scope: AppExtensionScope
    ) => () => void;
    onSelectAppView: (slot: AppExtensionSlot, extensionId: string, viewId: string) => void;
    onClearAppView: (slot: AppExtensionSlot) => void;
    onToggleSidebarPin: (extensionId: string, viewId: string) => void;
    onAppNotify: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void;
    modelTab: 'models' | 'providers';
    model: ModelInfo | null;
    modelRefreshLoading: boolean;
    modelRefreshFeedback: { success: boolean; message: string } | null;
    toolsList: { name: string; description: string; isBuiltin: boolean; origin?: string }[];
    activeToolNames: string[];
    resourcesLoaded: boolean;
    resourceDiagnostics: ResourceDiagnosticSummary[];
    contextFiles: string[];
    onUsePrompt: (name: string) => void;
    onOpenResourceFile: (path: string) => void;
    thinkingLevel: string;
    availableThinkingLevels: readonly string[];
    providers: ProviderInfo[];
    providerError: string | null;
    providerKeyInputs: Record<string, string>;
    providerFilter: string;
    modelFilter: string;
    toolFilter: string;
    skillFilter: string;
    filteredProviders: ProviderInfo[];
    configuredProviderCount: number;
    filteredModelsByProvider: [string, ModelInfo[]][];
    providerLoginPending: string | null;
    filteredTools: { name: string; description: string; isBuiltin: boolean; origin?: string }[];
    filteredSkills: { skills: SkillSummary[]; prompts: PromptSummary[] };
    skillInstallUrl: string;
    skillInstallScope: 'project' | 'user';
    skillInstalling: boolean;
    skillInstallFeedback: { success: boolean; message: string } | null;
    onClose: () => void;
    onResizeStart: (e: PointerEvent) => void;
    onResizeMove: (e: PointerEvent) => void;
    onResizeStop: () => void;
    onTabChange: (tab: 'models' | 'tools' | 'skills' | 'apps') => void;
    onSelectModel: (m: ModelInfo) => void;
    onPickThinkingLevel: (level: string) => void;
    onProviderLogin: (id: string) => void;
    onToggleTool: (name: string) => void;
    onSetProviderKey: (id: string) => void;
    onRemoveProviderKey: (id: string) => void;
    onSetActiveTools: (names: string[]) => void;
    onInstallSkill: (url: string, scope: 'project' | 'user') => void;
    onUseSkill: (name: string) => void;
    onDismissProviderError: () => void;
    onRefreshModels: () => void;
  } = $props();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic component type
  let Cmp = $state<any>(null);
  $effect(() => {
    if (open && !Cmp) {
      import('./right-panel.svelte').then((m) => (Cmp = m.default)).catch(() => {});
    }
  });
</script>

{#if Cmp}
  <Cmp
    {open}
    {isMobile}
    {width}
    {resizing}
    {tab}
    {appExtensions}
    {activeAppViews}
    {pinnedSidebarViews}
    {appScope}
    {appCall}
    {appSubscribe}
    {appPrompt}
    {appDraft}
    {appConfirm}
    {appOpenFile}
    {appSwitchSession}
    {appSetEnabled}
    {appReload}
    {appRefresh}
    {onSelectAppView}
    {onClearAppView}
    {onToggleSidebarPin}
    {onAppNotify}
    bind:modelTab
    {model}
    {modelRefreshLoading}
    {modelRefreshFeedback}
    {toolsList}
    {activeToolNames}
    {resourcesLoaded}
    {resourceDiagnostics}
    {contextFiles}
    {thinkingLevel}
    {availableThinkingLevels}
    {providers}
    bind:providerError
    bind:providerKeyInputs
    bind:providerFilter
    bind:modelFilter
    bind:toolFilter
    bind:skillFilter
    {filteredProviders}
    {configuredProviderCount}
    {providerLoginPending}
    {filteredModelsByProvider}
    {filteredTools}
    {filteredSkills}
    {onUsePrompt}
    {onOpenResourceFile}
    bind:skillInstallUrl
    bind:skillInstallScope
    {skillInstalling}
    bind:skillInstallFeedback
    {onClose}
    {onResizeStart}
    {onResizeMove}
    {onProviderLogin}
    {onResizeStop}
    {onTabChange}
    {onSelectModel}
    {onPickThinkingLevel}
    {onToggleTool}
    {onSetProviderKey}
    {onRemoveProviderKey}
    {onSetActiveTools}
    {onInstallSkill}
    {onUseSkill}
    {onDismissProviderError}
    {onRefreshModels}
  />
{/if}
