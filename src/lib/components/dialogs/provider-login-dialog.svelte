<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Dialog from '#lib/components/ui/dialog/index.js';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Info from '@lucide/svelte/icons/info';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import type { ServerMessage } from '#lib/ws/protocol.js';

  type LoginEvent = Extract<ServerMessage, { type: 'provider_login_event' }>['event'];
  type LoginPromptFrame = Extract<ServerMessage, { type: 'provider_login_prompt' }>;
  type LoginPrompt = LoginPromptFrame['prompt'];
  type LoginMessage = Extract<LoginEvent, { type: 'info' | 'progress' }>;
  type LoginState = {
    loginId: string;
    provider: string;
    providerName: string;
    authType: 'oauth' | 'api_key';
    status: 'started' | 'succeeded' | 'failed' | 'cancelled';
    error?: string;
    authUrl?: { url: string; instructions?: string };
    authUrlReceivedAt?: number;
    deviceCode?: {
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    };
    deviceCodeReceivedAt?: number;
    messages: LoginMessage[];
    prompt?: { promptId: string; prompt: LoginPrompt };
    promptCancelled?: boolean;
    subscription?: boolean;
  };

  let {
    login,
    onSubmit,
    onCancel,
    onClose,
    onRetry,
  }: {
    login: LoginState | null;
    onSubmit: (loginId: string, promptId: string, value: string) => void;
    onCancel: (loginId: string) => void;
    onClose: () => void;
    onRetry: (provider: string, authType: 'oauth' | 'api_key') => void;
  } = $props();

  let value = $state('');
  let selected = $state('');
  let copiedItem = $state<string | null>(null);
  let now = $state(Date.now());
  let fallbackCopyText = $state<string | null>(null);
  let fallbackInput = $state<HTMLInputElement | undefined>();
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;

  const deviceSecondsLeft = $derived.by(() => {
    const device = login?.deviceCode;
    const receivedAt = login?.deviceCodeReceivedAt;
    if (!device || device.expiresInSeconds === undefined || receivedAt === undefined) return null;
    return Math.max(0, Math.ceil(device.expiresInSeconds - (now - receivedAt) / 1000));
  });

  $effect(() => {
    if (login?.deviceCode && login.deviceCode.expiresInSeconds !== undefined) {
      now = Date.now();
      countdownTimer = setInterval(() => (now = Date.now()), 1000);
    }
    return () => {
      if (countdownTimer) clearInterval(countdownTimer);
      countdownTimer = undefined;
    };
  });

  $effect(() => {
    const promptId = login?.prompt?.promptId;
    value = '';
    selected = '';
    void promptId;
  });

  async function copy(text: string, item: string) {
    fallbackCopyText = null;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        showCopied(item);
        return;
      }
    } catch {
      // Insecure LAN origins can lack clipboard permission; offer a selectable fallback.
    }

    fallbackCopyText = text;
    requestAnimationFrame(() => {
      fallbackInput?.focus();
      fallbackInput?.select();
      try {
        if (document.execCommand('copy')) {
          fallbackCopyText = null;
          showCopied(item);
        }
      } catch {
        // The readonly text remains selected for manual copying.
      }
    });
  }

  function showCopied(item: string) {
    copiedItem = item;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedItem = null), 1400);
  }

  function close() {
    if (login?.status === 'started') onCancel(login.loginId);
    onClose();
  }

  function submit() {
    if (!login?.prompt) return;
    onSubmit(
      login.loginId,
      login.prompt.promptId,
      login.prompt.prompt.type === 'select' ? selected : value
    );
  }

  function openUrl(url: string) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
</script>

<Dialog.Root
  open={login !== null}
  onOpenChange={(open) => {
    if (!open) close();
  }}
