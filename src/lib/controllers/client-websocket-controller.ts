import type { ClientMessage, ServerMessage } from '#lib/ws/protocol.js';
import { parseServerMessage } from '#lib/ws/server-message-schema.js';
import { reconnectDelay } from '#lib/client-messages.js';

export const WEBSOCKET_OPEN = 1;

export type ClientConnectionState = 'closed' | 'connecting' | 'open';

/** The small browser WebSocket surface owned by this controller. */
export interface ClientWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface ClientWebSocketCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
  readonly handshakeComplete: boolean;
  readonly intentional: boolean;
}

export type ClientWebSocketReplacementReason = 'connect_replace' | 'hidden_timeout';

export interface ClientWebSocketReplacementInfo {
  readonly reason: ClientWebSocketReplacementReason;
  readonly handshakeComplete: boolean;
}

export interface ClientWebSocketErrorInfo {
  readonly event: unknown;
  readonly error?: unknown;
  readonly handshakeComplete: boolean;
  readonly intentional: boolean;
}

export type ClientWebSocketFactory = (url: string) => ClientWebSocket;
export type TimerHandle = unknown;

export interface ClientWebSocketTimers {
  setTimeout(callback: () => void, delay: number): TimerHandle;
  clearTimeout(timer: TimerHandle): void;
  setInterval(callback: () => void, delay: number): TimerHandle;
  clearInterval(timer: TimerHandle): void;
}

export interface ClientDocumentVisibility {
  readonly hidden: boolean;
}

export interface ClientLocation {
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly pathname: string;
  readonly search: string;
  assign(url: string): void;
}

export interface ClientWebSocketControllerState {
  connectionState: ClientConnectionState;
  reconnectAttempt: number;
  reconnectCountdown: number;
  handshakeComplete: boolean;
}

export type AuthProbe = () => boolean | Promise<boolean>;

export interface ClientWebSocketControllerOptions {
  /** Creates a socket for the URL supplied by `socketUrl`/`location`. */
  socketFactory: ClientWebSocketFactory;
  /** Override URL construction when the host/port convention is not suitable. */
  socketUrl?: string | (() => string);
  /** In development, use the Bun WS server's separate 5174 port. */
  development?: boolean;
  dev?: boolean;
  location?: ClientLocation;
  document?: ClientDocumentVisibility;
  isOnline?: () => boolean;
  timers?: Partial<ClientWebSocketTimers>;
  setTimeout?: ClientWebSocketTimers['setTimeout'];
  clearTimeout?: ClientWebSocketTimers['clearTimeout'];
  setInterval?: ClientWebSocketTimers['setInterval'];
  clearInterval?: ClientWebSocketTimers['clearInterval'];
  now?: () => number;
  /** Alias-shaped clock dependency for callers that group browser primitives. */
  clock?: { now: () => number };
  /** Optional deterministic delay override for tests or alternate clients. */
  reconnectDelay?: (attempt: number) => number;
  authProbe?: AuthProbe;
  /** Called with the login URL. Return true to indicate that navigation was handled. */
  onAuthRedirect?: (url: string) => boolean | void;
  onConnectionStateChange?: (state: ClientWebSocketControllerState) => void;
  onMessage?: (message: ServerMessage) => void;
  onProtocolInvalid?: (issues: string[]) => void;
  onClose?: (event: ClientWebSocketCloseInfo) => void;
  /** Called before a controller-initiated socket replacement detaches the old socket. */
  onSocketReplace?: (event: ClientWebSocketReplacementInfo) => void;
  onError?: (event: ClientWebSocketErrorInfo) => void;
  onReconnectCountdown?: (seconds: number) => void;
  onReconnectAttempt?: (attempt: number) => void;
  heartbeatIntervalMs?: number;
  pongTimeoutMs?: number;
  reconnectCountdownIntervalMs?: number;
  hiddenReconnectImmediateMs?: number;
  hiddenSocketTimeoutMs?: number;
}

const defaultVisibility: ClientDocumentVisibility = { hidden: false };
const defaultLocation: ClientLocation = {
  protocol: 'http:',
  hostname: 'localhost',
  port: '',
  pathname: '/',
  search: '',
  assign: () => undefined,
};

const browserLocation = (): ClientLocation => {
  if (typeof globalThis.location !== 'undefined') return globalThis.location;
  return defaultLocation;
};

