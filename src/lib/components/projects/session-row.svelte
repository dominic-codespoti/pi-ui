<script lang="ts">
  import { tick } from 'svelte';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Trash from '@lucide/svelte/icons/trash-2';
  import CornerDownRight from '@lucide/svelte/icons/corner-down-right';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import { formatRelativeDate } from '#lib/utils.js';
  import type { SessionRow as SessionTreeRow } from '#lib/state/projects-state.svelte.js';
  import type { SessionSummary } from '#lib/ws/protocol.js';

  let {
    row,
    open,
    isActive,
    isSubsessionsExpanded,
    isRenaming,
    isToolRunning,
    isRunning,
    needsAttention,
    hasUnread,
    renameDraft,
    canFork = false,
    pendingNewSession = false,
    onToggleSubsessions,
    onSwitch,
    onStartRename,
    onFork,
    onDelete,
    onCommitRename,
    onCancelRename,
    onRenameDraft,
  }: {
    row: SessionTreeRow;
    open: boolean;
    isActive: boolean;
    isSubsessionsExpanded: boolean;
    isRenaming: boolean;
    isToolRunning: boolean;
    isRunning: boolean;
    needsAttention: boolean;
    hasUnread: boolean;
    renameDraft: string;
    canFork?: boolean;
    pendingNewSession?: boolean;
    onToggleSubsessions: () => void;
    onSwitch: () => void;
    onStartRename: (session: SessionSummary) => void;
    onFork: () => void;
    onDelete: (session: SessionSummary) => void;
    onCommitRename: () => void;
    onCancelRename: () => void;
    onRenameDraft: (value: string) => void;
  } = $props();

  let renameInputEl = $state<HTMLInputElement | undefined>(undefined);
  const session = $derived(row.session);
  const sessionLabel = $derived(session.name ? session.name : session.firstMessage || '(empty)');

  $effect(() => {
    if (!isRenaming) return;
    tick().then(() => {
      renameInputEl?.focus();
      renameInputEl?.select();
    });
  });
</script>

<div
  style="margin-left: {Math.min(row.depth, 3) * 14}px"
  class="group rounded-2xl transition-colors duration-150 {isActive
    ? 'bg-primary/[0.07] border border-primary/[0.08]'
    : 'border border-transparent hover:bg-base-content/[0.035]'}"
>
  {#if isRenaming}
    <div class="px-3 py-2 flex items-center gap-2">
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
        class="flex-1 bg-transparent border-b border-base-content/30 focus:border-base-content/60 outline-none text-sm py-1 text-base-content/90 min-w-0 transition-colors"
        placeholder="session name…"
        aria-label="Session name"
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
    <div class="flex items-stretch">
      {#if row.hasChildren}
        <button
          type="button"
          onclick={(event) => {
            event.stopPropagation();
            onToggleSubsessions();
          }}
          class="flex h-10 w-9 shrink-0 items-center justify-center rounded-lg text-base-content/55 transition-colors hover:bg-base-content/8 hover:text-base-content/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:h-7 sm:w-7"
          aria-label="{isSubsessionsExpanded
            ? 'Collapse'
            : 'Expand'} sub-sessions for {sessionLabel}"
          aria-expanded={isSubsessionsExpanded}
          title="{isSubsessionsExpanded ? 'Collapse' : 'Expand'} sub-sessions"
          tabindex={open ? 0 : -1}
        >
          <ChevronRight
            class="h-3 w-3 transition-transform duration-150 {isSubsessionsExpanded
              ? 'rotate-90'
              : ''}"
            aria-hidden="true"
          />
        </button>
      {:else}
        <span class="h-10 w-9 shrink-0 sm:h-7 sm:w-7" aria-hidden="true"></span>
      {/if}
      <button
        onclick={onSwitch}
        disabled={pendingNewSession}
        class="flex-1 text-left px-3 py-2 min-w-0 disabled:cursor-wait"
        aria-current={isActive ? 'true' : undefined}
        tabindex={open ? 0 : -1}
      >
        <div class="flex items-center gap-2">
          {#if isToolRunning}
            <span
              class="w-2 h-2 rounded-full bg-primary shrink-0 animate-pulse glow-primary"
              aria-hidden="true"
            ></span>
            <span class="sr-only">{isActive ? 'Running tool' : 'Running tool in background'}</span>
          {:else if isRunning}
            <span
              class="w-2 h-2 rounded-full bg-success shrink-0 animate-pulse glow-success"
              aria-hidden="true"
            ></span>
            <span class="sr-only">{isActive ? 'Streaming' : 'Running in background'}</span>
          {:else if needsAttention}
            <span class="w-2 h-2 rounded-full bg-warning shrink-0 animate-pulse" aria-hidden="true"
            ></span>
            <span class="sr-only">Session needs attention</span>
          {:else if hasUnread}
            <span class="w-2 h-2 rounded-full bg-primary shrink-0 glow-primary" aria-hidden="true"
            ></span>
            <span class="sr-only">Unchecked result</span>
          {:else if session.parentSession}
            <CornerDownRight class="w-3 h-3 text-base-content/55 shrink-0" aria-hidden="true" />
            <span class="sr-only">Sub-session</span>
          {:else}
            <span class="w-2 h-2 rounded-full bg-base-content/20 shrink-0" aria-hidden="true"
            ></span>
          {/if}
          <span
            class="text-sm truncate leading-snug {isActive
              ? 'text-base-content font-semibold tracking-[-0.01em]'
              : 'text-base-content/75'}"
          >
            {sessionLabel}
          </span>
        </div>
        {#if session.name && session.firstMessage}
          <p class="text-xs text-base-content/60 mt-0.5 truncate pl-4">{session.firstMessage}</p>
        {/if}
        <p class="text-xs text-base-content/60 mt-0.5 pl-4 flex items-center gap-1.5">
          <span>{formatRelativeDate(session.modified)}</span>
          {#if (session.turns ?? session.messageCount) > 0}
            <span class="text-base-content/45">·</span>
            {#if session.turns !== undefined}
              <span>{session.turns} {session.turns === 1 ? 'exchange' : 'exchanges'}</span>
            {:else}
              <span>{session.messageCount} {session.messageCount === 1 ? 'msg' : 'msgs'}</span>
            {/if}
          {/if}
        </p>
      </button>
      <div
        class="touch-reveal touch-reveal-lg flex flex-col justify-center gap-0.5 pr-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
      >
        <button
          onclick={() => onStartRename(session)}
          class="w-7 h-7 flex items-center justify-center text-base-content/60 hover:text-base-content/80 hover:bg-base-content/8 rounded-lg transition-colors"
          title="Rename"
          aria-label="Rename session"
          tabindex={open ? 0 : -1}><Pencil class="w-3 h-3" aria-hidden="true" /></button
        >
        {#if isActive && canFork}
          <button
            onclick={onFork}
            class="w-7 h-7 flex items-center justify-center text-base-content/55 hover:text-primary hover:bg-primary/8 rounded-lg transition-colors"
            title="Fork session"
            aria-label="Fork session"
            tabindex={open ? 0 : -1}><GitBranch class="w-3 h-3" aria-hidden="true" /></button
          >
        {/if}
        {#if !isActive}
          <button
            onclick={() => onDelete(session)}
            class="w-7 h-7 flex items-center justify-center text-base-content/55 hover:text-error hover:bg-error/8 rounded-lg transition-colors"
            title="Delete"
            aria-label="Delete session"
            tabindex={open ? 0 : -1}><Trash class="w-3 h-3" aria-hidden="true" /></button
          >
        {/if}
      </div>
    </div>
  {/if}
</div>
