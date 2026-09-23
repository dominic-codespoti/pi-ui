<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import type { ModelInfo, ScopedModelInfo } from '#lib/ws/protocol.js';
  import { THINKING_LEVEL_CANONICAL } from '#lib/thinking-levels.js';
  let {
    open,
    models,
    scopedModels,
    onClose,
    onSave,
  }: {
    open: boolean;
    models: ModelInfo[];
    scopedModels: ScopedModelInfo[];
    onClose: () => void;
    onSave: (models: ScopedModelInfo[]) => void;
  } = $props();

  let query = $state('');
  let selectedIds = $state<string[]>([]);
  let thinkingLevels = $state<Record<string, string>>({});
  let initialized = $state(false);

  $effect(() => {
    if (!open) {
      initialized = false;
      return;
    }
    if (initialized) return;
    const initial: ScopedModelInfo[] = scopedModels.length
      ? scopedModels
      : models.map((model) => ({ provider: model.provider, modelId: model.id }));
    selectedIds = initial.map((model) => `${model.provider}/${model.modelId}`);
    thinkingLevels = Object.fromEntries(
      initial
        .filter(
          (model): model is ScopedModelInfo & { thinkingLevel: string } => !!model.thinkingLevel
        )
        .map((model) => [`${model.provider}/${model.modelId}`, model.thinkingLevel])
    );
    query = '';
    initialized = true;
  });

  const filteredByProvider = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = needle
      ? models.filter((model) =>
          `${model.provider} ${model.name} ${model.id}`.toLocaleLowerCase().includes(needle)
        )
      : models;
    const groups = new SvelteMap<string, ModelInfo[]>();
    for (const model of filtered) {
      const group = groups.get(model.provider) ?? [];
      group.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  function idOf(model: ModelInfo) {
    return `${model.provider}/${model.id}`;
  }

  function toggle(model: ModelInfo) {
    const id = idOf(model);
    selectedIds = selectedIds.includes(id)
      ? selectedIds.filter((selected) => selected !== id)
      : [...selectedIds, id];
  }

  function save() {
    onSave(
      models
        .filter((model) => selectedIds.includes(idOf(model)))
        .map((model) => ({
          provider: model.provider,
          modelId: model.id,
          ...(thinkingLevels[idOf(model)] ? { thinkingLevel: thinkingLevels[idOf(model)] } : {}),
        }))
    );
    onClose();
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(next) => {
    if (!next) onClose();
  }}
>
  <Dialog.Content
    class="relative flex max-h-[min(85vh,48rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-base-content/10 bg-base-100 p-0 shadow-2xl"
  >
    <header class="flex items-start justify-between gap-4 border-b border-base-content/8 px-5 py-4">
      <div>
        <Dialog.Title class="text-sm font-semibold text-base-content">Scope models</Dialog.Title>
        <Dialog.Description class="mt-1 text-xs text-base-content/45"
          >Choose models available for cycling. Saved to your Pi settings.</Dialog.Description
        >
      </div>
      <button class="btn btn-ghost btn-xs" onclick={onClose} aria-label="Close scope models"
        >Close</button
      >
    </header>
    <div class="border-b border-base-content/8 px-5 py-3">
      <input
        type="search"
        name="scoped-models-search"
        autocomplete="off"
        spellcheck="false"
        data-1p-ignore
        data-lpignore="true"
        data-bwignore
        data-form-type="other"
        bind:value={query}
        class="input input-sm w-full bg-base-200/50"
        placeholder="Search models or providers…"
        aria-label="Search models"
      />
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto px-3 py-2">
      {#if filteredByProvider.length === 0}
        <p class="px-3 py-8 text-center text-xs text-base-content/40">No matching models</p>
      {:else}
        {#each filteredByProvider as [provider, providerModels] (provider)}
          <section class="mb-3" aria-label={`${provider} models`}>
            <h3
              class="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-base-content/40"
            >
              {provider}
            </h3>
            {#each providerModels as model (model.id)}
              {@const id = idOf(model)}
              <div
                class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-base-content/[0.03]"
              >
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm checkbox-primary"
                  checked={selectedIds.includes(id)}
                  onchange={() => toggle(model)}
                  aria-label={`Include ${model.name}`}
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-xs text-base-content/80">{model.name}</span>
                  <span class="block truncate text-[10px] text-base-content/35">{model.id}</span>
                </span>
                {#if model.reasoning}
                  <select
                    class="select select-xs max-w-28 bg-base-200/60 text-[10px]"
                    value={thinkingLevels[id] ?? ''}
                    onchange={(event) => {
                      const value = event.currentTarget.value;
                      thinkingLevels = { ...thinkingLevels, [id]: value };
                    }}
                    aria-label={`Thinking level for ${model.name}`}
                  >
                    <option value="">Default thinking</option>
                    {#each THINKING_LEVEL_CANONICAL as level (level)}
                      <option value={level}>{level}</option>
                    {/each}
                  </select>
                {/if}
              </div>
            {/each}
          </section>
        {/each}
      {/if}
    </div>
    <footer
      class="flex items-center justify-between gap-3 border-t border-base-content/8 px-5 py-3"
    >
      <button
        class="btn btn-ghost btn-xs text-base-content/55"
        onclick={() => {
          selectedIds = [];
          thinkingLevels = {};
        }}>Clear scope</button
      >
      <div class="flex items-center gap-2">
        <span class="text-[10px] text-base-content/35">{selectedIds.length} selected</span>
        <button class="btn btn-primary btn-sm" onclick={save}>Save scope</button>
      </div>
    </footer>
  </Dialog.Content>
</Dialog.Root>
