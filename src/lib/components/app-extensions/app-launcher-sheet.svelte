<script lang="ts">
  import type { AppExtensionSlot, AppExtensionSummary } from '#lib/app-extensions/types.js';
  import type { AppExtensionViewRef } from '#lib/state/app-extensions-state.svelte.js';
  import { APP_EXTENSION_SLOT_META } from '#lib/app-extensions/slots.js';
  import { BottomSheet } from '#lib/components/ui/bottom-sheet/index.js';
  import Search from '@lucide/svelte/icons/search';
  import Pin from '@lucide/svelte/icons/pin';
  import Settings2 from '@lucide/svelte/icons/settings-2';

  let {
    open,
    extensions,
    pinnedSidebarViews,
    onOpenView,
    onToggleSidebarPin,
    onManageApps,
    onClose,
  }: {
    open: boolean;
    extensions: AppExtensionSummary[];
    pinnedSidebarViews: AppExtensionViewRef[];
    onOpenView: (slot: AppExtensionSlot, extensionId: string, viewId: string) => void;
    onToggleSidebarPin: (extensionId: string, viewId: string) => void;
    onManageApps: () => void;
    onClose: () => void;
  } = $props();

  let query = $state('');
  const enabledExtensions = $derived(extensions.filter((extension) => extension.enabled));
  const filteredExtensions = $derived.by(() => {
    const normalized = query.trim().toLowerCase();
    return enabledExtensions
      .map((extension) => ({
        extension,
        views: extension.views.filter((view) =>
          !normalized ||
          `${extension.name} ${extension.description ?? ''} ${view.title} ${view.slot}`
            .toLowerCase()
            .includes(normalized),
        ),
      }))
      .filter(({ views }) => views.length > 0);
  });

  function isPinned(extensionId: string, viewId: string): boolean {
    return pinnedSidebarViews.some(
      (ref) => ref.extensionId === extensionId && ref.viewId === viewId,
    );
  }

  function launch(slot: AppExtensionSlot, extensionId: string, viewId: string) {
    onOpenView(slot, extensionId, viewId);
  }
</script>

<BottomSheet open={open} title="Apps" onClose={onClose}>
  <div class="mx-auto flex w-full max-w-2xl flex-col gap-3 px-2 pb-1">
    <div class="flex items-center gap-2 rounded-xl border border-base-content/10 bg-base-content/[0.045] px-3 py-2.5 focus-within:border-primary/45">
      <Search class="h-4 w-4 shrink-0 text-base-content/40" aria-hidden="true" />
      <input
        bind:value={query}
        type="search"
        autocomplete="off"
        spellcheck="false"
        placeholder="Find an app or view…"
        aria-label="Find an app or view"
        class="min-w-0 flex-1 bg-transparent text-sm text-base-content/85 outline-none placeholder:text-base-content/35"
      />
      <button
        type="button"
        class="btn btn-xs btn-ghost shrink-0 gap-1.5"
        onclick={onManageApps}
      >
        <Settings2 class="h-3.5 w-3.5" aria-hidden="true" />
        Manage
      </button>
    </div>

    {#if filteredExtensions.length === 0}
      <div class="rounded-2xl border border-base-content/8 bg-base-content/[0.025] px-4 py-7 text-center">
        <p class="text-sm font-medium text-base-content/70">
          {enabledExtensions.length ? 'No matching app views' : 'No enabled app views'}
        </p>
        <p class="mt-1 text-xs text-base-content/40">
          {enabledExtensions.length
            ? 'Try another search.'
            : 'Enable trusted extensions in Manage apps to make them available here.'}
        </p>
      </div>
    {:else}
      <div class="max-h-[58dvh] overflow-y-auto overscroll-contain space-y-2 pr-0.5" role="list" aria-label="Launchable app views">
        {#each filteredExtensions as { extension, views } (extension.id)}
          <section class="rounded-2xl border border-base-content/8 bg-base-content/[0.025] p-2.5" role="listitem">
            <div class="flex items-baseline justify-between gap-2 px-1 pb-1.5">
              <h3 class="min-w-0 truncate text-xs font-semibold text-base-content/75">{extension.name}</h3>
              <span class="shrink-0 text-[10px] text-base-content/35">v{extension.version}</span>
            </div>
            <div class="grid gap-1.5 sm:grid-cols-2">
              {#each views as view (view.id)}
                {@const pinned = view.slot === 'sidebar' && isPinned(extension.id, view.id)}
                <div class="flex min-w-0 items-center gap-2 rounded-xl border border-base-content/6 bg-base-content/[0.025] px-3 py-2">
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm text-base-content/80">{view.title}</p>
                    <p class="text-[10px] uppercase tracking-wide text-base-content/35">
                      {APP_EXTENSION_SLOT_META[view.slot].label}
                    </p>
                  </div>
                  {#if view.slot === 'sidebar'}
                    <button
                      type="button"
                      class="btn btn-xs shrink-0 gap-1 {pinned ? 'btn-primary' : 'btn-ghost'}"
                      aria-pressed={pinned}
                      aria-label="{pinned ? 'Unpin' : 'Pin'} {view.title} sidebar attachment"
                      onclick={() => onToggleSidebarPin(extension.id, view.id)}
                    >
                      <Pin class="h-3 w-3" aria-hidden="true" />
                      {pinned ? 'Pinned' : 'Pin'}
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="btn btn-xs shrink-0"
                      aria-label="Open {view.title} {view.slot === 'workspace' ? 'workspace' : 'in the right panel'}"
                      onclick={() => launch(view.slot, extension.id, view.id)}
                    >
                      Open
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</BottomSheet>
