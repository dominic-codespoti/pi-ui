<script lang="ts">
  import { dev } from '$app/environment';
  import ExtensionComponent from '$lib/components/ui/extension-component.svelte';
  import type { ParsedComponent } from '$lib/tui-stubs';
  import { Button } from '$lib/components/ui/button';

  // ── Default JSON for live editor ───────────────────────────────────────
  const DEFAULT_JSON = JSON.stringify(
    {
      kind: 'container',
      direction: 'vertical',
      children: [
        { kind: 'text', label: '', content: 'Welcome to the extension lab! Try editing this JSON.' },
        { kind: 'input', label: 'Your name', placeholder: 'Type here…' },
        { kind: 'button', label: 'Submit', variant: 'primary' },
      ],
    },
    null,
    2,
  );

  let editorJson = $state(DEFAULT_JSON);
  let editorError = $state('');
  let liveComp = $derived.by(() => {
    try {
      const parsed = JSON.parse(editorJson);
      editorError = '';
      return parsed as ParsedComponent;
    } catch (e) {
      editorError = (e as Error).message;
      return null;
    }
  });

  // ── Interaction log ────────────────────────────────────────────────────
  let log = $state<{ time: string; value: string }[]>([]);
  function onLog(value: string) {
    log = [...log.slice(-49), { time: new Date().toLocaleTimeString(), value }];
  }
  function clearLog() {
    log = [];
  }

  // ── Catalog of examples ────────────────────────────────────────────────
  interface Example {
    name: string;
    comp: ParsedComponent;
  }

  const catalog: { section: string; examples: Example[] }[] = [
    {
      section: 'Select',
      examples: [
        {
          name: 'Simple select',
          comp: { kind: 'select', label: 'Pick a model', options: [
            { value: 'gpt-4', label: 'GPT-4' },
            { value: 'claude', label: 'Claude 3.5' },
            { value: 'llama', label: 'Llama 3' },
          ]},
        },
        {
          name: 'Select with descriptions',
          comp: { kind: 'select', label: 'Choose provider', options: [
            { value: 'openai', label: 'OpenAI', description: 'GPT-4o, GPT-4-turbo' },
            { value: 'anthropic', label: 'Anthropic', description: 'Claude 3 Opus, Sonnet' },
            { value: 'google', label: 'Google', description: 'Gemini 1.5 Pro' },
          ]},
        },
      ],
    },
    {
      section: 'Input',
      examples: [
        {
          name: 'Single-line',
          comp: { kind: 'input', label: 'API Key', placeholder: 'sk-…', value: '' },
        },
        {
          name: 'Multi-line',
          comp: { kind: 'input', label: 'Description', placeholder: 'Enter details…', value: '', multiline: true },
        },
        {
          name: 'Prefilled',
          comp: { kind: 'input', label: 'Name', placeholder: 'Your name', value: 'Alice' },
        },
      ],
    },
    {
      section: 'Button',
      examples: [
        {
          name: 'Default',
          comp: { kind: 'button', label: 'Cancel', variant: 'default' },
        },
        {
          name: 'Primary',
          comp: { kind: 'button', label: 'Confirm', variant: 'primary' },
        },
        {
          name: 'Danger',
          comp: { kind: 'button', label: 'Delete', variant: 'danger' },
        },
      ],
    },
    {
      section: 'Checkbox',
      examples: [
        {
          name: 'Unchecked',
          comp: { kind: 'checkbox', label: 'Enable telemetry', checked: false },
        },
        {
          name: 'Checked',
          comp: { kind: 'checkbox', label: 'I agree to terms', checked: true },
        },
        {
          name: 'Multiple',
          comp: {
            kind: 'container',
            direction: 'vertical',
            children: [
              { kind: 'checkbox', label: 'Option A', checked: true },
              { kind: 'checkbox', label: 'Option B', checked: false },
              { kind: 'checkbox', label: 'Option C', checked: false },
            ],
          } as ParsedComponent,
        },
      ],
    },
    {
      section: 'Text & Markdown',
      examples: [
        {
          name: 'Plain text',
          comp: { kind: 'text', label: '', content: 'This is a plain text block used for descriptions and labels.' },
        },
        {
          name: 'Monospace preserved',
          comp: { kind: 'text', label: '', content: '> tree\n  src/\n    lib/\n      components/', monoPreserve: true },
        },
      ],
    },
    {
      section: 'Progress & Loader',
      examples: [
        {
          name: 'Progress 45%',
          comp: { kind: 'progress', label: 'Downloading…', progress: 0.45 },
        },
        {
          name: 'Progress complete',
          comp: { kind: 'progress', label: 'Done', progress: 1.0 },
        },
        {
          name: 'Loader active',
          comp: { kind: 'loader', label: 'Processing…' },
        },
        {
          name: 'Cancellable loader',
          comp: { kind: 'loader', label: 'Running sub-agent…', cancellable: true },
        },
      ],
    },
    {
      section: 'Markdown & Settings',
      examples: [
        {
          name: 'Markdown block',
          comp: {
            kind: 'markdown',
            content: '## Release notes\n\n- Fixed **crash** on startup\n- Added `--verbose` flag\n- See [changelog](https://example.com)',
          },
        },
        {
          name: 'Settings list',
          comp: {
            kind: 'settings',
            items: [
              { id: 'theme', label: 'Theme', currentValue: 'dark', values: ['light', 'dark', 'system'] },
              { id: 'model', label: 'Default model', description: 'Used for new sessions', currentValue: 'claude-sonnet' },
              { id: 'autosave', label: 'Autosave', currentValue: 'on', values: ['on', 'off'] },
            ],
          },
        },
      ],
    },
    {
      section: 'Container layouts',
      examples: [
        {
          name: 'Vertical stack',
          comp: {
            kind: 'container',
            direction: 'vertical',
            children: [
              { kind: 'text', label: '', content: 'Fill in your details:' },
              { kind: 'input', label: 'Name', placeholder: '', value: '' },
              { kind: 'input', label: 'Email', placeholder: '', value: '' },
              { kind: 'button', label: 'Submit', variant: 'primary' },
            ],
          } as ParsedComponent,
        },
        {
          name: 'Horizontal buttons',
          comp: {
            kind: 'container',
            direction: 'horizontal',
            children: [
              { kind: 'button', label: 'Save', variant: 'primary' },
              { kind: 'button', label: 'Cancel', variant: 'default' },
              { kind: 'button', label: 'Delete', variant: 'danger' },
            ],
          } as ParsedComponent,
        },
        {
          name: 'Nested (form)',
          comp: {
            kind: 'container',
            direction: 'vertical',
            children: [
              { kind: 'text', label: '', content: 'Settings' },
              {
                kind: 'container',
                direction: 'vertical',
                children: [
                  { kind: 'checkbox', label: 'Dark mode', checked: true },
                  { kind: 'checkbox', label: 'Notifications', checked: false },
                ],
              } as ParsedComponent,
              {
                kind: 'container',
                direction: 'horizontal',
                children: [
                  { kind: 'button', label: 'Apply', variant: 'primary' },
                  { kind: 'button', label: 'Reset', variant: 'default' },
                ],
              } as ParsedComponent,
            ],
          } as ParsedComponent,
        },
      ],
    },
    {
      section: 'Real-world examples',
      examples: [
        {
          name: 'Model picker dialog',
          comp: {
            kind: 'container',
            direction: 'vertical',
            children: [
              { kind: 'text', label: '', content: 'Choose a model for this conversation:' },
              {
                kind: 'select',
                label: 'Model',
                options: [
                  { value: 'gpt-4o', label: 'GPT-4o', description: 'Fast, general purpose' },
                  { value: 'claude-sonnet', label: 'Claude 3.5 Sonnet', description: 'Best for coding' },
                ],
              },
              {
                kind: 'container',
                direction: 'horizontal',
                children: [
                  { kind: 'button', label: 'Switch', variant: 'primary' },
                  { kind: 'button', label: 'Cancel', variant: 'default' },
                ],
              } as ParsedComponent,
            ],
          } as ParsedComponent,
        },
        {
          name: 'Install extension',
          comp: {
            kind: 'container',
            direction: 'vertical',
            children: [
              { kind: 'text', label: '', content: 'Extension: prettier\nVersion: 3.4.2\nSize: 2.1 MB' },
              { kind: 'progress', label: 'Downloading…', progress: 0.6 },
              { kind: 'checkbox', label: 'Install globally', checked: false },
              { kind: 'button', label: 'Install', variant: 'primary' },
            ],
          } as ParsedComponent,
        },
        {
          name: 'Confirm destructive action',
          comp: {
            kind: 'container',
            direction: 'vertical',
            children: [
              { kind: 'text', label: '', content: 'Are you sure you want to delete the project "my-app"? This action cannot be undone.' },
              {
                kind: 'container',
                direction: 'horizontal',
                children: [
                  { kind: 'button', label: 'Delete', variant: 'danger' },
                  { kind: 'button', label: 'Cancel', variant: 'default' },
                ],
              } as ParsedComponent,
            ],
          } as ParsedComponent,
        },
      ],
    },
  ];
