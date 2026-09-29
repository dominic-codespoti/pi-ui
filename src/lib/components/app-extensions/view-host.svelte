<script lang="ts">
  import { untrack } from 'svelte';
  import type { AppExtensionScope } from '#lib/app-extensions/types.js';
  import {
    buildAppExtensionClientApi,
    loadAppExtensionClientModule,
    teardownAppExtensionClient,
    type AppExtensionClientCleanup,
    type AppExtensionHostCall,
    type AppExtensionHostNotify,
    type AppExtensionHostSubscribe,
    type AppExtensionHostPrompt,
    type AppExtensionHostDraft,
    type AppExtensionHostConfirm,
    type AppExtensionHostOpenFile,
    type AppExtensionHostSwitchSession,
    trackAppExtensionSubscriptions,
  } from '#lib/app-extensions/client-loader.js';

  interface Props {
    extensionId: string;
    viewId: string;
    /** Versioned runtime ESM bundle URL for this extension's client entry. */
    clientUrl: string;
    scope: AppExtensionScope;
    call: AppExtensionHostCall;
    subscribe: AppExtensionHostSubscribe;
    prompt: AppExtensionHostPrompt;
    draft: AppExtensionHostDraft;
    confirm: AppExtensionHostConfirm;
    openFile: AppExtensionHostOpenFile;
    switchSession: AppExtensionHostSwitchSession;
    notify?: AppExtensionHostNotify;
  }

  let {
    extensionId,
    viewId,
    clientUrl,
    scope,
    call,
    subscribe,
    prompt,
    draft,
    confirm,
    openFile,
    switchSession,
    notify,
  }: Props = $props();

  /** Container the extension client mounts into. */
  let host = $state<HTMLElement | null>(null);
  /** Contained load/mount failure — rendered inline, never thrown. */
  let error = $state<string | null>(null);
  /** Bumped by the retry button to re-run the load effect. */
  let retryNonce = $state(0);

  $effect(() => {
    const url = clientUrl;
    const extId = extensionId;
    // Tracked so switching views remounts even when the bundle URL is shared.
    const vId = viewId;
    // Live scope provider: reads the current prop value per call WITHOUT
    // subscribing, so project/session switches no longer remount the view.
    const getViewScope = () => untrack(() => ({ ...scope }));
    const doCall = call;
    const doSubscribe = subscribe;
    const doPrompt = prompt;
    const doDraft = draft;
    const doConfirm = confirm;
    const doOpenFile = openFile;
    const doSwitchSession = switchSession;
    const doNotify = notify;
    const root = host;
    void vId;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- retry trigger
    retryNonce;
    if (!root) return;
    if (!url) {
      error = 'Extension client is unavailable (missing client URL).';
      return;
    }
    let cancelled = false;
    let mounted: AppExtensionClientCleanup = undefined;
    const eventSubscriptions = trackAppExtensionSubscriptions(doSubscribe);
    error = null;
    void (async () => {
      try {
        const module = await loadAppExtensionClientModule(url);
        if (cancelled) return;
        const api = buildAppExtensionClientApi({
          extensionId: extId,
          scope: getViewScope,
          call: doCall,
          subscribe: eventSubscriptions.subscribe,
          prompt: doPrompt,
          draft: doDraft,
          confirm: doConfirm,
          openFile: doOpenFile,
          switchSession: doSwitchSession,
          notify: doNotify,
        });
        mounted = module.mount(root, api);
      } catch (mountError) {
        eventSubscriptions.cleanup();
        if (!cancelled) {
          error =
            mountError instanceof Error ? mountError.message : 'Failed to load extension view.';
        }
      }
    })();
    return () => {
      cancelled = true;
      const rootAtCleanup = root;
      teardownAppExtensionClient(mounted);
      mounted = undefined;
      eventSubscriptions.cleanup();
      // Drop any DOM a misbehaving client left behind so the next mount starts clean.
      try {
        rootAtCleanup.replaceChildren();
      } catch {
        /* best-effort container reset */
      }
    };
  });
</script>

<div
  class="app-extension-view-host min-h-0 min-w-0 select-text"
  data-extension-id={extensionId}
  data-view-id={viewId}
>
  {#if error}
    <div role="alert" class="m-2 rounded-md border border-error/30 bg-error/10 p-3 text-sm">
      <p class="font-medium">Extension view failed to load</p>
      <p class="mt-1 text-base-content/70">{error}</p>
      <button
        type="button"
        class="btn btn-xs btn-ghost mt-2"
        onclick={() => {
          error = null;
          retryNonce += 1;
        }}
      >
        Retry
      </button>
    </div>
  {/if}
  <div bind:this={host} class="min-h-0 min-w-0 select-text"></div>
</div>

<style>
  :global(.app-extension-view-host),
  :global(.app-extension-view-host *) {
    -webkit-user-select: text;
    user-select: text;
  }
</style>
