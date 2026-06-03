<script lang="ts">
  import { highlightCode } from '$lib/markdown';
  import { parseDiff } from '$lib/diff-parser';
  import { SvelteSet } from 'svelte/reactivity';

  const { diff }: { diff: string } = $props();

  const parsed = $derived(parseDiff(diff));
  const totalAdditions = $derived(parsed.reduce((s, f) => s + f.additions, 0));
  const totalDeletions = $derived(parsed.reduce((s, f) => s + f.deletions, 0));

  /** Set of expanded file paths (all expanded by default). */
  let expandedFiles = $state<Set<string>>(new SvelteSet());
  /** Copy feedback state. */
  let copied = $state(false);

  // Reset expanded state when diff changes
  $effect(() => {
    expandedFiles = new SvelteSet(parsed.map((f) => f.newPath));
  });

  function toggleFile(path: string) {
    const next = new SvelteSet(expandedFiles);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    expandedFiles = next;
  }

  function detectLang(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const map: Record<string, string> = {
      ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
      py: 'python', sh: 'bash', bash: 'bash', json: 'json',
      yaml: 'yaml', yml: 'yaml', html: 'html', xml: 'xml',
      css: 'css', sql: 'sql', md: 'markdown', rs: 'rust',
      go: 'go', cs: 'csharp', svelte: 'html',
    };
    return map[ext] ?? '';
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightLine(content: string, lang: string): string {
    if (!lang) return escapeHtml(content);
    try {
      // Highlight just this one line — wrap in the lang so hljs picks it up
      return highlightCode(content, lang);
    } catch {
      return escapeHtml(content);
    }
  }

  function copyDiff() {
    navigator.clipboard.writeText(diff);
    copied = true;
    setTimeout(() => { copied = false; }, 1500);
  }

  function truncateLabel(path: string): string {
    // Show last 2-3 path segments for long paths
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 3) return path;
    return `…/${parts.slice(-2).join('/')}`;
  }
</script>

<div class="diff-root text-xs font-mono">
  <!-- Header bar: stats + copy -->
  <div class="diff-header">
    <div class="flex items-center gap-3">
      <span class="text-base-content/50 font-sans text-[11px]">
        {parsed.length} file{parsed.length !== 1 ? 's' : ''}
      </span>
      {#if totalAdditions > 0}
        <span class="text-success/80">+{totalAdditions}</span>
      {/if}
      {#if totalDeletions > 0}
        <span class="text-error/70">-{totalDeletions}</span>
      {/if}
    </div>
    <button
      class="copy-btn"
      onclick={copyDiff}
      title="Copy diff"
    >
      {#if copied}
        <svg class="w-3.5 h-3.5 text-success" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
      {:else}
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      {/if}
    </button>
  </div>

  <!-- Files -->
  {#each parsed as file (file.newPath)}
    <div class="diff-file">
      <!-- File header -->
      <button class="file-header" onclick={() => toggleFile(file.newPath)}>
        <svg
          class="w-3.5 h-3.5 shrink-0 text-base-content/40 transition-transform duration-150"
          class:rotate-90={expandedFiles.has(file.newPath)}
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        ><path d="m9 18 6-6-6-6"/></svg>
        <span class="truncate">{truncateLabel(file.newPath)}</span>
        <span class="ml-auto shrink-0 flex items-center gap-2">
          {#if file.additions > 0}
            <span class="text-success/70">+{file.additions}</span>
          {/if}
          {#if file.deletions > 0}
            <span class="text-error/60">-{file.deletions}</span>
          {/if}
        </span>
      </button>

      <!-- Hunk lines -->
      {#if expandedFiles.has(file.newPath)}
        <div class="diff-hunk">
          {#each file.hunks as hunk, hi (hi)}
            {#if hunk !== file.hunks[0]}
              <div class="hunk-separator"></div>
            {/if}
            <div class="hunk-header">{hunk.header}</div>
            {#each hunk.lines as line (line.oldLineNumber ?? line.newLineNumber ?? Math.random())}
              <div
                class="diff-line"
                class:line-add={line.type === 'add'}
                class:line-del={line.type === 'delete'}
                class:line-ctx={line.type === 'context'}
              >
                <span class="line-num">{line.oldLineNumber ?? ''}</span>
                <span class="line-num">{line.newLineNumber ?? ''}</span>
                <span class="line-sign">{line.type === 'add' ? '+' : line.type === 'delete' ? '-' : ' '}</span>
                <span class="line-content">{@html highlightLine(line.content, detectLang(file.newPath))}</span>
              </div>
            {/each}
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .diff-root {
    border: 1px solid color-mix(in oklch, var(--color-base-content) 10%, transparent);
    border-radius: 0.5rem;
    overflow: hidden;
    background: color-mix(in oklch, var(--color-base-100) 60%, transparent);
  }

  .diff-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.375rem 0.625rem;
    background: color-mix(in oklch, var(--color-base-200) 50%, transparent);
    border-bottom: 1px solid color-mix(in oklch, var(--color-base-content) 8%, transparent);
  }

  .copy-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.25rem;
    color: color-mix(in oklch, var(--color-base-content) 40%, transparent);
    transition: all 0.15s;
  }
  .copy-btn:hover {
    background: color-mix(in oklch, var(--color-base-content) 8%, transparent);
    color: var(--color-base-content);
  }

  .diff-file {
    border-bottom: 1px solid color-mix(in oklch, var(--color-base-content) 6%, transparent);
  }
  .diff-file:last-child {
    border-bottom: none;
  }

  .file-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    width: 100%;
    padding: 0.375rem 0.625rem;
    text-align: left;
    font-size: 0.6875rem;
    color: color-mix(in oklch, var(--color-base-content) 65%, transparent);
    background: color-mix(in oklch, var(--color-base-200) 30%, transparent);
    transition: background 0.1s;
    cursor: pointer;
  }
  .file-header:hover {
    background: color-mix(in oklch, var(--color-base-content) 6%, transparent);
  }

  .diff-hunk {
    overflow-x: auto;
  }

  .hunk-header {
    padding: 0.125rem 0.625rem;
    font-size: 0.625rem;
    color: color-mix(in oklch, var(--color-info) 70%, transparent);
    background: color-mix(in oklch, var(--color-base-200) 25%, transparent);
  }

  .hunk-separator {
    height: 1px;
    background: color-mix(in oklch, var(--color-base-content) 6%, transparent);
  }

  .diff-line {
    display: flex;
    line-height: 1.375;
    padding: 0 0.5rem;
    white-space: pre;
  }

  .line-num {
    width: 2.75rem;
    min-width: 2.75rem;
    text-align: right;
    padding-right: 0.5rem;
    color: color-mix(in oklch, var(--color-base-content) 22%, transparent);
    user-select: none;
    font-size: 0.625rem;
  }

  .line-sign {
    width: 1rem;
    min-width: 1rem;
    text-align: center;
    user-select: none;
  }

  .line-content {
    flex: 1;
    min-width: 0;
  }

  .line-add {
    background: color-mix(in oklch, var(--color-success) 10%, transparent);
  }
  .line-add .line-sign {
    color: var(--color-success);
  }

  .line-del {
    background: color-mix(in oklch, var(--color-error) 8%, transparent);
  }
  .line-del .line-sign {
    color: var(--color-error);
  }

  .line-ctx {
    background: transparent;
  }

  /* Syntax highlight overrides inside diff lines — keep it subtle */
  .line-content :global(.hljs-keyword) { opacity: 0.8; }
  .line-content :global(.hljs-string) { opacity: 0.75; }
  .line-content :global(.hljs-number) { opacity: 0.75; }
</style>
