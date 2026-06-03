<script lang="ts">
  import { highlightCode } from '$lib/markdown';

  const {
    open,
    path,
    line,
    content,
    loading,
    error,
    onclose,
    oninsert,
  }: {
    open: boolean;
    path: string;
    line?: number;
    content: string;
    loading: boolean;
    error: string | null;
    onclose: () => void;
    oninsert: () => void;
  } = $props();

  let copied = $state(false);
  let contentEl = $state<HTMLElement | undefined>(undefined);

  // Detect language from file extension
  const lang = $derived.by(() => {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', sh: 'bash', bash: 'bash', json: 'json',
      yaml: 'yaml', yml: 'yaml', html: 'html', xml: 'xml',
      css: 'css', sql: 'sql', md: 'markdown', rs: 'rust',
      go: 'go', cs: 'csharp', svelte: 'html',
    };
    return map[ext] ?? '';
  });

  // Scroll to target line when content loads
  $effect(() => {
    if (content && line && contentEl) {
      // Find the target line element
      const timer = setTimeout(() => {
        const lineEl = contentEl?.querySelector(`[data-line="${line}"]`);
        if (lineEl) {
          lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          lineEl.classList.add('highlight-line');
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  });

  function handleCopy() {
    navigator.clipboard.writeText(content);
    copied = true;
    setTimeout(() => { copied = false; }, 1500);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') onclose();
  }

  const lines = $derived(content ? content.split('\n') : []);
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onclick={onclose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="file-viewer-modal bg-base-100 border border-base-content/10 rounded-xl shadow-2xl flex flex-col max-h-[85vh] w-full max-w-3xl mx-4"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Header -->
      <div class="flex items-center gap-3 px-4 py-2.5 border-b border-base-content/8">
        <svg class="w-4 h-4 text-base-content/40 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>
        </svg>
        <span class="text-sm font-medium truncate flex-1 min-w-0">{path}</span>
        {#if line}
          <span class="text-xs text-base-content/40 shrink-0">:{line}</span>
        {/if}
        <div class="flex items-center gap-1.5 ml-auto shrink-0">
          <button
            class="px-2 py-1 text-xs rounded-md text-base-content/60 hover:text-base-content hover:bg-base-content/8 transition-colors"
            onclick={handleCopy}
          >
            {#if copied}Copied{:else}Copy{/if}
          </button>
          <button
            class="px-2 py-1 text-xs rounded-md text-primary/70 hover:text-primary hover:bg-primary/10 transition-colors"
            onclick={oninsert}
          >
            Insert @file
          </button>
          <button
            class="ml-1 p-1 rounded-md text-base-content/40 hover:text-base-content hover:bg-base-content/8 transition-colors"
            onclick={onclose}
            aria-label="Close"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      </div>

      <!-- Content -->
      <div class="flex-1 overflow-auto min-h-0" bind:this={contentEl}>
        {#if loading}
          <div class="flex items-center justify-center py-16 text-base-content/30">
            <svg class="w-5 h-5 animate-spin mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
            </svg>
            Loading…
          </div>
        {:else if error}
          <div class="flex items-center justify-center py-16 text-error/60 text-sm">
            {error}
          </div>
        {:else}
          <div class="file-content font-mono text-xs leading-[1.5] select-text">
            {#each lines as contentLine, i (i)}
              {@const lineNum = i + 1}
              <div
                class="file-line"
                class:target-line={line && lineNum === line}
                data-line={lineNum}
              >
                <span class="line-number">{lineNum}</span>
                {#if lang}
                  <span class="line-text">{@html highlightCode(contentLine, lang)}</span>
                {:else}
                  <span class="line-text">{contentLine}</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .file-viewer-modal {
    max-height: 85vh;
  }

  .file-content {
    padding: 0.5rem 0;
  }

  .file-line {
    display: flex;
    padding: 0 1rem;
    min-height: 1.375rem;
    transition: background 0.2s;
  }

  .file-line:hover {
    background: color-mix(in oklch, var(--color-base-content) 4%, transparent);
  }

  .file-line.target-line {
    background: color-mix(in oklch, var(--color-info) 15%, transparent);
    border-left: 2px solid var(--color-info);
    padding-left: calc(1rem - 2px);
  }

  .line-number {
    width: 3rem;
    min-width: 3rem;
    text-align: right;
    padding-right: 1rem;
    color: color-mix(in oklch, var(--color-base-content) 25%, transparent);
    user-select: none;
    font-size: 0.625rem;
    line-height: inherit;
  }

  .line-text {
    flex: 1;
    min-width: 0;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
