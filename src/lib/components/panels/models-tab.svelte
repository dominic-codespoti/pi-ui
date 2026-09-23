<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Tabs from '#lib/components/ui/tabs/index.js';
  import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Eye from '@lucide/svelte/icons/eye';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import type { ModelInfo, ProviderInfo } from '#lib/ws/protocol.js';
  import { providerColor, sourceLabel, canRemove, fmtPricePerMillion } from '#lib/utils.js';

  let {
    open,
    modelTab = $bindable(),
    model,
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
    providerLoginPending,
    onSelectModel,
    onPickThinkingLevel,
    onSetProviderKey,
    onRemoveProviderKey,
    onProviderLogin,
    onDismissProviderError,
    onRefreshModels,
  }: {
    open: boolean;
    modelTab: 'models' | 'providers';
    model: ModelInfo | null;
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
    providerLoginPending: string | null;
    onSelectModel: (m: ModelInfo) => void;
    onPickThinkingLevel: (level: string) => void;
    onSetProviderKey: (id: string) => void;
    onRemoveProviderKey: (id: string) => void;
    onProviderLogin: (id: string) => void;
    onDismissProviderError: () => void;
    onRefreshModels: () => void;
  } = $props();
  const userTypedProviderKeys = new SvelteSet<string>();
  const unconfiguredProviderCount = $derived(providers.filter((p) => !p.configured).length);
  const compactTokens = (n: number) =>
    n >= 1_000_000
      ? `${Math.round(n / 1_000_000)}M`
      : n >= 1_000
        ? `${Math.round(n / 1_000)}k`
        : `${n}`;
  function modelDetailsTitle(model: ModelInfo): string {
    const prices = model.cost
      ? `Input ${fmtPricePerMillion(model.cost.input)} · output ${fmtPricePerMillion(model.cost.output)} · cache read ${fmtPricePerMillion(model.cost.cacheRead)} · cache write ${fmtPricePerMillion(model.cost.cacheWrite)} per Mtok`
      : 'Pricing unknown';
    const thinking = Object.keys(model.thinkingLevelMap ?? {}).filter(
      (level) => model.thinkingLevelMap?.[level] !== null
    );
    return [
      model.id,
      prices,
      model.maxTokens ? `${model.maxTokens.toLocaleString()} output tokens` : undefined,
      thinking.length ? `Thinking: ${thinking.join(', ')}` : undefined,
    ]
      .filter(Boolean)
      .join('\n');
  }
  function authSourceText(provider: ProviderInfo): string | undefined {
    if (provider.oauthAuthenticated) return 'OAuth';
    switch (provider.source) {
      case 'stored':
        return 'stored key';
      case 'runtime':
        return 'runtime key';
      case 'environment':
        return 'environment variable';
      case 'fallback':
        return 'ambient credentials';
      case 'models_json_key':
      case 'models_json_command':
        return 'models.json';
      default:
        return sourceLabel(provider.source);
    }
  }
  function providerHeaderText(provider?: ProviderInfo): string {
    if (!provider) return 'not signed in';
    if (provider.oauthAuthenticated) return 'OAuth';
    return provider.authLabel ?? authSourceText(provider) ?? 'not signed in';
  }
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

