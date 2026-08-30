<script lang="ts">
  import { resolve } from '$app/paths';
  import type { ClientMessage } from '#lib/ws/protocol.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import * as Select from '#lib/components/ui/select/index.js';
  import * as Card from '#lib/components/ui/card/index.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import { Switch } from '#lib/components/ui/switch/index.js';
  import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Keyboard from '@lucide/svelte/icons/keyboard';
  import Blocks from '@lucide/svelte/icons/blocks';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import PiIcon from '@lucide/svelte/icons/pi';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import PackageOpen from '@lucide/svelte/icons/package-open';
  import Bell from '@lucide/svelte/icons/bell';
  import type {
    ExtensionSummary,
    UpdateStatus,
    UpdateTarget,
    ProjectTrustInfo,
    RuntimeDiagnostic,
    ConfiguredPackageInfo,
    PackageUpdateInfo,
    PackageProgress,
    SessionStats,
  } from '#lib/ws/protocol.js';
  import type { NotificationPrefs } from '#lib/notification-prefs.js';
  import { versionText, fmtCost } from '#lib/utils.js';

  const SETTINGS_SECTIONS = [
    { id: 'session', label: 'Session', icon: SlidersHorizontal },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
    { id: 'extensions', label: 'Extensions', icon: Blocks },
    { id: 'packages', label: 'Packages', icon: PackageOpen },
    { id: 'updates', label: 'Updates', icon: RefreshCw },
    { id: 'about', label: 'About', icon: PiIcon },
  ] as const;

  const THEMES: { id: string; name: string }[] = [
    { id: 'pi', name: 'Pi' },
    { id: 'night', name: 'Night' },
    { id: 'dark', name: 'Dark' },
    { id: 'dracula', name: 'Dracula' },
    { id: 'synthwave', name: 'Synthwave' },
    { id: 'forest', name: 'Forest' },
    { id: 'luxury', name: 'Luxury' },
    { id: 'coffee', name: 'Coffee' },
    { id: 'sunset', name: 'Sunset' },
    { id: 'dim', name: 'Dim' },
    { id: 'black', name: 'Black' },
    { id: 'nord', name: 'Nord' },
    { id: 'abyss', name: 'Abyss' },
    { id: 'winter', name: 'Winter' },
    { id: 'emerald', name: 'Emerald' },
  ];

  const SHORTCUTS = [
    { keys: 'Ctrl / Cmd + /', action: 'Toggle sessions' },
    { keys: 'Ctrl / Cmd + K', action: 'Toggle model picker' },
    { keys: 'Ctrl / Cmd + T', action: 'Open thinking level' },
    { keys: 'Ctrl / Cmd + Shift + T', action: 'Cycle thinking level' },
    { keys: 'Escape', action: 'Close modal or panel' },
    { keys: 'Enter', action: 'Send from composer' },
    { keys: 'Shift + Enter', action: 'New line in composer' },
    { keys: '/', action: 'Open slash menu' },
    { keys: '@', action: 'Attach file context' },
  ];

  let {
    showSettingsPanel = $bindable(false),
    settingsSection = $bindable('session'),
    uiVersion = '',
    piVersion = '',
    cwd = '',
    wsState = 'closed',
    autoCompactionEnabled = $bindable(true),
    autoRetryEnabled = $bindable(true),
    projectTrust = null,
    runtimeDiagnostics = [],
    notificationPrefs = $bindable(),
    notificationWebhookUrl = $bindable(''),
    extensionsLoaded = false,
    extensionsList = [],
    extensionErrors = [],
    packageSource = $bindable(''),
    packageScope = $bindable('user'),
    packageBusy = $bindable(false),
    packageProgress = null,
    packagesLoaded = false,
    packagesList = [],
    packageUpdates = [],
    updateStatus = null,
    updateLoading = false,
    updateRunning = false,
    updateTarget = null,
    updateFeedback = null,
    updateLog = '',
    selectedTheme = 'pi',
    sessionStats = null,
    exportFeedback = null,
    send,
    setTheme,
    refreshUpdateStatus,
    runUpdate,
    restartServer,
  }: {
    showSettingsPanel?: boolean;
    settingsSection?:
      'session' | 'notifications' | 'shortcuts' | 'extensions' | 'packages' | 'updates' | 'about';
    uiVersion?: string;
    piVersion?: string;
    cwd?: string;
    wsState?: 'connecting' | 'open' | 'closing' | 'closed';
    autoCompactionEnabled?: boolean;
    autoRetryEnabled?: boolean;
    projectTrust?: ProjectTrustInfo | null;
    runtimeDiagnostics?: RuntimeDiagnostic[];
    notificationPrefs: NotificationPrefs;
    notificationWebhookUrl?: string;
    extensionsLoaded?: boolean;
    extensionsList?: ExtensionSummary[];
    extensionErrors?: { path: string; error: string }[];
    packageSource?: string;
    packageScope?: 'user' | 'project';
    packageBusy?: boolean;
    packageProgress?: PackageProgress | null;
    packagesLoaded?: boolean;
    packagesList?: ConfiguredPackageInfo[];
    packageUpdates?: PackageUpdateInfo[];
    updateStatus?: UpdateStatus | null;
    updateLoading?: boolean;
    updateRunning?: boolean;
    updateTarget?: UpdateTarget | null;
    updateFeedback?: {
      success: boolean;
      message: string;
      restartRequired?: boolean;
      reloadRequired?: boolean;
    } | null;
    updateLog?: string;
    selectedTheme?: string;
    sessionStats?: SessionStats | null;
    exportFeedback?: string | null;
    send: (msg: ClientMessage) => boolean | void;
    setTheme: (t: string) => void;
    refreshUpdateStatus: () => void;
    runUpdate: (target: UpdateTarget) => void;
    restartServer: (reloadPage?: boolean) => void;
  } = $props();
