import { describe, expect, it } from 'vitest';
import { ToolOutputController, type ToolOutputTarget } from '../tool-output-controller.js';

describe('ToolOutputController', () => {
  it('sets loading and requests an elided output', () => {
    const sent: unknown[] = [];
    const target: ToolOutputTarget = { toolCallId: 'tool-1', outputElided: true };
    const controller = new ToolOutputController({
      send: (message) => {
        sent.push(message);
        return true;
      },
    });

    expect(controller.request(target)).toBe(true);
    expect(target.outputLoading).toBe(true);
    expect(sent).toEqual([{ type: 'get_tool_output', toolCallId: 'tool-1' }]);
  });

  it('rolls back loading and reports a rejected send', () => {
    const errors: string[] = [];
    const target: ToolOutputTarget = { toolCallId: 'tool-1', outputElided: true };
    const controller = new ToolOutputController({
      send: () => false,
      onError: (message) => errors.push(message),
    });

    expect(controller.request(target)).toBe(false);
    expect(target.outputLoading).toBe(false);
    expect(errors).toEqual(['Unable to load tool output while disconnected.']);
  });

  it('rejects duplicate, non-elided, and already populated rows', () => {
    const send = () => {
      throw new Error('must not send');
    };
    const controller = new ToolOutputController({ send });
    expect(controller.request({ toolCallId: 'a', outputElided: true, outputLoading: true })).toBe(
      false
    );
    expect(controller.request({ toolCallId: 'b', outputElided: false })).toBe(false);
    expect(controller.request({ toolCallId: 'c', outputElided: true, content: 'loaded' })).toBe(
      false
    );
  });
});
