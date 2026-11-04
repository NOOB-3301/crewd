# Phone access for crewd: implementation plan

## Goal

The daemon runs on a Mac at home. From a phone, away from home, the user can:

- see which agent sessions are running, waiting or idle;
- read what an agent is doing, live;
- answer permission prompts;
- send a follow-up instruction.

## Decisions

| Topic | Decision |
| --- | --- |
| Reach the daemon | Tailscale (`tailscale serve`), tailnet-private. Not public. ngrok is allowed for short-lived testing only (see Phase 3b). |
| Transport | Plain HTTP + SSE for streaming, ordinary POSTs for actions. No WebSocket. |
| Auth | One static bearer token, stored in `~/.crewd/remote-token` (mode `0600`). No rotation, pairing, or per-device tracking. |
| Enable switch | `~/.crewd/remote.json`. If the file is absent, remote is off. |
| Phone client | A PWA served by the daemon on the same port. |
| Remote restrictions | None. The token plus tailnet membership is the whole trust boundary (see "Security notes"). |
| Keeping the Mac awake | Hold a `caffeinate` assertion only while at least one session is busy. |
| Push notifications | Not in v1. The phone is pull-based: open it, it reconnects and replays. |

## What the code looks like today

- `apps/daemon/src/main.ts` creates one server on a Unix socket (`~/.crewd/crewd.sock`, mode `0600`). The singleton check is socket-based, so a second listener does not interfere.
- `apps/daemon/src/server.ts` exports one Hono `app`, which a second server can reuse.
- Streaming is SSE at `GET /sessions/:id/events`. It replays the backlog after `Last-Event-ID` (the log `seq`) and then goes live. The client reconnects with backoff and drops duplicates. This already suits a flaky mobile connection.
- Permission requests are log events. The answer is `POST /sessions/:id/permissions/:requestId`. `sessions.answer()` throws 404 if the request is already settled, which is the right behavior when two clients race.
- Gaps for a phone:
  - The SSE handler has no heartbeat, so a quiet session looks dead to mobile carriers and proxies.
  - `GET /sessions/:id/history` returns the whole log, and `log.read` parses the whole file.
  - `packages/client` uses Bun's `fetch(..., { unix })` and imports `node:child_process`, so a browser cannot use it.
  - The log-folding function `toBlocks()` lives in `apps/tui/src/useSession.ts`, mixed with React hooks and a type imported from `ui/ToolLine.tsx`.

## Architecture

```
Phone (PWA, Tailscale app on)
   │  HTTPS  https://<mac>.<tailnet>.ts.net
   ▼
tailscale serve  ──►  127.0.0.1:<port>   remote listener (bearer-token auth)
                              │  same Hono routes
                              ▼
                        existing app  ──►  sessions.ts / orchestrators
                              ▲
TUI ── Unix socket (unchanged, no auth) ─┘
```

- The Unix socket and the TUI are unchanged.
- The TCP listener binds to `127.0.0.1` only. Tailscale is the only way in from outside.

## Phase 1: Remote listener with token auth (daemon only)

**Goal:** a token-protected TCP port on loopback, verified with `curl` on the Mac.

1. **Config.** `~/.crewd/remote.json` holds `{ "port": <number> }`. The daemon reads it at startup. If it is absent or invalid, remote is disabled and the daemon behaves exactly as today.
2. **Token module** (`apps/daemon/src/remote.ts`):
   - On first remote start, create `~/.crewd/remote-token` containing 32 random bytes, base64url-encoded, with mode `0600`. Reuse it on later starts.
   - Compare tokens in constant time (hash both with SHA-256, then `timingSafeEqual`).
   - Never log the token or request headers.
