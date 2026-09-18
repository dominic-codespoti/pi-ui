import { describe, expect, it, vi } from 'vitest';
import type {
  ClientWebSocket,
  ClientWebSocketCloseInfo,
  ClientWebSocketControllerOptions,
  ClientWebSocketErrorInfo,
  ClientWebSocketFactory,
  ClientWebSocketReplacementInfo,
} from '../client-websocket-controller.js';
import { ClientWebSocketController } from '../client-websocket-controller.js';

class FakeSocket implements ClientWebSocket {
  readyState = 0;
  onopen: ClientWebSocket['onopen'] = null;
  onmessage: ClientWebSocket['onmessage'] = null;
  onclose: ClientWebSocket['onclose'] = null;
  onerror: ClientWebSocket['onerror'] = null;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code: code ?? 1000, reason, wasClean: true }));
  }

  error(event: Event = new Event('error')): void {
    this.onerror?.(event);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  message(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  fail(code = 1006, reason = '', wasClean = false): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close', { code, reason, wasClean }));
  }
}

function setup(overrides: Partial<ClientWebSocketControllerOptions> = {}): {
  controller: ClientWebSocketController;
  sockets: FakeSocket[];
  document: { hidden: boolean };
  assign: ReturnType<typeof vi.fn>;
} {
  const sockets: FakeSocket[] = [];
  const document = { hidden: false };
  const assign = vi.fn();
  const options: ClientWebSocketControllerOptions = {
    socketFactory: vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    }),
    document,
    location: {
      protocol: 'https:',
      hostname: 'example.test',
      port: '443',
      pathname: '/app',
      search: '?session=one',
      assign,
    },
    isOnline: () => true,
    authProbe: async () => false,
    reconnectDelay: () => 500,
    ...overrides,
  };
  return { controller: new ClientWebSocketController(options), sockets, document, assign };
}

const connectedFrame = {
  type: 'connected',
  sessionId: 'session-1',
  isStreaming: false,
  thinkingLevel: 'off',
  model: null,
  availableModels: [],
  messages: [],
};

