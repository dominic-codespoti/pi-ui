<script lang="ts">
  import { tick } from 'svelte';
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
  import type { UIMessage } from '#lib/client-messages.js';
  import { formatRelativeDate as formatDate } from '#lib/utils.js';
  import { messageElementId } from './message-row-helpers.ts';
  import { observeOverflow } from './overflow-observer.ts';
  let {
    msg,
    isNewest,
    copiedId,
    isMobile,
    isStreaming,
    expandedUserMsgs,
    truncatedUserMsgs,
    onCopyMessage,
    onExpandUserMsg,
    onEditMessage,
    onLongPressStart,
    onLongPressMove,
    onLongPressCancel,
    editingId = $bindable(null),
    editingText = $bindable(''),
  }: {
    msg: UIMessage;
    isNewest: boolean;
    copiedId: string | null;
    isMobile: boolean;
    isStreaming: boolean;
    expandedUserMsgs: Record<string, boolean>;
    truncatedUserMsgs: Record<string, boolean>;
    onCopyMessage: (msg: UIMessage) => void;
    onExpandUserMsg: (msgId: string, isExpanded: boolean) => void;
    onEditMessage: (originalText: string, newText: string) => void;
    editingId?: string | null;
    editingText?: string;
    onLongPressStart: (event: PointerEvent) => void;
    onLongPressMove: (event: PointerEvent) => void;
    onLongPressCancel: () => void;
  } = $props();
  let isExpanded = $derived(expandedUserMsgs[msg.id] ?? false);
  let messageLabelId = $derived(messageElementId('user-label', msg.id));
  let messageContentId = $derived(messageElementId('user-content', msg.id));
  let messageRootEl = $state<HTMLDivElement | undefined>(undefined);
  let editorEl = $state<HTMLTextAreaElement | undefined>(undefined);
  let editTriggerEl = $state<HTMLButtonElement | undefined>(undefined);

  $effect(() => {
    if (editingId !== msg.id) return;
    tick().then(() => {
      if (editingId !== msg.id) return;
      editorEl?.focus();
      editorEl?.select();
    });
  });

  function finishEditing(save: boolean) {
    if (save && editingText.trim() && editingText !== msg.content) {
      onEditMessage(msg.content, editingText.trim());
    }
    editingId = null;
    tick().then(() => {
      const fallback = document.getElementById(messageElementId('user', msg.id));
      const focusTarget = editTriggerEl?.isConnected ? editTriggerEl : fallback;
      (focusTarget as HTMLElement | null)?.focus();
    });
  }

  function checkOverflow(node: HTMLElement, msgId: string) {
    const update = () => {
      if (!expandedUserMsgs[msgId]) {
        truncatedUserMsgs[msgId] = node.scrollHeight > node.clientHeight + 2;
      }
    };
    const cleanup = observeOverflow(node, update);
    return { destroy: cleanup };
  }
</script>

<div
  bind:this={messageRootEl}
  id={messageElementId('user', msg.id)}
  role="group"
  aria-labelledby={messageLabelId}
  tabindex="-1"
  class="group sticky top-0 z-20 bg-base-100 pt-2 -mx-4 md:-mx-6"
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
  <span id={messageLabelId} class="sr-only">Your message</span>
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
        <div id={messageContentId} role="region" aria-labelledby={messageLabelId}>
          {#if msg.content}
            {#if editingId === msg.id}
              <textarea
                bind:this={editorEl}
                bind:value={editingText}
                rows={Math.min(editingText.split('\n').length + 1, 8)}
                class="w-full bg-transparent border border-primary/30 rounded-lg px-2 py-1.5 text-sm text-base-content/90 leading-relaxed resize-none outline-none focus:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/40"
                aria-label="Edit your message"
                onkeydown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    finishEditing(true);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    finishEditing(false);
                  }
                }}>{editingText}</textarea
              >
              <div class="flex items-center gap-2 mt-1">
                <button
                  type="button"
                  onclick={() => finishEditing(true)}
                  class="{isMobile
                    ? 'min-h-11 px-3'
                    : 'px-1'} text-[10px] text-primary/70 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded transition-colors select-none"
                  >resend</button
                >
                <button
                  type="button"
                  onclick={() => finishEditing(false)}
                  class="{isMobile
                    ? 'min-h-11 px-3'
                    : 'px-1'} text-[10px] text-base-content/30 hover:text-base-content/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded transition-colors select-none"
                  >cancel</button
                >
              </div>
            {:else}
              <button
                type="button"
                use:checkOverflow={msg.id}
                class="w-full appearance-none bg-transparent border-0 p-0 text-left whitespace-pre-wrap break-words leading-relaxed text-base-content/90 select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded {isExpanded
                  ? 'block'
                  : 'line-clamp-3'}"
                onclick={() => {
                  if (truncatedUserMsgs[msg.id] || isExpanded) onExpandUserMsg(msg.id, !isExpanded);
                }}
                aria-expanded={isExpanded}
                aria-controls={messageContentId}>{msg.content}</button
              >
              {#if truncatedUserMsgs[msg.id] || isExpanded}
                <button
                  type="button"
                  onclick={() => onExpandUserMsg(msg.id, !isExpanded)}
                  class="{isMobile
                    ? 'min-h-11 px-2'
                    : 'px-1'} text-[10px] text-base-content/30 hover:text-base-content/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded transition-colors select-none"
                  aria-expanded={isExpanded}
                  aria-controls={messageContentId}>{isExpanded ? 'show less' : 'show more'}</button
                >
              {/if}
            {/if}
          {/if}
        </div>
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
                class="flex min-w-11 min-h-11 flex-shrink-0 items-center justify-center sm:min-w-0 sm:min-h-0 {isMobile
                  ? 'w-11 h-11'
                  : 'w-7 h-7'} text-base-content/25 hover:text-base-content/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded transition-colors select-none cursor-pointer"
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
                  bind:this={editTriggerEl}
                  type="button"
                  onclick={() => {
                    editingId = msg.id;
                    editingText = msg.content;
                  }}
                  class="flex min-w-11 min-h-11 flex-shrink-0 items-center justify-center sm:min-w-0 sm:min-h-0 {isMobile
                    ? 'w-11 h-11'
                    : 'w-7 h-7'} text-base-content/25 hover:text-base-content/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded transition-colors select-none cursor-pointer"
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
