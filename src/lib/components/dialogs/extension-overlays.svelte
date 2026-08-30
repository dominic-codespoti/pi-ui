<script lang="ts">
  import Blocks from '@lucide/svelte/icons/blocks';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import X from '@lucide/svelte/icons/x';
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import ExtensionComponent from '#lib/components/ui/extension-component.svelte';
  import {
    customModalNeedsTextInput,
    parsedComponentHasCheckbox,
    parsedComponentHasInput,
    parsedComponentIsDisplayOnly,
    type ExtensionOptionParts,
  } from '#lib/extension-modals.js';
  import type { ModalState } from '#lib/state/extension-ui-state.svelte.js';

  /** autocorrect is a real attribute but missing from Svelte's HTML typings. */
  function autoCorrectOff(node: HTMLElement) {
    node.setAttribute('autocorrect', 'off');
  }

  interface Props {
    modal: ModalState | null;
    filteredSelectOptions?: Array<{ value: string; index: number; option: ExtensionOptionParts }>;
    selectFilter?: string;
    modalInput?: string;
    modalFocusEl?: HTMLElement | undefined;
    overlayPreEl?: HTMLElement | undefined;
    overlayViewportEl?: HTMLElement | undefined;
    onSelectOption?: (value: string) => void;
    onConfirm?: (confirmed: boolean) => void;
    onSubmitValue?: () => void;
    onCancel?: () => void;
    onComponentAction?: (
      path: number[],
      event: 'select' | 'click' | 'toggle' | 'submit' | 'setting',
      value?: string
    ) => void;
    onKeydown?: (e: KeyboardEvent) => void;
    onOverlayKeydown?: (e: KeyboardEvent) => void;
    onOverlayPaste?: (e: ClipboardEvent) => void;
    onOverlayCompositionEnd?: (e: CompositionEvent) => void;
    focusElRef?: (el: HTMLElement | undefined) => void;
  }

  let {
    modal,
    filteredSelectOptions = [],
    selectFilter = $bindable(''),
    modalInput = $bindable(''),
    modalFocusEl = $bindable(undefined),
    overlayPreEl = $bindable(undefined),
    overlayViewportEl = $bindable(undefined),
    onSelectOption,
    onConfirm,
    onSubmitValue,
    onCancel,
    onComponentAction,
    onKeydown,
    onOverlayKeydown,
    onOverlayPaste,
    onOverlayCompositionEnd,
    focusElRef,
  }: Props = $props();

  $effect(() => {
    focusElRef?.(modalFocusEl);
  });
</script>

<!-- ── Interactive custom component full overlay (ConversationViewer etc.) ── -->
{#if modal?.method === 'custom' && modal.interactive}
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-base-100/76 px-3 py-6 backdrop-blur-md sm:px-6"
  >
    <div
      class="relative w-full max-w-3xl"
      role="dialog"
      aria-label="Extension terminal"
      aria-modal="true"
      tabindex="-1"
    >
      <span id="extension-terminal-instructions" class="sr-only">
        Arrow keys, Page Up/Down, Home, End, and Enter are forwarded to the extension. Press Escape
        to close.
      </span>
      <div
        class="flex h-[min(30rem,calc(100dvh-4rem))] flex-col overflow-hidden rounded-2xl border border-base-content/10 bg-base-200/95 shadow-2xl shadow-black/40 ring-1 ring-primary/[0.06] backdrop-blur-xl"
      >
        <div
          class="flex h-10 shrink-0 items-center border-b border-base-content/8 bg-gradient-to-r from-primary/[0.08] via-base-content/[0.025] to-transparent px-4"
        >
          <div class="flex items-center gap-1.5" aria-hidden="true">
            <span class="h-2 w-2 rounded-full bg-error/70"></span>
            <span class="h-2 w-2 rounded-full bg-warning/70"></span>
            <span class="h-2 w-2 rounded-full bg-success/70"></span>
          </div>
          <div class="ml-3 flex min-w-0 items-center gap-2 font-mono">
            <span
              class="truncate text-[10px] font-medium uppercase tracking-[0.16em] text-base-content/55"
              >extension terminal</span
            >
            <span class="h-1 w-1 shrink-0 rounded-full bg-success/80"></span>
            <span class="text-[9px] uppercase tracking-[0.14em] text-base-content/40">live</span>
          </div>
          <span
            class="ml-auto hidden rounded-md border border-base-content/10 bg-base-content/[0.035] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-base-content/35 sm:inline"
            >esc</span
          >
          <button
            type="button"
            onclick={() => onCancel?.()}
            class="ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-base-content/10 bg-base-content/[0.035] text-base-content/55 transition-colors hover:border-primary/30 hover:bg-primary/10 hover:text-base-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-label="Close extension overlay"
          >
            <X class="h-3.5 w-3.5" />
          </button>
        </div>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          bind:this={overlayViewportEl}
          role="application"
          tabindex="-1"
          onclick={() => modalFocusEl?.focus()}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') modalFocusEl?.focus();
          }}
          class="min-h-0 flex-1 overflow-auto bg-base-100/35"
        >
          <pre
            bind:this={overlayPreEl}
            class="min-h-full max-w-full select-text whitespace-pre px-4 py-2 font-mono text-[clamp(0.6875rem,1.5vw,0.8125rem)] leading-[1.55] text-base-content/85">{#if modal.htmlLines}{#each modal.htmlLines as line, i (i)}<div>{@html line ||
                    '&nbsp;'}</div>{/each}{:else}{(modal.lines ?? []).join('\n')}{/if}</pre>
        </div>
      </div>
      <!-- Focusable, transparent input: preserves IME and mobile soft-keyboard access. -->
      <input
        type="text"
        class="absolute left-1/2 top-1/2 h-px w-px opacity-0"
        aria-label="Extension terminal input"
        aria-describedby="extension-terminal-instructions"
        tabindex="0"
        onkeydown={(e) => onOverlayKeydown?.(e)}
        onpaste={(e) => onOverlayPaste?.(e)}
        oncompositionend={(e) => onOverlayCompositionEnd?.(e)}
        bind:this={modalFocusEl}
      />
    </div>
  </div>
{/if}

