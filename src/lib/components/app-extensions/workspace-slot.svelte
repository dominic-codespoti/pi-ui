<script lang="ts">
  import type {
    AppExtensionCall,
    AppExtensionEventListener,
  } from '#lib/app-extensions/transport.js';
  import type {
    AppExtensionHostPrompt,
    AppExtensionHostDraft,
    AppExtensionHostConfirm,
    AppExtensionHostOpenFile,
    AppExtensionHostSwitchSession,
  } from '#lib/app-extensions/client-loader.js';
  import type {
    AppExtensionScope,
    AppExtensionSummary,
    AppExtensionViewContribution,
  } from '#lib/app-extensions/types.js';
  import ExtensionSlotHost from './extension-slot-host.svelte';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Blocks from '@lucide/svelte/icons/blocks';

  /** Primary app surface shared by desktop and mobile; history Back returns to chat. */
  let {
    extension,
    view,
    scope,
    call,
    subscribe,
    prompt,
    draft,
    confirm,
    openFile,
    switchSession,
    notify = () => {},
    onClose,
    onOpenLauncher,
  }: {
    extension: AppExtensionSummary;
    view: AppExtensionViewContribution;
    scope: AppExtensionScope;
    call: AppExtensionCall;
    prompt: AppExtensionHostPrompt;
    draft: AppExtensionHostDraft;
    confirm: AppExtensionHostConfirm;
    openFile: AppExtensionHostOpenFile;
    switchSession: AppExtensionHostSwitchSession;
    subscribe: (
      extensionId: string,
      eventName: string,
      listener: AppExtensionEventListener,
      scope: AppExtensionScope,
    ) => () => void;
    notify?: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void;
    onClose: () => void;
    onOpenLauncher: () => void;
  } = $props();

  let backButton: HTMLButtonElement | null = $state(null);

  $effect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backButton?.focus();
    return () => {
      queueMicrotask(() => {
        if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
      });
    };
  });

</script>

<div
  role="dialog"
  aria-modal="true"
  aria-label="{view.title} workspace"
  class="fixed inset-0 z-50 flex min-h-0 flex-col bg-base-200"
  style="padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px);"
>
  <header class="flex shrink-0 items-center gap-2 border-b border-base-content/8 px-3 py-2.5">
    <button
      bind:this={backButton}
      type="button"
      class="btn btn-ghost btn-sm gap-1.5"
      aria-label="Back to chat"
      onclick={onClose}
    >
      <ArrowLeft class="h-4 w-4" aria-hidden="true" />
      <span>Chat</span>
    </button>
    <h1 class="min-w-0 flex-1 truncate text-sm font-medium text-base-content/85">
      {view.title}
      <span class="ml-1.5 text-xs font-normal text-base-content/40">{extension.name}</span>
    </h1>
    <span class="hidden text-[11px] text-base-content/35 sm:inline">Back to return</span>
    <button
      type="button"
      class="btn btn-ghost btn-sm btn-square"
      aria-label="Open apps"
      onclick={onOpenLauncher}
    >
      <Blocks class="h-4 w-4" aria-hidden="true" />
    </button>
  </header>
  <div class="min-h-0 flex-1 overflow-auto">
    <ExtensionSlotHost
      {extension}
      {view}
      {scope}
      {call}
      {subscribe}
      {prompt}
      {draft}
      {confirm}
      {openFile}
      {switchSession}
      {notify}
    />
  </div>
</div>
