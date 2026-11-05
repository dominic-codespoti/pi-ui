<script lang="ts">
  import { projectsState } from '#lib/state/projects-state.svelte.js';
  import TextSearch from '@lucide/svelte/icons/text-search';
  import type { SessionSearchMatch } from '#lib/ws/protocol.js';

  let { open }: { open: boolean } = $props();

  const ps = projectsState;
  const query = $derived(ps.filter.trim());
  const current = $derived(
    ps.contentSearch && ps.contentSearch.query === query ? ps.contentSearch : null
  );

  // A changed or cleared filter invalidates earlier results.
  $effect(() => {
    if (ps.contentSearch && ps.contentSearch.query !== query) ps.clearContentSearch();
  });

  function basename(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path;
  }
  function parts(match: SessionSearchMatch) {
    const end = match.matchStart + match.matchLength;
    return {
      before: match.snippet.slice(0, match.matchStart),
      hit: match.snippet.slice(match.matchStart, end),
      after: match.snippet.slice(end),
    };
  }
</script>

{#if query.length >= 2}
  <div class="px-1 pb-2" data-testid="session-content-search">
    {#if !current}
      <button
        type="button"
        class="w-full flex items-center gap-2 rounded-xl px-3 py-2 text-left text-xs text-base-content/55 transition-colors hover:bg-base-content/8 hover:text-base-content/80"
        onclick={() => ps.searchContent(query)}
        tabindex={open ? 0 : -1}
      >
        <TextSearch class="w-3.5 h-3.5 shrink-0" />
        <span class="min-w-0 truncate">Search messages for “{query}”</span>
      </button>
    {:else if current.loading}
      <p class="px-3 py-2 text-xs text-base-content/40" role="status">Searching messages…</p>
    {:else if current.response}
      {@const response = current.response}
      <p class="px-3 pt-1 pb-1.5 text-[10px] uppercase tracking-[0.18em] text-base-content/30">
        in messages · {response.results.length}{response.truncated ? '+' : ''}
      </p>
      {#if response.error}
        <p class="px-3 py-1 text-xs text-error/80">{response.error}</p>
      {:else if response.results.length === 0}
        <p class="px-3 py-1 text-xs text-base-content/40">
          No messages match{response.truncated ? ' in the sessions searched' : ''}.
        </p>
      {/if}
      <ul class="flex flex-col gap-0.5">
        {#each response.results as result (result.path)}
          <li>
            <button
              type="button"
              class="w-full rounded-xl px-3 py-2 text-left transition-colors hover:bg-base-content/8"
              onclick={() => ps.switchSession(result.path)}
              tabindex={open ? 0 : -1}
              data-testid="session-search-result"
            >
              <span class="flex items-baseline gap-2">
                <span class="min-w-0 flex-1 truncate text-xs text-base-content/80"
                  >{result.name || result.firstMessage}</span
                >
                <span class="shrink-0 text-[10px] text-base-content/35"
                  >{basename(result.cwd)}{result.matchCount > 1
                    ? ` · ${result.matchCount}`
                    : ''}</span
                >
              </span>
              {#each result.matches.slice(0, 2) as match, i (i)}
                {@const p = parts(match)}
                <span
                  class="mt-0.5 block text-[11px] leading-snug text-base-content/45 line-clamp-2"
                  >{p.before}<mark class="bg-primary/20 text-base-content/85 rounded-sm"
                    >{p.hit}</mark
                  >{p.after}</span
                >
              {/each}
            </button>
          </li>
        {/each}
      </ul>
      {#if response.truncated && response.results.length > 0}
        <p class="px-3 pt-1 text-[10px] text-base-content/30">
          Showing the most recent matches ({response.scannedFiles}/{response.totalFiles} sessions searched).
        </p>
      {/if}
    {/if}
  </div>
{/if}
