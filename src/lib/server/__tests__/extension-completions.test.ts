import { describe, expect, it, vi } from 'vitest';
import { getCommandArgumentCompletions } from '../extension-completions';

describe('getCommandArgumentCompletions', () => {
  it('resolves suffixed invocation names through the command runner', async () => {
    const getArgumentCompletions = vi.fn(async (prefix: string) => [
      { value: 'quota', label: 'quota', description: `prefix: ${prefix}` },
      { value: 'status', label: 'status' },
    ]);
    const getCommand = vi.fn((name: string) =>
      name === 'ag:2' ? { getArgumentCompletions } : undefined
    );

    const items = await getCommandArgumentCompletions({ getCommand }, 'ag:2', 'q');

    expect(getCommand).toHaveBeenCalledWith('ag:2');
    expect(getArgumentCompletions).toHaveBeenCalledWith('q');
    expect(items).toEqual([
      { value: 'quota', label: 'quota', description: 'prefix: q' },
      { value: 'status', label: 'status' },
    ]);
  });

  it('returns no items when a command has no argument provider', async () => {
    const getCommand = vi.fn(() => ({}));

    await expect(getCommandArgumentCompletions({ getCommand }, 'ag', '')).resolves.toEqual([]);
  });
});
