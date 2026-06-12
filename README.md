# pi-ui

Web UI for the [pi coding agent](https://github.com/earendil-works/pi) — a polished,
low-footprint PWA that runs in your browser and connects to a `pi` session over WebSocket.

Designed to run on a Raspberry Pi, but works on any machine with Bun.

---

## Features

- **Full chat UI** — streaming text, tool output, images, think-blocks, queue chips
- **Session management** — create, fork, compact, rename, and switch between sessions
- **Model & provider picker** — per-provider colour chips, thinking-level control
- **Skills & prompts browser** — browse and inject skills/prompts; install from GitHub URLs
- **Tool control** — enable/disable individual tools per session
- **Extension UI** — `select`, `confirm`, `input`, and `editor` dialogs forwarded to the browser
- **Diffs & file links** — inline unified-diff viewer and clickable workspace file references
- **Syntax highlighting** — tool output and code blocks highlighted via `highlight.js`
- **PWA** — installable on iOS and Android; minimal service worker with no offline cache
- **Password-protected** — bcrypt + signed JWT cookie; no external auth service required
- **Low footprint** — no SSR, no Workbox, single pi session per process, `perMessageDeflate`

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- A configured [pi coding agent](https://github.com/earendil-works/pi) (API keys, etc.)

---

## Installation

### Global (recommended for Raspberry Pi / servers)

```bash
bun add -g @thed24/pi-ui
```

Then start it:

```bash
pi-ui --password your-secret
```

Open `http://<your-pi-ip>:3000` in your browser.

---

### Run without installing (npx / bunx)

```bash
bunx @thed24/pi-ui --password your-secret
```

---

### From source

```bash
git clone https://github.com/dominic-codespoti/pi-ui
cd pi-ui
bun install
bun run build
bun run start --password your-secret
```

---

## Usage

```
pi-ui [options]
pi-ui update

Options:
  -p, --password <password>  Password to protect the UI
                             (or set PI_PASSWORD env var)
  -P, --port <port>          Port to listen on  (default: 3000)
                             (or set PORT env var)
      --cwd <dir>            Working directory for the pi session
                             (defaults to current working directory)
  -o, --open                 Open http://localhost:<port> in the browser
  -d, --daemon               Run as a background daemon (detached from terminal)
  -h, --help                 Show this help message
  -V, --version              Print version and exit

Commands:
  update                     Update pi-ui using the detected install method
```

### Examples

```bash
# Minimal
pi-ui -p secret

# Custom port, open browser
pi-ui -p secret -P 8080 --open

# Point pi at a specific project directory
pi-ui -p secret --cwd /path/to/my-project

# Password from environment variable
PI_PASSWORD=secret PORT=4000 pi-ui

# Run as a background daemon
pi-ui -p secret --daemon

# Update pi-ui to the latest version
pi-ui update
```

---

## Environment variables

| Variable      | Description                                | Default          |
|---------------|--------------------------------------------|------------------|
| `PI_PASSWORD` | Password for the web UI (required)         | —                |
| `PORT`        | Port to listen on                          | `3000`           |
| `PI_CWD`      | Working directory for the pi session       | `process.cwd()`  |

CLI flags take precedence over environment variables when both are set.

---

## Raspberry Pi deployment

### One-shot start

```bash
PI_PASSWORD=secret pi-ui --port 3000
```

### Persistent service (systemd)

Create `/etc/systemd/system/pi-ui.service`:

```ini
[Unit]
Description=pi coding agent UI
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi
Environment=PI_PASSWORD=your-secret-here
Environment=PORT=3000
ExecStart=/home/pi/.bun/bin/pi-ui
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable pi-ui
sudo systemctl start pi-ui
```

---

## Remote access

Do not expose the raw `pi-ui` port directly to the public internet. If you need
remote access, put it behind a private tunnel and keep `PI_PASSWORD` strong and
unique.

### Cloudflare Tunnel example

Start `pi-ui` locally on the Pi:

```bash
PI_PASSWORD='use-a-long-random-password' pi-ui --port 3000
```

Then point a Cloudflare Tunnel at the local service:

```bash
cloudflared tunnel --url http://localhost:3000
```

For a named tunnel, your `cloudflared` config should route a hostname to the
local HTTP service:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/pi/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: pi-ui.example.com
    service: http://localhost:3000
  - service: http_status:404
```

Cloudflare terminates TLS before traffic reaches the Pi, so treat the tunnel as
a secure transport layer, not as a replacement for the app password.

---

## Development

```bash
bun install

# UI hot-reload (no WebSocket — use for visual iteration only)
bun run dev

# Full local dev: Vite HMR plus Bun WebSocket server
PI_PASSWORD=dev bun run dev:full

# Build production assets
bun run build

# Start with WebSocket support (requires build first)
PI_PASSWORD=secret bun run start

# Type-check (Svelte + server)
bun run check
bun run check:server

# Lint / format
bun run lint
bun run format
```

---

## Publishing

```bash
# Validate packaging before publishing
bun run build && bun run build:server
npm pack --dry-run   # inspect the file list

# Builds and publishes to npm (runs prepublishOnly which builds first)
npm publish
```

The `prepublishOnly` hook runs `bun run build && bun run build:server`, so the
pre-built SvelteKit assets and minified Bun server bundle are included in the
package. Consumers get a zero-build install through the `pi-ui` CLI.

> **Note:** `@thed24/pi-ui` is a scoped package. The first publish requires
> `--access public`. Subsequent publishes default to the same access level.
> The `publishConfig.access: "public"` field in `package.json` handles this
> automatically.

---

## Architecture

```
Bun.serve (server.ts)
├── /ws   → WebSocket upgrade (auth-gated)
│           ├── pi SDK events → broadcast to all clients
│           └── ClientMessage → session commands
└── /*    → SvelteKit handler (SSR off, client-side SPA)

Browser (Svelte 5 SPA)
└── WebSocket (/ws)
    ├── streaming messages, tool outputs, extension UI dialogs
    └── commands: prompt, steer, fork, compact, model, tools, sessions …
```

- **Single pi session per process** — all browser tabs share one session
- **`perMessageDeflate: true`** — compresses large tool outputs over WS
- **No Workbox** — custom minimal service worker for iOS Safari compatibility
- **`svelte-adapter-bun`** — required; `@sveltejs/adapter-node` is incompatible with `Bun.serve`

---

## Contributing

Issues and PRs welcome at [github.com/dominic-codespoti/pi-ui](https://github.com/dominic-codespoti/pi-ui).

---

## License

MIT
