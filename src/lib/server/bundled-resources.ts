import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const BUNDLED_SKILL_NAME = 'pi-ui-extension-ui';

export function bundledSkillPaths(appRoot: string): string[] {
  const skillPath = join(appRoot, 'skills', BUNDLED_SKILL_NAME);
  return existsSync(join(skillPath, 'SKILL.md')) ? [skillPath] : [];
}
