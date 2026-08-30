export interface CommandCompletionItem {
  value: string;
  label: string;
  description?: string;
}

type CommandWithCompletions = {
  getArgumentCompletions?: (
    prefix: string
  ) => CommandCompletionItem[] | null | Promise<CommandCompletionItem[] | null>;
};

export interface ExtensionCommandResolver {
  getCommand(name: string): CommandWithCompletions | undefined;
}

/** Resolve the SDK invocation name before asking an extension for completions. */
export async function getCommandArgumentCompletions(
  resolver: ExtensionCommandResolver,
  command: string,
  prefix: string
): Promise<CommandCompletionItem[]> {
  const registered = resolver.getCommand(command);
  if (!registered?.getArgumentCompletions) return [];
  return (await registered.getArgumentCompletions(prefix)) ?? [];
}
