# Parallel Sessions + Live Sidebar Status — Design

_2026-09-10 · design of record. Five parallel read-only audits (server singleton map, SDK safety, client view model, liveness protocol, resource budget) plus RSS measurements taken on this machine (x64, Bun 1.3.14, `--smol`). Numbers marked **measured** are reproducible; `[INFERENCE]` marks reasoning._

---

## 1. Problem

Before Phases A–C, `server.ts` used a process-wide `live` binding for its in-memory `AgentSession` (`server.ts:2361-2367`). `setActiveSession` disposed any differing target (`server.ts:3412`), and the SDK's `AgentSession.dispose()` hard-aborted the turn — `abortRetry()`, `abortCompaction()`, `abortBranchSummary()`, `abortBash()`, `agent.abort()` (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:584-599`).

Before the resident-set implementation, the consequences were:

- Switching sessions — from **any** tab, because the live session was process-wide — killed whatever was generating.
- Non-live sessions had no in-memory state at all, so the sidebar could not show what was running; the orb model that used to fake it client-side was removed in `e05c8fa`.
- The runtime frame the sidebar needed was emitted only for the process-wide `live` runtime (`server.ts:3709-3710`), and the browser dropped runtime frames whose `sessionId` was not the visible session (`src/routes/(app)/+page.svelte:3537-3552`).

Goal: **N resident sessions, one visible**, with per-session running/idle/attention state streamed to the sidebar, on a Raspberry Pi.

---

## 2. Is it even safe? (SDK verdict)

Yes, with strict isolation. The SDK has **no "current session" binding** — `createAgentSession` builds independent `Agent` + `SessionManager` + `ExtensionRunner` + `ResourceLoader` graphs (`core/sdk.js:66-83`, `core/agent-session.js:100-161`).

| Concern                                                                      | Verdict                                                                                                                                                                                     | Evidence                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `AgentSession` / `Agent` / abort controllers / tool registries               | **per-session, safe**                                                                                                                                                                       | `agent-session.js:70-161`                                                              |
| `ExtensionRunner` + extension runtime                                        | **never share** — `invalidate()` exists precisely because a captured ctx must not outlive its session                                                                                       | `agent-session.js:595`, `extensions/runner.js:396-404`, `extensions/loader.js:132-196` |
| `createAgentSessionServices` (ModelRuntime, SettingsManager, ResourceLoader) | **per-session** — ModelRuntime holds mutable provider/model/auth maps; sharing means provider registration and credential mutations cross sessions                                          | `agent-session-services.js:53-106`, `model-runtime.js:40-70`                           |
| Extension **factory cache**                                                  | process-global but keyed by cwd + generation; **switching cwd clears it**, so residents in different projects thrash it and pay re-import                                                   | `extensions/loader.js:114-129,405-434`                                                 |
| Theme                                                                        | **true process global** via `globalThis[THEME_KEY]`                                                                                                                                         | `modes/interactive/theme/theme.js:539-550`                                             |
| Session `.jsonl` writes                                                      | **BLOCKER if shared**: bare `appendFileSync` / `openSync('w')`, **no** `proper-lockfile` (it guards only `auth.json`) — two managers on one file interleave appends and truncate each other | `session-manager.js:708-767`, `auth-storage.js:33-65`                                  |
| Auth file                                                                    | locked, shared read cache keyed by path — safe, serialize writes                                                                                                                            | `auth-storage.js:16,270-276`                                                           |
| stdout/TTY takeover (`output-guard`)                                         | single-owner only; server path does not use it                                                                                                                                              | `core/output-guard.js:1-63`                                                            |
| `process.on` / `chdir` / stdin in SDK core                                   | none found                                                                                                                                                                                  | —                                                                                      |

**Hard rules that fall out:** one resident session per `.jsonl` path (the resident map is the enforcement point); per-session services and extension runner; exactly one global theme; `dispose()` is _not_ an eviction primitive for a running session — it aborts.

