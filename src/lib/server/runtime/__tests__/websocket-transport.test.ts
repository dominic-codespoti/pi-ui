import { describe, expect, it, vi } from 'vitest';
import {
  closeExpiredSocket,
  createWebSocketTransport,
  decodeWebSocketFrame,
  isCurrentAuthValid,
  type WSData,
  type WebSocketLike,
  type WebSocketTransportOptions,
} from '../websocket-transport';

function socket(data: Partial<WSData> = {}) {
  return {
    data: { connectedAt: 0, tokenExp: Infinity, ...data },
    send: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    close: vi.fn(),
  } satisfies WebSocketLike;
}

function transport(options: Partial<WebSocketTransportOptions> = {}) {
  return createWebSocketTransport({
    topic: 'pi',
    orphanGraceMs: 500,
    onCancelOrphanCleanup: vi.fn(),
    onScheduleOrphanCleanup: vi.fn(),
    ...options,
  });
}

describe('decodeWebSocketFrame', () => {
  it('decodes text, ArrayBuffer, and typed-array frames', () => {
    const json = '{"type":"ping"}';
    const bytes = new TextEncoder().encode(json);

    expect(decodeWebSocketFrame(json)).toEqual({ type: 'ping' });
    expect(decodeWebSocketFrame(bytes.buffer)).toEqual({ type: 'ping' });
    expect(decodeWebSocketFrame(bytes)).toEqual({ type: 'ping' });
  });

  it('returns null for malformed JSON and malformed UTF-8 JSON', () => {
    expect(decodeWebSocketFrame('{')).toBeNull();
    expect(decodeWebSocketFrame(new Uint8Array([0xc3, 0x28]))).toBeNull();
  });
});

describe('websocket transport auth and lifecycle', () => {
  it('recognizes revoked and expired identities and closes an invalid socket', () => {
    const now = () => 2_000_000;
    const isJtiRevoked = (jti: string) => jti === 'revoked';
    const current = transport({ now, isJtiRevoked });

    expect(current.isAuthValid({ connectedAt: 0, tokenExp: 2_001, jti: 'ok' })).toBe(true);
    expect(current.isAuthValid({ connectedAt: 0, tokenExp: 2_001, jti: 'revoked' })).toBe(false);
    expect(current.isAuthValid({ connectedAt: 0, tokenExp: 1_999 })).toBe(false);
    expect(isCurrentAuthValid({ tokenExp: 0 }, { now })).toBe(false);

    const ws = socket({ tokenExp: 1_999 });
    closeExpiredSocket(ws);
    expect(ws.close).toHaveBeenCalledWith(4001, 'Session expired');
  });

  it('closes revoked sockets from the injected expiry timer and clears the timer', () => {
    let tick: (() => void) | undefined;
    const timer = {} as Timer;
    const schedule = vi.fn((callback: () => void) => {
      tick = callback;
      return timer;
    }) as unknown as typeof globalThis.setInterval;
    const clear = vi.fn() as unknown as typeof globalThis.clearInterval;
    const ws = socket({ tokenExp: Infinity, jti: 'revoked' });
    const t = transport({
      isJtiRevoked: (jti) => jti === 'revoked',
      setInterval: schedule,
      clearInterval: clear,
    });

    t.onOpen(ws);
    t.installExpiryTimer(ws);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(tick).toBeDefined();
    tick?.();

    expect(ws.close).toHaveBeenCalledWith(4001, 'Session expired');
    expect(clear).toHaveBeenCalledWith(timer);
    expect(ws.data._expTimer).toBeUndefined();
  });

  it('tracks open/close and focus refcounts, including orphan cleanup', () => {
    const cancelOrphanCleanup = vi.fn();
    const scheduleOrphanCleanup = vi.fn();
    const t = transport({
      onCancelOrphanCleanup: cancelOrphanCleanup,
      onScheduleOrphanCleanup: scheduleOrphanCleanup,
    });
    const first = socket();
    const second = socket();
    const onFocus = vi.fn();

    t.onOpen(first);
    t.onOpen(second);
    t.onOpen(first);
    expect(t.connectedClients).toBe(2);
    expect(cancelOrphanCleanup).toHaveBeenCalledTimes(2);
    expect(first.subscribe).toHaveBeenCalledTimes(1);

    t.setFocusedSession(first, 'one', onFocus);
    t.setFocusedSession(second, 'one');
    expect(t.hasFocusedSocket('one')).toBe(true);
    expect(onFocus).toHaveBeenCalledWith('one');

    t.setFocusedSession(first, 'two');
    expect(t.hasFocusedSocket('one')).toBe(true);
    expect(t.hasFocusedSocket('two')).toBe(true);
    t.onClose(first);
    expect(t.connectedClients).toBe(1);
    expect(t.hasFocusedSocket('one')).toBe(true);
    expect(t.hasFocusedSocket('two')).toBe(false);

    t.onClose(second);
    t.onClose(second);
    expect(t.connectedClients).toBe(0);
    expect(t.hasFocusedSocket('one')).toBe(false);
    expect(scheduleOrphanCleanup).toHaveBeenCalledTimes(1);
    expect(scheduleOrphanCleanup).toHaveBeenCalledWith(500);
    expect(second.unsubscribe).toHaveBeenCalledWith('pi');
  });
});
