<script lang="ts">
  import * as Card from '#lib/components/ui/card/index.js';
  import type { UsageSummary } from '#lib/ws/protocol.js';

  let {
    summary,
    loading,
    days,
    onDaysChange,
  }: {
    summary: UsageSummary | null;
    loading: boolean;
    days: number;
    onDaysChange: (days: number) => void;
  } = $props();

  const WINDOWS = [7, 30, 90] as const;

  function money(value: number): string {
    if (value === 0) return '$0';
    if (value < 0.01) return '<$0.01';
    return `$${value.toFixed(value < 100 ? 2 : 0)}`;
  }
  function tokens(value: number): string {
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
    return `${Math.round(value)}`;
  }
  function shortCwd(cwd: string): string {
    const parts = cwd.split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : cwd || '/';
  }

  // Chart by cost when any cost was reported, otherwise by tokens.
  const metric = $derived(summary && summary.totals.cost > 0 ? 'cost' : 'tokens');
  const peak = $derived(
    summary ? Math.max(0, ...summary.byDay.map((d) => (metric === 'cost' ? d.cost : d.tokens))) : 0
  );
</script>

<div class="space-y-4" data-testid="usage-section">
  <div class="flex items-center justify-between gap-3">
    <div class="flex gap-1" role="group" aria-label="Usage window">
      {#each WINDOWS as window (window)}
        <button
          type="button"
          class="px-2.5 py-1 text-xs rounded-full transition-colors {days === window
            ? 'bg-primary/15 text-primary'
            : 'text-base-content/50 hover:text-base-content/80 hover:bg-base-content/8'}"
          aria-pressed={days === window}
          onclick={() => onDaysChange(window)}>{window} days</button
        >
      {/each}
    </div>
    {#if loading}<span class="text-[11px] text-base-content/40">Loading…</span>{/if}
  </div>

  {#if summary}
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {#each [{ label: 'Cost', value: money(summary.totals.cost) }, { label: 'Tokens', value: tokens(summary.totals.tokens) }, { label: 'Replies', value: summary.totals.messages.toLocaleString() }, { label: 'Sessions', value: summary.sessionsWithUsage.toLocaleString() }] as stat (stat.label)}
        <div class="rounded-xl border border-base-content/10 bg-base-100/60 px-3 py-2.5">
          <p class="text-[11px] text-base-content/40">{stat.label}</p>
          <p
            class="mt-0.5 text-sm font-mono text-base-content/80"
            data-testid="usage-{stat.label.toLowerCase()}"
          >
            {stat.value}
          </p>
        </div>
      {/each}
    </div>

    <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
      <div class="px-4 py-3">
        <p class="text-xs text-base-content/45">
          {metric === 'cost' ? 'Cost' : 'Tokens'} per day · {summary.since} → {summary.until}
        </p>
        <div class="mt-3 flex h-24 items-end gap-px" aria-hidden="true">
          {#each summary.byDay as day (day.day)}
            {@const value = metric === 'cost' ? day.cost : day.tokens}
            <div
              class="flex-1 rounded-t-sm {value > 0 ? 'bg-primary/60' : 'bg-base-content/8'}"
              style="height: {peak > 0 ? Math.max(2, (value / peak) * 100) : 2}%"
              title="{day.day}: {money(day.cost)} · {tokens(day.tokens)} tokens"
            ></div>
          {/each}
        </div>
      </div>
    </Card.Root>

    {#if summary.byModel.length}
      <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
        <table class="w-full text-xs" data-testid="usage-by-model">
          <thead class="text-base-content/40">
            <tr>
              <th class="px-4 py-2 text-left font-normal">Model</th>
              <th class="px-2 py-2 text-right font-normal">Replies</th>
              <th class="px-2 py-2 text-right font-normal">Tokens</th>
              <th class="px-4 py-2 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-base-content/8">
            {#each summary.byModel as row (row.model)}
              <tr>
                <td class="px-4 py-2 font-mono text-base-content/75 break-all">{row.model}</td>
                <td class="px-2 py-2 text-right text-base-content/60">{row.messages}</td>
                <td class="px-2 py-2 text-right text-base-content/60">{tokens(row.tokens)}</td>
                <td class="px-4 py-2 text-right text-base-content/75">{money(row.cost)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </Card.Root>
    {/if}

    {#if summary.byProject.length}
      <Card.Root size="sm" class="py-0 overflow-hidden bg-base-100/60 border-base-content/10">
        <table class="w-full text-xs">
          <thead class="text-base-content/40">
            <tr>
              <th class="px-4 py-2 text-left font-normal">Project</th>
              <th class="px-2 py-2 text-right font-normal">Tokens</th>
              <th class="px-4 py-2 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-base-content/8">
            {#each summary.byProject as row (row.cwd)}
              <tr>
                <td class="px-4 py-2 font-mono text-base-content/75" title={row.cwd}
                  >{shortCwd(row.cwd)}</td
                >
                <td class="px-2 py-2 text-right text-base-content/60">{tokens(row.tokens)}</td>
                <td class="px-4 py-2 text-right text-base-content/75">{money(row.cost)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </Card.Root>
    {/if}

    <p class="text-[11px] text-base-content/35">
      Totals sum the usage recorded on each assistant reply across all sessions (days in server
      local time).
    </p>
  {:else if !loading}
    <p class="text-xs text-base-content/40">No usage data yet.</p>
  {/if}
</div>
