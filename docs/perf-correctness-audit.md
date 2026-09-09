# Performance & Correctness Audit

_2026-09-09 · working tree at `e338056` + uncommitted refactor (stores/`session-view-cache`/`session-tail` deleted, `wire-limits.ts` added)._
_Six parallel scout audits (WS lifecycle, server load path, last-session state, client render, catalog/watcher, protocol) + orchestrator measurements on this machine (x64 Ryzen 7 7735HS, Bun 1.3.14). Numbers marked **measured** are reproducible; a Raspberry Pi is roughly 4–10× slower per core and per byte of I/O._

---

## 0. Verdict

| Reported symptom                         | Dominant cause                                                                                                                                                                           | Confidence                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| "Reconnecting happens often"             | **P0** — the pinned SDK (`@earendil-works/pi-coding-agent@0.85.0`) cannot be imported; every WS connect dies with `1011` and reconnects                                                  | **Proven** (live probe)           |
| "Session loads are slow"                 | **P1a** 79 % of every `session_loaded` payload is collapsed tool output; **P1b** SDK opens the whole `.jsonl` synchronously; **P1c** `marked.parse` goes superlinear on code-shaped text | **Measured**                      |
| "Doesn't keep track of the last session" | **P2** no server-side last-session pointer (`continueRecent(PI_CWD)` on boot) + client identity is only written from `session_loaded`, never from `connected`                            | **Proven** (restart probe + code) |

---

## 1. Measured evidence

```
SDK import (pinned 0.85.0)         → throws: Cannot find module '@earendil-works/pi-server'
WS connect, 0.85.0                 → open at 4 ms, CLOSE 1011 "Session initialisation failed" at 402 ms
WS connect, 0.85.1 (cold SDK)      → connected at 1543 ms (empty session)
WS connect, 0.85.1 (warm SDK)      → connected at 4 ms
switch_session → 527 KB/80-msg     → session_loaded after 310 ms (first), 33–43 ms (subsequent)
session_loaded payload             → 515.8 KB total: messages 503 KB
                                     └ toolResult 409 KB (79 %) · assistant 93 KB · user 0.7 KB
                                     └ fields: content 345 KB, details 138 KB
SessionManager.open (sync, blocking) → 6 ms/MB: 5 MB 23 ms · 20 MB 105 ms · 50 MB 258 ms · 100 MB 613 ms
client pipeline on that payload     → JSON.parse 2.5 ms · rawMessagesToUI 4.4 ms
                                     · markdown for rows the UI actually renders 209 ms
marked.parse on TS-source-like text → 2 KB 40 ms · 5 KB 223 ms · 20 KB 483 ms · 40 KB 3096 ms · 51 KB 3725 ms
server restart                      → connected reports a NEW session for PI_CWD, not the pre-restart live session
```

Reproduction artifacts were throwaway scripts (deleted): a `/ws` probe minting a JWT via `createSessionToken()`, an SDK `SessionManager.open` scaling benchmark, and a client-pipeline benchmark over a captured `session_loaded` frame.

---

## 2. P0 — the repo as committed cannot serve a single session

**Evidence**

- `package.json` pins `@earendil-works/pi-coding-agent: 0.85.0`; `node_modules/.../dist/experimental/server.js:10-11` statically imports `@earendil-works/pi-server` and `@earendil-works/pi-server/unix`, which **0.85.0 does not declare as a dependency** (registry metadata for 0.85.0 lists `pi-client`/`pi-protocol` but no `pi-server`).
- `server.ts:2153` (`_sdk = await import('@earendil-works/pi-coding-agent')`) therefore throws on the first WS connection. Server log: `Failed to initialise session for new client: Cannot find module '@earendil-works/pi-server'`.
- The client sees close `1011` (`server.ts:3504-3509`) and reconnects with 0.5→30 s backoff (`src/lib/client-messages.ts:397-401`), forever. Live probe: `[4ms] open … [402ms] CLOSE code=1011 reason=Session initialisation failed`.

**Mechanism** → the "frequent reconnect" symptom is not a keepalive/backpressure problem at all: it is an infinite connect→init-fail→close→reconnect loop.

