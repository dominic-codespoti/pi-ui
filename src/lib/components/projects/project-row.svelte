<script lang="ts">
  import { tick } from 'svelte';
  import Folder from '@lucide/svelte/icons/folder';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Plus from '@lucide/svelte/icons/plus';
  import Pin from '@lucide/svelte/icons/pin';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash from '@lucide/svelte/icons/trash-2';
  import X from '@lucide/svelte/icons/x';
  import Check from '@lucide/svelte/icons/check';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import SessionRow from './session-row.svelte';
  import {
    SESSION_PREVIEW_LIMIT,
    type ProjectGroup,
    type SessionRow as SessionTreeRow,
  } from '#lib/state/projects-state.svelte.js';
  import type { SessionSummary } from '#lib/ws/protocol.js';

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
    group,
    open,
    isActive,
    isCollapsed,
    isRenaming,
    renameDraft,
    sessionRows,
    rootCount,
    projectActivity,
    canFork = false,
    pendingNewSession = false,
    pendingSessionSwitch = false,
    showPreviewToggle = true,
    expandedGroup = false,
    onToggleCollapsed,
    onStartProjectRename,
    onForgetProject,
    onDeleteProject,
    onNewSession,
    onToggleExpandedGroup,
    getSessionState,
    onToggleSubsessions,
    onSwitchSession,
    onStartSessionRename,
    onFork,
    onDeleteSession,
    onCommitRename,
    onCancelRename,
    onRenameDraft,
  }: {
    group: ProjectGroup;
    open: boolean;
    isActive: boolean;
    isCollapsed: boolean;
    isRenaming: boolean;
    renameDraft: string;
    sessionRows: SessionTreeRow[];
    rootCount: number;
    projectActivity: 'running' | 'unread' | null;
    canFork?: boolean;
    pendingNewSession?: boolean;
    pendingSessionSwitch?: boolean;
    showPreviewToggle?: boolean;
    expandedGroup?: boolean;
    onToggleCollapsed: () => void;
    onStartProjectRename: () => void;
    onForgetProject: () => void;
    onDeleteProject: () => void;
    onNewSession: () => void;
    onToggleExpandedGroup: () => void;
    getSessionState: (sessionId: string) => SessionRowState;
    onToggleSubsessions: (sessionId: string) => void;
    onSwitchSession: (path: string) => void;
    onStartSessionRename: (session: SessionSummary) => void;
    onFork: () => void;
    onDeleteSession: (session: SessionSummary) => void;
    onCommitRename: () => void;
    onCancelRename: () => void;
    onRenameDraft: (value: string) => void;
  } = $props();

  let renameInputEl = $state<HTMLInputElement | undefined>(undefined);

  $effect(() => {
    if (!isRenaming) return;
    tick().then(() => {
      renameInputEl?.focus();
      renameInputEl?.select();
    });
  });
</script>

<div
  class="group/dir relative rounded-2xl transition-colors duration-150 {isActive
    ? 'bg-base-content/[0.03]'
    : 'hover:bg-base-content/[0.025]'}"
