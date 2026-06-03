<script lang="ts">
  import type { ActionData } from './$types';

  let { form }: { form: ActionData } = $props();

  let password = $state('');
  let loading = $state(false);
</script>

<svelte:head>
  <title>pi UI | Login</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-base-100 px-4">
  <div class="w-full max-w-xs font-mono text-sm text-base-content">
    <p class="mb-6 text-base-content/40">pi</p>

    <form
      method="POST"
      onsubmit={() => (loading = true)}
      class="flex flex-col gap-4"
    >
      <div class="flex flex-col gap-1">
        <label for="password" class="text-base-content/40 text-xs">password</label>
        <input
          id="password"
          name="password"
          type="password"
          bind:value={password}
          autocomplete="current-password"
          required
          class="bg-transparent border-b border-base-content/20 pb-1 outline-none focus:border-base-content/60 transition-colors placeholder-base-content/10"
          placeholder="········"
        />
      </div>

      {#if form?.error}
        <p class="text-error text-xs">{form.error}</p>
      {/if}

      <button
        type="submit"
        disabled={loading || !password}
        class="mt-2 self-end text-base-content/40 hover:text-base-content disabled:opacity-20 transition-colors"
      >
        {loading ? '…' : '→'}
      </button>
    </form>
  </div>
</div>
