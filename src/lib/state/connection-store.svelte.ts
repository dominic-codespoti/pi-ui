/**
 * WebSocket connection lifecycle for the main chat page.
 *
 * Owns everything transport-level: dialing (dev port aware), application-level
 * handshake bookkeeping, zombie-socket heartbeat, exponential-backoff
 * reconnection (paused while hidden/offline), the expired-token login
 * redirect, and the HTTP auth probe that distinguishes "server down" from
 * "session expired". Consumers wire `onMessage` / `onSocketClosed` and read
 * `wsState` / `handshakeComplete` / `reconnectCountdown`.
 *
 * Not owned here: message routing (handleServer), stream sealing, terminal
 * input flushing, restart-pending reloads — those stay page-side via hooks.
 */
import { dev } from '$app/env';
import { reconnectDelay } from '#lib/client-messages.js';
import type { ClientMessage } from '#lib/ws/protocol.js';
export type WsState = 'connecting' | 'open' | 'closed';

const HEARTBEAT_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;

export class ConnectionStore {
  wsState = $state<WsState>('closed');
  /** True after this socket received its application-level `connected`. */
  handshakeComplete = $state(false);
  /** Seconds until the next reconnect attempt fires (0 when idle). */
  reconnectCountdown = $state(0);

  /** Page hook: raw server frame (liveness already recorded). */
  onMessage: (data: string) => void = () => {};
  /**
   * Page hook: socket lost after the stale/intentional guards passed and the
   * heartbeat stopped — seal streams, surface notices. Reconnect scheduling
   * and the auth probe run afterwards inside the store.
   */
  onSocketClosed: (event: CloseEvent) => void = () => {};

  /** Epoch ms of the last transition to hidden — drives resume decisions. */
  hiddenAt = 0;

  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMsgAt = 0;
  private pingSentAt = 0;
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private authProbeInFlight = false;

  send(msg: ClientMessage): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Handshake landed — reset the backoff counter for this healthy socket. */
  noteConnected(): void {
    this.handshakeComplete = true;
    this.reconnectAttempt = 0;
  }

  connect(): void {
    if (document.hidden) return;
    if (this.socket) {
      // Belt-and-braces: null the old socket's close handler so a superseded
      // socket cannot clobber current state or schedule spurious reconnects.
      this.socket.onclose = null;
      this.socket.onerror = null;
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.cancelReconnect();

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // In dev mode the Bun WS server runs on a separate port (5174);
    // in production everything is served from a single port.
    const wsPort = dev ? '5174' : location.port;
    const socket = new WebSocket(`${proto}//${location.hostname}${wsPort ? ':' + wsPort : ''}/ws`);
    this.socket = socket;
    this.handshakeComplete = false;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.wsState = 'open';
      this.cancelReconnect();
      this.startHeartbeat();
    };

    socket.onmessage = ({ data }: MessageEvent<string>) => {
      if (this.socket !== socket) return;
      this.lastMsgAt = Date.now();
      this.onMessage(data);
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.stopHeartbeat();
      if (this.intentionalClose) return;
      // 4001 = the server closed the socket because the session token expired
      // (or was revoked). Reconnecting can never succeed — go to /login.
      if (event.code === 4001) {
        this.redirectToLogin();
        return;
      }
      this.onSocketClosed(event);
      this.wsState = 'connecting';
      this.scheduleReconnect();
      // A rejected upgrade (expired cookie) looks like a dead server to the
      // WS API — probe HTTP to distinguish the two.
      void this.probeSessionExpired();
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };
  }

  /** Gracefully close the WS without reconnecting. */
  disconnect(): void {
    this.intentionalClose = true;
    this.wsState = 'closed';
    this.stopHeartbeat();
    this.cancelReconnect();
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }

