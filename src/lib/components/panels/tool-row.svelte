<script lang="ts">
  let {
    tool,
    active,
    open,
    onToggle,
  }: {
    tool: { name: string; description: string; isBuiltin: boolean; origin?: string };
    active: boolean;
    open: boolean;
    onToggle: () => void;
  } = $props();
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
    <span class="text-sm font-mono text-base-content/80 block truncate">{tool.name}</span>
    {#if tool.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2"
        >{tool.description}</span
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
