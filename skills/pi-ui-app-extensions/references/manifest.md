# Manifest reference (`pi-ui.extension.json`)

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
      "description": "Read package metadata and Git working-tree status.",
      "inputSchema": { "type": "object", "additionalProperties": false },
      "exposeToAgent": true
    }
  ],
  "events": []
}
```

## Rules

- `schemaVersion` must be `1`; `apiVersion` must equal the host `APP_EXTENSION_API_VERSION` (currently `1`).
- All ids (extension, view, operation) must start with a letter or digit, contain only letters, digits, `.`, `_`, `-`, max 128 chars. View ids unique within the package; operation ids unique within the package; event names unique.
- `clientEntry` / `serverEntry` must be non-empty relative paths with no `..` segments.
- Entry paths are relative to the package root (e.g. `client/index.mjs`, `server/index.mjs`).

## Views

Each view: `id`, `title`, optional `icon`, optional `order` (launcher sort: `order`, then title, then extension id, then view id), and `slot`: `sidebar` | `right-panel` | `workspace`. Legacy `main-tab` / `full-page` are accepted and normalized to `workspace` at load. Unknown slots are ignored.

## Operations

Each operation: `id`, `kind` (`read` | `action`), `description`, optional `scope` (`app` | `project` | `session`; omitted means app-scoped), optional `inputSchema` / `outputSchema` (JSON-Schema-shaped metadata), optional `exposeToAgent`.

- `exposeToAgent: true` registers a Pi agent tool named `app_<extension-id>_<operation-id>` (other characters become underscores) for sessions created while enabled.
- Agent tools reject calls with missing scope. After changing enablement, open a new Pi session so tool definitions attach.

## Events

`events` lists event names the package may broadcast via `ctx.emit`. Subscriptions are validated against declared names; undeclared subscriptions are dropped.

## Capabilities

Optional `capabilities` unlocks sensitive server namespaces. Unknown or duplicate values reject the manifest; undeclared use throws `missing-capability` at call time. Declared capabilities render as badges on the app card — review them before enabling.

- `workspace.write` — `ctx.workspace.writeText(path, content)` (1 MiB cap, atomic, project-contained).
- `session.read` — `ctx.session.getMessages({ limit?, kinds? })` over the calling session's recent transcript (≤200 messages, 256 KiB total).
- `catalog.list` — `ctx.projects.list()` and `ctx.sessions.list()` (sessions stay inside the calling project).
