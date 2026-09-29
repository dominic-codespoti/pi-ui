# Browser entry reference

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

## Client API

- `api.extensionId`, `api.scope` (live view scope — read fresh on every access, always the current project/session; the view is not remounted on switches).
- `api.read(operationId, input?, { signal? })` for `read` operations; `api.invoke(operationId, input?, { signal? })` for `action` operations. Both dispatch through the same server runtime as Pi agent tools.
- `api.subscribe(eventName, listener, scope?)` returns an unsubscribe function. Defaults to the view's scope at subscribe time; existing subscriptions keep their creation scope across session switches (resubscribe to follow); pass `{}` to receive app-wide events. Global listeners get only global events; project-only listeners get project events (not session events); session listeners match that exact session ID; a project+session listener must match both.
- `api.notify(message, kind?)` — `kind`: `info` | `success` | `warning` | `error`.
- `api.prompt(text)` — submits text as a chat prompt to the session in the view's scope. Rejects on blank text, when no session is active, or when the send fails.

## Chat prompts

- Call `api.prompt` only from an explicit user gesture (e.g. a button click). It submits immediately — there is no draft mode.
- Scope comes from the view snapshot; it is never inferred from chat focus. Without a `sessionId` the call rejects — surface that error instead of retrying silently.
- From a fullscreen workspace the host returns to chat on submit so the turn stays visible.
- A session that is mid-turn rejects the submit rather than interrupting the run; surface the error and let the user retry.

The client API intentionally exposes no filesystem or process primitives.

## Chat and host surfaces

- `api.setComposerDraft(text)` — replaces the chat composer draft for the session in the view's scope. Rejects unless that session is the active one.
- `api.confirm({ title?, message, confirmLabel? })` — host-rendered confirm dialog. Resolves `true` on confirm, `false` on cancel/dismiss. Gate destructive actions behind it; only one confirm at a time.
- `api.openFile(path)` — opens a project-relative file in the host file viewer. Validated client-side (relative, no `..`); the server re-checks containment.
- `api.switchSession(sessionId)` — switches chat to another session by ID. Rejects for unknown sessions or while a session operation is busy.

All four act on the visible UI, so call them only from explicit user gestures and surface rejections.

## Browser constraints

- Build the browser module as browser-compatible ESM. Relative ESM chunks may be imported; other assets in the same public directory load with normal browser APIs. Prefer a single-file client: its catalog URL is fingerprinted, so **Reload** remounts it with fresh code. With chunked builds, sibling chunk URLs are unchanged and the browser reuses their cached modules — those need a page reload.
- Assets serve from the authenticated same-origin `/extensions/` route, only from the enabled package's client-entry directory, with path and symlink containment checks.
- Sidebar views mount only while their attachment is expanded; always return cleanup (or `{ unmount() }`) and guard async completions with a disposed flag.
