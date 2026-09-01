<script lang="ts">
  import type { UIMessage } from '#lib/client-messages.js';
  import ProjectPicker from '#lib/components/projects/project-picker.svelte';
  import MessageRow from '#lib/components/chat/message-row.svelte';
  import { BottomSheet } from '#lib/components/ui/bottom-sheet/index.js';

  /** Precomputed turn-boundary map. For each assistant message, true = last assistant in its turn.
   *  Maintained incrementally on tail changes (append/truncate) — recomputing the
   *  whole map per append was O(N²) over a session. */
  const isLastInTurnMap = $state<Record<string, boolean>>({});
  let _prevTailKey = '';
  let _prevMarkedId: string | undefined;
  $effect(() => {
    const n = messages.length;
    const lastMsg = n > 0 ? messages[n - 1] : undefined;
    const tailKey = lastMsg ? `${n}:${lastMsg.id}:${lastMsg.role}` : '';
    if (tailKey === _prevTailKey) return;
    _prevTailKey = tailKey;
    // Only the final turn's marker can change with the tail: appending a user
    // message opens a new empty turn and leaves the previous marker intact.
    if (lastMsg && lastMsg.role !== 'user' && _prevMarkedId !== undefined) {
      isLastInTurnMap[_prevMarkedId] = false;
    }
    let newMarked: string | undefined;
    if (lastMsg && lastMsg.role !== 'user') {
      for (let i = n - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user') break;
        if (m.role === 'assistant') {
          newMarked = m.id;
          break;
        }
      }
    }
    if (newMarked !== undefined) isLastInTurnMap[newMarked] = true;
    _prevMarkedId = newMarked;
  });

  let {
    messages,
    sessionLoading,
    wsState,
    sessionId,
    isMobile,
    isStreaming,
    copiedId,
    copiedTurnId,
    expandedUserMsgs,
    truncatedUserMsgs = $bindable(),
    workingVisible,
    hiddenThinkingLabel,
    workingIndicatorFrames,
    workingFrameIndex,
    workingMessage,
    messagesTruncated,
    totalRawMessagesLoaded,
    totalMessageCount,
    projectPickerOpen,
    activeProjectName,
    onLoadOlder,
    onCopyMessage,
    onCopyTurn,
    onExpandUserMsg,
    onToggleThinking,
    onToggleTool,
    onProjectPickerToggle,
    onProjectPickerClose,
    onInsertShortcut,
    onEditMessage,
    onDismissNotice,
    onHaptic,
  }: {
    messages: UIMessage[];
    sessionLoading: boolean;
    wsState: 'connecting' | 'open' | 'closed';
    sessionId: string | null;
    isMobile: boolean;
    isStreaming: boolean;
    copiedId: string | null;
    copiedTurnId: string | null;
    expandedUserMsgs: Record<string, boolean>;
    truncatedUserMsgs: Record<string, boolean>;
    workingVisible: boolean;
    hiddenThinkingLabel: string;
    workingIndicatorFrames: string[];
    workingFrameIndex: number;
    workingMessage: string | undefined;
    messagesTruncated: boolean;
    totalRawMessagesLoaded: number;
    totalMessageCount: number;
    projectPickerOpen: boolean;
    activeProjectName: string;
    onLoadOlder: () => void;
    onCopyMessage: (msg: UIMessage) => void;
    onCopyTurn: (msg: UIMessage) => void;
    onExpandUserMsg: (msgId: string, isExpanded: boolean) => void;
    onToggleThinking: (msg: UIMessage) => void;
    onToggleTool: (msg: UIMessage) => void;
    onProjectPickerToggle: (e: MouseEvent) => void;
    onProjectPickerClose: () => void;
    onInsertShortcut: (text: string) => void;
    onEditMessage: (originalText: string, newText: string) => void;
    onDismissNotice: (id: string) => void;
    onHaptic?: () => void;
  } = $props();

  /**
   * Client-side DOM cap — the full array stays in state (pagination, edits),
   * but only the tail is mounted. Prevents unbounded DOM growth in very long
   * sessions; older messages re-mount via the button rendered at the top.
   */
  const MAX_MOUNTED_MESSAGES = 400;
  let mountedLimit = $state(MAX_MOUNTED_MESSAGES);
  const visibleMessages = $derived(
    messages.length > mountedLimit ? messages.slice(-mountedLimit) : messages
  );
</script>

