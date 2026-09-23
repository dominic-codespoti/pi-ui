import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../examples/index.ts';
import { renderSkill, SKILL_DIR, SKILL_NAME, extractPublishedRegion } from '../render-skill.ts';
import { SKILL_CATALOG } from '../catalog.ts';

const repoRoot = path.resolve(__dirname, '../../../../');

describe('extension UI skill renderer', () => {
  it('produces a skill accepted by the SDK loader', () => {
    const output = renderSkill({
      catalog: SKILL_CATALOG,
      examples: EXAMPLES.map((module) => ({
        module,
        source: readFileSync(
          path.join(repoRoot, 'src/lib/extension-ui-capabilities/examples', `${module.id}.ts`),
          'utf8'
        ),
      })),
    });
    const directory = mkdtempSync(path.join(tmpdir(), 'pi-ui-skill-'));
    try {
      for (const file of output) {
        const outputPath = path.join(directory, SKILL_DIR, file.path);
        const parent = outputPath.slice(0, outputPath.lastIndexOf('/'));
        mkdirSync(parent, { recursive: true });
        writeFileSync(outputPath, file.content, 'utf8');
      }
      const result = loadSkillsFromDir({ dir: path.join(directory, SKILL_DIR), source: 'test' });
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe(SKILL_NAME);
      expect(result.diagnostics).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires exactly one published region and dedents it', () => {
    expect(() => extractPublishedRegion('no markers')).toThrow(/exactly one published region/i);
    expect(() =>
      extractPublishedRegion(
        '// #region published\n  one\n// #endregion published\n// #region published\n  two\n// #endregion published'
      )
    ).toThrow(/exactly one published region/i);
    expect(
      extractPublishedRegion(
        '// #region published\n    first\n      second\n// #endregion published'
      )
    ).toBe('first\n  second');
  });

  it('publishes snippets without private parameter names or type imports', () => {
    const output = renderSkill({
      catalog: SKILL_CATALOG,
      examples: EXAMPLES.map((module) => ({
        module,
        source: readFileSync(
          path.join(repoRoot, 'src/lib/extension-ui-capabilities/examples', `${module.id}.ts`),
          'utf8'
        ),
      })),
    });
    const examples = output.find((file) => file.path === 'references/examples.md');
    expect(examples).toBeDefined();
    const snippets = examples!.content.match(/```ts\n([\s\S]*?)\n```/g) ?? [];
    expect(snippets).toHaveLength(EXAMPLES.length);
    for (const snippet of snippets) {
      expect(snippet).not.toMatch(/\b_(?:tui|theme|keybindings|done)\b/);
      expect(snippet).not.toContain('../types.ts');
    }
  });
});
