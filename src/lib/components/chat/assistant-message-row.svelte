<script lang="ts">
  import Brain from '@lucide/svelte/icons/brain';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Loader from '@lucide/svelte/icons/loader';
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
  import type { UIMessage } from '#lib/client-messages.js';
  import { memoizedRenderMarkdown } from '#lib/markdown.js';
  import { formatRelativeDate as formatDate } from '#lib/utils.js';
  import { messageElementId, usageBreakdownTitle } from './message-row-helpers.ts';
  let {
    msg,
    isNewest,
    isLastInTurn,
    copiedId,
    copiedTurnId,
    isMobile,
    workingVisible,
    hiddenThinkingLabel,
    hideThinkingBlock,
    workingIndicatorFrames,
    workingFrameIndex,
    workingMessage,
    onCopyMessage,
    onCopyTurn,
    onToggleThinking,
    onLongPressStart,
    onLongPressMove,
    onLongPressCancel,
  }: {
    msg: UIMessage;
    isNewest: boolean;
    isLastInTurn: boolean;
    copiedId: string | null;
    copiedTurnId: string | null;
    isMobile: boolean;
    workingVisible: boolean;
    hiddenThinkingLabel: string;
    hideThinkingBlock: boolean;
    workingIndicatorFrames: string[];
    workingFrameIndex: number;
    workingMessage: string | undefined;
    onCopyMessage: (msg: UIMessage) => void;
    onCopyTurn: (msg: UIMessage) => void;
    onToggleThinking: (msg: UIMessage) => void;
    onLongPressStart: (event: PointerEvent) => void;
    onLongPressMove: (event: PointerEvent) => void;
    onLongPressCancel: () => void;
  } = $props();
  let messageLabelId = $derived(messageElementId('assistant-label', msg.id));
  let thinkingToggleId = $derived(messageElementId('thinking-toggle', msg.id));
  let thinkingHiddenText = $derived(
    hiddenThinkingLabel ||
      (msg.endMs && msg.thinkingStartMs
        ? `Thought for ${Math.round((msg.endMs - msg.thinkingStartMs) / 1000)}s`
        : 'Thinking…')
  );
  let thinkingPanelId = $derived(messageElementId('thinking', msg.id));
  let thinkingText = $derived(msg.thinking ?? '');
  let usageTitle = $derived(usageBreakdownTitle(msg.usage));
</script>

<!-- Long-press gesture surface — children are the interactive elements -->
<div
  id={messageElementId('assistant', msg.id)}
  role="group"
  aria-labelledby={messageLabelId}
  class="group trace-step"
  class:msg-in={isNewest}
  class:msg-row-longpress={isMobile}
  onpointerdown={onLongPressStart}
  onpointermove={onLongPressMove}
  onpointerup={onLongPressCancel}
  onpointercancel={onLongPressCancel}
  oncontextmenu={(e) => {
    if (isMobile) e.preventDefault();
  }}
