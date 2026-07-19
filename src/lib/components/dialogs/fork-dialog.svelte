<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';

  let { open, loading, forkPoints, forkAt, onClose }: {
    open: boolean;
    loading: boolean;
    forkPoints: { entryId: string; text: string }[];
    forkAt: (entryId: string) => void;
    onClose: () => void;
  } = $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="font-mono">
    <Dialog.Header>
      <Dialog.Title>Fork session</Dialog.Title>
      <Dialog.Description>Choose a user message to branch from. A new session will be created up to that point.</Dialog.Description>
    </Dialog.Header>

    {#if loading}
      <div class="flex items-center justify-center py-6 text-muted-foreground text-sm gap-2">
        <svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
        loading…
      </div>
    {:else if forkPoints.length === 0}
      <p class="text-sm text-muted-foreground py-4 text-center">No user messages found in this session.</p>
    {:else}
      <div class="space-y-1 max-h-64 overflow-y-auto">
        {#each forkPoints as fp (fp.entryId)}
          <button
            onclick={() => forkAt(fp.entryId)}
            class="w-full text-left px-3 py-2.5 rounded-lg text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors leading-snug truncate"
            title={fp.text}
          >{fp.text || '(empty)'}</button>
        {/each}
      </div>
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={onClose}>cancel</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
