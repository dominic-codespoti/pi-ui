import type { ClientMessage } from '#lib/ws/protocol.js';

/** Minimal mutable tool row surface needed to initiate a lazy output request. */
export interface ToolOutputTarget {
  toolCallId?: string;
  content?: string;
  outputElided?: boolean;
  outputLoading?: boolean;
}

export interface ToolOutputControllerOptions {
  send: (message: Extract<ClientMessage, { type: 'get_tool_output' }>) => boolean;
  onError?: (message: string) => void;
}

/**
 * Initiates lazy tool-output requests without owning result application. The
 * session reducer remains the sole owner of incoming tool_output mutation.
 */
export class ToolOutputController {
  private readonly send: ToolOutputControllerOptions['send'];
  private readonly onError: (message: string) => void;

  constructor(options: ToolOutputControllerOptions) {
    this.send = options.send;
    this.onError = options.onError ?? (() => {});
  }

  /**
   * Request an elided result exactly once while its row is expanded. Returns
   * false when the row is not requestable or transport rejected the request.
   */
  request(target: ToolOutputTarget): boolean {
    if (
      !target.toolCallId ||
      !target.outputElided ||
      Boolean(target.content) ||
      target.outputLoading
    ) {
      return false;
    }

    target.outputLoading = true;
    const accepted = this.send({ type: 'get_tool_output', toolCallId: target.toolCallId });
    if (accepted) return true;

    target.outputLoading = false;
    this.onError('Unable to load tool output while disconnected.');
    return false;
  }
}
