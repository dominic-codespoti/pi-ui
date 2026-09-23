<script lang="ts">
  import SidebarPanel from '#lib/components/sidebar-panel.svelte';
  import ModelsTab from './models-tab.svelte';
  import ToolsTab from './tools-tab.svelte';
  import SkillsTab from './skills-tab.svelte';
  import type {
    ModelInfo,
    ProviderInfo,
    SkillSummary,
    PromptSummary,
    ResourceDiagnosticSummary,
  } from '#lib/ws/protocol.js';
  import AlertTriangle from '@lucide/svelte/icons/triangle-alert';

  let {
    open,
    isMobile,
    width,
    resizing,
    tab,
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
    providerLoginPending,
    configuredProviderCount,
    filteredModelsByProvider,
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
    onToggleTool,
    onSetProviderKey,
    onProviderLogin,
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
    modelRefreshLoading: boolean;
    modelRefreshFeedback: { success: boolean; message: string } | null;
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
    providerLoginPending: string | null;
    filteredTools: { name: string; description: string; isBuiltin: boolean; origin?: string }[];
    filteredSkills: { skills: SkillSummary[]; prompts: PromptSummary[] };
    resourceDiagnostics: ResourceDiagnosticSummary[];
    contextFiles: string[];
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
    onProviderLogin: (id: string) => void;
    onRemoveProviderKey: (id: string) => void;
    onSetActiveTools: (names: string[]) => void;
    onInstallSkill: (url: string, scope: 'project' | 'user') => void;
    onUseSkill: (name: string) => void;
    onUsePrompt: (name: string) => void;
    onOpenResourceFile: (path: string) => void;
    onDismissProviderError: () => void;
    onRefreshModels: () => void;
  } = $props();

  // Domain rendering is delegated to the tab children below; the shell owns
  // only panel layout, tab navigation, and parent-facing callbacks.
</script>

<SidebarPanel
  title={tab === 'models'
    ? 'models'
    : tab === 'tools'
      ? toolsList.length
        ? `tools (${activeToolNames.length}/${toolsList.length})`
        : 'tools'
      : 'skills & prompts'}
  {open}
  {isMobile}
  {width}
  side="right"
  {resizing}
  closeLabel="Close panel"
  surface="default"
  {onClose}
  {onResizeStart}
  {onResizeMove}
  {onResizeStop}
>
  {#snippet header()}{/snippet}

  <div class="shrink-0 px-3 py-2.5 border-b border-base-content/8 flex items-center gap-2">
    <div
      role="tablist"
      aria-label="Panel sections"
      tabindex={open ? 0 : -1}
      class="flex items-center flex-1 bg-base-content/[0.045] border border-base-content/[0.05] rounded-full p-0.5 gap-0.5"
    >
      <button
        role="tab"
        aria-selected={tab === 'models'}
        onclick={() => onTabChange('models')}
        class="flex-1 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {tab ===
        'models'
          ? 'text-base-content bg-base-content/12 shadow-sm shadow-black/10'
          : 'text-base-content/45 hover:text-base-content/70'}"
        tabindex={open ? 0 : -1}>models</button
      >
      <button
        role="tab"
        aria-selected={tab === 'tools'}
        onclick={() => onTabChange('tools')}
        class="flex-1 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {tab ===
        'tools'
          ? 'text-base-content bg-base-content/12 shadow-sm shadow-black/10'
          : 'text-base-content/45 hover:text-base-content/70'}"
        tabindex={open ? 0 : -1}
        >tools{#if toolsList.length}
          <span class="text-base-content/30 font-normal text-[10px] tabular-nums ml-1"
            >{activeToolNames.length}/{toolsList.length}</span
          >{/if}</button
      >
      <button
        role="tab"
        aria-selected={tab === 'skills'}
        onclick={() => onTabChange('skills')}
        class="flex-1 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {tab ===
        'skills'
          ? 'text-base-content bg-base-content/12 shadow-sm shadow-black/10'
          : 'text-base-content/45 hover:text-base-content/70'}"
        tabindex={open ? 0 : -1}
        aria-label="skills and prompts{resourceDiagnostics.length
          ? `, ${resourceDiagnostics.length} resource diagnostics`
          : ''}"
        >skills{#if resourceDiagnostics.length > 0}<AlertTriangle
            class="ml-1 inline h-3 w-3 text-warning"
            aria-hidden="true"
          /><span class="ml-0.5 text-[10px] text-warning">{resourceDiagnostics.length}</span
          >{/if}</button
      >
    </div>
    <button
      onclick={onClose}
      class="w-8 h-8 flex items-center justify-center text-base-content/40 hover:text-base-content hover:bg-base-content/10 rounded-full transition-all duration-150 shrink-0"
      aria-label="Close panel"
      ><svg
        class="w-4 h-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg
      ></button
    >
  </div>
  {#if tab === 'models'}
    <ModelsTab
      {open}
      bind:modelTab
      {model}
      {modelRefreshLoading}
      {modelRefreshFeedback}
      {thinkingLevel}
      {availableThinkingLevels}
      {providers}
      bind:providerError
      bind:providerKeyInputs
      bind:providerFilter
      bind:modelFilter
      {filteredProviders}
      {configuredProviderCount}
      {filteredModelsByProvider}
      {providerLoginPending}
      {onProviderLogin}
      {onSelectModel}
      {onPickThinkingLevel}
      {onSetProviderKey}
      {onRemoveProviderKey}
      {onDismissProviderError}
      {onRefreshModels}
    />
  {:else if tab === 'tools'}
    <ToolsTab
      {open}
      {toolsList}
      {activeToolNames}
      bind:toolFilter
      {filteredTools}
      {onToggleTool}
      {onSetActiveTools}
    />
  {:else}
    <SkillsTab
      {open}
      {resourcesLoaded}
      diagnostics={resourceDiagnostics}
      {contextFiles}
      bind:skillFilter
      {filteredSkills}
      bind:skillInstallUrl
      bind:skillInstallScope
      {skillInstalling}
      bind:skillInstallFeedback
      {onInstallSkill}
      {onUseSkill}
      {onUsePrompt}
      onOpenFile={onOpenResourceFile}
    />
  {/if}
</SidebarPanel>