>
  <Dialog.Content class="max-w-[calc(100%-2rem)] sm:max-w-lg grid-cols-[minmax(0,1fr)]">
    <Dialog.Header>
      <Dialog.Title class="flex flex-wrap items-center gap-2">
        <span>{login?.providerName ?? 'Provider'}</span>
        {#if login?.subscription}
          <span class="badge badge-sm badge-secondary">Subscription</span>
        {/if}
      </Dialog.Title>
      <Dialog.Description>
        {login?.authType === 'oauth' ? 'OAuth sign-in' : 'API key'}
      </Dialog.Description>
    </Dialog.Header>

    {#if login?.authUrl}
      <section
        class="space-y-3 rounded-lg border border-base-300 bg-base-200/40 p-4"
        aria-label="Sign-in page"
      >
        <div class="flex flex-wrap gap-2">
          <Button onclick={() => openUrl(login.authUrl!.url)}>
            <ExternalLink size={16} />Open sign-in page
          </Button>
          <Button variant="ghost" onclick={() => copy(login.authUrl!.url, 'auth-url')}>
            {#if copiedItem === 'auth-url'}<Check size={16} />{:else}<Copy size={16} />{/if}
            {copiedItem === 'auth-url' ? 'Copied' : 'Copy URL'}
          </Button>
        </div>
        <p class="truncate font-mono text-xs text-base-content/60" title={login.authUrl.url}>
          {login.authUrl.url}
        </p>
        {#if login.authUrl.instructions}
          <p class="text-sm text-base-content/70">{login.authUrl.instructions}</p>
        {/if}
      </section>
    {/if}

    {#if login?.deviceCode}
      <section
        class="space-y-3 rounded-lg border border-base-300 p-4 text-center"
        aria-label="Device sign-in code"
      >
        <div class="font-mono text-3xl font-semibold tracking-[0.25em] sm:text-4xl">
          {login.deviceCode.userCode}
        </div>
        <div class="flex flex-wrap justify-center gap-2">
          <Button variant="ghost" onclick={() => copy(login.deviceCode!.userCode, 'device-code')}>
            {#if copiedItem === 'device-code'}<Check size={16} />{:else}<Copy size={16} />{/if}
            {copiedItem === 'device-code' ? 'Copied' : 'Copy code'}
          </Button>
          <Button variant="outline" onclick={() => openUrl(login.deviceCode!.verificationUri)}>
            <ExternalLink size={16} />Open verification page
          </Button>
        </div>
        {#if deviceSecondsLeft !== null}
          <p class="text-sm text-base-content/60" role="timer">
            Code expires in {Math.floor(deviceSecondsLeft / 60)
              .toString()
              .padStart(2, '0')}:{(deviceSecondsLeft % 60).toString().padStart(2, '0')}
          </p>
        {/if}
      </section>
    {/if}

    {#if login?.messages.length}
      <ol
        class="max-h-36 space-y-2 overflow-y-auto"
        aria-label="Sign-in updates"
        aria-live="polite"
      >
        {#each login.messages as message, index (index)}
          <li
            class={`rounded-md bg-base-200/60 p-3 text-sm ${index === login.messages.length - 1 ? 'text-base-content' : 'text-base-content/60'}`}
          >
            <p class="flex items-start gap-2">
              {#if message.type === 'progress'}<LoaderCircle
                  class="mt-0.5 shrink-0 animate-spin"
                  size={16}
                />{/if}
              <span>{message.message}</span>
            </p>
            {#if message.type === 'info' && message.links?.length}
              <div class="mt-2 flex flex-wrap gap-2">
                {#each message.links as link (link.url)}
                  <a
                    class="link link-primary break-all"
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.label ?? link.url}
                  </a>
                {/each}
              </div>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}

    {#if login?.prompt}
      <form
        class="space-y-3"
        onsubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label class="label" for="provider-login-input">{login.prompt.prompt.message}</label>
        {#if login.prompt.prompt.type === 'manual_code'}
          <div
            class="flex gap-2 rounded-md border border-info/30 bg-info/10 p-3 text-sm"
            role="note"
          >
            <Info class="mt-0.5 shrink-0 text-info" size={18} />
            <p>
              If this server is remote (for example, on a Raspberry Pi), the final redirect to
              localhost may fail in your browser. That is expected. Copy the full URL from the
              failed page's address bar and paste it here.
            </p>
          </div>
        {/if}
        {#if login.prompt.prompt.type === 'select'}
          <div class="grid gap-2" role="group" aria-label={login.prompt.prompt.message}>
            {#each login.prompt.prompt.options ?? [] as option (option.id)}
              <button
                type="button"
                class={`rounded-lg border p-3 text-left transition-colors hover:bg-base-200 ${selected === option.id ? 'border-primary bg-primary/10' : ''}`}
                aria-pressed={selected === option.id}
                onclick={() => (selected = option.id)}
              >
                <strong class="block">{option.label}</strong>
                {#if option.description}
                  <span class="mt-1 block text-sm text-base-content/60">{option.description}</span>
                {/if}
              </button>
            {/each}
          </div>
        {:else}
          <input
            id="provider-login-input"
            bind:value
            type={login.prompt.prompt.type === 'secret' ? 'password' : 'text'}
            placeholder={login.prompt.prompt.placeholder ??
              (login.prompt.prompt.type === 'manual_code'
                ? 'Authorization code or redirect URL'
                : '')}
            autocomplete={login.prompt.prompt.type === 'secret' ? 'new-password' : 'off'}
            name="provider-login-prompt"
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            data-form-type="other"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            class="input input-bordered w-full"
          />
        {/if}
        <div class="flex justify-end gap-2">
          <Button variant="ghost" type="button" onclick={() => login && onCancel(login.loginId)}
            >Cancel</Button
          >
          <Button
            type="submit"
            disabled={login.prompt.prompt.type === 'select' ? !selected : !value}>Submit</Button
          >
        </div>
      </form>
    {:else if login?.promptCancelled}
      <p class="flex items-center gap-2 text-sm text-success" role="status">
        <Check size={18} />Received sign-in from browser…
      </p>
    {/if}

    {#if login?.status === 'started' && !login.prompt && !login.promptCancelled}
      <p class="flex items-center gap-2 text-sm text-base-content/70" role="status">
        <LoaderCircle class="animate-spin" size={16} />Waiting for sign-in…
      </p>
    {:else if login?.status === 'succeeded'}
      <p class="flex items-center gap-2 text-success" role="status">
        <Check size={18} />Signed in to {login.providerName}
      </p>
    {:else if login?.status === 'failed'}
      <div class="space-y-2" role="alert">
        <p class="text-error">{login.error ?? 'Sign-in failed.'}</p>
        <Button onclick={() => login && onRetry(login.provider, login.authType)}>Retry</Button>
      </div>
    {:else if login?.status === 'cancelled'}
      <p class="text-sm text-base-content/70" role="status">Sign-in cancelled.</p>
    {/if}

    {#if fallbackCopyText}
      <label class="space-y-1 text-xs text-base-content/60" for="provider-login-copy-fallback">
        <span>Copy manually if your browser blocks clipboard access:</span>
        <input
          id="provider-login-copy-fallback"
          bind:this={fallbackInput}
          readonly
          value={fallbackCopyText}
          class="input input-bordered input-sm w-full font-mono"
        />
      </label>
    {/if}

    <Dialog.Footer>
      <Button variant="ghost" onclick={close}
        >{login?.status === 'started' ? 'Cancel' : 'Close'}</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
