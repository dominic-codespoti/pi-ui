<script lang="ts">
  import { ScrollArea } from '#lib/components/ui/scroll-area/index.js';
  import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
  import type { SkillSummary, PromptSummary } from '#lib/ws/protocol.js';

  let {
    open,
    resourcesLoaded,
    skillFilter = $bindable(),
    filteredSkills,
    skillInstallUrl = $bindable(),
    skillInstallScope = $bindable(),
    skillInstalling,
    skillInstallFeedback = $bindable(),
    onInstallSkill,
    onUseSkill,
  }: {
    open: boolean;
    resourcesLoaded: boolean;
    skillFilter: string;
    filteredSkills: { skills: SkillSummary[]; prompts: PromptSummary[] };
    skillInstallUrl: string;
    skillInstallScope: 'project' | 'user';
    skillInstalling: boolean;
    skillInstallFeedback: { success: boolean; message: string } | null;
    onInstallSkill: (url: string, scope: 'project' | 'user') => void;
    onUseSkill: (name: string) => void;
  } = $props();
</script>

{#snippet sectionHeader(letter: string, bg: string, label: string)}
  <div
    class="sticky top-0 z-10 bg-base-200 px-5 py-2 flex items-center gap-2 border-b border-base-content/6"
  >
    <span
      class="inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[8px] text-white font-bold leading-none select-none shrink-0 {bg}"
      aria-hidden="true">{letter}</span
    >
    <span class="text-[10px] text-base-content/35 uppercase tracking-[0.1em] font-semibold"
      >{label}</span
    >
  </div>
{/snippet}

{#snippet skillItem(skill: SkillSummary)}
  <div class="px-5 py-2.5 flex items-start gap-3 transition-colors hover:bg-base-content/[0.03]">
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5 mb-0.5 flex-wrap">
        <span class="text-sm font-mono text-base-content/80 truncate">{skill.name}</span>
        {#if skill.isBuiltin}<span
            class="shrink-0 px-1.5 py-0.5 rounded text-base-content/30 bg-base-content/6"
            style="font-size:9px">pkg</span
          >{/if}
      </span>
      {#if skill.description}<span class="text-xs text-base-content/40 leading-relaxed line-clamp-2"
          >{skill.description}</span
        >{/if}
    </span>
    <button
      onclick={() => onUseSkill(skill.name)}
      class="shrink-0 mt-0.5 w-7 h-7 flex items-center justify-center text-base-content/30 hover:text-primary hover:bg-primary/10 rounded transition-colors"
      title="Use skill"><CornerDownLeft class="w-3.5 h-3.5" /></button
    >
  </div>
{/snippet}

{#snippet promptItem(prompt: PromptSummary)}
  <div class="px-5 py-2.5 flex items-start gap-3 transition-colors hover:bg-base-content/[0.03]">
    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5 mb-0.5 flex-wrap">
        <span class="text-sm font-mono text-base-content/80 truncate">{prompt.name}</span>
        {#if prompt.isBuiltin}<span
            class="shrink-0 px-1.5 py-0.5 rounded text-base-content/30 bg-base-content/6"
            style="font-size:9px">pkg</span
          >{/if}
      </span>
      {#if prompt.description}<span
          class="text-xs text-base-content/40 leading-relaxed line-clamp-2"
          >{prompt.description}</span
        >{/if}
    </span>
  </div>
{/snippet}

<div
  class="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-base-200/80 to-transparent z-10"
></div>
<div
  class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-base-content/6 to-transparent z-10"
></div>

<div class="flex-1 min-h-0 flex flex-col">
  <div class="shrink-0 px-5 py-3 border-b border-base-content/8">
    <div class="relative">
      <svg
        class="absolute left-0 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/20 pointer-events-none"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg
      >
      <input
        type="search"
        placeholder="filter skills & prompts…"
        bind:value={skillFilter}
        class="focus-ring w-full bg-transparent outline-none text-sm text-base-content/80 placeholder-base-content/20 pl-6 transition-all duration-150 focus:placeholder-base-content/35"
        aria-label="Filter skills and prompts"
        tabindex={open ? 0 : -1}
      />
    </div>
  </div>
  <ScrollArea class="flex-1 min-h-0">
    {#if !resourcesLoaded}
      <div class="px-5 py-6 space-y-3 animate-pulse">
        {#each [0, 1, 2, 3] as i (i)}
          <div class="flex items-center gap-3">
            <div class="w-4 h-4 rounded bg-base-content/8 shrink-0"></div>
            <div class="flex-1 space-y-1.5">
              <div class="h-3 bg-base-content/8 rounded w-{['1/2', '2/5', '1/3', '3/5'][i]}"></div>
              <div class="h-2 bg-base-content/5 rounded w-{['3/4', '1/2', '2/3', '2/5'][i]}"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if filteredSkills.skills.length === 0 && filteredSkills.prompts.length === 0}
      <div class="flex-1 flex items-center justify-center px-5 py-8">
        <p class="text-xs text-base-content/20">
          {skillFilter.trim() ? 'no match' : 'no skills or prompts found'}
        </p>
      </div>
    {:else}
      {#if filteredSkills.skills.length > 0}
        {@const projectSkills = filteredSkills.skills.filter((s) => s.scope === 'project')}
        {@const userSkills = filteredSkills.skills.filter((s) => s.scope === 'user')}
        {@const builtinSkills = filteredSkills.skills.filter(
          (s) => s.isBuiltin && s.scope !== 'project' && s.scope !== 'user'
        )}
        {#if projectSkills.length > 0}{@render sectionHeader(
            'P',
            'bg-primary/70',
            'project skills'
          )}{#each projectSkills as skill (skill.name)}{@render skillItem(skill)}{/each}{/if}
        {#if userSkills.length > 0}{@render sectionHeader(
            'U',
            'bg-accent/70',
            'user skills'
          )}{#each userSkills as skill (skill.name)}{@render skillItem(skill)}{/each}{/if}
        {#if builtinSkills.length > 0}
          {@render sectionHeader('B', 'bg-base-content/30', 'built-in skills')}
          <div class="opacity-70">
            {#each builtinSkills as skill (skill.name)}{@render skillItem(skill)}{/each}
          </div>
        {/if}
      {/if}
      {#if filteredSkills.prompts.length > 0}
        {@const projectPrompts = filteredSkills.prompts.filter((p) => p.scope === 'project')}
        {@const userPrompts = filteredSkills.prompts.filter((p) => p.scope === 'user')}
        {@const builtinPrompts = filteredSkills.prompts.filter((p) => p.isBuiltin)}
        {#if projectPrompts.length > 0}{@render sectionHeader(
            'P',
            'bg-primary/70',
            'project prompts'
          )}{#each projectPrompts as prompt (prompt.name)}{@render promptItem(prompt)}{/each}{/if}
        {#if userPrompts.length > 0}{@render sectionHeader(
            'U',
            'bg-accent/70',
            'user prompts'
          )}{#each userPrompts as prompt (prompt.name)}{@render promptItem(prompt)}{/each}{/if}
        {#if builtinPrompts.length > 0}{@render sectionHeader(
            'B',
            'bg-base-content/30',
            'built-in prompts'
          )}
          <div class="opacity-70">
            {#each builtinPrompts as prompt (prompt.name)}{@render promptItem(prompt)}{/each}
          </div>{/if}
      {/if}
    {/if}
  </ScrollArea>
</div>

<div class="shrink-0 border-t border-base-content/10 px-5 py-3 space-y-2">
  <p class="text-xs text-base-content/40 uppercase tracking-wider mb-1">install skill</p>
  <input
    bind:value={skillInstallUrl}
    type="url"
    placeholder="GitHub URL or raw .md URL"
    class="w-full text-xs bg-base-content/5 border border-base-content/10 rounded-lg px-3 py-2 text-base-content/80 placeholder-base-content/30 focus:outline-none focus:border-primary/50"
    tabindex={open ? 0 : -1}
    onkeydown={(e) => {
      if (e.key === 'Enter' && skillInstallUrl.trim() && !skillInstalling)
        onInstallSkill(skillInstallUrl.trim(), skillInstallScope);
    }}
  />
  <div class="flex items-center gap-2">
    <select
      bind:value={skillInstallScope}
      class="text-xs bg-base-content/5 border border-base-content/10 rounded-lg px-2 py-1.5 text-base-content/70 focus:outline-none focus:border-primary/50"
      tabindex={open ? 0 : -1}
    >
      <option value="user">user (~/.pi)</option>
      <option value="project">project (.pi)</option>
    </select>
    <button
      onclick={() => {
        if (!skillInstallUrl.trim() || skillInstalling) return;
        onInstallSkill(skillInstallUrl.trim(), skillInstallScope);
      }}
      disabled={!skillInstallUrl.trim() || skillInstalling}
      class="flex-1 text-xs py-1.5 px-3 rounded-lg transition-colors {skillInstalling
        ? 'bg-base-content/10 text-base-content/30'
        : 'bg-primary/15 text-primary hover:bg-primary/25'}"
      tabindex={open ? 0 : -1}>{skillInstalling ? 'installing…' : 'install'}</button
    >
  </div>
  {#if skillInstallFeedback}
    <p class="text-xs {skillInstallFeedback.success ? 'text-success' : 'text-error'} leading-snug">
      {skillInstallFeedback.message}
    </p>
  {/if}
</div>
