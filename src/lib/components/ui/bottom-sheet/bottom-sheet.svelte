<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    open = $bindable(),
    title = '',
    showHandle = true,
    showClose = true,
    onClose,
    children,
  }: {
    open: boolean;
    title?: string;
    showHandle?: boolean;
    showClose?: boolean;
    onClose?: () => void;
    children?: Snippet;
  } = $props();

  let panelEl = $state<HTMLDivElement | undefined>(undefined);
  let dragStartY = 0;
  let dragging = false;

  function dismiss() {
    open = false;
    onClose?.();
  }

  function onHeaderPointerDown(e: PointerEvent) {
    // Never start a drag from an interactive control (the close button).
    if ((e.target as HTMLElement).closest('button, a, input, textarea, select')) return;
    dragging = true;
    dragStartY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onHeaderPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dy = Math.max(0, e.clientY - dragStartY);
    if (panelEl) panelEl.style.transform = `translateY(${dy}px)`;
  }

  function endDrag(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    const dy = e.clientY - dragStartY;
    if (panelEl) panelEl.style.transform = '';
    if (dy > 88) dismiss();
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-[70]"
    role="dialog"
    aria-modal="true"
    aria-label={title || 'Bottom sheet'}
  >
    <button
      type="button"
      class="absolute inset-0 w-full h-full bg-base-100/60 backdrop-blur-sm sheet-backdrop-in cursor-default"
      aria-label="Close"
      tabindex="-1"
      onclick={dismiss}
    ></button>
    <div
      bind:this={panelEl}
      data-sheet-panel
      class="absolute inset-x-0 bottom-0 flex max-h-[88dvh] flex-col rounded-t-[1.65rem] border border-base-content/10 bg-base-200/95 shadow-2xl shadow-black/40 sheet-panel-in"
      style="padding-bottom: env(safe-area-inset-bottom, 0px);"
    >
      {#if showHandle || title || showClose}
        <!-- Drag-to-dismiss gesture surface; handle/close inside are keyboard-operable -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="shrink-0 touch-none select-none"
          style="touch-action: none;"
          onpointerdown={onHeaderPointerDown}
          onpointermove={onHeaderPointerMove}
          onpointerup={endDrag}
          onpointercancel={endDrag}
        >
          {#if showHandle}
            <div class="flex justify-center pt-2.5 pb-1">
              <div
                class="h-1 w-12 rounded-full bg-base-content/20"
                role="button"
                tabindex="0"
                aria-label="Dismiss sheet"
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    dismiss();
                  }
                }}
              ></div>
            </div>
          {/if}
          {#if title || showClose}
            <div class="flex items-center justify-between gap-3 px-4 pb-1">
              {#if title}
                <span class="min-w-0 truncate text-sm font-medium text-base-content/80"
                  >{title}</span
                >
              {/if}
              {#if showClose}
                <button
                  onclick={dismiss}
                  class="w-8 h-8 flex items-center justify-center rounded-lg text-base-content/45 hover:text-base-content/80 hover:bg-base-content/8 transition-colors shrink-0"
                  aria-label="Close"
                  ><svg
                    class="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg
                  ></button
                >
              {/if}
            </div>
          {/if}
        </div>
      {/if}
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
        {@render children?.()}
      </div>
    </div>
  </div>
{/if}

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') dismiss();
  }}
/>
