<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import * as Tabs from '$lib/components/ui/tabs';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import SidebarPanel from '$lib/components/sidebar-panel.svelte';
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import type { ModelInfo, ProviderInfo, SkillSummary, PromptSummary } from '$lib/ws/protocol';

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
    toolsList: { name: string; description: string; isBuiltin: boolean }[];
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
    filteredTools: { name: string; description: string; isBuiltin: boolean }[];
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

  function providerColor(id: string): string {
    const map: Record<string, string> = {
      anthropic: '#C06A3A', openai: '#10A37F', google: '#4285F4', gemini: '#4285F4',
      mistral: '#FF7000', groq: '#F55036', cohere: '#39D3C3', deepseek: '#4D90FE',
      xai: '#888888', grok: '#888888', openrouter: '#6E56CF', meta: '#0668E1',
      llama: '#0668E1', bedrock: '#FF9900', aws: '#FF9900',
    };
    const lower = id.toLowerCase();
    for (const [key, color] of Object.entries(map)) { if (lower.includes(key)) return color; }
    return '#6B7280';
  }

  function sourceLabel(source?: string): string | undefined {
    switch (source) {
      case 'environment': return 'env';
      case 'models_json_key': case 'models_json_command': return 'config';
      case 'fallback': return 'config';
      case 'runtime': return 'runtime';
      default: return undefined;
    }
  }
  function canRemove(source?: string): boolean { return source === 'stored'; }
</script>

