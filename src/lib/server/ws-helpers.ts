import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { ModelInfo, SessionSummary } from '$lib/ws/protocol';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { SessionFileInfo } from './session-scan';

/** Accepted input — SessionFileInfo with legacy numeric timestamps allowed. */
export type SessionSummaryInput = Omit<SessionFileInfo, 'created' | 'modified'> & {
  created: Date | number;
  modified: Date | number;
  turns?: number;
};

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

export function serializeSession(s: SessionSummaryInput): SessionSummary {
  const rawCount = s.messageCount;
  return {
    id: s.id,
    path: s.path,
    cwd: s.cwd,
    name: s.name,
    created: s.created instanceof Date ? s.created.getTime() : s.created,
    modified: s.modified instanceof Date ? s.modified.getTime() : s.modified,
    messageCount: rawCount,
    turns: s.turns ?? (rawCount > 0 ? undefined : 0),
    firstMessage: s.firstMessage,
  };
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

