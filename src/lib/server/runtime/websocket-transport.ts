import type { ClientMessage } from '../../ws/protocol.ts';
import { isJtiRevoked as defaultIsJtiRevoked } from '../../auth/password.ts';

/** Per-connection state carried by Bun's WebSocket implementation. */
export interface WSData {
  connectedAt: number;
  /** JWT expiry (seconds since epoch) — checked periodically to close expired sockets. */
  tokenExp: number;
  /** JTI of the session token — checked periodically and per message so a
   * revoked (logged-out) token cannot keep driving an established socket. */
  jti?: string;
  /** Periodic expiry-check interval, cleared on close. */
  _expTimer?: Timer;
  /** True once the close handler ran. */
  closed?: boolean;
  /** Session currently visible in this socket's client. */
  focusedSessionId?: string;
}

/** Small structural subset of Bun's socket used by the transport. */
export interface WebSocketLike<TData extends WSData = WSData> {
  data: TData;
  send(data: string): unknown;
  subscribe(topic: string): unknown;
  unsubscribe(topic: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export type RawWebSocketFrame = string | ArrayBuffer | ArrayBufferView;

export interface WebSocketTransportOptions {
  topic: string;
  orphanGraceMs: number;
  onCancelOrphanCleanup: () => void;
  onScheduleOrphanCleanup: (delayMs: number) => void;
  isJtiRevoked?: (jti: string) => boolean;
  now?: () => number;
  expiryIntervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export interface WebSocketTransport<TData extends WSData = WSData> {
  readonly connectedClients: number;
  hasFocusedSocket(sessionId: string): boolean;
  onOpen(socket: WebSocketLike<TData>): void;
  onClose(socket: WebSocketLike<TData>): void;
  setFocusedSession(
    socket: WebSocketLike<TData>,
    sessionId: string | null,
    onFocus?: (sessionId: string) => void
  ): void;
  isAuthValid(data: TData): boolean;
  closeExpired(socket: WebSocketLike<TData>): void;
  installExpiryTimer(socket: WebSocketLike<TData>): void;
  clearExpiryTimer(socket: WebSocketLike<TData>): void;
  decodeFrame(raw: RawWebSocketFrame): ClientMessage | null;
}

/** Decode a Bun WebSocket text or binary frame without throwing on malformed input. */
export function decodeWebSocketFrame(raw: RawWebSocketFrame): ClientMessage | null {
  try {
    const text =
      typeof raw === 'string'
        ? raw
        : new TextDecoder().decode(
            ArrayBuffer.isView(raw)
              ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
              : new Uint8Array(raw)
          );
    return JSON.parse(text) as ClientMessage;
  } catch {
    return null;
  }
}

/** Alias kept descriptive for callers that deal in raw socket frames. */
export const decodeRawFrame = decodeWebSocketFrame;

/** Validate the auth identity captured during the authenticated upgrade. */
export function isCurrentAuthValid(
  data: Pick<WSData, 'tokenExp' | 'jti'>,
  options: Pick<WebSocketTransportOptions, 'isJtiRevoked' | 'now'> = {}
): boolean {
  const now = (options.now ?? Date.now)() / 1000;
  const revoked = options.isJtiRevoked ?? defaultIsJtiRevoked;
  return !(data.jti && revoked(data.jti)) && !(data.tokenExp !== undefined && now > data.tokenExp);
}

/** Safely close an expired/revoked socket with the established auth close reason. */
export function closeExpiredSocket<TData extends WSData>(socket: WebSocketLike<TData>): void {
  try {
    socket.close(4001, 'Session expired');
  } catch {
    // The socket may already have closed between validation and close().
  }
}

/** Build the stateful lifecycle and focus bookkeeping used by the server root. */
export function createWebSocketTransport<TData extends WSData = WSData>(
  options: WebSocketTransportOptions
): WebSocketTransport<TData> {
  let connectedClients = 0;
  const openSockets = new WeakSet<object>();
  const focusedSessionCounts = new Map<string, number>();
  const now = options.now ?? Date.now;
  const checkInterval = options.expiryIntervalMs ?? 60_000;
  const scheduleInterval = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  const isJtiRevoked = options.isJtiRevoked ?? defaultIsJtiRevoked;

  const transport: WebSocketTransport<TData> = {
    get connectedClients() {
      return connectedClients;
    },

    hasFocusedSocket(sessionId) {
      return (focusedSessionCounts.get(sessionId) ?? 0) > 0;
    },

    onOpen(socket) {
      if (openSockets.has(socket)) return;
      openSockets.add(socket);
      socket.data.closed = false;
      socket.subscribe(options.topic);
      connectedClients++;
      options.onCancelOrphanCleanup();
    },

    onClose(socket) {
      if (!openSockets.delete(socket)) return;
      socket.data.closed = true;
      socket.unsubscribe(options.topic);
      transport.clearExpiryTimer(socket);
      const focused = socket.data.focusedSessionId;
      if (focused) {
        const count = focusedSessionCounts.get(focused) ?? 0;
        if (count <= 1) focusedSessionCounts.delete(focused);
        else focusedSessionCounts.set(focused, count - 1);
      }
      socket.data.focusedSessionId = undefined;
      connectedClients = Math.max(0, connectedClients - 1);
      if (connectedClients === 0) options.onScheduleOrphanCleanup(options.orphanGraceMs);
    },

    setFocusedSession(socket, sessionId, onFocus) {
      const previous = socket.data.focusedSessionId;
      if (previous === sessionId) return;
      if (previous) {
        const count = focusedSessionCounts.get(previous) ?? 0;
        if (count <= 1) focusedSessionCounts.delete(previous);
        else focusedSessionCounts.set(previous, count - 1);
      }
      if (sessionId) {
        focusedSessionCounts.set(sessionId, (focusedSessionCounts.get(sessionId) ?? 0) + 1);
      }
      socket.data.focusedSessionId = sessionId ?? undefined;
      if (sessionId) onFocus?.(sessionId);
    },

    isAuthValid(data) {
      return isCurrentAuthValid(data, { isJtiRevoked, now });
    },

    closeExpired(socket) {
      transport.clearExpiryTimer(socket);
      closeExpiredSocket(socket);
    },

    installExpiryTimer(socket) {
      if (socket.data.closed) return;
      transport.clearExpiryTimer(socket);
      socket.data._expTimer = scheduleInterval(() => {
        if (socket.data.closed) return;
        if (!transport.isAuthValid(socket.data)) transport.closeExpired(socket);
      }, checkInterval);
    },

    clearExpiryTimer(socket) {
      if (socket.data._expTimer === undefined) return;
      clearIntervalFn(socket.data._expTimer);
      socket.data._expTimer = undefined;
    },

    decodeFrame(raw) {
      return decodeWebSocketFrame(raw);
    },
  };

  return transport;
}
