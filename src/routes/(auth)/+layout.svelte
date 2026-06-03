<script lang="ts">
  import '../../app.css';
  import type { Snippet } from 'svelte';
  import { registerServiceWorker } from '$lib/register-service-worker';

  let { children }: { children: Snippet } = $props();

  registerServiceWorker();
</script>

{@render children()}
