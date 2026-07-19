<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import { Button } from '$lib/components/ui/button';

  type Toast = { id: string; message: string; type: 'info' | 'warning' | 'error' };

  let { toasts, dismissToast }: {
    toasts: Toast[];
    dismissToast: (id: string) => void;
  } = $props();
</script>

{#if toasts.length > 0}
  <div
    class="fixed left-4 right-4 sm:left-auto z-50 flex flex-col items-stretch sm:items-end gap-2 pointer-events-none"
    style="bottom: calc(env(safe-area-inset-bottom, 0px) + 1rem);"
    aria-live="polite"
  >
    {#each toasts as toast (toast.id)}
      <div
        class="pointer-events-auto msg-in flex items-start gap-2.5 px-4 py-3 rounded-2xl text-sm sm:max-w-xs shadow-xl shadow-black/30 backdrop-blur-md border bg-base-200/92 text-base-content
        {toast.type === 'error' ? 'border-error/35' : toast.type === 'warning' ? 'border-warning/35' : 'border-base-content/12'}"
      >
        <span class="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 {toast.type === 'error' ? 'bg-error' : toast.type === 'warning' ? 'bg-warning' : 'bg-primary'}"></span>
        <span class="flex-1 leading-relaxed">{toast.message}</span>
        <Button variant="ghost" size="icon-xs" onclick={() => dismissToast(toast.id)} aria-label="Dismiss"><X class="w-3.5 h-3.5" /></Button>
      </div>
    {/each}
  </div>
{/if}
