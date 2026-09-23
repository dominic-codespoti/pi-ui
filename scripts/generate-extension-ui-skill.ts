import { readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { EXAMPLES } from '../src/lib/extension-ui-capabilities/examples/index.ts';
import { renderSkill, SKILL_DIR } from '../src/lib/extension-ui-capabilities/render-skill.ts';
import { SKILL_CATALOG } from '../src/lib/extension-ui-capabilities/catalog.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDir = join(repoRoot, SKILL_DIR);
const check = process.argv.includes('--check');

async function filesUnder(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      paths.push(...(await filesUnder(join(directory, entry.name), relative)));
    else paths.push(relative);
  }
  return paths;
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

const examples = await Promise.all(
  EXAMPLES.map(async (module) => ({
    module,
    source: await Bun.file(
      join(repoRoot, 'src/lib/extension-ui-capabilities/examples', `${module.id}.ts`)
    ).text(),
  }))
);
const generated = renderSkill({ catalog: SKILL_CATALOG, examples });
const formatted = await Promise.all(
  generated.map(async (file) => {
    const absPath = join(outputDir, file.path);
    const config = (await prettier.resolveConfig(absPath)) ?? {};
    return {
      path: file.path,
      content: await prettier.format(file.content, { ...config, filepath: absPath }),
    };
  })
);

if (check) {
  const expected = new Set(formatted.map((file) => file.path));
  let stale = false;
  const onDisk = await filesUnder(outputDir).catch((error: unknown) => {
    if (isNotFound(error)) return [] as string[];
    throw error;
  });
  const onDiskSet = new Set(onDisk);
  for (const file of formatted) {
    const path = join(outputDir, file.path);
    let existing: string | undefined;
    if (onDiskSet.has(file.path)) existing = await Bun.file(path).text();
    if (existing !== file.content) {
      console.error(`${file.path}: ${existing === undefined ? 'missing' : 'stale'}`);
      stale = true;
    }
  }
  for (const path of onDisk) {
    if (!expected.has(path)) {
      console.error(`${path}: extra`);
      stale = true;
    }
  }
  if (stale) process.exit(1);
  console.log('Skill output is up to date.');
} else {
  await rm(outputDir, { recursive: true, force: true });
  for (const file of formatted) {
    const path = join(outputDir, file.path);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, file.content, 'utf8');
  }
  console.log(`Generated ${formatted.length} skill files.`);
}