<div class="shrink-0 pl-5 pr-3 py-2.5 border-b border-base-content/8 flex items-center gap-2">
  <Tabs.Root bind:value={modelTab} class="min-w-0 flex-1">
    <Tabs.List variant="line" class="gap-4">
      <Tabs.Trigger value="models" tabindex={open ? 0 : -1}>models</Tabs.Trigger>
      <Tabs.Trigger value="providers" tabindex={open ? 0 : -1} class="gap-1.5"
        >providers{#if providers.length}
          <span class="text-base-content/30 font-normal text-[10px] tabular-nums"
            >{configuredProviderCount}/{providers.length}</span
          >{/if}</Tabs.Trigger
      >
    </Tabs.List>
  </Tabs.Root>
  <Button
    variant="ghost"
    size="icon-sm"
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
  {#if availableThinkingLevels.length > 0}
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
          name="models-panel-model-filter"
          autocomplete="off"
          spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          placeholder="filter models…"
          bind:value={modelFilter}
          class="focus-ring w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35"
          aria-label="Filter models"
          tabindex={open ? 0 : -1}
        />
      </div>
    </div>
    <ScrollArea class="flex-1 min-h-0">
      {#if filteredModelsByProvider.length === 0}
        <div class="flex flex-col items-center gap-2 px-5 py-8 text-center">
          <p class="text-xs text-base-content/40">
            {modelFilter.trim() ? 'no match' : 'No signed-in providers yet'}
          </p>
          {#if !modelFilter.trim()}
            <Button
              variant="ghost"
              size="xs"
              onclick={() => (modelTab = 'providers')}
              tabindex={open ? 0 : -1}>Sign in to a provider</Button
            >
          {/if}
        </div>
      {:else}
        {#each filteredModelsByProvider as [provider, models] (provider)}
          {@const providerInfo = providers.find((item) => item.id === provider)}
          <div>
            {@render sectionHeader(
              provider[0].toUpperCase(),
              '',
              `${provider} · ${providerHeaderText(providerInfo)} · ${models.length} models`,
              providerColor(provider)
            )}
            {#each models as m (m.id)}
              {@const isActive = model?.id === m.id && model?.provider === m.provider}
              {@const included = providerInfo?.subscription || providerInfo?.oauthSubscription}
              <button
                onclick={() => onSelectModel(m)}
                title={modelDetailsTitle(m)}
                class="w-full text-left px-5 py-2 transition-all duration-150 flex items-start gap-2.5 relative {isActive
                  ? 'text-primary bg-primary/[0.06]'
                  : 'text-base-content/70 hover:text-base-content hover:bg-base-content/[0.03]'}"
                aria-pressed={isActive}
                tabindex={open ? 0 : -1}
              >
                {#if isActive}<span
                    class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary glow-primary"
                  ></span>{/if}
                <span
                  class="mt-[7px] w-1.5 h-1.5 rounded-full shrink-0"
                  style="background:{providerColor(provider)}"
                ></span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-sm">{m.name}</span>
                    {#if isActive}<svg
                        class="w-3.5 h-3.5 shrink-0 text-primary"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"><path d="m20 6-11 11-5-5" /></svg
                      >{/if}
                  </span>
                  <span
                    class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-base-content/35"
                  >
                    {#if m.contextWindow}<span>{compactTokens(m.contextWindow)} ctx</span>{/if}
                    {#if m.maxTokens}<span>{compactTokens(m.maxTokens)} out</span>{/if}
                    {#if included}
                      <span class="text-secondary/70">included</span>
                    {:else if m.cost}
                      <span
                        >{fmtPricePerMillion(m.cost.input)} / {fmtPricePerMillion(m.cost.output)}
                        per Mtok</span
                      >
                    {/if}
                    {#if !m.input || m.input.includes('image')}
                      <Eye class="w-3 h-3" aria-label="Image input" />
                    {/if}
                    {#if m.reasoning}<Sparkles
                        class="w-3 h-3 text-secondary/50"
                        aria-label="Supports reasoning"
                      />{/if}
                    {#if m.isDefault}<span class="text-success/70">default</span>{/if}
                  </span>
                </span>
              </button>
            {/each}
          </div>
        {/each}
        {#if (providers.length === 0 || unconfiguredProviderCount > 0) && !modelFilter.trim()}
          <button
            type="button"
            onclick={() => (modelTab = 'providers')}
            tabindex={open ? 0 : -1}
            class="w-full px-5 py-3 text-left text-[11px] text-base-content/35 hover:text-base-content/70 transition-colors"
          >
            {unconfiguredProviderCount > 0
              ? `${unconfiguredProviderCount} more provider${unconfiguredProviderCount === 1 ? '' : 's'} available`
              : 'More providers available'} — sign in to see their models →
          </button>
        {/if}
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
          name="models-panel-provider-filter"
          autocomplete="off"
          spellcheck="false"
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
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
    <p class="px-5 py-2 text-[10px] text-base-content/35 border-b border-base-content/6">
      Credential precedence: runtime key → stored key → models.json → environment variable or
      ambient credentials.
    </p>

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
          {@const isPending = providerLoginPending === p.id}
          {@const label = p.authLabel ?? authSourceText(p)}
          <div
            class="px-5 py-3 border-b border-base-content/6 transition-colors duration-300 {isCurrentProvider
              ? 'bg-primary/[0.04]'
              : 'hover:bg-base-content/[0.02]'}"
          >
            <div class="flex items-center gap-3 mb-2">
              <span
                class="text-sm flex-1 min-w-0 truncate {p.configured
                  ? 'text-base-content/85'
                  : 'text-base-content/40'} {isCurrentProvider ? 'text-primary' : ''}"
                >{p.name}</span
              >
              {#if label}<span
                  class="text-[10px] text-base-content/50 shrink-0 font-mono truncate max-w-[45%]"
                  title={label}>{label}</span
                >{/if}
              <span
                class="w-2 h-2 rounded-full shrink-0 {p.configured
                  ? 'bg-primary/70 glow-primary'
                  : 'border border-base-content/25'}"
                role="img"
                aria-label={p.configured ? 'Configured' : 'Not configured'}
              ></span>
              <button
                class="text-[10px] text-base-content/35 hover:text-primary shrink-0"
                onclick={() => {
                  modelTab = 'models';
                  modelFilter = '';
                  providerFilter = p.id;
                }}
                aria-label="Show {p.modelCount} models from {p.name}"
                tabindex={open ? 0 : -1}>{p.modelCount} models</button
              >
            </div>
            {#if p.baseUrl}
              <p class="mb-2 truncate text-[10px] text-base-content/30 font-mono" title={p.baseUrl}>
                {p.baseUrl}
              </p>
            {/if}
            <div class="flex flex-wrap gap-1.5 items-center mb-2">
              {#if p.oauthLoginLabel}<span
                  class="rounded-full bg-secondary/10 px-1.5 py-0.5 text-[9px] text-secondary/75"
                  >OAuth</span
                >{/if}
              {#if p.apiKeyLogin}<span
                  class="rounded-full bg-base-content/5 px-1.5 py-0.5 text-[9px] text-base-content/45"
                  >API key</span
                >{/if}
              {#if p.subscription || p.oauthSubscription}<span
                  class="rounded-full bg-success/10 px-1.5 py-0.5 text-[9px] text-success/75"
                  >Subscription</span
                >{/if}
              {#if isPending}<span
                  class="inline-flex items-center gap-1 text-[10px] text-primary/70"
                  ><LoaderCircle class="w-3 h-3 animate-spin" />Signing in…</span
                >{/if}
            </div>
            <div class="flex flex-wrap gap-2 items-center">
              {#if p.oauthLoginLabel && !p.oauthAuthenticated}
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={isPending}
                  onclick={() => onProviderLogin(p.id)}
                  tabindex={open ? 0 : -1}>{p.oauthLoginLabel}</Button
                >
              {/if}
              {#if p.oauthAuthenticated}
                <Button
                  variant="ghost"
                  size="xs"
                  onclick={() => onRemoveProviderKey(p.id)}
                  tabindex={open ? 0 : -1}>Sign out</Button
                >
              {:else if p.configured && canRemove(p.source)}
                <Button
                  variant="ghost"
                  size="xs"
                  onclick={() => onRemoveProviderKey(p.id)}
                  tabindex={open ? 0 : -1}>remove key</Button
                >
              {:else if p.configured}
                <span class="text-xs text-base-content/35">configured outside pi</span>
              {/if}
              {#if !p.configured && p.apiKeyLogin}
                <input
                  type="password"
                  name="provider-api-key-{p.id}"
                  autocomplete="new-password"
                  disabled={isPending}
                  data-1p-ignore
                  data-lpignore="true"
                  data-bwignore
                  data-form-type="other"
                  spellcheck="false"
                  autocapitalize="off"
                  autocorrect="off"
                  placeholder="API key…"
                  bind:value={providerKeyInputs[p.id]}
                  oninput={() => userTypedProviderKeys.add(p.id)}
                  onkeydown={(e) => {
                    if (
                      e.key === 'Enter' &&
                      userTypedProviderKeys.has(p.id) &&
                      providerKeyInputs[p.id]?.trim()
                    )
                      onSetProviderKey(p.id);
                  }}
                  class="focus-ring flex-1 bg-transparent border-b border-base-content/10 focus:border-base-content/30 outline-none text-sm py-1.5 placeholder-base-content/15 transition-all duration-150 min-w-0"
                  aria-label="API key for {p.name}"
                  tabindex={open ? 0 : -1}
                />
                {#if userTypedProviderKeys.has(p.id) && providerKeyInputs[p.id]?.trim()}
                  <button
                    disabled={isPending}
                    onclick={() => onSetProviderKey(p.id)}
                    class="text-xs text-base-content/35 hover:text-base-content transition-all duration-150 shrink-0 px-2 py-1.5"
                    tabindex={open ? 0 : -1}>save</button
                  >
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      {/if}
    </ScrollArea>
  </div>
{/if}