describe('ClientWebSocketController', () => {
  it('accepts the native WebSocket as its socket factory', () => {
    const factory: ClientWebSocketFactory = (url) => new WebSocket(url);
    expect(factory).toBeTypeOf('function');
  });

  it('handles open, decoded message, close, and scheduled reconnect lifecycle', () => {
    vi.useFakeTimers();
    try {
      const states: string[] = [];
      const attempts: number[] = [];
      const countdowns: number[] = [];
      const messages: unknown[] = [];
      const { controller, sockets } = setup({
        onConnectionStateChange: (state) => states.push(state.connectionState),
        onReconnectAttempt: (attempt) => attempts.push(attempt),
        onReconnectCountdown: (seconds) => countdowns.push(seconds),
        onMessage: (message) => messages.push(message),
        reconnectDelay: () => 2_500,
      });

      controller.connect();
      expect(controller.current.connectionState).toBe('connecting');
      expect(sockets).toHaveLength(1);
      sockets[0].open();
      expect(controller.current.connectionState).toBe('open');
      sockets[0].message(JSON.stringify(connectedFrame));
      sockets[0].message(JSON.stringify({ type: 'message_update', delta: 'hello' }));
      expect(controller.current.handshakeComplete).toBe(true);
      expect(messages).toHaveLength(2);

      sockets[0].fail(1006, 'network');
      expect(controller.current.connectionState).toBe('connecting');
      expect(attempts).toEqual([1]);
      expect(countdowns.at(-1)).toBe(3);
      vi.advanceTimersByTime(1_000);
      expect(controller.current.reconnectCountdown).toBe(2);
      vi.advanceTimersByTime(1_500);
      expect(sockets).toHaveLength(2);
      expect(controller.current.connectionState).toBe('connecting');
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it('delivers close code, reason, clean state, and handshake state before reconnecting', () => {
    const closes: ClientWebSocketCloseInfo[] = [];
    const statesAtClose: string[] = [];
    const setupResult = setup({
      onClose: (info) => {
        closes.push(info);
        statesAtClose.push(setupResult.controller.current.connectionState);
      },
    });
    const controller = setupResult.controller;
    const { sockets } = setupResult;

    controller.connect();
    sockets[0].open();
    sockets[0].message(JSON.stringify(connectedFrame));
    sockets[0].fail(1011, 'server initialization failed', false);

    expect(closes).toEqual([
      {
        code: 1011,
        reason: 'server initialization failed',
        wasClean: false,
        handshakeComplete: true,
        intentional: false,
      },
    ]);
    expect(statesAtClose).toEqual(['open']);
    controller.dispose();
  });

  it('delivers current-socket errors with the original error and connection context', () => {
    const errors: ClientWebSocketErrorInfo[] = [];
    const error = new Error('network failure');
    const { controller, sockets } = setup({ onError: (info) => errors.push(info) });

    controller.connect();
    sockets[0].open();
    sockets[0].error(new ErrorEvent('error', { error }));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      error,
      handshakeComplete: false,
      intentional: false,
    });
    controller.dispose();
  });

  it('reports malformed JSON and schema-invalid frames without delivering messages', () => {
    const invalid: string[][] = [];
    const messages: unknown[] = [];
    const { controller, sockets } = setup({
      onProtocolInvalid: (issues) => invalid.push(issues),
      onMessage: (message) => messages.push(message),
    });
    controller.connect();
    sockets[0].open();
    sockets[0].message('{not-json');
    sockets[0].message(JSON.stringify({ type: 'connected' }));
    expect(invalid).toHaveLength(2);
    expect(invalid[0][0]).toContain('JSON');
    expect(messages).toHaveLength(0);
    controller.dispose();
  });

  it('returns false when closed and true after an open socket sends JSON', () => {
    const { controller, sockets } = setup();
    expect(controller.send({ type: 'ping' })).toBe(false);
    controller.connect();
    expect(controller.send({ type: 'ping' })).toBe(false);
    sockets[0].open();
    expect(controller.send({ type: 'ping' })).toBe(true);
    expect(sockets[0].sent).toEqual([JSON.stringify({ type: 'ping' })]);
    controller.dispose();
  });

  it('pings an idle socket and closes it after the pong timeout when no frame arrives', () => {
    vi.useFakeTimers();
    try {
      const { controller, sockets } = setup({
        heartbeatIntervalMs: 100,
        pongTimeoutMs: 30,
      });
      controller.connect();
      sockets[0].open();
      vi.advanceTimersByTime(100);
      expect(sockets[0].sent).toEqual([JSON.stringify({ type: 'ping' })]);
      vi.advanceTimersByTime(50);
      expect(sockets[0].closeCalls).toHaveLength(1);
      expect(controller.current.connectionState).toBe('connecting');
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers reconnect while hidden and resumes it when visible', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const { controller, sockets, document } = setup();
      controller.connect();
      sockets[0].open();
      document.hidden = true;
      controller.handleVisibilityChange();
      sockets[0].fail();
      vi.advanceTimersByTime(10_000);
      expect(sockets).toHaveLength(1);
      document.hidden = false;
      vi.setSystemTime(2_000);
      controller.handleVisibilityChange();
      vi.advanceTimersByTime(500);
      expect(sockets).toHaveLength(2);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it('notifies before replacing a long-hidden socket, but not after a short hidden resume', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const replacements: ClientWebSocketReplacementInfo[] = [];
      const setupResult = setup({
        heartbeatIntervalMs: 1_000_000,
        onSocketReplace: (info) => {
          replacements.push(info);
          expect(setupResult.sockets).toHaveLength(1);
        },
      });
      const { controller, sockets, document } = setupResult;
      controller.connect();
      sockets[0].open();
      sockets[0].message(JSON.stringify(connectedFrame));

      document.hidden = true;
      controller.handleVisibilityChange();
      vi.setSystemTime(2_000);
      document.hidden = false;
      controller.handleVisibilityChange();
      expect(replacements).toHaveLength(0);
      expect(sockets).toHaveLength(1);

      document.hidden = true;
      controller.handleVisibilityChange();
      vi.setSystemTime(123_002);
      document.hidden = false;
      controller.handleVisibilityChange();

      expect(replacements).toEqual([{ reason: 'hidden_timeout', handshakeComplete: true }]);
      expect(sockets).toHaveLength(2);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect after an intentional disconnect', () => {
    vi.useFakeTimers();
    try {
      const { controller, sockets } = setup();
      controller.connect();
      sockets[0].open();
      controller.disconnect();
      expect(controller.current.connectionState).toBe('closed');
      expect(sockets[0].onclose).toBeNull();
      vi.advanceTimersByTime(20_000);
      expect(sockets).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('redirects when the post-close auth probe reports an expired session', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => true);
      const redirect = vi.fn();
      const { controller, sockets, assign } = setup({ authProbe: probe, onAuthRedirect: redirect });
      controller.connect();
      sockets[0].open();
      sockets[0].fail(1006);
      await Promise.resolve();
      expect(probe).toHaveBeenCalledTimes(1);
      expect(redirect).toHaveBeenCalledWith('/login?redirect=%2Fapp%3Fsession%3Done');
      expect(assign).not.toHaveBeenCalled();
      expect(controller.current.connectionState).toBe('closed');
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('detaches replaced socket callbacks so stale events cannot mutate current state or notify listeners', () => {
    const received: unknown[] = [];
    const closes: ClientWebSocketCloseInfo[] = [];
    const errors: ClientWebSocketErrorInfo[] = [];
    const replacements: ClientWebSocketReplacementInfo[] = [];
    const { controller, sockets } = setup({
      onMessage: (message) => received.push(message),
      onClose: (info) => closes.push(info),
      onError: (info) => errors.push(info),
      onSocketReplace: (info) => replacements.push(info),
    });
    controller.connect();
    expect(replacements).toHaveLength(0);
    const old = sockets[0];
    const oldOpen = old.onopen;
    const oldMessage = old.onmessage;
    const oldClose = old.onclose;
    const oldError = old.onerror;
    controller.connect();
    expect(replacements).toEqual([{ reason: 'connect_replace', handshakeComplete: false }]);
    expect(old.onopen).toBeNull();
    expect(old.onmessage).toBeNull();
    expect(old.onclose).toBeNull();
    expect(old.onerror).toBeNull();
    oldOpen?.(new Event('open'));
    oldMessage?.(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'message_update', delta: 'stale' }),
      })
    );
    oldError?.(new ErrorEvent('error', { error: new Error('stale') }));
    oldClose?.(new CloseEvent('close', { code: 1006, reason: 'stale', wasClean: false }));
    expect(received).toHaveLength(0);
    expect(closes).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(controller.current.connectionState).toBe('connecting');
    sockets[1].open();
    expect(controller.current.connectionState).toBe('open');
    controller.dispose();
  });
});
