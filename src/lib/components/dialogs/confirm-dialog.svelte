<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';

  let { pendingConfirm, onClose }: {
    pendingConfirm: {
      title: string;
      message: string;
      confirmLabel: string;
      variant: 'error' | 'warning' | 'info';
      onConfirm: () => void;
    } | null;
    onClose: () => void;
  } = $props();
</script>

<Dialog.Root open={pendingConfirm !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>{pendingConfirm?.title ?? 'Confirm'}</Dialog.Title>
      <Dialog.Description>{pendingConfirm?.message ?? ''}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={onClose}>Cancel</Button>
      <Button
        onclick={() => { pendingConfirm?.onConfirm(); onClose(); }}
        size="sm"
        class={pendingConfirm?.variant === 'warning' ? 'bg-warning text-warning-content hover:brightness-110' : pendingConfirm?.variant === 'info' ? 'bg-primary text-primary-content hover:brightness-110' : 'bg-error text-error-content hover:brightness-110'}
      >{pendingConfirm?.confirmLabel ?? 'Confirm'}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
