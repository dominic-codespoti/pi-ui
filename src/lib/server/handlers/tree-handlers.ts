import type { AgentSession } from '@earendil-works/pi-coding-agent';

export type NavigateTreeOptions = {
  entryId: string;
  summarize?: boolean;
  customInstructions?: string;
  label?: string;
};

export async function navigateTree(session: AgentSession, options: NavigateTreeOptions) {
  if (session.isStreaming)
    throw new Error('Cannot navigate the session tree while the agent is streaming.');
  if (!session.sessionManager.getEntry(options.entryId)) {
    throw new Error('The selected session entry no longer exists.');
  }
  const result = await session.navigateTree(options.entryId, {
    summarize: options.summarize,
    customInstructions: options.customInstructions?.trim() || undefined,
    replaceInstructions: false,
    label: options.label?.trim() || undefined,
  });
  return result;
}

export function setEntryLabel(
  session: AgentSession,
  entryId: string,
  label?: string
): string | undefined {
  if (!session.sessionManager.getEntry(entryId)) {
    throw new Error('The selected session entry no longer exists.');
  }
  const normalized = label?.trim() || undefined;
  session.sessionManager.appendLabelChange(entryId, normalized);
  return session.sessionManager.getLabel(entryId);
}
