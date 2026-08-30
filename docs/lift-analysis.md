# Lift Analysis: OpenClaw / Hermes → pi-ui

_2026-08-25 · research report · sources verified against live repos/docs on this date_

---

## 1. What the projects are

|                    | OpenClaw                                                                                                                                                                                                                                                      | Hermes Agent                                                                                                                                                                                                     | hermes-webui                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| What               | Personal AI assistant gateway (ex-Clawdbot/Moltbot, by Peter Steinberger / OpenClaw Foundation). One Gateway process bridging models, tools, messaging channels (WhatsApp/Telegram/Discord/Slack/Signal/iMessage…), companion apps, and a browser Control UI. | Nous Research's self-improving autonomous agent. Terminal-first, messaging gateway (10+ platforms), persistent memory, self-written skills, cron, 7 terminal backends (local/Docker/SSH/Modal/Daytona…). Python. | Community web UI for Hermes (17.7k★). Three-panel layout, **Python backend + vanilla JS, no framework** — full CLI parity from the browser. |
| Repo               | `openclaw/openclaw` (TypeScript, pnpm workspace, MIT)                                                                                                                                                                                                         | `NousResearch/hermes-agent` (Python, MIT)                                                                                                                                                                        | `nesquena/hermes-webui` (Python, MIT)                                                                                                       |
| Relevance to pi-ui | Closest architectural cousin: a self-hosted server bridging an agent to clients over **one WebSocket** — same shape as `server.ts`. Its README thanks Mario Zechner for pi.                                                                                   | Feature roadmap for the _agent-side_ capabilities pi-ui could surface. Ships `hermes claw migrate` from OpenClaw — the two define the current feature frontier of this category.                                 | The most directly comparable _web frontend_: browser/phone access to a self-hosted agent, like pi-ui.                                       |

Licenses are all MIT — anything can be lifted legally.

---

## 2. Image analysis (what their UIs actually look like)

Seven screenshots pulled from the repos and a CODE Magazine walkthrough (saved under `/tmp/lift-imgs/`).

### hermes-webui (most relevant comparison — a web chat UI like ours)

**Light mode (`hw-light.png`, repo README)** — three panels: icon rail + session list, chat, workspace file browser.

- Session list: filter box, **profile chips (All/Test/Foo/Bar/Baz)**, PINNED section, time grouping (THIS WEEK / LAST WEEK).
- Chat: per-message **token usage line ("585.3k in · 1.5k out")**, timestamps, copy button, message-count badge in header.
- Right panel: file tree with **file sizes**, **git branch chip (MAIN) with refresh**, inline image previews.
- Composer footer (always visible): attach, mic, **profile picker, workspace dir picker, model picker, circular context-usage ring**, send.

**Dark mode (`hw-main.png`)** — the richest shot:

- Sidebar: **source chips "WebUI sessions (88) / CLI sessions (6)"** — merges CLI history into the same list; "Show 26 from other profiles", "Show 5 archived"; **channel badges (DISCORD)** on sessions; status dots for running sessions.
- Chat: collapsible **"Thinking" block with branch button**, inline generated image, **"Done in 1m 6s"** timing, **streaming speed "66.7 t/s"**, **"Trace — Expand all / Collapse all"** for tool calls, scroll-to-bottom FAB.
- Right panel tabs: **Files / Artifacts (0) / Todos**.
- Composer: model + **effort/reasoning level (High)** selectors, context ring.

**Settings modal (`hw-settings.png`)**: default model/workspace, send key (Enter vs Shift+Enter), theme picker (Solarized Dark etc.), **"Show token usage after responses" toggle**, **"Show CLI sessions in sidebar"** (imports CLI sessions from state.db to continue in web), **usage sync to `/insights`**, access password. Sidebar footer: **↓ Transcript / { } JSON / ↑ Import** buttons.

### OpenClaw

**TUI chat (`cm-11.png`, `cm-12.png`, `cm-14.png` — CODE Magazine walkthrough)**:

