import { describe, expect, it, vi } from 'vitest';
import type { ClientMessage } from '#lib/ws/protocol.js';
import {
  ComposerCompletionController,
  type CompletionView,
} from '../composer-completion-controller.js';

const view = (overrides: Partial<CompletionView> = {}): CompletionView => ({
  websocketOpen: true,
  loading: false,
  sessionId: 'session-1',
  trigger: '@',
  query: 'rea',
  commandArgMode: null,
  ...overrides,
});

describe('ComposerCompletionController', () => {
  it('debounces requests and cancels the superseded timer', () => {
    vi.useFakeTimers();
    try {
      const sent: ClientMessage[] = [];
      const controller = new ComposerCompletionController(
        (message): void => {
          sent.push(message);
        },
        {
          debounceMs: 100,
        }
      );

      controller.update(view({ query: 'r' }));
      controller.update(view({ query: 're' }));
      vi.advanceTimersByTime(99);
      expect(sent).toHaveLength(0);
      vi.advanceTimersByTime(1);

      expect(sent.filter((message) => message.type === 'file_complete')).toEqual([
        {
          type: 'file_complete',
          sessionId: 'session-1',
          requestId: '1',
          query: 're',
        },
      ]);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects stale responses after the visible query changes', () => {
    vi.useFakeTimers();
    try {
      const sent: ClientMessage[] = [];
      const controller = new ComposerCompletionController(
        (message): void => {
          sent.push(message);
        },
        {
          debounceMs: 1,
        }
      );
      controller.update(view({ query: 'old' }));
      vi.advanceTimersByTime(1);
      const oldRequest = sent.find(
        (message): message is Extract<ClientMessage, { type: 'file_complete' }> =>
          message.type === 'file_complete'
      )!;

      controller.update(view({ query: 'new' }));
      expect(
        controller.handleResponse(
          {
            type: 'file_completions',
            sessionId: 'session-1',
            requestId: oldRequest.requestId,
            query: 'old',
            entries: ['old.ts'],
          },
          view({ query: 'new' })
        )
      ).toBe(false);
      vi.advanceTimersByTime(1);
      const currentRequest = sent.filter(
        (message): message is Extract<ClientMessage, { type: 'file_complete' }> =>
          message.type === 'file_complete'
      )[1]!;
      expect(
        controller.handleResponse(
          {
            type: 'file_completions',
            sessionId: 'session-1',
            requestId: currentRequest.requestId,
            query: 'new',
            entries: ['new.ts'],
          },
          view({ query: 'new' })
        )
      ).toBe(true);
      expect(controller.current.fileCompletions).toEqual(['new.ts']);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels all pending channels and rejects responses after a session reset', () => {
    vi.useFakeTimers();
    try {
      const sent: ClientMessage[] = [];
      const controller = new ComposerCompletionController(
        (message): void => {
          sent.push(message);
        },
        {
          debounceMs: 100,
        }
      );
      controller.update(
        view({
          trigger: '/',
          query: 'bu',
          commandArgMode: {
            command: 'build',
            prefix: ' target',
            parentPrefix: '',
            currentToken: 'target',
          },
        })
      );
      controller.setSession('session-2');
      vi.advanceTimersByTime(200);
      expect(sent).toHaveLength(0);
      expect(controller.current.sessionId).toBe('session-2');
      expect(
        controller.handleResponse(
          {
            type: 'extension_completions',
            sessionId: 'session-1',
            requestId: '1',
            trigger: '/',
            query: 'bu',
            items: [{ value: 'build', label: 'build' }],
          },
          view({ trigger: '/', query: 'bu', sessionId: 'session-1' })
        )
      ).toBe(false);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('correlates extension and command responses with their active request context', () => {
    vi.useFakeTimers();
    try {
      const sent: ClientMessage[] = [];
      const controller = new ComposerCompletionController(
        (message): void => {
          sent.push(message);
        },
        {
          debounceMs: 1,
          commandDebounceMs: 1,
        }
      );
      const commandMode = {
        command: 'deploy',
        prefix: ' prod',
        parentPrefix: '',
        currentToken: 'prod',
      };
      controller.update(view({ trigger: '/', query: 'de', commandArgMode: commandMode }));
      vi.advanceTimersByTime(1);
      expect(sent).toHaveLength(2);
      const extensionRequest = sent.find(
        (message) => message.type === 'get_extension_autocomplete'
      );
      const commandRequest = sent.find((message) => message.type === 'get_command_completions');
      expect(extensionRequest?.type).toBe('get_extension_autocomplete');
      expect(commandRequest?.type).toBe('get_command_completions');
      expect(controller.current.latestExtensionRequestId).toBe(
        (extensionRequest as Extract<ClientMessage, { type: 'get_extension_autocomplete' }>)
          .requestId
      );

      expect(
        controller.handleResponse(
          {
            type: 'extension_completions',
            sessionId: 'session-1',
            requestId: (
              extensionRequest as Extract<ClientMessage, { type: 'get_extension_autocomplete' }>
            ).requestId,
            trigger: '/',
            query: 'de',
            items: [{ value: 'deploy', label: 'deploy' }],
          },
          view({ trigger: '/', query: 'de', commandArgMode: commandMode })
        )
      ).toBe(true);
      expect(
        controller.handleResponse(
          {
            sessionId: 'session-1',
            type: 'command_completions',
            requestId: (
              commandRequest as Extract<ClientMessage, { type: 'get_command_completions' }>
            ).requestId,
            command: 'deploy',
            prefix: 'stale',
            items: [{ value: 'prod', label: 'prod' }],
          },
          view({ trigger: '/', query: 'de', commandArgMode: commandMode })
        )
      ).toBe(false);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains command results while a new prefix is pending and ignores stale responses', () => {
    vi.useFakeTimers();
    try {
      const sent: ClientMessage[] = [];
      const controller = new ComposerCompletionController(
        (message): void => {
          sent.push(message);
        },
        { commandDebounceMs: 1 }
      );
      const firstMode = { command: 'deploy', prefix: ' prod' };
      controller.update(view({ trigger: '/', commandArgMode: firstMode }));
      vi.advanceTimersByTime(1);
      const firstRequest = sent.find(
        (message): message is Extract<ClientMessage, { type: 'get_command_completions' }> =>
          message.type === 'get_command_completions'
      )!;
      const firstItems = [{ value: 'prod', label: 'prod' }];
      expect(
        controller.handleResponse(
          {
            type: 'command_completions',
            sessionId: 'session-1',
            requestId: firstRequest.requestId,
            command: 'deploy',
            prefix: ' prod',
            items: firstItems,
          },
          view({ trigger: '/', commandArgMode: firstMode })
        )
      ).toBe(true);

      const nextMode = { command: 'deploy', prefix: ' prod staging' };
      controller.update(view({ trigger: '/', commandArgMode: nextMode }));
      expect(controller.current.commandArgCompletions).toEqual(firstItems);
      expect(controller.current.commandArgResultsPrefix).toBe(' prod');
      expect(controller.current.commandCompletionsPending).toBe(true);
      expect(
        controller.handleResponse(
          {
            type: 'command_completions',
            sessionId: 'session-1',
            requestId: firstRequest.requestId,
            command: 'deploy',
            prefix: ' prod',
            items: [{ value: 'old', label: 'old' }],
          },
          view({ trigger: '/', commandArgMode: nextMode })
        )
      ).toBe(false);
      expect(controller.current.commandArgCompletions).toEqual(firstItems);
      expect(controller.current.commandArgResultsPrefix).toBe(' prod');
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears command results when the command changes', () => {
    vi.useFakeTimers();
    try {
      const sent: ClientMessage[] = [];
      const controller = new ComposerCompletionController(
        (message): void => {
          sent.push(message);
        },
        { commandDebounceMs: 1 }
      );
      const mode = { command: 'deploy', prefix: ' prod' };
      controller.update(view({ trigger: '/', commandArgMode: mode }));
      vi.advanceTimersByTime(1);
      const request = sent.find(
        (message): message is Extract<ClientMessage, { type: 'get_command_completions' }> =>
          message.type === 'get_command_completions'
      )!;
      controller.handleResponse(
        {
          type: 'command_completions',
          sessionId: 'session-1',
          requestId: request.requestId,
          command: 'deploy',
          prefix: ' prod',
          items: [{ value: 'prod', label: 'prod' }],
        },
        view({ trigger: '/', commandArgMode: mode })
      );
      controller.update(
        view({ trigger: '/', commandArgMode: { command: 'build', prefix: ' target' } })
      );
      expect(controller.current.commandArgCompletions).toEqual([]);
      expect(controller.current.commandArgResultsPrefix).toBe('');
      expect(controller.current.commandCompletionsPending).toBe(true);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses a separate debounce for command completion requests', () => {
    vi.useFakeTimers();
    try {
      const sent: ClientMessage[] = [];
      const controller = new ComposerCompletionController(
        (message): void => {
          sent.push(message);
        },
        { debounceMs: 20, commandDebounceMs: 5 }
      );
      controller.update(
        view({
          trigger: '/',
          query: 'bu',
          commandArgMode: { command: 'build', prefix: ' target' },
        })
      );
      vi.advanceTimersByTime(5);
      expect(sent.some((message) => message.type === 'get_command_completions')).toBe(true);
      expect(sent.some((message) => message.type === 'get_extension_autocomplete')).toBe(false);
      vi.advanceTimersByTime(15);
      expect(sent.some((message) => message.type === 'get_extension_autocomplete')).toBe(true);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
