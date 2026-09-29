<script lang="ts">
  import type {
    AppExtensionCall,
    AppExtensionEventListener,
  } from '#lib/app-extensions/transport.js';
  import type { AppExtensionScope } from '#lib/app-extensions/types.js';
  import type {
    AppExtensionHostPrompt,
    AppExtensionHostDraft,
    AppExtensionHostConfirm,
    AppExtensionHostOpenFile,
    AppExtensionHostSwitchSession,
  } from '#lib/app-extensions/client-loader.js';
  import type {
    AppExtensionResolvedView,
    AppExtensionViewRef,
  } from '#lib/state/app-extensions-state.svelte.js';

  /**
   * Lazy-mounting wrapper for the projects sidebar — loaded on first open (or
   * prefetched on idle). The sidebar shell stays mounted for the width
   * transition; only the heavy project/session tree is deferred.
   */
  let {
    open,
    canFork = false,
    onFork,
    onRequestConfirm = () => {},
    appExtensionViews = [],
    appScope = {},
    appCall = null,
    appSubscribe = null,
    appPrompt = null,
    appDraft = null,
    appConfirm = null,
    appOpenFile = null,
    appSwitchSession = null,
    appNotify = () => {},
    onUnpinAppView = () => {},
    onMoveAppViewPin = () => {},
  }: {
    open: boolean;
    canFork?: boolean;
    onFork: () => void;
    onRequestConfirm: (
      message: string,
      onConfirm: () => void,
      opts?: { title?: string; confirmLabel?: string; variant?: 'error' | 'warning' | 'info' }
    ) => void;
    appExtensionViews?: AppExtensionResolvedView[];
    appScope?: AppExtensionScope;
    appCall?: AppExtensionCall | null;
    appSubscribe?:
      | ((
          extensionId: string,
          eventName: string,
          listener: AppExtensionEventListener,
          scope: AppExtensionScope
        ) => () => void)
      | null;
    appPrompt?: AppExtensionHostPrompt | null;
    appDraft?: AppExtensionHostDraft | null;
    appConfirm?: AppExtensionHostConfirm | null;
    appOpenFile?: AppExtensionHostOpenFile | null;
    appSwitchSession?: AppExtensionHostSwitchSession | null;
    appNotify?: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void;
    onUnpinAppView?: (extensionId: string, viewId: string) => void;
    onMoveAppViewPin?: (ref: AppExtensionViewRef, targetIndex: number) => void;
  } = $props();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic component type
  let Cmp = $state<any>(null);
  $effect(() => {
    if (open && !Cmp) {
      import('./projects-sidebar.svelte').then((m) => (Cmp = m.default)).catch(() => {});
    }
  });
</script>

{#if Cmp}
  <Cmp
    {open}
    {canFork}
    {onFork}
    {onRequestConfirm}
    {appExtensionViews}
    {appScope}
    {appCall}
    {appSubscribe}
    {appPrompt}
    {appDraft}
    {appConfirm}
    {appOpenFile}
    {appSwitchSession}
    {appNotify}
    {onUnpinAppView}
    {onMoveAppViewPin}
  />
{/if}