</script>

<svelte:head>
  <title>Extension Lab — pi UI</title>
</svelte:head>

<div class="mx-auto max-w-6xl px-4 py-8 font-mono text-base-content">
  <!-- ── Header ────────────────────────────────────────────────────────── -->
  <div class="mb-8">
    <h1 class="text-2xl font-bold tracking-tight">Extension Component Lab</h1>
    <p class="mt-1 text-sm text-base-content/50">
      dev only — {#if !dev}
        <span class="text-destructive">not available in production</span>
      {:else}
        interactive preview of all ParsedComponent variants
      {/if}
    </p>
  </div>

  {#if dev}
    <!-- ── Live Editor ──────────────────────────────────────────────────── -->
    <section class="mb-10 rounded-xl border border-base-content/10 bg-base-200/50 p-4">
      <h2 class="mb-3 text-sm font-semibold uppercase tracking-wider text-base-content/60">Live Editor</h2>
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label for="live-json" class="mb-1 block text-xs text-base-content/50">ParsedComponent JSON</label>
          <textarea
            id="live-json"
            bind:value={editorJson}
            class="h-64 w-full rounded-lg border border-base-content/12 bg-base-300/50 p-3 text-xs leading-relaxed outline-none transition-colors focus:border-primary/50 font-mono"
          ></textarea>
          {#if editorError}
            <p class="mt-1 text-xs text-destructive">{editorError}</p>
          {/if}
        </div>
        <div>
          <p class="mb-1 block text-xs text-base-content/50">Rendered output</p>
          {#if liveComp}
            <div class="rounded-lg border border-base-content/8 bg-base-200 p-4">
              <ExtensionComponent component={liveComp} interactive onselect={onLog} />
            </div>
          {:else if !editorError}
            <div class="flex h-64 items-center justify-center rounded-lg border border-dashed border-base-content/12 text-xs text-base-content/30">
              Enter valid JSON above
            </div>
          {/if}
        </div>
      </div>
    </section>

    <!-- ── Component Gallery ────────────────────────────────────────────── -->
    <section class="mb-10">
      <h2 class="mb-4 text-sm font-semibold uppercase tracking-wider text-base-content/60">Component Gallery</h2>

      {#each catalog as section (section.section)}
        <div class="mb-6">
          <h3 class="mb-3 text-xs font-semibold uppercase tracking-[0.15em] text-base-content/40">{section.section}</h3>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {#each section.examples as ex (ex.name)}
              <div class="rounded-xl border border-base-content/8 bg-base-200/30 p-4">
                <p class="mb-2 text-xs font-medium text-base-content/60">{ex.name}</p>
                <div class="mb-3 rounded-lg border border-base-content/5 bg-base-200 p-3">
                  <ExtensionComponent component={ex.comp} interactive onselect={onLog} />
                </div>
                <details class="group">
                  <summary class="cursor-pointer text-xs text-base-content/40 hover:text-base-content/60">
                    JSON
                  </summary>
                  <pre class="mt-2 overflow-x-auto rounded bg-base-300/50 p-2 text-[10px] leading-relaxed text-base-content/50"><code>{JSON.stringify(ex.comp, null, 2)}</code></pre>
                </details>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </section>

    <!-- ── Interaction Log ──────────────────────────────────────────────── -->
    <section class="mb-10 rounded-xl border border-base-content/10 bg-base-200/50 p-4">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-base-content/60">Interaction Log</h2>
        <Button size="xs" variant="outline" onclick={clearLog}>Clear</Button>
      </div>
      {#if log.length === 0}
        <p class="text-xs text-base-content/30">Click interactive elements above to see events here.</p>
      {:else}
        <div class="max-h-48 space-y-0.5 overflow-y-auto font-mono text-xs">
          {#each log as entry (entry.time + entry.value)}
            <div class="rounded bg-base-300/30 px-2 py-1 text-base-content/60">
              <span class="text-base-content/40">{entry.time}</span> {entry.value}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</div>
