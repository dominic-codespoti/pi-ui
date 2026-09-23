<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';

  let {
    open = $bindable(false),
    onCompact,
  }: {
    open?: boolean;
    onCompact: (instructions: string) => void;
  } = $props();

  let instructions = $state('');

  function close() {
    open = false;
    instructions = '';
  }

  function compact() {
    onCompact(instructions.trim());
    close();
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={(next) => {
    if (!next) close();
    else open = true;
  }}
>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Compact context</Dialog.Title>
      <Dialog.Description>
        Optionally guide how the conversation is summarized. Leave blank for the default summary.
      </Dialog.Description>
    </Dialog.Header>
    <label class="flex flex-col gap-2 text-sm">
      <span class="text-xs font-medium text-base-content/60">Summary instructions</span>
      <textarea
        bind:value={instructions}
        rows="5"
        class="textarea textarea-bordered w-full resize-y text-sm"
        placeholder="Preserve key decisions, constraints, and unfinished work…"
        aria-label="Compaction summary instructions"></textarea>
    </label>
    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={close}>Cancel</Button>
      <Button size="sm" onclick={compact}>Compact</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