Also note: `createSdkSession` currently _reuses_ the previous session's ModelRuntime (`modelRuntime: source?.modelRuntime`, `server.ts:~2563`). That is fine when sessions are sequential; with concurrent residents it becomes cross-session mutation. Give each resident its own, or make sharing explicit and read-only.

---

## 3. What does residency cost? (measured)

Throwaway benchmark, `bun --smol`, real session files, four full `AgentSession`s (own services each) held simultaneously:

```
process start                             RSS  35.7 MB
SDK imported (module graph)               RSS 156.3 MB     ← dominates everything
+ full session 1 (0.50 MB jsonl, 82 msgs) RSS 164.3 MB     services 77 ms, session 5 ms
+ full session 2 (0.43 MB jsonl, 50 msgs) RSS 166.8 MB     services 12 ms, session 1 ms
+ full session 3 (0.37 MB jsonl, 82 msgs) RSS 166.9 MB     services 17 ms, session 1 ms
+ full session 4 (0.25 MB jsonl, 21 msgs) RSS 169.0 MB     services  8 ms, session 1 ms
```

SessionManager-only variant (5 sessions, 1.76 MB of jsonl): RSS 69.8 → 82.0 MB, i.e. **≈ 6.9× the jsonl bytes**, consistent with parsed-object overhead.

Read that carefully:

- **The SDK import (~120 MB) is the cost, not the sessions.** A second, third, fourth resident session on typical histories costs **1–2.5 MB each** — cheaper than the 126 KB wire payload cycle it replaces.
- Per-session RSS scales with **history bytes**, not session count, and history is retained **twice**: `SessionManager.fileEntries` (whole parsed file) plus the restored `agent.state.messages` from `buildSessionContext()` (`session-manager.js:621-684,980-982`; `sdk.js:80-82,236-244`). Budget **≈ 4–7× file bytes** [INFERENCE from the 6.9× SessionManager measurement].
- The audit's tool-output elision does **not** help here: `boundMessagesForWire` is copy-on-write and only shrinks the wire (`src/lib/server/wire-messages.ts:40-84`).
- That benchmark used the e2e agent dir (fake model, minimal extensions), so 1–2.5 MB per resident is the **floor**. Re-measured against the real `~/.pi/agent` dir (Phase C follow-up): process 35.8 MB → 154.4 MB after the SDK import → **222.8 MB** after the first full session (the +68 MB is the one-time extension load), then **+2.7 MB** for a second session in the _same_ cwd but **+22.8 MB** and **+10 MB** for two sessions in _different_ cwds. That spread is the SDK's process-global extension factory cache being cleared on every cwd change (`extensions/loader.js:114-129`) and re-importing — direct empirical support for the cwd-clustering eviction tie-break in Phase C. Budget accordingly: ~3 MB per additional same-project resident, 10–25 MB per additional cross-project resident, on top of the history bytes.

**Therefore: cap residency by history bytes, not by session count.**

| Pi RAM | SDK + handler + Bun | History budget                      | Practical residents          |
| ------ | ------------------- | ----------------------------------- | ---------------------------- |
| 2 GB   | ~190 MB             | 48 MB parsed (≈ 8–12 MB of jsonl)   | 3 (visible + 2)              |
| 4 GB   | ~190 MB             | 128 MB parsed (≈ 20–30 MB of jsonl) | 6                            |
| 8 GB   | ~190 MB             | 320 MB parsed                       | 10 (cap for sanity, not RAM) |

Local store for calibration: 59 sessions, 2.1 MB total, p50 ≈ 3 KB, max 517 KB — i.e. _typical_ histories are trivial and the cap only ever bites on pathological multi-hundred-MB sessions, which are exactly the ones that must not be pinned.

---

## 4. Architecture

### 4.1 Server: resident map + selection + residency policy

Replace the singleton with three concepts that are currently conflated in one binding:

```ts
const resident = new Map<string, ManagedSession>();   // sessionId → entry
let selectedSessionId: string | null;                 // what "the session" means for un-targeted requests
// per client:
type WSData = { …; focusedSessionId?: string };       // what THIS socket is looking at
```

