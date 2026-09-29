# Server entry reference

The server entry exports a default handler map (or a named `extension`):

```js
export default {
  reads: {
    'project-summary': async (input, ctx) => {
      const [packageJson, git] = await Promise.all([
        ctx.workspace.readJson('package.json').catch(() => null),
        ctx.cli.run('git', ['status', '--short'], { timeoutMs: 10_000, maxOutputBytes: 16_384 }),
      ]);
      return { packageJson, gitStatus: git.stdout, gitExitCode: git.exitCode };
    },
  },
  actions: {
    'run-check': async (_input, ctx) =>
      ctx.cli.run('bun', ['run', 'check'], { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 }),
  },
};
```

Handlers receive `(input, ctx)`. `ctx` carries the validated `scope`, `caller` (`{ kind: 'ui' | 'agent', sessionId? }`), and optional `signal`, plus:

- `ctx.workspace.readText(path)`, `readJson(path)`, `listFiles(path?)` — reads under the selected project root. Paths are project-relative with traversal and symlink-escape checks.
- `ctx.cli.run(program, argv, options?)` — explicit executable plus argument vector, no shell. Working directory derives from the validated project scope, never from the extension. Supports `timeoutMs`, `maxOutputBytes`, cancellation. Resolves `{ stdout, stderr, exitCode, timedOut, killed }`.
- `ctx.storage.get/set/delete(key)` — extension-namespaced JSON data in the Pi agent directory (1 MiB per value, 256 keys per extension).
- `ctx.emit(eventName, data?)` — broadcasts a manifest-declared event tagged with the operation's exact scope.

These are convenience APIs, not a sandbox: enabled code also has its process privileges directly. Validate all inputs in the handler; never trust scope, kind, or schemas as confinement. UI calls, agent tools, and cancellation all dispatch through the same registered handler.

Sensitive namespaces need a matching manifest `capability` (see [manifest](manifest.md)); undeclared use throws `missing-capability`:

- `ctx.workspace.writeText(path, content)` — atomic write under the project root (parents created, 1 MiB cap, symlink-escape checks, refuses directories). Requires `workspace.write`.
- `ctx.session.getMessages({ limit?, kinds? })` — recent transcript of the calling session only (default 50, max 200 messages; `kinds` filters `user` | `assistant` | `tool` | `other`; long texts truncate at 4k chars, 256 KiB total, oldest dropped first). Requires a session scope and `session.read`. The session must be resident.
- `ctx.projects.list()` — `{ cwd, name }` for every cataloged project. Requires `catalog.list`.
- `ctx.sessions.list()` — `{ id, cwd, name?, messageCount }` for sessions in the calling project only. Requires a project scope and `catalog.list`.

The server entry is imported from a content-addressed copy under `<agent-dir>/app-extensions-runtime/`, so `import.meta.url` points at the cache copy, not the install path. The copy holds the full package tree (relative imports work), but it is ephemeral — keep durable state in `ctx.storage`, never in files next to the module.