- Persistent status footer: `connected | idle · agent main | session main (openclaw-tui) | ollama/kimi-k2.5:cloud | tokens 43k/262k (16%)` — connection + agent/session + model + **context window with percentage** in one line.
- Full markdown tables rendered in-terminal.
- **Cron created by conversation**: user asks in prose → agent confirms plan → asks approval → reports "✅ Job created — cron `0 8 * * *` in `America/Los_Angeles`, runs in an isolated sub-agent, posts results back into this chat."

**Ecosystem (`oc-agents-ui.jpg`, showcase)**: a third-party skills-manager app syncing skills across Agents/Claude/Codex/Clawdbot with per-target toggles and frontmatter editing — evidence the **agentskills.io skill format** is becoming a portable standard.

**Control UI** (no official screenshots published; documented in `docs.openclaw.ai/web/control-ui`): session rail with live "headline" digest generated by a cheap utility model; `/btw` side-chat companion that answers questions about a _running_ session without interrupting it; device pairing (QR for mobile apps); environment identity stripes; 21 locales; tweakcn theme import; Plugins hub (Installed/Discover/Skills/Workshop, backed by ClawHub); new-session page with **Place picker (project/folder/worktree/cloud node)** and browser-side draft recovery; Gateway host status card (CPU/mem/uptime); "Ask OpenClaw" repair agent with hosted setup wizards.

---

## 3. Feature matrix vs pi-ui (verified against this codebase)

✅ present · 🟡 partial · ❌ absent. pi-ui column grounded in: `AGENTS.md`, component inventory, `client-messages.ts`, `projects-sidebar.svelte`, `message-list.svelte`, `app.css`, `+page.svelte`.

| Feature                                                                    | pi-ui                                                      | OpenClaw                                                              | hermes-webui                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| WS chat streaming + tool traces + thinking blocks                          | ✅                                                         | ✅                                                                    | ✅                                                |
| Message edit/rewind + fork + session tree                                  | ✅ (`edit_message`, `fork-dialog`, `session-tree-modal`)   | ✅ (Fork in row menu)                                                 | 🟡 (branch button)                                |
| Per-message tokens + cost + duration                                       | ✅ (`message-list.svelte:870-882`)                         | ✅ (footer aggregate)                                                 | ✅ (per-message in/out)                           |
| Session list: rename/fork/delete, pin projects, running dots, title filter | ✅ (`projects-sidebar.svelte`)                             | ✅✅ (+unread, archive, groups, drag-pin, multi-select, draft badges) | ✅ (+profiles, source chips, archived toggle)     |
| Session **content** search                                                 | ❌                                                         | ✅ (command-palette search)                                           | ✅ (Hermes FTS5 + LLM summarize)                  |
| Aggregate usage dashboard                                                  | ❌                                                         | ✅ (Usage page, per-agent)                                            | ✅ (`/insights`, usage sync)                      |
| Context-window ring/% near composer                                        | ❌                                                         | ✅ (footer `43k/262k (16%)`)                                          | ✅ (context ring)                                 |
| Cron / scheduled automations                                               | ❌                                                         | ✅ (Automations page + conversational creation)                       | ✅ (cron + delivery to any platform)              |
| Persistent memory / persona profiles                                       | ❌                                                         | ✅ (MEMORY.md, SOUL.md)                                               | ✅ (profile chips, MEMORY/USER.md, personalities) |
| Workspace file browser panel                                               | 🟡 (`file-viewer-modal` + read/write tools; no tree panel) | 🟡                                                                    | ✅ (tree + sizes + previews + git branch)         |
| Transcript export (Markdown/JSON/HTML)                                     | ❌                                                         | ✅                                                                    | ✅ (↓ Transcript / JSON / ↑ Import)               |
| Unread/attention states in session list                                    | ❌                                                         | ✅ (unread dots, attention chips, queued hourglass, draft pencil)     | 🟡 (status dots)                                  |
| Worktree-per-session launcher                                              | ❌                                                         | ✅ (worktree picker, `openclaw/<name>`)                               | 🟡 (`api/worktrees.py`)                           |
| In-browser terminal                                                        | ❌                                                         | 🟡 ("Start in terminal")                                              | ✅ (`api/terminal.py`)                            |
| Side-chat about a running session                                          | ❌                                                         | ✅ (`/btw` companion rail)                                            | ❌                                                |
| Messaging channels (Telegram/Discord/…)                                    | ❌                                                         | ✅ (15+)                                                              | ✅ (10+)                                          |
| Themes                                                                     | ✅ (daisyUI: pi, night, … `app.css:177`)                   | ✅ (3 built-ins + tweakcn import)                                     | ✅ (multi-theme incl. light)                      |
| i18n                                                                       | ❌                                                         | ✅ (21 locales)                                                       | ❌                                                |
| PWA + push notifications + cold-start resume                               | ✅ (SW, `session-snapshot.ts`)                             | 🟡 (companion apps instead)                                           | ❌                                                |
| STT voice input                                                            | ✅ (`+page.svelte` `isRecording`)                          | 🟡                                                                    | ✅ (voice memos)                                  |
| Auth                                                                       | ✅ (password + JWT + rate limit)                           | ✅ (token/password + **device pairing + QR**)                         | ✅ (password, OIDC, **passkeys**)                 |
| Self-hosted update flow                                                    | ✅ (`bin/pifrontier.ts`)                                   | ✅                                                                    | ✅                                                |

