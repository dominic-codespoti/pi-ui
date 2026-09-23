import type { ResourceLoader } from '@earendil-works/pi-coding-agent';
import type {
  PromptSummary,
  ResourceDiagnosticSummary,
  SkillSummary,
  ThemeSummary,
} from '../ws/protocol.ts';

export interface ResourcesSummary {
  skills: SkillSummary[];
  prompts: PromptSummary[];
  themes: ThemeSummary[];
  contextFiles: string[];
  diagnostics: ResourceDiagnosticSummary[];
}
function summarizeScope(scope: string | undefined, origin?: string): string | undefined {
  if (origin === 'package') return 'package';
  if (scope === 'temporary') return 'bundled';
  return scope;
}

export function summarizeResources(resourceLoader: ResourceLoader): ResourcesSummary {
  const { skills, diagnostics: skillDiagnostics } = resourceLoader.getSkills();
  const { prompts, diagnostics: promptDiagnostics } = resourceLoader.getPrompts();
  const { themes, diagnostics: themeDiagnostics } = resourceLoader.getThemes();
  const diagnostics = [...skillDiagnostics, ...promptDiagnostics, ...themeDiagnostics].map(
    ({ type, message, path, collision }) => ({
      type,
      message: collision
        ? `${message} (${collision.name}: ${collision.winnerPath} overrides ${collision.loserPath})`
        : message,
      ...((path ?? collision?.loserPath) ? { path: path ?? collision?.loserPath } : {}),
    })
  );

  return {
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      scope: summarizeScope(skill.sourceInfo.scope, skill.sourceInfo.origin)!,
      isBuiltin: skill.sourceInfo.origin === 'package',
      source: skill.sourceInfo.source,
      sourcePath: skill.filePath || skill.sourceInfo.path,
      disableModelInvocation: skill.disableModelInvocation,
    })),
    prompts: prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      argumentHint: prompt.argumentHint,
      scope: summarizeScope(prompt.sourceInfo.scope, prompt.sourceInfo.origin)!,
      isBuiltin: prompt.sourceInfo.origin === 'package',
      source: prompt.sourceInfo.source,
      sourcePath: prompt.filePath || prompt.sourceInfo.path,
    })),
    themes: themes.map((theme) => ({
      name: theme.name ?? 'unnamed',
      scope: summarizeScope(theme.sourceInfo?.scope, theme.sourceInfo?.origin),
      sourcePath: theme.sourcePath ?? theme.sourceInfo?.path,
    })),
    contextFiles: resourceLoader.getAgentsFiles().agentsFiles.map(({ path }) => path),
    diagnostics,
  };
}
