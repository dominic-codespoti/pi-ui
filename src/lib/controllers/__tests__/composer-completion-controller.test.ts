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
});
