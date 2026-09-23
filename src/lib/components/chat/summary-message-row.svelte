<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import FileText from '@lucide/svelte/icons/file-text';
  import type { UIMessage } from '#lib/client-messages.js';
  import { memoizedRenderMarkdown } from '#lib/markdown.js';

  let { msg }: { msg: UIMessage } = $props();
  let expanded = $state(false);
  let isCompaction = $derived(msg.role === 'compaction_summary');
  let title = $derived(
    isCompaction
      ? typeof msg.tokensBefore === 'number'
        ? `Context compacted — ${msg.tokensBefore.toLocaleString()} tokens summarized`
        : 'Context compacted'
      : 'Branch summary'
  );
</script>

<section
  class="my-2 rounded-xl border border-base-content/10 bg-base-content/[0.035] overflow-hidden"
>
  <button
    type="button"
    class="flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-sm text-base-content/75 hover:bg-base-content/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    aria-expanded={expanded}
    onclick={() => (expanded = !expanded)}
  >
    <FileText class="size-4 shrink-0 text-secondary" aria-hidden="true" />
    <span class="min-w-0 flex-1 font-medium">{title}</span>
    <ChevronRight
      class="size-4 shrink-0 transition-transform {expanded ? 'rotate-90' : ''}"
      aria-hidden="true"
    />
  </button>
  {#if expanded}
    <div
      class="border-t border-base-content/10 px-4 py-3 prose prose-sm max-w-none text-base-content/75"
    >
      {@html memoizedRenderMarkdown(msg.summary ?? msg.content)}
    </div>
  {/if}
</section>
