import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { ModelInfo, SessionSummary } from '$lib/ws/protocol';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

export function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

export function isInsideWorkspace(activeCwd: string, resolvedPath: string): boolean {
  const root = resolve(activeCwd);
  return resolvedPath === root || resolvedPath.startsWith(root + sep);
}

export function activeCwd(session: AgentSession | null, fallbackCwd: string): string {
  return session?.sessionManager.getCwd() || fallbackCwd;
}

export function serializeModel(model: Model<Api> | undefined | null): ModelInfo | null {
  if (!model) return null;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    thinkingLevelMap: model.thinkingLevelMap,
  };
}

export function serializeSession(s: Record<string, unknown>): SessionSummary {
  const rawCount = s.messageCount as number;
  return {
    id: s.id as string,
    path: s.path as string,
    cwd: s.cwd as string,
    name: s.name as string | undefined,
    created: s.created instanceof Date ? s.created.getTime() : (s.created as number),
    modified: s.modified instanceof Date ? s.modified.getTime() : (s.modified as number),
    messageCount: rawCount,
    turns: (s.turns as number | undefined) ?? (rawCount > 0 ? undefined : 0),
    firstMessage: s.firstMessage as string,
  };
}

/**
 * Count conversational turns in a .jsonl session file.
 * Only counts entries with role === 'user' or role === 'assistant',
 * which gives the real exchange count the user sees, not the SDK's
 * inflated total (which includes bashExecution, toolResult, etc.).
 */
export async function countTurnsInFile(path: string): Promise<number> {
  try {
    const file = Bun.file(path);
    const text = await file.text();
    const lines = text.split('\n');
    let turns = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const msg = entry.message ?? entry;
        if (!msg || typeof msg.role !== 'string') continue;
        const role = msg.role.toLowerCase();
        if (role === 'user' || role === 'assistant') turns++;
      } catch {
        // skip malformed lines
      }
    }
    return turns;
  } catch {
    return 0;
  }
}

export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

export function resolveGitHubRawUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === 'github.com') {
      const parts = u.pathname.replace(/^\//, '').split('/');
      if (parts[2] === 'blob' && parts.length >= 5) {
        const [owner, repo, , branch, ...rest] = parts;
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join('/')}`;
      }
    }
  } catch {
    // invalid URL — will fail at fetch time with a useful error
  }
  return url;
}

export function formatCommand(args: string[]): string {
  return args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

export function ephemeralUpdateHint(root: string, packageName: string): string | null {
  const normalized = root.replaceAll('\\', '/');
  if (normalized.includes('/.bun/install/cache/')) return `bunx ${packageName}@latest --password ...`;
  if (normalized.includes('/.npm/_npx/') || normalized.includes('/_npx/')) return `npx -y ${packageName}@latest --password ...`;
  if (normalized.includes('/pnpm/dlx/') || normalized.includes('/.pnpm/dlx/')) return `pnpm dlx ${packageName}@latest --password ...`;
  if (normalized.includes('/yarn/dlx/')) return `yarn dlx ${packageName}@latest --password ...`;
  return null;
}

export const ALLOWED_SKILL_HOSTS = ['github.com', 'raw.githubusercontent.com', 'gist.githubusercontent.com'];

export const SKIP_DIRS = new Set(['.git', 'node_modules', '.svelte-kit', 'build', 'dist', '.cache']);

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
    case 'environment': return 'env';
    case 'models_json_key':
    case 'models_json_command': return 'config';
    case 'fallback': return 'config';
    case 'runtime': return 'runtime';
    default: return undefined;
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
