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
├── sessions/
│   └── <id>/
│       ├── meta.json   # SessionMeta
│       └── log.jsonl   # append-only event log
├── tmp/                # images pasted into the prompt
├── tui.json            # home view, default mode, last model per agent
└── wall.json           # open tiles restored on launch
```

MCP servers are enabled by default and passed to sessions at creation. A session can be created with a subset; the MCP screen (`m`) manages the list and toggles servers.

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
  tui/        # OpenTUI + React terminal client
packages/
  protocol/   # shared types, event vocabulary, route table
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
