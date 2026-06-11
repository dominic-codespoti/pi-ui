<script lang="ts">
  /**
   * Projects sidebar — first-class project tree with nested sessions.
   *
   * Pinned projects float to the top. Projects can be renamed, pinned,
   * collapsed (persisted), and forgotten (registry-only projects with no
   * sessions). Sessions support switch / rename / fork / delete.
   */
  import { tick } from 'svelte';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import DirectoryPicker from './directory-picker.svelte';
  import { projectsState, SESSION_PREVIEW_LIMIT, type ProjectGroup } from '$lib/state/projects-state.svelte';
  import { formatRelativeDate } from '$lib/utils';
  import type { SessionSummary } from '$lib/ws/protocol';

  import Search from '@lucide/svelte/icons/search';
  import Folder from '@lucide/svelte/icons/folder';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Plus from '@lucide/svelte/icons/plus';
  import Pin from '@lucide/svelte/icons/pin';
  import PinOff from '@lucide/svelte/icons/pin-off';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash from '@lucide/svelte/icons/trash-2';
  import X from '@lucide/svelte/icons/x';
  import Check from '@lucide/svelte/icons/check';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

  let {
    open,
    canFork = false,
    onFork,
  }: {
    /** Whether the panel is visible — gates tab order. */
    open: boolean;
    /** Whether the active session can be forked right now. */
    canFork?: boolean;
    /** Opens the fork dialog (page-level). */
    onFork: () => void;
  } = $props();

  const ps = projectsState;

  /** Path of the session being renamed inline (null = none). */
  let renamingSession = $state<string | null>(null);
  /** Cwd of the project being renamed inline (null = none). */
  let renamingProject = $state<string | null>(null);
  let renameDraft = $state('');
  let renameInputEl = $state<HTMLInputElement | undefined>(undefined);
  /** Whether the footer "new project" picker is visible. */
  let newProjectMode = $state(false);

  const pinnedGroups = $derived(ps.filteredGroups.filter((g) => g.pinned));
  const recentGroups = $derived(ps.filteredGroups.filter((g) => !g.pinned));

  $effect(() => {
    if (!renamingSession && !renamingProject) return;
    tick().then(() => {
      renameInputEl?.focus();
      renameInputEl?.select();
    });
  });

  function startSessionRename(s: SessionSummary) {
    renamingProject = null;
    renameDraft = s.name ?? '';
    renamingSession = s.path;
  }

  function startProjectRename(g: ProjectGroup) {
    renamingSession = null;
    renameDraft = g.name;
    renamingProject = g.cwd;
  }

  function commitRename() {
    const name = renameDraft.trim();
    if (renamingSession && name) ps.renameSession(renamingSession, name);
    if (renamingProject) ps.renameProject(renamingProject, name); // empty resets to basename
    cancelRename();
  }

  function cancelRename() {
    renamingSession = null;
    renamingProject = null;
    renameDraft = '';
  }

  function renameKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
  }

  function confirmDeleteSession(s: SessionSummary) {
    const label = s.name || s.firstMessage || s.path.split('/').pop()?.replace('.jsonl', '') || s.path;
    if (!window.confirm(`Delete session "${label}"?`)) return;
    ps.deleteSession(s.path);
  }

  function confirmForgetProject(g: ProjectGroup) {
    if (!window.confirm(`Forget project "${g.name}"? Files on disk are untouched.`)) return;
    ps.removeProject(g.cwd);
  }

  function openNewProject(path: string) {
    newProjectMode = false;
    ps.newSession(path);
  }
</script>

