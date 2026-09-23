<script lang="ts">
  import type {
    ModelInfo,
    ProviderInfo,
    SkillSummary,
    PromptSummary,
    ResourceDiagnosticSummary,
    ScopedModelInfo,
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
    modelTab = $bindable(),
    model,
    allModels,
    modelRefreshLoading,
    modelRefreshFeedback,
    toolsList,
    activeToolNames,
    resourcesLoaded,
    resourceDiagnostics,
    contextFiles,
    thinkingLevel,
    availableThinkingLevels,
    scopedModels,
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
    highlightProviderId,
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
    onOpenScopedModels,
    onProviderLogin,
    onOpenProviderKey,
    onHighlightConsumed,
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
    tab: 'models' | 'tools' | 'skills';
    modelTab: 'models' | 'providers';
    model: ModelInfo | null;
    allModels: ModelInfo[];
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
    scopedModels: ScopedModelInfo[];
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
    highlightProviderId: string | null;
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
    onTabChange: (tab: 'models' | 'tools' | 'skills') => void;
    onSelectModel: (m: ModelInfo) => void;
    onPickThinkingLevel: (level: string) => void;
    onOpenScopedModels: () => void;
    onProviderLogin: (id: string) => void;
    onOpenProviderKey: (id: string) => void;
    onHighlightConsumed: () => void;
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
    bind:modelTab
    {model}
    {allModels}
    {modelRefreshLoading}
    {modelRefreshFeedback}
    {toolsList}
    {activeToolNames}
    {resourcesLoaded}
    {resourceDiagnostics}
    {contextFiles}
    {thinkingLevel}
    {availableThinkingLevels}
    {scopedModels}
    {providers}
    bind:providerError
    bind:providerKeyInputs
    bind:providerFilter
    bind:modelFilter
    bind:toolFilter
    bind:skillFilter
    {filteredProviders}
    {configuredProviderCount}
    {highlightProviderId}
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
    {onOpenProviderKey}
    {onHighlightConsumed}
    {onResizeStop}
    {onTabChange}
    {onSelectModel}
    {onPickThinkingLevel}
    {onOpenScopedModels}
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
