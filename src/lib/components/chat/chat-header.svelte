<script lang="ts">
  import * as Tooltip from '#lib/components/ui/tooltip/index.js';
  import { fmtTokens, fmtCost } from '#lib/utils.js';
  import type { ModelInfo } from '#lib/ws/protocol.js';

  import BookOpen from '@lucide/svelte/icons/book-open';
  import Wrench from '@lucide/svelte/icons/wrench';

  let {
    wsState,
    sessionMode,
    piVersion,
    uiVersion,
    isRestarting = false, // eslint-disable-line @typescript-eslint/no-unused-vars -- reserved for restarting pill
    sessionName,
    activeProjectName,
    model = null,
    thinkingLevel = 'off',
    effectiveContextTokens = 0,
    contextPercent = 0,
    contextUsageWindow = 0,
    sessionTokens = 0,
    sessionCostTotal = 0,
    sessionDuration = '',
    isMobile = false,
    showSessionPanel = false,
    showRightPanel = false,
    rightPanelTab = 'models',
    showSettingsPanel = false,
    installReady = false,
    onToggleSessionPanel = () => {},
    onOpenRightTab = () => {},
    onToggleSettingsPanel = () => {},
    onInstallApp = () => {},
  }: {
    wsState: 'connecting' | 'open' | 'closed';
    sessionMode?: string;
    piVersion: string;
    uiVersion: string;
    isRestarting?: boolean;
    sessionName?: string;
    activeProjectName?: string;
    model?: ModelInfo | null;
    thinkingLevel?: string;
    effectiveContextTokens?: number;
    contextPercent?: number;
    contextUsageWindow?: number;
    sessionTokens?: number;
    sessionCostTotal?: number;
    sessionDuration?: string;
    isMobile?: boolean;
    showSessionPanel?: boolean;
    showRightPanel?: boolean;
    rightPanelTab?: 'models' | 'tools' | 'skills';
    showSettingsPanel?: boolean;
    installReady?: boolean;
    onToggleSessionPanel?: () => void;
    onOpenRightTab?: (tab: 'models' | 'tools' | 'skills') => void;
    onToggleSettingsPanel?: () => void;
    onInstallApp?: () => void;
  } = $props();
</script>

<header
  class="relative shrink-0 min-h-14 flex items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 bg-[radial-gradient(ellipse_70%_100%_at_50%_0%,color-mix(in_oklch,var(--color-primary)_6%,transparent),transparent_75%),color-mix(in_oklch,var(--color-base-200)_86%,black_8%)] shadow-sm shadow-black/10"
  style="padding-top: env(safe-area-inset-top, 0px);"
