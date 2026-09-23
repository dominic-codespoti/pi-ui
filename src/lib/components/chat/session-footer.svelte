<script lang="ts">
  import type { FooterStats } from '#lib/ws/protocol.js';
  import GitBranch from '@lucide/svelte/icons/git-branch';
  interface Props {
    gitBranch: string | null;
    availableProviderCount: number;
    stats?: FooterStats;
  }
  let { gitBranch, availableProviderCount, stats }: Props = $props();
  const number = (value: number | undefined) => (value ?? 0).toLocaleString();
</script>

<div
  class="flex min-h-6 items-center gap-3 px-1 text-[10px] leading-4 text-base-content/45"
  aria-label="Session statistics"
>
  {#if gitBranch}
    <span class="inline-flex min-w-0 items-center gap-1" title={gitBranch}>
      <GitBranch class="size-3 shrink-0" aria-hidden="true" />
      <span class="max-w-[10rem] truncate">{gitBranch}</span>
    </span>
  {/if}
  {#if stats}
    <span
      class="hidden items-center gap-2 sm:inline-flex"
      title="Cache read {number(stats.cacheReadTokens)} · cache write {number(
        stats.cacheWriteTokens
      )}"
    >
      <span>↑{number(stats.inputTokens)} ↓{number(stats.outputTokens)}</span>
      <span>${(stats.cost ?? 0).toFixed(4)}</span>
    </span>
  {/if}
  {#if availableProviderCount > 0}
    <span class="ml-auto hidden sm:inline" title="Providers with available models"
      >{availableProviderCount} providers</span
    >
  {/if}
</div>
