<script lang="ts">
  import Brain from '@lucide/svelte/icons/brain';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Loader from '@lucide/svelte/icons/loader';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Check from '@lucide/svelte/icons/check';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Cog from '@lucide/svelte/icons/cog';
  import Terminal from '@lucide/svelte/icons/terminal';
  import FileText from '@lucide/svelte/icons/file-text';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Search from '@lucide/svelte/icons/search';
  import List from '@lucide/svelte/icons/list';
  import Trash from '@lucide/svelte/icons/trash';
  import Send from '@lucide/svelte/icons/send';
  import X from '@lucide/svelte/icons/x';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Button } from '$lib/components/ui/button';
  import type { UIMessage } from '$lib/client-messages';
  import { renderMarkdown, highlightCode } from '$lib/markdown';
  import { formatRelativeDate as formatDate } from '$lib/utils';
  import DiffViewer from '$lib/components/diff-viewer.svelte';
  import ProjectPicker from '$lib/components/projects/project-picker.svelte';

  /** Precomputed turn-boundary map. For each assistant message, true = last assistant in its turn. */
  const isLastInTurnMap = $derived.by(() => {
    const map: Record<string, boolean> = {};
    let i = 0;
    while (i < messages.length) {
      if (messages[i].role === 'user') { i++; continue; }
      // Find end of this turn (next user message or end of array)
      const turnStart = i;
      while (i < messages.length && messages[i].role !== 'user') i++;
      const turnEnd = i;
      // Walk backward from turn end to find the last assistant message
      for (let j = turnEnd - 1; j >= turnStart; j--) {
        if (messages[j].role === 'assistant') {
          map[messages[j].id] = true;
          break;
        }
      }
    }
    return map;
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
    truncatedUserMsgs,
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
    now,
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
    now: number;
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
  } = $props();
  /** ID of message currently being edited, and its draft text */
  let editingId: string | null = $state(null);
  let editingText: string = $state('');

  function checkOverflow(node: HTMLElement, msgId: string) {
    const update = () => {
      if (!expandedUserMsgs[msgId]) {
        truncatedUserMsgs[msgId] = node.scrollHeight > node.clientHeight + 2;
      }
    };
    const ro = new ResizeObserver(update);
    ro.observe(node);
    update();
    return { destroy() { ro.disconnect(); } };
  }


  type ToolMetaEntry = { icon: typeof Cog; label: string; color: string };

  const toolMeta: Record<string, ToolMetaEntry> = {
    bash:         { icon: Terminal, label: 'Shell',  color: 'var(--color-info)' },
    execute_bash: { icon: Terminal, label: 'Shell',  color: 'var(--color-info)' },
    shell:        { icon: Terminal, label: 'Shell',  color: 'var(--color-info)' },
    read:         { icon: FileText, label: 'Read',   color: 'color-mix(in oklch, var(--color-base-content) 45%, transparent)' },
    read_file:    { icon: FileText, label: 'Read',   color: 'color-mix(in oklch, var(--color-base-content) 45%, transparent)' },
    cat:          { icon: FileText, label: 'Read',   color: 'color-mix(in oklch, var(--color-base-content) 45%, transparent)' },
    write:        { icon: Pencil, label: 'Write',  color: 'var(--color-success)' },
    write_file:   { icon: Pencil, label: 'Write',  color: 'var(--color-success)' },
    edit:         { icon: Pencil, label: 'Edit',   color: 'var(--color-success)' },
    grep:         { icon: Search, label: 'Search', color: 'var(--color-secondary)' },
    find:         { icon: Search, label: 'Find',   color: 'var(--color-secondary)' },
    ls:           { icon: List,   label: 'List',   color: 'var(--color-primary)' },
  };

  const HEURISTIC_ICONS: [RegExp, typeof Cog][] = [
    [/search|find|grep|query|lookup/i, Search],
    [/write|create|save|store|generate/i, Pencil],
    [/delete|remove|trash|drop/i, Trash],
    [/send|post|publish|deploy|push/i, Send],
    [/read|fetch|load|get|download/i, FileText],
    [/run|exec|shell|bash|spawn/i, Terminal],
    [/list|ls|dir|enumerate/i, List],
  ];

  function getToolMeta(name: string | undefined): ToolMetaEntry {
    const key = (name ?? '').toLowerCase();
    if (toolMeta[key]) return toolMeta[key];
    let icon = Cog;
    for (const [pattern, component] of HEURISTIC_ICONS) {
      if (pattern.test(key)) { icon = component; break; }
    }
    let label: string;
    if (key.includes('_') || key.includes('-')) {
      label = key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    } else {
      label = key.charAt(0).toUpperCase() + key.slice(1);
    }
    return { icon, label, color: 'var(--color-primary)' };
  }

  function getToolLang(toolName: string | undefined, toolInput: string | undefined): string {
    const name = (toolName ?? '').toLowerCase();
    if (['bash', 'execute_bash', 'shell'].includes(name)) return 'bash';
    if (['read', 'read_file', 'cat'].includes(name)) {
      const path = (toolInput ?? '').split(' ')[0];
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      const extMap: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
        py: 'python', sh: 'bash', bash: 'bash', json: 'json',
        yaml: 'yaml', yml: 'yaml', html: 'html', css: 'css', sql: 'sql',
        md: 'markdown', rs: 'rust', go: 'go', cs: 'csharp', svelte: 'html',
      };
      return extMap[ext] ?? '';
    }
    return '';
  }

  /** Strip leading '$ ' from shell command details — label already says "Shell". */
  function cleanDetail(detail: string): string {
    return detail.startsWith('$ ') ? detail.slice(2) : detail;
  }
  /** Track which tool output was recently copied (by msg id). */
  let toolCopiedId: string | null = $state(null);
  function copyToolOutput(content: string, id: string) {
    navigator.clipboard.writeText(content);
    toolCopiedId = id;
    setTimeout(() => { if (toolCopiedId === id) toolCopiedId = null; }, 1500);
  }
