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

  let { onClose }: { onClose: () => void } = $props();

  const ps = projectsState;

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
  class="w-full max-w-sm pointer-events-auto bg-base-200/80 backdrop-blur-xl border border-base-content/10 rounded-2xl shadow-xl shadow-black/20 overflow-hidden"
  role="listbox"
  aria-label="Select project"
>
  <!-- Existing projects -->
  <div class="max-h-60 overflow-y-auto overscroll-contain">
    {#if ps.groups.length === 0}
      <p class="px-4 py-3 text-xs text-base-content/35">No projects yet — open a folder below</p>
    {:else}
      {#each ps.groups as g (g.cwd)}
        {@const isActive = g.cwd === ps.cwd}
        <button
          onclick={() => pick(g)}
          disabled={!g.exists}
          class="w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors disabled:opacity-45 disabled:cursor-not-allowed {isActive ? 'bg-primary/[0.08] text-primary' : 'text-base-content/70 hover:bg-base-content/[0.06] hover:text-base-content'}"
          role="option"
          aria-selected={isActive}
          title={g.exists ? `New session in ${g.cwd}` : `${g.cwd} no longer exists`}
        >
          {#if isActive}
            <FolderOpen class="w-4 h-4 shrink-0 text-primary" />
          {:else}
            <Folder class="w-4 h-4 shrink-0 text-base-content/30" />
          {/if}
          <div class="flex-1 min-w-0">
            <p class="text-sm truncate font-medium flex items-center gap-1.5">
              <span class="truncate">{g.name}</span>
              {#if g.pinned}<Pin class="w-2.5 h-2.5 shrink-0 text-primary/50" />{/if}
              {#if !g.exists}<TriangleAlert class="w-3 h-3 shrink-0 text-warning/70" />{/if}
            </p>
            <p class="text-[11px] text-base-content/30 truncate">{g.cwd}</p>
          </div>
          <div class="shrink-0 flex flex-col items-end gap-0.5">
            <span class="text-[10px] text-base-content/25 tabular-nums">{g.sessions.length || 'no'} session{g.sessions.length === 1 ? '' : 's'}</span>
            {#if g.lastActivity > 0}
              <span class="text-[10px] text-base-content/20">{formatRelativeDate(g.lastActivity)}</span>
            {/if}
          </div>
        </button>
      {/each}
    {/if}
  </div>

  <!-- Divider + new path input -->
  <div class="border-t border-base-content/8 p-2">
    <p class="px-1.5 pb-1 text-[10px] uppercase tracking-[0.18em] text-base-content/30 flex items-center gap-1"><Plus class="w-2.5 h-2.5" />open another folder</p>
    <DirectoryPicker
      placeholder="~/path/to/project"
      onSubmit={openPath}
      onCancel={onClose}
    />
  </div>
</div>