3. **Remote app.** Build a second Hono instance that applies auth middleware and then mounts the existing `app`. A request without `Authorization: Bearer <token>` gets 401. Log failed attempts (path only) to `daemon.log`.
4. **No Host check and no CORS.** A cross-origin web page cannot send a custom `Authorization` header without a CORS preflight, and the daemon never answers one. The page also cannot guess the token. So the token alone covers CSRF and DNS rebinding. Do not add CORS middleware.
5. **`main.ts`:**
   - If remote is enabled, create a second `createAdaptorServer` for the remote app and `listen(port, '127.0.0.1')`.
   - If the port is busy, log it and keep the socket daemon running rather than exiting.
   - Close both servers in `shutdown`.

**Checks (curl on the Mac):**
- `/sessions` with no token returns 401.
- With a wrong token it returns 401, and with the right token it returns 200.
- The TUI over the socket works exactly as before.
- The port is bound to loopback only, not `0.0.0.0` (check with `lsof -i`).

## Phase 2: Streaming hardening

**Goal:** the SSE stream survives mobile networks.

1. **Heartbeat.** In the events handler, run a ~15s interval that writes an SSE comment (`: ping`) to the stream, and clear it on abort. The existing client parser skips blocks without `data`, so the TUI is unaffected.
2. **Tail history.** Add `?turns=N` to `GET /sessions/:id/history`. It returns lines starting at the Nth-from-last user line, counting both `kind:'user'` and `ev.type:'user'`. Cutting at a turn boundary keeps `toBlocks` correct, and an open permission request is always in the latest turn, so it is never cut off. Without the parameter, behavior is unchanged. The phone loads the tail, then subscribes with `after=<last seq>`.
3. **Client watchdog** (built in Phase 5): if no bytes arrive for ~35s, abort and reconnect using the existing backoff and `Last-Event-ID` logic.
4. **Known limit:** every connect still parses the full `log.jsonl`. That is the existing `shortcut:` in `log.ts` and is fine for chat-sized logs.

**Checks:**
- `curl -N` with the token shows `: ping` roughly every 15s on an idle session.
- `turns=2` returns only the last two turns.
- The TUI streams normally.

## Phase 3: Tailscale and keeping the Mac awake

**Tailscale setup (one time):**
1. Install Tailscale on the Mac and the phone, signed in to the same tailnet.
2. In the Tailscale admin console, enable MagicDNS and HTTPS certificates.
3. On the Mac run `tailscale serve --bg <port>`. Flags vary between versions, so check `tailscale serve --help`. Use `serve`, not `funnel`, because Funnel makes it public.
4. The result is `https://<mac>.<tailnet>.ts.net`, proxying to `127.0.0.1:<port>`. HTTPS matters because a PWA needs a secure context.

**Sleep prevention (macOS only):**
- `setStatus` in `sessions.ts` is the single place where session status changes.
- Keep a count of busy sessions (`running` or `waiting`). On 0→1, spawn `caffeinate -i -w <daemon pid>`. When the count returns to 0, kill it.
- Only do this on `darwin` and only when remote is enabled.
- `caffeinate -i` prevents idle sleep but not sleep from closing the lid. To close the lid, use an external display (clamshell mode) on power, or a tool like Amphetamine. Document this in the README.

**Checks:**
- From the phone browser, `https://<mac>.<tailnet>.ts.net/` reaches the daemon. Before the PWA exists, a 401 or 404 is enough to prove the path works.
- Start a long-running session and confirm the Mac does not idle-sleep while it runs, and may sleep after it finishes.
- The port is not reachable from a device outside the tailnet.

## Phase 3b: Testing with ngrok (temporary alternative to Tailscale)

**Audience note:** this section is written as explicit, ordered instructions so a human or an AI agent can follow it without guessing.

**Purpose:** let a developer test the remote listener and the phone app without setting up Tailscale. ngrok is for testing only. Tailscale remains the intended way to use the feature day to day.

**Scope of change:** none to the code. The daemon listener, the token, the heartbeat, the PWA and `caffeinate` behave the same. Only the command that exposes the port differs. Skip the "Tailscale setup" steps of Phase 3 and use the steps below instead.

