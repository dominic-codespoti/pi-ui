<script lang="ts">
  import type { ParsedComponent } from '$lib/tui-stubs';
  import { Button } from '$lib/components/ui/button';
  import { renderMarkdown } from '$lib/markdown';
  import LoaderIcon from '@lucide/svelte/icons/loader';
  import Square from '@lucide/svelte/icons/square';
  import SquareCheck from '@lucide/svelte/icons/square-check';

  interface Props {
    component: ParsedComponent;
    interactive?: boolean;
    onselect?: (value: string) => void;
    onaction?: (path: number[], event: 'select' | 'click' | 'toggle' | 'submit' | 'setting', value?: string) => void;
    inputValue?: string;
    oninputchange?: (value: string) => void;
  }

  let {
    component,
    interactive = false,
    onselect,
    onaction,
    inputValue = $bindable(''),
    oninputchange = () => {},
  }: Props = $props();
  let checkboxStates = $state<Record<string, boolean>>({});
  let settingsLocal = $state<Record<string, string>>({});

  function submitInput(comp: { path?: number[] }) {
    if (onaction) onaction(comp.path ?? [], 'submit', inputValue);
  }

  function cycleSetting(item: { id: string; currentValue: string; values?: string[] }, path: number[]) {
    if (!item.values || item.values.length === 0) return;
    const current = settingsLocal[item.id] ?? item.currentValue;
    const idx = item.values.indexOf(current);
    const next = item.values[(idx + 1) % item.values.length];
    settingsLocal[item.id] = next;
    onaction?.(path, 'setting', `${item.id}::${next}`);
  }
</script>

