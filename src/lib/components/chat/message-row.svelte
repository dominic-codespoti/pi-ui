<script lang="ts">
  import Loader from '@lucide/svelte/icons/loader';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Pencil from '@lucide/svelte/icons/pencil';
  import X from '@lucide/svelte/icons/x';
  import { Button } from '#lib/components/ui/button/index.js';
  import type { UIMessage } from '#lib/client-messages.js';
  import { memoizedRenderMarkdown } from '#lib/markdown.js';
  import {
    compactionSavings,
    compactionStatus,
    compactionStatusClass,
    compactionStatusLabel,
  } from './message-row-helpers.ts';
  import { formatRelativeDate as formatDate } from '#lib/utils.js';
  import { BottomSheet } from '#lib/components/ui/bottom-sheet/index.js';
  import Copy from '@lucide/svelte/icons/copy';
  import Layers from '@lucide/svelte/icons/layers';
  import LiveElapsed from '#lib/components/chat/live-elapsed.svelte';
  import UserMessageRow from './user-message-row.svelte';
  import AssistantMessageRow from './assistant-message-row.svelte';
  import ToolMessageRow from './tool-message-row.svelte';

  let {
    msg: sourceMsg,
    revision,
    isNewest,
    isLastInTurn,
    copiedId,
    copiedTurnId,
    isMobile,
    isStreaming,
    expandedUserMsgs,
    truncatedUserMsgs,
    workingVisible,
    hiddenThinkingLabel,
    workingIndicatorFrames,
    workingFrameIndex,
    workingMessage,
    onCopyMessage,
    onCopyTurn,
    onExpandUserMsg,
    onToggleThinking,
    onToggleTool,
    onEditMessage,
    onDismissNotice,
    onHaptic,
  }: {
    msg: UIMessage;
    revision: number;
    isNewest: boolean;
    isLastInTurn: boolean;
    copiedId: string | null;
    copiedTurnId: string | null;
    isMobile: boolean;
    isStreaming: boolean;
    expandedUserMsgs: Record<string, boolean>;
    truncatedUserMsgs: Record<string, boolean>;
    workingVisible: boolean;
    hiddenThinkingLabel: string;
    workingIndicatorFrames: string[];
    workingFrameIndex: number;
    workingMessage: string | undefined;
    onCopyMessage: (msg: UIMessage) => void;
    onCopyTurn: (msg: UIMessage) => void;
    onExpandUserMsg: (msgId: string, isExpanded: boolean) => void;
    onToggleThinking: (msg: UIMessage) => void;
    onToggleTool: (msg: UIMessage) => void;
    onEditMessage: (originalText: string, newText: string) => void;
    onDismissNotice: (id: string) => void;
    onHaptic?: () => void;
  } = $props();
  let msg = $derived.by(() => {
    void revision;
    return { ...sourceMsg };
  });
  let editingId: string | null = $state(null);
  let editingText = $state('');

  let sheetMessage: UIMessage | null = $state(null);
  let sheetOpen = $state(false);
  let _longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let _lpStartX = 0;
  let _lpStartY = 0;

  function startLongPress(message: UIMessage, event: PointerEvent) {
    if (!isMobile) return;
    if (
      (event.target as HTMLElement).closest(
        'button, a, input, textarea, select, [role="button"], .select-text, [contenteditable="true"]'
      )
    ) {
      return;
    }
    _lpStartX = event.clientX;
    _lpStartY = event.clientY;
    clearTimeout(_longPressTimer);
    _longPressTimer = setTimeout(() => {
      _longPressTimer = undefined;
      sheetMessage = message;
      sheetOpen = true;
      onHaptic?.();
    }, 500);
  }

  function moveLongPress(event: PointerEvent) {
    if (!_longPressTimer) return;
    if (Math.abs(event.clientX - _lpStartX) > 10 || Math.abs(event.clientY - _lpStartY) > 10) {
      clearTimeout(_longPressTimer);
      _longPressTimer = undefined;
    }
  }

  function cancelLongPress() {
    clearTimeout(_longPressTimer);
    _longPressTimer = undefined;
  }