---

## 4. Lift candidates, ranked

### Tier 1 — high value, clean fit, no new server subsystems

1. **Context-window ring / percentage near the composer.** pi already reports usage per message (`client-messages.ts:204`); we just never aggregate it. Show `used/context` for the active session (last-turn sum + compaction state) as a ring or footer chip, like OpenClaw's `43k/262k (16%)`. Pure frontend + possibly one `connected`/`session_loaded` field for window size. _Effort: S._
2. **Transcript export** (Markdown + JSON). All data is already client-side in `chat.messages`. Mirror hermes-webui's `↓ Transcript / { } JSON` pair in the chat header. _Effort: S._
3. **Session content search.** We already stream-scan session JSONL line-by-line (`session-scan.ts`) with a persisted (mtime,size) cache — exactly the substrate for a cheap full-text index. Add a `search_sessions` client message (grep over cache, bounded results like the `wire-messages.ts` caps) and a search palette in the UI. Hermes's FTS5+LLM-summarize is the deluxe version; title+content grep is the 80% version. _Effort: M._
4. **Unread/attention states in the session list.** OpenClaw's unread dot + "needs input" chip is the biggest UX gap vs. our list. We already track `runningSessions`; extend the catalog overlay with `lastReadAt` (localStorage or server setting) + `needsInput` (we already compute "unseen results" for `scheduleNavOutDisposal`, and the SW notification path knows when a turn ends hidden). _Effort: M._
5. **Aggregate usage page.** Sum per-message usage from the session scan (tokens in/out + cost by model/day). Hermes `/insights` and OpenClaw's Usage page prove demand; our scan cache makes it nearly free. _Effort: M._

### Tier 2 — differentiating, moderate build

6. **Cron / scheduled automations.** The flagship gap. OpenClaw makes creation conversational ("create an 8 AM job…" → approval → cron); Hermes delivers results to any channel. For pi-ui: a server-side scheduler (Bun, no new deps) that runs a **headless pi session per job** and broadcasts results as a notification + session entry; UI page listing jobs (name, schedule, last run, enable toggle). Start with cron-expression + one-shot-prompt jobs. Watch memory: RPi target means jobs must reuse the LRU session pool, not pin sessions. _Effort: L._
7. **Workspace file-browser panel.** Promote `file-viewer-modal` into a right-panel tab: tree with sizes, inline preview (read_file path + workspace guard already exist), git branch chip (cheap `git rev-parse` per project cwd, cached). Hermes's Files/Artifacts/Todos tabs are a good layout template. _Effort: M._
8. **Profiles/personas per session.** Hermes's profile chips (persona + model preset per session) slot naturally into our composer footer next to the model picker; pi supports system prompts per session. _Effort: M (depends on pi SDK surface)._
9. **Worktree launcher for new sessions.** OpenClaw's new-session "Place" picker (project → optional worktree `openclaw/<name>`) is best-in-class for parallel coding tasks. Our project picker + `fork_session` give half the plumbing. _Effort: M._
10. **Composer draft recovery.** OpenClaw persists unsent drafts + staged attachments per browser (IndexedDB, 20 drafts / 7 days). We already have the cold-start snapshot pattern in localStorage; drafts are the same trick. _Effort: S._

