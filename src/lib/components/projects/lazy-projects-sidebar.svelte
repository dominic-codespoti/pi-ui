<script lang="ts">
  /**
   * Lazy-mounting wrapper for the projects sidebar — loaded on first open (or
   * prefetched on idle). The sidebar shell stays mounted for the width
   * transition; only the heavy project/session tree is deferred.
   */
  let {
    open,
    canFork = false,
    onFork,
    onRequestConfirm = () => {},
  }: {
    open: boolean;
    canFork?: boolean;
    onFork: () => void;
    onRequestConfirm: (
      message: string,
      onConfirm: () => void,
      opts?: { title?: string; confirmLabel?: string; variant?: 'error' | 'warning' | 'info' }
    ) => void;
  } = $props();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic component type
  let Cmp = $state<any>(null);
  $effect(() => {
    if (open && !Cmp) {
      import('./projects-sidebar.svelte').then((m) => (Cmp = m.default)).catch(() => {});
    }
  });
</script>

{#if Cmp}
  <Cmp {open} {canFork} {onFork} {onRequestConfirm} />
{/if}
