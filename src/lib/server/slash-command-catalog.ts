import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

export type BuiltinSlashCommand = {
  name: string;
  description: string;
  argumentHint?: string;
};
const pendingBugReports = new Map<string, unknown>();

async function sdkModuleUrl(path: string): Promise<string> {
  // Keep the SDK lazy: this helper is imported during server startup, before a browser connects.
  const { getPackageDir } = await import('@earendil-works/pi-coding-agent');
  return pathToFileURL(join(getPackageDir(), path)).href;
}

export async function getBuiltinSlashCommands(): Promise<BuiltinSlashCommand[]> {
  // The SDK package root does not re-export this catalog; load its authoritative dist module.
  const { BUILTIN_SLASH_COMMANDS } = await import(
    await sdkModuleUrl('dist/core/slash-commands.js')
  );
  return BUILTIN_SLASH_COMMANDS.map((command: BuiltinSlashCommand) => ({ ...command }));
}

export async function getLatestChangelogEntries(lastSeenVersion?: string) {
  const { getChangelogPath, parseChangelog, getNewEntries } = await import(
    await sdkModuleUrl('dist/utils/changelog.js')
  );
  const entries = parseChangelog(getChangelogPath());
  const newer = lastSeenVersion ? getNewEntries(entries, lastSeenVersion) : [];
  return (newer.length ? newer : entries.slice(0, 5)).map(
    (entry: { major: number; minor: number; patch: number; content: string }) => ({
      version: `${entry.major}.${entry.minor}.${entry.patch}`,
      content: entry.content,
    })
  );
}

export async function prepareBugReport(session: AgentSession, hint?: string) {
  const { collectBugReportMetadata, collectBugReportDiagnostics } = await import(
    await sdkModuleUrl('dist/core/bug-report.js')
  );
  const loadedExtensions = session.resourceLoader.getExtensions();
  const bundle = {
    metadata: collectBugReportMetadata({
      hint,
      sessionId: session.sessionId,
      cwd: session.sessionManager.getCwd(),
      includeSession: false,
      includeSummary: false,
      messageCount: session.messages.length,
      model: session.model,
      modelRuntime: session.modelRuntime,
      thinkingLevel: session.thinkingLevel,
      extensions: loadedExtensions.extensions,
      extensionErrors: loadedExtensions.errors,
      globalSettings: session.settingsManager.getGlobalSettings(),
      projectSettings: session.settingsManager.getProjectSettings(),
    }),
    diagnostics: collectBugReportDiagnostics(session.sessionManager),
  };
  const preview = [
    'This report is sent privately to the Pi developers. It does not include your conversation transcript.',
    `Description: ${hint?.trim() || 'none'}`,
    `Pi version: ${bundle.metadata.environment.version}`,
    `Platform: ${bundle.metadata.environment.platform} ${bundle.metadata.environment.arch}`,
    `Model/provider details: ${bundle.metadata.model ? `${bundle.metadata.model.provider}/${bundle.metadata.model.id}` : 'none'}`,
    `Loaded extensions: ${bundle.metadata.extensions.length}`,
    `Session diagnostics: ${bundle.diagnostics.assistant.length} failed assistant turns, ${bundle.diagnostics.crashes.length} crashes`,
    'The report includes settings and provider diagnostics with credential values redacted.',
  ].join('\n');
  const id = crypto.randomUUID();
  pendingBugReports.set(id, bundle);
  return { id, preview };
}

export async function uploadPreparedBugReport(id: string) {
  const bundle = pendingBugReports.get(id);
  if (!bundle) throw new Error('Bug report preview expired. Run /bug again.');
  pendingBugReports.delete(id);
  const { uploadBugReport: upload } = await import(
    await sdkModuleUrl('dist/core/bug-report-upload.js')
  );
  return upload(bundle as Parameters<typeof upload>[0]);
}