{#if sessionLoading}
  <div
    class="aurora min-h-full flex flex-col items-center justify-start gap-3 px-4 pt-8"
    role="status"
    aria-live="polite"
  >
    {#each Array.from({ length: 14 }, (_, i) => i) as i (i)}
      <div
        class="flex {i % 2 === 0
          ? 'justify-end'
          : 'justify-start'} w-full max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl mx-auto"
      >
        <div
          class="skeleton-shimmer {i % 2 === 0
            ? 'bg-base-content/[0.06] rounded-2xl rounded-br-md w-3/5 h-10'
            : 'bg-base-content/[0.04] rounded-2xl rounded-bl-md w-4/5 h-16'}"
        ></div>
      </div>
    {/each}
  </div>
{:else if messages.length === 0 && wsState === 'connecting'}
  <div
    class="aurora min-h-full flex flex-col items-center justify-center gap-4 select-none pointer-events-none"
  >
    <span class="pi-glyph pi-glyph-breathe text-8xl font-light leading-none">π</span>
    <p class="text-sm text-base-content/50 tracking-wide">connecting…</p>
  </div>
{:else if messages.length === 0 && wsState === 'open' && !sessionId}
  <div
    class="aurora min-h-full flex flex-col items-center justify-center gap-4 select-none pointer-events-none"
  >
    <span class="pi-glyph pi-glyph-breathe text-8xl font-light leading-none">π</span>
    <p class="text-sm text-base-content/50 tracking-wide">loading session…</p>
  </div>
{:else if messages.length === 0 && wsState === 'open'}
  <div
    class="aurora min-h-full flex flex-col items-center justify-center gap-5 select-none px-6"
    role="presentation"
    onclick={(e) => {
      if (projectPickerOpen) {
        const target = e.target as HTMLElement;
        if (!target.closest('[data-project-picker]')) {
          onProjectPickerClose();
        }
      }
    }}
  >
    <span class="pi-glyph pi-glyph-breathe text-8xl font-light leading-none">π</span>
    <div class="flex flex-col items-center gap-1">
      <p class="text-base text-base-content/75">What should we build?</p>
      <button
        onclick={onProjectPickerToggle}
        class="text-xs text-base-content/35 hover:text-base-content/60 transition-colors pointer-events-auto flex items-center gap-1"
        aria-expanded={projectPickerOpen}
      >
        <span>{activeProjectName ? `working in ${activeProjectName}` : 'start a conversation'}</span
        >
        <svg
          class="w-3 h-3 transition-transform duration-150 {projectPickerOpen ? 'rotate-180' : ''}"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg
        >
      </button>
    </div>
    {#if projectPickerOpen}
      {#if isMobile}
        <BottomSheet open={projectPickerOpen} onClose={onProjectPickerClose} title="Select project">
          <ProjectPicker onClose={onProjectPickerClose} />
        </BottomSheet>
      {:else}
        <ProjectPicker onClose={onProjectPickerClose} />
      {/if}
    {/if}
    <div class="flex flex-wrap justify-center gap-2 mt-1 max-w-sm pointer-events-auto">
      <button
        onclick={() => onInsertShortcut('/session ')}
        class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-primary hover:border-primary/35 hover:bg-primary/[0.06] transition-all duration-150 hover:-translate-y-px"
        >/session</button
      >
      <button
        onclick={() => onInsertShortcut('! ')}
        class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-secondary hover:border-secondary/35 hover:bg-secondary/[0.06] transition-all duration-150 hover:-translate-y-px"
        >! run a command</button
      >
      {#if activeProjectName}
        <button
          onclick={() => onInsertShortcut('#review ')}
          class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-accent hover:border-accent/35 hover:bg-accent/[0.06] transition-all duration-150 hover:-translate-y-px"
          >#review</button
        >
      {/if}
    </div>
  </div>
{:else}
  <div
    class="w-full max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl mx-auto px-4 md:px-6 flex flex-col gap-1"
  >
    {#if messagesTruncated}
      <div class="flex items-center gap-3 py-2 select-none" aria-live="polite">
        <span
          class="flex-1 h-px bg-gradient-to-r from-transparent via-base-content/12 to-transparent"
        ></span>
        <button
          onclick={onLoadOlder}
          disabled={totalRawMessagesLoaded >= totalMessageCount}
          class="shrink-0 text-[11px] transition-colors px-3 py-1 rounded-full border bg-base-content/[0.02] {totalRawMessagesLoaded >=
          totalMessageCount
            ? 'text-base-content/15 border-base-content/5 cursor-default'
            : 'text-base-content/35 hover:text-primary border-base-content/8 hover:border-primary/25 hover:bg-primary/[0.04]'}"
        >
          {#if totalRawMessagesLoaded >= totalMessageCount}
            <span>All messages loaded</span>
          {:else}
            Load {Math.min(50, totalMessageCount - totalRawMessagesLoaded).toLocaleString()} older ({totalMessageCount -
              totalRawMessagesLoaded} remaining)
          {/if}
        </button>
        <span
          class="flex-1 h-px bg-gradient-to-r from-transparent via-base-content/12 to-transparent"
        ></span>
      </div>
    {/if}

    {#if messages.length > mountedLimit}
      <div class="flex items-center gap-3 py-2 select-none">
        <span
          class="flex-1 h-px bg-gradient-to-r from-transparent via-base-content/12 to-transparent"
        ></span>
        <button
          onclick={() => (mountedLimit += MAX_MOUNTED_MESSAGES)}
          class="shrink-0 text-[11px] transition-colors px-3 py-1 rounded-full border bg-base-content/[0.02] text-base-content/35 hover:text-primary border-base-content/8 hover:border-primary/25 hover:bg-primary/[0.04]"
        >
          Show {messages.length - mountedLimit} older messages
        </button>
        <span class="flex-1 h-px bg-gradient-to-r from-base-content/12 to-transparent"></span>
      </div>
    {/if}

    {#each visibleMessages as msg, i (msg.id)}
      <MessageRow
        {msg}
        isNewest={i === visibleMessages.length - 1}
        isLastInTurn={isLastInTurnMap[msg.id] ?? false}
        {copiedId}
        {copiedTurnId}
        {isMobile}
        {isStreaming}
        {expandedUserMsgs}
        {truncatedUserMsgs}
        {workingVisible}
        {hiddenThinkingLabel}
        {workingIndicatorFrames}
        {workingFrameIndex}
        {workingMessage}
        {onCopyMessage}
        {onCopyTurn}
        {onExpandUserMsg}
        {onToggleThinking}
        {onToggleTool}
        {onEditMessage}
        {onDismissNotice}
        {onHaptic}
      />
    {/each}
  </div>
{/if}
