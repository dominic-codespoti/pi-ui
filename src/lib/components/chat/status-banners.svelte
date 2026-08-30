<script lang="ts">
  import type { ProjectTrustInfo } from '#lib/ws/protocol.js';

  import ShieldQuestion from '@lucide/svelte/icons/shield-question';
  import Bell from '@lucide/svelte/icons/bell';
  import X from '@lucide/svelte/icons/x';

  let {
    wsState,
    reconnectCountdown = 0,
    projectTrust = null,
    trustPromptVisible = false,
    showNotifNudge = false,
    onReconnect = () => {},
    onTrust = () => {},
    onEnableNotifications = () => {},
    onDismissNudge = () => {},
  }: {
    wsState: 'connecting' | 'open' | 'closed';
    reconnectCountdown?: number;
    projectTrust?: ProjectTrustInfo | null;
    trustPromptVisible?: boolean;
    showNotifNudge?: boolean;
    onReconnect?: () => void;
    onTrust?: (decision: 'trusted' | 'session') => void;
    onEnableNotifications?: () => void;
    onDismissNudge?: () => void;
  } = $props();
</script>

{#if wsState === 'closed'}
  <div
    class="shrink-0 flex items-center justify-center gap-3 px-3 py-2 text-xs bg-error/10 text-error/80 border-b border-error/15"
    role="status"
    aria-live="polite"
  >
    <span class="w-1.5 h-1.5 rounded-full bg-error animate-pulse"></span>

    <span
      >disconnected{reconnectCountdown > 0 ? ` — reconnecting in ${reconnectCountdown}s` : ''}</span
    >

    <button
      onclick={onReconnect}
      class="ml-auto shrink-0 px-2 py-0.5 rounded-md font-semibold text-error/90 hover:text-error hover:bg-error/15 transition-colors"
      >Reconnect now</button
    >
  </div>
{:else if wsState === 'connecting'}
  <div
    class="shrink-0 flex items-center justify-center gap-2 px-3 py-2 text-xs bg-warning/10 text-warning/80 border-b border-warning/15"
    role="status"
    aria-live="polite"
  >
    <span class="w-1.5 h-1.5 rounded-full bg-warning animate-pulse"></span>
    <span class="flex items-center gap-1">
      reconnecting
      {#if reconnectCountdown > 0}
        <span class="tabular-nums ml-0.5">({reconnectCountdown}s)</span>
      {/if}
    </span>
  </div>
{/if}

{#if trustPromptVisible && projectTrust}
  <div
    class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs bg-warning/10 text-warning/85 border-b border-warning/15"
    role="status"
    aria-live="polite"
  >
    <ShieldQuestion class="w-3.5 h-3.5 shrink-0" />
    <span class="flex-1 min-w-0 truncate">
      Project resources in
      <span class="font-mono text-warning/70">{projectTrust?.cwd}</span>
      aren't trusted
    </span>
    <button
      class="shrink-0 px-2 py-0.5 rounded-md font-semibold text-warning/90 hover:text-warning hover:bg-warning/15 transition-colors"
      onclick={() => onTrust('trusted')}>Trust project</button
    >
    <button
      class="shrink-0 px-2 py-0.5 rounded-md font-semibold text-warning/90 hover:text-warning hover:bg-warning/15 transition-colors"
      onclick={() => onTrust('session')}>Trust this session</button
    >
  </div>
{/if}

{#if showNotifNudge}
  <div
    class="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs bg-primary/[0.08] text-base-content/80 border-b border-primary/15"
    role="status"
  >
    <Bell class="w-3.5 h-3.5 shrink-0 text-primary/80" />
    <span class="flex-1 min-w-0 truncate"
      >Get a notification when pi finishes — even with the app closed.</span
    >
    <button
      class="shrink-0 px-2 py-0.5 rounded-md font-semibold text-primary hover:text-primary/90 hover:bg-primary/12 transition-colors"
      onclick={onEnableNotifications}>Enable</button
    >
    <button
      class="shrink-0 px-2 py-0.5 rounded-md text-base-content/50 hover:text-base-content/80 hover:bg-base-content/8 transition-colors"
      onclick={onDismissNudge}
      aria-label="Dismiss notification prompt"><X class="w-3 h-3" /></button
    >
  </div>
{/if}
