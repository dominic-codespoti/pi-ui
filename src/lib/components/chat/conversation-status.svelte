<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Bell from '@lucide/svelte/icons/bell';
  import ShieldQuestion from '@lucide/svelte/icons/shield-question';
  import type { ProjectTrustInfo } from '#lib/ws/protocol.js';
  import { Button } from '#lib/components/ui/button/index.js';

  interface Props {
    wsState: 'connecting' | 'open' | 'closed';
    reconnectCountdown: number;
    trustPromptVisible: boolean;
    projectTrust: ProjectTrustInfo | null;
    showNotifNudge: boolean;
    extensionHeader?: string;
    onReconnect: () => void;
    onTrustProject: () => void;
    onTrustSession: () => void;
    onEnableNotifications: () => void;
    onDismissNotifications: () => void;
    onDismissHeader: () => void;
  }

  let {
    wsState,
    reconnectCountdown,
    trustPromptVisible,
    projectTrust,
    showNotifNudge,
    extensionHeader,
    onReconnect,
    onTrustProject,
    onTrustSession,
    onEnableNotifications,
    onDismissNotifications,
    onDismissHeader,
  }: Props = $props();
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
      <span class="font-mono text-warning/70">{projectTrust.cwd}</span>
      aren't trusted
    </span>
    <button
      class="shrink-0 px-2 py-0.5 rounded-md font-semibold text-warning/90 hover:text-warning hover:bg-warning/15 transition-colors"
      onclick={onTrustProject}>Trust project</button
    >
    <button
      class="shrink-0 px-2 py-0.5 rounded-md font-semibold text-warning/90 hover:text-warning hover:bg-warning/15 transition-colors"
      onclick={onTrustSession}>Trust this session</button
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
      onclick={onDismissNotifications}
      aria-label="Dismiss notification prompt"><X class="w-3 h-3" /></button
    >
  </div>
{/if}

{#if extensionHeader}
  <div
    class="shrink-0 min-w-0 px-3 py-1.5 text-xs text-base-content/60 bg-base-200/50 border-b border-base-content/10 font-mono whitespace-pre-wrap flex items-start gap-2"
  >
    <span class="min-w-0 flex-1 break-words">{extensionHeader}</span>
    <Button variant="ghost" size="icon-xs" onclick={onDismissHeader} aria-label="Dismiss header"
      ><X class="w-3 h-3" /></Button
    >
  </div>
{/if}
