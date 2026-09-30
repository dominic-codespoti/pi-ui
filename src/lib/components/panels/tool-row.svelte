<script lang="ts">
  let {
    tool,
    active,
    open,
    onToggle,
  }: {
    tool: {
      name: string;
      description: string;
      isBuiltin: boolean;
      origin?: string;
      exposure?: 'model-only' | 'codemode' | 'deferred';
      namespace?: { name: string; description?: string };
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    };
    active: boolean;
    open: boolean;
    onToggle: () => void;
  } = $props();

  const exposureTitle = $derived(
    tool.exposure === 'model-only'
      ? 'Declared to the model while active; cannot be called through codemode.'
      : tool.exposure === 'codemode'
        ? 'Callable whenever registered and listed by codemode; not declared to the model unless explicitly activated.'
        : tool.exposure === 'deferred'
          ? 'Callable through codemode but omitted from its listings; tool_search can find and activate it.'
          : ''
  );
  const hint = $derived(
    tool.annotations?.readOnlyHint
      ? 'read-only'
      : tool.annotations?.destructiveHint
        ? 'destructive'
        : ''
  );
  // Some tool descriptions (e.g. tool_search) are markdown documents; the
  // two-line preview should read as prose, not show raw heading markers.
  const descriptionPreview = $derived(
    tool.description
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
</script>

<button
  onclick={onToggle}
  class="group cursor-pointer w-full text-left px-5 py-2.5 text-sm transition-all duration-150 flex items-center gap-3 relative {active
    ? 'hover:bg-base-content/5'
    : 'opacity-50 hover:opacity-75 hover:bg-base-content/3'}"
  tabindex={open ? 0 : -1}
  role="checkbox"
  aria-checked={active}
  title={active ? `Disable ${tool.name}` : `Enable ${tool.name}`}
>
  {#if active}<span
      class="absolute left-0 top-1 bottom-1 w-0.5 rounded-r-full bg-primary glow-primary"
    ></span>{/if}
  <span class="min-w-0 flex-1">
    <span class="flex min-w-0 items-center gap-1.5">
      <span class="text-sm font-mono text-base-content/80 truncate">{tool.name}</span>
      {#if tool.exposure}
        <span
          class="shrink-0 rounded bg-base-content/8 px-1 py-0.5 text-[9px] leading-none text-base-content/45"
          title={exposureTitle}>{tool.exposure}</span
        >
      {/if}
      {#if hint}
        <span
          class="shrink-0 rounded bg-base-content/6 px-1 py-0.5 text-[9px] leading-none text-base-content/40"
          title={hint === 'read-only'
            ? 'Tool author indicates this tool does not modify its environment.'
            : 'Tool author indicates this tool may delete or overwrite data.'}>{hint}</span
        >
      {/if}
    </span>
    {#if tool.namespace}
      <span
        class="block truncate text-[10px] leading-tight text-base-content/30"
        title={tool.namespace.description ?? tool.namespace.name}>{tool.namespace.name}</span
      >
    {/if}
    {#if descriptionPreview}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2"
        >{descriptionPreview}</span
      >{/if}
  </span>
  <span
    data-state={active ? 'checked' : 'unchecked'}
    aria-hidden="true"
    class="cursor-pointer shrink-0 w-4 h-4 rounded border flex items-center justify-center transition-colors {active
      ? 'border-primary bg-primary text-primary-content glow-primary'
      : 'border-base-content/45 bg-transparent group-hover:border-primary/60 group-hover:bg-primary/5'}"
    >{#if active}<svg
        class="w-2.5 h-2.5 text-primary-content"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"><path d="m20 6-11 11-5-5" /></svg
      >{/if}</span
  >
</button>
