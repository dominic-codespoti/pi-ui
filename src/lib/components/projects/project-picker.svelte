<script lang="ts">
  /**
   * Project picker dropdown for the empty chat state.
   * Picking a project starts a NEW session in that directory; resuming an
   * existing session happens via the projects sidebar.
   */
  import DirectoryPicker from './directory-picker.svelte';
  import { projectsState, type ProjectGroup } from '$lib/state/projects-state.svelte';
  import { formatRelativeDate } from '$lib/utils';

  import Folder from '@lucide/svelte/icons/folder';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Pin from '@lucide/svelte/icons/pin';
  import Plus from '@lucide/svelte/icons/plus';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';

  let { onClose }: { onClose: () => void } = $props();

  const ps = projectsState;
  let query = $state('');
  const filteredGroups = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ps.groups;
    return ps.groups.filter((g) =>
      g.name.toLowerCase().includes(q) ||
      g.cwd.toLowerCase().includes(q) ||
      g.sessions.some((s) => (s.name ?? s.firstMessage ?? '').toLowerCase().includes(q))
    );
  });

  function pick(g: ProjectGroup) {
    if (!g.exists) return;
    ps.newSession(g.cwd);
    onClose();
  }

  function openPath(path: string) {
    ps.newSession(path);
    onClose();
  }
</script>

<div
  data-project-picker
  class="w-full max-w-md max-h-[min(34rem,calc(100dvh-8rem))] pointer-events-auto overflow-hidden rounded-[1.65rem] border border-base-content/10 bg-base-200/88 shadow-2xl shadow-black/30 backdrop-blur-xl flex flex-col"
  role="dialog"
  aria-label="Select project"
>
  <div class="p-2.5 sm:p-3 space-y-2 min-h-0 flex-1 flex flex-col">
    <div class="flex items-center gap-2 rounded-[1.35rem] border border-base-content/10 bg-base-content/[0.04] px-3 sm:px-3.5 py-2.5 sm:py-3 shadow-inner shadow-black/10 focus-within:border-base-content/45">
      <Search class="w-4 h-4 shrink-0 text-base-content/35" />
      <!-- svelte-ignore a11y_autofocus -->
      <input
        autofocus
        type="search"
        bind:value={query}
        placeholder="Search projects, paths, sessions…"
        class="min-w-0 flex-1 bg-transparent text-base sm:text-sm text-base-content/82 placeholder-base-content/30 outline-none"
        aria-label="Search projects"
      />
      {#if query}
        <button onclick={() => (query = '')} class="rounded-full p-1.5 text-base-content/35 hover:bg-base-content/8 hover:text-base-content/70" aria-label="Clear project search">
          <X class="w-3.5 h-3.5" />
        </button>
      {/if}
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl bg-base-content/[0.035] border border-base-content/6 p-1.5" role="listbox" aria-label="Projects">
      {#if ps.groups.length === 0}
        <p class="px-3 py-4 text-center text-xs text-base-content/35">No projects yet — open a folder below.</p>
      {:else if filteredGroups.length === 0}
        <p class="px-3 py-4 text-center text-xs text-base-content/35">No project matches “{query}”.</p>
      {:else}
        {#each filteredGroups as g (g.cwd)}
          {@const isActive = g.cwd === ps.cwd}
          <button
            onclick={() => pick(g)}
            disabled={!g.exists}
            class="group w-full rounded-xl px-3 py-2.5 sm:py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 {isActive ? 'bg-primary/[0.09] text-primary' : 'text-base-content/70 hover:bg-base-content/[0.075] hover:text-base-content'}"
            role="option"
            aria-selected={isActive}
            title={g.exists ? `New session in ${g.cwd}` : `${g.cwd} no longer exists`}
          >
            <div class="flex items-start gap-3">
              {#if isActive}
                <FolderOpen class="mt-0.5 w-4 h-4 shrink-0 text-primary" />
              {:else}
                <Folder class="mt-0.5 w-4 h-4 shrink-0 text-base-content/32 group-hover:text-base-content/55" />
              {/if}
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-1.5 text-sm font-medium">
                  <span class="truncate">{g.name}</span>
                  {#if g.pinned}<Pin class="w-2.5 h-2.5 shrink-0 text-primary/50" />{/if}
                  {#if !g.exists}<TriangleAlert class="w-3 h-3 shrink-0 text-warning/70" />{/if}
                </p>
                <p class="truncate font-mono text-[11px] text-base-content/32">{g.cwd}</p>
              </div>
              <div class="hidden sm:block shrink-0 text-right">
                <p class="text-[10px] uppercase tracking-[0.12em] text-base-content/25">{g.sessions.length || 'no'} session{g.sessions.length === 1 ? '' : 's'}</p>
                {#if g.lastActivity > 0}
                  <p class="text-[10px] text-base-content/22">{formatRelativeDate(g.lastActivity)}</p>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      {/if}
    </div>
  </div>

  <div class="border-t border-base-content/8 p-2.5 sm:p-3 bg-base-300/20 shrink-0">
    <p class="px-1 pb-2 text-[10px] uppercase tracking-[0.18em] text-base-content/32 flex items-center gap-1"><Plus class="w-2.5 h-2.5" />open another folder</p>
    <DirectoryPicker
      placeholder="~/path/to/project"
      onSubmit={openPath}
      onCancel={onClose}
    />
  </div>
</div>
