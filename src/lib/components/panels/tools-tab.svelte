<script lang="ts">
  import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
  import ToolRow from './tool-row.svelte';

  type Tool = { name: string; description: string; isBuiltin: boolean; origin?: string };

  let {
    open,
    toolsList,
    activeToolNames,
    toolFilter = $bindable(),
    filteredTools,
    onToggleTool,
    onSetActiveTools,
  }: {
    open: boolean;
    toolsList: Tool[];
    activeToolNames: string[];
    toolFilter: string;
    filteredTools: Tool[];
    onToggleTool: (name: string) => void;
    onSetActiveTools: (names: string[]) => void;
  } = $props();

  const activeToolSet = $derived(new Set(activeToolNames));
  const builtinTools = $derived(filteredTools.filter((t) => t.isBuiltin));
  const customTools = $derived(filteredTools.filter((t) => !t.isBuiltin));
  const customToolsByOrigin = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local grouping Map, not reactive state
    const groups = new Map<string, typeof customTools>();
    for (const t of customTools) {
      const key = t.origin || 'custom';
      const g = groups.get(key);
      if (g) g.push(t);
      else groups.set(key, [t]);
    }
    return [...groups.entries()] as [string, typeof customTools][];
  });
</script>

{#snippet sectionHeader(letter: string, bg: string, label: string)}
  <div
    class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6"
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
        placeholder="filter tools…"
        bind:value={toolFilter}
        class="focus-ring w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35"
        aria-label="Filter tools"
        tabindex={open ? 0 : -1}
      />
    </div>
  </div>
  <ScrollArea class="flex-1 min-h-0">
    {#if toolsList.length === 0}
      <div class="px-5 py-6 space-y-3 animate-pulse">
        {#each [0, 1, 2, 3, 4] as i (i)}
          <div class="flex items-center gap-3">
            <div class="w-4 h-4 rounded bg-base-content/8 shrink-0"></div>
            <div class="flex-1 space-y-1.5">
              <div
                class="h-3 bg-base-content/8 rounded w-{['1/3', '1/2', '2/5', '1/3', '1/4'][i]}"
              ></div>
              <div
                class="h-2 bg-base-content/5 rounded w-{['2/3', '3/4', '1/2', '3/5', '2/5'][i]}"
              ></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if filteredTools.length === 0}
      <div class="flex-1 flex items-center justify-center px-5 py-8">
        <p class="text-xs text-base-content/20">no match</p>
      </div>
    {:else}
      {#if builtinTools.length > 0}
        {@render sectionHeader('B', 'bg-base-content/30', 'built-in')}
        {#each builtinTools as tool (tool.name)}
          <ToolRow
            {tool}
            active={activeToolSet.has(tool.name)}
            {open}
            onToggle={() => onToggleTool(tool.name)}
          />
        {/each}
      {/if}
      {#each customToolsByOrigin as [origin, tools] (origin)}
        {@render sectionHeader('C', 'bg-primary/70', origin)}
        {#each tools as tool (tool.name)}
          <ToolRow
            {tool}
            active={activeToolSet.has(tool.name)}
            {open}
            onToggle={() => onToggleTool(tool.name)}
          />
        {/each}
      {/each}
    {/if}
  </ScrollArea>
</div>

<div class="shrink-0 border-t border-base-content/10 px-5 py-2 flex items-center justify-between">
  <button
    onclick={() => onSetActiveTools(toolsList.map((t) => t.name))}
    class="text-xs text-base-content/55 hover:text-base-content/80 transition-colors py-2.5 px-1 -mx-1"
    tabindex={open ? 0 : -1}>enable all</button
  >
  <button
    onclick={() => onSetActiveTools([])}
    class="text-xs text-base-content/55 hover:text-base-content/80 transition-colors py-2.5 px-1 -mx-1"
    tabindex={open ? 0 : -1}>disable all</button
  >
</div>
