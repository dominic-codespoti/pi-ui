<script lang="ts">
  /**
   * Path input with server-driven directory autocomplete.
   * Used by the projects sidebar ("new project") and the project picker.
   *
   * Keys: ArrowUp/Down navigate completions · Tab accepts the highlighted
   * (or first) completion · Enter submits · Escape cancels.
   */
  import { projectsState } from '$lib/state/projects-state.svelte';

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

  const completions = $derived(projectsState.dirCompletions);

  $effect(() => {
    if (value.trim()) {
      projectsState.requestDirCompletions(value);
    } else {
      projectsState.dirCompletions = [];
    }
    highlight = -1;
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

<div class="bg-base-content/5 rounded-xl px-3 py-2.5">
  <div class="flex items-center gap-2">
    <!-- svelte-ignore a11y_autofocus -->
    <input
      autofocus
      type="text"
      bind:value
      {placeholder}
      class="flex-1 min-w-0 bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/30"
      aria-label="Project directory path"
      tabindex={tabbable ? 0 : -1}
      onkeydown={onKeydown}
    />
    {#if value.trim()}
      <button
        onclick={submit}
        class="shrink-0 text-[11px] uppercase tracking-wide text-primary/70 hover:text-primary px-1.5 py-0.5 rounded transition-colors"
        tabindex={tabbable ? 0 : -1}
      >{submitLabel}</button>
    {/if}
  </div>
  {#if completions.length > 0}
    <div class="mt-1.5 flex flex-col gap-0.5 max-h-36 overflow-y-auto overscroll-contain" role="listbox" aria-label="Directory completions">
      {#each completions as entry, i (entry)}
        <button
          onclick={() => acceptCompletion(entry)}
          role="option"
          aria-selected={i === highlight}
          class="text-left text-xs py-1 px-1.5 rounded transition-colors truncate {i === highlight ? 'text-base-content/90 bg-base-content/12' : 'text-base-content/60 hover:text-base-content/90 hover:bg-base-content/8'}"
          tabindex={tabbable ? 0 : -1}
        >{entry}</button>
      {/each}
    </div>
  {/if}
</div>