{#snippet projectGroup(g: ProjectGroup)}
  {@const isActive = g.cwd === ps.cwd}
  {@const isCollapsed = ps.collapsed.has(g.cwd)}
  {@const isRenaming = renamingProject === g.cwd}
  {@const streaming = ps.isStreaming && isActive}
  <div class="group/dir relative rounded-2xl transition-colors duration-150 {isActive ? 'bg-base-content/[0.03]' : 'hover:bg-base-content/[0.025]'}">
    {#if isRenaming}
      <div class="px-3 py-2.5 flex items-center gap-2">
        <Folder class="w-4 h-4 shrink-0 text-base-content/45" />
        <input
          bind:this={renameInputEl}
          type="text"
          bind:value={renameDraft}
          onkeydown={renameKeydown}
          class="flex-1 bg-transparent border-b border-base-content/30 focus:border-base-content/60 outline-none text-sm py-0.5 text-base-content/90 min-w-0 transition-colors"
          placeholder={g.cwd.split('/').filter(Boolean).pop()}
          aria-label="Project name"
        />
        <button onclick={commitRename} class="w-7 h-7 flex items-center justify-center text-primary/70 hover:text-primary hover:bg-primary/8 rounded-lg transition-colors" aria-label="Confirm rename"><Check class="w-3.5 h-3.5" /></button>
        <button onclick={cancelRename} class="w-7 h-7 flex items-center justify-center text-base-content/35 hover:text-base-content/70 hover:bg-base-content/8 rounded-lg transition-colors" aria-label="Cancel rename"><X class="w-3.5 h-3.5" /></button>
      </div>
    {:else}
      <div class="flex items-center">
        <button
          onclick={() => ps.toggleCollapsed(g.cwd)}
          class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 text-left transition-colors duration-150 rounded-2xl {isActive ? 'text-base-content font-semibold' : 'text-base-content/60 hover:text-base-content/85'}"
          tabindex={open ? 0 : -1}
          aria-expanded={!isCollapsed}
          title={g.cwd}
        >
          <ChevronRight class="w-3 h-3 shrink-0 text-base-content/40 transition-transform duration-150 {isCollapsed ? '' : 'rotate-90'}" />
          {#if isActive}
            <FolderOpen class="w-4 h-4 shrink-0 text-primary/70" />
          {:else}
            <Folder class="w-4 h-4 shrink-0 text-base-content/45" />
          {/if}
          <span class="flex-1 min-w-0 truncate text-sm">{g.name}</span>
          {#if !g.exists}
            <span class="shrink-0 flex items-center gap-1 text-[10px] text-warning/70" title="Directory no longer exists on disk">
              <TriangleAlert class="w-3 h-3" />missing
            </span>
          {/if}
          {#if streaming}
            <span class="w-1.5 h-1.5 rounded-full bg-success glow-success animate-pulse shrink-0" aria-label="Generating"></span>
          {/if}
          {#if g.pinned}
            <Pin class="w-3 h-3 shrink-0 text-primary/45 group-hover/dir:hidden" />
          {/if}
          <span class="text-[11px] text-base-content/28 shrink-0 tabular-nums group-hover/dir:hidden">{g.sessions.length}</span>
        </button>
        <!-- Hover actions -->
        <div class="hidden group-hover/dir:flex items-center gap-0.5 pr-1.5 shrink-0">
          <button
            onclick={() => startProjectRename(g)}
            class="w-7 h-7 flex items-center justify-center text-base-content/35 hover:text-base-content/70 hover:bg-base-content/8 rounded-xl transition-colors"
            title="Rename project" aria-label="Rename project {g.name}" tabindex={open ? 0 : -1}
          ><Pencil class="w-3 h-3" /></button>
          <button
            onclick={() => ps.setPinned(g.cwd, !g.pinned)}
            class="w-7 h-7 flex items-center justify-center rounded-xl transition-colors {g.pinned ? 'text-primary/70 hover:text-primary hover:bg-primary/10' : 'text-base-content/35 hover:text-base-content/70 hover:bg-base-content/8'}"
            title={g.pinned ? 'Unpin project' : 'Pin project'} aria-label="{g.pinned ? 'Unpin' : 'Pin'} project {g.name}" tabindex={open ? 0 : -1}
          >{#if g.pinned}<PinOff class="w-3 h-3" />{:else}<Pin class="w-3 h-3" />{/if}</button>
          {#if g.registered && g.sessions.length === 0 && !isActive}
            <button
              onclick={() => confirmForgetProject(g)}
              class="w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-error hover:bg-error/8 rounded-xl transition-colors"
              title="Forget project" aria-label="Forget project {g.name}" tabindex={open ? 0 : -1}
            ><X class="w-3.5 h-3.5" /></button>
          {/if}
          <button
            onclick={() => { if (ps.collapsed.has(g.cwd)) ps.toggleCollapsed(g.cwd); ps.newSession(g.cwd); }}
            disabled={!g.exists}
            class="w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            title="New session in {g.name}" aria-label="New session in {g.name}" tabindex={open ? 0 : -1}
          ><Plus class="w-3.5 h-3.5" /></button>
        </div>
      </div>
    {/if}

    <!-- Sessions nested under this project -->
    {#if !isCollapsed}
      <div class="ml-3 pl-3 pt-0.5 pb-1.5 border-l border-base-content/8 space-y-1">
        {#if g.sessions.length === 0}
          <p class="px-3 py-1.5 text-xs text-base-content/30">no sessions yet</p>
        {/if}
        {#each ps.visibleSessions(g) as s (s.id)}
          {@const isActiveSession = ps.activeSessionId === s.id}
          {@const isRenamingSession = renamingSession === s.path}
          {@const hasUnchecked = ps.uncheckedSessions.has(s.id)}
          <div class="group rounded-2xl transition-colors duration-150 {isActiveSession ? 'bg-primary/[0.07] border border-primary/[0.08]' : 'border border-transparent hover:bg-base-content/[0.035]'}">
            {#if isRenamingSession}
              <div class="px-3 py-2 flex items-center gap-2">
                <input
                  bind:this={renameInputEl}
                  type="text"
                  bind:value={renameDraft}
                  onkeydown={renameKeydown}
                  class="flex-1 bg-transparent border-b border-base-content/30 focus:border-base-content/60 outline-none text-sm py-1 text-base-content/90 min-w-0 transition-colors"
                  placeholder="session name…"
                  aria-label="Session name"
                />
                <button onclick={commitRename} class="w-7 h-7 flex items-center justify-center text-primary/70 hover:text-primary hover:bg-primary/8 rounded-lg transition-colors" aria-label="Confirm rename"><Check class="w-3.5 h-3.5" /></button>
                <button onclick={cancelRename} class="w-7 h-7 flex items-center justify-center text-base-content/35 hover:text-base-content/70 hover:bg-base-content/8 rounded-lg transition-colors" aria-label="Cancel rename"><X class="w-3.5 h-3.5" /></button>
              </div>
            {:else}
              <div class="flex items-stretch">
                <button
                  onclick={() => ps.switchSession(s.path)}
                  class="flex-1 text-left px-3 py-2 min-w-0"
                  aria-current={isActiveSession ? 'true' : undefined}
                  tabindex={open ? 0 : -1}
                >
                  <div class="flex items-center gap-2">
                    {#if ps.isStreaming && isActiveSession}
                      <span class="w-2 h-2 rounded-full bg-success shrink-0 animate-pulse glow-success" aria-label="Streaming"></span>
                    {:else if hasUnchecked}
                      <span class="w-2 h-2 rounded-full bg-primary shrink-0 glow-primary" aria-label="Unchecked result"></span>
                    {:else}
                      <span class="w-2 h-2 rounded-full bg-base-content/20 shrink-0"></span>
                    {/if}
                    <span class="text-sm truncate leading-snug {isActiveSession ? 'text-base-content font-semibold tracking-[-0.01em]' : 'text-base-content/68'}">
                      {s.name ? s.name : (s.firstMessage || '(empty)')}
                    </span>
                  </div>
                  {#if s.name && s.firstMessage}
                    <p class="text-xs text-base-content/35 mt-0.5 truncate pl-4">{s.firstMessage}</p>
                  {/if}
                  <p class="text-xs text-base-content/24 mt-0.5 pl-4 flex items-center gap-1.5">
                    <span>{formatRelativeDate(s.modified)}</span>
                    {#if s.messageCount > 0}
                      <span class="text-base-content/18">·</span>
                      <span>{s.messageCount} msg{s.messageCount === 1 ? '' : 's'}</span>
                    {/if}
                  </p>
                </button>
                <!-- Session actions — visible on row hover -->
                <div class="flex flex-col justify-center gap-0.5 pr-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onclick={() => startSessionRename(s)} class="w-7 h-7 flex items-center justify-center text-base-content/40 hover:text-base-content/70 hover:bg-base-content/8 rounded-lg transition-colors" title="Rename" aria-label="Rename session" tabindex={open ? 0 : -1}><Pencil class="w-3 h-3" /></button>
                  {#if isActiveSession && canFork}
                    <button onclick={onFork} class="w-7 h-7 flex items-center justify-center text-base-content/35 hover:text-primary hover:bg-primary/8 rounded-lg transition-colors" title="Fork session" aria-label="Fork session" tabindex={open ? 0 : -1}><GitBranch class="w-3 h-3" /></button>
                  {/if}
                  {#if !isActiveSession}
                    <button onclick={() => confirmDeleteSession(s)} class="w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-error hover:bg-error/8 rounded-lg transition-colors" title="Delete" aria-label="Delete session" tabindex={open ? 0 : -1}><Trash class="w-3 h-3" /></button>
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/each}
        {#if g.sessions.length > SESSION_PREVIEW_LIMIT}
          {@const expanded = ps.expandedGroups.has(g.cwd)}
          <button
            onclick={() => ps.toggleExpandedGroup(g.cwd)}
            class="w-full text-left pl-4 pr-3 py-1.5 text-xs text-base-content/32 hover:text-base-content/55 transition-colors"
            tabindex={open ? 0 : -1}
          >
            {expanded ? 'Show fewer sessions' : `Show ${g.sessions.length - SESSION_PREVIEW_LIMIT} more sessions`}
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/snippet}

<!-- Search capsule -->
<div class="shrink-0 px-3 py-3">
  <div class="flex items-center gap-2 bg-base-content/[0.055] border border-base-content/[0.04] rounded-2xl px-3 py-2.5 shadow-inner shadow-black/5">
    <Search class="w-4 h-4 shrink-0 text-base-content/30" />
    <input
      type="search"
      placeholder="search projects &amp; sessions…"
      bind:value={ps.filter}
      class="flex-1 bg-transparent outline-none text-sm placeholder-base-content/30 text-base-content/80 min-w-0"
      aria-label="Filter projects and sessions"
      tabindex={open ? 0 : -1}
    />
  </div>
</div>

<!-- Error banner -->
{#if ps.error}
  <div class="shrink-0 mx-3 mb-2 px-3 py-2.5 bg-error/10 border border-error/20 rounded-xl flex items-center justify-between gap-2">
    <span class="text-sm text-error break-words min-w-0">{ps.error}</span>
    <button
      onclick={() => (ps.error = null)}
      class="w-7 h-7 flex items-center justify-center text-error/50 hover:text-error/80 shrink-0 rounded-lg transition-colors"
      aria-label="Dismiss error"
    ><X class="w-3.5 h-3.5" /></button>
  </div>
{/if}

<!-- Project tree -->
<ScrollArea class="flex-1 min-h-0">
  <div class="px-2.5 pb-2">
    {#if ps.groups.length === 0}
      <div class="flex flex-col items-center justify-center gap-2 py-12 px-4 text-center">
        <FolderPlus class="w-8 h-8 text-base-content/15" />
        <p class="text-sm text-base-content/55 font-medium">No projects yet</p>
        <p class="text-xs text-base-content/45">Open a folder below to start</p>
      </div>
    {:else if ps.filteredGroups.length === 0}
      <div class="flex flex-col items-center justify-center gap-1.5 py-10 px-4 text-center">
        <p class="text-sm text-base-content/55">No match</p>
        <p class="text-xs text-base-content/45">Try a different search term</p>
      </div>
    {:else}
      <div class="flex flex-col pt-1 gap-2">
        {#if pinnedGroups.length > 0}
          <p class="px-3 pt-1 text-[10px] uppercase tracking-[0.18em] text-base-content/30 flex items-center gap-1.5"><Pin class="w-2.5 h-2.5" />pinned</p>
          {#each pinnedGroups as g (g.cwd)}
            {@render projectGroup(g)}
          {/each}
          {#if recentGroups.length > 0}
            <p class="px-3 pt-2 text-[10px] uppercase tracking-[0.18em] text-base-content/30">recent</p>
          {/if}
        {/if}
        {#each recentGroups as g (g.cwd)}
          {@render projectGroup(g)}
        {/each}
      </div>
    {/if}
  </div>
</ScrollArea>

<!-- Footer: new project -->
<div class="shrink-0 p-3 pt-2 space-y-2 bg-gradient-to-t from-base-300/25 to-transparent">
  <button
    onclick={() => (newProjectMode = !newProjectMode)}
    class="w-full flex items-center justify-center gap-2 text-sm text-base-content/50 hover:text-base-content/80 transition-colors py-3 bg-base-content/[0.045] hover:bg-base-content/[0.075] border border-base-content/[0.035] rounded-2xl disabled:opacity-50"
    disabled={ps.pendingNewSession}
    tabindex={open ? 0 : -1}
  >
    <FolderPlus class="w-4 h-4" />
    <span>{newProjectMode ? 'cancel' : ps.pendingNewSession ? 'opening…' : 'open project…'}</span>
  </button>
  {#if newProjectMode}
    <DirectoryPicker
      tabbable={open}
      onSubmit={openNewProject}
      onCancel={() => (newProjectMode = false)}
    />
  {/if}
</div>