### Prerequisites

- Phase 1 is done: `~/.crewd/remote.json` exists with `{ "port": <number> }`, the daemon is running, and `curl -H "Authorization: Bearer $(cat ~/.crewd/remote-token)" http://127.0.0.1:<port>/sessions` returns 200.
- ngrok is installed on the Mac and signed in (`ngrok config add-authtoken <token>`).

### Steps

1. Choose the port from `~/.crewd/remote.json`. Call it `<port>`.
2. Run `ngrok http <port>`. Do not pass `--basic-auth`: it uses the `Authorization` header, which crewd already uses for the bearer token, so the two would collide.
3. Copy the `https://….ngrok-free.app` forwarding URL that ngrok prints. Call it `<url>`.
4. Verify auth from any machine:
   - `curl -i <url>/sessions` must return `401`.
   - `curl -i -H "Authorization: Bearer <token>" <url>/sessions` must return `200` with a JSON array.
5. Verify streaming (needs a session id from step 4):
   - `curl -N -H "Authorization: Bearer <token>" <url>/sessions/<id>/events`
   - On an idle session a `: ping` line must appear about every 15 seconds, and the connection must stay open.
6. Open `<url>/app/` on the phone. If ngrok shows a warning page, click through it once.
7. Paste the token on the phone's token screen, then run the Phase 5 checks.
8. When testing ends, stop ngrok (Ctrl+C in its terminal). The public URL stops working immediately.

### Expected results and what to do if they fail

| Check | Expected | If it fails |
| --- | --- | --- |
| No token returns 401 | `401` | The auth middleware is not applied to the remote app. Fix Phase 1 before continuing. |
| Token returns 200 | `200` | Check that the token in the header matches `~/.crewd/remote-token` exactly, with no trailing newline or quotes. |
| SSE stays open | `: ping` about every 15s | If the stream stalls, ngrok may be buffering. Confirm the heartbeat is implemented. If it still stalls, record it as an ngrok-specific limitation and test again with Tailscale. |
| PWA `fetch` calls fail with an HTML warning page | JSON responses | ngrok's free tier can show an interstitial to browsers. Add the request header `ngrok-skip-browser-warning: 1` in `apps/web/src/api.ts`. |
| PWA loads but every call returns 401 | Calls succeed | The token screen did not store the token, or `localStorage` is blocked. Clear site data and paste the token again. |

### Constraints (do not skip)

- The ngrok URL is public on the internet. The bearer token is the only protection. Keep the tunnel running only while testing.
- Never put the token in a URL or query string, and never paste it into logs, screenshots or chat.
- Do not leave the ngrok tunnel running overnight or unattended.
- Do not enable any CORS headers to "make it work". The same-origin PWA does not need them.
- Free ngrok URLs may change each run. Use the URL printed by the current ngrok session.

### Switching back to Tailscale

Stop ngrok and follow the Tailscale steps in Phase 3. No code or config change is needed, because both options proxy to `127.0.0.1:<port>`.

## Phase 4: Extract shared code

**Goal:** the TUI and phone fold logs with the same code.

1. Create `packages/shared`, with no Node, no React and no Bun APIs. Move into it:
   - `toBlocks` and the `Item` / `Block` types;
   - whatever derives open permission requests from the log, if that also lives in `useSession`;
   - the `ToolItem` type, so shared code does not import from `ui/`;
   - the SSE block parser (the `data:` / `id:` loop in `packages/client`), as a pure function.
2. Rewire `apps/tui` and `packages/client` to import from it. Behavior must not change.
3. Add the package to the workspace and to the root `typecheck` script.

This touches working code, so it should be its own commit.

**Check:** `bun run typecheck` passes, and the TUI streams, folds and shows prompts exactly as before.

## Phase 5: The phone web app (`apps/web`)

