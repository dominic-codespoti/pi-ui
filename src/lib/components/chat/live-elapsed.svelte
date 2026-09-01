<script lang="ts">
  import { fmtDuration } from '#lib/utils.js';

  let {
    startMs = 0,
    endMs,
    durationMs,
    active = false,
    format = 'seconds',
    className = '',
  }: {
    startMs?: number;
    endMs?: number;
    durationMs?: number;
    active?: boolean;
    format?: 'seconds' | 'duration';
    className?: string;
  } = $props();

  let now = $state(Date.now());

  $effect(() => {
    if (!active || !startMs || endMs !== undefined || durationMs !== undefined) return;
    now = Date.now();
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  const elapsedMs = $derived.by(() => {
    if (!startMs) return undefined;
    if (durationMs !== undefined) return Math.max(0, durationMs);
    if (endMs !== undefined) return Math.max(0, endMs - startMs);
    if (!active) return undefined;
    return Math.max(0, now - startMs);
  });

  const label = $derived.by(() => {
    if (elapsedMs === undefined) return '';
    if (format === 'duration') return fmtDuration(elapsedMs);
    return endMs !== undefined
      ? `${(elapsedMs / 1000).toFixed(1)}s`
      : `${Math.floor(elapsedMs / 1000)}s`;
  });
</script>

{#if label}<span class={className}>{label}</span>{/if}