>
  <div class="absolute inset-x-0 bottom-0 hairline-x pointer-events-none"></div>
  <div class="relative z-10 flex items-center gap-1.5 shrink-0">
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            onclick={onToggleSessionPanel}
            class="{isMobile
              ? 'h-10 w-10'
              : 'h-9 w-9'} flex items-center justify-center rounded-lg transition-colors {showSessionPanel
              ? 'text-primary bg-primary/12'
              : 'text-base-content/60 hover:text-base-content/90 hover:bg-base-content/8'}"
            aria-label="Toggle session panel"
            aria-expanded={showSessionPanel}
            ><svg
              class="w-[18px] h-[18px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="3" y="4" width="18" height="16" rx="2"></rect>
              <path d="M9 4v16"></path>
            </svg>
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">Sessions</Tooltip.Content>
    </Tooltip.Root>
  </div>

  <button
    onclick={() => onOpenRightTab('models')}
    class="absolute left-1/2 top-0 bottom-0 z-0 w-[min(52rem,calc(100vw-12.5rem))] sm:w-[min(52rem,calc(100vw-8.5rem))] -translate-x-1/2 min-w-0 flex flex-col items-center justify-center px-2 sm:px-3 text-center rounded-t-none sm:rounded-t-xl border-x border-transparent hover:bg-base-content/[0.035] transition-colors"
    aria-label="Open model and provider panel"
    aria-expanded={showRightPanel && rightPanelTab === 'models'}
  >
    <span class="max-w-full text-sm sm:text-[15px] leading-tight text-base-content/82 truncate">
      {sessionName || activeProjectName || 'New chat'}
    </span>
    <span
      class="hidden sm:flex max-w-full items-center justify-center gap-1.5 text-[11px] leading-tight text-base-content/38 truncate"
    >
      <span class="truncate">{model?.provider || 'no provider'}</span>
      {#if model?.name}<span class="text-base-content/40">›</span><span class="truncate"
          >{model.name}</span
        >{/if}
      {#if thinkingLevel !== 'off'}<span class="text-success/65">{thinkingLevel}</span>{/if}
    </span>
  </button>

  <div class="relative z-10 flex items-center gap-1.5 shrink-0 ml-auto">
    {#if effectiveContextTokens > 0}
      <Tooltip.Root>
        <Tooltip.Trigger
          class={[
            'h-9 hidden md:flex items-center gap-2 rounded-xl px-3 border text-xs tabular-nums cursor-default transition-colors',
            contextPercent >= 75
              ? 'bg-error/8 border-error/18 text-error/70'
              : contextPercent >= 50
                ? 'bg-warning/8 border-warning/18 text-warning/70'
                : 'bg-base-content/[0.055] border-base-content/8 text-base-content/65',
          ].join(' ')}
        >
          <span class="relative flex h-4 w-4 items-center justify-center">
            <span
              class={[
                'absolute inset-0 rounded-full border-2 transition-colors',
                contextPercent >= 75
                  ? 'border-error/40'
                  : contextPercent >= 50
                    ? 'border-warning/40'
                    : 'border-success/35',
              ].join(' ')}
            ></span>
            <span
              class={[
                'h-1.5 w-1.5 rounded-full transition-colors',
                contextPercent >= 75
                  ? 'bg-error/70'
                  : contextPercent >= 50
                    ? 'bg-warning/70'
                    : 'bg-success/70',
              ].join(' ')}
            ></span>
          </span>
          <span
            >{contextPercent > 0 ? `${contextPercent}%` : fmtTokens(effectiveContextTokens)}</span
          >
        </Tooltip.Trigger>
        <Tooltip.Content sideOffset={8} class="min-w-[180px]">
          <div class="flex flex-col gap-2 py-0.5">
            <div class="flex items-center justify-between gap-3">
              <span class="text-background/60">Context</span>
              <span class="font-medium"
                >{contextPercent > 0
                  ? `${contextPercent}%`
                  : fmtTokens(effectiveContextTokens)}</span
              >
            </div>
            <div class="w-full h-1.5 rounded-full bg-background/15 overflow-hidden">
              <div
                class={[
                  'h-full rounded-full transition-all',
                  contextPercent >= 75
                    ? 'bg-error/70'
                    : contextPercent >= 50
                      ? 'bg-warning/70'
                      : 'bg-background/70',
                ].join(' ')}
                style="width: {Math.min(contextPercent, 100)}%"
              ></div>
            </div>
            <div class="flex items-center justify-between text-background/60">
              <span>{effectiveContextTokens.toLocaleString()}</span>
              {#if contextUsageWindow > 0 || model?.contextWindow}
                <span
                  >/ {(
                    (contextUsageWindow > 0 ? contextUsageWindow : null) ??
                    model?.contextWindow ??
                    0
                  ).toLocaleString()} tokens</span
                >
              {/if}
            </div>
            {#if sessionTokens > 0}
              <div
                class="flex items-center justify-between border-t border-background/10 pt-1.5 mt-0.5"
              >
                <span class="text-background/45">Session</span>
                <span class="text-background/70">{sessionTokens.toLocaleString()} tokens</span>
              </div>
            {/if}
            {#if sessionCostTotal > 0}
              <div class="flex items-center justify-between">
                <span class="text-background/45">Cost</span>
                <span class="text-background/70">{fmtCost(sessionCostTotal)}</span>
              </div>
            {/if}
            {#if sessionDuration}
              <div
                class="flex items-center justify-between border-t border-background/10 pt-1.5 mt-0.5"
              >
                <span class="text-background/45">Elapsed</span>
                <span class="text-background/70">{sessionDuration}</span>
              </div>
            {/if}
          </div>
        </Tooltip.Content>
      </Tooltip.Root>
    {/if}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            onclick={() => onOpenRightTab('skills')}
            class="h-9 w-9 hidden sm:flex items-center justify-center rounded-lg transition-colors {showRightPanel &&
            rightPanelTab === 'skills'
              ? 'text-primary bg-primary/12'
              : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'}"
            aria-label="Toggle resources panel"
            aria-expanded={showRightPanel && rightPanelTab === 'skills'}
            ><BookOpen class="w-4 h-4" /></button
          >
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">Skills & Prompts</Tooltip.Content>
    </Tooltip.Root>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            onclick={() => onOpenRightTab('tools')}
            class="{isMobile
              ? 'h-10 w-10'
              : 'h-9 w-9'} flex items-center justify-center rounded-lg transition-colors {showRightPanel &&
            rightPanelTab === 'tools'
              ? 'text-primary bg-primary/12'
              : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'}"
            aria-label="Toggle tools panel"
            aria-expanded={showRightPanel && rightPanelTab === 'tools'}
            ><Wrench class="w-4 h-4" /></button
          >
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">Tools</Tooltip.Content>
    </Tooltip.Root>
    {#if installReady}
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              onclick={onInstallApp}
              class="h-9 w-9 flex items-center justify-center rounded-lg transition-colors text-base-content/45 hover:text-primary hover:bg-primary/12"
              aria-label="Install app"
              ><svg
                class="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M12 3v13"></path>
                <path d="m5 13 7 7 7-7"></path>
                <path d="M5 21h14"></path>
              </svg>
            </button>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="bottom">Install App</Tooltip.Content>
      </Tooltip.Root>
    {/if}
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            onclick={onToggleSettingsPanel}
            class="{isMobile
              ? 'h-10 w-10'
              : 'h-9 w-9'} flex items-center justify-center rounded-lg transition-colors {showSettingsPanel
              ? 'text-primary bg-primary/12'
              : 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'}"
            aria-label="Open settings"
            aria-expanded={showSettingsPanel}
            ><svg
              class="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"></path>

              <path
                d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.4.2.7.5.9.9.2.3.4.7.4 1.1V11a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"
              ></path>
            </svg>
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom">Settings</Tooltip.Content>
    </Tooltip.Root>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <button
            {...props}
            class="h-9 w-9 hidden sm:flex items-center justify-center rounded-lg transition-colors relative {wsState ===
            'open'
              ? 'text-base-content/45 hover:text-base-content/75 hover:bg-base-content/8'
              : wsState === 'connecting'
                ? 'text-warning/50 hover:text-warning/70 hover:bg-warning/8'
                : 'text-error/50 hover:text-error/70 hover:bg-error/8'}"
            aria-label="Connection info"
            ><svg
              class="w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M4 5h16"></path>
              <path d="M7 5v11a2 2 0 0 0 2 2h2"></path>
              <path d="M13 5v11a2 2 0 0 0 2 2h2"></path>
            </svg>

            <span
              class="absolute top-0.5 right-0.5 w-2 h-2 rounded-full border border-base-100 {wsState ===
              'open'
                ? 'bg-success glow-success'
                : wsState === 'connecting'
                  ? 'bg-warning animate-pulse'
                  : 'bg-error'}"
            ></span>
          </button>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content sideOffset={8} class="min-w-[180px]">
        <div class="flex flex-col gap-2 py-0.5">
          <div class="flex items-center justify-between gap-3">
            <span class="text-background/60">Connection</span>
            <span class="flex items-center gap-1.5 font-medium">
              <span
                class="w-1.5 h-1.5 rounded-full {wsState === 'open'
                  ? 'bg-success'
                  : wsState === 'connecting'
                    ? 'bg-warning animate-pulse'
                    : 'bg-error'}"
              ></span>
              {wsState === 'open'
                ? 'Connected'
                : wsState === 'connecting'
                  ? 'Connecting'
                  : 'Disconnected'}
            </span>
          </div>
          {#if sessionMode}
            <div class="flex items-center justify-between gap-3">
              <span class="text-background/60">Session</span>
              <span class="font-medium">{sessionMode}</span>
            </div>
          {/if}
          {#if piVersion}
            <div class="flex items-center justify-between gap-3">
              <span class="text-background/60">SDK</span>
              <span class="font-medium">v{piVersion}</span>
            </div>
          {/if}
          {#if uiVersion}
            <div class="flex items-center justify-between gap-3">
              <span class="text-background/60">UI</span>
              <span class="font-medium">v{uiVersion}</span>
            </div>
          {/if}
        </div>
      </Tooltip.Content>
    </Tooltip.Root>
  </div>
</header>