</script>

{#if msg.role === 'user'}
  <UserMessageRow
    {msg}
    {isNewest}
    {copiedId}
    {isMobile}
    {isStreaming}
    {expandedUserMsgs}
    {truncatedUserMsgs}
    {onCopyMessage}
    {onExpandUserMsg}
    bind:editingId
    bind:editingText
    {onEditMessage}
    onLongPressStart={(event) => startLongPress(msg, event)}
    onLongPressMove={moveLongPress}
    onLongPressCancel={cancelLongPress}
  />
{:else if msg.role === 'assistant'}
  <AssistantMessageRow
    {msg}
    {isNewest}
    {isLastInTurn}
    {copiedId}
    {copiedTurnId}
    {isMobile}
    {workingVisible}
    {hiddenThinkingLabel}
    {workingIndicatorFrames}
    {workingFrameIndex}
    {workingMessage}
    {onCopyMessage}
    {onCopyTurn}
    {onToggleThinking}
    onLongPressStart={(event) => startLongPress(msg, event)}
    onLongPressMove={moveLongPress}
    onLongPressCancel={cancelLongPress}
  />
{:else if msg.role === 'tool'}
  <ToolMessageRow {msg} {isNewest} {isMobile} {onToggleTool} />
  <!-- ── Diagnostic ───────────────────────────────────────────────── -->
{:else if msg.role === 'diagnostic'}
  <div class="my-1.5" class:msg-in={isNewest}>
    <div
      class="rounded-xl border-l-4 px-3.5 py-2.5 text-sm leading-relaxed select-text {!msg.level ||
      msg.level === 'info'
        ? 'border-info bg-info/[0.03]'
        : ''} {msg.level === 'warning' ? 'border-warning bg-warning/[0.04]' : ''} {msg.level ===
      'error'
        ? 'border-error bg-error/[0.04]'
        : ''} {msg.level === 'success' ? 'border-success bg-success/[0.04]' : ''}"
    >
      <div class="flex items-center gap-2 mb-1">
        {#if msg.level === 'warning'}
          <span class="text-[10px] uppercase tracking-[0.12em] font-semibold text-warning/70"
            >Warning</span
          >
        {:else if msg.level === 'error'}
          <span class="text-[10px] uppercase tracking-[0.12em] font-semibold text-destructive/70"
            >Error</span
          >
        {:else if msg.level === 'success'}
          <span class="text-[10px] uppercase tracking-[0.12em] font-semibold text-success/70"
            >Success</span
          >
        {:else}
          <span class="text-[10px] uppercase tracking-[0.12em] font-semibold text-info/70"
            >Info</span
          >
        {/if}
        {#if msg.source}
          <span class="text-[10px] text-base-content/35 font-mono">{msg.source}</span>
        {/if}
        <span class="flex-1"></span>
        <span class="text-[10px] text-base-content/45">{formatDate(msg.createdAt)}</span>
      </div>
      <div class="prose prose-sm text-base-content/85">
        {@html memoizedRenderMarkdown(msg.content)}
      </div>
      {#if msg.details}
        <button
          onclick={() => (msg.expanded = !msg.expanded)}
          class="mt-1.5 text-[10px] text-base-content/40 hover:text-base-content/70 transition-colors select-none cursor-pointer"
        >
          {msg.expanded ? '▾ less' : '▸ more'}
        </button>
        {#if msg.expanded}
          <div
            class="mt-1.5 text-xs text-base-content/50 whitespace-pre-wrap leading-relaxed px-2 py-1.5 bg-base-content/[0.04] rounded"
          >
            {@html memoizedRenderMarkdown(msg.details)}
          </div>
        {/if}
      {/if}
    </div>
  </div>

  <!-- ── Notice ────────────────────────────────────────────────────── -->
{:else if msg.role === 'notice'}
  {#if msg.noticeKind === 'toast'}
    <div class="my-1.5 min-w-0 flex items-start gap-2.5" class:msg-in={isNewest}>
      <div
        class="min-w-0 flex-1 rounded-xl border-l-4 px-3.5 py-2.5 text-sm leading-relaxed select-text {!msg.level ||
        msg.level === 'info'
          ? 'border-info bg-info/[0.03]'
          : ''} {msg.level === 'warning' ? 'border-warning bg-warning/[0.04]' : ''} {msg.level ===
        'error'
          ? 'border-error bg-error/[0.04]'
          : ''}"
      >
        <div class="flex min-w-0 items-start gap-2">
          <span class="min-w-0 flex-1 break-words whitespace-pre-wrap text-base-content/85"
            >{msg.content}</span
          >
          <span class="text-[10px] text-base-content/40 shrink-0">{formatDate(msg.createdAt)}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 -my-1"
            onclick={() => onDismissNotice(msg.id)}
            aria-label="Dismiss"><X class="w-3.5 h-3.5" /></Button
          >
        </div>
      </div>
    </div>
  {:else if msg.noticeKind === 'compaction'}
    {@const details = msg.compaction}
    {@const status = compactionStatus(msg)}
    {@const savings = compactionSavings(details?.tokensBefore, details?.tokensAfter)}
    <div class="my-2" class:msg-in={isNewest}>
      <div class="rounded-xl border border-base-content/10 bg-base-content/[0.025] px-3.5 py-3">
        <div class="flex items-start gap-2.5">
          <span
            class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg {status ===
            'failed'
              ? 'bg-error/10 text-error/75'
              : status === 'aborted'
                ? 'bg-base-content/8 text-base-content/55'
                : status === 'retrying'
                  ? 'bg-info/10 text-info/75'
                  : status === 'completed'
                    ? 'bg-success/10 text-success/75'
                    : 'bg-warning/10 text-warning/75'}"
          >
            {#if status === 'running'}
              <Loader class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {:else if status === 'failed' || status === 'aborted'}
              <CircleX class="h-3.5 w-3.5" aria-hidden="true" />
            {:else}
              <Sparkles class="h-3.5 w-3.5" aria-hidden="true" />
            {/if}
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-xs font-medium text-base-content/80">Context compaction</span>
              <span
                class="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] {compactionStatusClass(
                  status
                )}">{compactionStatusLabel(status)}</span
              >
              {#if details?.reason}
                <span class="text-[10px] text-base-content/35">{details.reason}</span>
              {/if}
            </div>
            <p class="mt-1 text-[11px] leading-relaxed text-base-content/55">{msg.content}</p>
          </div>
          <LiveElapsed
            startMs={details?.startedAt}
            endMs={details?.endedAt}
            durationMs={details?.durationMs}
            active={msg.streaming}
            format="duration"
            className="shrink-0 pt-0.5 text-[10px] tabular-nums text-base-content/40"
          />
        </div>
        {#if details?.tokensBefore !== undefined || details?.tokensAfter !== undefined}
          <div
            class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-base-content/8 pt-2 text-[10px]"
          >
            <span class="text-base-content/35">Context</span>
            <span class="font-mono tabular-nums text-base-content/65">
              {details?.tokensBefore !== undefined ? details.tokensBefore.toLocaleString() : '—'}
              <span class="px-1 text-base-content/30">→</span>
              {details?.tokensAfter !== undefined ? details.tokensAfter.toLocaleString() : '—'}
              tokens
            </span>
            {#if savings !== undefined}
              <span class="text-success/70">{savings}% freed</span>
            {/if}
          </div>
        {/if}
        {#if details?.errorMessage && !msg.content.includes(details.errorMessage)}
          <div
            class="mt-2 flex items-start gap-1.5 border-t border-error/10 pt-2 text-[10px] text-error/70"
          >
            <CircleX class="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span class="break-words">{details.errorMessage}</span>
          </div>
        {/if}
      </div>
    </div>
  {:else if msg.customType === 'slash_result'}
    <div
      class="my-2 px-4 py-3 bg-base-content/[0.04] border border-base-content/[0.06] rounded-xl font-mono text-[11px] leading-relaxed text-base-content/70 whitespace-pre-wrap break-words overflow-hidden select-text shadow-inner shadow-black/5"
      class:msg-in={isNewest}
    >
      {msg.content}
    </div>
  {:else if msg.renderedNoticeHtml}
    <div
      class="my-2 px-4 py-3 bg-base-content/[0.04] border border-base-content/[0.06] rounded-xl font-mono text-[11px] leading-relaxed text-base-content/70 whitespace-pre-wrap break-words overflow-hidden select-text shadow-inner shadow-black/5"
      class:msg-in={isNewest}
    >
      {#each msg.renderedNoticeHtml as line, i (i)}<div>{@html line || '&nbsp;'}</div>{/each}
    </div>
  {:else}
    <div
      class="flex min-w-0 max-w-full items-start gap-2.5 text-[10px] text-base-content/45 select-none py-1"
      class:msg-in={isNewest}
    >
      <span class="min-w-0 flex-1 h-px bg-gradient-to-r from-transparent to-base-content/15"></span>
      <span class="flex min-w-0 max-w-full items-start gap-1">
        {#if msg.streaming}
          <svg
            class="w-2 h-2 shrink-0 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg
          >
        {:else if msg.noticeKind === 'retry'}
          <svg
            class="w-2 h-2 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            ><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path
              d="M3 3v5h5"
            /></svg
          >
        {:else if msg.noticeKind === 'custom'}
          <span class="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-secondary inline-block"></span>
        {/if}
        <span class="min-w-0 break-words whitespace-pre-wrap">{msg.content}</span>
      </span>
      <span class="min-w-0 flex-1 h-px bg-gradient-to-l from-transparent to-base-content/15"></span>
    </div>
  {/if}
{/if}
{#if sheetMessage}
  {@const sm = sheetMessage}
  <BottomSheet
    bind:open={sheetOpen}
    title={sm.content?.slice(0, 80) || (sm.role === 'user' ? 'Your message' : 'Response')}
  >
    <div class="flex flex-col gap-1 py-1">
      <button
        onclick={() => {
          onCopyMessage(sm);
          sheetOpen = false;
        }}
        class="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-base-content/85 hover:bg-base-content/8 active:bg-base-content/12 transition-colors"
      >
        <Copy class="w-4 h-4 text-base-content/45 shrink-0" />
        Copy message
      </button>
      {#if sm.role === 'assistant' && isLastInTurn}
        <button
          onclick={() => {
            onCopyTurn(sm);
            sheetOpen = false;
          }}
          class="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-base-content/85 hover:bg-base-content/8 active:bg-base-content/12 transition-colors"
        >
          <Layers class="w-4 h-4 text-base-content/45 shrink-0" />
          Copy entire turn
        </button>
      {/if}
      {#if sm.role === 'user' && !isStreaming}
        <button
          onclick={() => {
            editingId = sm.id;
            editingText = sm.content;
            sheetOpen = false;
          }}
          class="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm text-base-content/85 hover:bg-base-content/8 active:bg-base-content/12 transition-colors"
        >
          <Pencil class="w-4 h-4 text-base-content/45 shrink-0" />
          Edit &amp; resend
        </button>
      {/if}
      <div class="h-px bg-base-content/8 my-1" aria-hidden="true"></div>
      <button
        onclick={() => (sheetOpen = false)}
        class="w-full py-3 rounded-xl text-sm text-base-content/55 hover:bg-base-content/8 active:bg-base-content/12 transition-colors"
        >Cancel</button
      >
    </div>
  </BottomSheet>
{/if}