**Fix** — `@earendil-works/pi-coding-agent@0.85.1` (current `latest`) removes `dist/experimental/` entirely and has no `pi-server` reference. Verified end-to-end here: with 0.85.1 installed, the same probe reaches `connected` in 1.54 s and `switch_session` works.

```bash
bun add @earendil-works/pi-coding-agent@0.85.1 @earendil-works/pi-tui@0.85.1
```

**Pinned version** — `package.json` now pins `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at `0.85.1`.

---

## 3. P1 — session-load latency

### P1a · 79 % of the load payload is tool output the UI keeps collapsed

- `session_loaded` for a 527 KB session = **515.8 KB on the wire**, of which **409 KB is `toolResult`** (`content` 345 KB + `details` 138 KB) vs 93 KB of assistant text.
- Tool rows render a one-line summary and only reveal output when `msg.expanded` (`src/lib/components/chat/message-row.svelte:596-679`), so this data is usually never displayed.
- The 512 KB `totalBudget` (`src/lib/server/wire-messages.ts` + `src/lib/wire-limits.ts:4-10`) is saturated by that tool output, so real conversation history gets truncated first.
- Cost per switch: 0.5 MB serialize + transfer + `JSON.parse` on the client, ×2 if two tabs are open (global broadcast, see P3a).

**Fix** — ship tool results lazily: keep `toolName`/`toolInput`/status/size in the load payload, fetch `content`/`details`/`renderedResultHtml` on expand (new `get_tool_output` request, mirroring `older_messages`). Expect ~5× smaller load payloads with no UI regression.

### P1b · SDK session open is a synchronous whole-file read on the event loop

- `server.ts:3742-3754` calls `SessionManager.open(resolvedPath)`; `session-manager.js:598-614` → `_setSessionFile` → `loadEntriesFromFile` (`session-manager.js:277-300`, `readSync` loop + `JSON.parse` per line) → `_buildIndex`. All synchronous, before `createSdkSession` and before any byte reaches the client.
- **measured** 6 ms/MB on x64 → ~613 ms for a 100 MB session here, plausibly 3–5 s on a Pi. `buildSessionContext()` is negligible (<2 ms).
- Deleting `src/lib/server/session-tail.ts` did not regress this (it never fed the SDK); `session-scan.ts` is a catalog scanner only. Bounded tails survived for the wire, never existed for SDK hydration.

**Fix** — nothing in this repo can bound the SDK read; the actionable parts are (a) keep the live session resident so switches are rare, (b) avoid re-opening the same path (a repeat switch to an already-live session should be a no-op — currently it re-opens: 43 ms for a 527 KB file), (c) upstream request for a lazy/indexed history API.

### P1c · `marked.parse` is superlinear on code-shaped text — multi-second main-thread freezes

- **measured** on a 51 KB TypeScript-source-like block (1147 lines, 766 four-space-indented, 843 `*`): 40 KB → **3.1 s**, 51 KB → **3.7 s**, versus 40 ms at 2 KB. Stripping fences or `$` changes nothing (it is not hljs and not the LaTeX extension — `src/lib/markdown.ts:179-205,524-583`); it is marked's own tokenizer.
- Reached from `message-row.svelte:465` (assistant content), `:410,419` (thinking), `:767` (notice/other roles) and at turn end (`+page.svelte:2456-2463`). The FNV-1a LRU (300/4M, `markdown.ts:546-575`) makes a repeat render 0.18 ms, but every cold load and every first render pays full price.
- **Correction to the scout report:** tool output is _not_ markdown-rendered (it goes through `renderedResultHtml`/`highlightCode`), so the honest per-load render cost for the sampled session is **209 ms**, not the 6 s an unfiltered benchmark suggested. The pathology still bites whenever an _assistant_ message or a _thinking_ block contains a large indented/asterisk-dense block, which is routine for a coding agent.

**Fix** — guard the renderer: for bodies over ~8–16 KB, or bodies whose indented-line ratio marks them as source dumps, render escaped `<pre>` (or chunk markdown per block) instead of a full `marked.parse`; render off the paint-blocking path (idle callback) and keep the memo cache.

### P1d · Cold catalog scan can land on the interactive path

- `switch_session` awaits `sessionCatalog.list()` before opening (`server.ts:3721-3740`); a cold `list()` runs `scanAllSessions` over every project dir (`src/lib/server/session-scan.ts:551-590`) with per-file line-by-line folding. Warm is stat-only (**measured** `get_all_sessions` = 2–14 ms for 59 files / 2.1 MB here), cold is O(all session bytes) — the Pi's store is the risk, not this one.
- **Fix** — warm the catalog once after startup off the WS path, and validate a switch target with the targeted `hasFile` lookup instead of awaiting the global list.

### P1e · Per-append watcher work during streaming

- `src/lib/server/session-watcher.ts:36-42`: 500 ms one-shot debounce (not reset by later events) → ~2 callbacks/second while a turn streams; a `null` `filename` also passes the `.jsonl` filter.
- Each callback invalidates the whole scan and schedules `all_sessions_list` + `projects_list` refreshes (`server.ts:3146-3175`). `all_sessions_list` is deduped by serialized JSON; **`projects_list` is not** — a full project array is re-derived and published every 300 ms window regardless of change.
- The live session's own file is excluded from parsing via the overlay/`skipPaths` (`session-catalog.ts:103-117`), but its watcher events still trigger the global invalidation.
- **Fix** — ignore watcher events whose path is the live overlay path, dedupe `projects_list` like the session list, and reset the debounce timer on each event.

### P1f · `perMessageDeflate: true` on every frame

`server.ts:5895` enables compression for all traffic, including per-token deltas. On ARM this is measurable CPU per frame with little benefit for small deltas. Consider disabling for the streaming topic or raising the compression threshold.

---

## 4. P2 — last-session tracking

### P2a · The server has no durable active-session pointer

- Boot: `ensureSession()` → `SessionManager.continueRecent(cwd)` (`server.ts:2694-2707`), `cwd = PI_CWD ?? process.cwd()` (`server.ts:209-212`). Nothing reads a saved id; `ui-settings.ts` stores only generic prefs and `project-registry.ts` stores `path`/`pinned`/`lastOpened` (project recency, not a session).
- **Proven**: after `switch_session` to a pi-ui-2 session followed by a restart, `connected` reported a brand-new session under `--tmp-piui-audit-cwd--`. The previously live session was forgotten, and because `continueRecent` is scoped to `PI_CWD` it cannot even return a session from another project.

### P2b · The client only persists identity from `session_loaded`

- `+page.svelte:2221-2222` writes `saveIdentity(...)` in the `session_loaded` branch; the `connected`-only branch (`:2201-2205`) sets the URL and snapshot but **never** calls `saveIdentity`.
- Consequence: a user who opens the app and never switches sessions has no durable pointer at all, so the next cold boot falls back to whatever `continueRecent` picks. `clearIdentity()` also fires whenever the active session is in-memory (`:2222`).
- **Fix** — save identity on any authoritative snapshot carrying a persisted `sessionPath` (both `connected` and `session_loaded`), and persist the pointer server-side (`ui-settings.ts` is the natural home) so restarts and second devices resume the same session; validate it on boot and fall back to `continueRecent`.

### P2c · Boot order shows the wrong session first

`bootResumePath = getSessionParam() ?? loadIdentity()?.path` (`+page.svelte:4632`) is resolved _after_ the first `connected` snapshot is applied wholesale (`applySessionState`, `:1982-2048`), so the UI renders the server's session (and a snapshot for a different path) before requesting the remembered one — a visible flash plus a second full load. A stale `?session=` in a reloaded tab also outranks the remembered session.

### P2d · Any tab's switch yanks every other tab

One process-wide live session (`server.ts:2226-2231`) + `broadcastSessionLoaded` publishing globally (`server.ts:3113-3116`, `5912-5917`) means tab B's switch changes tab A's content, and tab A then overwrites its own localStorage identity with B's path (`+page.svelte:2221`). Reads as "it lost my session".

---

## 5. P3 — correctness findings

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                  | Evidence                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| a   | `session_loaded` is deliberately exempted from the stale-`sessionId` guard and applied unconditionally, with no request/epoch correlation → a late snapshot for session A clobbers B (messages, identity, URL, running flag).                                                                                                                                                                            | `+page.svelte:2141-2155,2209-2243`; `server.ts:3113-3116`  |
| b   | Final assistant content is never reconciled. `message_update` is stripped to `{role}` (`server.ts:2759-2760`) and `message_end` carries the bounded full message (`:2761-2772`), but the client uses it only for usage/images/abort — never replacing `content`/`thinking`. `protocol.ts:379-385` documents the opposite. Markdown-transformer output and any final text not present in deltas are lost. | `+page.svelte:2415-2465`                                   |
| c   | Reconnect mid-tool loses the tool card: the snapshot carries only `streamingMessage` (`server.ts:203-206,3080-3092`), and `tool_execution_update/end` silently no-op without a prior `start` (`+page.svelte:2502-2520`). Upsert by `toolCallId` instead.                                                                                                                                                 | as cited                                                   |
| d   | `edit_message` truncates local history before the server accepts; the server rejects while streaming and `agent_error` never restores the pre-edit messages → client shows a rewind that never happened.                                                                                                                                                                                                 | `+page.svelte:3377-3389,2329-2344`; `server.ts:5564-5593`  |
| e   | Emitted-but-unhandled frames: `bash_execution_update` (`server.ts:4816-4823`), `extension_flag_result` (`:5407-5416`), `shutdown_requested` (`:2484-2486`) have no client case — shell progress and extension-flag results are silently dropped. `parseServerMessage`'s loose SDK fallback hides them.                                                                                                   | `src/lib/ws/server-message-schema.ts:742-812`              |
| f   | Schema-invalid frames are `console.warn`-and-drop with no resync, so a malformed high-value frame can leave a spinner or modal wedged until reconnect.                                                                                                                                                                                                                                                   | `+page.svelte:1737-1741`                                   |
| g   | New-chat watchdog: on success-with-lost-reply the 20 s watchdog restores the stashed old messages while the server is already bound to the new empty session.                                                                                                                                                                                                                                            | `projects-state.svelte.ts:377-391`; `+page.svelte:866-908` |
| h   | `applyMarkdownTransformersToMessages` and `customEntriesForWire` have no call site — extension markdown transforms and display-only custom entries never reach history payloads (dead code implying behaviour that does not happen).                                                                                                                                                                     | `src/lib/tui-stubs.ts:1364-1379,1442-1501`                 |
| i   | A blocking extension UI request waits 5 min before auto-cancel, during which the session looks hung.                                                                                                                                                                                                                                                                                                     | `server.ts:1030-1046,1421-1427`                            |
| j   | `connected` retry-without-history is only single-shot: if the fallback `sendConnected([], true)` throws, the outer catch closes with 1011 — contradicting the documented behaviour.                                                                                                                                                                                                                      | `server.ts:3405-3449,3504-3509`                            |

---

## 6. Ruled out (checked, not the cause)

- **Missing keepalive.** Bun's `sendPings` defaults to **true** (`node_modules/bun-types/serve.d.ts:496-501`), and the client adds a 25 s app-level ping with a 10 s pong deadline (`+page.svelte:1586-1610`; server pong `server.ts:5821-5825`). `idleTimeout: 120` (`server.ts:5893`) only bites when the OS suspends a backgrounded PWA socket. _Residual risk:_ any server event-loop stall >10 s trips the client's force-close — the measured stalls (≤0.6 s per 100 MB session parse on x64) stay below that unless the store is huge.
- **Duplicate `session_loaded` per switch.** The requester-specific copy only fires when `requestId` is set (`server.ts:3117-3123`) and the client never sends one (`projects-state.svelte.ts:436`); the live probe received exactly one frame per switch. _(Corrects two scout findings.)_
- **Service worker interception / stale shell.** Only exact precached assets are served; navigations and `/ws` bypass the SW (`src/service-worker/index.ts:52-57`).
- **Auth expiry / JWT churn.** Cookie and token are 30 days with a persisted signing key (`login/+page.server.ts:35-48`, `auth/password.ts:9-12,199-200`); established sockets close 4001 only on real expiry/revocation.
- **O(n²) per-token array copying on the client.** Deltas mutate the active message in place; the list is keyed by `msg.id` with a 400-row mount cap (`message-list.svelte:117-137,285-307`). The per-frame streaming preview is O(current length) per rendered frame, which is the remaining streaming cost, not an array-copy blowup.
- **Full re-read of the live session file per append.** Prevented by the in-memory overlay and `skipPaths` (`session-catalog.ts:103-117`; `server.ts:2898-2902`).
- **Watcher leaks / unbounded session maps.** One watcher owned by `getSDK()` and closed at shutdown (`server.ts:2174-2185,5929-5934`); `createdById`, scan-cache entries and UI buckets are pruned. Only the project registry grows until an explicit remove.

---

## 7. Recommended order

1. **P0** bump the SDK to 0.85.1 — without it nothing else is observable.
2. **P1a** lazy tool-output loading (biggest single load win, ~5× payload cut) + **P1c** markdown size/shape guard (removes multi-second freezes).
3. **P2a/P2b** durable last-session pointer (server settings + save identity on `connected`), then **P2c** boot ordering.
4. **P1d/P1e** keep cold scans and watcher fan-out off the interactive path; dedupe `projects_list`.
5. **P3a–P3d** snapshot epoch correlation, `message_end` reconciliation, tool-card upsert on reconnect, transactional edit.

---

## 8. Resolution status

| Finding | Fix landed                                                                                                                                                                                          | Measured before → after                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P0      | **Resolved** — `package.json` pins `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` at 0.85.1.                                                                                        | 0.85.0 import failed and WS closed 1011 at 402 ms → 0.85.1 connected cold at 1543 ms |
| P1a     | **Resolved** — `src/lib/wire-limits.ts`, `src/lib/server/wire-messages.ts`, `server.ts`, and client message rendering elide oversized tool output and fetch it through `get_tool_output`.           | `session_loaded` 515.8 KB → 126.7 KB for the measured 527 KB session                 |
| P1b     | **Mitigated** — `server.ts` keeps the live session resident and makes a switch to its existing path a no-op snapshot re-send; the SDK's synchronous whole-file open remains an upstream limitation. | Repeat switch 43 ms → 7 ms                                                           |
| P1c     | **Resolved** — `src/lib/markdown.ts` detects large source-dump-shaped bodies and renders escaped `<pre><code>` instead of invoking the slow tokenizer.                                              | —                                                                                    |
| P1d     | **Resolved** — `server.ts` warms both catalogs after `Bun.serve` and validates switch targets with `sessionCatalog.hasFile`.                                                                        | —                                                                                    |
| P1e     | **Resolved** — `src/lib/server/session-watcher.ts` uses trailing 500 ms debounce with a 5 s maximum coalescing window and ignores the live path; `server.ts` dedupes project broadcasts.            | —                                                                                    |
| P1f     | **Resolved** — `server.ts` disables `perMessageDeflate` for the WebSocket server.                                                                                                                   | —                                                                                    |
| P2a     | **Resolved** — `src/lib/server/ui-settings.ts` persists `lastSession`, and `server.ts` validates and resumes it before `SessionManager.continueRecent`.                                             | —                                                                                    |
| P2b     | **Resolved** — `server.ts` writes the durable pointer and `src/routes/(app)/+page.svelte` persists identity from both `connected` and `session_loaded`.                                             | —                                                                                    |
| P2c     | **Resolved** — `src/routes/(app)/+page.svelte` holds the first server snapshot while the remembered session resolves, with `src/app.d.ts` marking app-written session URLs.                         | —                                                                                    |
| P2d     | **Resolved** — `src/routes/(app)/+page.svelte` detects foreign switches, shows a notice, and does not overwrite this device's active identity.                                                      | —                                                                                    |
| P3a     | **Resolved** — `server.ts` stamps session operations and sends exactly one requester snapshot per stamped request; `+page.svelte` rejects stale or foreign snapshots.                               | —                                                                                    |
| P3b     | **Resolved** — `src/routes/(app)/+page.svelte` reconciles sealed assistant text and thinking from `message_end`.                                                                                    | —                                                                                    |
| P3c     | **Resolved** — `src/routes/(app)/+page.svelte` upserts tool cards by `toolCallId`, including reconnect-time updates and ends.                                                                       | —                                                                                    |
| P3d     | **Resolved** — `src/routes/(app)/+page.svelte` makes `edit_message` transactional, rolling back and resyncing on failure.                                                                           | —                                                                                    |
| P3e     | **Resolved** — `src/lib/ws/protocol.ts` and `server-message-schema.ts` define the three previously unhandled frame schemas, while `+page.svelte` handles them.                                      | —                                                                                    |
| P3f     | **Resolved** — `src/routes/(app)/+page.svelte` throttles invalid-frame notices and requests `resync_session`.                                                                                       | —                                                                                    |
| P3g     | **Resolved** — `src/lib/state/projects-state.svelte.ts` resyncs after a timed-out new-chat watchdog instead of restoring stale optimistic history.                                                  | —                                                                                    |
| P3h     | **Resolved** — `server.ts` applies extension markdown transformers and custom-entry helpers to bounded initial history.                                                                             | —                                                                                    |
| P3i     | **Resolved** — `server.ts` cancels orphaned extension UI requests after the 30 s grace period while retaining the 5-minute ceiling.                                                                 | —                                                                                    |
| P3j     | **Resolved** — `server.ts` keeps the history-less `connected` fallback from escalating a failed retry into a 1011 close.                                                                            | —                                                                                    |

## 9. Found while verifying the fixes

These were not in the original diagnosis; they surfaced when the production build and the Playwright
mock suite were exercised end-to-end, and are fixed alongside the audit findings.

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Fix                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | **Production HTTP was entirely broken**: the vendored adapter's post-build patch (`adapters/svelte-adapter-bun/dist/index.js`, function `X`) targets pre-3.x SvelteKit internals. Under the pinned `@sveltejs/kit@3.0.0-next.25` its regexes silently miss and it still injects `websocket() { return this.#options.hooks.websocket }` into `build/server/index.js` against an undeclared private field — a module-level `SyntaxError`, so every request (including `/login`) returned 500. | The patch now declares a module-level `__sk_websocket_hook`, fills it after `get_hooks()`, and returns it from the injected accessor. Verified: `/` → 302 `/login`, `/login` → 200. |
| V2  | **`parseServerMessage` rejected valid snapshots**: nested payload schemas (notably `ExtensionUiStatePayloadSchema`, plus model/stats/component/extension-error sub-objects) required decorative fields, so a `connected` frame missing one ornament was dropped whole — and after P3f that produced a visible notice plus a `resync_session` loop.                                                                                                                                          | Decorative/derived nested fields are optional (types retained); only `type`/`kind` discriminators and correlation identifiers stay required.                                        |
| V3  | **Duplicate thinking-level logic**: `+page.svelte` carried a stale copy of the rung derivation that disagreed with `src/lib/thinking-levels.ts`, so rungs did not follow the selected model's `thinkingLevelMap`.                                                                                                                                                                                                                                                                           | The page now uses `getSupportedThinkingLevels`/`clampThinkingLevelForModel` and clamps the incoming level on snapshot apply; the duplicate is gone.                                 |
| V4  | **Notification deep links died with the socket**: a session deep link clicked while the WebSocket was down was dropped instead of applied after reconnect.                                                                                                                                                                                                                                                                                                                                  | Single-slot pending intent (latest wins) flushed after the `connected` handshake and cleared once applied.                                                                          |

Suite state after the work: `bun run check`, `check:server`, `check:sw`, `lint` clean; `bun run test:unit`
443 tests passing; mock Playwright suite 136 passed / 8 skipped / **2 failed** — both remaining failures
(`e2e/session-orbs.spec.ts:67` and `:178`) pin the background-session orbs that the uncommitted
`projects-sidebar.svelte` refactor deliberately removed (`anyRunning`/`anyUnchecked`,
`runningSessions`/`uncheckedSessions`, the "Background session running" labels), so those specs belong
to that refactor, not to this remediation.