const browserDocument = (): ClientDocumentVisibility => {
  if (typeof globalThis.document !== 'undefined') return globalThis.document;
  return defaultVisibility;
};

const browserOnline = (): boolean => {
  if (typeof globalThis.navigator === 'undefined') return true;
  return globalThis.navigator.onLine;
};

type NativeTimerHandle = Parameters<typeof globalThis.clearTimeout>[0];

const browserTimers: ClientWebSocketTimers = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as NativeTimerHandle),
  setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
  clearInterval: (timer) => globalThis.clearInterval(timer as NativeTimerHandle),
};
const parseFrame = (
  data: unknown
): { ok: true; value: ServerMessage } | { ok: false; issues: string[] } => {
  if (typeof data !== 'string') {
    return { ok: false, issues: ['Expected a JSON text WebSocket frame'] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { ok: false, issues: ['Failed to parse WebSocket frame as JSON'] };
  }
  const parsed = parseServerMessage(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value as ServerMessage };
};

/**
 * Owns the browser-side WebSocket lifecycle. All browser effects are injected
 * so this class can be exercised without Svelte or a real network connection.
 */
export class ClientWebSocketController {
  private readonly options: ClientWebSocketControllerOptions;
  private readonly socketFactory: ClientWebSocketFactory;
  private readonly timers: ClientWebSocketTimers;
  private readonly now: () => number;
  private readonly document: ClientDocumentVisibility;
  private readonly location: ClientLocation;
  private readonly isOnline: () => boolean;
  private readonly authProbe: AuthProbe;
  private readonly heartbeatIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly reconnectCountdownIntervalMs: number;
  private readonly hiddenReconnectImmediateMs: number;
  private readonly hiddenSocketTimeoutMs: number;
  private readonly delay: (attempt: number) => number;

  private state: ClientWebSocketControllerState = {
    connectionState: 'closed',
    reconnectAttempt: 0,
    reconnectCountdown: 0,
    handshakeComplete: false,
  };
  private socket: ClientWebSocket | null = null;
  private socketGeneration = 0;
  private reconnectTimer: TimerHandle | null = null;
  private reconnectInterval: TimerHandle | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private lastMessageAt = 0;
  private pingSentAt = 0;
  private pageHiddenAt = 0;
  private intentionalClose = false;
  private authProbeInFlight = false;
  private listeners = new Set<(state: ClientWebSocketControllerState) => void>();

  constructor(options: ClientWebSocketControllerOptions) {
    this.options = options;
    this.socketFactory = options.socketFactory;
    const timerOverrides = options.timers ?? {};
    this.timers = {
      setTimeout: options.setTimeout ?? timerOverrides.setTimeout ?? browserTimers.setTimeout,
      clearTimeout:
        options.clearTimeout ?? timerOverrides.clearTimeout ?? browserTimers.clearTimeout,
      setInterval: options.setInterval ?? timerOverrides.setInterval ?? browserTimers.setInterval,
      clearInterval:
        options.clearInterval ?? timerOverrides.clearInterval ?? browserTimers.clearInterval,
    };
    this.now = options.now ?? options.clock?.now ?? (() => Date.now());
    this.document = options.document ?? browserDocument();
    this.location = options.location ?? browserLocation();
    this.isOnline = options.isOnline ?? browserOnline;
    this.authProbe = options.authProbe ?? this.defaultAuthProbe;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.reconnectCountdownIntervalMs = options.reconnectCountdownIntervalMs ?? 1_000;
    this.hiddenReconnectImmediateMs = options.hiddenReconnectImmediateMs ?? 5_000;
    this.hiddenSocketTimeoutMs = options.hiddenSocketTimeoutMs ?? 120_000;
    this.delay = options.reconnectDelay ?? reconnectDelay;
  }

  get current(): ClientWebSocketControllerState {
    return { ...this.state };
  }

  get connectionState(): ClientConnectionState {
    return this.state.connectionState;
  }

  subscribe(listener: (state: ClientWebSocketControllerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }
  private publish(): void {
    const snapshot = this.current;
    this.options.onConnectionStateChange?.(snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }

  private updateState(patch: Partial<ClientWebSocketControllerState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as (keyof ClientWebSocketControllerState)[]) {
      const value = patch[key];
      if (value !== undefined && this.state[key] !== value) changed = true;
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    if (patch.reconnectCountdown !== undefined) {
      this.options.onReconnectCountdown?.(this.state.reconnectCountdown);
    }
    this.publish();
  }

  private hidden(): boolean {
    return this.document.hidden;
  }

  private socketUrl(): string {
    if (typeof this.options.socketUrl === 'function') return this.options.socketUrl();
    if (this.options.socketUrl) return this.options.socketUrl;
    const protocol = this.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const port = this.options.development || this.options.dev ? '5174' : this.location.port;
    return `${protocol}//${this.location.hostname}${port ? `:${port}` : ''}/ws`;
  }

  private defaultAuthProbe = async (): Promise<boolean> => {
    if (typeof globalThis.fetch !== 'function') return false;
    try {
      const response = await globalThis.fetch('/', {
        method: 'HEAD',
        redirect: 'manual',
        cache: 'no-store',
      });
      return (
        response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)
      );
    } catch {
      return false;
    }
  };

  private detach(socket: ClientWebSocket): void {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.timers.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pingSentAt = 0;
  }

  startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastMessageAt = this.now();
    this.pingSentAt = 0;
    const generation = this.socketGeneration;
    this.heartbeatTimer = this.timers.setInterval(() => {
      const current = this.socket;
      if (!current || generation !== this.socketGeneration || current.readyState !== WEBSOCKET_OPEN)
        return;
      const now = this.now();
      if (
        this.pingSentAt &&
        this.lastMessageAt < this.pingSentAt &&
        now - this.pingSentAt > this.pongTimeoutMs
      ) {
        try {
          current.close();
        } catch {
          // A close failure still leaves the normal reconnect path to onclose.
        }
        return;
      }
      if (now - this.lastMessageAt >= this.heartbeatIntervalMs) {
        this.pingSentAt = now;
        this.send({ type: 'ping' });
      }
    }, this.heartbeatIntervalMs / 2);
  }

  stopReconnect(): void {
    this.cancelReconnect();
  }

  cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectInterval !== null) {
      this.timers.clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    this.updateState({ reconnectCountdown: 0 });
  }

  scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.hidden()) {
      if (this.pageHiddenAt <= 0) this.pageHiddenAt = this.now();
      return;
    }
    if (!this.isOnline()) return;

    this.cancelReconnect();
    const delay = this.delay(this.state.reconnectAttempt);
    const attempt = this.state.reconnectAttempt + 1;
    this.updateState({ connectionState: 'connecting', reconnectAttempt: attempt });
    this.options.onReconnectAttempt?.(attempt);
    this.updateState({ reconnectCountdown: Math.ceil(delay / 1000) });
    this.reconnectInterval = this.timers.setInterval(() => {
      this.updateState({ reconnectCountdown: Math.max(0, this.state.reconnectCountdown - 1) });
    }, this.reconnectCountdownIntervalMs);
    const timer = this.timers.setTimeout(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = null;
      if (this.reconnectInterval !== null) {
        this.timers.clearInterval(this.reconnectInterval);
        this.reconnectInterval = null;
      }
      this.updateState({ reconnectCountdown: 0 });
      if (this.intentionalClose || this.hidden() || !this.isOnline()) return;
      this.connect();
    }, delay);
    this.reconnectTimer = timer;
  }

  /** Establish a socket, detaching all handlers from any socket it supersedes. */
  connect(replacementReason?: ClientWebSocketReplacementReason): void {
    if (this.hidden()) return;
    this.intentionalClose = false;
    this.cancelReconnect();
    this.stopHeartbeat();

    const oldSocket = this.socket;
    if (oldSocket) {
      this.options.onSocketReplace?.({
        reason: replacementReason ?? 'connect_replace',
        handshakeComplete: this.state.handshakeComplete,
      });
      this.detach(oldSocket);
      this.socket = null;
      try {
        oldSocket.close();
      } catch {
        // The replacement socket must still be created if close rejects.
      }
    }

    this.socketGeneration += 1;
    const generation = this.socketGeneration;
    this.updateState({ connectionState: 'connecting', handshakeComplete: false });
    let socket: ClientWebSocket;
    try {
      socket = this.socketFactory(this.socketUrl());
    } catch {
      if (generation === this.socketGeneration) this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || generation !== this.socketGeneration) return;
      this.updateState({ connectionState: 'open' });
      this.cancelReconnect();
      this.startHeartbeat();
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket || generation !== this.socketGeneration) return;
      this.lastMessageAt = this.now();
      const parsed = parseFrame(event.data);
      if (!parsed.ok) {
        this.options.onProtocolInvalid?.(parsed.issues);
        return;
      }
      if (parsed.value.type === 'connected') {
        this.updateState({ handshakeComplete: true, reconnectAttempt: 0 });
      }
      this.options.onMessage?.(parsed.value);
    };

    socket.onclose = (event) => {
      if (this.socket !== socket || generation !== this.socketGeneration) return;
      this.options.onClose?.({
        code: event.code,
        reason: event.reason ?? '',
        wasClean: event.wasClean ?? false,
        handshakeComplete: this.state.handshakeComplete,
        intentional: this.intentionalClose,
      });
      if (this.socket !== socket || generation !== this.socketGeneration) return;
      this.socket = null;
      this.detach(socket);
      this.stopHeartbeat();
      this.updateState({ handshakeComplete: false });
      if (event.code === 4001) {
        this.redirectToLogin();
        return;
      }
      if (this.intentionalClose) {
        this.updateState({ connectionState: 'closed' });
        return;
      }
      this.updateState({ connectionState: 'connecting' });
      this.scheduleReconnect();
      void this.probeSessionExpired();
    };

    socket.onerror = (event) => {
      if (this.socket !== socket || generation !== this.socketGeneration) return;
      const error =
        typeof event === 'object' && event !== null && 'error' in event
          ? (event as { error?: unknown }).error
          : undefined;
      this.options.onError?.({
        event,
        error,
        handshakeComplete: this.state.handshakeComplete,
        intentional: this.intentionalClose,
      });
      if (this.socket !== socket || generation !== this.socketGeneration) return;
      try {
        socket.close();
      } catch {
        // onclose performs the reconnect transition.
      }
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.socketGeneration += 1;
    this.cancelReconnect();
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      this.detach(socket);
      try {
        socket.close();
      } catch {
        // Intentional disconnect is complete even if the browser rejects close.
      }
    }
    this.updateState({ connectionState: 'closed', handshakeComplete: false });
  }

  dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }

  send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEBSOCKET_OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Resume reconnect behavior after a visibilitychange/focus event. */
  handleVisibilityChange(): void {
    if (this.hidden()) {
      if (this.pageHiddenAt <= 0) this.pageHiddenAt = this.now();
      this.cancelReconnect();
      return;
    }
    if (this.pageHiddenAt <= 0 || this.intentionalClose) return;
    const hiddenFor = this.now() - this.pageHiddenAt;
    this.pageHiddenAt = 0;
    if (this.state.connectionState === 'connecting') {
      if (hiddenFor > this.hiddenReconnectImmediateMs) {
        this.cancelReconnect();
        this.connect();
      } else {
        this.scheduleReconnect();
      }
      return;
    }
    if (this.state.connectionState === 'open' && hiddenFor > this.hiddenSocketTimeoutMs) {
      this.connect('hidden_timeout');
    }
  }

  resume(): void {
    this.handleVisibilityChange();
  }

  handleOnline(): void {
    if (this.intentionalClose || this.hidden() || this.state.connectionState === 'open') return;
    this.cancelReconnect();
    this.connect();
  }

  handleOffline(): void {
    if (this.state.connectionState === 'open') this.updateState({ connectionState: 'connecting' });
    this.cancelReconnect();
  }

  private async probeSessionExpired(): Promise<void> {
    if (this.authProbeInFlight || this.intentionalClose || this.hidden() || !this.isOnline())
      return;
    this.authProbeInFlight = true;
    try {
      if (await this.authProbe()) this.redirectToLogin();
    } catch {
      // Probe failures mean the server is unreachable; reconnecting remains active.
    } finally {
      this.authProbeInFlight = false;
    }
  }

  private redirectToLogin(): void {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.stopHeartbeat();
    this.updateState({ connectionState: 'closed', handshakeComplete: false });
    const current = this.location.pathname + this.location.search;
    const target = `/login?redirect=${encodeURIComponent(current)}`;
    if (this.options.onAuthRedirect) {
      this.options.onAuthRedirect(target);
    } else {
      this.location.assign(target);
    }
  }
}