{#snippet renderParsed(comp: ParsedComponent)}
  {#if comp.kind === 'select'}
    {#if comp.label}
      <p class="text-sm text-base-content/65 mb-2">{comp.label}</p>
    {/if}
    <div class="space-y-1 {interactive ? 'max-h-60 overflow-y-auto pr-1' : 'flex flex-wrap gap-1'}">
      {#each comp.options as opt (opt.value)}
        {#if interactive && (onaction || onselect)}
          <button
            class="w-full rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2.5 text-left text-sm text-base-content/75 transition-colors hover:bg-primary/10 hover:text-base-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
            onclick={() => (onaction ? onaction(comp.path ?? [], 'select', opt.value) : onselect?.(opt.value))}
          >
            <span class="font-medium">{opt.label}</span>
            {#if opt.description}
              <span class="block text-xs text-base-content/45 mt-0.5">{opt.description}</span>
            {/if}
          </button>
        {:else}
          <span class="px-2 py-0.5 bg-base-content/10 rounded text-xs text-base-content/70">{opt.label}</span>
        {/if}
      {/each}
    </div>
  {:else if comp.kind === 'input'}
    <div class="flex flex-col gap-1.5">
      {#if comp.label}
        <span class="text-sm text-base-content/65">{comp.label}</span>
      {/if}
      {#if comp.multiline}
        <textarea
          bind:value={inputValue}
          placeholder={comp.placeholder ?? ''}
          rows={6}
          oninput={() => oninputchange(inputValue)}
          onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitInput(comp); } }}
          class="w-full rounded-lg border border-base-content/12 bg-base-content/[0.025] p-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-base-content/35 focus:border-primary/50 focus:bg-base-100/60"
        ></textarea>
      {:else}
        <input
          type="text"
          bind:value={inputValue}
          placeholder={comp.placeholder ?? ''}
          oninput={() => oninputchange(inputValue)}
          onkeydown={(e) => { if (e.key === 'Enter') submitInput(comp); }}
          class="w-full rounded-lg border border-base-content/12 bg-base-content/[0.025] px-3 py-2 text-sm outline-none transition-colors placeholder:text-base-content/35 focus:border-primary/50 focus:bg-base-100/60"
        />
      {/if}
    </div>
  {:else if comp.kind === 'text'}
    {#if comp.monoPreserve}
      <pre
        class="max-h-56 overflow-y-auto rounded-lg border border-base-content/8 bg-base-content/[0.035] p-3 text-xs font-mono text-base-content/65 whitespace-pre leading-relaxed"
      >{comp.content}</pre>
    {:else if comp.content}
      <p class="text-sm text-base-content/75 whitespace-pre-wrap leading-relaxed">{comp.content}</p>
    {/if}
  {:else if comp.kind === 'markdown'}
    <div class="prose prose-sm max-w-none text-base-content/80">{@html renderMarkdown(comp.content)}</div>
  {:else if comp.kind === 'settings'}
    <div class="space-y-1">
      {#each comp.items as item (item.id)}
        {@const cyclable = interactive && !!item.values?.length}
        {#if cyclable}
          <button
            type="button"
            class="flex w-full items-center justify-between gap-3 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-left text-sm transition-colors hover:bg-primary/10"
            onclick={() => cycleSetting(item, comp.path ?? [])}
          >
            <div class="min-w-0">
              <span class="text-base-content/75">{item.label}</span>
              {#if item.description}
                <span class="block text-xs text-base-content/45 mt-0.5">{item.description}</span>
              {/if}
            </div>
            <span class="shrink-0 rounded-full bg-base-content/10 px-2 py-0.5 text-xs text-base-content/60">{settingsLocal[item.id] ?? item.currentValue}</span>
          </button>
        {:else}
          <div class="flex items-center justify-between gap-3 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-sm">
            <div class="min-w-0">
              <span class="text-base-content/75">{item.label}</span>
              {#if item.description}
                <span class="block text-xs text-base-content/45 mt-0.5">{item.description}</span>
              {/if}
            </div>
            <span class="shrink-0 rounded-full bg-base-content/10 px-2 py-0.5 text-xs text-base-content/60">{item.currentValue}</span>
          </div>
        {/if}
      {/each}
    </div>
  {:else if comp.kind === 'button'}
    {#if interactive && (onaction || onselect)}
      <Button
        variant={comp.variant === 'primary' ? 'default' : comp.variant === 'danger' ? 'destructive' : 'outline'}
        size="sm"
        class="w-full justify-start"
        onclick={() => (onaction ? onaction(comp.path ?? [], 'click', comp.label) : onselect?.(comp.label))}
      >{comp.label}</Button>
    {:else}
      <span class="font-semibold text-sm" class:text-primary={comp.variant === 'primary'} class:text-destructive={comp.variant === 'danger'}>{comp.label}</span>
    {/if}
  {:else if comp.kind === 'checkbox'}
    {#if interactive}
      {@const localChecked = checkboxStates[comp.label] ?? comp.checked}
      <button
        class="flex w-full items-center gap-2 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-left text-sm text-base-content/65 transition-colors hover:bg-primary/10 hover:text-base-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        aria-pressed={localChecked}
        onclick={() => { checkboxStates[comp.label] = !localChecked; onaction?.(comp.path ?? [], 'toggle', String(!localChecked)); }}
      >
        <span class="w-4 h-4 rounded border {localChecked ? 'bg-primary/20 border-primary' : 'border-base-content/20'} flex items-center justify-center text-xs">
          {#if localChecked}
            <SquareCheck class="w-3.5 h-3.5 text-primary/70" />
          {:else}
            <Square class="w-3.5 h-3.5 text-base-content/35" />
          {/if}
        </span>
        <span>{comp.label}</span>
      </button>
    {:else}
      <div class="flex items-center gap-2 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-sm text-base-content/65">
        <span class="w-4 h-4 rounded border {comp.checked ? 'bg-primary/20 border-primary' : 'border-base-content/20'} flex items-center justify-center text-xs">
          {#if comp.checked}
            <SquareCheck class="w-3.5 h-3.5 text-primary/70" />
          {:else}
            <Square class="w-3.5 h-3.5 text-base-content/35" />
          {/if}
        </span>
        <span>{comp.label}</span>
      </div>
    {/if}
  {:else if comp.kind === 'progress'}
    <div class="flex flex-col gap-1.5">
      {#if comp.label}
        <span class="text-xs text-base-content/55">{comp.label}</span>
      {/if}
      <progress
        value={comp.progress}
        max="1"
        aria-label={comp.label || 'Progress'}
        class="w-full h-2 rounded-full [&::-webkit-progress-bar]:bg-base-content/10 [&::-webkit-progress-value]:bg-primary/60 [&::-moz-progress-bar]:bg-primary/60"
      ></progress>
    </div>
  {:else if comp.kind === 'loader'}
    <div class="flex items-center gap-2 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-sm text-base-content/65">
      <LoaderIcon class="w-4 h-4 animate-spin text-primary/70" />
      {#if comp.label}
        <span>{comp.label}</span>
      {/if}
      {#if comp.cancellable}
        <span class="ml-auto text-[10px] uppercase tracking-wide text-base-content/35">Esc to cancel</span>
      {/if}
    </div>
  {:else if comp.kind === 'image'}
    <div class="flex flex-col gap-1">
      {#if comp.label}
        <span class="text-xs text-muted-foreground mb-1">{comp.label}</span>
      {/if}
      <img src="data:{comp.mimeType};base64,{comp.data}" alt={comp.label} class="max-h-64 max-w-full rounded-lg object-contain border border-base-content/10" />
    </div>
  {:else if comp.kind === 'container'}
    <div class="flex {comp.direction === 'horizontal' ? 'flex-row flex-wrap gap-3' : 'flex-col gap-2'}">
      {#each comp.children as child (child.kind + (JSON.stringify(child).slice(0, 32)))}
        {@render renderParsed(child)}
      {/each}
    </div>
  {/if}
{/snippet}

{@render renderParsed(component)}