### Tier 3 — strategic / larger bets

11. **Messaging-channel gateway** (Telegram at minimum). The core competency of both upstream projects and the main reason people run them. For pi-ui: a channel plugin that relays session events to a chat and relays replies as `prompt`/`steer`. Needs a "no-UI client" mode alongside `server.publish` fan-out and the extension-UI blocking model. Big, but it turns pi-ui from "web frontend" into "reach your Pi from anywhere". _Effort: XL._
12. **Side-chat companion (`/btw`)**: ask questions about a running session via a second read-only session fed a bounded transcript snapshot (we already size-bound histories in `wire-messages.ts`). OpenClaw routes it to a cheap utility model. _Effort: L._
13. **Skills manager depth.** We have a skills tab; upstream shows where it goes: enable/disable + API-key entry per skill (Hermes), marketplace search with download counts + trust badges (ClawHub), proposals mined from history (OpenClaw Skill Workshop). The **agentskills.io format** is the interoperability anchor — support importing it. _Effort: M per piece._
14. **Device pairing for PWA logins** (OpenClaw QR pairing; hermes-webui passkeys). JWT-cookie auth is fine on one device; pairing/passkeys smooth multi-device PWA installs. _Effort: M._

### Don't lift

- **TTS / voice output** — excluded by project constraint.
- **node-pty in-browser terminal** — excluded by constraint (hermes-webui's terminal is the one piece that truly needs its Python side).
- **Multi-user gateways, owner assignment, incognito threads** — conflict with the single-operator design.
- **Lit/Vite or Python source itself** — OpenClaw Control UI is Lit; hermes-webui is vanilla-JS-over-Python. Nothing drops into Svelte 5/Bun. Lift **patterns and protocol shapes** (OpenClaw's bounded `chat.history` refresh with per-message text caps — we already do exactly this in `wire-messages.ts`; their draft-recovery TTLs; Hermes's session-source chips), not files.

---

## 5. Suggested sequencing

1. Quick wins (Tier 1 #1, #2, #10) — one focused PR each; no protocol churn beyond maybe one `connected` field.
2. Session content search + usage page (#3, #5) — both build on `session-scan.ts`; do together.
3. Unread/attention states (#4) — small protocol addition (session-state patch), pairs with the existing coalesced broadcast.
4. Then pick one Tier 2 bet — **cron** for headline parity with what makes OpenClaw/Hermes popular; **file-browser panel** as the cheapest of the three.

## 6. Sources

- OpenClaw: `github.com/openclaw/openclaw` (README, `docs/web/control-ui.md`, `docs/assets/showcase/agents-ui.jpg`), `docs.openclaw.ai/web/control-ui`
- Hermes: `github.com/NousResearch/hermes-agent` (README incl. `hermes claw migrate`), `hermes-agent.nousresearch.com/docs`
- hermes-webui: `github.com/nesquena/hermes-webui` (README + screenshots; `api/` listing: `terminal.py`, `worktrees.py`, `passkeys.py`, `session_export_html.py`, `goals.py`, `kanban_bridge.py`)
- CODE Magazine article 268031 walkthrough screenshots (OpenClaw TUI status footer, markdown rendering, conversational cron)
- pi-ui grounding: `AGENTS.md`, `server.ts`, `src/lib/server/session-scan.ts`, `src/lib/server/wire-messages.ts`, `src/lib/client-messages.ts`, `src/lib/components/*`, `src/app.css`, `src/routes/(app)/+page.svelte`
