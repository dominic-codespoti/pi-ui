<script lang="ts">
  import { highlightCode } from '$lib/markdown';
  import * as Dialog from '$lib/components/ui/dialog';

  const {
    open,
    path,
    line,
    content,
    loading,
    error,
    onclose,
    oninsert,
    onsave,
    saving,
  }: {
    open: boolean;
    path: string;
    line?: number;
    content: string;
    loading: boolean;
    error: string | null;
    onclose: () => void;
    oninsert: () => void;
    onsave?: (content: string) => void;
    saving?: boolean;
  } = $props();

  let copied = $state(false);
  let editing = $state(false);
  let editContent = $state('');
  let contentEl = $state<HTMLElement | undefined>(undefined);
  let didSave = $state(false);

  /** Whether unsaved edits exist (content differs from editContent). */
  const hasUnsaved = $derived(editing && editContent !== content);

  function startEdit() {
    editContent = content;
    editing = true;
  }

  function cancelEdit() {
    editing = false;
    editContent = '';
  }

  function saveEdit() {
    onsave?.(editContent);
  }

  // Close edit mode only after a true save transition (false→true→false).
  // Ignores the initial saving=false on mount.
  $effect(() => {
    if (saving) didSave = true;
    if (didSave && !saving && editing) {
      editing = false;
      editContent = '';
    }
  });

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
    if (content && line && contentEl && !editing) {
      const timer = setTimeout(() => {
        const lineEl = contentEl?.querySelector(`[data-line="${line}"]`);
        if (lineEl) {
            if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
              lineEl.scrollIntoView({ block: 'center' });
            } else {
              lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
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

  function requestClose() {
    if (hasUnsaved) {
      if (!confirm('Discard unsaved changes?')) return;
    }
    onclose();
  }

  /** Escape / outside-click — route through the unsaved-changes guard instead of bits-ui's default close. */
  function interceptClose(e: Event) {
    e.preventDefault();
    requestClose();
  }

  const lines = $derived(content ? content.split('\n') : []);
  const FILE_LINE_LIMIT = 1000;
  const linesTruncated = $derived(lines.length > FILE_LINE_LIMIT);
  const visibleLines = $derived(linesTruncated ? lines.slice(0, FILE_LINE_LIMIT) : lines);
</script>

<Dialog.Root {open}>
  <Dialog.Content
    class="file-viewer-modal bg-base-100 border border-base-content/10 rounded-xl shadow-2xl flex flex-col max-h-[85vh] w-full sm:max-w-3xl p-0 gap-0"
    showCloseButton={false}
    onEscapeKeydown={interceptClose}
    onInteractOutside={interceptClose}
  >
    <Dialog.Description class="sr-only">File contents viewer</Dialog.Description>
      <!-- Header -->
      <div class="flex items-center gap-3 px-4 py-2.5 border-b border-base-content/8">
        <svg class="w-4 h-4 text-base-content/40 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>
        </svg>
        <Dialog.Title class="text-sm leading-normal font-medium truncate flex-1 min-w-0">{path}</Dialog.Title>
        {#if line}
          <span class="text-xs text-base-content/40 shrink-0">:{line}</span>
        {/if}
        <div class="flex items-center gap-1.5 ml-auto shrink-0">
          {#if editing}
            <button
              class="px-2 py-1 text-xs rounded-md text-base-content/60 hover:text-base-content hover:bg-base-content/8 transition-colors"
              onclick={cancelEdit}
            >Cancel</button>
            <button
              class="px-2 py-1 text-xs rounded-md text-success/80 hover:text-success hover:bg-success/10 transition-colors"
              onclick={saveEdit}
              disabled={saving}
            >{#if saving}saving…{:else}Save{/if}</button>
          {:else}
            <button
              class="px-2 py-1 text-xs rounded-md text-base-content/60 hover:text-base-content hover:bg-base-content/8 transition-colors"
              onclick={handleCopy}
            >
              {#if copied}Copied{:else}Copy{/if}
            </button>
            <button
              class="px-2 py-1 text-xs rounded-md text-primary/70 hover:text-primary hover:bg-primary/10 transition-colors"
              onclick={oninsert}
            >Insert @file</button>
            <button
              class="px-2 py-1 text-xs rounded-md text-warning/70 hover:text-warning hover:bg-warning/10 transition-colors"
              onclick={startEdit}
            >Edit</button>
            <button
              class="ml-1 p-1 rounded-md text-base-content/40 hover:text-base-content hover:bg-base-content/8 transition-colors"
              onclick={requestClose}
              aria-label="Close"
            >
              <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          {/if}
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
        {:else if editing}
          <textarea
            class="w-full h-full min-h-[50vh] bg-transparent border-0 outline-none p-4 font-mono text-xs leading-relaxed resize-none"
            bind:value={editContent}
          ></textarea>
        {:else}
          <div class="file-content font-mono text-xs leading-[1.5] select-text">
            {#each visibleLines as contentLine, i (i)}
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
            {#if linesTruncated}
              <div class="px-4 py-2 text-[10px] text-base-content/40 italic">
                File exceeds {FILE_LINE_LIMIT} lines — only the first {FILE_LINE_LIMIT.toLocaleString()} are shown.
              </div>
            {/if}
          </div>
        {/if}
      </div>
  </Dialog.Content>
</Dialog.Root>

<style>
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