**Build and serve:**
- A small React app built with `bun build` into `apps/web/dist`.
- The daemon serves those static files on the remote app under `/app/` and redirects `/` there. The shell is unauthenticated because it is static. The API paths stay behind the token.
- The shell and the API share an origin, so the app calls relative URLs. No base-URL setting or CORS is needed.
- Use a tiny static handler in the daemon with a path-traversal check, not a new dependency. It finds `dist` relative to the daemon bundle, as `ensureDaemon` does for the daemon directory.
- Add `manifest.webmanifest` and icons so "Add to Home Screen" works. Skip the service worker.

**API layer** (`apps/web/src/api.ts`): a thin `fetch` wrapper using `routes` from `@crewd/protocol`. It attaches the bearer token and uses the shared SSE parser. On a 401 it shows the token screen again.

**Screens:**

| Screen | Behavior |
| --- | --- |
| Token | Paste the token once; store it in `localStorage`. |
| Sessions | Poll `GET /sessions` every ~3s while visible. Sort `waiting` first (highlighted), then `running`, then the rest. Each row shows harness, title, cwd and status. |
| Session | Load `history?turns=N`, fold with `toBlocks`, subscribe to SSE after the last seq. Show agent turns, collapsed tool lines that expand on tap (long output truncated), an interrupt button, and a text box to send. |
| Permission card | When an open `permission_request` exists, show tool, title, input, and one button per option. A 404 on answer means it was already handled elsewhere, so just refresh. |

**Lifecycle:** when the tab becomes visible, reconnect and refetch the list. When hidden, close the stream. This matches the pull-based model.

**UI safety rule:** render agent and tool text as plain pre-wrapped text, or through a React markdown component. Never use `innerHTML` with agent output. The token is in `localStorage`, so an XSS bug would give an attacker full control of the Mac.

**Checks (on a real phone, over Tailscale):**
- Send a prompt and watch it stream.
- Trigger a permission prompt and approve it from the phone.
- Turn on airplane mode mid-stream, turn it off, and confirm replay has no gaps or duplicates.
- Answer the same prompt from the TUI and the phone and confirm the loser ends cleanly.
- Restart the daemon with the phone open and confirm it reconnects.

## Phase 6: Docs

- Update `ARCHITECTURE.md`. Design principle 4 says "no TCP listener", and the "Local security model" tradeoff names the socket as the only trust boundary. Both need to reflect the optional remote listener.
- Add a README section: creating `remote.json`, where the token lives, the `tailscale serve` command, and the sleep caveat.

## Order

| Phase | Depends on |
| --- | --- |
| 1 Listener and auth | None |
| 2 Streaming hardening | 1 |
| 3 Tailscale and sleep prevention | 1 |
| 3b ngrok testing (optional, replaces the Tailscale setup while testing) | 1, 2 |
| 4 Shared code extraction | None (can run in parallel with 1–3) |
| 5 Web app | 2, 4 |
| 6 Docs | All |

The first usable result is after Phase 3 (`curl` over Tailscale works). The first end-to-end result is after Phase 5.

## Security notes

- Without the token, the daemon rejects every API call. With it, the holder has full control of the Mac through the agents: they can start sessions in any directory, edit the MCP server list (which defines commands the daemon launches), and switch sessions to bypass-permissions mode. This is an accepted tradeoff for a personal, single-user setup, with no remote restrictions in v1.
- The token protects only against reaching the port. Keep the Tailscale boundary: only the user's own devices should be on the tailnet.
- Do not expose the port publicly (no Funnel, no ngrok) with only this token in front.
- Keep the token out of URLs, logs and screenshots.

## Deferred (not in v1)

- Push notifications (for example, the daemon posting to an ntfy.sh topic on `permission_request`).
- Image upload from the phone (`/messages` currently takes absolute paths on the Mac).
- Starting new sessions from the phone.
- Switching mode or model from the phone.
- A global event stream for the session list (v1 polls).
- Markdown rendering of agent output.
- Token rotation, per-device tokens and audit trails.
