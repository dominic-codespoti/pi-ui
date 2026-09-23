import { test as base, type Page } from '@playwright/test';
import type { WebSocketRoute } from 'playwright-core';
import {
  CONNECTED_PAYLOAD,
  PROJECTS_LIST_PAYLOAD,
  ALL_SESSIONS_LIST_PAYLOAD,
} from './mocks/payloads';

export type MockWsOptions = {
  /** If true, the mock WS auto-replies to common init messages (get_projects, get_all_sessions). */
  autoInit?: boolean;
  /** If true, client messages not handled by the fixture are reported by assertNoUnhandled. */
  strict?: boolean;
};

export type MockWsMessage = Record<string, unknown>;

export type MockWsHarness = {
  /** Valid JSON object messages sent by the page, in arrival order. */
  received: MockWsMessage[];
  /** Send a JSON-serializable server message to the active routed socket. */
  send: (serverMessage: unknown) => void;
  /** Resolve with the first received message of this type matching the predicate. */
  waitForMessage: (
    type: string,
    predicate?: (message: MockWsMessage) => boolean
  ) => Promise<MockWsMessage>;
  /** Throw if malformed frames or strict-mode unhandled messages were observed. */
  assertNoUnhandled: () => void;
};

type PendingMessageWaiter = {
  type: string;
  predicate?: (message: MockWsMessage) => boolean;
  resolve: (message: MockWsMessage) => void;
  reject: (error: Error) => void;
};

function isMessageObject(value: unknown): value is MockWsMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeFrame(frame: unknown): string {
  if (typeof frame === 'string') return JSON.stringify(frame);
  if (Buffer.isBuffer(frame)) return JSON.stringify(frame.toString());
  try {
    return JSON.stringify(frame);
  } catch {
    return String(frame);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Extended test fixture that provides helpers for mocking the /ws endpoint.
 */
export const test = base.extend<{
  mockWs: (page: Page, opts?: MockWsOptions) => Promise<MockWsHarness>;
  login: (page: Page, password?: string) => Promise<void>;
}>({
  mockWs: async ({ browserName }, use) => {
    void browserName;
    const cleanups = new Set<() => void>();

    try {
      await use(async (page: Page, opts?: MockWsOptions): Promise<MockWsHarness> => {
        const { autoInit = true, strict = false } = opts ?? {};
        const received: MockWsMessage[] = [];
        const unhandled: string[] = [];
        const malformed: string[] = [];
        const waiters = new Set<PendingMessageWaiter>();
        let activeSocket: WebSocketRoute | undefined;
        let frameCounter = 0;
        let disposed = false;

        const rejectWaiters = (error: Error): void => {
          for (const waiter of waiters) waiter.reject(error);
          waiters.clear();
        };

        const cleanup = (): void => {
          if (disposed) return;
          disposed = true;
          activeSocket = undefined;
          rejectWaiters(
            new Error('Mock WebSocket fixture disposed before the requested message arrived')
          );
          page.removeListener('close', cleanup);
          cleanups.delete(cleanup);
        };
        cleanups.add(cleanup);
        page.once('close', cleanup);

        const matches = (
          message: MockWsMessage,
          type: string,
          predicate?: (candidate: MockWsMessage) => boolean
        ): boolean => {
          if (message.type !== type) return false;
          return predicate ? predicate(message) : true;
        };

        const waitForMessage = (
          type: string,
          predicate?: (message: MockWsMessage) => boolean
        ): Promise<MockWsMessage> => {
          if (disposed) {
            return Promise.reject(
              new Error('Mock WebSocket fixture disposed before the requested message arrived')
            );
          }

          for (const message of received) {
            try {
              if (matches(message, type, predicate)) return Promise.resolve(message);
            } catch (error) {
              return Promise.reject(error);
            }
          }

          return new Promise<MockWsMessage>((resolve, reject) => {
            waiters.add({ type, predicate, resolve, reject });
          });
        };

        const send = (serverMessage: unknown): void => {
          if (!activeSocket || disposed) {
            throw new Error('Cannot send mock WebSocket message: no active connection');
          }
          let encoded: string;
          try {
            encoded = JSON.stringify(serverMessage);
          } catch (error) {
            throw new Error(`Cannot encode mock WebSocket message: ${describeError(error)}`, {
              cause: error,
            });
          }
          if (encoded === undefined) {
            throw new Error('Cannot encode mock WebSocket message: value is not JSON-serializable');
          }
          activeSocket.send(encoded);
        };

        const assertNoUnhandled = (): void => {
          const problems = [...malformed, ...unhandled];
          if (problems.length > 0) {
            throw new Error(`Unexpected mock WebSocket client frames:\n${problems.join('\n')}`);
          }
        };

        const harness: MockWsHarness = {
          received,
          send,
          waitForMessage,
          assertNoUnhandled,
        };

        await page.routeWebSocket('/ws', (ws) => {
          activeSocket = ws;
          ws.onMessage((message) => {
            const frameNumber = ++frameCounter;
            const raw = String(message);
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch (error) {
              malformed.push(
                `frame #${frameNumber}: malformed JSON (${describeError(error)}): ${describeFrame(message)}`
              );
              return;
            }

            if (!isMessageObject(parsed)) {
              malformed.push(
                `frame #${frameNumber}: expected a JSON object, received ${describeFrame(parsed)}`
              );
              return;
            }

            received.push(parsed);
            let handled = false;
            if (autoInit && parsed.type === 'get_projects') {
              handled = true;
              ws.send(JSON.stringify(PROJECTS_LIST_PAYLOAD));
            } else if (autoInit && parsed.type === 'get_all_sessions') {
              handled = true;
              ws.send(JSON.stringify(ALL_SESSIONS_LIST_PAYLOAD));
            }

            if (strict && !handled) {
              const type = typeof parsed.type === 'string' ? parsed.type : '<missing type>';
              unhandled.push(
                `frame #${frameNumber}: unhandled command ${type} ${JSON.stringify(parsed)}`
              );
            }

            for (const waiter of [...waiters]) {
              try {
                if (!matches(parsed, waiter.type, waiter.predicate)) continue;
                waiters.delete(waiter);
                waiter.resolve(parsed);
              } catch (error) {
                waiters.delete(waiter);
                waiter.reject(
                  error instanceof Error ? error : new Error(String(error), { cause: error })
                );
              }
            }
          });

          // Send connected payload immediately on open.
          ws.send(JSON.stringify(CONNECTED_PAYLOAD));
        });

        return harness;
      });
    } finally {
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
    }
  },

  login: async ({ browserName }, use) => {
    void browserName;
    await use(async (page: Page, password?: string) => {
      await page.goto('/login');
      await page.fill('input[name="password"]', password ?? 'test-password');
      await page.click('button[type="submit"]');
      await page.waitForURL('/');
    });
  },
});

/**
 * Fill the composer and submit via the send button.
 * Works on both desktop and mobile projects — on mobile, plain Enter inserts
 * a newline by design, so keyboard submission is not portable.
 */
export async function submitPrompt(page: Page, text: string): Promise<void> {
  await page.fill('textarea', text);
  await page.click('button[aria-label="Send message"]');
}

export { expect } from '@playwright/test';
