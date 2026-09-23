<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Tabs from '#lib/components/ui/tabs/index.js';
  import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import type { ModelInfo, ProviderInfo } from '#lib/ws/protocol.js';
  import { providerColor, sourceLabel, canRemove } from '#lib/utils.js';

  let {
    open,
    modelTab = $bindable(),
    model,
    availableModels,
    modelRefreshLoading,
    modelRefreshFeedback,
    thinkingLevel,
    availableThinkingLevels,
    providers,
    providerError = $bindable(),
    providerKeyInputs = $bindable(),
    providerFilter = $bindable(),
    modelFilter = $bindable(),
    filteredProviders,
    configuredProviderCount,
    filteredModelsByProvider,
    onSelectModel,
    onPickThinkingLevel,
    onSetProviderKey,
    onRemoveProviderKey,
    onDismissProviderError,
    onRefreshModels,
  }: {
    open: boolean;
    modelTab: 'models' | 'providers';
    model: ModelInfo | null;
    availableModels: ModelInfo[];
    modelRefreshLoading: boolean;
    modelRefreshFeedback: { success: boolean; message: string } | null;
    thinkingLevel: string;
    availableThinkingLevels: readonly string[];
    providers: ProviderInfo[];
    providerError: string | null;
    providerKeyInputs: Record<string, string>;
    providerFilter: string;
    modelFilter: string;
    filteredProviders: ProviderInfo[];
    configuredProviderCount: number;
    filteredModelsByProvider: [string, ModelInfo[]][];
    onSelectModel: (m: ModelInfo) => void;
    onPickThinkingLevel: (level: string) => void;
    onSetProviderKey: (id: string) => void;
    onRemoveProviderKey: (id: string) => void;
    onDismissProviderError: () => void;
    onRefreshModels: () => void;
  } = $props();
</script>

