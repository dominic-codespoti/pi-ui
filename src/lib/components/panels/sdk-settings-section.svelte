<script lang="ts">
  import { Button } from '#lib/components/ui/button/index.js';
  import * as Card from '#lib/components/ui/card/index.js';

  interface Props {
    settings: Record<string, unknown>;
    projectOverrides: Record<string, unknown>;
    descriptions: Record<string, string>;
    busy: boolean;
    errors: Record<string, string>;
    onSet: (key: string, value: unknown, scope: 'global' | 'project') => void;
  }

  let { settings, projectOverrides, descriptions, busy, errors, onSet }: Props = $props();

  type Field = {
    key: string;
    label: string;
    kind: 'select' | 'number' | 'text' | 'boolean' | 'readonly';
    options?: string[];
    min?: number;
    defaultValue?: unknown;
  };
  const groups: { title: string; fields: Field[] }[] = [
    {
      title: 'Agent behaviour',
      fields: [
        {
          key: 'steeringMode',
          label: 'Steering mode',
          kind: 'select',
          options: ['one-at-a-time', 'all'],
          defaultValue: 'one-at-a-time',
        },
        {
          key: 'followUpMode',
          label: 'Follow-up mode',
          kind: 'select',
          options: ['one-at-a-time', 'all'],
          defaultValue: 'one-at-a-time',
        },
      ],
    },
    {
      title: 'Compaction',
      fields: [
        {
          key: 'compaction.enabled',
          label: 'Automatic compaction',
          kind: 'readonly',
          defaultValue: true,
        },
        {
          key: 'compaction.reserveTokens',
          label: 'Reserved response tokens',
          kind: 'number',
          min: 0,
          defaultValue: 16384,
        },
        {
          key: 'compaction.keepRecentTokens',
          label: 'Recent tokens to keep',
          kind: 'number',
          min: 0,
          defaultValue: 20000,
        },
      ],
    },
    {
      title: 'Branch summaries',
      fields: [
        {
          key: 'branchSummary.reserveTokens',
          label: 'Reserved summary tokens',
          kind: 'number',
          min: 0,
          defaultValue: 16384,
        },
        {
          key: 'branchSummary.skipPrompt',
          label: 'Skip summary prompt',
          kind: 'boolean',
          defaultValue: false,
        },
      ],
    },
    {
      title: 'Retries',
      fields: [
        { key: 'retry.enabled', label: 'Automatic retry', kind: 'readonly', defaultValue: true },
        {
          key: 'retry.maxRetries',
          label: 'Maximum agent retries',
          kind: 'number',
          min: 0,
          defaultValue: 3,
        },
        {
          key: 'retry.baseDelayMs',
          label: 'Initial retry delay (ms)',
          kind: 'number',
          min: 0,
          defaultValue: 2000,
        },
        {
          key: 'retry.maxAgentDelayMs',
          label: 'Maximum agent delay (ms)',
          kind: 'number',
          min: 0,
          defaultValue: 60000,
        },
        { key: 'retry.provider.timeoutMs', label: 'Provider timeout (ms)', kind: 'number', min: 0 },
        {
          key: 'retry.provider.maxRetries',
          label: 'Provider retries',
          kind: 'number',
          min: 0,
          defaultValue: 0,
        },
        {
          key: 'retry.provider.maxRetryDelayMs',
          label: 'Maximum provider retry delay (ms)',
          kind: 'number',
          min: 0,
          defaultValue: 60000,
        },
      ],
    },
    {
      title: 'Model defaults',
      fields: [
        { key: 'defaultProvider', label: 'Default provider', kind: 'text' },
        { key: 'defaultModel', label: 'Default model ID', kind: 'text' },
        {
          key: 'defaultThinkingLevel',
          label: 'Default thinking level',
          kind: 'select',
          options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
          defaultValue: 'medium',
        },
      ],
    },
    {
      title: 'Thinking',
      fields: [
        {
          key: 'hideThinkingBlock',
          label: 'Hide thinking blocks',
          kind: 'boolean',
          defaultValue: false,
        },
      ],
    },
    {
      title: 'Images',
      fields: [
        {
          key: 'images.autoResize',
          label: 'Resize images before sending',
          kind: 'boolean',
          defaultValue: true,
        },
        { key: 'images.blockImages', label: 'Block images', kind: 'boolean', defaultValue: false },
      ],
    },
    {
      title: 'Network',
      fields: [
        {
          key: 'transport',
          label: 'Provider transport',
          kind: 'select',
          options: ['auto', 'sse', 'websocket', 'websocket-cached'],
          defaultValue: 'auto',
        },
        {
          key: 'httpIdleTimeoutMs',
          label: 'HTTP idle timeout (ms)',
          kind: 'number',
          min: 0,
          defaultValue: 300000,
        },
        {
          key: 'websocketConnectTimeoutMs',
          label: 'WebSocket connect timeout (ms)',
          kind: 'number',
          min: 0,
          defaultValue: 15000,
        },
      ],
    },
    {
      title: 'Shell',
      fields: [
        { key: 'shellPath', label: 'Shell executable', kind: 'text' },
        { key: 'shellCommandPrefix', label: 'Command prefix', kind: 'text' },
      ],
    },
    {
      title: 'Tools',
      fields: [{ key: 'defaultTools', label: 'Built-in tools (read-only)', kind: 'readonly' }],
    },
    {
      title: 'Resources',
      fields: [
        {
          key: 'enableSkillCommands',
          label: 'Enable skill slash commands',
          kind: 'boolean',
          defaultValue: true,
        },
      ],
    },
  ];

  const editable: Record<string, true> = {
    steeringMode: true,
    followUpMode: true,
    'compaction.enabled': true,
    'retry.enabled': true,
    defaultProvider: true,
    defaultModel: true,
    defaultThinkingLevel: true,
    transport: true,
    hideThinkingBlock: true,
    shellPath: true,
    shellCommandPrefix: true,
    'images.autoResize': true,
    'images.blockImages': true,
    httpIdleTimeoutMs: true,
    enableSkillCommands: true,
  };

  function commit(field: Field, raw: string | boolean) {
    if (field.kind === 'number') {
      if (raw === '') return;
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < (field.min ?? 0)) return;
      onSet(field.key, parsed, 'global');
    } else {
      onSet(field.key, raw, 'global');
    }
  }