{#snippet sectionHeader(letter: string, bg: string, label: string, color?: string)}
  <div class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6" style={color ? `color:${color}` : ''}>
    <span class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 {bg}" aria-hidden="true">{letter}</span>
    <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold">{label}</span>
  </div>
{/snippet}

{#snippet skillItem(skill: SkillSummary)}
  <div class="px-5 py-2.5 flex items-start gap-3 transition-colors hover:bg-base-content/[0.03]">
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5 mb-0.5 flex-wrap">
        <span class="text-sm font-mono text-base-content/80 truncate">{skill.name}</span>
        {#if skill.isBuiltin}<span class="shrink-0 px-1.5 py-0.5 rounded text-base-content/30 bg-base-content/6" style="font-size:9px">pkg</span>{/if}
      </span>
      {#if skill.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{skill.description}</span>{/if}
    </span>
    <button onclick={() => onUseSkill(skill.name)} class="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded transition-colors" title="Use skill"><CornerDownLeft class="w-3.5 h-3.5" /></button>
  </div>
{/snippet}

{#snippet promptItem(prompt: PromptSummary)}
  <div class="px-5 py-2.5 flex items-start gap-3 transition-colors hover:bg-base-content/[0.03]">
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5 mb-0.5 flex-wrap">
        <span class="text-sm font-mono text-base-content/80 truncate">{prompt.name}</span>
        {#if prompt.isBuiltin}<span class="shrink-0 px-1.5 py-0.5 rounded text-base-content/30 bg-base-content/6" style="font-size:9px">pkg</span>{/if}
      </span>
      {#if prompt.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{prompt.description}</span>{/if}
    </span>
  </div>
{/snippet}

<SidebarPanel
  title={tab === 'models' ? 'models' : tab === 'tools' ? (toolsList.length ? `tools (${activeToolNames.length}/${toolsList.length})` : 'tools') : 'skills & prompts'}
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
    <div role="tablist" aria-label="Panel sections" tabindex={open ? 0 : -1} class="flex items-center flex-1 bg-base-content/[0.045] border border-base-content/[0.05] rounded-full p-0.5 gap-0.5">
      <button role="tab" aria-selected={tab === 'models'} onclick={() => onTabChange('models')} class="flex-1 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {tab === 'models' ? 'text-base-content bg-base-content/12 shadow-sm shadow-black/10' : 'text-base-content/45 hover:text-base-content/70'}" tabindex={open ? 0 : -1}>models</button>
      <button role="tab" aria-selected={tab === 'tools'} onclick={() => onTabChange('tools')} class="flex-1 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {tab === 'tools' ? 'text-base-content bg-base-content/12 shadow-sm shadow-black/10' : 'text-base-content/45 hover:text-base-content/70'}" tabindex={open ? 0 : -1}>tools{#if toolsList.length} <span class="text-base-content/30 font-normal ml-0.5">{activeToolNames.length}/{toolsList.length}</span>{/if}</button>
      <button role="tab" aria-selected={tab === 'skills'} onclick={() => onTabChange('skills')} class="flex-1 px-2.5 py-1.5 text-xs font-medium rounded-full transition-colors {tab === 'skills' ? 'text-base-content bg-base-content/12 shadow-sm shadow-black/10' : 'text-base-content/45 hover:text-base-content/70'}" tabindex={open ? 0 : -1}>skills</button>
    </div>
    <button onclick={onClose} class="w-8 h-8 flex items-center justify-center text-base-content/40 hover:text-base-content hover:bg-base-content/10 rounded-full transition-all duration-150 shrink-0" aria-label="Close panel"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
  </div>

  {#if tab === 'models'}
    <div class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-base-200/80 to-transparent z-10"></div>
    <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-base-content/6 to-transparent z-10"></div>

    <div class="shrink-0 px-5 py-2 border-b border-base-content/8 flex items-center gap-3">
      <Tabs.Root bind:value={modelTab} class="flex-1">
        <Tabs.List variant="line">
          <Tabs.Trigger value="models" tabindex={open ? 0 : -1}>models</Tabs.Trigger>
          <Tabs.Trigger value="providers" tabindex={open ? 0 : -1}>providers{#if providers.length} <span class="text-base-content/30 font-normal text-xs">{configuredProviderCount}/{providers.length}</span>{/if}</Tabs.Trigger>
        </Tabs.List>
      </Tabs.Root>
    </div>

    {#if modelTab === 'models'}
      {#if model?.reasoning}
        <div class="shrink-0 px-5 py-3.5 border-b border-base-content/8">
          <p class="text-[10px] text-base-content/35 uppercase tracking-[0.12em] mb-3 font-semibold">thinking</p>
          <div class="flex flex-wrap gap-1.5">
            {#each availableThinkingLevels as lvl (lvl)}
              <button onclick={() => onPickThinkingLevel(lvl)} class="px-3 py-1 text-xs font-medium rounded-full border transition-all duration-150 {thinkingLevel === lvl ? 'border-primary/60 text-primary bg-primary/10 glow-primary' : 'border-base-content/12 text-base-content/40 hover:border-base-content/30 hover:text-base-content/70 hover:bg-base-content/5'}" tabindex={open ? 0 : -1}>{lvl}</button>
            {/each}
          </div>
        </div>
      {/if}

      <div class="flex-1 min-h-0 flex flex-col">
        <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
          <div class="relative">
            <svg class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input type="search" placeholder="filter models…" bind:value={modelFilter} class="focus-ring w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35" aria-label="Filter models" tabindex={open ? 0 : -1} />
          </div>
        </div>
        <ScrollArea class="flex-1 min-h-0">
          {#if availableModels.length === 0}
            <div class="flex-1 flex items-center justify-center px-5 py-8"><p class="text-xs text-base-content/45">no models configured</p></div>
          {:else if filteredModelsByProvider.length === 0}
            <div class="flex-1 flex items-center justify-center px-5 py-8"><p class="text-xs text-base-content/20">no match</p></div>
          {:else}
            {#each filteredModelsByProvider as [provider, models] (provider)}
              <div>
                {@render sectionHeader(provider[0].toUpperCase(), '', provider, providerColor(provider))}
                {#each models as m (m.id)}
                  {@const isActive = model?.id === m.id && model?.provider === m.provider}
                  <button onclick={() => onSelectModel(m)} class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive ? 'text-primary bg-primary/[0.06]' : 'text-base-content/70 hover:text-base-content hover:bg-base-content/[0.03]'}" aria-pressed={isActive} tabindex={open ? 0 : -1}>
                    {#if isActive}<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary glow-primary"></span>{/if}
                    <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:{providerColor(provider)}"></span>
                    <span class="flex-1 truncate">{m.name}</span>
                    {#if m.contextWindow}<span class="text-[10px] text-base-content/25 tabular-nums shrink-0">{m.contextWindow >= 1_000_000 ? `${(m.contextWindow / 1_000_000).toFixed(0)}M` : m.contextWindow >= 1_000 ? `${Math.round(m.contextWindow / 1_000)}k` : m.contextWindow}</span>{/if}
                    {#if m.reasoning}<Sparkles class="w-3 h-3 text-secondary/50 shrink-0" aria-label="Supports reasoning" />{/if}
                    {#if isActive}<span class="text-primary shrink-0"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg></span>{/if}
                  </button>
                {/each}
              </div>
            {/each}
          {/if}
        </ScrollArea>
      </div>
    {:else}
      <div class="flex-1 min-h-0 flex flex-col">
        <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
          <div class="relative">
            <svg class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <input type="search" placeholder="filter providers…" bind:value={providerFilter} class="focus-ring w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35" aria-label="Filter providers" tabindex={open ? 0 : -1} />
          </div>
        </div>

        {#if providerError}
          <div class="shrink-0 px-5 py-2.5 bg-error/[0.07] border-b border-error/20 flex items-center justify-between gap-2">
            <span class="text-xs text-error/80 break-words min-w-0">{providerError}</span>
            <Button variant="ghost" size="icon-xs" onclick={onDismissProviderError} aria-label="Dismiss error"><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></Button>
          </div>
        {/if}

        <ScrollArea class="flex-1 min-h-0">
          {#if providers.length === 0}
            <div class="px-5 py-6 space-y-4 animate-pulse">
              {#each [0,1,2] as i (i)}
                <div class="flex items-center gap-3">
                  <div class="flex-1 space-y-1.5">
                    <div class="h-3 bg-base-content/8 rounded w-{['1/3','1/4','2/5'][i]}"></div>
                    <div class="h-2 bg-base-content/5 rounded w-{['1/2','1/3','2/5'][i]}"></div>
                  </div>
                  <div class="w-2 h-2 rounded-full bg-base-content/8"></div>
                </div>
              {/each}
            </div>
          {:else if filteredProviders.length === 0}
            <div class="flex-1 flex items-center justify-center px-5 py-8"><p class="text-xs text-base-content/20">no match</p></div>
          {:else}
            {#each filteredProviders as p (p.id)}
              {@const isCurrentProvider = model?.provider === p.id}
              {@const label = sourceLabel(p.source)}
              <div class="px-5 py-3 border-b border-base-content/6 transition-colors duration-150 {isCurrentProvider ? 'bg-primary/[0.04]' : 'hover:bg-base-content/[0.02]'}">
                <div class="flex items-center gap-3 mb-2">
                  <span class="text-sm flex-1 truncate {p.configured ? 'text-base-content/85' : 'text-base-content/40'} {isCurrentProvider ? 'text-primary' : ''}">{p.name}</span>
                  {#if label}<span class="text-[10px] text-base-content/25 shrink-0 font-mono">{label}</span>{/if}
                  <span class="w-2 h-2 rounded-full shrink-0 {p.configured ? 'bg-primary/70 glow-primary' : 'border border-base-content/25'}" role="img" aria-label={p.configured ? 'Configured' : 'Not configured'}></span>
                  <span class="text-[10px] text-base-content/25 shrink-0">{p.modelCount}m</span>
                </div>
                {#if p.configured}
                  {#if canRemove(p.source)}
                    <Button variant="ghost" size="xs" onclick={() => onRemoveProviderKey(p.id)} tabindex={open ? 0 : -1}>remove key</Button>
                  {:else}
                    <span class="text-xs text-base-content/15">set externally</span>
                  {/if}
                {:else}
                  <div class="flex gap-2 items-center mt-1">
                    <input type="password" placeholder="API key…" bind:value={providerKeyInputs[p.id]} onkeydown={(e) => { if (e.key === 'Enter') onSetProviderKey(p.id); }} class="focus-ring flex-1 bg-transparent border-b border-base-content/10 focus:border-base-content/30 outline-none text-sm py-1.5 placeholder-base-content/15 transition-all duration-150 min-w-0" aria-label="API key for {p.name}" tabindex={open ? 0 : -1} />
                    <button onclick={() => onSetProviderKey(p.id)} disabled={!(providerKeyInputs[p.id] ?? '').trim()} class="text-xs text-base-content/35 hover:text-base-content disabled:opacity-20 transition-all duration-150 shrink-0 px-2 py-1.5" tabindex={open ? 0 : -1}>save</button>
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </ScrollArea>
      </div>
    {/if}

  {:else if tab === 'tools'}
    <div class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-base-200/80 to-transparent z-10"></div>
    <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-base-content/6 to-transparent z-10"></div>

    <div class="flex-1 min-h-0 flex flex-col">
      <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
        <div class="relative">
          <svg class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="search" placeholder="filter tools…" bind:value={toolFilter} class="focus-ring w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35" aria-label="Filter tools" tabindex={open ? 0 : -1} />
        </div>
      </div>
      <ScrollArea class="flex-1 min-h-0">
        {#if toolsList.length === 0}
          <div class="px-5 py-6 space-y-3 animate-pulse">
            {#each [0,1,2,3,4] as i (i)}
              <div class="flex items-center gap-3">
                <div class="w-4 h-4 rounded bg-base-content/8 shrink-0"></div>
                <div class="flex-1 space-y-1.5">
                  <div class="h-3 bg-base-content/8 rounded w-{['1/3','1/2','2/5','1/3','1/4'][i]}"></div>
                  <div class="h-2 bg-base-content/5 rounded w-{['2/3','3/4','1/2','3/5','2/5'][i]}"></div>
                </div>
              </div>
            {/each}
          </div>
        {:else if filteredTools.length === 0}
          <div class="flex-1 flex items-center justify-center px-5 py-8"><p class="text-xs text-base-content/20">no match</p></div>
        {:else}
          {@const builtinTools = filteredTools.filter((t) => t.isBuiltin)}
          {@const customTools = filteredTools.filter((t) => !t.isBuiltin)}
          {#if builtinTools.length > 0}
            {@render sectionHeader('B', 'bg-base-content/30', 'built-in')}
            {#each builtinTools as tool (tool.name)}
              {@const isActive = activeToolNames.includes(tool.name)}
              <button onclick={() => onToggleTool(tool.name)} class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive ? 'hover:bg-base-content/5' : 'opacity-50 hover:opacity-75 hover:bg-base-content/3'}" tabindex={open ? 0 : -1} aria-pressed={isActive}>
                {#if isActive}<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary glow-primary"></span>{/if}
                <span class="min-w-0 flex-1">
                  <span class="text-sm font-mono text-base-content/80 block truncate">{tool.name}</span>
                  {#if tool.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{tool.description}</span>{/if}
                </span>
                <span class="shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors {isActive ? 'border-primary bg-primary' : 'border-base-content/30 bg-transparent'}">{#if isActive}<svg class="w-2.5 h-2.5 text-primary-content" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{/if}</span>
              </button>
            {/each}
          {/if}
          {#if customTools.length > 0}
            {@render sectionHeader('C', 'bg-primary/70', 'custom')}
            {#each customTools as tool (tool.name)}
              {@const isActive = activeToolNames.includes(tool.name)}
              <button onclick={() => onToggleTool(tool.name)} class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive ? 'hover:bg-base-content/5' : 'opacity-50 hover:opacity-75 hover:bg-base-content/3'}" tabindex={open ? 0 : -1} aria-pressed={isActive}>
                {#if isActive}<span class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary glow-primary"></span>{/if}
                <span class="min-w-0 flex-1">
                  <span class="text-sm font-mono text-base-content/80 block truncate">{tool.name}</span>
                  {#if tool.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2">{tool.description}</span>{/if}
                </span>
                <span class="shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors {isActive ? 'border-primary bg-primary' : 'border-base-content/30 bg-transparent'}">{#if isActive}<svg class="w-2.5 h-2.5 text-primary-content" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{/if}</span>
              </button>
            {/each}
          {/if}
        {/if}
      </ScrollArea>
    </div>

    <div class="shrink-0 border-t border-base-content/10 px-5 py-2 flex items-center justify-between">
      <button onclick={() => onSetActiveTools(toolsList.map((t) => t.name))} class="text-xs text-base-content/55 hover:text-base-content/80 transition-colors py-2.5 px-1 -mx-1" tabindex={open ? 0 : -1}>enable all</button>
      <button onclick={() => onSetActiveTools([])} class="text-xs text-base-content/55 hover:text-base-content/80 transition-colors py-2.5 px-1 -mx-1" tabindex={open ? 0 : -1}>disable all</button>
    </div>

  {:else}
    <div class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-base-200/80 to-transparent z-10"></div>
    <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-base-content/6 to-transparent z-10"></div>

    <div class="flex-1 min-h-0 flex flex-col">
      <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
        <div class="relative">
          <svg class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="search" placeholder="filter skills & prompts…" bind:value={skillFilter} class="focus-ring w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35" aria-label="Filter skills and prompts" tabindex={open ? 0 : -1} />
        </div>
      </div>
      <ScrollArea class="flex-1 min-h-0">
        {#if !resourcesLoaded}
          <div class="px-5 py-6 space-y-3 animate-pulse">
            {#each [0,1,2,3] as i (i)}
              <div class="flex items-center gap-3">
                <div class="w-4 h-4 rounded bg-base-content/8 shrink-0"></div>
                <div class="flex-1 space-y-1.5">
                  <div class="h-3 bg-base-content/8 rounded w-{['1/2','2/5','1/3','3/5'][i]}"></div>
                  <div class="h-2 bg-base-content/5 rounded w-{['3/4','1/2','2/3','2/5'][i]}"></div>
                </div>
              </div>
            {/each}
          </div>
        {:else if filteredSkills.skills.length === 0 && filteredSkills.prompts.length === 0}
          <div class="flex-1 flex items-center justify-center px-5 py-8"><p class="text-xs text-base-content/20">{skillFilter.trim() ? 'no match' : 'no skills or prompts found'}</p></div>
        {:else}
          {#if filteredSkills.skills.length > 0}
            {@const projectSkills = filteredSkills.skills.filter((s) => s.scope === 'project')}
            {@const userSkills = filteredSkills.skills.filter((s) => s.scope === 'user')}
            {@const builtinSkills = filteredSkills.skills.filter((s) => s.isBuiltin && s.scope !== 'project' && s.scope !== 'user')}
            {#if projectSkills.length > 0}{@render sectionHeader('P', 'bg-primary/70', 'project skills')}{#each projectSkills as skill (skill.name)}{@render skillItem(skill)}{/each}{/if}
            {#if userSkills.length > 0}{@render sectionHeader('U', 'bg-accent/70', 'user skills')}{#each userSkills as skill (skill.name)}{@render skillItem(skill)}{/each}{/if}
            {#if builtinSkills.length > 0}
              {@render sectionHeader('B', 'bg-base-content/30', 'built-in skills')}
              <div class="opacity-70">{#each builtinSkills as skill (skill.name)}{@render skillItem(skill)}{/each}</div>
            {/if}
          {/if}
          {#if filteredSkills.prompts.length > 0}
            {@const projectPrompts = filteredSkills.prompts.filter((p) => p.scope === 'project')}
            {@const userPrompts = filteredSkills.prompts.filter((p) => p.scope === 'user')}
            {@const builtinPrompts = filteredSkills.prompts.filter((p) => p.isBuiltin)}
            {#if projectPrompts.length > 0}{@render sectionHeader('P', 'bg-primary/70', 'project prompts')}{#each projectPrompts as prompt (prompt.name)}{@render promptItem(prompt)}{/each}{/if}
            {#if userPrompts.length > 0}{@render sectionHeader('U', 'bg-accent/70', 'user prompts')}{#each userPrompts as prompt (prompt.name)}{@render promptItem(prompt)}{/each}{/if}
            {#if builtinPrompts.length > 0}{@render sectionHeader('B', 'bg-base-content/30', 'built-in prompts')}<div class="opacity-70">{#each builtinPrompts as prompt (prompt.name)}{@render promptItem(prompt)}{/each}</div>{/if}
          {/if}
        {/if}
      </ScrollArea>
    </div>

    <div class="shrink-0 border-t border-base-content/10 px-5 py-3 space-y-2">
      <p class="text-xs text-base-content/40 uppercase tracking-wider mb-1">install skill</p>
      <input bind:value={skillInstallUrl} type="url" placeholder="GitHub URL or raw .md URL" class="w-full text-xs bg-base-content/5 border border-base-content/10 rounded-lg px-3 py-2 text-base-content/80 placeholder-base-content/30 focus:outline-none focus:border-primary/50" tabindex={open ? 0 : -1} onkeydown={(e) => { if (e.key === 'Enter' && skillInstallUrl.trim() && !skillInstalling) onInstallSkill(skillInstallUrl.trim(), skillInstallScope); }} />
      <div class="flex items-center gap-2">
        <select bind:value={skillInstallScope} class="text-xs bg-base-content/5 border border-base-content/10 rounded-lg px-2 py-1.5 text-base-content/70 focus:outline-none focus:border-primary/50" tabindex={open ? 0 : -1}>
          <option value="user">user (~/.pi)</option>
          <option value="project">project (.pi)</option>
        </select>
        <button onclick={() => { if (!skillInstallUrl.trim() || skillInstalling) return; onInstallSkill(skillInstallUrl.trim(), skillInstallScope); }} disabled={!skillInstallUrl.trim() || skillInstalling} class="flex-1 text-xs py-1.5 px-3 rounded-lg transition-colors {skillInstalling ? 'bg-base-content/10 text-base-content/30' : 'bg-primary/15 text-primary hover:bg-primary/25'}" tabindex={open ? 0 : -1}>{skillInstalling ? 'installing…' : 'install'}</button>
      </div>
      {#if skillInstallFeedback}
        <p class="text-xs {skillInstallFeedback.success ? 'text-success' : 'text-error'} leading-snug">{skillInstallFeedback.message}</p>
      {/if}
    </div>
  {/if}
</SidebarPanel>
