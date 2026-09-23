import { describe, expect, it } from 'vitest';
import { createSessionOperationGate } from '../session-operation-gate';

describe('SessionOperationGate', () => {
  it('accepts only the newest selection intent', () => {
    const gate = createSessionOperationGate();
    const slow = gate.begin();
    const fast = gate.begin();

    expect(gate.isCurrent(slow)).toBe(false);
    expect(gate.isCurrent(fast)).toBe(true);
  });

  it('does not accept a completion before any intent starts', () => {
    const gate = createSessionOperationGate();

    expect(gate.isCurrent(0)).toBe(false);
  });
});
