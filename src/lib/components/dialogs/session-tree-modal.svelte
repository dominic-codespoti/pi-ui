<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import type { TreeNode } from '#lib/ws/protocol.js';

  type FlatNode = { node: TreeNode; depth: number };
  let {
    open,
    loading,
    treeData,
    branchSummarySkipPrompt = false,
    navigating = false,
    summarizing = false,
    error = '',
    onClose,
    onNavigate,
    onLabel,
    onAbort,
  }: {
    open: boolean;
    loading: boolean;
    treeData: TreeNode[];
    branchSummarySkipPrompt?: boolean;
    navigating?: boolean;
    summarizing?: boolean;
    error?: string;
    onClose: () => void;
    onNavigate: (entryId: string, summarize: boolean, customInstructions: string) => void;
    onLabel: (entryId: string, label?: string) => void;
    onAbort: () => void;
  } = $props();

  let filter = $state('');
  let selectedEntryId = $state('');
  let summarize = $state(false);
  let instructions = $state('');
  let editingLabelId = $state('');
  let labelValue = $state('');

  const flatNodes = $derived.by(() => {
    const flat: FlatNode[] = [];
    const needle = filter.trim().toLocaleLowerCase();
    if (!needle) {
      const append = (nodes: TreeNode[], depth: number) => {
        for (const node of nodes) {
          flat.push({ node, depth });
          if (node.children.length) append(node.children, depth + 1);
        }
      };
      append(treeData, 0);
      return flat;
    }
    const visibleIds = new SvelteSet<string>();
    const markMatches = (node: TreeNode): boolean => {
      const selfMatches = `${node.role ?? node.type} ${node.text ?? ''} ${node.label ?? ''}`
        .toLocaleLowerCase()
        .includes(needle);
      let descendantMatches = false;
      for (const child of node.children) {
        if (markMatches(child)) descendantMatches = true;
      }
      if (selfMatches || descendantMatches) visibleIds.add(node.entryId);
      return selfMatches || descendantMatches;
    };
    for (const root of treeData) markMatches(root);
    const appendMatches = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        if (!visibleIds.has(node.entryId)) continue;
        flat.push({ node, depth });
        if (node.children.length) appendMatches(node.children, depth + 1);
      }
    };
    appendMatches(treeData, 0);
    return flat;
  });
  const selectedNode = $derived(
    flatNodes.find(({ node }) => node.entryId === selectedEntryId)?.node
  );

  $effect(() => {
    if (!flatNodes.some(({ node }) => node.entryId === selectedEntryId)) {
      selectedEntryId =
        flatNodes.find(({ node }) => node.isCurrentLeaf)?.node.entryId ??
        flatNodes[0]?.node.entryId ??
        '';
    }
  });

  function selectOffset(offset: number) {
    if (flatNodes.length === 0) return;
    const current = flatNodes.findIndex(({ node }) => node.entryId === selectedEntryId);
    const next = Math.max(0, Math.min(flatNodes.length - 1, (current < 0 ? 0 : current) + offset));
    selectedEntryId = flatNodes[next].node.entryId;
    document.getElementById(`tree-entry-${selectedEntryId}`)?.scrollIntoView({ block: 'nearest' });
  }

  function handleKeydown(event: KeyboardEvent) {
    const target = event.target;
    if (
      event.key === 'Enter' &&
      target instanceof HTMLElement &&
      target.closest('button') &&
      !target.closest('[role="option"]')
    ) {
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      selectOffset(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && selectedNode && !editingLabelId && !navigating) {
      event.preventDefault();
      onNavigate(selectedNode.entryId, summarize, instructions);
    }
  }

  function beginLabel(node: TreeNode) {
    editingLabelId = node.entryId;
    labelValue = node.label ?? '';
  }

  function saveLabel(entryId: string) {
    onLabel(entryId, labelValue.trim() || undefined);
    editingLabelId = '';
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Dialog.Root bind:open>
  <Dialog.Content class="font-mono max-w-3xl" onCloseAutoFocus={(event) => event.preventDefault()}>
    <Dialog.Header>
      <Dialog.Title>Session tree</Dialog.Title>
      <Dialog.Description
        >Choose an entry to continue from it. User messages are restored to the editor.</Dialog.Description
      >
    </Dialog.Header>

    {#if loading}
      <div class="flex items-center justify-center py-6 text-muted-foreground text-sm gap-2">
        Loading session tree…
      </div>
    {:else if treeData.length === 0}
      <p class="text-sm text-muted-foreground py-4 text-center">Session tree is empty.</p>
    {:else}
      <input
        class="input input-bordered input-sm w-full"
        placeholder="Filter entries by text or label…"
        aria-label="Filter session tree"
        bind:value={filter}
      />
      <div
        class="max-h-80 overflow-y-auto py-2 space-y-0.5"
        role="listbox"
        aria-label="Session entries"
      >
        {#each flatNodes as item (item.node.entryId)}
          {@const node = item.node}
          <div
            id="tree-entry-{node.entryId}"
            class="flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors {selectedEntryId ===
            node.entryId
              ? 'border-primary bg-primary/10'
              : node.isOnCurrentPath
                ? 'border-base-300 bg-base-200/60'
                : 'border-transparent hover:bg-base-200/50'} {node.isCurrentLeaf
              ? 'ring-1 ring-primary/40'
              : ''}"
            style="margin-left: {Math.min(item.depth, 10) * 0.8}rem"
          >
            <button
              class="min-w-0 flex-1 text-left"
              role="option"
              aria-selected={selectedEntryId === node.entryId}
              aria-label="{node.role ?? node.type}: {node.text ?? node.label ?? 'empty entry'}"
              onclick={() => (selectedEntryId = node.entryId)}
            >
              <span class="flex min-w-0 items-center gap-2">
                <span
                  class="text-xs font-semibold {node.role === 'user'
                    ? 'text-info/80'
                    : node.role === 'assistant'
                      ? 'text-success/80'
                      : 'text-warning/80'}">{node.role ?? node.type}</span
                >
                {#if node.isCurrentLeaf}<span class="badge badge-primary badge-xs"
                    >current leaf</span
                  >{/if}
                {#if node.label}<span class="badge badge-outline badge-xs max-w-28 truncate"
                    >{node.label}</span
                  >{/if}
                <span class="truncate text-xs text-base-content/65">{node.text ?? '(empty)'}</span>
              </span>
            </button>
            {#if editingLabelId === node.entryId}
              <input
                class="input input-bordered input-xs w-28"
                aria-label="Entry label"
                bind:value={labelValue}
                onkeydown={(event) => {
                  if (event.key === 'Enter') saveLabel(node.entryId);
                  if (event.key === 'Escape') editingLabelId = '';
                }}
              />
              <Button size="xs" onclick={() => saveLabel(node.entryId)}>save</Button>
              <Button variant="ghost" size="xs" onclick={() => (editingLabelId = '')}>cancel</Button
              >
            {:else}
              <Button
                variant="ghost"
                size="xs"
                aria-label="Label entry"
                onclick={() => beginLabel(node)}>Label</Button
              >
            {/if}
          </div>
        {/each}
        {#if flatNodes.length === 0}<p class="py-4 text-center text-sm text-muted-foreground">
            No matching entries.
          </p>{/if}
      </div>
      {#if selectedNode && !selectedNode.isOnCurrentPath && !branchSummarySkipPrompt}
        <div class="rounded-lg border border-base-300 bg-base-200/40 p-3 space-y-2">
          <label class="flex items-center gap-2 text-sm">
            <input class="checkbox checkbox-sm" type="checkbox" bind:checked={summarize} />
            <span>Summarize abandoned branch</span>
          </label>
          {#if summarize}
            <textarea
              class="textarea textarea-bordered textarea-sm w-full"
              rows="2"
              aria-label="Branch summary instructions"
              placeholder="Optional instructions for the summary"
              bind:value={instructions}></textarea>
          {/if}
        </div>
      {/if}
      {#if error}<p class="text-sm text-error" role="alert">{error}</p>{/if}
      {#if navigating}
        <div class="flex items-center justify-between text-sm text-info" role="status">
          <span class="animate-pulse"
            >{summarizing ? 'Summarizing branch and navigating…' : 'Navigating to entry…'}</span
          >
          {#if summarizing}<Button variant="outline" size="sm" onclick={onAbort}>Abort</Button>{/if}
        </div>
      {/if}
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" size="sm" onclick={onClose}>close</Button>
      {#if selectedNode}
        <Button
          size="sm"
          disabled={navigating || loading}
          onclick={() => onNavigate(selectedNode.entryId, summarize, instructions)}
          >Navigate here</Button
        >
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
