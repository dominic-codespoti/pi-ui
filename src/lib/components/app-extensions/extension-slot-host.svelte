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
  import AppExtensionViewHost from './view-host.svelte';

  /**
   * Binds the shared transport-level call/subscribe functions to the mounted
   * extension ID, so every slot host dispatches operations and events for its
   * own extension — never a globally selected view. Each instance owns an
   * independent ViewHost (and therefore independent subscription teardown).
   */
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
      scope: AppExtensionScope
    ) => () => void;
    notify?: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void;
  } = $props();

  function boundCall(
    kind: 'read' | 'action',
    operationId: string,
    input: Record<string, unknown> | undefined,
    operationScope: AppExtensionScope,
    signal?: AbortSignal
  ) {
    return call(kind, extension.id, operationId, input, operationScope, signal);
  }

  function boundSubscribe(
    eventName: string,
    listener: AppExtensionEventListener,
    eventScope: AppExtensionScope
  ) {
    return subscribe(extension.id, eventName, listener, eventScope);
  }
</script>

{#if extension.clientUrl}
  <AppExtensionViewHost
    extensionId={extension.id}
    viewId={view.id}
    clientUrl={extension.clientUrl}
    {scope}
    call={boundCall}
    subscribe={boundSubscribe}
    {prompt}
    {draft}
    {confirm}
    {openFile}
    {switchSession}
    {notify}
  />
{:else}
  <p class="m-auto px-6 py-10 text-center text-xs text-base-content/50">
    The extension client bundle is unavailable.
  </p>
{/if}