  /**
   * Resume path when the tab becomes visible again after being hidden.
   * Encodes the original timing heuristics: a stale countdown while hidden,
   * an idle timeout window, and detached-handler force reconnects.
   */
  resumeFromHidden(): void {
    if (this.hiddenAt <= 0) return;
    const wasHidden = Date.now() - this.hiddenAt;
    this.hiddenAt = 0;
    if (this.wsState === 'connecting' && wasHidden > 5000) {
      // Server likely timed us out — reset and connect immediately.
      this.intentionalClose = false;
      this.cancelReconnect();
      this.connect();
    } else if (this.wsState === 'connecting') {
      this.scheduleReconnect();
    } else if (this.wsState === 'open' && wasHidden > 120_000) {
      // Server idle timeout (120s) likely closed the socket — force reconnect.
      this.forceReconnect();
    }
  }

  /**
   * Tear down the current socket without waiting for its async close event
   * and dial immediately. Used when the server's idle timeout silently
   * dropped an open-but-dead socket while the tab was hidden.
   */
  forceReconnect(): void {
    this.intentionalClose = false;
    const old = this.socket;
    if (old) {
      // Detach first: the close event fires asynchronously and must not
      // clobber the fresh connection's state.
      old.onclose = null;
      old.onerror = null;
      try {
        old.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.wsState = 'connecting';
    this.connect();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastMsgAt = Date.now();
    this.pingSentAt = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      // A ping is outstanding, its timeout passed, and nothing arrived since —
      // the socket is dead. Force-close so onclose fires and reconnection runs.
      if (
        this.pingSentAt &&
        this.lastMsgAt < this.pingSentAt &&
        now - this.pingSentAt > PONG_TIMEOUT_MS
      ) {
        try {
          this.socket.close();
        } catch {
          /* ignore */
        }
        return;
      }
      if (now - this.lastMsgAt >= HEARTBEAT_INTERVAL_MS) {
        this.pingSentAt = now;
        this.send({ type: 'ping' });
      }
    }, HEARTBEAT_INTERVAL_MS / 2);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
    this.reconnectCountdown = 0;
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (document.hidden) {
      this.hiddenAt = Date.now();
      return; // pause reconnection while page is hidden
    }
    if (!navigator.onLine) return; // wait for online event
    this.cancelReconnect();
    const delay = reconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.wsState = 'connecting';
    this.reconnectCountdown = Math.ceil(delay / 1000);
    this.reconnectInterval = setInterval(() => {
      this.reconnectCountdown = Math.max(0, this.reconnectCountdown - 1);
    }, 1000);
    this.reconnectTimer = setTimeout(() => {
      if (this.reconnectInterval) {
        clearInterval(this.reconnectInterval);
        this.reconnectInterval = null;
      }
      this.connect();
    }, delay);
  }

  /** Navigate to /login, preserving the current URL so login can return here. */
  private redirectToLogin(): void {
    this.intentionalClose = true;
    this.cancelReconnect();
    this.stopHeartbeat();
    this.wsState = 'closed';
    const current = location.pathname + location.search;
    location.assign(`/login?redirect=${encodeURIComponent(current)}`);
  }

  /**
   * Detect an expired/revoked session after a socket failure. A rejected WS
   * upgrade (401) surfaces to the client as a generic abnormal close, so the
   * only way to tell "server down" from "session expired" is an HTTP probe:
   * hooks.server redirects every path but /login with a 302 when the JWT is
   * missing or invalid. Network failures mean the server is unreachable and
   * the normal reconnect loop applies.
   */
  private async probeSessionExpired(): Promise<void> {
    if (this.authProbeInFlight || document.hidden || !navigator.onLine) return;
    this.authProbeInFlight = true;
    try {
      const res = await fetch('/', { method: 'HEAD', redirect: 'manual', cache: 'no-store' });
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
        this.redirectToLogin();
      }
    } catch {
      // Server unreachable — keep the reconnect loop.
    } finally {
      this.authProbeInFlight = false;
    }
  }
}