`ManagedSession` holds everything per-session (`server.ts`: `session`, forwarding/runtime subscriptions, `cwd`, `path`, estimated `historyBytes`, `isRunning`, tool state, `lastActivity`, runtime timer/status, diagnostics, host binding state, `firstMessage`, `lastTurnError`, `unread`, shutdown state, fallback message, and `sessionName`); entries now live in the `resident` map rather than a singleton container. The pre-refactor direct `live` reads (`server.ts:2314, 2364, 2367, 2373, 2401, 2462, 2467, 2620, 2738, 2758, 2847, 2950, 3146, 3238, 3412, 3414, 3427, 3710, 3988, 6201`) split into three intents:

1. **"the session this request targets"** — resolve via `managedSessionFor(sid)`; ~60 handlers currently call `activeSession()` with no target (`server.ts:3764…6012`).
2. **"the session the UI is looking at"** — `selectedSessionId` / `ws.data.focusedSessionId` (durable pointer, boot resume, URL sync).
3. **"any resident session"** — iterate the map (shutdown `:6201-6208`; event forwarding and runtime, which are _accidentally_ active-only today).

**Residency policy** (the part that makes this Pi-safe):

- Admission: opening a path already resident returns the existing entry (the P1b no-op switch generalises to this) — this is also what enforces the SDK's one-owner-per-file rule.
- Pinning: `isRunning`, an active tool, a pending extension dialog, or `phase === 'awaiting-input'` pins an entry. **Never evict a pinned entry** — eviction is `dispose()`, which aborts.
- Eviction: when residents exceed `MAX_RESIDENT_SESSIONS` or the parsed-history budget, dispose the least-recently-active _unpinned_, non-selected entry. Re-hydration is cheap and already measured: ~6 ms/MB parse + 8–17 ms services.
- Run concurrency is a **separate** cap from residency: `MAX_CONCURRENT_RUNS` (2 on a Pi) — a prompt to a session beyond the cap queues rather than starting a third LLM turn plus tool sandbox. Residency ≫ concurrency.
- The landed policy defaults to `PI_UI_MAX_RESIDENT_SESSIONS=4`, `PI_UI_MAX_RESIDENT_HISTORY_MB=48`, and `PI_UI_MAX_CONCURRENT_RUNS=2` (each integer is clamped to a safe range). Estimated parsed-history cost is the `.jsonl` `stat` size multiplied by 5, and residency evicts on either the count or 48 MiB estimated-history cap. When choosing an unpinned eviction candidate, the implementation prefers a project outlier before least-recently-active LRU to reduce extension-cache churn.

**Locking:** Per-session mutation queues serialize prompt, steer, follow-up, abort, edit, compact, model, thinking-level, and tool operations. A global lock remains for new/switch/fork/delete/rename/project-delete and other catalog-structural work; shared provider-credential mutations also remain globally serialized, so independent resident sessions do not block one another for session work.

**Catalog / watcher:** The overlay remains a `Map<id, SessionFileInfo>` and `skipPaths` remains a `Set` (`src/lib/server/session-catalog.ts:19-148`). The watcher now ignores every resident path rather than one live path, and release drops the overlay entry for the specific session id.

**Event forwarding:** Every resident session forwards events with its `sessionId`; the forwarding/runtime/host-binding paths no longer gate on a singleton `live` entry. The `connectedClients === 0` guard remains (it suppresses sending, not running).

### 4.2 Protocol: extend `session_runtime`, don't invent a parallel list

Inventory (`SessionSummary`, `session_updated`, `all_sessions_list`) stays metadata-only; liveness stays a keyed projection. The existing frame already carries `sessionId`, so extend it rather than adding a second source of truth:

```ts
export type SessionPhase = 'idle' | 'running' | 'awaiting-input' | 'error';

| {
    type: 'session_runtime';
    sessionId: string;
    phase: SessionPhase;
    isRunning: boolean;          // retained during migration; derivable from phase
    activeToolName?: string;     // omitted when none
    lastActivity: number;
    unread: boolean;             // run finished while no client had this session focused
    needsAttention: boolean;     // awaiting-input | error
    resident: boolean;           // false ⇒ status is disk-derived, not live
  }
```

