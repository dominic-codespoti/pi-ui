<script lang="ts">
  import type { Snippet } from 'svelte';

  type Side = 'left' | 'right';

  let {
    title,
    open,
    isMobile,
    width,
    side = 'right',
    resizing = false,
    closeLabel = `Close ${title}`,
    surface = 'default',
    header,
    children,
    onClose,
    onResizeStart,
    onResizeMove,
    onResizeStop,
  }: {
    title: string;
    open: boolean;
    isMobile: boolean;
    width: number;
    side?: Side;
    resizing?: boolean;
    closeLabel?: string;
    surface?: 'default' | 'deep';
    header?: Snippet;
    children: Snippet;
    onClose: () => void;
    onResizeStart?: (event: PointerEvent) => void;
    onResizeMove?: (event: PointerEvent) => void;
    onResizeStop?: (event: PointerEvent) => void;
  } = $props();

  const translateClosed = $derived(side === 'left' ? '-100%' : '100%');
  const borderClass = $derived('');
  const fixedSideClass = $derived(side === 'left' ? 'left-0' : 'right-0');
  const resizeSideClass = $derived(side === 'left' ? 'right-0' : 'left-0');
  const resizeCursorClass = $derived(side === 'left' ? 'cursor-col-resize' : 'cursor-col-resize');
  const panelStyle = $derived(
    isMobile
      ? `width: min(${width}px, calc(100vw - 1rem)); transform: translateX(${open ? '0' : translateClosed}); transition: transform 220ms cubic-bezier(0.33,1,0.68,1); padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);`
      : `width: ${open ? width + 'px' : '0'}; transition: ${resizing ? 'none' : 'width 220ms cubic-bezier(0.33,1,0.68,1)'};`
  );
  const surfaceClass = $derived(
    surface === 'deep'
      ? 'bg-base-300/98 shadow-2xl shadow-black/20'
      : 'bg-[color-mix(in_oklch,var(--color-base-200)_92%,black_8%)] shadow-2xl shadow-black/15'
  );
  const mobileRoundClass = $derived(side === 'left' ? 'rounded-r-[1.5rem]' : 'rounded-l-[1.5rem]');
</script>

{#if isMobile && open}
  <div
    class="fixed inset-0 z-30 bg-base-100/60 backdrop-blur-sm"
    onclick={onClose}
    aria-hidden="true"
    role="presentation"
  ></div>
{/if}

<div
  role="complementary"
  aria-label={title}
  class={isMobile ? `fixed inset-y-0 ${fixedSideClass} z-40 flex flex-col` : 'relative shrink-0 overflow-hidden'}
  style={panelStyle}
  aria-hidden={!open}
>
  <div class="w-full h-full {surfaceClass} {borderClass} {isMobile ? mobileRoundClass : ''} flex flex-col overflow-hidden">
    {#if header}
      {@render header()}
    {:else}
      <div class="shrink-0 px-4 py-3 border-b border-base-content/10 flex items-center justify-between bg-base-content/[0.025]">
        <span class="text-sm text-base-content/60 uppercase tracking-[0.16em] font-medium truncate">{title}</span>
        <button
          onclick={onClose}
          class="w-9 h-9 flex items-center justify-center text-base-content/45 hover:text-base-content/80 hover:bg-base-content/8 rounded-xl transition-colors shrink-0"
          aria-label={closeLabel}
          tabindex={open ? 0 : -1}
        ><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
    {/if}

    {@render children()}
  </div>

  {#if !isMobile && onResizeStart && onResizeMove && onResizeStop}
    <div
      class="absolute top-0 {resizeSideClass} bottom-0 w-1.5 z-10 {resizeCursorClass} hover:bg-primary/25 active:bg-primary/40 transition-colors"
      onpointerdown={onResizeStart}
      onpointermove={onResizeMove}
      onpointerup={onResizeStop}
      onpointercancel={onResizeStop}
      aria-hidden="true"
    ></div>
  {/if}
</div>
