export interface ExtensionToolInfo {
  name: string;
  sourceInfo: { source: string };
}

/**
 * Add extension tools that were not present in the previous runtime while
 * preserving the current active set. A known-but-disabled extension tool stays
 * disabled across reloads; newly installed tools become available immediately.
 */
export function activateNewExtensionTools(
  activeToolNames: readonly string[],
  allTools: readonly ExtensionToolInfo[],
  knownExtensionToolNames: ReadonlySet<string>
): string[] {
  const next = [...activeToolNames];
  const active = new Set(next);

  for (const tool of allTools) {
    if (tool.sourceInfo.source === 'builtin') continue;
    if (knownExtensionToolNames.has(tool.name) || active.has(tool.name)) continue;
    next.push(tool.name);
    active.add(tool.name);
  }

  return next;
}

export function extensionToolNames(allTools: readonly ExtensionToolInfo[]): Set<string> {
  return new Set(
    allTools.filter((tool) => tool.sourceInfo.source !== 'builtin').map((tool) => tool.name)
  );
}
