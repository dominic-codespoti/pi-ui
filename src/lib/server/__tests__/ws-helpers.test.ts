import { describe, it, expect } from 'vitest';
import {
  expandTilde, isInsideWorkspace, serializeModel, serializeSession,
  compareSemver, resolveGitHubRawUrl, formatCommand, ephemeralUpdateHint,
  providerColor, versionText, sourceLabel, canRemove, fmtTokens, fmtCost, fmtDuration,
} from '../ws-helpers';

describe('expandTilde', () => {
  it('expands ~ to home directory', () => {
    const result = expandTilde('~/projects');
    expect(result).toContain('/projects');
    expect(result).not.toContain('~');
  });

  it('returns non-tilde paths unchanged', () => {
    expect(expandTilde('/absolute/path')).toBe('/absolute/path');
  });
});

describe('isInsideWorkspace', () => {
  it('returns true for exact match', () => {
    expect(isInsideWorkspace('/home/user/proj', '/home/user/proj')).toBe(true);
  });

  it('returns true for path inside workspace', () => {
    expect(isInsideWorkspace('/home/user/proj', '/home/user/proj/src/index.ts')).toBe(true);
  });

  it('returns false for path outside workspace', () => {
    expect(isInsideWorkspace('/home/user/proj', '/home/user/other/file.ts')).toBe(false);
  });

  it('prevents sibling prefix bypass', () => {
    expect(isInsideWorkspace('/home/user/proj', '/home/user/proj-evil/file.ts')).toBe(false);
  });
});

describe('serializeModel', () => {
  it('returns null for null/undefined input', () => {
    expect(serializeModel(null)).toBeNull();
    expect(serializeModel(undefined)).toBeNull();
  });

  it('serializes model with all fields', () => {
    const model = {
      provider: 'openai',
      id: 'gpt-4o',
      name: 'GPT-4o',
      reasoning: false,
      contextWindow: 128_000,
    };
    const result = serializeModel(model as never);
    expect(result?.provider).toBe('openai');
    expect(result?.contextWindow).toBe(128_000);
  });
});

describe('serializeSession', () => {
  it('serializes session with Date timestamps', () => {
    const created = new Date('2024-01-01');
    const modified = new Date('2024-06-15');
    const result = serializeSession({
      id: 's1',
      path: '/sessions/s1.jsonl',
      cwd: '/home/user',
      name: 'Test Session',
      created,
      modified,
      messageCount: 10,
      firstMessage: 'Hello',
    });
    expect(result.id).toBe('s1');
    expect(result.created).toBe(created.getTime());
    expect(result.modified).toBe(modified.getTime());
    expect(result.messageCount).toBe(10);
  });

  it('serializes session with numeric timestamps', () => {
    const result = serializeSession({
      id: 's2',
      path: '/sessions/s2.jsonl',
      cwd: '/home/user',
      created: 1700000000000,
      modified: 1705000000000,
      messageCount: 5,
      firstMessage: 'hi',
    });
    expect(result.created).toBe(1700000000000);
  });
});

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns 1 when a > b', () => {
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1);
  });

  it('returns -1 when a < b', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
  });

  it('handles semver with pre-release tags', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBe(0);
  });

  it('strips leading v', () => {
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
  });
});

describe('resolveGitHubRawUrl', () => {
  it('converts github.com blob URL to raw', () => {
    expect(resolveGitHubRawUrl('https://github.com/user/repo/blob/main/src/index.ts'))
      .toBe('https://raw.githubusercontent.com/user/repo/main/src/index.ts');
  });

  it('passes through raw.githubusercontent.com URLs', () => {
    const url = 'https://raw.githubusercontent.com/user/repo/main/file.md';
    expect(resolveGitHubRawUrl(url)).toBe(url);
  });

  it('passes through non-GitHub URLs', () => {
    const url = 'https://example.com/file.md';
    expect(resolveGitHubRawUrl(url)).toBe(url);
  });
});

describe('formatCommand', () => {
  it('joins args with spaces', () => {
    expect(formatCommand(['bun', 'run', 'start'])).toBe('bun run start');
  });

  it('quotes args with spaces', () => {
    expect(formatCommand(['bun', 'run', 'my script'])).toBe('bun run "my script"');
  });
});

describe('ephemeralUpdateHint', () => {
  it('returns bunx hint for bun cache path', () => {
    const hint = ephemeralUpdateHint('/home/user/.bun/install/cache/pi-ui', 'pi-ui');
    expect(hint).toContain('bunx');
  });

  it('returns null for normal paths', () => {
    expect(ephemeralUpdateHint('/home/user/projects/pi-ui', 'pi-ui')).toBeNull();
  });
});

describe('providerColor', () => {
  it('returns color for known provider', () => {
    expect(providerColor('openai')).toBe('#10A37F');
    expect(providerColor('anthropic')).toBe('#C06A3A');
  });

  it('handles case-insensitive match', () => {
    expect(providerColor('OpenAI')).toBe('#10A37F');
  });

  it('returns default color for unknown provider', () => {
    expect(providerColor('unknown')).toBe('#6B7280');
  });
});

describe('versionText', () => {
  it('formats version string', () => {
    expect(versionText('1.2.3')).toBe('v1.2.3');
  });

  it('returns unknown for undefined', () => {
    expect(versionText(undefined)).toBe('unknown');
  });

  it('returns unknown for "unknown"', () => {
    expect(versionText('unknown')).toBe('unknown');
  });
});

describe('sourceLabel', () => {
  it('returns env for environment', () => {
    expect(sourceLabel('environment')).toBe('env');
  });

  it('returns config for config sources', () => {
    expect(sourceLabel('models_json_key')).toBe('config');
    expect(sourceLabel('fallback')).toBe('config');
  });

  it('returns undefined for unknown', () => {
    expect(sourceLabel('unknown')).toBeUndefined();
  });
});

describe('canRemove', () => {
  it('returns true only for stored', () => {
    expect(canRemove('stored')).toBe(true);
    expect(canRemove('environment')).toBe(false);
    expect(canRemove('runtime')).toBe(false);
  });
});

describe('fmtTokens', () => {
  it('formats values < 1000 as-is', () => {
    expect(fmtTokens(500)).toBe('500');
  });

  it('formats values >= 1000 with k suffix', () => {
    expect(fmtTokens(1500)).toBe('1.5k');
  });
});

describe('fmtCost', () => {
  it('returns null for zero', () => {
    expect(fmtCost(0)).toBeNull();
  });

  it('formats very small costs', () => {
    expect(fmtCost(0.00005)).toBe('<$0.0001');
  });

  it('formats normal costs', () => {
    expect(fmtCost(0.015)).toBe('$0.0150');
  });
});

describe('fmtDuration', () => {
  it('formats milliseconds', () => {
    expect(fmtDuration(500)).toBe('500ms');
  });

  it('formats seconds', () => {
    expect(fmtDuration(5500)).toBe('5.5s');
  });

  it('formats minutes', () => {
    expect(fmtDuration(125000)).toBe('2m');
  });
});