>
  <span id={messageLabelId} class="sr-only">Assistant message</span>
  {#if msg.streaming}
    {#if thinkingText.length > 0}
      <!-- Streaming thinking: flat flex row -->
      <div class="trace-row">
        <Brain
          class="w-3.5 h-3.5 flex-shrink-0"
          style="color:var(--color-secondary);animation:pulse 1.5s ease-in-out infinite"
        />
        <span class="trace-row-label italic shimmer-text">{thinkingHiddenText}</span>
        {#if !hideThinkingBlock}
          <span class="trace-row-detail italic"
            >{thinkingText.slice(0, 120)}{thinkingText.length > 120 ? '…' : ''}</span
          >
        {/if}
      </div>
    {:else if !msg.content}
      <!-- Waiting/loading: flat flex row -->
      <div class="trace-row">
        <Loader
          class="w-3 h-3 flex-shrink-0 animate-spin"
          style="color:var(--color-secondary);opacity:0.6"
        />
        <span class="trace-row-label italic shimmer-text">{thinkingHiddenText}</span>
        <span class="trace-row-detail italic">…</span>
      </div>
    {/if}
  {:else if thinkingText && !msg.blocks?.length}
    {#if hideThinkingBlock}
      <div class="trace-row">
        <Brain class="w-3.5 h-3.5 flex-shrink-0" style="color:var(--color-secondary)" />
        <span class="trace-row-label italic">{thinkingHiddenText}</span>
      </div>
    {:else if msg.content}
      <!-- Collapsed thinking toggle: flat flex row -->
      <button
        id={thinkingToggleId}
        type="button"
        onclick={() => onToggleThinking(msg)}
        class="trace-row trace-row-toggle mb-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        aria-expanded={msg.thinkingExpanded}
        aria-controls={thinkingPanelId}
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
          >{thinkingText.slice(0, 120)}{thinkingText.length > 120 ? '…' : ''}</span
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
        {@html msg.renderedThinking ?? memoizedRenderMarkdown(thinkingText)}
      </div>
    {/if}
  {/if}
  <div
    id={thinkingPanelId}
    role="region"
    aria-labelledby={thinkingText && msg.content ? thinkingToggleId : undefined}
    hidden={!msg.thinkingExpanded ||
      !thinkingText ||
      !msg.content ||
      Boolean(msg.blocks?.length) ||
      hideThinkingBlock}
    class="trace-output text-[11px] text-base-content/55 max-h-56 overflow-y-auto leading-relaxed bg-base-content/[0.03] rounded-r px-3 py-2 mb-4 select-text prose prose-sm"
  >
    {#if msg.thinkingExpanded && thinkingText && msg.content && !msg.blocks?.length && !hideThinkingBlock}
      {@html msg.renderedThinking ?? memoizedRenderMarkdown(thinkingText)}
    {/if}
  </div>

  {#if (msg.content || msg.streaming) && !(msg.blocks?.length && !msg.streaming)}
    <div class="trace-body leading-relaxed select-text">
      {#if !msg.content && msg.streaming}
        {#if workingVisible && thinkingText.length === 0}
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
            {#each msg.images as src, i (`${msg.id}-image-${i}`)}<img
                {src}
                alt={`Image from assistant ${i + 1}`}
                class="max-h-64 max-w-full rounded-lg object-contain border border-base-content/10"
              />{/each}
          </div>
        {/if}
        {#if msg.streaming}<span class="text-primary animate-pulse">▌</span>{/if}
      {/if}
    </div>
  {/if}
  {#if !msg.streaming && msg.blocks?.length}
    <div class="trace-body leading-relaxed select-text">
      {#each msg.blocks as block, i (`${block.type}-${i}`)}
        {#if block.type === 'text'}
          <div class="prose text-base-content/90">
            {@html memoizedRenderMarkdown(block.text)}
          </div>
        {:else if hideThinkingBlock}
          <span
            class="my-1 inline-flex items-center gap-1.5 rounded-full bg-base-content/[0.04] px-2.5 py-1 text-xs text-base-content/55"
          >
            <Brain class="size-3" aria-hidden="true" />{thinkingHiddenText}
          </span>
        {:else}
          {@const blockThinkingToggleId = messageElementId('thinking-toggle', `${msg.id}-${i}`)}
          {@const blockThinkingPanelId = messageElementId('thinking', `${msg.id}-${i}`)}
          <button
            id={blockThinkingToggleId}
            type="button"
            class="trace-row trace-row-toggle mb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label={`Toggle thinking block ${i + 1}`}
            aria-expanded={Boolean(msg.thinkingExpanded)}
            aria-controls={blockThinkingPanelId}
            onclick={() => onToggleThinking(msg)}
          >
            <ChevronRight
              class="w-2.5 h-2.5 flex-shrink-0 transition-transform duration-150 {msg.thinkingExpanded
                ? 'rotate-90'
                : ''}"
              aria-hidden="true"
            />
            <Brain
              class="w-3.5 h-3.5 flex-shrink-0"
              style="color:var(--color-secondary)"
              aria-hidden="true"
            />
            <span class="trace-row-label italic">{hiddenThinkingLabel || 'Thinking'}</span>
            <span class="trace-row-detail italic">
              {block.text.slice(0, 120)}{block.text.length > 120 ? '…' : ''}
            </span>
          </button>
          <div
            id={blockThinkingPanelId}
            role="region"
            aria-labelledby={blockThinkingToggleId}
            hidden={!msg.thinkingExpanded || hideThinkingBlock}
            class="trace-output text-[11px] text-base-content/55 max-h-56 overflow-y-auto leading-relaxed bg-base-content/[0.03] rounded-r px-3 py-2 mb-4 select-text prose prose-sm"
          >
            {#if msg.thinkingExpanded && !hideThinkingBlock}
              {@html memoizedRenderMarkdown(block.text)}
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
  {#if msg.redactedThinking}
    <span
      class="my-2 inline-flex items-center rounded-full border border-base-content/10 bg-base-content/[0.04] px-2.5 py-1 text-xs text-base-content/55"
    >
      <Brain class="mr-1.5 size-3" aria-hidden="true" />Thinking hidden by provider
    </span>
  {/if}
  {#if msg.blocks?.length && msg.images?.length}
    <div class="flex gap-2 flex-wrap mt-2">
      {#each msg.images as src, i (`${msg.id}-ordered-image-${i}`)}<img
          {src}
          alt={`Image from assistant ${i + 1}`}
          class="max-h-64 max-w-full rounded-lg object-contain border border-base-content/10"
        />{/each}
    </div>
  {/if}
  {#if msg.stopReason === 'length'}
    <div class="mt-2 text-xs text-warning/80" role="status">
      Response truncated (max output tokens reached)
    </div>
  {:else if msg.stopReason === 'error'}
    <div class="mt-2 text-xs text-error" role="status">
      {msg.errorMessage || 'The model returned an error'}
    </div>
  {:else if msg.stopReason === 'deferred'}
    <div class="mt-2 text-xs text-base-content/45" role="status">Response deferred</div>
  {:else if msg.stopReason === 'aborted' || msg.aborted}
    <div class="mt-2 text-xs text-base-content/45" role="status">
      Aborted{msg.errorMessage && msg.errorMessage !== 'Request was aborted'
        ? ` — ${msg.errorMessage}`
        : ''}
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
              class="flex min-w-11 min-h-11 flex-shrink-0 items-center justify-center sm:min-w-0 sm:min-h-0 {isMobile
                ? 'w-11 h-11'
                : 'w-5 h-5'} text-base-content/35 hover:text-base-content/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded transition-colors cursor-pointer"
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
                class="flex min-w-11 min-h-11 flex-shrink-0 items-center justify-center sm:min-w-0 sm:min-h-0 {isMobile
                  ? 'w-11 h-11'
                  : 'w-5 h-5'} text-base-content/35 hover:text-base-content/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded transition-colors cursor-pointer"
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
        {#if msg.usage}<span class="tabular-nums" title={usageTitle}
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
