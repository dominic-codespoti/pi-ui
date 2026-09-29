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
    AppExtensionSlot,
    AppExtensionSummary,
  } from '#lib/app-extensions/types.js';
  import {
    APP_EXTENSION_SLOT_META,
  } from '#lib/app-extensions/slots.js';
  import type { AppExtensionViewRef } from '#lib/state/app-extensions-state.svelte.js';
  import ExtensionSlotHost from '#lib/components/app-extensions/extension-slot-host.svelte';

  /**
   * Compact apps launcher plus the `right-panel` slot host. Each installed app
   * keeps its enable toggle and contributed view launchers together.
   */
  let {
    extensions,
    activeViews,
    pinnedSidebarViews,
    scope,
    call,
    subscribe,
    prompt,
    draft,
    confirm,
    openFile,
    switchSession,
    onSelectView,
    onClearView,
    onToggleSidebarPin,
    onSetEnabled,
    onReload,
    onRefresh,
    onNotify = () => {},
  }: {
    extensions: AppExtensionSummary[];
    activeViews: Record<AppExtensionSlot, AppExtensionViewRef | null>;
    pinnedSidebarViews: AppExtensionViewRef[];
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
    onSelectView: (slot: AppExtensionSlot, extensionId: string, viewId: string) => void;
    onClearView: (slot: AppExtensionSlot) => void;
    onToggleSidebarPin: (extensionId: string, viewId: string) => void;
    onSetEnabled: (extensionId: string, enabled: boolean) => void;
    onReload: (extensionId: string) => void;
    onRefresh: () => void;
    onNotify?: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void;
  } = $props();

  const rightPanelRef = $derived(activeViews['right-panel']);
  const selectedExtension = $derived(
    rightPanelRef
      ? extensions.find(
          (extension) => extension.id === rightPanelRef.extensionId && extension.enabled
        )
      : undefined
  );
  const selectedContribution = $derived(
    selectedExtension?.views.find(
      (view) => view.id === rightPanelRef?.viewId && view.slot === 'right-panel'
    )
  );

  function isActive(slot: AppExtensionSlot, extensionId: string, viewId: string): boolean {
    const ref = activeViews[slot];
    return ref?.extensionId === extensionId && ref.viewId === viewId;
  }

  function isSidebarPinned(extensionId: string, viewId: string): boolean {
    return pinnedSidebarViews.some(
      (ref) => ref.extensionId === extensionId && ref.viewId === viewId,
    );
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if extensions.length === 0}
    <div class="m-auto flex max-w-sm flex-col items-center gap-2 px-6 py-8 text-center">
      <h2 class="text-sm font-semibold text-base-content/75">No apps installed</h2>
      <button type="button" class="btn btn-xs btn-ghost" onclick={onRefresh}>Refresh</button>
    </div>
  {:else}
    <div class="max-h-[45%] shrink-0 overflow-y-auto border-b border-base-content/8">
      <div class="flex items-center justify-between px-2 pb-1 pt-2">
        <p class="text-[11px] font-medium text-base-content/55">Installed apps</p>
        <button type="button" class="btn btn-xs btn-ghost" onclick={onRefresh}>Refresh</button>
      </div>
      <p class="px-2 pb-1 text-[10px] text-base-content/40">Agent tools update for newly created sessions.</p>
      <div class="space-y-1.5 p-2 pt-1" role="list" aria-label="Installed apps">
        {#each extensions as extension (extension.id)}
          <section
            class="rounded-md border border-base-content/8 bg-base-content/[0.025] p-2"
            role="listitem"
          >
            <div class="flex items-center justify-between gap-2">
              <p class="min-w-0 truncate text-xs text-base-content/75" title={extension.name}>
                {extension.name}
                <span class="text-base-content/40">v{extension.version}</span>
                {#if extension.capabilities?.length}
                  {#each extension.capabilities as capability (capability)}
                    <span
                      class="ml-1 inline-block rounded bg-warning/15 px-1 py-px text-[9px] uppercase tracking-wide text-warning"
                      title="This app declares the sensitive {capability} capability. Review its source before enabling."
                      >{capability}</span
                    >
                  {/each}
                {/if}
              </p>
              <div class="flex shrink-0 items-center gap-1">
                {#if extension.enabled}
                  <button
                    type="button"
                    class="btn btn-xs btn-ghost"
                    title="Re-import {extension.name}'s server code now. Use after editing an
                    enabled extension; single-file client views remount automatically, chunked builds still need a page reload."
                    aria-label="Reload {extension.name}"
                    onclick={() => onReload(extension.id)}
                  >
                    Reload
                  </button>
                {/if}
                <button
                  type="button"
                  class="btn btn-xs {extension.enabled ? 'btn-ghost' : 'btn-outline'}"
                  aria-pressed={extension.enabled}
                  aria-label="{extension.enabled ? 'Disable' : 'Enable'} {extension.name}"
                  onclick={() => onSetEnabled(extension.id, !extension.enabled)}
                >
                  {extension.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>

            {#if extension.views.length > 0}
              <div
                class="mt-1.5 flex flex-wrap gap-1"
                role="group"
                aria-label="{extension.name} views"
              >
                {#each extension.views as view (view.id)}
                  {@const slotMeta = APP_EXTENSION_SLOT_META[view.slot]}
                  {@const active = view.slot !== 'sidebar' && isActive(view.slot, extension.id, view.id)}
                  {@const pinned = view.slot === 'sidebar' && isSidebarPinned(extension.id, view.id)}
                  <button
                    type="button"
                    class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] transition-colors {active || pinned
                      ? 'bg-primary/15 text-primary'
                      : 'bg-base-content/5 text-base-content/65 hover:bg-base-content/10'} disabled:cursor-not-allowed disabled:opacity-40"
                    disabled={!extension.enabled}
                    aria-pressed={active || pinned}
                    aria-label={view.slot === 'sidebar'
                      ? `${pinned ? 'Unpin' : 'Pin'} ${view.title} as a sidebar attachment`
                      : `${active ? 'Close' : 'Open'} ${view.title} in ${slotMeta.label}`}
                    title={view.slot === 'sidebar'
                      ? `${pinned ? 'Remove' : 'Keep'} this view in your local sidebar attachments.`
                      : slotMeta.description}
                    onclick={() => view.slot === 'sidebar'
                      ? onToggleSidebarPin(extension.id, view.id)
                      : active
                        ? onClearView(view.slot)
                        : onSelectView(view.slot, extension.id, view.id)}
                  >
                    <span class="text-[9px] uppercase tracking-wide text-base-content/40"
                      >{view.slot === 'sidebar' ? (pinned ? 'Pinned' : 'Pin') : slotMeta.label}</span
                    >
                    <span>{view.title}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    </div>

    {#if selectedExtension && selectedContribution}
      <div class="flex shrink-0 items-center justify-between gap-2 px-2 py-1.5">
        <p class="min-w-0 truncate text-[11px] text-base-content/45">
          {selectedContribution.title}
          <span class="text-base-content/30">· {selectedExtension.name}</span>
        </p>
        <button
          type="button"
          class="btn btn-xs btn-ghost shrink-0"
          aria-label="Close {selectedContribution.title}"
          onclick={() => onClearView('right-panel')}
        >
          Close
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-auto">
        <ExtensionSlotHost
          extension={selectedExtension}
          view={selectedContribution}
          {scope}
          {call}
          {subscribe}
          {prompt}
          {draft}
          {confirm}
          {openFile}
          {switchSession}
          notify={onNotify}
        />
      </div>
    {/if}
  {/if}
</div>