</script>

<div class="space-y-4">
  <div class="text-xs text-base-content/45">
    Global defaults are saved in Pi's settings file. Project overrides are shown when present.
    Automatic compaction and retry use the controls above; advanced values without an SDK public
    setter are shown read-only.
  </div>
  {#each groups as group (group.title)}
    <details class="group" open={group.title === 'Agent behaviour'}>
      <summary
        class="cursor-pointer list-none rounded-xl border border-base-content/10 bg-base-100/60 px-4 py-3 text-sm font-semibold text-base-content/75 hover:bg-base-100/85"
      >
        <span>{group.title}</span>
        <span class="float-right text-base-content/35 transition-transform group-open:rotate-90"
          >›</span
        >
      </summary>
      <Card.Root size="sm" class="mt-2 py-0 overflow-hidden bg-base-100/60 border-base-content/10">
        <div class="divide-y divide-base-content/8">
          {#each group.fields as field (field.key)}
            {@const projectValue = projectOverrides[field.key]}
            {@const value = settings[field.key]}
            {@const isEditable = Boolean(editable[field.key]) && field.kind !== 'readonly'}
            <div
              class="px-4 py-3 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.8fr)] gap-2 sm:gap-5 items-center"
            >
              <div class="min-w-0">
                <label class="text-sm text-base-content/75" for={'sdk-setting-' + field.key}
                  >{field.label}</label
                >
                <p class="text-xs text-base-content/40 mt-0.5">
                  {descriptions[field.key] ?? 'SDK setting.'}
                </p>
                {#if projectValue !== undefined}<p class="text-[10px] text-primary/70 mt-1">
                    Project override: {String(projectValue)}
                  </p>{/if}
                {#if !isEditable && field.kind !== 'readonly'}<p
                    class="text-[10px] text-base-content/35 mt-1"
                  >
                    Read-only: this SDK version has no public setter for this value.
                  </p>{/if}
                {#if errors[field.key]}<p class="text-xs text-error mt-1" role="alert">
                    {errors[field.key]}
                  </p>{/if}
              </div>
              <div class="flex items-center gap-2">
                {#if isEditable && field.kind === 'boolean'}
                  <input
                    id={'sdk-setting-' + field.key}
                    type="checkbox"
                    class="toggle toggle-sm"
                    checked={Boolean(value ?? field.defaultValue)}
                    disabled={busy}
                    onchange={(event) => commit(field, event.currentTarget.checked)}
                    aria-label={field.label}
                  />
                {:else if isEditable && field.kind === 'select'}
                  <select
                    id={'sdk-setting-' + field.key}
                    class="select select-sm select-bordered w-full"
                    value={String(value ?? field.defaultValue ?? '')}
                    disabled={busy}
                    onchange={(event) => commit(field, event.currentTarget.value)}
                  >
                    {#each field.options ?? [] as option (option)}<option value={option}
                        >{option}</option
                      >{/each}
                  </select>
                {:else if isEditable && field.kind === 'number'}
                  <input
                    id={'sdk-setting-' + field.key}
                    type="number"
                    class="input input-sm input-bordered w-full"
                    min={field.min}
                    step="1"
                    value={String(value ?? field.defaultValue ?? '')}
                    disabled={busy}
                    onchange={(event) => commit(field, event.currentTarget.value)}
                  />
                {:else if isEditable && field.kind === 'text'}
                  <input
                    id={'sdk-setting-' + field.key}
                    type="text"
                    name={'sdk-setting-' + field.key}
                    autocomplete="off"
                    spellcheck="false"
                    data-1p-ignore
                    data-lpignore="true"
                    data-bwignore
                    data-form-type="other"
                    class="input input-sm input-bordered w-full"
                    value={String(value ?? '')}
                    disabled={busy}
                    onchange={(event) => commit(field, event.currentTarget.value)}
                  />
                {:else}
                  <output class="text-xs text-base-content/50 font-mono"
                    >{Array.isArray(value)
                      ? value.join(', ')
                      : String(value ?? field.defaultValue ?? 'SDK default')}</output
                  >
                {/if}
                {#if isEditable && field.defaultValue !== undefined}
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy || Object.is(value ?? field.defaultValue, field.defaultValue)}
                    onclick={() => onSet(field.key, field.defaultValue, 'global')}>Reset</Button
                  >
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </Card.Root>
    </details>
  {/each}
</div>