<!-- ── Extension UI modal ─────────────────────────────────────────────────────── -->
<Dialog.Root
  open={!!modal && !(modal.method === 'custom' && modal.interactive)}
  onOpenChange={(v) => {
    if (!v && modal) onCancel?.();
  }}
>
  <Dialog.Content
    class="flex w-full max-w-[calc(100%-1.5rem)] min-h-0 flex-col overflow-hidden rounded-2xl border border-base-content/10 bg-base-100/95 p-0 shadow-2xl shadow-black/40 ring-1 ring-base-content/5 backdrop-blur-xl sm:max-w-2xl max-h-[min(42rem,calc(100dvh-2rem))] gap-0"
    showCloseButton={false}
    onkeydown={(e) => onKeydown?.(e)}
  >
    <Dialog.Header class="border-b border-base-content/8 px-5 py-4">
      <div class="flex items-center gap-3">
        <div
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary"
        >
          <Blocks class="h-4 w-4" />
        </div>
        <div class="min-w-0">
          <p class="text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60">
            Extension UI
          </p>
          <Dialog.Title class="min-w-0 break-words text-sm font-medium leading-snug"
            >{modal?.title}</Dialog.Title
          >
        </div>
      </div>
      {#if modal?.method === 'confirm' && modal.message}
        <Dialog.Description
          class="max-h-[min(12rem,30dvh)] overflow-y-auto whitespace-pre-wrap break-words break-all pr-1 leading-relaxed"
          >{modal.message}</Dialog.Description
        >
      {/if}
    </Dialog.Header>

    {#if modal?.method === 'input'}
      <input
        bind:this={modalFocusEl}
        type={modal.secret ? 'password' : 'text'}
        bind:value={modalInput}
        placeholder={modal.placeholder ?? ''}
        class="dialog-input mx-5 mb-5 mt-5 w-[calc(100%-2.5rem)] rounded-xl px-3.5 py-2.5 text-sm outline-none placeholder-muted-foreground transition-colors"
      />
    {:else if modal?.method === 'select'}
      {#if modal.options.length > 0}
        <div class="min-h-0 max-h-[min(28rem,60dvh)] overflow-y-auto px-4 py-4 sm:px-5">
          {#if modal.options.length > 10}
            <div class="relative mb-3">
              <input
                type="search"
                bind:value={selectFilter}
                placeholder="Filter options…"
                aria-label="Filter options"
                class="w-full rounded-xl border border-base-content/10 bg-base-content/[0.035] px-3.5 py-2.5 pr-9 text-sm outline-none transition-colors placeholder:text-base-content/35 focus:border-primary/45 focus:bg-base-content/[0.06]"
              />
              <span
                class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wide text-base-content/30"
                >{filteredSelectOptions.length}/{modal.options.length}</span
              >
            </div>
          {/if}
          {#if filteredSelectOptions.length > 0}
            <div
              role="listbox"
              aria-label={modal.title}
              class="space-y-1.5 rounded-xl border border-base-content/8 bg-base-content/[0.02] p-2"
            >
              {#each filteredSelectOptions as item (item.index + ':' + item.value)}
                {@const option = item.option}
                <!-- svelte-ignore a11y_autofocus -->
                <button
                  type="button"
                  data-extension-option="true"
                  role="option"
                  aria-selected="false"
                  aria-posinset={item.index + 1}
                  aria-setsize={modal.options.length}
                  autofocus={item.index === 0}
                  class="group flex w-full min-w-0 items-start gap-3 rounded-xl border border-base-content/8 bg-base-content/[0.025] px-3.5 py-3 text-left transition-all duration-150 hover:border-primary/30 hover:bg-primary/[0.06] focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 active:scale-[0.99]"
                  onclick={() => onSelectOption?.(item.value)}
                >
                  <span
                    class="mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 px-1.5 text-xs font-semibold tabular-nums text-primary/80"
                    >{option.index}</span
                  >
                  <span class="min-w-0 flex-1">
                    <span
                      class="block whitespace-normal break-words text-sm font-medium leading-snug text-base-content/78 group-hover:text-base-content"
                      >{option.label}</span
                    >
                    {#if option.description}
                      <span
                        class="mt-1 block whitespace-normal break-words text-xs leading-relaxed text-base-content/45 group-hover:text-base-content/60"
                        >{option.description}</span
                      >
                    {/if}
                  </span>
                  <ChevronRight
                    class="mt-1 h-4 w-4 shrink-0 text-base-content/25 transition-transform group-hover:translate-x-0.5 group-hover:text-primary/70"
                  />
                </button>
              {/each}
            </div>
          {:else}
            <p
              class="rounded-xl border border-dashed border-base-content/10 px-4 py-6 text-center text-sm text-muted-foreground"
            >
              No matching options.
            </p>
          {/if}
        </div>
      {:else}
        <p class="px-5 py-6 text-sm text-muted-foreground">No options were provided.</p>
      {/if}
    {:else if modal?.method === 'editor'}
      <textarea
        bind:this={modalFocusEl}
        bind:value={modalInput}
        rows={8}
        autocapitalize="off"
        spellcheck={false}
        use:autoCorrectOff
        class="dialog-input mx-5 mb-5 mt-5 w-[calc(100%-2.5rem)] resize-none rounded-xl p-3.5 text-sm leading-relaxed transition-colors"
      ></textarea>
    {:else if modal?.method === 'custom'}
      <div class="min-h-0 max-h-[min(32rem,65dvh)] min-w-0 flex-1 overflow-y-auto px-5 py-4">
        {#if modal.parsed}
          <ExtensionComponent
            component={modal.parsed}
            interactive
            onaction={onComponentAction}
            bind:inputValue={modalInput}
          />
          {#if customModalNeedsTextInput(modal.parsed)}
            <input
              bind:this={modalFocusEl}
              type="text"
              bind:value={modalInput}
              placeholder="Type your response…"
              class="dialog-input mt-4 w-full rounded-xl px-3.5 py-2.5 text-sm placeholder-muted-foreground transition-colors"
            />
          {/if}
        {:else}
          <p class="mb-2 text-sm text-muted-foreground">Extension request:</p>
          <input
            bind:this={modalFocusEl}
            type="text"
            bind:value={modalInput}
            placeholder="Type your response…"
            class="dialog-input w-full rounded-xl px-3.5 py-2.5 text-sm placeholder-muted-foreground transition-colors"
          />
        {/if}
      </div>
    {/if}
    <Dialog.Footer
      class="mx-0 mb-0 items-center rounded-b-2xl border-base-content/8 bg-base-200/50 px-5 py-3.5"
    >
      {#if modal?.method === 'select'}
        <span class="mr-auto hidden text-[11px] text-base-content/35 sm:inline"
          >↑↓ navigate · Enter select · Esc cancel</span
        >
      {/if}
      <Button
        variant="ghost"
        size="sm"
        class="shrink-0 text-muted-foreground/80 hover:text-base-content"
        onclick={() => onCancel?.()}>Cancel</Button
      >
      {#if modal?.method === 'confirm'}
        <Button size="sm" onclick={() => onConfirm?.(true)}>Confirm</Button>
      {:else if modal?.method === 'input' || modal?.method === 'editor'}
        <Button size="sm" onclick={() => onSubmitValue?.()}>Submit</Button>
      {:else if modal?.method === 'custom' && !modal.interactive && (customModalNeedsTextInput(modal.parsed) || parsedComponentHasInput(modal.parsed) || parsedComponentHasCheckbox(modal.parsed) || parsedComponentIsDisplayOnly(modal.parsed))}
        <Button size="sm" onclick={() => onSubmitValue?.()}
          >{parsedComponentIsDisplayOnly(modal.parsed) ? 'OK' : 'Submit'}</Button
        >
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
