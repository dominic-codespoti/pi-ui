<script lang="ts">
  import type { UIMessage } from '#lib/client-messages.js';
  import MessageList from '#lib/components/chat/message-list.svelte';
  import { Button } from '#lib/components/ui/button/index.js';
  import X from '@lucide/svelte/icons/x';

  interface Props {
    messages: UIMessage[];
    sessionLoading: boolean;
    wsState: 'connecting' | 'open' | 'closed';
    sessionId: string | null;
    isMobile: boolean;
    isStreaming: boolean;
    copiedId: string | null;
    copiedTurnId: string | null;
    expandedUserMsgs: Record<string, boolean>;
    truncatedUserMsgs?: Record<string, boolean>;
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
    isAtBottom: boolean;
    extensionFooter?: string;
    scrollEl?: HTMLElement;
    onScroll: () => void;
    onMessageAreaClick: (event: MouseEvent) => void;
    onCodeCopy: (event: MouseEvent | KeyboardEvent) => void;
    onScrollToBottom: () => void;
    onLoadOlder: () => void;
    onCopyMessage: (msg: UIMessage) => void;
    onCopyTurn: (msg: UIMessage) => void;
    onExpandUserMsg: (msgId: string, isExpanded: boolean) => void;
    onToggleThinking: (msg: UIMessage) => void;
    onToggleTool: (msg: UIMessage) => void;
    onProjectPickerToggle: (event: MouseEvent) => void;
    onProjectPickerClose: () => void;
    onInsertShortcut: (text: string) => void;
    onEditMessage: (originalText: string, newText: string) => void;
    onDismissNotice: (id: string) => void;
    onHaptic?: () => void;
    onDismissFooter: () => void;
  }

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
    truncatedUserMsgs = $bindable<Record<string, boolean>>({}),
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
    isAtBottom,
    extensionFooter,
    scrollEl = $bindable(),
    onScroll,
    onMessageAreaClick,
    onCodeCopy,
    onScrollToBottom,
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
    onDismissFooter,
  }: Props = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main
  id="main-content"
  tabindex="-1"
  bind:this={scrollEl}
  onscroll={onScroll}
  onclick={onMessageAreaClick}
  onkeydown={onCodeCopy}
  aria-label="Conversation"
  aria-busy={sessionLoading}
  class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scroll-container-mobile pb-3 sm:pb-4 bg-base-100 rounded-none sm:rounded-xl"
  style="overflow-anchor: none; overscroll-behavior: contain;"
>
  <MessageList
    {messages}
    {sessionLoading}
    {wsState}
    {sessionId}
    {isMobile}
    {copiedId}
    {copiedTurnId}
    {isStreaming}
    {expandedUserMsgs}
    bind:truncatedUserMsgs
    {workingVisible}
    {hiddenThinkingLabel}
    {workingIndicatorFrames}
    {workingFrameIndex}
    {workingMessage}
    {messagesTruncated}
    {totalRawMessagesLoaded}
    {totalMessageCount}
    {projectPickerOpen}
    {activeProjectName}
    {onLoadOlder}
    {onCopyMessage}
    {onCopyTurn}
    {onExpandUserMsg}
    {onToggleThinking}
    {onToggleTool}
    {onProjectPickerToggle}
    {onProjectPickerClose}
    {onInsertShortcut}
    {onEditMessage}
    {onDismissNotice}
    {onHaptic}
  />
</main>

{#if extensionFooter}
  <div
    class="shrink-0 min-w-0 px-3 py-1.5 text-xs text-base-content/60 bg-base-200/50 border-t border-base-content/10 font-mono whitespace-pre-wrap flex items-start gap-2"
  >
    <span class="min-w-0 flex-1 break-words">{extensionFooter}</span>
    <Button variant="ghost" size="icon-xs" onclick={onDismissFooter} aria-label="Dismiss footer"
      ><X class="w-3 h-3" /></Button
    >
  </div>
{/if}

<!-- Scroll-to-bottom button — fades in when user scrolls up -->
<div
  class="absolute right-4 z-10 pointer-events-none transition-all duration-200"
  style="bottom: calc(env(safe-area-inset-bottom, 0px) + 5.5rem);"
  class:opacity-0={isAtBottom}
  class:translate-y-2={isAtBottom}
>
  <button
    onclick={onScrollToBottom}
    class="pointer-events-auto w-9 h-9 rounded-full bg-base-200/85 backdrop-blur-md border border-base-content/15 shadow-lg shadow-black/25 flex items-center justify-center text-base-content/55 hover:text-base-content hover:border-primary/40 transition-colors"
    aria-label="Scroll to bottom"
    tabindex={isAtBottom ? -1 : 0}
    ><svg
      class="w-4 h-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"><path d="M12 5v14m0 0-7-7m7 7 7-7"></path></svg
    >
  </button>
</div>
