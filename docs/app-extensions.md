# App extensions

App extensions add installation-wide views and named operations to pi-ui. They are separate from Pi session extensions: they have their own package directory, enablement store, WebSocket messages, operation registry, and browser view host.

> **Trust warning:** an enabled extension is full, trusted JavaScript code. Its server module runs with the pi-ui server process's privileges, and its browser module runs in the authenticated pi-ui origin. Extensions are not sandboxed. Review the source before enabling one. Manifest declarations and helper APIs are contracts, not a security boundary.

## Install and enable

Create a package directory under `~/.pi/agent/app-extensions/<id>/` (or the active Pi agent directory's `app-extensions/` folder), containing `pi-ui.extension.json`, `server/`, and `client/`. For example, copy [`../examples/app-extensions/project-cockpit`](../examples/app-extensions/project-cockpit) to that directory. Open the global **Apps** launcher and choose **Manage** to reach the right-panel Apps manager; choose **Refresh** to scan installed packages. Packages are disabled by default; scanning manifests does not import package code. Each app card keeps its Enable/Disable and Reload controls beside its view buttons. Review package source before enabling it. Enabling is the explicit trust decision: it imports the server entry and stores the enabled ID. Disabling unregisters its operations and views. Opening the Apps manager rescans manifests, so added, removed, or edited manifests appear without a manual refresh.

**Applying code edits.** For a manifest-only change, reopening the Apps manager is enough. For changed `serverEntry` code, press **Reload** on the card: it re-imports the entry and swaps the handlers in place, leaving the host (and every resident session) running. In-flight operations for that extension are cancelled, exactly as a disable would do. **Reload** is refused while an extension is disabled, because running a server entry is the trust decision that Enable grants; enable it first. Client-side changes are picked up automatically for single-file clients: the catalog URL carries the client entry's mtime/size fingerprint, so **Reload** makes mounted views remount with fresh code. Chunked builds (a client entry with relative ESM chunk imports) still need a page reload, because sibling chunk URLs are unchanged and the browser reuses their cached modules. Editing pi-ui itself is separate: that needs a host restart.

The reload mechanism is worth knowing about when debugging: Bun keys its module cache on the resolved real path and ignores `?v=` query strings, so the loader imports each server entry from a content-addressed copy under `<agent-dir>/app-extensions-runtime/` (mode 0700, one retained fingerprint per extension). A changed entry lands on a new path and therefore a fresh module; an unchanged one reuses the copy it already has. Relative imports inside the package still resolve because the whole package tree is copied. Only the server entry is imported from that copy — browser assets keep being served from the installed path, so asset containment is unaffected. An extension that locates its own files through `import.meta.url` sees the cache path rather than the install path. The cache copy holds the full package tree, so relative imports and sibling data files resolve the same way; treat the copy as ephemeral (only one fingerprint per extension is retained) and keep durable state in `ctx.storage`, never in files next to the module.

**Enable**, **pin**, and **open** are separate actions. Enable makes trusted code available; pin adds a browser-local shortcut/attachment without enabling or mounting the extension; open mounts a view. Pins and their order are local to this pi-ui installation/browser profile, not shared between users.

A view can render any UI into its host element. Each view declares a `slot` in the manifest, which decides where it opens:

- `sidebar` — can be pinned as a compact attachment in the left projects sidebar. Only the expanded attachment mounts, and it is unmounted while the sidebar is closed.
- `right-panel` — hosts inline in the persistent **Apps** tab of the right panel.
- `workspace` — opens as the primary full-screen app surface on desktop and a pushed full-screen page on mobile. Chat remains mounted underneath with drafts and session state preserved; browser/mobile Back and the in-page **Chat** button return to it. The Workspace header also opens the Apps launcher.

Legacy `main-tab` and `full-page` manifest slots are accepted and normalized to `workspace`. Workspace selection persists locally across page reloads; history entries retain the selected view so Back can return to the previous Workspace or Chat. Sidebar pins and their order are browser-local and do not enable extensions.

## Package layout

```text
project-cockpit/
  pi-ui.extension.json
  server/
    index.mjs
  client/
    index.mjs
```

Keep server files outside the `client/` directory. The server only serves assets within the client entry's directory, and it explicitly blocks the server entry and manifest paths. Browser modules should be built as browser-compatible ESM; relative ESM chunks can be imported, and other assets in that public directory can be loaded with normal browser APIs.

### Manifest

```json
{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "project-cockpit",
  "name": "Project Cockpit",
  "version": "1.0.0",
  "description": "A compact project status view and check action.",
  "clientEntry": "client/index.mjs",
  "serverEntry": "server/index.mjs",
  "views": [{ "id": "cockpit", "title": "Cockpit", "slot": "right-panel" }],
  "operations": [
    {
      "id": "project-summary",
      "kind": "read",
      "scope": "project",
      "description": "Read package metadata and Git working-tree status for an explicitly selected project.",
      "inputSchema": { "type": "object", "additionalProperties": false },
      "exposeToAgent": true
    },
    {
      "id": "run-check",
      "kind": "action",
      "scope": "project",
      "description": "Run the project's Bun check script in an explicitly selected project.",
      "inputSchema": { "type": "object", "additionalProperties": false },
      "exposeToAgent": true
    }
  ],
  "events": []
}
```

Operation IDs must be unique within a package. An operation omitted from `scope` is app-scoped; project and session operations require that explicit identifier in every call. `exposeToAgent: true` adds the operation to Pi agent tool definitions for sessions created while the extension is enabled. Generated tool names use `app_<extension-id>_<operation-id>` (non-alphanumeric characters become underscores). Tool schemas are descriptive metadata; handlers must validate their inputs.

### Server entry

The server entry exports a default handler map (or named `extension`):

```js
export default {
  reads: {
    'project-summary': async (_input, ctx) => {
      const [packageJson, git] = await Promise.all([
        ctx.workspace.readJson('package.json').catch(() => null),
        ctx.cli.run('git', ['status', '--short'], {
          timeoutMs: 10_000,
          maxOutputBytes: 16_384,
        }),
      ]);
      return {
        packageJson,
        gitStatus: git.stdout,
        gitExitCode: git.exitCode,
      };
    },
  },
  actions: {
    'run-check': async (_input, ctx) =>
      ctx.cli.run('bun', ['run', 'check'], {
        timeoutMs: 120_000,
        maxOutputBytes: 64 * 1024,
      }),
  },
};
```

Handlers receive `(input, ctx)`, where `ctx` includes the validated `scope`, `caller`, and optional `signal`, plus:

- `ctx.workspace.readText(relativePath)`, `readJson(relativePath)`, and `listFiles(relativePath?)` for reads under the selected project root. Paths are project-relative and checked against traversal and symlink escapes.
- `ctx.workspace.writeText(relativePath, content)` for atomic writes under the project root (parents created, 1 MiB cap, refuses directories). Requires the `workspace.write` manifest capability.
- `ctx.session.getMessages({ limit?, kinds? })` for the calling session's recent transcript (default 50, max 200; long texts truncate, 256 KiB total). Requires a session scope, a resident session, and the `session.read` capability.
- `ctx.projects.list()` for `{ cwd, name }` catalog entries and `ctx.sessions.list()` for sessions in the calling project. Both require the `catalog.list` capability; sessions additionally require a project scope.
- `ctx.cli.run(program, argv, options?)` for explicit executable + argument-vector execution (no shell). Its working directory is derived from the validated project scope, never provided by the extension. Timeout, cancellation, and output limits are supported.
- `ctx.storage.get/set/delete(key)` for extension-namespaced JSON data in the Pi agent directory.
- `ctx.emit(eventName, data?)` to broadcast an event declared in the manifest, tagged with the operation's exact scope.

These are convenience APIs, not a sandbox. Enabled code can also use the privileges of its process directly. Do not treat a declared capability, operation kind, or helper as confinement.

### Browser entry

The client entry exports `mount(root, api)` and may return a cleanup function or `{ unmount() }`:

```js
export function mount(root, api) {
  const refresh = document.createElement('button');
  refresh.textContent = 'Refresh project summary';
  const output = document.createElement('pre');
  root.replaceChildren(refresh, output);

  let disposed = false;
  async function load() {
    refresh.disabled = true;
    try {
      const summary = await api.read('project-summary');
      if (!disposed) output.textContent = JSON.stringify(summary, null, 2);
    } catch (error) {
      if (!disposed) output.textContent = String(error);
    } finally {
      if (!disposed) refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', load);
  void load();
  return () => {
    disposed = true;
    refresh.removeEventListener('click', load);
  };
}
```

The client API exposes `extensionId`, a snapshot of the current explicit `scope`, `read(operationId, input?, { signal? })`, `invoke(operationId, input?, { signal? })`, `subscribe(eventName, listener, scope?)`, `notify(message, kind?)`, `prompt(text)`, `setComposerDraft(text)`, `confirm({ title?, message, confirmLabel? })`, `openFile(path)`, and `switchSession(sessionId)`. The last four act on the visible UI: call them only from explicit user gestures. Declared manifest `capabilities` (`workspace.write`, `session.read`, `catalog.list`) unlock the matching sensitive server namespaces and render as badges on the app card. `prompt` submits text as a chat prompt to the session in the view's scope — it rejects when no session is active or the send fails, and from a fullscreen workspace the host returns to chat so the turn stays visible. Gate it behind an explicit user gesture (e.g. a button click) and surface rejections; a mid-turn session rejects the submit rather than interrupting the run. Event subscriptions default to the view's scope; pass an explicit scope override such as `{}` to receive app-wide events from an app-scoped operation. Global listeners receive only global events; project-only listeners receive project-scoped events (not session events); session listeners match that exact session ID, and a project+session listener must match both. Reads and actions dispatch through the same server runtime used by Pi agent tools. The client API intentionally does not expose filesystem or process primitives.

## Lifecycle and scope

- A package scan reads and validates manifests but does not execute package code.
- Enabling is an explicit trust decision and dynamically imports the server entry. Enabled IDs persist in `app-extensions.enabled.json` under the Pi agent directory.
- Each WebSocket operation includes explicit `projectId` and/or `sessionId` values required by its declaration. `projectId` carries the canonical project `cwd`; `sessionId` is the cataloged session ID. The server validates them against its catalogs and never substitutes the focused project or session.
- UI calls, agent tools, and cancellation use the same registered operation handler. Agent tools reject calls with missing scope.
- Event subscriptions are validated against declared event names and canonical catalog scope; rejected subscriptions are dropped client-side, and server subscriptions are purged on disable, refresh removal, or socket close.
- Browser assets are served from the authenticated same-origin `/extensions/` route, only from the enabled package's client-entry directory, with path and symlink containment checks.
- Agent tool definitions are attached when a Pi session is created. After changing extension enablement, create a new Pi session if the current session does not yet list the extension's agent tools.

## Development checks

Keep extensions small and test their server handlers independently. The pi-ui host's focused unit suites are under `src/lib/server/app-extensions/`, `src/lib/server/handlers/__tests__/app-extension-handlers.test.ts`, `src/lib/app-extensions/`, and `src/lib/state/__tests__/app-extensions-state.test.ts`. No E2E tests are required for the host contract.