>
  {#if isRenaming}
    <div class="px-3 py-2.5 flex items-center gap-2">
      <Folder class="w-4 h-4 shrink-0 text-base-content/55" aria-hidden="true" />
      <input
        bind:this={renameInputEl}
        type="text"
        value={renameDraft}
        oninput={(event) => onRenameDraft((event.currentTarget as HTMLInputElement).value)}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommitRename();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancelRename();
          }
        }}
        class="flex-1 bg-transparent border-b border-base-content/30 focus:border-base-content/60 outline-none text-sm py-0.5 text-base-content/90 min-w-0 transition-colors"
        placeholder={group.cwd.split('/').filter(Boolean).pop()}
        aria-label="Project name"
      />
      <button
        onclick={onCommitRename}
        class="w-7 h-7 flex items-center justify-center text-primary/70 hover:text-primary hover:bg-primary/8 rounded-lg transition-colors"
        aria-label="Confirm rename"><Check class="w-3.5 h-3.5" aria-hidden="true" /></button
      >
      <button
        onclick={onCancelRename}
        class="w-7 h-7 flex items-center justify-center text-base-content/60 hover:text-base-content/80 hover:bg-base-content/8 rounded-lg transition-colors"
        aria-label="Cancel rename"><X class="w-3.5 h-3.5" aria-hidden="true" /></button
      >
    </div>
  {:else}
    <div class="flex items-center">
      <button
        onclick={onToggleCollapsed}
        class="flex-1 min-w-0 flex items-center gap-2 px-3 py-2 text-left transition-colors duration-150 rounded-2xl {isActive
          ? 'text-base-content font-semibold'
          : 'text-base-content/60 hover:text-base-content/85'}"
        tabindex={open ? 0 : -1}
        aria-expanded={!isCollapsed}
        title={group.cwd}
      >
        <ChevronRight
          class="w-3 h-3 shrink-0 text-base-content/40 transition-transform duration-150 {isCollapsed
            ? ''
            : 'rotate-90'}"
          aria-hidden="true"
        />
        {#if isActive}
          <FolderOpen class="w-4 h-4 shrink-0 text-primary/70" aria-hidden="true" />
        {:else}
          <Folder class="w-4 h-4 shrink-0 text-base-content/45" aria-hidden="true" />
        {/if}
        <span class="flex-1 min-w-0 truncate text-sm">{group.name}</span>
        {#if !group.exists}
          <span
            class="shrink-0 flex items-center gap-1 text-[10px] text-warning/70"
            title="Directory no longer exists on disk"
          >
            <TriangleAlert class="w-3 h-3" aria-hidden="true" />missing
          </span>
        {/if}
        {#if projectActivity === 'running'}
          <span
            class="w-1.5 h-1.5 rounded-full bg-success glow-success animate-pulse shrink-0"
            aria-hidden="true"
            title="Generating"
          ></span>
          <span class="sr-only">Background session running</span>
        {:else if projectActivity === 'unread'}
          <span
            class="w-1.5 h-1.5 rounded-full bg-primary glow-primary shrink-0"
            aria-hidden="true"
            title="Unchecked results"
          ></span>
          <span class="sr-only">Unchecked result</span>
        {/if}
        {#if group.pinned}
          <Pin class="w-3 h-3 shrink-0 text-primary/45 group-hover/dir:hidden" aria-hidden="true" />
        {/if}
        <span
          class="text-[11px] text-base-content/60 shrink-0 tabular-nums group-hover/dir:hidden"
          aria-hidden="true">{group.sessions.length}</span
        >
        <span class="sr-only"
          >{group.sessions.length} {group.sessions.length === 1 ? 'session' : 'sessions'}</span
        >
      </button>
      <div
        class="touch-reveal touch-reveal-lg hidden group-hover/dir:flex group-focus-within/dir:flex items-center gap-0.5 pr-1.5 shrink-0"
      >
        <button
          onclick={onStartProjectRename}
          class="w-7 h-7 flex items-center justify-center text-base-content/55 hover:text-base-content/80 hover:bg-base-content/8 rounded-xl transition-colors"
          title="Rename project"
          aria-label="Rename project {group.name}"
          tabindex={open ? 0 : -1}><Pencil class="w-3 h-3" aria-hidden="true" /></button
        >
        {#if group.registered && group.sessions.length === 0 && !isActive}
          <button
            onclick={onForgetProject}
            class="w-7 h-7 flex items-center justify-center text-base-content/55 hover:text-error hover:bg-error/8 rounded-xl transition-colors"
            title="Forget project"
            aria-label="Forget project {group.name}"
            tabindex={open ? 0 : -1}><X class="w-3.5 h-3.5" aria-hidden="true" /></button
          >
        {/if}
        {#if group.sessions.length > 0 && !isActive}
          <button
            onclick={onDeleteProject}
            class="w-7 h-7 flex items-center justify-center text-base-content/55 hover:text-error hover:bg-error/8 rounded-xl transition-colors"
            title="Delete project and all sessions"
            aria-label="Delete project {group.name}"
            tabindex={open ? 0 : -1}><Trash class="w-3.5 h-3.5" aria-hidden="true" /></button
          >
        {/if}
        <button
          onclick={onNewSession}
          disabled={!group.exists || pendingNewSession}
          class="w-7 h-7 flex items-center justify-center text-base-content/55 hover:text-primary hover:bg-primary/10 rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          title="New session in {group.name}"
          aria-label="New session in {group.name}"
          tabindex={open ? 0 : -1}><Plus class="w-3.5 h-3.5" aria-hidden="true" /></button
        >
      </div>
    </div>
  {/if}

  {#if !isCollapsed}
    <div class="pt-0.5 pb-1.5 space-y-1">
      {#if group.sessions.length === 0}
        <p class="px-3 py-1.5 text-xs text-base-content/60">no sessions yet</p>
      {/if}
      {#each sessionRows as row (row.session.id)}
        {@const state = getSessionState(row.session.id)}
        <SessionRow
          {row}
          {open}
          isActive={state.isActive}
          isSubsessionsExpanded={state.isSubsessionsExpanded}
          isRenaming={state.isRenaming}
          isToolRunning={state.isToolRunning}
          isRunning={state.isRunning}
          needsAttention={state.needsAttention}
          hasUnread={state.hasUnread}
          {renameDraft}
          {canFork}
          pendingNewSession={pendingSessionSwitch}
          onToggleSubsessions={() => onToggleSubsessions(row.session.id)}
          onSwitch={() => onSwitchSession(row.session.path)}
          onStartRename={onStartSessionRename}
          {onFork}
          onDelete={onDeleteSession}
          {onCommitRename}
          {onCancelRename}
          {onRenameDraft}
        />
      {/each}
      {#if showPreviewToggle && rootCount > SESSION_PREVIEW_LIMIT && !expandedGroup}
        <button
          onclick={onToggleExpandedGroup}
          class="w-full text-left px-3 py-1.5 text-xs text-base-content/60 hover:text-base-content/80 transition-colors"
          tabindex={open ? 0 : -1}
        >
          Show {rootCount - SESSION_PREVIEW_LIMIT} more sessions
        </button>
      {:else if showPreviewToggle && expandedGroup && rootCount > SESSION_PREVIEW_LIMIT}
        <button
          onclick={onToggleExpandedGroup}
          class="w-full text-left px-3 py-1.5 text-xs text-base-content/60 hover:text-base-content/80 transition-colors"
          tabindex={open ? 0 : -1}
        >
          Show fewer sessions
        </button>
      {/if}
    </div>
  {/if}
</div>
