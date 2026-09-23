<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Loader from '@lucide/svelte/icons/loader';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Check from '@lucide/svelte/icons/check';
  import type { UIMessage } from '#lib/client-messages.js';
  import { highlightCode } from '#lib/markdown.js';
  import { getToolLang, getToolRowData, messageElementId } from './message-row-helpers.ts';
  import LiveElapsed from '#lib/components/chat/live-elapsed.svelte';

  let {
    msg,
    isNewest,
    isMobile,
    onToggleTool,
  }: {
    msg: UIMessage;
    isNewest: boolean;
    isMobile: boolean;
    onToggleTool: (msg: UIMessage) => void;
  } = $props();

  let tool = $derived(getToolRowData(msg));
  let meta = $derived(tool.meta);
  let messageLabelId = $derived(messageElementId('tool-label', msg.id));
  let outputToggleId = $derived(messageElementId('tool-toggle', msg.id));
  let outputPanelId = $derived(messageElementId('tool-output', msg.id));

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
</script>

<div
  id={messageElementId('tool', msg.id)}
  role="group"
  aria-labelledby={messageLabelId}
  class="flex flex-col trace-step tool-step"
  class:msg-in={isNewest}
>
  <span id={messageLabelId} class="sr-only">{meta.label} tool message</span>
  <!-- Flat flex row: [status][icon][label][detail][time] -->
  <button
    id={outputToggleId}
    type="button"
    onclick={() => {
      if (tool.hasOutput) onToggleTool(msg);
    }}
    class="trace-row trace-row-toggle font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 {!tool.hasOutput &&
    !msg.streaming
      ? 'cursor-default'
      : ''}"
    aria-expanded={Boolean(msg.expanded)}
    aria-controls={outputPanelId}
    aria-label="{msg.expanded ? 'Collapse' : 'Expand'} {meta.label} output"
  >
    {#if msg.streaming || msg.outputLoading}
      <Loader class="w-2.5 h-2.5 flex-shrink-0 animate-spin" style="opacity:0.5" />
    {:else if msg.isError}
      <CircleX class="w-2.5 h-2.5 flex-shrink-0 text-destructive/70" />
    {:else if tool.hasOutput}
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
      style="color:{meta.color};{msg.streaming ? 'animation:pulse 1.5s ease-in-out infinite' : ''}"
    />
    <!-- Label / detail (extension-rendered if available) -->
    {#if msg.renderedCallHtml}
      <span class="trace-row-label trace-row-call font-normal"
        >{#each msg.renderedCallHtml as line, i (i)}{#if i > 0}<br />{/if}{@html line}{/each}</span
      >
    {:else}
      <span class="trace-row-label">{tool.meta.label}</span>
      <span class="trace-row-detail">{tool.detail}</span>
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
  <div
    id={outputPanelId}
    role="region"
    aria-labelledby={outputToggleId}
    hidden={!msg.expanded || msg.streaming}
  >
    {#if msg.outputLoading}
      <div
        class="trace-output mt-1 flex items-center gap-2 text-xs text-base-content/45 italic py-1.5 px-2"
      >
        <Loader class="w-3 h-3 flex-shrink-0 animate-spin" style="opacity:0.6" />
        <span
          >Loading full output{#if msg.outputBytes}
            <span class="text-base-content/35">({msg.outputBytes.toLocaleString()} chars)</span
            >{/if}…</span
        >
      </div>
    {:else if msg.renderedResultHtml}
      <div
        class="trace-output mt-1 text-xs leading-relaxed select-text py-1.5 px-2 bg-base-content/[0.025] rounded-r font-mono"
      >
        {#each msg.renderedResultHtml as line, i (i)}<div>
            {@html line || '&nbsp;'}
          </div>{/each}
      </div>
    {:else}
      {#if msg.diff}
        <div class="trace-output mt-1">
          {#await import('#lib/components/diff-viewer.svelte') then { default: DiffViewer }}
            <DiffViewer diff={msg.diff} />
          {/await}
        </div>
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
              type="button"
              onclick={() => copyToolOutput(msg.content, msg.id)}
              class="min-w-11 min-h-11 flex-shrink-0 sm:min-w-0 sm:min-h-0 {isMobile
                ? 'px-2'
                : 'px-1.5 py-0.5'} rounded text-[10px] text-base-content/40 hover:text-base-content/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 hover:bg-base-content/[0.06] backdrop-blur-sm"
              aria-label="Copy output"
            >
              {toolCopiedId === msg.id ? 'copied' : 'copy'}
            </button>
            <button
              type="button"
              onclick={() => downloadToolOutput(msg.content, msg.toolName ?? 'output')}
              class="min-w-11 min-h-11 flex-shrink-0 sm:min-w-0 sm:min-h-0 {isMobile
                ? 'px-2'
                : 'px-1.5 py-0.5'} rounded text-[10px] text-base-content/40 hover:text-base-content/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 hover:bg-base-content/[0.06] backdrop-blur-sm"
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
                type="button"
                onclick={() => downloadImage(src, idx)}
                class="min-w-11 min-h-11 flex-shrink-0 sm:min-w-0 sm:min-h-0 {isMobile
                  ? 'px-2'
                  : 'px-1.5 py-0.5'} absolute top-1 right-1 opacity-0 group-hover/img:opacity-100 group-focus-within/img:opacity-100 focus-visible:opacity-100 transition-opacity rounded text-[10px] bg-base-100/80 text-base-content/60 hover:text-base-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 border border-base-content/10 backdrop-blur-sm"
                aria-label="Download image"
                title="Download image">download</button
              >
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