</script>

{#if sessionLoading}
  <div class="aurora min-h-full flex flex-col items-center justify-start gap-3 px-4 pt-8" role="status" aria-live="polite">
    {#each Array.from({ length: 14 }, (_, i) => i) as i (i)}
      <div class="flex {i % 2 === 0 ? 'justify-end' : 'justify-start'} w-full max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl mx-auto">
        <div class="skeleton-shimmer {i % 2 === 0 ? 'bg-base-content/[0.06] rounded-2xl rounded-br-md w-3/5 h-10' : 'bg-base-content/[0.04] rounded-2xl rounded-bl-md w-4/5 h-16'}"></div>
      </div>
    {/each}
  </div>
{:else if messages.length === 0 && wsState === 'connecting'}
  <div class="aurora min-h-full flex flex-col items-center justify-center gap-4 select-none pointer-events-none">
    <span class="pi-glyph pi-glyph-breathe text-8xl font-light leading-none">π</span>
    <p class="text-sm text-base-content/50 tracking-wide">connecting…</p>
  </div>
{:else if messages.length === 0 && wsState === 'open' && !sessionId}
  <div class="aurora min-h-full flex flex-col items-center justify-center gap-4 select-none pointer-events-none">
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
        <span>{activeProjectName ? `working in ${activeProjectName}` : 'start a conversation'}</span>
        <svg class="w-3 h-3 transition-transform duration-150 {projectPickerOpen ? 'rotate-180' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
    </div>
    {#if projectPickerOpen}
      <ProjectPicker onClose={onProjectPickerClose} />
    {/if}
    <div class="flex flex-wrap justify-center gap-2 mt-1 max-w-sm pointer-events-auto">
      <button onclick={() => onInsertShortcut('/session ')} class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-primary hover:border-primary/35 hover:bg-primary/[0.06] transition-all duration-150 hover:-translate-y-px">/session</button>
      <button onclick={() => onInsertShortcut('! ')} class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-secondary hover:border-secondary/35 hover:bg-secondary/[0.06] transition-all duration-150 hover:-translate-y-px">! run a command</button>
      {#if activeProjectName}
        <button onclick={() => onInsertShortcut('#review ')} class="px-3 py-1.5 text-xs rounded-full border border-base-content/10 bg-base-content/[0.03] text-base-content/50 hover:text-accent hover:border-accent/35 hover:bg-accent/[0.06] transition-all duration-150 hover:-translate-y-px">#review</button>
      {/if}
    </div>
  </div>
{:else}
  <div class="w-full max-w-3xl lg:max-w-5xl xl:max-w-6xl 2xl:max-w-7xl mx-auto px-4 md:px-6 flex flex-col gap-1">
    {#if messagesTruncated}
      <div class="flex items-center gap-3 py-2 select-none" aria-live="polite">
        <span class="flex-1 h-px bg-gradient-to-r from-transparent via-base-content/12 to-transparent"></span>
        <button
          onclick={onLoadOlder}
          disabled={totalRawMessagesLoaded >= totalMessageCount}
          class="shrink-0 text-[11px] transition-colors px-3 py-1 rounded-full border bg-base-content/[0.02] {totalRawMessagesLoaded >= totalMessageCount ? 'text-base-content/15 border-base-content/5 cursor-default' : 'text-base-content/35 hover:text-primary border-base-content/8 hover:border-primary/25 hover:bg-primary/[0.04]'}"
        >
          {#if totalRawMessagesLoaded >= totalMessageCount}
            <span>All messages loaded</span>
          {:else}
            Load {Math.min(50, totalMessageCount - totalRawMessagesLoaded).toLocaleString()} older ({totalMessageCount - totalRawMessagesLoaded} remaining)
          {/if}
        </button>
        <span class="flex-1 h-px bg-gradient-to-r from-transparent via-base-content/12 to-transparent"></span>
      </div>
    {/if}

    {#each messages as msg (msg.id)}

      <!-- ── User message ───────────────────────────────────────────────── -->
      {#if msg.role === 'user'}
        {@const isExpanded = expandedUserMsgs[msg.id] ?? false}
        <div class="group msg-in sticky top-0 z-20 bg-base-100 relative pt-2 -mx-4 md:-mx-6">
          <div class="absolute bottom-0 left-0 right-0 h-5 bg-gradient-to-b from-base-100 to-transparent pointer-events-none"></div>
          <div class="flex justify-end px-4 md:px-6">
          <div class="max-w-[82%] space-y-0.5">
            <div class="bg-[color-mix(in_oklch,var(--color-primary)_11%,transparent)] border border-primary/[0.08] rounded-2xl rounded-br-md px-3.5 py-2.5 space-y-1">
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
                    }}
                  >{editingText}</textarea>
                  <div class="flex items-center gap-2 mt-1">
                    <button
                      onclick={() => {
                        if (editingText.trim() && editingText !== msg.content) {
                          onEditMessage(msg.content, editingText.trim());
                        }
                        editingId = null;
                      }}
                      class="text-[10px] text-primary/70 hover:text-primary transition-colors select-none"
                    >resend</button>
                    <button
                      onclick={() => { editingId = null; }}
                      class="text-[10px] text-base-content/30 hover:text-base-content/55 transition-colors select-none"
                    >cancel</button>
                  </div>
                {:else}
                  <button
                    type="button"
                    use:checkOverflow={msg.id}
                    class="w-full appearance-none bg-transparent border-0 p-0 text-left whitespace-pre-wrap break-words leading-relaxed text-base-content/90 select-text {isExpanded ? 'block' : 'line-clamp-3'}"
                    onclick={() => { if (truncatedUserMsgs[msg.id] || isExpanded) onExpandUserMsg(msg.id, !isExpanded); }}
                    aria-expanded={isExpanded}
                  >{msg.content}</button>
                  {#if truncatedUserMsgs[msg.id] || isExpanded}
                    <button
                      onclick={() => onExpandUserMsg(msg.id, !isExpanded)}
                      class="text-[10px] text-base-content/30 hover:text-base-content/55 transition-colors select-none"
                    >{isExpanded ? 'show less' : 'show more'}</button>
                  {/if}
                {/if}
              {/if}
            </div>
            <div class="flex justify-end items-center gap-1 {isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} transition-opacity duration-150">
              <span class="text-[10px] text-base-content/45">{formatDate(msg.createdAt)}</span>
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      onclick={() => onCopyMessage(msg)}
                      class="flex items-center justify-center w-7 h-7 text-base-content/25 hover:text-base-content/55 rounded transition-colors select-none cursor-pointer"
                      aria-label="Copy message"
                    >{#if copiedId === msg.id}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>{:else}<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>{/if}</button>
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
                        onclick={() => { editingId = msg.id; editingText = msg.content; }}
                        class="flex items-center justify-center w-7 h-7 text-base-content/25 hover:text-base-content/55 rounded transition-colors select-none cursor-pointer"
                        aria-label="Edit message"
                      ><svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg></button>
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
        {@const isLastInTurn = isLastInTurnMap[msg.id] ?? false}
        <div class="group msg-in trace-step">
          {#if msg.streaming}
            {#if msg.thinking && msg.thinking.length > 0}
              <!-- Streaming thinking: flat flex row -->
              <div class="trace-row">
                <Brain class="w-3.5 h-3.5 flex-shrink-0" style="color:var(--color-secondary);animation:pulse 1.5s ease-in-out infinite" />
                <span class="trace-row-label italic shimmer-text">{hiddenThinkingLabel}</span>
                <span class="trace-row-detail italic">{msg.thinking.slice(0, 120)}{msg.thinking.length > 120 ? '…' : ''}</span>
              </div>
            {:else if !msg.content}
              <!-- Waiting/loading: flat flex row -->
              <div class="trace-row">
                <Loader class="w-3 h-3 flex-shrink-0 animate-spin" style="color:var(--color-secondary);opacity:0.6" />
                <span class="trace-row-label italic shimmer-text">{hiddenThinkingLabel}</span>
                <span class="trace-row-detail italic">…</span>
              </div>
            {/if}
          {:else if msg.thinking}
            {#if msg.content}
              <!-- Collapsed thinking toggle: flat flex row -->
              <button onclick={() => onToggleThinking(msg)} class="trace-row trace-row-toggle mb-5" aria-expanded={msg.thinkingExpanded}>
                <ChevronRight class="w-2.5 h-2.5 flex-shrink-0 transition-transform duration-150 {msg.thinkingExpanded ? 'rotate-90' : ''}" style="color:color-mix(in oklch, var(--color-base-content) 28%, transparent)" />
                <Brain class="w-3.5 h-3.5 flex-shrink-0" style="color:var(--color-secondary)" />
                <span class="trace-row-label italic">{hiddenThinkingLabel}</span>
                <span class="trace-row-detail italic">{msg.thinking.slice(0, 120)}{msg.thinking.length > 120 ? '…' : ''}</span>
                <span class="trace-row-time">
                  {#if msg.endMs && msg.thinkingStartMs}{Math.round((msg.endMs - msg.thinkingStartMs) / 1000)}s{/if}
                </span>
              </button>
            {:else}
              <!-- Thinking-only message: render as prose -->
              <div class="trace-body prose text-base-content/80 text-sm leading-relaxed">{@html msg.renderedThinking ?? renderMarkdown(msg.thinking)}</div>
            {/if}
          {/if}

          {#if msg.thinkingExpanded && msg.thinking && msg.content}
            <div class="trace-output text-[11px] text-base-content/55 max-h-56 overflow-y-auto leading-relaxed bg-base-content/[0.03] rounded-r px-3 py-2 mb-4 select-text prose prose-sm">{@html msg.renderedThinking ?? renderMarkdown(msg.thinking)}</div>
          {/if}

          {#if msg.content || msg.streaming}
            <div class="trace-body leading-relaxed select-text">
              {#if !msg.content && msg.streaming}
                {#if workingVisible && !(msg.thinking && msg.thinking.length > 0)}
                  <span class="flex items-center gap-1.5 h-5" aria-label={hiddenThinkingLabel}>
                    {#if workingIndicatorFrames.length > 0}
                      <span class="text-base-content/60 text-sm font-mono">{workingIndicatorFrames[workingFrameIndex]}</span>
                    {:else}
                      <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
                    {/if}
                    {#if workingMessage}<span class="ml-2 text-base-content/40 text-xs">{workingMessage}</span>{/if}
                  </span>
                {/if}
              {:else if msg.aborted}
                <div class="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-warning/10 text-warning text-sm font-medium">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {msg.content}
                </div>
              {:else}
                <div class="prose text-base-content/90">{@html msg.renderedContent ?? renderMarkdown(msg.content)}</div>
                {#if msg.images?.length}
                  <div class="flex gap-2 flex-wrap mt-2">
                    {#each msg.images as src (src)}<img {src} alt="" class="max-h-64 max-w-full rounded-lg object-contain border border-base-content/10" />{/each}
                  </div>
                {/if}
                {#if msg.streaming}<span class="text-primary animate-pulse">▌</span>{/if}
              {/if}
            </div>
          {/if}

          <!-- Bottom action bar -->
          {#if !msg.streaming}
            <div class="trace-meta flex items-center gap-1.5 text-[10px] pt-1.5 mt-1 border-t border-base-content/[0.07] select-none {isMobile ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'} transition-opacity duration-150">
              <!-- Copy button — left side -->
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props })}
                    <button
                      {...props}
                      onclick={() => onCopyMessage(msg)}
                      class="flex items-center justify-center w-5 h-5 text-base-content/35 hover:text-base-content/65 rounded transition-colors cursor-pointer"
                      aria-label="Copy message"
                    >
                      {#if copiedId === msg.id}
                        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>
                      {:else}
                        <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
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
                        class="flex items-center justify-center w-5 h-5 text-base-content/35 hover:text-base-content/65 rounded transition-colors cursor-pointer"
                        aria-label="Copy turn"
                      >
                        {#if copiedTurnId === msg.id}
                          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m20 6-11 11-5-5"/></svg>
                        {:else}
                          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/><path d="M9 15v4a2 2 0 0 0 2 2h4"/></svg>
                        {/if}
                      </button>
                    {/snippet}
                  </Tooltip.Trigger>
                  <Tooltip.Content>Copy all responses in this turn</Tooltip.Content>
                </Tooltip.Root>
              {/if}
              <!-- Metrics — right side -->
              <span class="ml-auto flex items-center gap-2 text-base-content/55">
                {#if msg.usage}<span class="tabular-nums">{msg.usage.totalTokens >= 1000 ? (msg.usage.totalTokens / 1000).toFixed(1) + 'k' : msg.usage.totalTokens}t</span>{/if}
                {#if msg.usage?.cost?.total}<span class="tabular-nums">{msg.usage.cost.total < 0.0001 ? '<$0.0001' : `$${msg.usage.cost.total.toFixed(4)}`}</span>{/if}
                {#if msg.endMs && msg.startMs}<span class="tabular-nums">{msg.endMs - msg.startMs < 1000 ? `${msg.endMs - msg.startMs}ms` : `${((msg.endMs - msg.startMs) / 1000).toFixed(1)}s`}</span>{/if}
                <span>{formatDate(msg.createdAt)}</span>
              </span>
            </div>
          {/if}
        </div>

      <!-- ── Tool call ─────────────────────────────────────────────────── -->
      {:else if msg.role === 'tool'}
        {@const meta = getToolMeta(msg.toolName)}
        {@const detail = cleanDetail(msg.toolInput ?? '')}
        {@const hasOutput = !!(msg.content || msg.diff || msg.images?.length || msg.renderedResultHtml?.length)}
        <div class="msg-in flex flex-col trace-step tool-step">
          <!-- Flat flex row: [status][icon][label][detail][time] -->
          <button
            onclick={() => { if (hasOutput) onToggleTool(msg); }}
            class="trace-row trace-row-toggle font-mono {!hasOutput && !msg.streaming ? 'cursor-default' : ''}"
            disabled={!hasOutput && !msg.streaming}
          >
            <!-- Status: chevron (expandable) | spinner (streaming) | check | error -->
            {#if msg.streaming}
              <Loader class="w-2.5 h-2.5 flex-shrink-0 animate-spin" style="opacity:0.5" />
            {:else if msg.isError}
              <CircleX class="w-2.5 h-2.5 flex-shrink-0 text-destructive/70" />
            {:else if hasOutput}
              <ChevronRight class="w-2.5 h-2.5 flex-shrink-0 transition-transform duration-150 {msg.expanded ? 'rotate-90' : ''}" style="color:color-mix(in oklch, var(--color-base-content) 28%, transparent)" />
            {:else}
              <Check class="w-2.5 h-2.5 flex-shrink-0 text-success/50" />
            {/if}
            <!-- Tool icon -->
            <meta.icon class="w-3.5 h-3.5 flex-shrink-0" style="color:{meta.color};{msg.streaming ? 'animation:pulse 1.5s ease-in-out infinite' : ''}" />
            <!-- Label / detail (extension-rendered if available) -->
            {#if msg.renderedCallHtml}
              <span class="trace-row-label font-normal">{#each msg.renderedCallHtml as line, i (i)}{#if i > 0}<br />{/if}{@html line}{/each}</span>
            {:else}
              <span class="trace-row-label">{meta.label}</span>
              <span class="trace-row-detail">{detail}</span>
            {/if}
            <!-- Time + line count -->
            <span class="trace-row-time">
              {#if msg.streaming && msg.startMs}{Math.floor((now - msg.startMs) / 1000)}s
              {:else if msg.endMs && msg.startMs}{((msg.endMs - msg.startMs) / 1000).toFixed(1)}s{/if}
              {#if msg.lineCount !== undefined}<span>{msg.lineCount}L</span>{/if}
              {#if msg.images?.length}<span>{msg.images.length}img</span>{/if}
            </span>
          </button>
          {#if msg.expanded && !msg.streaming}
            {#if msg.renderedResultHtml}
              <div class="trace-output mt-1 text-xs leading-relaxed select-text py-1.5 px-2 bg-base-content/[0.025] rounded-r font-mono">
                {#each msg.renderedResultHtml as line, i (i)}<div>{@html line || '&nbsp;'}</div>{/each}
              </div>
            {:else}
            {#if msg.diff}
              <div class="trace-output mt-1"><DiffViewer diff={msg.diff} /></div>
            {:else if msg.content}
              {@const toolLang = getToolLang(msg.toolName, msg.toolInput)}
              <div class="relative group/copy mt-1">
                {#if toolLang}
                  <pre class="trace-output text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed select-text py-1.5 bg-base-content/[0.025] rounded-r pr-8"><code class="hljs">{@html highlightCode(msg.content, toolLang)}</code></pre>
                {:else}
                  <pre class="trace-output text-base-content/58 text-xs whitespace-pre-wrap break-words max-h-56 overflow-y-auto leading-relaxed select-text py-1.5 bg-base-content/[0.025] rounded-r pr-8">{msg.content}</pre>
                {/if}
                <button onclick={() => copyToolOutput(msg.content, msg.id)} class="absolute top-1.5 right-1.5 opacity-0 group-hover/copy:opacity-100 group-focus-within/copy:opacity-100 transition-opacity duration-150 px-1.5 py-0.5 rounded text-[10px] text-base-content/40 hover:text-base-content/70 hover:bg-base-content/[0.06] backdrop-blur-sm" aria-label="Copy output">
                  {toolCopiedId === msg.id ? 'copied' : 'copy'}
                </button>
              </div>
            {/if}
            {#if msg.images?.length}
              <div class="trace-output flex gap-2 flex-wrap mt-2">
                {#each msg.images as src (src)}<img {src} alt="" class="max-h-64 max-w-full rounded-lg object-contain border border-base-content/10" />{/each}
              </div>
            {/if}
          {/if}
          {/if}
        </div>


      <!-- ── Diagnostic ───────────────────────────────────────────────── -->
      {:else if msg.role === 'diagnostic'}
        <div class="msg-in my-1.5">
          <div
            class="rounded-xl border-l-4 px-3.5 py-2.5 text-sm leading-relaxed select-text {(!msg.level || msg.level === 'info') ? 'border-info bg-info/[0.03]' : ''} {msg.level === 'warning' ? 'border-warning bg-warning/[0.04]' : ''} {msg.level === 'error' ? 'border-error bg-error/[0.04]' : ''} {msg.level === 'success' ? 'border-success bg-success/[0.04]' : ''}"
          >
            <div class="flex items-center gap-2 mb-1">
              {#if msg.level === 'warning'}
                <span class="text-[10px] uppercase tracking-[0.12em] font-semibold text-warning/70">Warning</span>
              {:else if msg.level === 'error'}
                <span class="text-[10px] uppercase tracking-[0.12em] font-semibold text-destructive/70">Error</span>
              {:else if msg.level === 'success'}
                <span class="text-[10px] uppercase tracking-[0.12em] font-semibold text-success/70">Success</span>
              {:else}
                <span class="text-[10px] uppercase tracking-[0.12em] font-semibold text-info/70">Info</span>
              {/if}
              {#if msg.source}
                <span class="text-[10px] text-base-content/35 font-mono">{msg.source}</span>
              {/if}
              <span class="flex-1"></span>
              <span class="text-[10px] text-base-content/45">{formatDate(msg.createdAt)}</span>
            </div>
            <div class="prose prose-sm text-base-content/85">{@html renderMarkdown(msg.content)}</div>
            {#if msg.details}
              <button
                onclick={() => msg.expanded = !msg.expanded}
                class="mt-1.5 text-[10px] text-base-content/40 hover:text-base-content/70 transition-colors select-none cursor-pointer"
              >
                {msg.expanded ? '▾ less' : '▸ more'}
              </button>
              {#if msg.expanded}
                <div class="mt-1.5 text-xs text-base-content/50 whitespace-pre-wrap leading-relaxed px-2 py-1.5 bg-base-content/[0.04] rounded">{@html renderMarkdown(msg.details)}</div>
              {/if}
            {/if}
          </div>
        </div>

      <!-- ── Notice ────────────────────────────────────────────────────── -->
      {:else if msg.role === 'notice'}
        {#if msg.noticeKind === 'toast'}
          <div class="msg-in my-1.5 flex items-start gap-2.5">
            <div
              class="flex-1 rounded-xl border-l-4 px-3.5 py-2.5 text-sm leading-relaxed select-text {(!msg.level || msg.level === 'info') ? 'border-info bg-info/[0.03]' : ''} {msg.level === 'warning' ? 'border-warning bg-warning/[0.04]' : ''} {msg.level === 'error' ? 'border-error bg-error/[0.04]' : ''}"
            >
              <div class="flex items-center gap-2">
                <span class="flex-1 text-base-content/85">{msg.content}</span>
                <span class="text-[10px] text-base-content/40 shrink-0">{formatDate(msg.createdAt)}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  class="shrink-0 -my-1"
                  onclick={() => onDismissNotice(msg.id)}
                  aria-label="Dismiss"
                ><X class="w-3.5 h-3.5" /></Button>
              </div>
            </div>
          </div>
        {:else if msg.customType === 'slash_result'}
          <div class="msg-in my-2 px-4 py-3 bg-base-content/[0.04] border border-base-content/[0.06] rounded-xl font-mono text-[11px] leading-relaxed text-base-content/70 whitespace-pre-wrap break-words overflow-hidden select-text shadow-inner shadow-black/5">{msg.content}</div>
        {:else if msg.renderedNoticeHtml}
          <div class="msg-in my-2 px-4 py-3 bg-base-content/[0.04] border border-base-content/[0.06] rounded-xl font-mono text-[11px] leading-relaxed text-base-content/70 whitespace-pre-wrap break-words overflow-hidden select-text shadow-inner shadow-black/5">
            {#each msg.renderedNoticeHtml as line, i (i)}<div>{@html line || '&nbsp;'}</div>{/each}
          </div>
        {:else}
          <div class="msg-in flex items-center gap-2.5 text-[10px] text-base-content/45 select-none py-1">
            <span class="flex-1 h-px bg-gradient-to-r from-transparent to-base-content/15"></span>
            <span class="flex items-center gap-1 shrink-0">
              {#if msg.streaming}
                <svg class="w-2 h-2 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              {:else if msg.noticeKind === 'compaction'}
                <Sparkles class="w-2.5 h-2.5" aria-hidden="true" />
              {:else if msg.noticeKind === 'retry'}
                <svg class="w-2 h-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              {:else if msg.noticeKind === 'custom'}
                <span class="w-2 h-2 rounded-full bg-secondary inline-block"></span>
              {/if}
              <span>{msg.content}</span>
            </span>
            <span class="flex-1 h-px bg-gradient-to-l from-transparent to-base-content/15"></span>
          </div>
        {/if}
      {/if}
    {/each}
  </div>
{/if}
