<script lang="ts">
  /**
   * Projects sidebar — recency-first session list grouped under thin project
   * headers. Projects sort by their most recent session (pinned first);
   * sub-sessions nest under their parent (substacks are collapsed by default),
   * each sibling level ordered by its subtree's most recent activity.
   *
   * The active project can be collapsed like any other; a search filter expands
   * everything and shows every match. Projects can be renamed, pinned, collapsed
   * (persisted), and forgotten (registry-only projects with no sessions).
   * Sessions support switch / rename / fork / delete, with nested branches
   * independently expandable.
   */
  import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
  import DirectoryPicker from './directory-picker.svelte';
  import ProjectRow from './project-row.svelte';
  import { projectsState, type ProjectGroup } from '#lib/state/projects-state.svelte.js';
  import type { SessionSummary } from '#lib/ws/protocol.js';
  import type {
    AppExtensionCall,
    AppExtensionEventListener,
  } from '#lib/app-extensions/transport.js';
  import type { AppExtensionScope } from '#lib/app-extensions/types.js';
  import type {
    AppExtensionHostPrompt,
    AppExtensionHostDraft,
    AppExtensionHostConfirm,
    AppExtensionHostOpenFile,
    AppExtensionHostSwitchSession,
  } from '#lib/app-extensions/client-loader.js';
  import type {
    AppExtensionResolvedView,
    AppExtensionViewRef,
  } from '#lib/state/app-extensions-state.svelte.js';
  import ExtensionSlotHost from '#lib/components/app-extensions/extension-slot-host.svelte';

  import Search from '@lucide/svelte/icons/search';
  import FolderPlus from '@lucide/svelte/icons/folder-plus';
  import Pin from '@lucide/svelte/icons/pin';
  import X from '@lucide/svelte/icons/x';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  interface SessionRowState {
    isActive: boolean;
    isSubsessionsExpanded: boolean;
    isRenaming: boolean;
    isToolRunning: boolean;
    isRunning: boolean;
    needsAttention: boolean;
    hasUnread: boolean;
  }

  let {
    open,
    canFork = false,
    onFork,
    onRequestConfirm = () => {},
    appExtensionViews = [],
    appScope = {},
    appCall = null,
    appSubscribe = null,
    appPrompt = null,
    appDraft = null,
    appConfirm = null,
    appOpenFile = null,
    appSwitchSession = null,
    appNotify = () => {},
    onUnpinAppView = () => {},
    onMoveAppViewPin = () => {},
  }: {
    /** Whether the panel is visible — gates tab order. */
    open: boolean;
    /** Whether the active session can be forked right now. */
    canFork?: boolean;
    /** Opens the fork dialog (page-level). */
    onFork: () => void;
    /** Show a confirmation dialog before destructive actions. */
    onRequestConfirm: (
      message: string,
      onConfirm: () => void,
      opts?: { title?: string; confirmLabel?: string; variant?: 'error' | 'warning' | 'info' }
    ) => void;
    /** Locally pinned sidebar attachments; disabled apps remain visible but do not mount. */
    appExtensionViews?: AppExtensionResolvedView[];
    /** Current project/session scope passed to the extension view. */
    appScope?: AppExtensionScope;
    /** Transport-level operation call (bound to the mounted extension by the slot host). */
    appCall?: AppExtensionCall | null;
    /** Transport-level event subscription (bound to the mounted extension by the slot host). */
    appSubscribe?:
      | ((
          extensionId: string,
          eventName: string,
          listener: AppExtensionEventListener,
          scope: AppExtensionScope
        ) => () => void)
      | null;
    /** Chat prompt submission for extension views (bound to the view scope by the slot host). */
    appPrompt?: AppExtensionHostPrompt | null;
    /** Composer draft replacement for extension views. */
    appDraft?: AppExtensionHostDraft | null;
    /** Host-rendered confirmation dialog for extension views. */
    appConfirm?: AppExtensionHostConfirm | null;
    /** Host file viewer for project-relative paths. */
    appOpenFile?: AppExtensionHostOpenFile | null;
    /** Chat session switch for extension views. */
    appSwitchSession?: AppExtensionHostSwitchSession | null;
    /** Surface an extension notice in the chat. */
    appNotify?: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void;
    /** Remove one local sidebar attachment. */
    onUnpinAppView?: (extensionId: string, viewId: string) => void;
    /** Move one pinned attachment to a zero-based position. */
    onMoveAppViewPin?: (ref: AppExtensionViewRef, targetIndex: number) => void;
  } = $props();

  const ps = projectsState;

  /** ID of the session being renamed inline (null = none). */
  let renamingSession = $state<string | null>(null);
  /** Cwd of the project being renamed inline (null = none). */
  let renamingProject = $state<string | null>(null);
  let renameDraft = $state('');
  /** Whether the footer "new project" picker is visible. */
  let newProjectMode = $state(false);
  /** Only one small attachment is expanded at a time to avoid mounting hidden views. */
  let expandedAppAttachment = $state<string | null>(null);

  function attachmentKey(extensionId: string, viewId: string): string {
    return `${extensionId}:${viewId}`;
  }
  const pinnedGroups = $derived(ps.filteredGroups.filter((g) => g.pinned));
  const recentGroups = $derived(ps.filteredGroups.filter((g) => !g.pinned));

  function startSessionRename(s: SessionSummary) {
    renamingProject = null;
    renameDraft = s.name ?? '';
    renamingSession = s.id;
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

  function confirmDeleteSession(s: SessionSummary) {
    const label =
      s.name || s.firstMessage || s.path.split('/').pop()?.replace('.jsonl', '') || s.path;
    onRequestConfirm(`Delete session "${label}"? This cannot be undone.`, () =>
      ps.deleteSession(s.id)
    );
  }

  function confirmForgetProject(g: ProjectGroup) {
    onRequestConfirm(
      `Forget project "${g.name}"? Sessions and pinned state will be removed, but files on disk are untouched.`,
      () => ps.removeProject(g.cwd)
    );
  }

  function confirmDeleteProject(g: ProjectGroup) {
    const count = g.sessions.length;
    const label = count === 1 ? '1 session' : `${count} sessions`;
    onRequestConfirm(
      `Delete project "${g.name}" and all ${label}? This will permanently delete ${label} and cannot be undone.`,
      () => ps.deleteProject(g.cwd),
      { title: `Delete ${g.name}?`, confirmLabel: `Delete project`, variant: 'error' }
    );
  }

  function openNewProject(path: string) {
    newProjectMode = false;
    ps.newSession(path);
  }
</script>

{#snippet projectGroup(g: ProjectGroup)}
  {@const isActive = g.cwd === ps.cwd}
  {@const isCollapsed = !ps.filter && ps.collapsed.has(g.cwd)}
  {@const isRenaming = renamingProject === g.cwd}
  {@const rootCount = g.sessions.filter((r) => r.depth === 0).length}
  {@const projectActivity = ps.projectActivity(g)}
  {@const visibleSessions = ps.visibleSessions(g)}
  <ProjectRow
    group={g}
    {open}
    {isActive}
    {isCollapsed}
    {isRenaming}
    {renameDraft}
    sessionRows={visibleSessions}
    {rootCount}
    {projectActivity}
    {canFork}
    pendingNewSession={ps.pendingNewSession || ps.sessionLoading}
    pendingSessionSwitch={ps.pendingNewSession}
    showPreviewToggle={!ps.filter}
    onToggleCollapsed={() => ps.toggleCollapsed(g.cwd)}
    onStartProjectRename={() => startProjectRename(g)}
    onForgetProject={() => confirmForgetProject(g)}
    onDeleteProject={() => confirmDeleteProject(g)}
    onNewSession={() => {
      if (ps.collapsed.has(g.cwd)) ps.toggleCollapsed(g.cwd);
      ps.newSession(g.cwd);
    }}
    onToggleExpandedGroup={() => ps.toggleExpandedGroup(g.cwd)}
    getSessionState={(id): SessionRowState => ({
      isActive: ps.activeSessionId === id,
      isSubsessionsExpanded: ps.expandedSubsessions.has(id),
      isRenaming: renamingSession === id,
      isToolRunning: Boolean(ps.sessionToolName(id)),
      isRunning: ps.isSessionRunning(id),
      needsAttention: ps.sessionNeedsAttention(id),
      hasUnread: ps.isSessionUnread(id),
    })}
    onToggleSubsessions={(id) => ps.toggleSubsessions(id)}
    onSwitchSession={(path) => ps.switchSession(path)}
    onStartSessionRename={startSessionRename}
    {onFork}
    onDeleteSession={confirmDeleteSession}
    onCommitRename={commitRename}
    onCancelRename={cancelRename}
    onRenameDraft={(value) => (renameDraft = value)}
  />
{/snippet}

<!-- Search capsule -->
<div class="shrink-0 px-3 py-3">
  <div
    class="flex items-center gap-2 rounded-[1.35rem] border border-base-content/10 bg-base-content/[0.045] px-3 py-2.5 shadow-inner shadow-black/10 transition-colors focus-within:border-base-content/45 focus-within:bg-base-content/[0.055]"
  >
    <Search class="w-4 h-4 shrink-0 text-base-content/35" />
    <input
      type="search"
      name="projects-sidebar-filter"
      autocomplete="off"
      spellcheck="false"
      data-1p-ignore
      data-lpignore="true"
      data-bwignore
      data-form-type="other"
      placeholder="Search projects, paths, sessions…"
      bind:value={ps.filter}
      class="focus-ring flex-1 bg-transparent outline-none text-sm placeholder-base-content/30 text-base-content/82 min-w-0"
      aria-label="Filter projects and sessions"
      tabindex={open ? 0 : -1}
    />
    {#if ps.filter}
      <button
        onclick={() => (ps.filter = '')}
        class="rounded-full p-1.5 text-base-content/35 transition-colors hover:bg-base-content/8 hover:text-base-content/70"
        aria-label="Clear project search"
        tabindex={open ? 0 : -1}><X class="w-3.5 h-3.5" /></button
      >
    {/if}
  </div>
  {#if ps.filter}
    <p class="px-2 pt-1.5 text-[10px] text-base-content/32">
      {ps.filteredGroups.length} project{ps.filteredGroups.length === 1 ? '' : 's'} matched
    </p>
  {/if}
</div>

<!-- Error banner -->
{#if ps.error}
  <div
    class="shrink-0 mx-3 mb-2 px-3 py-2.5 bg-error/10 border border-error/20 rounded-xl flex items-center justify-between gap-2"
  >
    <span class="text-sm text-error break-words min-w-0">{ps.error}</span>
    <button
      onclick={() => (ps.error = null)}
      class="w-7 h-7 flex items-center justify-center text-error/50 hover:text-error/80 shrink-0 rounded-lg transition-colors"
      aria-label="Dismiss error"><X class="w-3.5 h-3.5" /></button
    >
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
          <p
            class="px-3 pt-1 text-[10px] uppercase tracking-[0.18em] text-base-content/30 flex items-center gap-1.5"
          >
            <Pin class="w-2.5 h-2.5" />pinned
          </p>
          {#each pinnedGroups as g (g.cwd)}
            {@render projectGroup(g)}
          {/each}
          {#if recentGroups.length > 0}
            <p class="px-3 pt-2 text-[10px] uppercase tracking-[0.18em] text-base-content/30">
              recent
            </p>
          {/if}
        {/if}
        {#each recentGroups as g (g.cwd)}
          {@render projectGroup(g)}
        {/each}
      </div>
    {/if}
  </div>
</ScrollArea>

<!-- Browser-local app attachments: pin state persists, but only the expanded view mounts. -->
{#if appExtensionViews.length > 0}
  <section aria-label="Pinned app attachments" class="shrink-0 border-t border-base-content/10">
    <div class="flex items-center gap-1.5 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-base-content/40">
      <Pin class="h-3 w-3" aria-hidden="true" />
      <span class="flex-1">attachments</span>
      <span class="tabular-nums">{appExtensionViews.length}</span>
    </div>
    <div class="max-h-80 min-h-0 space-y-1 overflow-y-auto px-2 pb-2">
      {#each appExtensionViews as attachment, index (attachmentKey(attachment.extension.id, attachment.view.id))}
        {@const key = attachmentKey(attachment.extension.id, attachment.view.id)}
        {@const expanded = open && expandedAppAttachment === key}
        <article class="overflow-hidden rounded-xl border border-base-content/8 bg-base-content/[0.025]">
          <div class="flex items-center gap-1 px-1.5 py-1">
            <button
              type="button"
              class="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 py-1 text-left text-xs text-base-content/70 hover:bg-base-content/5"
              aria-expanded={expanded}
              aria-controls="app-attachment-{key}"
              tabindex={open ? 0 : -1}
              onclick={() => (expandedAppAttachment = expanded ? null : key)}
            >
              <ChevronDown
                class="h-3.5 w-3.5 shrink-0 transition-transform {expanded ? '' : '-rotate-90'}"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate">{attachment.view.title}</span>
              <span class="max-w-20 truncate text-[10px] text-base-content/35">{attachment.extension.name}</span>
            </button>
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-base-content/35 hover:bg-base-content/8 hover:text-base-content/70 disabled:opacity-25"
              aria-label="Move {attachment.view.title} attachment up"
              disabled={index === 0}
              tabindex={open ? 0 : -1}
              onclick={() => onMoveAppViewPin({ extensionId: attachment.extension.id, viewId: attachment.view.id }, index - 1)}
            >
              <ChevronDown class="h-3.5 w-3.5 rotate-180" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-base-content/35 hover:bg-base-content/8 hover:text-base-content/70 disabled:opacity-25"
              aria-label="Move {attachment.view.title} attachment down"
              disabled={index === appExtensionViews.length - 1}
              tabindex={open ? 0 : -1}
              onclick={() => onMoveAppViewPin({ extensionId: attachment.extension.id, viewId: attachment.view.id }, index + 1)}
            >
              <ChevronDown class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-base-content/35 hover:bg-base-content/8 hover:text-base-content/70"
              aria-label="Unpin {attachment.view.title}"
              tabindex={open ? 0 : -1}
              onclick={() => onUnpinAppView(attachment.extension.id, attachment.view.id)}
            >
              <X class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
          {#if expanded}
            <div id="app-attachment-{key}" class="max-h-56 overflow-y-auto border-t border-base-content/6 px-1.5 py-1.5">
              {#if attachment.extension.enabled && appCall && appSubscribe && appPrompt && appDraft && appConfirm && appOpenFile && appSwitchSession}
                <ExtensionSlotHost
                  extension={attachment.extension}
                  view={attachment.view}
                  scope={appScope}
                  call={appCall}
                  subscribe={appSubscribe}
                  prompt={appPrompt}
                  draft={appDraft}
                  confirm={appConfirm}
                  openFile={appOpenFile}
                  switchSession={appSwitchSession}
                  notify={appNotify}
                />
              {:else}
                <p class="px-2 py-3 text-center text-[11px] text-base-content/40">
                  This extension is disabled. Re-enable it in Manage apps to use this attachment.
                </p>
              {/if}
            </div>
          {/if}
        </article>
      {/each}
    </div>
  </section>
{/if}

<!-- Footer: new project -->
<div class="shrink-0 p-3 pt-2 space-y-2 bg-gradient-to-t from-base-300/25 to-transparent">
  <button
    onclick={() => (newProjectMode = !newProjectMode)}
    class="w-full flex items-center justify-center gap-2 text-sm text-base-content/50 hover:text-base-content/80 transition-colors py-3 bg-base-content/[0.045] hover:bg-base-content/[0.075] border border-base-content/[0.035] rounded-2xl disabled:opacity-50"
    disabled={ps.pendingNewSession || ps.sessionLoading}
    tabindex={open ? 0 : -1}
  >
    <FolderPlus class="w-4 h-4" />
    <span
      >{newProjectMode
        ? 'cancel'
        : ps.pendingNewSession || ps.sessionLoading
          ? 'opening…'
          : 'open project…'}</span
    >
  </button>
  {#if newProjectMode}
    <DirectoryPicker
      tabbable={open}
      onSubmit={openNewProject}
      onCancel={() => (newProjectMode = false)}
    />
  {/if}
</div>
