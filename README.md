# pifrontier

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
- **Syntax highlighting** — tool output and code blocks highlighted via `highlight.js`
- **PWA** — installable on iOS and Android; service worker with offline shell
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
bun add -g pifrontier
```

Then start it:

```bash
pifrontier --password your-secret
```

Open `http://<your-pi-ip>:3000` in your browser.

---

### Run without installing (npx / bunx)

```bash
bunx pifrontier --password your-secret
```

---

### From source

```bash
git clone https://github.com/dominic-codespoti/pi-ui
cd pifrontier
bun install
bun run build
bun run start --password your-secret
```

---

## Usage

```
pifrontier [options]

Options:
  -p, --password <password>  Password to protect the UI
                             (or set PI_PASSWORD env var)
  -P, --port <port>          Port to listen on  (default: 3000)
                             (or set PORT env var)
      --cwd <dir>            Working directory for the pi session
                             (defaults to current working directory)
  -o, --open                 Open http://localhost:<port> in the browser
  -h, --help                 Show this help message
  -V, --version              Print version and exit
```

### Examples

```bash
# Minimal
pifrontier -p secret

# Custom port, open browser
pifrontier -p secret -P 8080 --open

# Point pi at a specific project directory
pifrontier -p secret --cwd /path/to/my-project

# Password from environment variable
PI_PASSWORD=secret PORT=4000 pifrontier
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
PI_PASSWORD=secret pifrontier --port 3000
```

### Persistent service (systemd)

Create `/etc/systemd/system/pifrontier.service`:

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
ExecStart=/home/pi/.bun/bin/pifrontier
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable pifrontier
sudo systemctl start pifrontier
```

---

## Development

```bash
bun install

# UI hot-reload (no WebSocket — use for visual iteration only)
bun run dev

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
# Builds and publishes to npm
npm publish
```

The `prepublishOnly` hook runs `bun run build` automatically, so the pre-built
SvelteKit assets are included in the package. Consumers get a zero-build install —
only runtime dependencies (`@earendil-works/pi-coding-agent`, `bcryptjs`, `jose`)
are installed.

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

