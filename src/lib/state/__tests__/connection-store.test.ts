import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionStore } from '../connection-store.svelte.js';

type MessageEventHandler = ((event: MessageEvent<string>) => void) | null;
type CloseEventHandler = ((event: CloseEvent) => void) | null;
type ErrorEventHandler = ((event: Event) => void) | null;
type OpenEventHandler = (() => void) | null;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: OpenEventHandler = null;
  onmessage: MessageEventHandler = null;
  onclose: CloseEventHandler = null;
  onerror: ErrorEventHandler = null;
  sentData: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentData.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  // Test helpers to trigger socket events
  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  triggerMessage(data: string): void {
    this.onmessage?.({ data } as MessageEvent<string>);
  }

  triggerClose(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  triggerError(): void {
    this.onerror?.(new Event('error'));
  }
}

describe('ConnectionStore', () => {
  let store: ConnectionStore;
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];

    // Stub global WebSocket
    vi.stubGlobal('WebSocket', FakeWebSocket);

    // Stub document.hidden and navigator.onLine
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
      writable: true,
    });
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
      writable: true,
    });

    // Stub location & assign
    assignSpy = vi.fn();
    const mockLocation = {
      protocol: 'http:',
      hostname: 'localhost',
      port: '3000',
      pathname: '/chat',
      search: '?session=123',
      assign: assignSpy,
    };
    vi.stubGlobal('location', mockLocation);

    store = new ConnectionStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('connects to ws://host:port/ws in standard non-dev url shape', () => {
    // Note: $app/env 'dev' is evaluated at import time in connection-store.svelte.ts.
    // In test environment, dev evaluates to false or true based on vitest setup,
    // dialing ws://${hostname}${port ? ':' + wsPort : ''}/ws.
    store.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toMatch(/^ws:\/\/localhost:(3000|5174)\/ws$/);
    expect(store.wsState).toBe('closed'); // becomes 'open' on socket onopen
  });

  it('updates wsState to open and sets up heartbeat on socket open; silence past pong timeout force-closes', () => {
    store.connect();
    const socket = FakeWebSocket.instances[0];

    socket.triggerOpen();
    expect(store.wsState).toBe('open');

    // Heartbeat interval is 25s, timer checks every 12.5s
    // Advance by 25s: ping should be sent
    vi.advanceTimersByTime(25_000);
    expect(socket.sentData).toContain(JSON.stringify({ type: 'ping' }));

    // Pong timeout is 10s. If no message received after ping sent + 10s:
    // Advance timers by another 12.5s (next heartbeat tick, now - pingSentAt > 10_000 and lastMsgAt < pingSentAt)
    vi.advanceTimersByTime(12_500);

    // Socket should have been force-closed due to pong timeout
    expect(socket.closeCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('bumps liveness on onmessage and forwards raw data to onMessage hook', () => {
    const onMessageSpy = vi.fn();
    store.onMessage = onMessageSpy;

    store.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    socket.triggerMessage(JSON.stringify({ type: 'connected', sessionId: 'abc' }));
    expect(onMessageSpy).toHaveBeenCalledWith(
      JSON.stringify({ type: 'connected', sessionId: 'abc' })
    );

    // Advance 25s after message - heartbeat ping sent
    vi.advanceTimersByTime(25_000);
    expect(socket.sentData).toHaveLength(1);

    // Server responds with pong (or any message) before pong timeout
    socket.triggerMessage(JSON.stringify({ type: 'pong' }));

    // Advance another tick (12.5s) - socket should NOT be closed because lastMsgAt >= pingSentAt
    vi.advanceTimersByTime(12_500);
    expect(socket.closeCalls).toHaveLength(0);
  });

  it('redirects to /login when closed with code 4001', () => {
    store.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    socket.triggerClose(4001, 'Session expired');

    expect(assignSpy).toHaveBeenCalledWith('/login?redirect=%2Fchat%3Fsession%3D123');
    expect(store.wsState).toBe('closed');
    expect(store.reconnectCountdown).toBe(0);
  });

  it('schedules reconnect with countdown > 0 on non-4001 close and backs off', () => {
    const onSocketClosedSpy = vi.fn();
    store.onSocketClosed = onSocketClosedSpy;

    store.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    socket.triggerClose(1006, 'Abnormal closure');

    expect(onSocketClosedSpy).toHaveBeenCalled();
    expect(store.wsState).toBe('connecting');
    expect(store.reconnectCountdown).toBeGreaterThan(0);

    const initialCountdown = store.reconnectCountdown;
    vi.advanceTimersByTime(1000);
    expect(store.reconnectCountdown).toBe(initialCountdown - 1);

    // Advance until reconnect timer fires and redials
    vi.advanceTimersByTime(initialCountdown * 1000);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it('detaches old socket and forceReconnects when resuming from hidden after >120s with open state', () => {
    store.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    // Mark page hidden and record hiddenAt
    store.hiddenAt = Date.now() - 125_000; // 125s ago
    store.resumeFromHidden();

    // Old socket close handler detached and closed; new socket created in 'connecting' state
    expect(socket.onclose).toBeNull();
    expect(socket.closeCalls.length).toBeGreaterThanOrEqual(1);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it('send() returns true and delivers JSON when OPEN, false otherwise', () => {
    // Closed socket
    expect(store.send({ type: 'ping' })).toBe(false);

    store.connect();
    const socket = FakeWebSocket.instances[0];

    // Connecting socket
    expect(store.send({ type: 'ping' })).toBe(false);

    // Open socket
    socket.triggerOpen();
    const res = store.send({ type: 'prompt', message: 'hello' });
    expect(res).toBe(true);
    expect(socket.sentData).toContain(JSON.stringify({ type: 'prompt', message: 'hello' }));

    // After disconnect
    store.disconnect();
    expect(store.send({ type: 'ping' })).toBe(false);
  });

  it('resumes immediately when hidden in connecting state for >5s', () => {
    store.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();
    socket.triggerClose(1006, 'Abnormal closure');

    expect(store.wsState).toBe('connecting');
    const prevInstanceCount = FakeWebSocket.instances.length;

    // Simulate returning after 6s hidden while connecting
    store.hiddenAt = Date.now() - 6_000;
    store.resumeFromHidden();

    // Should cancel existing reconnect and connect immediately
    expect(FakeWebSocket.instances.length).toBe(prevInstanceCount + 1);
  });
});
