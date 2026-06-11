# pi-ui-2 — Agent Context

PWA frontend for the `pi` coding agent, analogous to how OpenChamber fronts OpenCode.
Hosted on a Raspberry Pi — low memory/CPU is a hard constraint.

---

## What this is

A SvelteKit + Bun application that:
1. Wraps the `pi` TypeScript SDK in a server-side session manager
2. Bridges pi events → browser over a single WebSocket at `/ws`
3. Serves a Svelte 5 SPA with PWA support
4. Guards access with a password set at startup via `PI_PASSWORD=... bun run start`

**Design philosophy: pass-through GUI, not business logic.** pi-ui does not impose
its own data model or behavior on top of Pi — it forwards SDK events verbatim,
passes user gestures through as SDK calls, and provides a web interface for Pi's
native session/project concepts.

Reference architecture: [OpenChamber](https://github.com/openchamber/openchamber) ↔ OpenCode.

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Svelte 5 + SvelteKit | Compiled to vanilla JS, minimal runtime |
| Server adapter | `svelte-adapter-bun` (community) | Fetch-API native handler; required for Bun WS interop |
| Runtime | Bun | Lower memory than Node; native WebSocket in `Bun.serve` |
| Styling | Tailwind CSS v4 | Utility-first, zero runtime |
| PWA | SvelteKit native service worker | Custom `src/service-worker.ts`; no Workbox |
| Pi integration | `@earendil-works/pi-coding-agent` SDK (server-side only) | In-process, typed; no subprocess overhead |
| Auth | Bcrypt hash of `PI_PASSWORD` env var; signed HTTP-only cookie | Simple, no DB |

---

## Project structure

```
src/
  app.html                  # Shell; PWA manifest + iOS meta tags
  app.css                   # Tailwind v4 + daisyUI styles
  service-worker.ts         # Minimal custom SW; no Workbox or offline cache
  lib/
    auth/
      password.ts           # bcryptjs hash (globalThis); jose JWT sign/verify
      rate-limiter.ts       # In-memory IP-based login rate limiter
    ws/
      protocol.ts           # Shared ServerMessage / ClientMessage types
    server/
      project-registry.ts   # Persisted JSON project registry (sessions grouped by cwd)
    state/
      projects-state.svelte.ts # Runes-based shared projects/session list state
    tui-stubs.ts            # Minimal pi-tui stub bridge for extension UI rendering
    markdown.ts             # Configured marked + highlight.js renderer
    diff-parser.ts          # Unified diff parser for DiffViewer
    utils.ts                # cn(), formatRelativeDate(), type helpers
    components/
      ui/                   # shadcn-style UI primitives (dialog, button, select, switch, card, etc.)
      sidebar-panel.svelte  # Reusable slide-out panel
      diff-viewer.svelte    # Inline unified-diff renderer
      file-viewer-modal.svelte # Workspace file viewer/editor
      projects/             # Projects sidebar, project picker components
  routes/
    (auth)/+layout.svelte
      login/+page.svelte    # Password form (Svelte 5 runes)
      login/+page.server.ts # POST action: verify → set cookie → redirect /
    (app)/
      +layout.ts            # ssr=false, prerender=false
      +layout.svelte
      +page.svelte          # Main chat UI (WS client, message rendering, STT)
hooks.server.ts             # Auth guard — redirects unauthenticated → /login
server.ts                   # Bun entry: pi session init, WS upgrade at /ws, SK handler fallback
svelte.config.js            # svelte-adapter-bun adapter
vite.config.ts              # Tailwind v4 + SvelteKit
```

---

## Dev commands

```bash
# Install
bun install

# Dev (SK dev server — no WebSocket, use for UI iteration only)
bun run dev

# Build
bun run build

# Serve (production — runs custom server.ts with WS support)
PI_PASSWORD=secret bun run start

# Typecheck
bun run check       # svelte-check

# Lint / format
bun run lint        # eslint
bun run format      # prettier
```

---

## Critical architecture notes

### Bun server.ts — WebSocket interception pattern

`svelte-adapter-bun` generates a Fetch-API-native `build/handler.js`.
**Do not use `@sveltejs/adapter-node`** — its `handler.js` uses Node's
`IncomingMessage`/`ServerResponse` and is incompatible with `Bun.serve`.

```ts
// server.ts
import { handler } from "./build/handler.js";

Bun.serve<{ sessionId: string }>({
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      // auth check before upgrade
      const cookie = req.headers.get("cookie") ?? "";
      if (!isValidSession(cookie)) return new Response("Unauthorized", { status: 401 });
      if (server.upgrade(req, { data: { sessionId: extractSessionId(cookie) } })) return;
      return new Response("WS upgrade failed", { status: 400 });
    }
    return handler(req);
  },
  websocket: {
    open(ws)            { /* attach pi session listener */ },
    message(ws, msg)    { /* dispatch RpcCommand to pi session */ },
    close(ws)           { /* detach listener */ },
    idleTimeout: 120,
    perMessageDeflate: true,  // saves bandwidth on the Pi
  },
});
```

### Pi SDK usage (server-side only)

```ts
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({ cwd: process.cwd() });

// Send a prompt
await session.prompt("Hello");

// Stream events to browser — forwarded verbatim, no enrichment
const unsubscribe = session.subscribe((event) => {
  ws.send(JSON.stringify(event));
});

// Forking uses the SDK's native branching API
import { SessionManager } from "@earendil-works/pi-coding-agent";
const sm = SessionManager.open(session.sessionFile!);
const forkPath = sm.createBranchedSession(entryId);

// Key events to handle
// "agent_start" / "agent_end"        → isStreaming state
// "message_update" text_delta        → streaming text
// "tool_execution_start/end"         → tool progress UI
// "queue_update"                     → pending message queue
// "extension_ui_request"             → modal dialog (MUST respond)
```

**`session.subscribe` is the only streaming mechanism** — there is no HTTP SSE
from the SDK. All events come through this callback.

### Extension UI requests — must respond or pi hangs

When pi emits `extension_ui_request` with `method: "select" | "confirm" | "input" | "editor"`,
the session blocks until `extension_ui_response` is sent. Forward to browser,
collect user response via WS, call the appropriate session method.

Fire-and-forget methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`)
need no response — just display them.

### Pi SDK is ESM only

`@earendil-works/pi-coding-agent` is `"type": "module"`. Everything importing it
must be ESM. `server.ts` and all lib files must use `.ts` extensions and
`"type": "module"` in `package.json`.

### Auth flow

1. Start: `PI_PASSWORD=secret bun run start` → bcrypt hash stored in memory
2. `POST /login` with `{ password }` → verify → set signed HTTP-only cookie
   (use `jose` for HS256 JWT or `crypto.subtle` — no external session DB)
3. `hooks.server.ts` checks cookie on every request; redirects to `/login` if invalid
4. WS upgrade in `server.ts` re-validates cookie before upgrade

### Design principles — things we intentionally don't do

pi-ui avoids imposing logic on Pi. Features that were removed to stay lean:

- **No TTS** — no speech synthesis, no LLM-generated spoken summaries, no auto-speak.
  Speech-to-text (STT) dictation via the browser's `SpeechRecognition` API is kept
  as a text input convenience — it doesn't touch Pi.
- **No auto-compaction health monitor** — the SDK handles compaction natively.
- **No history paging** — full `session.messages` array is sent on connect/switch.
  No `HistoryWindow`, no `load_history` protocol message.
- **No contextUsage enrichment** — SDK events forwarded as-is, no data grafted on.
- **No default thinking level override** — SDK's own default is used.
- **No `boundedInt` / history limits** — removed with paging.

### PWA service worker

Use SvelteKit's native `src/service-worker.ts` entry. Keep it minimal — just
`install` (skipWaiting), `activate` (clients.claim), and `fetch` passthrough.
No offline caching of chat history (RPi storage is limited).

---

## Pi SDK key types (import from `@earendil-works/pi-coding-agent`)

```ts
// Session
interface AgentSession {
  prompt(text: string, options?: PromptOptions): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  setModel(model: Model): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  messages: AgentMessage[];
  isStreaming: boolean;
  sessionId: string;
  dispose(): void;
}

// AgentMessage roles
type AgentMessage =
  | { role: "user"; content: string | ContentBlock[]; timestamp: number }
  | { role: "assistant"; content: ContentBlock[]; usage: TokenUsage; stopReason: string; timestamp: number }
  | { role: "toolResult"; toolCallId: string; toolName: string; content: ContentBlock[]; isError: boolean; timestamp: number }
  | { role: "bashExecution"; command: string; output: string; exitCode: number; timestamp: number }

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
// Note: "xhigh" only works with openai codex-max
```

---

## Memory / CPU constraints (Raspberry Pi)

- **No SSR for chat messages** — render client-side only; avoid hydration overhead
- **No Workbox** — Workbox precaches aggressively; a custom minimal SW is lighter
- **`perMessageDeflate: true`** on WebSocket — reduces bandwidth for large tool outputs
- **Single pi session** per server process — do not create one per browser tab
- **Avoid heavy Markdown renderers** — use a lightweight parser or a custom one
- **No `node-pty` / terminal emulator** — pi's bash tool handles shell needs
- **Tailwind purge** — ensure unused CSS is eliminated in production build
