<script lang="ts">
  import type { ActionData } from './$types';

  let { form }: { form: ActionData } = $props();

  let password = $state('');
  let loading = $state(false);
</script>

<svelte:head>
  <title>pi UI | Login</title>
</svelte:head>

<div class="aurora flex min-h-dvh w-full items-center justify-center bg-base-100 px-4">
  <div class="w-full max-w-sm font-mono text-sm text-base-content">
    <!-- Glyph + wordmark -->
    <div class="mb-10 flex flex-col items-center gap-3 select-none">
      <span class="pi-glyph pi-glyph-breathe text-7xl font-light leading-none">π</span>
      <p class="text-xs tracking-[0.35em] uppercase text-base-content/35">pi · coding agent</p>
    </div>

    <form
      method="POST"
      onsubmit={() => (loading = true)}
      class="composer rounded-2xl px-5 py-5 flex flex-col gap-4"
    >
      <div class="flex flex-col gap-2">
        <label for="password" class="text-[11px] uppercase tracking-[0.18em] text-base-content/40">password</label>
        <input
          id="password"
          name="password"
          type="password"
          bind:value={password}
          autocomplete="current-password"
          required
          class="w-full bg-transparent border-b border-base-content/15 pb-2 outline-none focus:border-primary/60 transition-colors placeholder-base-content/15 text-base"
          placeholder="········"
        />
      </div>

      {#if form?.error}
        <p class="text-error text-xs flex items-center gap-1.5">
          <span class="w-1 h-1 rounded-full bg-error inline-block"></span>
          {form.error}
        </p>
      {/if}

      <button
        type="submit"
        disabled={loading || !password}
        class="mt-1 h-10 w-full rounded-xl text-sm font-semibold transition-all duration-200
          {password && !loading
            ? 'bg-primary text-primary-content hover:brightness-110 shadow-[0_0_24px_-6px_color-mix(in_oklch,var(--color-primary)_60%,transparent)]'
            : 'bg-base-content/[0.06] text-base-content/25 cursor-default'}"
      >
        {loading ? 'unlocking…' : 'unlock'}
      </button>
    </form>

    <p class="mt-6 text-center text-[11px] text-base-content/25">
      set via <span class="text-base-content/40">PI_PASSWORD</span> at server start
    </p>
  </div>
</div>