</script>

<Dialog.Root bind:open={showSettingsPanel}>
  <Dialog.Content
    class="p-0 overflow-hidden max-w-[calc(100vw-1rem)] sm:max-w-[min(68rem,calc(100vw-2rem))] h-[fit-content(calc(100dvh-2rem))] sm:h-[min(44rem,calc(100dvh-2rem))] bg-base-200 text-base-content border border-base-content/10 shadow-2xl shadow-black/40"
    showCloseButton={false}
  >
    <div class="flex h-full min-h-0">
      <aside
        class="hidden sm:flex w-60 shrink-0 flex-col border-r border-base-content/10 bg-base-300/70"
      >
        <div class="px-5 py-4 border-b border-base-content/8">
          <p class="text-sm font-semibold text-base-content/80">Settings</p>
          <p class="text-xs text-base-content/35 mt-0.5">pi-ui preferences</p>
        </div>
        <nav class="flex-1 p-2 space-y-1">
          {#each SETTINGS_SECTIONS as section (section.id)}
            <button
              onclick={() => (settingsSection = section.id)}
              class="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors {settingsSection ===
              section.id
                ? 'bg-base-content/10 text-base-content'
                : 'text-base-content/62 hover:text-base-content/85 hover:bg-base-content/[0.055]'}"
            >
              <span class="w-5 flex items-center justify-center text-base-content/45"
                ><section.icon class="w-4 h-4" /></span
              >
              <span>{section.label}</span>
            </button>
          {/each}
        </nav>
        <div class="px-5 py-3 border-t border-base-content/8 space-y-1.5">
          <a
            href={resolve('logout')}
            class="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-base-content/45 hover:text-base-content/85 hover:bg-base-content/[0.055] transition-colors"
          >
            Sign out
          </a>
          <div class="text-[10px] text-base-content/32 font-mono">
            {uiVersion ? `pi-ui v${uiVersion}` : 'pi-ui'}
          </div>
        </div>
      </aside>

      <div
        class="flex-1 min-w-0 min-h-0 flex flex-col bg-[radial-gradient(circle_at_30%_25%,color-mix(in_oklch,var(--color-primary)_8%,transparent),transparent_35%),var(--color-base-200)]"
      >
        <header
          class="shrink-0 flex flex-col gap-1.5 px-4 sm:px-6 py-3 sm:py-4 border-b border-base-content/10"
        >
          <div class="flex items-center gap-3">
            <Select.Root
              type="single"
              value={settingsSection}
              onValueChange={(v: string) => {
                if (v) settingsSection = v as typeof settingsSection;
              }}
            >
              <Select.Trigger size="sm" class="sm:hidden w-40 text-xs">
                {SETTINGS_SECTIONS.find((s) => s.id === settingsSection)?.label ?? 'Settings'}
              </Select.Trigger>
              <Select.Content>
                {#each SETTINGS_SECTIONS as section (section.id)}
                  <Select.Item value={section.id}>{section.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <Dialog.Title
              class="sr-only sm:not-sr-only sm:min-w-0 sm:flex-1 sm:truncate text-base font-semibold text-base-content/82"
            >
              {SETTINGS_SECTIONS.find((s) => s.id === settingsSection)?.label ?? 'Settings'}
            </Dialog.Title>
            <span class="flex-1 sm:hidden"></span>
            <Button
              variant="ghost"
              size="icon"
              class="shrink-0"
              onclick={() => (showSettingsPanel = false)}
              aria-label="Close settings"
            >
              <svg
                class="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg
              >
            </Button>
          </div>
          <Dialog.Description class="text-xs text-base-content/45 sm:text-base-content/38">
            {#if settingsSection === 'session'}Defaults and behavior for session runs{:else if settingsSection === 'notifications'}Configure
              PWA push and page notifications{:else if settingsSection === 'shortcuts'}Keyboard
              shortcuts available in the chat UI{:else if settingsSection === 'extensions'}Loaded
              extensions and their tools/commands{:else if settingsSection === 'packages'}Manage SDK
              extension packages{:else if settingsSection === 'updates'}Check and apply pi-ui or SDK
              updates{:else}Runtime information and server controls{/if}
          </Dialog.Description>
        </header>

        <ScrollArea class="flex-1 min-h-0">
          <div class="max-w-3xl px-4 sm:px-8 py-6 space-y-6">
            {#if settingsSection === 'session'}
              <Card.Root
                size="sm"
                class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
              >
                <div class="divide-y divide-base-content/8">
                  <div class="flex items-center gap-3 px-4 py-3">
                    <div class="flex-1 min-w-0">
                      <p class="text-sm text-base-content/75">Auto-compact</p>
                      <p class="text-xs text-base-content/35 mt-0.5">
                        Let pi compress context before it gets too large.
                      </p>
                    </div>
                    <Switch
                      checked={autoCompactionEnabled}
                      onCheckedChange={(v) => {
                        autoCompactionEnabled = v;
                        try {
                          localStorage.setItem(
                            'pifrontier:autoCompactionEnabled',
                            JSON.stringify(v)
                          );
                        } catch {
                          /* noop */
                        }
                        send({ type: 'set_auto_compaction', enabled: v });
                      }}
                      disabled={wsState !== 'open'}
                      aria-label="Toggle auto-compaction"
                    />
                  </div>
                  <div class="flex items-center gap-3 px-4 py-3">
                    <div class="flex-1 min-w-0">
                      <p class="text-sm text-base-content/75">Auto-retry</p>
                      <p class="text-xs text-base-content/35 mt-0.5">
                        Retry transient model errors automatically.
                      </p>
                    </div>
                    <Switch
                      checked={autoRetryEnabled}
                      onCheckedChange={(v) => {
                        autoRetryEnabled = v;
                        try {
                          localStorage.setItem('pifrontier:autoRetryEnabled', JSON.stringify(v));
                        } catch {
                          /* noop */
                        }
                        send({ type: 'set_auto_retry', enabled: v });
                      }}
                      disabled={wsState !== 'open'}
                      aria-label="Toggle auto-retry"
                    />
                  </div>
                </div>
              </Card.Root>
              <Card.Root
                size="sm"
                class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
              >
                <div class="px-4 py-3 space-y-3">
                  <div>
                    <p class="text-sm text-base-content/75">Project trust</p>
                    <p class="text-xs text-base-content/35 mt-0.5">
                      Project extensions, skills, prompts, and packages load only when trusted.
                    </p>
                  </div>
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-xs font-mono text-base-content/55"
                      >{projectTrust?.decision ?? 'ask'}</span
                    >
                    {#each [['trusted', 'Trust project'], ['denied', 'Block project'], ['ask', 'Ask next time']] as [decision, label] (decision)}
                      <Button
                        size="sm"
                        variant={projectTrust?.decision === decision ? 'default' : 'outline'}
                        disabled={wsState !== 'open'}
                        onclick={() =>
                          send({
                            type: 'set_project_trust',
                            cwd: projectTrust?.cwd ?? cwd,
                            decision: decision as 'trusted' | 'denied' | 'ask',
                          })}>{label}</Button
                      >
                    {/each}
                  </div>
                </div>
              </Card.Root>
              {#if runtimeDiagnostics.length > 0}
                <Card.Root
                  size="sm"
                  class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                >
                  <div class="px-4 py-3">
                    <p class="text-sm text-base-content/75">Runtime diagnostics</p>
                    <div class="mt-2 space-y-1.5">
                      {#each runtimeDiagnostics as diagnostic (diagnostic.message)}
                        <p
                          class="text-xs {diagnostic.type === 'error'
                            ? 'text-error/75'
                            : diagnostic.type === 'warning'
                              ? 'text-warning/75'
                              : 'text-base-content/50'}"
                        >
                          {diagnostic.message}
                        </p>
                      {/each}
                    </div>
                  </div>
                </Card.Root>
              {/if}
            {:else if settingsSection === 'notifications'}
              <Card.Root
                size="sm"
                class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
              >
                <div class="divide-y divide-base-content/8">
                  <div class="flex items-center gap-3 px-4 py-3">
                    <div class="flex-1 min-w-0">
                      <p class="text-sm text-base-content/75">Notifications</p>
                      <p class="text-xs text-base-content/35 mt-0.5">
                        Global toggle for all push and page notifications.
                      </p>
                    </div>
                    <Switch
                      checked={notificationPrefs.enabled}
                      onCheckedChange={(v) => {
                        notificationPrefs.enabled = v;
                        if (v && 'Notification' in window && Notification.permission === 'default')
                          Notification.requestPermission();
                      }}
                      aria-label="Toggle all notifications"
                    />
                  </div>
                  <div
                    class="flex items-center gap-3 px-4 py-3 {notificationPrefs.enabled
                      ? ''
                      : 'opacity-40 pointer-events-none'}"
                  >
                    <div class="flex-1 min-w-0">
                      <p class="text-sm text-base-content/75">Response Complete</p>
                      <p class="text-xs text-base-content/35 mt-0.5">
                        Notify when the active session's agent finishes responding.
                      </p>
                    </div>
                    <Switch
                      checked={notificationPrefs.onComplete}
                      onCheckedChange={(v) => {
                        notificationPrefs.onComplete = v;
                      }}
                      disabled={!notificationPrefs.enabled}
                      aria-label="Toggle response complete notification"
                    />
                  </div>
                  <div
                    class="flex items-center gap-3 px-4 py-3 {notificationPrefs.enabled
                      ? ''
                      : 'opacity-40 pointer-events-none'}"
                  >
                    <div class="flex-1 min-w-0">
                      <p class="text-sm text-base-content/75">Background Session Finished</p>
                      <p class="text-xs text-base-content/35 mt-0.5">
                        Notify when a session you're not watching finishes.
                      </p>
                    </div>
                    <Switch
                      checked={notificationPrefs.onSessionFinish}
                      onCheckedChange={(v) => {
                        notificationPrefs.onSessionFinish = v;
                      }}
                      disabled={!notificationPrefs.enabled}
                      aria-label="Toggle background session notification"
                    />
                  </div>
                </div>
              </Card.Root>

              {#if notificationPrefs.enabled}
                <Card.Root
                  size="sm"
                  class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                >
                  <div class="divide-y divide-base-content/8">
                    <div class="flex items-center gap-3 px-4 py-3">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Phone Push</p>
                        <p class="text-xs text-base-content/35 mt-0.5">
                          Webhook URL for push notifications when the browser is closed (ntfy.sh,
                          Pushover, Gotify). Leave empty to disable.
                        </p>
                      </div>
                    </div>
                    <div class="px-4 py-3">
                      <input
                        type="url"
                        class="w-full rounded-lg border border-base-content/12 bg-base-200/50 px-3 py-2 text-sm text-base-content/80 placeholder:text-base-content/25 outline-none focus:border-primary/50 transition-colors"
                        placeholder="https://ntfy.sh/my-pi-topic"
                        value={notificationWebhookUrl}
                        onblur={(e) => {
                          const val = (e.target as HTMLInputElement).value.trim();
                          notificationWebhookUrl = val;
                          send({ type: 'set_notification_webhook_url', url: val });
                        }}
                        onkeydown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    </div>
                  </div>
                </Card.Root>
              {/if}
            {:else if settingsSection === 'shortcuts'}
              <Card.Root
                size="sm"
                class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
              >
                <div class="divide-y divide-base-content/8">
                  {#each SHORTCUTS as shortcut (shortcut.keys)}
                    <div class="flex items-center gap-4 px-4 py-3">
                      <kbd
                        class="min-w-32 rounded-lg border border-base-content/12 bg-base-content/[0.055] px-2 py-1 text-xs text-base-content/60 font-mono"
                        >{shortcut.keys}</kbd
                      >
                      <span class="text-sm text-base-content/70">{shortcut.action}</span>
                    </div>
                  {/each}
                </div>
              </Card.Root>
            {:else if settingsSection === 'extensions'}
              {#if !extensionsLoaded}
                <div class="space-y-3 animate-pulse">
                  {#each [0, 1] as i (i)}
                    <div
                      class="rounded-xl border border-base-content/10 p-4 space-y-2 bg-base-100/60"
                    >
                      <div class="h-4 bg-base-content/8 rounded w-{['1/3', '1/4'][i]}"></div>
                      <div class="h-3 bg-base-content/5 rounded w-{['2/3', '1/2'][i]}"></div>
                      <div class="h-3 bg-base-content/5 rounded w-1/4"></div>
                    </div>
                  {/each}
                </div>
              {:else if extensionsList.length === 0 && extensionErrors.length === 0}
                <p class="text-sm text-base-content/45">No extensions loaded.</p>
              {:else}
                {#each ['user', 'project', 'temporary'] as scope (scope)}
                  {@const scoped = extensionsList.filter((e) => e.scope === scope)}
                  {#if scoped.length > 0}
                    {@const bySource = Object.groupBy(scoped, (e) => e.source)}
                    <div class="mb-5">
                      <p
                        class="text-xs font-semibold text-base-content/50 uppercase tracking-wider mb-2"
                      >
                        {scope}
                      </p>
                      <div class="space-y-2">
                        {#each Object.entries(bySource).filter((e): e is [string, ExtensionSummary[]] => !!e[1]) as [source, exts] (source)}
                          {@const allTools = exts.flatMap((e) => e.tools)}
                          {@const allCommands = exts.flatMap((e) => e.commands)}
                          {@const allFlags = [
                            ...new Map(
                              exts.flatMap((e) => e.flags ?? []).map((flag) => [flag.name, flag])
                            ).values(),
                          ]}
                          {@const allShortcuts = exts.flatMap((e) => e.shortcuts ?? [])}
                          <Card.Root
                            size="sm"
                            class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                          >
                            <div class="divide-y divide-base-content/8">
                              <div class="px-4 py-3">
                                <div class="flex items-center gap-2">
                                  <p class="text-sm font-medium text-base-content/80">
                                    {source}
                                  </p>
                                  {#if exts.length > 1}
                                    <span
                                      class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-base-content/10 text-base-content/45"
                                      >{exts.length} files</span
                                    >
                                  {/if}
                                  <span
                                    class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-base-content/10 text-base-content/45"
                                  >
                                    {scope === 'user'
                                      ? 'User'
                                      : scope === 'project'
                                        ? 'Project'
                                        : 'Temporary'}
                                  </span>
                                </div>
                                {#if exts.length === 1}
                                  <p
                                    class="mt-0.5 text-xs text-base-content/35 font-mono truncate"
                                    title={exts[0].path}
                                  >
                                    {exts[0].path}
                                  </p>
                                {:else}
                                  <p class="mt-0.5 text-xs text-base-content/35">
                                    {exts.map((e) => e.path).join(', ')}
                                  </p>
                                {/if}
                              </div>
                              {#if allTools.length > 0}
                                <details class="group px-4 py-2">
                                  <summary
                                    class="cursor-pointer text-xs font-medium text-base-content/55 hover:text-base-content/75 transition-colors list-none flex items-center gap-1.5"
                                  >
                                    <ChevronRight
                                      class="w-3 h-3 transition-transform group-open:rotate-90"
                                    />
                                    Tools ({allTools.length})
                                  </summary>
                                  <div class="mt-1.5 ml-4 space-y-1">
                                    {#each allTools as tool (tool.name)}
                                      <div>
                                        <p class="text-xs text-base-content/70 font-mono">
                                          {tool.name}
                                        </p>
                                        {#if tool.description}
                                          <p class="text-[11px] text-base-content/40 leading-snug">
                                            {tool.description}
                                          </p>
                                        {/if}
                                      </div>
                                    {/each}
                                  </div>
                                </details>
                              {/if}
                              {#if allCommands.length > 0}
                                <details class="group px-4 py-2">
                                  <summary
                                    class="cursor-pointer text-xs font-medium text-base-content/55 hover:text-base-content/75 transition-colors list-none flex items-center gap-1.5"
                                  >
                                    <ChevronRight
                                      class="w-3 h-3 transition-transform group-open:rotate-90"
                                    />
                                    Commands ({allCommands.length})
                                  </summary>
                                  <div class="mt-1.5 ml-4 space-y-1">
                                    {#each allCommands as cmd (cmd.name)}
                                      <div>
                                        <p class="text-xs text-base-content/70 font-mono">
                                          /{cmd.name}
                                        </p>
                                        {#if cmd.description}
                                          <p class="text-[11px] text-base-content/40 leading-snug">
                                            {cmd.description}
                                          </p>
                                        {/if}
                                      </div>
                                    {/each}
                                  </div>
                                </details>
                              {/if}
                              {#if allShortcuts.length > 0}
                                <div class="px-4 py-2 space-y-1.5">
                                  <p class="text-[11px] font-medium text-base-content/45">
                                    Shortcuts
                                  </p>
                                  {#each allShortcuts as shortcut (shortcut.shortcut)}
                                    <button
                                      class="w-full flex items-center justify-between gap-3 text-left text-xs hover:text-primary transition-colors"
                                      onclick={() =>
                                        send({
                                          type: 'invoke_extension_shortcut',
                                          shortcut: shortcut.shortcut,
                                        })}
                                    >
                                      <span class="font-mono text-base-content/65"
                                        >{shortcut.shortcut}</span
                                      >
                                      <span class="text-base-content/40 truncate"
                                        >{shortcut.description ?? ''}</span
                                      >
                                    </button>
                                  {/each}
                                </div>
                              {/if}
                              {#if allFlags.length > 0}
                                <div class="px-4 py-2 space-y-2">
                                  {#each allFlags as flag (flag.name)}
                                    <div class="flex items-center gap-3">
                                      <div class="min-w-0 flex-1">
                                        <p class="text-xs font-mono text-base-content/65">
                                          {flag.name}
                                        </p>
                                        {#if flag.description}
                                          <p class="text-[11px] text-base-content/40">
                                            {flag.description}
                                          </p>
                                        {/if}
                                      </div>
                                      {#if flag.type === 'boolean'}
                                        <Switch
                                          checked={flag.value === true}
                                          onCheckedChange={(value) =>
                                            send({
                                              type: 'set_extension_flag',
                                              name: flag.name,
                                              value,
                                            })}
                                          aria-label={`Toggle ${flag.name}`}
                                        />
                                      {:else}
                                        <input
                                          class="w-36 rounded border border-base-content/12 bg-base-200/50 px-2 py-1 text-xs font-mono"
                                          value={String(flag.value ?? flag.default ?? '')}
                                          onchange={(event) =>
                                            send({
                                              type: 'set_extension_flag',
                                              name: flag.name,
                                              value: (event.currentTarget as HTMLInputElement)
                                                .value,
                                            })}
                                        />
                                      {/if}
                                    </div>
                                  {/each}
                                </div>
                              {/if}
                            </div>
                          </Card.Root>
                        {/each}
                      </div>
                    </div>
                  {/if}
                {/each}
                {#if extensionErrors.length > 0}
                  <details class="group">
                    <summary
                      class="cursor-pointer text-xs font-medium text-error/70 hover:text-error transition-colors list-none flex items-center gap-1.5"
                    >
                      <ChevronRight class="w-3 h-3 transition-transform group-open:rotate-90" />
                      Errors ({extensionErrors.length})
                    </summary>
                    <div class="mt-2 space-y-1.5">
                      {#each extensionErrors as err (err.path)}
                        <div class="px-3 py-2 rounded-lg bg-error/8 border border-error/15">
                          <p class="text-xs text-error/80 font-mono break-all">{err.path}</p>
                          <p class="text-[11px] text-error/60 mt-0.5">{err.error}</p>
                        </div>
                      {/each}
                    </div>
                  </details>
                {/if}
              {/if}
            {:else if settingsSection === 'packages'}
              <div class="space-y-4">
                <Card.Root
                  size="sm"
                  class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                >
                  <div class="px-4 py-3 space-y-3">
                    <div>
                      <p class="text-sm text-base-content/75">Configured packages</p>
                      <p class="text-xs text-base-content/35 mt-0.5">
                        Install or remove SDK extension packages.
                      </p>
                    </div>
                    <div class="flex flex-col sm:flex-row gap-2">
                      <input
                        class="min-w-0 flex-1 rounded-lg border border-base-content/12 bg-base-200/50 px-3 py-2 text-xs font-mono outline-none focus:border-primary/50"
                        placeholder="npm package or git URL"
                        bind:value={packageSource}
                        disabled={packageBusy}
                      />

                      <Select.Root
                        type="single"
                        value={packageScope}
                        onValueChange={(v: string) => (packageScope = v as 'user' | 'project')}
                      >
                        <Select.Trigger size="sm" class="w-28">{packageScope}</Select.Trigger>
                        <Select.Content>
                          <Select.Item value="user">user</Select.Item>
                          <Select.Item
                            value="project"
                            disabled={projectTrust?.decision !== 'trusted'}>project</Select.Item
                          >
                        </Select.Content>
                      </Select.Root>
                      <Button
                        size="sm"
                        disabled={!packageSource.trim() ||
                          packageBusy ||
                          (packageScope === 'project' && projectTrust?.decision !== 'trusted')}
                        onclick={() => {
                          packageBusy = true;
                          send({
                            type: 'install_package',
                            source: packageSource.trim(),
                            scope: packageScope,
                          });
                        }}>Install</Button
                      >
                    </div>
                    {#if packageProgress}
                      <p class="text-xs text-base-content/45">
                        {packageProgress.message ?? packageProgress.phase}
                      </p>
                    {/if}
                  </div>
                </Card.Root>
                {#if !packagesLoaded}
                  <p class="text-sm text-base-content/45">Loading packages…</p>
                {:else if packagesList.length === 0}
                  <p class="text-sm text-base-content/45">No configured packages.</p>
                {:else}
                  <Card.Root
                    size="sm"
                    class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                  >
                    <div class="divide-y divide-base-content/8">
                      {#each packagesList as pkg (`${pkg.scope}:${pkg.source}`)}
                        <div class="flex items-center gap-3 px-4 py-3">
                          <div class="min-w-0 flex-1">
                            <p class="text-xs font-mono text-base-content/70 truncate">
                              {pkg.source}
                            </p>
                            <p class="text-[11px] text-base-content/35">
                              {pkg.scope}{pkg.filtered ? ' · filtered' : ''}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={packageBusy}
                            onclick={() => {
                              packageBusy = true;
                              send({
                                type: 'remove_package',
                                source: pkg.source,
                                scope: pkg.scope,
                              });
                            }}>Remove</Button
                          >
                        </div>
                      {/each}
                    </div>
                  </Card.Root>
                {/if}
                {#if packageUpdates.length > 0}
                  <p class="text-xs text-warning/75">
                    {packageUpdates.length} package update(s) available.
                  </p>
                {/if}
              </div>
            {:else if settingsSection === 'updates'}
              <div class="space-y-4">
                <Card.Root
                  size="sm"
                  class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
                >
                  <div class="divide-y divide-base-content/8">
                    <div class="flex items-center gap-3 px-4 py-3">
                      <div class="flex-1 min-w-0">
                        <p class="text-sm text-base-content/75">Update status</p>
                        <p class="text-xs text-base-content/35 mt-0.5">
                          Checks npm for latest versions. Update actions run on the server.
                        </p>
                      </div>
                      <button
                        onclick={refreshUpdateStatus}
                        disabled={wsState !== 'open' || updateLoading || updateRunning}
                        class="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors {wsState ===
                          'open' &&
                        !updateLoading &&
                        !updateRunning
                          ? 'text-primary hover:bg-primary/10'
                          : 'text-base-content/25 cursor-default'}"
                        >{updateLoading ? 'Checking…' : 'Check'}</button
                      >
                    </div>

                    <div
                      class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-base-content/8"
                    >
                      <div class="px-4 py-3 space-y-3">
                        <div>
                          <p class="text-xs text-base-content/35">pi-ui</p>
                          <p class="mt-1 text-sm text-base-content/75 font-mono">
                            {versionText(updateStatus?.ui.current ?? uiVersion)}
                          </p>
                          <p class="mt-0.5 text-xs text-base-content/40">
                            Latest: {versionText(updateStatus?.ui.latest)}
                          </p>
                          {#if updateStatus?.ui.error}
                            <p class="mt-1 text-xs text-warning/80">{updateStatus.ui.error}</p>
                          {:else if updateStatus?.ui.updateAvailable}
                            <p class="mt-1 text-xs text-success/80">Update available</p>
                          {:else if updateStatus?.ui.latest}
                            <p class="mt-1 text-xs text-base-content/35">Up to date</p>
                          {/if}
                        </div>
                        <button
                          onclick={() => runUpdate('ui')}
                          disabled={wsState !== 'open' ||
                            updateRunning ||
                            !updateStatus?.canUpdateUi}
                          class="w-full px-3 py-2 text-xs rounded-lg font-medium transition-colors {wsState ===
                            'open' &&
                          !updateRunning &&
                          updateStatus?.canUpdateUi
                            ? 'bg-primary/15 text-primary hover:bg-primary/25'
                            : 'bg-base-content/8 text-base-content/28 cursor-default'}"
                          >{updateRunning && updateTarget === 'ui'
                            ? 'Updating pi-ui…'
                            : 'Update pi-ui'}</button
                        >
                        {#if updateStatus && !updateStatus.canUpdateUi}
                          <p class="text-[11px] text-base-content/35 leading-snug">
                            This run is ephemeral; restart with the latest package instead.
                          </p>
                        {/if}
                      </div>

                      <div class="px-4 py-3 space-y-3">
                        <div>
                          <p class="text-xs text-base-content/35">pi SDK</p>
                          <p class="mt-1 text-sm text-base-content/75 font-mono">
                            {versionText(updateStatus?.sdk.current ?? piVersion)}
                          </p>
                          <p class="mt-0.5 text-xs text-base-content/40">
                            Latest: {versionText(updateStatus?.sdk.latest)}
                          </p>
                          {#if updateStatus?.sdk.error}
                            <p class="mt-1 text-xs text-warning/80">{updateStatus.sdk.error}</p>
                          {:else if updateStatus?.sdk.updateAvailable}
                            <p class="mt-1 text-xs text-success/80">Update available</p>
                          {:else if updateStatus?.sdk.latest}
                            <p class="mt-1 text-xs text-base-content/35">Up to date</p>
                          {/if}
                        </div>
                        <button
                          onclick={() => runUpdate('sdk')}
                          disabled={wsState !== 'open' ||
                            updateRunning ||
                            !updateStatus?.canUpdateSdk}
                          class="w-full px-3 py-2 text-xs rounded-lg font-medium transition-colors {wsState ===
                            'open' &&
                          !updateRunning &&
                          updateStatus?.canUpdateSdk
                            ? 'bg-primary/15 text-primary hover:bg-primary/25'
                            : 'bg-base-content/8 text-base-content/28 cursor-default'}"
                          >{updateRunning && updateTarget === 'sdk'
                            ? 'Updating SDK…'
                            : 'Update SDK'}</button
                        >
                        {#if updateStatus && !updateStatus.canUpdateSdk}
                          <p class="text-[11px] text-base-content/35 leading-snug">
                            SDK-only updates are available from source checkouts only. Package
                            installs update the SDK with pi-ui.
                          </p>
                        {/if}
                      </div>
                    </div>

                    {#if updateStatus}
                      <div class="px-4 py-3 space-y-1.5">
                        <p class="text-xs text-base-content/35">App directory</p>
                        <p class="text-xs text-base-content/65 font-mono break-all">
                          {updateStatus.appRoot}
                        </p>
                        <p class="text-xs text-base-content/35">
                          Mode: {updateStatus.mode === 'source'
                            ? 'source checkout'
                            : updateStatus.mode === 'ephemeral'
                              ? 'ephemeral run'
                              : 'package install'}
                        </p>
                        {#if updateStatus.updateCommand}
                          <p class="text-xs text-base-content/35">
                            Update command: <span class="font-mono text-base-content/60"
                              >{updateStatus.updateCommand}</span
                            >
                          </p>
                        {/if}
                      </div>
                    {/if}
                  </div>
                </Card.Root>

                {#if updateFeedback}
                  <Card.Root
                    size="sm"
                    class="py-0 overflow-hidden {updateFeedback.success
                      ? 'bg-success/5 border-success/20'
                      : 'bg-error/5 border-error/20'}"
                  >
                    <div class="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                      <div class="flex-1 min-w-0">
                        <p
                          class="text-sm {updateFeedback.success
                            ? 'text-success/85'
                            : 'text-error/85'}"
                        >
                          {updateFeedback.message}
                        </p>
                        {#if updateFeedback.restartRequired}
                          <p class="text-xs text-base-content/40 mt-0.5">
                            Restart is required before the new version is loaded.
                          </p>
                        {/if}
                      </div>
                      {#if updateFeedback.restartRequired}
                        <button
                          onclick={() => restartServer(Boolean(updateFeedback?.reloadRequired))}
                          class="px-3 py-1.5 text-xs rounded-lg font-medium text-primary bg-primary/12 hover:bg-primary/20 transition-colors"
                          >{updateFeedback.reloadRequired
                            ? 'Restart + reload'
                            : 'Restart now'}</button
                        >
                      {/if}
                    </div>
                  </Card.Root>
                {/if}

                {#if updateStatus?.notes.length}
                  <Card.Root
                    size="sm"
                    class="py-0 overflow-hidden bg-base-100/45 border-base-content/10"
                  >
                    <div class="px-4 py-3 space-y-1">
                      {#each updateStatus.notes as note (note)}
                        <p class="text-xs text-base-content/42 leading-snug">{note}</p>
                      {/each}
                    </div>
                  </Card.Root>
                {/if}

                {#if updateLog}
                  <pre
                    class="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-base-content/10 bg-base-300/70 p-3 text-[11px] leading-relaxed text-base-content/60 font-mono">{updateLog}</pre>
                {/if}
              </div>
            {:else}
              <Card.Root
                size="sm"
                class="py-0 overflow-hidden bg-base-100/60 border-base-content/10"
              >
                <div class="divide-y divide-base-content/8">
                  <div class="px-4 py-3">
                    <p class="text-xs text-base-content/35 mb-2">Theme</p>
                    <div class="flex flex-wrap gap-1.5">
                      {#each THEMES as theme (theme.id)}
                        <button
                          onclick={() => setTheme(theme.id)}
                          class="px-2.5 py-1 text-xs rounded-lg border transition-colors {selectedTheme ===
                          theme.id
                            ? 'border-primary/50 bg-primary/12 text-primary'
                            : 'border-base-content/12 text-base-content/50 hover:text-base-content/75 hover:border-base-content/25'}"
                          >{theme.name}</button
                        >
                      {/each}
                    </div>
                  </div>
                  <div class="px-4 py-3">
                    <p class="text-xs text-base-content/35">Working directory</p>
                    <p class="mt-1 text-xs text-base-content/65 font-mono break-all">
                      {cwd || 'unknown'}
                    </p>
                  </div>
                  <div
                    class="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-base-content/8"
                  >
                    <div class="px-4 py-3">
                      <p class="text-xs text-base-content/35">pi-ui</p>
                      <p class="mt-1 text-sm text-base-content/70 font-mono">
                        {uiVersion ? `v${uiVersion}` : 'unknown'}
                      </p>
                    </div>
                    <div class="px-4 py-3">
                      <p class="text-xs text-base-content/35">pi SDK</p>
                      <p class="mt-1 text-sm text-base-content/70 font-mono">
                        {piVersion ? `v${piVersion}` : 'unknown'}
                      </p>
                    </div>
                  </div>
                  <div class="flex items-center gap-3 px-4 py-3">
                    <div class="flex-1 min-w-0">
                      <p class="text-sm text-base-content/75">Restart server</p>
                      <p class="text-xs text-base-content/35 mt-0.5">
                        Reconnects after the Bun process restarts.
                      </p>
                    </div>
                    <button
                      onclick={() => restartServer()}
                      class="px-3 py-1.5 text-xs rounded-lg font-medium transition-colors {wsState ===
                      'open'
                        ? 'text-error/75 hover:text-error hover:bg-error/10'
                        : 'text-base-content/25 cursor-default'}"
                      disabled={wsState !== 'open'}
                      aria-label="Restart server">Restart</button
                    >
                  </div>
                  {#if sessionStats}
                    <div class="px-4 py-3">
                      <div class="flex items-center justify-between gap-3">
                        <p class="text-sm text-base-content/75">Session usage</p>
                        <div class="flex gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onclick={() => send({ type: 'export_session', format: 'html' })}
                            >HTML</Button
                          >
                          <Button
                            size="sm"
                            variant="ghost"
                            onclick={() => send({ type: 'export_session', format: 'jsonl' })}
                            >JSONL</Button
                          >
                        </div>
                      </div>
                      <div class="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                        <span class="text-base-content/50"
                          >Messages <b class="text-base-content/75">{sessionStats.totalMessages}</b
                          ></span
                        >
                        <span class="text-base-content/50"
                          >Tools <b class="text-base-content/75">{sessionStats.toolCalls}</b></span
                        >
                        <span class="text-base-content/50"
                          >Tokens <b class="text-base-content/75"
                            >{sessionStats.tokens.total.toLocaleString()}</b
                          ></span
                        >
                        <span class="text-base-content/50"
                          >Cost <b class="text-base-content/75">{fmtCost(sessionStats.cost)}</b
                          ></span
                        >
                      </div>
                      {#if exportFeedback}
                        <p class="mt-2 text-[11px] text-base-content/45">{exportFeedback}</p>
                      {/if}
                    </div>
                  {/if}
                </div>
              </Card.Root>
            {/if}
          </div>
        </ScrollArea>
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
