import { describe, expect, it } from 'vitest';
import { activateNewExtensionTools, extensionToolNames } from '../extension-tools';

const builtin = (name: string) => ({ name, sourceInfo: { source: 'builtin' } });
const extension = (name: string) => ({ name, sourceInfo: { source: 'auto' } });

describe('activateNewExtensionTools', () => {
  it('activates extension tools on the initial RPC bind without duplicating builtins', () => {
    const allTools = [builtin('read'), extension('ask_user_question'), extension('custom_tool')];

    expect(activateNewExtensionTools(['read', 'bash'], allTools, new Set())).toEqual([
      'read',
      'bash',
      'ask_user_question',
      'custom_tool',
    ]);
  });

  it('activates newly installed tools but preserves known disabled tools', () => {
    const allTools = [extension('ask_user_question'), extension('new_tool')];
    const known = extensionToolNames([extension('ask_user_question')]);

    expect(activateNewExtensionTools(['read'], allTools, known)).toEqual(['read', 'new_tool']);
  });
});
