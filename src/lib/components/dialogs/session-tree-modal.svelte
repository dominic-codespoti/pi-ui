<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import type { TreeNode } from '$lib/ws/protocol';

  let { open, loading, treeData, onClose }: {
    open: boolean;
    loading: boolean;
    treeData: TreeNode[];
    onClose: () => void;
  } = $props();
</script>

{#snippet renderNode(nodes: TreeNode[], depth: number)}
  {#each nodes as node (node.entryId)}
    <div class="flex items-start gap-2" style="padding-left: {depth * 1.25}rem;">
      {#if node.children.length > 0}
        <span class="text-base-content/30 shrink-0 mt-0.5 select-none">
          <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M9 5l7 7-7 7"/></svg>
        </span>
      {:else}
        <span class="w-3 shrink-0"></span>
      {/if}
      <div class="min-w-0 flex-1 py-1.5">
        <div class="flex items-baseline gap-2">
          {#if node.role === 'user'}
            <span class="text-xs font-semibold text-info/80">user</span>
          {:else if node.role === 'assistant'}
            <span class="text-xs font-semibold text-success/80">assistant</span>
          {:else if node.role === 'toolResult'}
            <span class="text-xs font-semibold text-warning/80">tool</span>
          {:else}
            <span class="text-xs font-semibold text-base-content/40">{node.type}</span>
          {/if}
          {#if node.text}
            <span class="text-xs text-base-content/60 truncate">{node.text}</span>
          {:else if node.label}
            <span class="text-xs text-base-content/40 italic truncate">[{node.label}]</span>
          {:else}
            <span class="text-xs text-base-content/30 italic">(empty)</span>
          {/if}
        </div>
      </div>
    </div>
    {#if node.children.length > 0}
      {@render renderNode(node.children, depth + 1)}
    {/if}
  {/each}
{/snippet}

<Dialog.Root bind:open>
  <Dialog.Content class="font-mono max-w-2xl">
    <Dialog.Header>
      <Dialog.Title>Session tree</Dialog.Title>
      <Dialog.Description>Hierarchical view of the session branch structure.</Dialog.Description>
    </Dialog.Header>

    {#if loading}
      <div class="flex items-center justify-center py-6 text-muted-foreground text-sm gap-2">
        <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        loading…
      </div>
    {:else if treeData.length === 0}
      <p class="text-sm text-muted-foreground py-4 text-center">Session tree is empty.</p>
    {:else}
      <div class="max-h-96 overflow-y-auto py-2 space-y-0.5">
        {@render renderNode(treeData, 0)}
      </div>
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={onClose}>close</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
