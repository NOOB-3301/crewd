# crewd

> One terminal for all your coding agents.

crewd is a local-first terminal workspace for running coding agents side by side. A background daemon owns every agent process and session log; an OpenTUI terminal UI connects to it over a Unix socket. Start Claude Code, Qoder, and OpenCode sessions in different projects, watch them all at once, answer permission prompts, and switch modes and models without leaving the keyboard.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit together.

## Features

- **Multiple harnesses** — Claude Code and Qoder through their agent SDKs, OpenCode and custom agents through ACP (Agent Client Protocol).
- **Session wall** — keep several sessions open as tiles (1, 2×2, 3×2, …), with the focused one optionally full screen.
- **Resume anything** — list crewd's own sessions plus sessions found in each harness's store, and resume native sessions in place.
- **Live streaming** — events are appended to a JSONL log and pushed to the TUI over SSE; reconnects replay from the last seen sequence number.
- **Permission prompts** — allow once, always allow, or deny tool calls from the TUI, with the prompt queued in the session log.
- **Modes and models** — switch permission modes (Claude's modes or an ACP agent's own) and models at runtime; model lists are cached per project.
- **Command palette** — `/` lists the harness's slash commands; `/permissions`, `/model`, `/new`, `/sessions`, `/stop` are handled by crewd.
- **Images** — paste a clipboard image or drop image paths into the prompt; the daemon encodes them for the agent.
- **MCP servers** — keep one shared list, toggle servers on/off, and pass a subset to any session.
- **Usage** — account quota for Claude and Qoder, local totals for OpenCode.
- **Crash-safe logs** — append-only session files; on restart, interrupted sessions are marked and open prompts are cancelled.

## Requirements

