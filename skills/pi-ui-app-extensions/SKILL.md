---
name: pi-ui-app-extensions
description: Build pi-ui app extensions - installation-wide sidebar, right-panel, and workspace views plus scoped server operations with agent tools. Use when creating or modifying a pi-ui extension package (pi-ui.extension.json, serverEntry, clientEntry), wiring views, operations, events, exposeToAgent tools, chat prompts, composer drafts, confirm dialogs, file viewing, session switching, workspace writes, transcript reads, catalog listing, or manifest capabilities.
version: 2
created: "2026-09-27"
updated: "2026-09-29"
---

# Pi UI App Extensions

App extensions add installation-wide views and named operations to pi-ui. They are separate from Pi session extensions: own package directory, enablement store, WebSocket messages, operation registry, browser view host.

> Trust: an enabled extension is full, trusted JavaScript. Its server module runs with the pi-ui server's privileges; its browser module runs in the authenticated pi-ui origin. Not sandboxed. Review source before enabling. Never treat manifest declarations as a security boundary.

## Package layout

```text
<id>/
  pi-ui.extension.json
  server/index.mjs
  client/index.mjs
```

Copy `examples/app-extensions/project-cockpit` as the starting template. Keep server files outside `client/` — only the client entry's directory is served to browsers, and the server entry plus manifest paths are explicitly blocked.

## Install, enable, reload

1. Create the package under `~/.pi/agent/app-extensions/<id>/` (or the active Pi agent dir's `app-extensions/` folder).
2. In pi-ui open the Apps launcher: it rescans manifests on open (or press **Refresh**). Packages are disabled by default; scanning never imports code.
3. Review source, then **Enable**. Enabling imports the server entry and persists the ID in `app-extensions.enabled.json`. Disabling unregisters operations and views.
4. After editing an enabled package's `serverEntry`: press **Reload** on its card. It re-imports the entry and swaps handlers in place without restarting the host or dropping sessions. In-flight operations for that extension are cancelled, and it is refused while the extension is disabled. Single-file client changes remount automatically via the fingerprinted client URL; chunked builds still need a page reload. Editing pi-ui itself needs a host restart.
5. After changing enablement, create a new Pi session if the current one lacks the extension's agent tools.

Enable, pin, and open are separate: enable makes code available; pin is a browser-local shortcut that neither enables nor mounts; open mounts a view. Pins and order are browser-local.

## Views and slots

Each view declares a slot deciding where it opens. See [manifest](references/manifest.md) for the full manifest contract.

- `sidebar` — pinned as a compact attachment in the left projects sidebar. Only the expanded attachment mounts; unmounted while the sidebar is closed.
- `right-panel` — inline in the persistent Apps tab of the right panel.
- `workspace` — full-screen app surface (desktop) / pushed full-screen page (mobile). Chat stays mounted underneath with drafts preserved; Back and the in-page Chat button return. Legacy `main-tab` / `full-page` slots normalize to `workspace`.

## Operations

Reads and actions dispatch through the same server runtime for UI calls and Pi agent tools. An operation omitted from `scope` is app-scoped; `project` / `session` operations require that explicit identifier in every call — the server validates against its catalogs and never substitutes the focused project or session.

`exposeToAgent: true` adds the operation to Pi agent tool definitions as `app_<extension-id>_<operation-id>` (non-alphanumerics become underscores). Tool schemas are descriptive metadata only; handlers must validate inputs.

- Server handler map and `ctx` APIs: see [server](references/server.md).
- Browser `mount(root, api)` and client API: see [client](references/client.md).

## Capabilities

Sensitive server namespaces need a matching `capabilities` entry in `pi-ui.extension.json` (see [manifest](references/manifest.md)); undeclared use throws `missing-capability`. Declared capabilities render as badges on the app card — check them during review:

- `workspace.write` — `ctx.workspace.writeText(path, content)`.
- `session.read` — `ctx.session.getMessages({ limit?, kinds? })` over the calling session only.
- `catalog.list` — `ctx.projects.list()` and `ctx.sessions.list()` (sessions stay inside the calling project).

## Client API

Beyond `read` / `invoke` / `subscribe` / `notify`, views can reach the visible UI — call these only from explicit user gestures and surface rejections:

- `api.prompt(text)` — submits a chat prompt to the session in the view's scope (rejects without one; workspace returns to chat on submit).
- `api.setComposerDraft(text)` — replaces the composer draft (rejects unless that session is active).
- `api.confirm({ title?, message, confirmLabel? })` — host dialog; resolves `true`/`false`. Gate destructive actions behind it.
- `api.openFile(path)` — project-relative file in the host viewer.
- `api.switchSession(sessionId)` — switches chat to another session.

Full signatures and rules: see [client](references/client.md).

## Development checks

Keep extensions small; test server handlers independently. Host suites: `src/lib/server/app-extensions/`, `src/lib/server/handlers/__tests__/app-extension-handlers.test.ts`, `src/lib/app-extensions/`, `src/lib/state/__tests__/app-extensions-state.test.ts`. No E2E required for the host contract.
