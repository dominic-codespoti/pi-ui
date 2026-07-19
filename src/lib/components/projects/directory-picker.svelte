<script lang="ts">
  /**
   * Path input with server-driven directory autocomplete.
   * Used by the projects sidebar ("new project") and the project picker.
   *
   * Keys: ArrowUp/Down navigate completions · Tab accepts the highlighted
   * (or first) completion · Enter submits · Escape cancels.
   */
  import { projectsState } from '$lib/state/projects-state.svelte';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right';
  import X from '@lucide/svelte/icons/x';

  let {
    placeholder = '~/path/to/project',
    submitLabel = 'open',
    tabbable = true,
    onSubmit,
    onCancel,
  }: {
    placeholder?: string;
    submitLabel?: string;
    tabbable?: boolean;
    onSubmit: (path: string) => void;
    onCancel?: () => void;
  } = $props();

  let value = $state('');
  let highlight = $state(-1);
  let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const completions = $derived(projectsState.dirCompletions);

  $effect(() => {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    if (value.trim()) {
      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        projectsState.requestDirCompletions(value);
      }, 200);
    } else {
      projectsState.dirCompletions = [];
    }
    highlight = -1;
    return () => { if (_debounceTimer) clearTimeout(_debounceTimer); };
  });

  function acceptCompletion(entry: string) {
    value = entry;
    projectsState.dirCompletions = [];
    highlight = -1;
  }

  function submit() {
    const path = value.trim();
    if (!path) return;
    onSubmit(path);
    value = '';
    projectsState.dirCompletions = [];
    highlight = -1;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (highlight >= 0 && highlight < completions.length) acceptCompletion(completions[highlight]);
      else submit();
    } else if (e.key === 'Tab' && completions.length > 0) {
      e.preventDefault();
      acceptCompletion(completions[Math.max(0, highlight)]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (completions.length > 0) highlight = highlight < completions.length - 1 ? highlight + 1 : 0;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (completions.length > 0) highlight = highlight > 0 ? highlight - 1 : completions.length - 1;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      value = '';
      projectsState.dirCompletions = [];
      highlight = -1;
      onCancel?.();
    }
  }
</script>

<div class="space-y-2">
  <div class="flex items-center gap-2 rounded-[1.4rem] border border-base-content/14 bg-base-content/[0.035] px-3.5 sm:px-4 py-2.5 sm:py-3 shadow-inner shadow-black/10 transition-colors focus-within:border-base-content/55 focus-within:bg-base-content/[0.045]">
    <FolderPlus class="w-4 h-4 shrink-0 text-base-content/42" />
    <!-- svelte-ignore a11y_autofocus -->
    <input
      autofocus
      type="text"
      bind:value
      {placeholder}
      class="focus-ring flex-1 min-w-0 bg-transparent outline-none text-base sm:text-sm text-base-content/84 placeholder-base-content/32 font-mono"
      aria-label="Project directory path"
      tabindex={tabbable ? 0 : -1}
      onkeydown={onKeydown}
    />
    {#if value.trim()}
      <button
        onclick={submit}
        class="shrink-0 rounded-full px-2 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-primary/75 transition-colors hover:bg-primary/10 hover:text-primary"
        tabindex={tabbable ? 0 : -1}
      >{submitLabel}</button>
    {:else if onCancel}
      <button
        onclick={onCancel}
        class="shrink-0 rounded-full p-1.5 text-base-content/35 transition-colors hover:bg-base-content/8 hover:text-base-content/70"
        aria-label="Cancel project path entry"
        tabindex={tabbable ? 0 : -1}
      ><X class="w-3.5 h-3.5" /></button>
    {/if}
  </div>

  <div class="rounded-2xl bg-base-content/[0.035] border border-base-content/6 px-2.5 sm:px-3 py-2.5 min-h-12">
    {#if value.trim()}
      <button
        onclick={submit}
        class="w-full flex items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-base-content/8"
        tabindex={tabbable ? 0 : -1}
      >
        <CornerDownRight class="w-3.5 h-3.5 shrink-0 text-base-content/32" />
        <span class="min-w-0 flex-1 truncate font-mono text-sm text-base-content/75">{value.trim()}</span>
        <span class="text-[10px] uppercase tracking-[0.16em] text-primary/70">{submitLabel}</span>
      </button>
    {:else}
      <p class="px-2 py-1.5 font-mono text-sm text-base-content/24">{placeholder}</p>
    {/if}

    {#if completions.length > 0}
      <div class="mt-2 flex max-h-[min(11rem,28dvh)] flex-col gap-0.5 overflow-y-auto overscroll-contain border-t border-base-content/8 pt-2" role="listbox" aria-label="Directory completions">
        {#each completions as entry, i (entry)}
          <button
            onclick={() => acceptCompletion(entry)}
            role="option"
            aria-selected={i === highlight}
            class="flex items-center gap-2 rounded-lg px-2 py-2 sm:py-1.5 text-left text-xs transition-colors {i === highlight ? 'text-base-content/90 bg-base-content/12' : 'text-base-content/58 hover:text-base-content/90 hover:bg-base-content/8'}"
            tabindex={tabbable ? 0 : -1}
          >
            <CornerDownRight class="w-3 h-3 shrink-0 text-base-content/28" />
            <span class="truncate font-mono">{entry}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