- [Bun](https://bun.sh) (workspaces, scripts, and the TUI)
- Node.js (the daemon is bundled with Bun and started with `node`)
- macOS or Linux (Unix domain sockets)
- At least one agent installed and on `PATH`:
  - Claude Code (`claude`) and a completed `claude` login
  - Qoder (`qodercli`) and either `QODER_PERSONAL_ACCESS_TOKEN` or `qodercli login`
  - OpenCode (`opencode`)
  - Pi (`pi-acp`, disabled by default)

## Quick start

```sh
bun install
bun run tui
```

The TUI auto-starts the daemon if it is not already running: it builds `apps/daemon/dist/main.js` on first use, spawns it detached, and waits for the socket to answer. To run the daemon yourself:

```sh
bun run daemon   # build + start in the foreground
bun run tui      # in another terminal
```

The daemon listens on `$CREWD_HOME/crewd.sock`, which defaults to `~/.crewd/crewd.sock`.

## Harnesses

| id | Label | Transport | Requirement | Notes |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code | SDK (`@anthropic-ai/claude-agent-sdk`) | `claude` on `PATH` | Default mode `auto`; exposes Claude's permission modes |
| `qoder` | Qoder | SDK (`@qoder-ai/qoder-agent-sdk`, optional) | `qodercli` on `PATH` | Auth from `QODER_PERSONAL_ACCESS_TOKEN` or `qodercli login` |
| `opencode` | OpenCode | ACP | `opencode acp` | Modes/models come from ACP config options |
| `pi` | Pi | ACP | `pi-acp` | Disabled until configured |

Any installed harness shows up in the new-session screen. Add your own ACP agent in `~/.crewd/harnesses.json` (read on every request, so edits apply live):

```json
[
  {
    "id": "my-agent",
    "label": "My agent",
    "kind": "acp",
    "command": ["my-agent", "acp"],
    "color": "#7C9EF5"
  }
]
```

## Configuration

Set `CREWD_HOME` to relocate everything. Default layout:

```
~/.crewd/
├── crewd.sock          # HTTP socket (mode 0600)
├── daemon.log          # daemon diagnostics
├── harnesses.json      # extra ACP harnesses
├── mcp.json            # [{ name, command, args?, env?, enabled? }]
├── remote.json         # { "port": n } — adds the loopback remote listener; no file means no listener
├── remote-token        # bearer token for it, created on the first remote start (mode 0600)
├── sessions/
│   └── <id>/
│       ├── meta.json   # SessionMeta
│       └── log.jsonl   # append-only event log
├── tmp/                # images pasted into the prompt
├── tui.json            # home view, default mode, last model per agent
└── wall.json           # open tiles restored on launch
```

MCP servers are enabled by default and passed to sessions at creation. A session can be created with a subset; the MCP screen (`m`) manages the list and toggles servers.

## Phone access

`apps/mobile` is an Expo (React Native) app for Android. It reaches the daemon over HTTPS through a second listener bound to `127.0.0.1` only, which Tailscale exposes from outside. The socket and the TUI keep working as before.

Turn the listener on by writing the port, then restart the daemon — `remote.json` is read at startup:

```sh
echo '{ "port": 8787 }' > ~/.crewd/remote.json
```

The daemon creates the token on the first remote start and reuses it after. It is in `~/.crewd/remote-token` (mode `0600`):

```sh
cat ~/.crewd/remote-token
```

Every remote call needs `Authorization: Bearer <token>`; without it the daemon answers `401`. The token grants what the socket grants — sessions in any folder, MCP edits, bypass-permissions mode — so keep the token and the tailnet to yourself.

Install Tailscale on the Mac and the phone, signed in to the same tailnet, enable MagicDNS and HTTPS certificates in the admin console, then on the Mac:

```sh
tailscale serve --bg 8787   # flags vary by version, check `tailscale serve --help`
```

You get `https://<mac>.<tailnet>.ts.net`. HTTPS is required, not preferred: Android blocks plain-HTTP requests from apps. Use `serve`, never `funnel`, which is public.

While a session is `running` or `waiting` the daemon holds `caffeinate -i`, so the Mac does not idle-sleep mid-turn. Closing the lid still sleeps it — use an external display on power (clamshell mode) or a tool like Amphetamine.

### Install the app

Give `apps/mobile/eas.json` a `preview` profile that outputs an APK:

```json
{ "build": { "preview": { "android": { "buildType": "apk" } } } }
```

```sh
cd apps/mobile && bunx eas-cli build --platform android --profile preview
```

Needs a free Expo account; the free tier has a monthly build quota and may queue, and EAS manages the signing key. Download the APK from the link the build prints, get it onto the phone (`adb install <file>.apk` or any file transfer) and open it — installing from a browser or file manager asks you to allow "Install unknown apps" for that app first. Rebuilds must be signed with the same key as the installed version or Android refuses the update; a local build means keeping your own keystore.

### Connect

On the Connect screen enter the server address (`https://<mac>.<tailnet>.ts.net`, it must start with `https://`) and the token. "Test connection" calls `GET /harnesses`. Both are saved in `expo-secure-store`.

To test without Tailscale, run `ngrok http 8787` and use its public URL as the server address. Do not pass `--basic-auth`: it uses the `Authorization` header the bearer token already uses. The tunnel is public with only the token in front of it, so stop it (Ctrl+C) when you are done and never leave it running unattended. ngrok also holds back small, infrequent SSE writes, so a status change can take seconds to reach the phone over it even though the connection looks alive; the app polls on a slow timer as a backstop, and Tailscale delivers pushes promptly.

## Keys

| Key | Action |
| --- | --- |
| `↑↓` / `j k` | move |
| `enter` | open a session, card, or tool line |
| `n` / `ctrl+n` | new session |
| `m` | MCP servers |
| `u` | usage |
| `/` | command palette |
| `esc` | stop the turn (or deny a permission prompt) |
| `y` / `a` / `n` | permission prompt: allow, always, deny |
| `shift+tab` | next mode |
| `tab` | switch between input and transcript |
| `alt+1…9` | focus tile |
| `ctrl+f` | focused tile full screen |
| `ctrl+w` | close tile (session keeps running) |
| `ctrl+o` | session list ↔ open tiles |
| `ctrl+c` | quit |

Press `?` anywhere for the full list.

## Development

```
apps/
  daemon/     # Node + Hono API on a Unix socket; owns agents and logs
  mobile/     # Expo + React Native app for Android, used over the remote listener
  tui/        # OpenTUI + React terminal client
packages/
  protocol/   # shared types, event vocabulary, route table
  shared/     # log folding and SSE parsing; no Node, Bun or React APIs
  client/     # typed HTTP + SSE client, daemon auto-start
fixtures/
  claude/     # sample Claude transcript JSONL files
```

Scripts:

```sh
bun run build       # bundle the daemon to apps/daemon/dist
bun run daemon      # build and run the daemon
bun run tui         # run the TUI from source
bun run typecheck   # tsc for daemon and TUI (no emit)
```

Self-checks:

```sh
bun apps/daemon/src/models.check.ts        # ACP model probe, cache, and switching
bun apps/tui/src/ui/clipboard.check.ts     # clipboard/image-path parsing (macOS: overwrites the clipboard)
```

## Troubleshooting

- **Daemon won't start** — check `~/.crewd/daemon.log`, or run `node apps/daemon/dist/main.js` in the foreground to see the error. A stale socket is removed on startup; a connectable socket means another daemon already owns it.
- **`socket path too long`** — macOS caps Unix socket paths at 104 bytes. Set a shorter `CREWD_HOME`.
- **A harness is listed but unavailable** — its binary is not on `PATH`; `installed: false` hides it from pickers.
- **Claude usage is missing** — the usage screen reads your Claude login from the macOS keychain or `~/.claude/.credentials.json`. Run `claude` once and sign in.
- **Qoder usage/model listing fails** — install the optional SDK with `bun add @qoder-ai/qoder-agent-sdk` and make sure `qodercli login` has succeeded.
- **Messages not arriving** — the TUI retries the daemon connection every 3 seconds; check the daemon log if the warning never clears.
