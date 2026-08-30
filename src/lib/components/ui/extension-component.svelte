<script lang="ts">
  import type { ParsedComponent } from '#lib/tui-stubs.js';
  import { Button } from '#lib/components/ui/button/index.js';
  import { renderMarkdown } from '#lib/markdown.js';
  import LoaderIcon from '@lucide/svelte/icons/loader';
  import Square from '@lucide/svelte/icons/square';

  interface Props {
    component: ParsedComponent;
    interactive?: boolean;
    onselect?: (value: string) => void;
    onaction?: (
      path: number[],
      event: 'select' | 'click' | 'toggle' | 'submit' | 'setting',
      value?: string
    ) => void;
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
  let failedImages = $state<Record<string, boolean>>({});

  function submitInput(comp: { path?: number[] }) {
    if (onaction) onaction(comp.path ?? [], 'submit', inputValue);
  }

  function cycleSetting(
    item: { id: string; currentValue: string; values?: string[] },
    path: number[]
  ) {
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
      <p class="mb-2 break-words text-sm text-base-content/65">{comp.label}</p>
    {/if}
    <div
      class="min-w-0 space-y-1 {interactive
        ? 'max-h-[min(24rem,45dvh)] overflow-y-auto pr-1'
        : 'flex flex-wrap gap-1'}"
    >
      {#each comp.options as opt (opt.value)}
        {#if interactive && (onaction || onselect)}
          <button
            type="button"
            class="w-full min-w-0 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2.5 text-left text-sm text-base-content/75 transition-colors hover:bg-primary/10 hover:text-base-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
            onclick={() =>
              onaction ? onaction(comp.path ?? [], 'select', opt.value) : onselect?.(opt.value)}
          >
            <span class="block whitespace-normal break-words font-medium">{opt.label}</span>
            {#if opt.description}
              <span class="mt-0.5 block whitespace-normal break-words text-xs text-base-content/45"
                >{opt.description}</span
              >
            {/if}
          </button>
        {:else}
          <span
            class="max-w-full break-words rounded bg-base-content/10 px-2 py-0.5 text-xs text-base-content/70"
            >{opt.label}</span
          >
        {/if}
      {/each}
    </div>
  {:else if comp.kind === 'input'}
    <div class="min-w-0 flex flex-col gap-1.5">
      {#if comp.label}
        <span class="break-words text-sm text-base-content/65">{comp.label}</span>
      {/if}
      {#if comp.multiline}
        <textarea
          bind:value={inputValue}
          placeholder={comp.placeholder ?? ''}
          rows={6}
          oninput={() => oninputchange(inputValue)}
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitInput(comp);
            }
          }}
          class="max-h-[min(18rem,40dvh)] w-full resize-y rounded-lg border border-base-content/12 bg-base-content/[0.025] p-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-base-content/35 focus:border-primary/50 focus:bg-base-100/60"
        ></textarea>
      {:else}
        <input
          type="text"
          bind:value={inputValue}
          placeholder={comp.placeholder ?? ''}
          oninput={() => oninputchange(inputValue)}
          onkeydown={(e) => {
            if (e.key === 'Enter') submitInput(comp);
          }}
          class="w-full min-w-0 rounded-lg border border-base-content/12 bg-base-content/[0.025] px-3 py-2 text-sm outline-none transition-colors placeholder:text-base-content/35 focus:border-primary/50 focus:bg-base-100/60"
        />
      {/if}
    </div>
  {:else if comp.kind === 'text'}
    {#if comp.monoPreserve}
      <pre
        class="max-h-[min(18rem,45dvh)] max-w-full overflow-auto rounded-lg border border-base-content/8 bg-base-content/[0.035] p-3 text-xs font-mono leading-relaxed text-base-content/65 whitespace-pre">{comp.content}</pre>
    {:else if comp.content}
      <p
        class="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-base-content/75"
      >
        {comp.content}
      </p>
    {/if}
  {:else if comp.kind === 'markdown'}
    {#if comp.content}
      <div class="prose prose-sm min-w-0 max-w-none overflow-x-auto text-base-content/80">
        {@html renderMarkdown(comp.content)}
      </div>
    {/if}
  {:else if comp.kind === 'settings'}
    <div class="min-w-0 space-y-1">
      {#each comp.items as item (item.id)}
        {@const cyclable = interactive && !!item.values?.length}
        {#if cyclable}
          <button
            type="button"
            class="flex w-full min-w-0 items-start justify-between gap-3 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-left text-sm transition-colors hover:bg-primary/10"
            onclick={() => cycleSetting(item, comp.path ?? [])}
          >
            <div class="min-w-0">
              <span class="break-words text-base-content/75">{item.label}</span>
              {#if item.description}
                <span class="mt-0.5 block break-words text-xs text-base-content/45"
                  >{item.description}</span
                >
              {/if}
            </div>
            <span
              class="shrink-0 rounded-full bg-base-content/10 px-2 py-0.5 text-xs tabular-nums text-base-content/60"
              >{settingsLocal[item.id] ?? item.currentValue}</span
            >
          </button>
        {:else}
          <div
            class="flex w-full min-w-0 items-start justify-between gap-3 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-sm"
          >
            <div class="min-w-0">
              <span class="break-words text-base-content/75">{item.label}</span>
              {#if item.description}
                <span class="mt-0.5 block break-words text-xs text-base-content/45"
                  >{item.description}</span
                >
              {/if}
            </div>
            <span
              class="shrink-0 rounded-full bg-base-content/10 px-2 py-0.5 text-xs tabular-nums text-base-content/60"
              >{item.currentValue}</span
            >
          </div>
        {/if}
      {/each}
    </div>
  {:else if comp.kind === 'button'}
    {#if interactive && (onaction || onselect)}
      <Button
        variant={comp.variant === 'primary'
          ? 'default'
          : comp.variant === 'danger'
            ? 'destructive'
            : 'outline'}
        size="sm"
        class="h-auto min-h-9 w-full max-w-full justify-start whitespace-normal break-words text-left"
        onclick={() =>
          onaction ? onaction(comp.path ?? [], 'click', comp.label) : onselect?.(comp.label)}
        >{comp.label}</Button
      >
    {:else}
      <span
        class="break-words text-sm font-semibold"
        class:text-primary={comp.variant === 'primary'}
        class:text-destructive={comp.variant === 'danger'}>{comp.label}</span
      >
    {/if}
  {:else if comp.kind === 'checkbox'}
    {#if interactive}
      {@const localChecked = checkboxStates[comp.label] ?? comp.checked}
      <button
        type="button"
        class="flex w-full min-w-0 items-start gap-2 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-left text-sm text-base-content/65 transition-colors hover:bg-primary/10 hover:text-base-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        role="checkbox"
        aria-checked={localChecked}
        onclick={() => {
          checkboxStates[comp.label] = !localChecked;
          onaction?.(comp.path ?? [], 'toggle', String(!localChecked));
        }}
      >
        <span
          class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-xs transition-colors {localChecked
            ? 'border-primary bg-primary'
            : 'border-base-content/20'}"
        >
          {#if localChecked}
            <svg
              class="h-3 w-3 text-white"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"><path d="M2 6l3 3 5-5" /></svg
            >
          {:else}
            <Square class="h-3.5 w-3.5 text-base-content/35" />
          {/if}
        </span>
        <span class="min-w-0 break-words">{comp.label}</span>
      </button>
    {:else}
      <div
        class="flex w-full min-w-0 items-start gap-2 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-sm text-base-content/65"
        role="checkbox"
        aria-checked={comp.checked}
      >
        <span
          class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border text-xs transition-colors {comp.checked
            ? 'border-primary bg-primary'
            : 'border-base-content/20'}"
        >
          {#if comp.checked}
            <svg
              class="h-3 w-3 text-white"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"><path d="M2 6l3 3 5-5" /></svg
            >
          {:else}
            <Square class="h-3.5 w-3.5 text-base-content/35" />
          {/if}
        </span>
        <span class="min-w-0 break-words">{comp.label}</span>
      </div>
    {/if}
  {:else if comp.kind === 'progress'}
    <div class="min-w-0 flex flex-col gap-1.5" role="status" aria-live="polite">
      {#if comp.label}
        <span class="break-words text-xs text-base-content/55">{comp.label}</span>
      {/if}
      <progress
        value={comp.progress}
        max="1"
        aria-label={comp.label || 'Progress'}
        class="h-2 w-full max-w-full rounded-full [&::-webkit-progress-bar]:bg-base-content/10 [&::-webkit-progress-value]:bg-primary/60 [&::-moz-progress-bar]:bg-primary/60"
      ></progress>
    </div>
  {:else if comp.kind === 'loader'}
    <div
      class="flex min-w-0 items-start gap-2 rounded-lg border border-base-content/8 bg-base-content/[0.025] px-3 py-2 text-sm text-base-content/65"
      role="status"
      aria-live="polite"
    >
      <LoaderIcon
        class="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary/70 motion-reduce:animate-none"
      />
      {#if comp.label}
        <span class="min-w-0 break-words">{comp.label}</span>
      {/if}
      {#if comp.cancellable}
        <span class="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-base-content/35"
          >Esc to cancel</span
        >
      {/if}
    </div>
  {:else if comp.kind === 'image'}
    {@const imageKey = comp.path?.join('.') ?? `${comp.label}:${comp.mimeType}`}
    <div class="min-w-0 flex flex-col gap-1">
      {#if comp.label}
        <span class="mb-1 break-words text-xs text-muted-foreground">{comp.label}</span>
      {/if}
      {#if failedImages[imageKey]}
        <div
          role="img"
          aria-label={comp.label || 'Extension image unavailable'}
          class="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-base-content/12 bg-base-content/[0.025] px-4 py-6 text-center text-xs text-base-content/45"
        >
          Image unavailable
        </div>
      {:else}
        <img
          src="data:{comp.mimeType};base64,{comp.data}"
          alt={comp.label}
          onerror={() => (failedImages[imageKey] = true)}
          class="max-h-[min(24rem,50dvh)] max-w-full rounded-lg border border-base-content/10 object-contain"
        />
      {/if}
    </div>
  {:else if comp.kind === 'container'}
    {@const horizontal = comp.direction === 'horizontal'}
    <div class="min-w-0 flex {horizontal ? 'flex-row flex-wrap gap-2 sm:gap-3' : 'flex-col gap-2'}">
      {#each comp.children as child, i (i)}
        <div class={horizontal ? 'min-w-0 flex-1 basis-56' : 'min-w-0'}>
          {@render renderParsed(child)}
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

<div class="min-w-0 max-w-full overflow-hidden">
  {@render renderParsed(component)}
</div>
