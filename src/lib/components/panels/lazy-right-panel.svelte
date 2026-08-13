<script lang="ts">
  import type { ModelInfo, ProviderInfo, SkillSummary, PromptSummary } from '$lib/ws/protocol';

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
    availableModels,
    toolsList,
    activeToolNames,
    resourcesLoaded,
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
    filteredTools,
    filteredSkills,
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
    onToggleTool,
    onSetProviderKey,
    onRemoveProviderKey,
    onSetActiveTools,
    onInstallSkill,
    onUseSkill,
    onDismissProviderError,
  }: {
    open: boolean;
    isMobile: boolean;
    width: number;
    resizing: boolean;
    tab: 'models' | 'tools' | 'skills';
    modelTab: 'models' | 'providers';
    model: ModelInfo | null;
    availableModels: ModelInfo[];
    toolsList: { name: string; description: string; isBuiltin: boolean; origin?: string }[];
    activeToolNames: string[];
    resourcesLoaded: boolean;
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
    onToggleTool: (name: string) => void;
    onSetProviderKey: (id: string) => void;
    onRemoveProviderKey: (id: string) => void;
    onSetActiveTools: (names: string[]) => void;
    onInstallSkill: (url: string, scope: 'project' | 'user') => void;
    onUseSkill: (name: string) => void;
    onDismissProviderError: () => void;
  } = $props();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic component type
  let Cmp = $state<any>(null);
  $effect(() => {
    if (open && !Cmp) {
      import('./right-panel.svelte')
        .then((m) => (Cmp = m.default))
        .catch(() => {});
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
    {availableModels}
    {toolsList}
    {activeToolNames}
    {resourcesLoaded}
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
    {filteredModelsByProvider}
    {filteredTools}
    {filteredSkills}
    bind:skillInstallUrl
    bind:skillInstallScope
    {skillInstalling}
    bind:skillInstallFeedback
    {onClose}
    {onResizeStart}
    {onResizeMove}
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
  />
{/if}
