import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Compact relative timestamp: "just now", "5m ago", "yesterday", "Mar 4". */
export function formatRelativeDate(ms: number): string {
  const diff = Date.now() - ms;
  const min = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < 2 * min) return 'just now';
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Adds an optional `ref` bindable to a component's props (mirrors bits-ui). */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
  ref?: U | null;
};

/** Strips the `children` snippet prop (mirrors bits-ui). */
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;

/** Strips the `child` snippet prop (mirrors bits-ui). */
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;

/** Strips both `children` and `child` snippet props (mirrors bits-ui). */
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;

// ── Display formatters (shared by chat page + panels) ─────────────────────────

/** Provider display color — used for model picker chips and session badges. */
export function providerColor(id: string): string {
  const map: Record<string, string> = {
    anthropic: '#C06A3A',
    openai: '#10A37F',
    google: '#4285F4',
    gemini: '#4285F4',
    mistral: '#FF7000',
    groq: '#F55036',
    cohere: '#39D3C3',
    deepseek: '#4D90FE',
    xai: '#888888',
    grok: '#888888',
    openrouter: '#6E56CF',
    meta: '#0668E1',
    llama: '#0668E1',
    bedrock: '#FF9900',
    aws: '#FF9900',
  };
  const lower = id.toLowerCase();
  for (const [key, color] of Object.entries(map)) {
    if (lower.includes(key)) return color;
  }
  return '#6B7280';
}

export function versionText(version?: string): string {
  return version && version !== 'unknown' ? `v${version}` : 'unknown';
}

export function sourceLabel(source?: string): string | undefined {
  switch (source) {
    case 'environment':
      return 'env';
    case 'models_json_key':
    case 'models_json_command':
      return 'config';
    case 'fallback':
      return 'config';
    case 'runtime':
      return 'runtime';
    default:
      return undefined;
  }
}

export function canRemove(source?: string): boolean {
  return source === 'stored';
}

export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

export function fmtCost(c: number): string | null {
  if (!c) return null;
  if (c < 0.0001) return '<$0.0001';
  return `$${c.toFixed(4)}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.round(s / 60)}m`;
}