New client frame so the server can define "visible":

```ts
| { type: 'session_focus'; sessionId: string | null }   // sent on switch and on visibility change
```

Rules:

- Emit **one delta per session, only when the serialized status changed**, with the existing 300 ms per-entry debounce → ≤ 3.3 frames/s per continuously-eventful session; 3 running sessions ≤ 10 frames/s. If that proves noisy, batch into `session_runtime_batch` — but only then; a new frame is extra schema/client surface.
- On connect, send a status snapshot for **every** resident session after the selected session's `connected` snapshot (`server.ts` open path).
- `unread` lives **in the resident entry (ephemeral)**, set when a run ends while no socket has that sid focused, cleared on `session_focus` (not merely on socket connect). Do **not** put it in `ui-settings.ts` — that file is durable user preference, not transient run state.
- The old untyped `unseen: false` field is no longer emitted; `session_runtime` uses the protocol/schema fields above.
- Non-resident sessions simply have no runtime frame; the sidebar renders them idle from disk metadata.

### 4.3 Sidebar visuals → wire fields

The pre-refactor orb model (`HEAD~1:src/lib/components/projects/projects-sidebar.svelte:155-162,221-230,297-303`) had the right visual grammar but faked its state client-side from the one stream it could see. Same visuals, now driven by real per-session status:

| Visual                     | Source                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Tool spinner on a row      | `activeToolName` present                                                                                    |
| Green pulsing dot on a row | `phase === 'running'`                                                                                       |
| Primary dot on a row       | `unread === true`                                                                                           |
| Amber/attention badge      | `needsAttention` (`awaiting-input`, `error`)                                                                |
| Idle dot / branch icon     | `phase === 'idle'`, no flags                                                                                |
| Project-level rollup       | any child row running → green; else any unread → primary (old `anyRunning`/`anyUnchecked` logic, unchanged) |

### 4.4 Client: one visible view + N status rows

Today every piece of chat state is a page singleton: `messages`, `activeStreamMsg`, `toolMessagesById`, expanded/truncated maps, queues, context usage, extension UI, composer draft (`src/routes/(app)/+page.svelte:564-584,806-846,970-975`), and `extensionUiState` is a singleton reset on switch (`src/lib/state/extension-ui-state.svelte.ts:34-78`). Minimal model:

```ts
type SessionView = {
  // bounded: keep ~3, LRU-evict, rehydrate from server
  messages: UIMessage[];
  activeStreamMsg: UIMessage | null;
  toolsById: Map<string, UIMessage>;
  expandedUserMsgs: Set<string>;
  truncatedUserMsgs: Set<string>;
  draft: string; // no attachments in background views (base64!)
  contextUsage;
  queuedSteering;
  queuedFollowUp;
  scrollAtBottom: boolean;
};
const views = new Map<string, SessionView>(); // visible one is bound to the chat components
const status = new Map<string, RuntimeStatus>(); // cheap, every resident session, drives the sidebar
```

Three concrete client changes beyond that:

1. Frame routing now uses `sessionId`: status/runtime frames are always accepted; message/tool frames are applied to the cached view for that sid and rendered only when it is visible. Snapshot frames (`connected`/`session_loaded`) retain their request correlation.
2. `session_runtime` handling now writes each resident status into the client state unconditionally and only updates page streaming state for the visible session.
3. `SessionViewCache` is implemented as a bounded LRU of three views; it clones inactive views while stripping base64 image data and attachments, and evicted sessions are rebuilt from the server on the next switch.

Stay global: project list, panel layout, filters, notification prefs, theme, device settings.

**Attention path**: a run finishing in a non-visible session reaches the user through the existing push/SW route (`+page.svelte`), plus `updateAppBadge`, which now sets the PWA badge to `ProjectsState.unreadCount` and clears it when that count reaches zero.

---

## 5. What I would explicitly not do