{#snippet sectionHeader(letter: string, bg: string, label: string, color?: string)}
  <div
    class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6"
    style={color ? `color:${color}` : ''}
  >
    <span
      class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 {bg}"
      aria-hidden="true">{letter}</span
    >
    <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold"
      >{label}</span
    >
  </div>
{/snippet}

<div
  class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-base-200/80 to-transparent z-10"
></div>
<div
  class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-base-content/6 to-transparent z-10"
></div>

<div class="shrink-0 px-5 py-2 border-b border-base-content/8 flex items-center gap-3">
  <Tabs.Root bind:value={modelTab} class="min-w-0">
    <Tabs.List variant="line">
      <Tabs.Trigger value="models" tabindex={open ? 0 : -1}>models</Tabs.Trigger>
      <Tabs.Trigger value="providers" tabindex={open ? 0 : -1}
        >providers{#if providers.length}
          <span class="text-base-content/30 font-normal text-xs"
            >{configuredProviderCount}/{providers.length}</span
          >{/if}</Tabs.Trigger
      >
    </Tabs.List>
  </Tabs.Root>
  <Button
    variant="ghost"
    size="icon"
    onclick={onRefreshModels}
    disabled={modelRefreshLoading || !open}
    aria-label={modelRefreshLoading ? 'Refreshing model catalog' : 'Refresh model catalog'}
    title="Refresh model catalog"
    aria-busy={modelRefreshLoading}
    tabindex={open ? 0 : -1}
    class="shrink-0 text-base-content/35 hover:text-base-content/70"
  >
    <RefreshCw class="h-3.5 w-3.5 {modelRefreshLoading ? 'animate-spin' : ''}" aria-hidden="true" />
  </Button>
</div>
{#if modelRefreshFeedback}
  <div
    class="shrink-0 px-5 py-1.5 text-[11px] border-b {modelRefreshFeedback.success
      ? 'text-success/75 bg-success/[0.04] border-success/10'
      : 'text-error/80 bg-error/[0.07] border-error/20'}"
    role="status"
    aria-live="polite"
  >
    {modelRefreshFeedback.message}
  </div>
{/if}

{#if modelTab === 'models'}
  {#if model?.reasoning}
    <div class="shrink-0 px-5 py-3.5 border-b border-base-content/8">
      <p class="text-[10px] text-base-content/35 uppercase tracking-[0.12em] mb-3 font-semibold">
        thinking
      </p>
      <div class="flex flex-wrap gap-1.5">
        {#each availableThinkingLevels as lvl (lvl)}
          <button
            onclick={() => onPickThinkingLevel(lvl)}
            class="px-3 py-1 text-xs font-medium rounded-full border transition-all duration-150 {thinkingLevel ===
            lvl
              ? 'border-primary/60 text-primary bg-primary/10 glow-primary'
              : 'border-base-content/12 text-base-content/40 hover:border-base-content/30 hover:text-base-content/70 hover:bg-base-content/5'}"
            tabindex={open ? 0 : -1}>{lvl}</button
          >
        {/each}
      </div>
    </div>
  {/if}

  <div class="flex-1 min-h-0 flex flex-col">
    <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
      <div class="relative">
        <svg
          class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg
        >
        <input
          type="search"
          placeholder="filter models…"
          bind:value={modelFilter}
          class="focus-ring w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35"
          aria-label="Filter models"
          tabindex={open ? 0 : -1}
        />
      </div>
    </div>
    <ScrollArea class="flex-1 min-h-0">
      {#if availableModels.length === 0}
        <div class="flex-1 flex items-center justify-center px-5 py-8">
          <p class="text-xs text-base-content/45">no models configured</p>
        </div>
      {:else if filteredModelsByProvider.length === 0}
        <div class="flex-1 flex items-center justify-center px-5 py-8">
          <p class="text-xs text-base-content/20">no match</p>
        </div>
      {:else}
        {#each filteredModelsByProvider as [provider, models] (provider)}
          <div>
            {@render sectionHeader(
              provider[0].toUpperCase(),
              '',
              provider,
              providerColor(provider)
            )}
            {#each models as m (m.id)}
              {@const isActive = model?.id === m.id && model?.provider === m.provider}
              <button
                onclick={() => onSelectModel(m)}
                class="w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {isActive
                  ? 'text-primary bg-primary/[0.06]'
                  : 'text-base-content/70 hover:text-base-content hover:bg-base-content/[0.03]'}"
                aria-pressed={isActive}
                tabindex={open ? 0 : -1}
              >
                {#if isActive}<span
                    class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary glow-primary"
                  ></span>{/if}
                <span
                  class="w-1.5 h-1.5 rounded-full shrink-0"
                  style="background:{providerColor(provider)}"
                ></span>
                <span class="flex-1 truncate">{m.name}</span>
                {#if m.contextWindow}<span
                    class="text-[10px] text-base-content/25 tabular-nums shrink-0"
                    >{m.contextWindow >= 1_000_000
                      ? `${(m.contextWindow / 1_000_000).toFixed(0)}M`
                      : m.contextWindow >= 1_000
                        ? `${Math.round(m.contextWindow / 1_000)}k`
                        : m.contextWindow}</span
                  >{/if}
                {#if m.reasoning}<Sparkles
                    class="w-3 h-3 text-secondary/50 shrink-0"
                    aria-label="Supports reasoning"
                  />{/if}
                {#if isActive}<span class="text-primary shrink-0"
                    ><svg
                      class="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"><path d="m20 6-11 11-5-5" /></svg
                    ></span
                  >{/if}
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
        <svg
          class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg
        >
        <input
          type="search"
          placeholder="filter providers…"
          bind:value={providerFilter}
          class="focus-ring w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35"
          aria-label="Filter providers"
          tabindex={open ? 0 : -1}
        />
      </div>
    </div>

    {#if providerError}
      <div
        class="shrink-0 px-5 py-2.5 bg-error/[0.07] border-b border-error/20 flex items-center justify-between gap-2"
      >
        <span class="text-xs text-error/80 break-words min-w-0">{providerError}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={onDismissProviderError}
          aria-label="Dismiss error"
          ><svg
            class="w-3.5 h-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg
          ></Button
        >
      </div>
    {/if}

    <ScrollArea class="flex-1 min-h-0">
      {#if providers.length === 0}
        <div class="px-5 py-6 space-y-4 animate-pulse">
          {#each [0, 1, 2] as i (i)}
            <div class="flex items-center gap-3">
              <div class="flex-1 space-y-1.5">
                <div class="h-3 bg-base-content/8 rounded w-{['1/3', '1/4', '2/5'][i]}"></div>
                <div class="h-2 bg-base-content/5 rounded w-{['1/2', '1/3', '2/5'][i]}"></div>
              </div>
              <div class="w-2 h-2 rounded-full bg-base-content/8"></div>
            </div>
          {/each}
        </div>
      {:else if filteredProviders.length === 0}
        <div class="flex-1 flex items-center justify-center px-5 py-8">
          <p class="text-xs text-base-content/20">no match</p>
        </div>
      {:else}
        {#each filteredProviders as p (p.id)}
          {@const isCurrentProvider = model?.provider === p.id}
          {@const label = sourceLabel(p.source)}
          <div
            class="px-5 py-3 border-b border-base-content/6 transition-colors duration-150 {isCurrentProvider
              ? 'bg-primary/[0.04]'
              : 'hover:bg-base-content/[0.02]'}"
          >
            <div class="flex items-center gap-3 mb-2">
              <span
                class="text-sm flex-1 truncate {p.configured
                  ? 'text-base-content/85'
                  : 'text-base-content/40'} {isCurrentProvider ? 'text-primary' : ''}"
                >{p.name}</span
              >
              {#if label}<span class="text-[10px] text-base-content/25 shrink-0 font-mono"
                  >{label}</span
                >{/if}
              <span
                class="w-2 h-2 rounded-full shrink-0 {p.configured
                  ? 'bg-primary/70 glow-primary'
                  : 'border border-base-content/25'}"
                role="img"
                aria-label={p.configured ? 'Configured' : 'Not configured'}
              ></span>
              <span class="text-[10px] text-base-content/25 shrink-0">{p.modelCount}m</span>
            </div>
            {#if p.configured}
              {#if canRemove(p.source)}
                <Button
                  variant="ghost"
                  size="xs"
                  onclick={() => onRemoveProviderKey(p.id)}
                  tabindex={open ? 0 : -1}>remove key</Button
                >
              {:else}
                <span class="text-xs text-base-content/15">set externally</span>
              {/if}
            {:else}
              <div class="flex gap-2 items-center mt-1">
                <input
                  type="password"
                  placeholder="API key…"
                  bind:value={providerKeyInputs[p.id]}
                  onkeydown={(e) => {
                    if (e.key === 'Enter') onSetProviderKey(p.id);
                  }}
                  class="focus-ring flex-1 bg-transparent border-b border-base-content/10 focus:border-base-content/30 outline-none text-sm py-1.5 placeholder-base-content/15 transition-all duration-150 min-w-0"
                  aria-label="API key for {p.name}"
                  tabindex={open ? 0 : -1}
                />
                <button
                  onclick={() => onSetProviderKey(p.id)}
                  disabled={!(providerKeyInputs[p.id] ?? '').trim()}
                  class="text-xs text-base-content/35 hover:text-base-content disabled:opacity-20 transition-all duration-150 shrink-0 px-2 py-1.5"
                  tabindex={open ? 0 : -1}>save</button
                >
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </ScrollArea>
  </div>
{/if}
