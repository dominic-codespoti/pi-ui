<script lang="ts">
  import Brain from '@lucide/svelte/icons/brain';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Loader from '@lucide/svelte/icons/loader';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Check from '@lucide/svelte/icons/check';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Pencil from '@lucide/svelte/icons/pencil';
  import X from '@lucide/svelte/icons/x';
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import type { UIMessage } from '#lib/client-messages.js';
  import { memoizedRenderMarkdown, highlightCode } from '#lib/markdown.js';
  import {
    cleanDetail,
    compactionSavings,
    compactionStatus,
    compactionStatusClass,
    compactionStatusLabel,
    getToolLang,
    getToolMeta,
  } from './message-row-helpers.ts';
  import { formatRelativeDate as formatDate } from '#lib/utils.js';
  import DiffViewer from '#lib/components/diff-viewer.svelte';
  import { BottomSheet } from '#lib/components/ui/bottom-sheet/index.js';
  import Copy from '@lucide/svelte/icons/copy';
  import Layers from '@lucide/svelte/icons/layers';
  import LiveElapsed from '#lib/components/chat/live-elapsed.svelte';

  let {
    msg,
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

  let editingId: string | null = $state(null);
  let editingText = $state('');

  function checkOverflow(node: HTMLElement, msgId: string) {
    const update = () => {
      if (!expandedUserMsgs[msgId]) {
        truncatedUserMsgs[msgId] = node.scrollHeight > node.clientHeight + 2;
      }
    };
    let ro: ResizeObserver | null = null;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      if (!ro) {
        ro = new ResizeObserver(update);
        ro.observe(node);
      }
      update();
    });
    io.observe(node);
    return {
      destroy() {
        io.disconnect();
        ro?.disconnect();
      },
    };
  }

  let toolCopiedId: string | null = $state(null);
  function copyToolOutput(content: string, id: string) {
    navigator.clipboard.writeText(content).catch(() => {
      if (content.length > 50000) downloadToolOutput(content, 'tool-output');
    });
    toolCopiedId = id;
    setTimeout(() => {
      if (toolCopiedId === id) toolCopiedId = null;
    }, 1500);
  }
  function downloadToolOutput(content: string, toolName: string) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${toolName || 'output'}-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function downloadImage(src: string, index: number) {
    const a = document.createElement('a');
    a.href = src;
    a.download = `image-${Date.now()}-${index}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  let sheetMessage: UIMessage | null = $state(null);
  let sheetOpen = $state(false);
  let _longPressTimer: ReturnType<typeof setTimeout> | undefined;
  let _lpStartX = 0;
  let _lpStartY = 0;

  function startLongPress(message: UIMessage, event: PointerEvent) {
    if (!isMobile) return;
    if (
      (event.target as HTMLElement).closest('button, a, input, textarea, select, [role="button"]')
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

<!-- ── User message ───────────────────────────────────────────────── -->
{#if msg.role === 'user'}
  {@const isExpanded = expandedUserMsgs[msg.id] ?? false}
  <!-- Long-press gesture surface — children are the interactive elements -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="group sticky top-0 z-20 bg-base-100 relative pt-2 -mx-4 md:-mx-6"
    class:msg-in={isNewest}
    class:msg-row-longpress={isMobile}
    onpointerdown={(e) => startLongPress(msg, e)}
    onpointermove={moveLongPress}
    onpointerup={cancelLongPress}
    onpointercancel={cancelLongPress}
    oncontextmenu={(e) => {
      if (isMobile) e.preventDefault();
    }}
  >
    <div
      class="absolute bottom-0 left-0 right-0 h-5 bg-gradient-to-b from-base-100 to-transparent pointer-events-none"
    ></div>
    <div class="flex justify-end px-4 md:px-6">
      <div class="max-w-[82%] space-y-0.5">
        <div
          class="bg-[color-mix(in_oklch,var(--color-primary)_11%,transparent)] border border-primary/[0.08] rounded-2xl rounded-br-md px-3.5 py-2.5 space-y-1"
        >
          {#if msg.images?.length}
            <div class="flex gap-2 flex-wrap -mx-1">
              {#each msg.images as src (src)}
                <img {src} alt="attachment" class="max-h-48 max-w-full rounded-lg object-contain" />
              {/each}
            </div>
          {/if}
          {#if msg.content}
            {#if editingId === msg.id}
              <textarea
                bind:value={editingText}
                rows={Math.min(editingText.split('\n').length + 1, 8)}
                class="w-full bg-transparent border border-primary/30 rounded-lg px-2 py-1.5 text-sm text-base-content/90 leading-relaxed resize-none outline-none focus:border-primary/60"
                onkeydown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (editingText.trim() && editingText !== msg.content) {
                      onEditMessage(msg.content, editingText.trim());
                    }
                    editingId = null;
                  } else if (e.key === 'Escape') {
                    editingId = null;
                  }
                }}>{editingText}</textarea
              >
              <div class="flex items-center gap-2 mt-1">
                <button
                  onclick={() => {
                    if (editingText.trim() && editingText !== msg.content) {
                      onEditMessage(msg.content, editingText.trim());
                    }
                    editingId = null;
                  }}
                  class="text-[10px] text-primary/70 hover:text-primary transition-colors select-none"
                  >resend</button
                >
                <button
                  onclick={() => {
                    editingId = null;
                  }}
                  class="text-[10px] text-base-content/30 hover:text-base-content/55 transition-colors select-none"
                  >cancel</button
                >
              </div>
            {:else}
              <button
                type="button"
                use:checkOverflow={msg.id}
                class="w-full appearance-none bg-transparent border-0 p-0 text-left whitespace-pre-wrap break-words leading-relaxed text-base-content/90 select-text {isExpanded
                  ? 'block'
                  : 'line-clamp-3'}"
                onclick={() => {
                  if (truncatedUserMsgs[msg.id] || isExpanded) onExpandUserMsg(msg.id, !isExpanded);
                }}
                aria-expanded={isExpanded}>{msg.content}</button
              >
              {#if truncatedUserMsgs[msg.id] || isExpanded}
                <button
                  onclick={() => onExpandUserMsg(msg.id, !isExpanded)}
                  class="text-[10px] text-base-content/30 hover:text-base-content/55 transition-colors select-none"
                  >{isExpanded ? 'show less' : 'show more'}</button
                >
              {/if}
            {/if}
          {/if}
        </div>
        <div
          class="flex justify-end items-center gap-1 {isMobile
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} transition-opacity duration-150"
        >
          <span class="text-[10px] text-base-content/45">{formatDate(msg.createdAt)}</span>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  onclick={() => onCopyMessage(msg)}
                  class="flex items-center justify-center {isMobile
                    ? 'w-9 h-9'
                    : 'w-7 h-7'} text-base-content/25 hover:text-base-content/55 rounded transition-colors select-none cursor-pointer"
                  aria-label="Copy message"
                  >{#if copiedId === msg.id}<svg
                      class="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"><path d="m20 6-11 11-5-5" /></svg
                    >{:else}<svg
                      class="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      ><rect x="9" y="9" width="13" height="13" rx="2" /><path
                        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                      /></svg
                    >{/if}</button
                >
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>Copy message</Tooltip.Content>
          </Tooltip.Root>
          {#if !isStreaming && editingId !== msg.id}
            <Tooltip.Root>
              <Tooltip.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    onclick={() => {
                      editingId = msg.id;
                      editingText = msg.content;
                    }}
                    class="flex items-center justify-center {isMobile
                      ? 'w-9 h-9'
                      : 'w-7 h-7'} text-base-content/25 hover:text-base-content/55 rounded transition-colors select-none cursor-pointer"
                    aria-label="Edit message"
                    ><svg
                      class="w-3.5 h-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      ><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path
                        d="m15 5 4 4"
                      /></svg
                    ></button
                  >
                {/snippet}
              </Tooltip.Trigger>
              <Tooltip.Content>Edit and resend</Tooltip.Content>
            </Tooltip.Root>
          {/if}
        </div>
      </div>
    </div>
  </div>

  <!-- ── Assistant message ─────────────────────────────────────────── -->
{:else if msg.role === 'assistant'}
  <!-- Long-press gesture surface — children are the interactive elements -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="group trace-step"
    class:msg-in={isNewest}
    class:msg-row-longpress={isMobile}
    onpointerdown={(e) => startLongPress(msg, e)}
    onpointermove={moveLongPress}
    onpointerup={cancelLongPress}
    onpointercancel={cancelLongPress}
    oncontextmenu={(e) => {
      if (isMobile) e.preventDefault();
    }}
  >
    {#if msg.streaming}
      {#if msg.thinking && msg.thinking.length > 0}
        <!-- Streaming thinking: flat flex row -->
        <div class="trace-row">
          <Brain
            class="w-3.5 h-3.5 flex-shrink-0"
            style="color:var(--color-secondary);animation:pulse 1.5s ease-in-out infinite"
          />
          <span class="trace-row-label italic shimmer-text">{hiddenThinkingLabel}</span>
          <span class="trace-row-detail italic"
            >{msg.thinking.slice(0, 120)}{msg.thinking.length > 120 ? '…' : ''}</span
          >
        </div>
      {:else if !msg.content}
        <!-- Waiting/loading: flat flex row -->
        <div class="trace-row">
          <Loader
            class="w-3 h-3 flex-shrink-0 animate-spin"
            style="color:var(--color-secondary);opacity:0.6"
          />
          <span class="trace-row-label italic shimmer-text">{hiddenThinkingLabel}</span>
          <span class="trace-row-detail italic">…</span>
        </div>
      {/if}
    {:else if msg.thinking}
      {#if msg.content}
        <!-- Collapsed thinking toggle: flat flex row -->
        <button
          onclick={() => onToggleThinking(msg)}
          class="trace-row trace-row-toggle mb-5"
          aria-expanded={msg.thinkingExpanded}
        >
          <ChevronRight
            class="w-2.5 h-2.5 flex-shrink-0 transition-transform duration-150 {msg.thinkingExpanded
              ? 'rotate-90'
              : ''}"
            style="color:color-mix(in oklch, var(--color-base-content) 28%, transparent)"
          />
          <Brain class="w-3.5 h-3.5 flex-shrink-0" style="color:var(--color-secondary)" />
          <span class="trace-row-label italic">{hiddenThinkingLabel}</span>
          <span class="trace-row-detail italic"
            >{msg.thinking.slice(0, 120)}{msg.thinking.length > 120 ? '…' : ''}</span
          >
          <span class="trace-row-time">
            {#if msg.endMs && msg.thinkingStartMs}{Math.round(
                (msg.endMs - msg.thinkingStartMs) / 1000
              )}s{/if}
          </span>
        </button>
      {:else}
        <!-- Thinking-only message: render as prose -->
        <div class="trace-body prose text-base-content/80 text-sm leading-relaxed">
          {@html msg.renderedThinking ?? memoizedRenderMarkdown(msg.thinking)}
        </div>
      {/if}
    {/if}

    {#if msg.thinkingExpanded && msg.thinking && msg.content}
      <div
        class="trace-output text-[11px] text-base-content/55 max-h-56 overflow-y-auto leading-relaxed bg-base-content/[0.03] rounded-r px-3 py-2 mb-4 select-text prose prose-sm"
      >
        {@html msg.renderedThinking ?? memoizedRenderMarkdown(msg.thinking)}
      </div>
    {/if}

    {#if msg.content || msg.streaming}
      <div class="trace-body leading-relaxed select-text">
        {#if !msg.content && msg.streaming}
          {#if workingVisible && !(msg.thinking && msg.thinking.length > 0)}
            <span class="flex items-center gap-1.5 h-5" aria-label={hiddenThinkingLabel}>
              {#if workingIndicatorFrames.length > 0}
                <span class="text-base-content/60 text-sm font-mono"
                  >{workingIndicatorFrames[workingFrameIndex]}</span
                >
              {:else}
                <span class="typing-dot"></span><span class="typing-dot"></span><span
                  class="typing-dot"
                ></span>
              {/if}
              {#if workingMessage}<span class="ml-2 text-base-content/40 text-xs"
                  >{workingMessage}</span
                >{/if}
            </span>
          {/if}
        {:else if msg.aborted}
          <div
            class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-warning/10 text-warning text-sm font-medium"
          >
            <svg
              class="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              ><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line
                x1="12"
                y1="16"
                x2="12.01"
                y2="16"
              /></svg
            >
            {msg.content}
          </div>
        {:else}
          <div class="prose text-base-content/90">
            {@html msg.renderedContent ?? memoizedRenderMarkdown(msg.content)}
          </div>
          {#if msg.images?.length}
            <div class="flex gap-2 flex-wrap mt-2">
              {#each msg.images as src (src)}<img
                  {src}
                  alt=""
                  class="max-h-64 max-w-full rounded-lg object-contain border border-base-content/10"
                />{/each}
            </div>
          {/if}
          {#if msg.streaming}<span class="text-primary animate-pulse">▌</span>{/if}
        {/if}
      </div>
    {/if}

    <!-- Bottom action bar -->
    {#if !msg.streaming}
      <div
        class="trace-meta flex items-center gap-1.5 text-[10px] pt-1.5 mt-1 border-t border-base-content/[0.07] select-none {isMobile
          ? ''
          : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} transition-opacity duration-150"
      >
        <!-- Copy button — left side -->
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                onclick={() => onCopyMessage(msg)}
                class="flex items-center justify-center {isMobile
                  ? 'w-8 h-8'
                  : 'w-5 h-5'} text-base-content/35 hover:text-base-content/65 rounded transition-colors cursor-pointer"
                aria-label="Copy message"
              >
                {#if copiedId === msg.id}
                  <svg
                    class="w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"><path d="m20 6-11 11-5-5" /></svg
                  >
                {:else}
                  <svg
                    class="w-3 h-3"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    ><rect x="9" y="9" width="13" height="13" rx="2" /><path
                      d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                    /></svg
                  >
                {/if}
              </button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Copy message</Tooltip.Content>
        </Tooltip.Root>
        {#if isLastInTurn}
          <!-- Copy entire turn -->
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <button
                  {...props}
                  onclick={() => onCopyTurn(msg)}
                  class="flex items-center justify-center {isMobile
                    ? 'w-8 h-8'
                    : 'w-5 h-5'} text-base-content/35 hover:text-base-content/65 rounded transition-colors cursor-pointer"
                  aria-label="Copy turn"
                >
                  {#if copiedTurnId === msg.id}
                    <svg
                      class="w-3 h-3"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"><path d="m20 6-11 11-5-5" /></svg
                    >
                  {:else}
                    <svg
                      class="w-3 h-3"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      ><rect x="9" y="9" width="13" height="13" rx="2" /><path
                        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                      /><path d="M9 15v4a2 2 0 0 0 2 2h4" /></svg
                    >
                  {/if}
                </button>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content>Copy all responses in this turn</Tooltip.Content>
          </Tooltip.Root>
        {/if}
        <!-- Metrics — right side -->
        <span class="ml-auto flex items-center gap-2 text-base-content/55">
          {#if msg.usage}<span class="tabular-nums"
              >{msg.usage.totalTokens >= 1000
                ? (msg.usage.totalTokens / 1000).toFixed(1) + 'k'
                : msg.usage.totalTokens}t</span
            >{/if}
          {#if msg.usage?.cost?.total}<span class="tabular-nums"
              >{msg.usage.cost.total < 0.0001
                ? '<$0.0001'
                : `$${msg.usage.cost.total.toFixed(4)}`}</span
            >{/if}
          {#if msg.endMs && msg.startMs}<span class="tabular-nums"
              >{msg.endMs - msg.startMs < 1000
                ? `${msg.endMs - msg.startMs}ms`
                : `${((msg.endMs - msg.startMs) / 1000).toFixed(1)}s`}</span
            >{/if}
          <span>{formatDate(msg.createdAt)}</span>
        </span>
      </div>
    {/if}
  </div>

  <!-- ── Tool call ─────────────────────────────────────────────────── -->
{:else if msg.role === 'tool'}
  {@const meta = getToolMeta(msg.toolName)}
  {@const detail = cleanDetail(msg.toolInput ?? '')}
  {@const hasOutput = !!(
    msg.content ||
    msg.diff ||
    msg.images?.length ||
    msg.renderedResultHtml?.length
  )}
  <div class="flex flex-col trace-step tool-step" class:msg-in={isNewest}>
    <!-- Flat flex row: [status][icon][label][detail][time] -->
    <button
      onclick={() => {
        if (hasOutput) onToggleTool(msg);
      }}
      class="trace-row trace-row-toggle font-mono {!hasOutput && !msg.streaming
        ? 'cursor-default'
        : ''}"
      disabled={!hasOutput && !msg.streaming}
    >
      <!-- Status: chevron (expandable) | spinner (streaming) | check | error -->
      {#if msg.streaming}
        <Loader class="w-2.5 h-2.5 flex-shrink-0 animate-spin" style="opacity:0.5" />
      {:else if msg.isError}
        <CircleX class="w-2.5 h-2.5 flex-shrink-0 text-destructive/70" />
      {:else if hasOutput}
        <ChevronRight
          class="w-2.5 h-2.5 flex-shrink-0 transition-transform duration-150 {msg.expanded
            ? 'rotate-90'
            : ''}"
          style="color:color-mix(in oklch, var(--color-base-content) 28%, transparent)"
        />
      {:else}
        <Check class="w-2.5 h-2.5 flex-shrink-0 text-success/50" />
      {/if}
      <!-- Tool icon -->
      <meta.icon
        class="w-3.5 h-3.5 flex-shrink-0"
        style="color:{meta.color};{msg.streaming
          ? 'animation:pulse 1.5s ease-in-out infinite'
          : ''}"
      />
      <!-- Label / detail (extension-rendered if available) -->
      {#if msg.renderedCallHtml}
        <span class="trace-row-label font-normal"
          >{#each msg.renderedCallHtml as line, i (i)}{#if i > 0}<br
              />{/if}{@html line}{/each}</span
        >
      {:else}
        <span class="trace-row-label">{meta.label}</span>
        <span class="trace-row-detail">{detail}</span>
      {/if}
      <!-- Time + line count -->
      <span class="trace-row-time">
        <LiveElapsed
          startMs={msg.startMs}
          endMs={msg.endMs}
          active={msg.streaming}
          format="seconds"
        />
        {#if msg.lineCount !== undefined}<span>{msg.lineCount}L</span>{/if}
        {#if msg.images?.length}<span>{msg.images.length}img</span>{/if}
      </span>
    </button>
    {#if msg.expanded && !msg.streaming}
      {#if msg.renderedResultHtml}
        <div
          class="trace-output mt-1 text-xs leading-relaxed select-text py-1.5 px-2 bg-base-content/[0.025] rounded-r font-mono"
        >
          {#each msg.renderedResultHtml as line, i (i)}<div>
              {@html line || '&nbsp;'}
            </div>{/each}
        </div>
      {:else}
        {#if msg.diff}
          <div class="trace-output mt-1"><DiffViewer diff={msg.diff} /></div>
        {:else if msg.content}
          {@const toolLang = getToolLang(msg.toolName, msg.toolInput)}
          <div class="relative group/copy mt-1">
            {#if toolLang}
              <pre
                class="trace-output text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed select-text py-1.5 bg-base-content/[0.025] rounded-r pr-8"><code
                  class="hljs">{@html highlightCode(msg.content, toolLang)}</code
                ></pre>
            {:else}
              <pre
                class="trace-output text-base-content/58 text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed select-text py-1.5 bg-base-content/[0.025] rounded-r pr-8">{msg.content}</pre>
            {/if}
            <div
              class="touch-reveal absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 transition-opacity duration-150"
            >
              <button
                onclick={() => copyToolOutput(msg.content, msg.id)}
                class="{isMobile
                  ? 'px-2 py-1.5'
                  : 'px-1.5 py-0.5'} rounded text-[10px] text-base-content/40 hover:text-base-content/70 hover:bg-base-content/[0.06] backdrop-blur-sm"
                aria-label="Copy output"
              >
                {toolCopiedId === msg.id ? 'copied' : 'copy'}
              </button>
              <button
                onclick={() => downloadToolOutput(msg.content, msg.toolName ?? 'output')}
                class="{isMobile
                  ? 'px-2 py-1.5'
                  : 'px-1.5 py-0.5'} rounded text-[10px] text-base-content/40 hover:text-base-content/70 hover:bg-base-content/[0.06] backdrop-blur-sm"
                aria-label="Download output"
                title="Download output as .txt">download</button
              >
            </div>
          </div>
        {/if}
        {#if msg.images?.length}
          <div class="trace-output flex gap-2 flex-wrap mt-2">
            {#each msg.images as src, idx (src)}
              <div class="relative group/img">
                <img
                  {src}
                  alt=""
                  class="max-h-64 max-w-full rounded-lg object-contain border border-base-content/10"
                />
                <button
                  onclick={() => downloadImage(src, idx)}
                  class="absolute top-1 right-1 opacity-0 group-hover/img:opacity-100 transition-opacity px-1.5 py-0.5 rounded text-[10px] bg-base-100/80 text-base-content/60 hover:text-base-content border border-base-content/10 backdrop-blur-sm"
                  aria-label="Download image"
                  title="Download image">download</button
                >
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}
  </div>

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
    <div class="my-1.5 flex items-start gap-2.5" class:msg-in={isNewest}>
      <div
        class="flex-1 rounded-xl border-l-4 px-3.5 py-2.5 text-sm leading-relaxed select-text {!msg.level ||
        msg.level === 'info'
          ? 'border-info bg-info/[0.03]'
          : ''} {msg.level === 'warning' ? 'border-warning bg-warning/[0.04]' : ''} {msg.level ===
        'error'
          ? 'border-error bg-error/[0.04]'
          : ''}"
      >
        <div class="flex items-center gap-2">
          <span class="flex-1 text-base-content/85">{msg.content}</span>
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
      class="flex items-center gap-2.5 text-[10px] text-base-content/45 select-none py-1"
      class:msg-in={isNewest}
    >
      <span class="flex-1 h-px bg-gradient-to-r from-transparent to-base-content/15"></span>
      <span class="flex items-center gap-1 shrink-0">
        {#if msg.streaming}
          <svg
            class="w-2 h-2 animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg
          >
        {:else if msg.noticeKind === 'retry'}
          <svg
            class="w-2 h-2"
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
          <span class="w-2 h-2 rounded-full bg-secondary inline-block"></span>
        {/if}
        <span>{msg.content}</span>
      </span>
      <span class="flex-1 h-px bg-gradient-to-l from-transparent to-base-content/15"></span>
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