- **Do not resurrect `session-tail.ts` as a memory fix.** It reverse-reads the last N entries for the _wire_ (`HEAD~1:src/lib/server/session-tail.ts:8-45`); it never fed SDK hydration and cannot, because `SessionManager.open`'s only injection point is `preloadedFileEntries`, an all-entries parameter (`session-manager.js:1216-1237`). Bounded-tail hydration needs an upstream SDK API; ask for it, don't fake it.
- **Do not share one services/ModelRuntime object across residents** to save memory — measured savings are ~1 MB, the cost is provider/credential crosstalk (`model-runtime.js:40-70`).
- **Do not open the same `.jsonl` twice**, ever. No file locking exists (`session-manager.js:708-767`).
- **Do not use `dispose()` as a "park this session" primitive** — it aborts. Parking = keep resident and idle.
- **Do not add liveness fields to `SessionSummary`/`session_updated`.** Full-list broadcasts are already flagged as waste; liveness is a delta stream.
- **Do not let residency imply concurrency.** N resident sessions on a Pi is fine; N concurrent LLM turns with tool sandboxes is not.

---

## 6. Phasing

**Phase A — stop killing runs (smallest useful slice).**
`resident` map with `MAX_RESIDENT_SESSIONS = 2` (visible + one background), running-pinned, LRU eviction; drop the forwarding/runtime `live` gates; per-session runtime deltas with `phase`; connect-time status snapshot for all residents; client `status` map; sidebar orbs restored from real data; `session-orbs.spec.ts` (currently red, pinning the deleted orbs) becomes the acceptance test. Handlers keep defaulting to the selected session — only `prompt`, `abort`, `steer`, `follow_up`, `get_tool_output` need explicit `sessionId` in this phase.

**Phase B — real targeting and attention.**
`sessionId` on every session-scoped client message with `focusedSessionId` fallback; the ~60 `activeSession()` call sites resolved by target; per-session mutation locks; `session_focus` + `unread`/`needsAttention`; per-session client `views` with LRU; push/badge for background completion.

**Phase C — policy and hardening.**
History-byte budget with eviction (not just a count), `MAX_CONCURRENT_RUNS` with queueing, extension-cache cwd-thrash mitigation (prefer residents grouped by project, or accept re-import and measure), re-measure per-session RSS with a real extension set, and revisit the upstream ask for lazy/bounded history hydration.

Each phase is independently shippable and independently revertible; Phase A alone removes the reported "switching sessions kills my run" behaviour.

## 7. Implementation status

All three phases are implemented as of 2026-09-10:

- **Phase A — landed:** the server uses a resident session map with running-pinned, least-recently-active eviction; all residents forward stamped events; runtime deltas and connect-time snapshots drive the sidebar's real session orbs. The initial two-resident count cap was subsequently hardened by Phase C.
- **Phase B — landed:** session-scoped messages accept explicit `sessionId` targeting with focused-session and selected-session fallback; per-session mutation queues, `session_focus`, `unread`/`needsAttention`, the bounded three-view client LRU (with base64 stripped from inactive views), and background completion notifications are in place.
- **Phase C — landed:** residency enforces both count and estimated-history-byte caps with `PI_UI_MAX_RESIDENT_SESSIONS` (default 4), `PI_UI_MAX_RESIDENT_HISTORY_MB` (default 48 MiB), and a five-times-`.jsonl` size estimate; eviction prefers project outliers before LRU ties. `PI_UI_MAX_CONCURRENT_RUNS` (default 2) is independent of residency, and prompt/steer/follow-up work beyond the run cap queues FIFO and is surfaced through the existing queue state.

The measured evidence in §3 remains the basis for those defaults: SDK import reached 156.3 MB RSS from a 35.7 MB process baseline; four full residents reached 169.0 MB, with the second through fourth adding roughly 1–2.5 MB each; and the SessionManager-only measurement was approximately 6.9× `.jsonl` bytes. The local store sample was 59 sessions and 2.1 MB total, with p50 history around 3 KB and a 517 KB maximum.

Live verification also confirms the end-to-end behavior: a run in session A survives switching to session B with `stopReason: 'stop'` (not `'aborted'`); both sessions stream in parallel; each emits runtime deltas with `resident: true`; and completion sets `unread` on the unfocused session.
