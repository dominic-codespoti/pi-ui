import Cog from '@lucide/svelte/icons/cog';
import Terminal from '@lucide/svelte/icons/terminal';
import FileText from '@lucide/svelte/icons/file-text';
import Pencil from '@lucide/svelte/icons/pencil';
import Search from '@lucide/svelte/icons/search';
import List from '@lucide/svelte/icons/list';
import Trash from '@lucide/svelte/icons/trash';
import Send from '@lucide/svelte/icons/send';
import type { CompactionNoticeDetails, UIMessage } from '#lib/client-messages.js';

type ToolMetaEntry = { icon: typeof Cog; label: string; color: string };

const TOOL_META: Record<string, ToolMetaEntry> = {
  bash: { icon: Terminal, label: 'Shell', color: 'var(--color-info)' },
  execute_bash: { icon: Terminal, label: 'Shell', color: 'var(--color-info)' },
  shell: { icon: Terminal, label: 'Shell', color: 'var(--color-info)' },
  read: {
    icon: FileText,
    label: 'Read',
    color: 'color-mix(in oklch, var(--color-base-content) 45%, transparent)',
  },
  read_file: {
    icon: FileText,
    label: 'Read',
    color: 'color-mix(in oklch, var(--color-base-content) 45%, transparent)',
  },
  cat: {
    icon: FileText,
    label: 'Read',
    color: 'color-mix(in oklch, var(--color-base-content) 45%, transparent)',
  },
  write: { icon: Pencil, label: 'Write', color: 'var(--color-success)' },
  write_file: { icon: Pencil, label: 'Write', color: 'var(--color-success)' },
  edit: { icon: Pencil, label: 'Edit', color: 'var(--color-success)' },
  grep: { icon: Search, label: 'Search', color: 'var(--color-secondary)' },
  find: { icon: Search, label: 'Find', color: 'var(--color-secondary)' },
  ls: { icon: List, label: 'List', color: 'var(--color-primary)' },
};

const HEURISTIC_ICONS: [RegExp, typeof Cog][] = [
  [/search|find|grep|query|lookup/i, Search],
  [/write|create|save|store|generate/i, Pencil],
  [/delete|remove|trash|drop/i, Trash],
  [/send|post|publish|deploy|push/i, Send],
  [/read|fetch|load|get|download/i, FileText],
  [/run|exec|shell|bash|spawn/i, Terminal],
  [/list|ls|dir|enumerate/i, List],
];

export function getToolMeta(name: string | undefined): ToolMetaEntry {
  const key = (name ?? '').toLowerCase();
  if (TOOL_META[key]) return TOOL_META[key];
  let icon = Cog;
  for (const [pattern, component] of HEURISTIC_ICONS) {
    if (pattern.test(key)) {
      icon = component;
      break;
    }
  }
  let label: string;
  if (key.includes('_') || key.includes('-')) {
    label = key.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  } else {
    label = key.charAt(0).toUpperCase() + key.slice(1);
  }
  return { icon, label, color: 'var(--color-primary)' };
}

export function getToolLang(toolName: string | undefined, toolInput: string | undefined): string {
  const name = (toolName ?? '').toLowerCase();
  if (['bash', 'execute_bash', 'shell'].includes(name)) return 'bash';
  if (['read', 'read_file', 'cat'].includes(name)) {
    const path = (toolInput ?? '').split(' ')[0];
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    const extMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      sh: 'bash',
      bash: 'bash',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      html: 'html',
      css: 'css',
      sql: 'sql',
      md: 'markdown',
      rs: 'rust',
      go: 'go',
      cs: 'csharp',
      svelte: 'html',
    };
    return extMap[ext] ?? '';
  }
  return '';
}

export function compactionStatusLabel(status: CompactionNoticeDetails['status']): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'aborted':
      return 'Aborted';
    case 'retrying':
      return 'Retrying';
  }
}

export function compactionStatusClass(status: CompactionNoticeDetails['status']): string {
  switch (status) {
    case 'running':
      return 'border-warning/20 bg-warning/[0.06] text-warning/75';
    case 'completed':
      return 'border-success/20 bg-success/[0.06] text-success/75';

    case 'failed':
      return 'border-error/20 bg-error/[0.06] text-error/75';
    case 'aborted':
      return 'border-base-content/15 bg-base-content/[0.04] text-base-content/55';
    case 'retrying':
      return 'border-info/20 bg-info/[0.06] text-info/75';
  }
}

export function compactionStatus(message: UIMessage): CompactionNoticeDetails['status'] {
  return message.compaction?.status ?? (message.streaming ? 'running' : 'completed');
}

export function compactionSavings(before?: number, after?: number): number | undefined {
  if (before === undefined || after === undefined || before <= 0 || after > before)
    return undefined;
  return Math.round(((before - after) / before) * 100);
}
export function cleanDetail(detail: string): string {
  return detail.startsWith('$ ') ? detail.slice(2) : detail;
}
