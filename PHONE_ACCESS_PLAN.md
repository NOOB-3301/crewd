# Phone access for crewd: implementation plan

**Audience note:** this document is written so a human or an AI agent can implement it phase by phase without guessing. File paths, route names and expected results are given explicitly. Where something depends on a library version or a choice not yet made, it says so.

## Goal

The daemon runs on a Mac at home. From a phone, away from home, the user can:

- see which agent sessions are running, waiting or idle, updated live;
- read what an agent is doing, live, with rendered markdown;
- answer permission prompts;
- send a follow-up instruction and interrupt a turn;
- switch a session's mode and model;
- start a new session in a project on the Mac.

## Decisions

| Topic | Decision |
| --- | --- |
| Phone client | A native app built with **Expo (React Native)**, in `apps/mobile`. Not a web app. |
| Reach the daemon | Tailscale (`tailscale serve`), tailnet-private. ngrok is allowed for short-lived testing only (see Phase 3b). |
| Transport | Plain HTTP + SSE for streaming, ordinary POSTs for actions. No WebSocket. |
| Auth | One static bearer token in `~/.crewd/remote-token` (mode `0600`). No rotation, pairing or per-device tracking. |
| Enable switch | `~/.crewd/remote.json`. If the file is absent, remote is off. |
| Remote restrictions | None. The token plus tailnet membership is the whole trust boundary (see "Security notes"). |
| Keeping the Mac awake | Hold a `caffeinate` assertion only while at least one session is busy. |
| Session list updates | A global SSE stream (Phase 9). Until then, the app polls `GET /sessions`. |
| Push notifications | Not in this plan. The app is pull-based: open it, it reconnects and replays. |

## What the code looks like today

- `apps/daemon/src/main.ts` creates one server on a Unix socket (`~/.crewd/crewd.sock`, mode `0600`). The singleton check is socket-based, so a second listener does not interfere.
- `apps/daemon/src/server.ts` exports one Hono `app`, which a second server can reuse.
- Streaming is SSE at `GET /sessions/:id/events`. It replays the backlog after `Last-Event-ID` (the log `seq`) and then goes live. The client reconnects with backoff and drops duplicates. This already suits a flaky mobile connection.
- Permission requests are log events. The answer is `POST /sessions/:id/permissions/:requestId`. `sessions.answer()` throws 404 if the request is already settled, which is the right behavior when two clients race.
- Mode and model switching already exist as `POST /sessions/:id/mode` and `/model`. The lists of available modes and models arrive as `mode` and `model` log events (`available` field).
- `POST /sessions` already accepts `{ harness, cwd, resumeId?, mcp?, permissionMode?, model? }`. `GET /harnesses` lists installed harnesses. `GET /harnesses/:id/models?cwd=` lists models (cached 10 minutes).
- In `apps/daemon/src/sessions.ts`, `emit()` updates `meta.updatedAt` in memory on every event but does not persist or broadcast it. `setStatus()` and the `mode` / `model` / `nativeId` handlers call `log.writeMeta`. These are the places where session metadata really changes.
- The TUI derives everything from the log inside `apps/tui/src/useSession.ts`: `toBlocks()` folds lines into chat blocks, and a `useMemo` derives `status`, `mode`, `modes`, `model`, `models`, `commands` and open permission requests. The Home screen polls every 3 seconds (`apps/tui/src/allSessions.ts`).
- Gaps for a phone:
  - The SSE handler has no heartbeat, so a quiet session looks dead to mobile carriers and proxies.
  - `GET /sessions/:id/history` returns the whole log, and `log.read` parses the whole file.
  - `packages/client` uses Bun's `fetch(..., { unix })` and imports `node:child_process`, so it cannot run in a phone app.
  - The folding logic is tangled with React hooks and a type imported from `ui/ToolLine.tsx`.
  - There is no way to list project folders without browsing the Mac's disk.
  - The TUI (`apps/tui`) depends on `react@^19.3.1`. Expo pins its own React version. See the risk note in Phase 5.

## Architecture

```
Phone (Expo app, Tailscale app on)
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
- The app is a separate client that talks to the same HTTP routes the TUI uses.

## Phase 1: Remote listener with token auth (daemon only)

**Goal:** a token-protected TCP port on loopback, verified with `curl` on the Mac.

1. **Config.** `~/.crewd/remote.json` holds `{ "port": <number> }`. The daemon reads it at startup. If the file is absent or invalid, remote is disabled and the daemon behaves exactly as today.
2. **Token module** (`apps/daemon/src/remote.ts`):
   - On first remote start, create `~/.crewd/remote-token` containing 32 random bytes, base64url-encoded, with mode `0600`. Reuse it on later starts.
   - Compare tokens in constant time (hash both with SHA-256, then `timingSafeEqual`).
   - Never log the token or request headers.
3. **Remote app.** Build a second Hono instance that applies auth middleware and then mounts the existing `app`. A request without `Authorization: Bearer <token>` gets 401. Log failed attempts (path only) to `daemon.log`.
4. **No Host check and no CORS.** A web page in a browser cannot send a custom `Authorization` header cross-origin without a CORS preflight, and the daemon never answers one. The page also cannot guess the token. So the token alone covers CSRF and DNS rebinding. Do not add CORS middleware. The native app does not need CORS either.
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

1. **Heartbeat.** In the events handler, run a ~15s interval that writes an SSE comment (`: ping`) to the stream, and clear it on abort. The existing client parser skips blocks without `data`, so the TUI is unaffected. Apply the same heartbeat to the global stream in Phase 9.
2. **Tail history.** Add `?turns=N` to `GET /sessions/:id/history`. It returns lines starting at the Nth-from-last user line, counting both `kind:'user'` and `ev.type:'user'`. Cutting at a turn boundary keeps `toBlocks` correct, and an open permission request is always in the latest turn, so it is never cut off. Without the parameter, behavior is unchanged. The app loads the tail, then subscribes with `after=<last seq>`.
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
4. The result is `https://<mac>.<tailnet>.ts.net`, proxying to `127.0.0.1:<port>`. HTTPS matters because iOS and Android block plain-HTTP requests from apps by default.

**Sleep prevention (macOS only):**
- `setStatus` in `sessions.ts` is the single place where session status changes.
- Keep a count of busy sessions (`running` or `waiting`). On 0→1, spawn `caffeinate -i -w <daemon pid>`. When the count returns to 0, kill it.
- Only do this on `darwin` and only when remote is enabled.
- `caffeinate -i` prevents idle sleep but not sleep from closing the lid. To close the lid, use an external display (clamshell mode) on power, or a tool like Amphetamine. Document this in the README.

**Checks:**
- From the phone browser, `https://<mac>.<tailnet>.ts.net/sessions` returns 401 (proves the path works and auth is on).
- Start a long-running session and confirm the Mac does not idle-sleep while it runs, and may sleep after it finishes.
- The port is not reachable from a device outside the tailnet.

## Phase 3b: Testing with ngrok (temporary alternative to Tailscale)

**Purpose:** let a developer test the remote listener and the app without setting up Tailscale. ngrok is for testing only. Tailscale remains the intended way to use the feature day to day.

**Scope of change:** none to the code. The daemon listener, the token, the heartbeat, the app and `caffeinate` behave the same. Only the command that exposes the port differs. Skip the "Tailscale setup" steps of Phase 3 and use the steps below instead.

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
6. In the app's Connect screen (Phase 5), enter `<url>` as the server address and the token, then tap "Test connection". It must succeed.
7. Run the Phase 5 checks.
8. When testing ends, stop ngrok (Ctrl+C in its terminal). The public URL stops working immediately.

### Expected results and what to do if they fail

| Check | Expected | If it fails |
| --- | --- | --- |
| No token returns 401 | `401` | The auth middleware is not applied to the remote app. Fix Phase 1 before continuing. |
| Token returns 200 | `200` | Check that the token in the header matches `~/.crewd/remote-token` exactly, with no trailing newline or quotes. |
| SSE stays open | `: ping` about every 15s | If the stream stalls, ngrok may be buffering. Confirm the heartbeat is implemented. If it still stalls, record it as an ngrok-specific limitation and test again with Tailscale. |
| App requests return an HTML warning page instead of JSON | JSON responses | ngrok's free tier can show an interstitial to browser-like clients. Add the request header `ngrok-skip-browser-warning: 1` in `apps/mobile/src/api.ts` and in the stream request. |
| App connects but every call returns 401 | Calls succeed | The token was saved with extra whitespace, or the wrong one. Re-enter it on the Connect screen. |

### Constraints (do not skip)

- The ngrok URL is public on the internet. The bearer token is the only protection. Keep the tunnel running only while testing.
- Never put the token in a URL or query string, and never paste it into logs, screenshots or chat.
- Do not leave the ngrok tunnel running overnight or unattended.
- Free ngrok URLs may change each run. Use the URL printed by the current ngrok session.

### Switching back to Tailscale

Stop ngrok and follow the Tailscale steps in Phase 3. Then change the server address in the app. No daemon code or config change is needed, because both options proxy to `127.0.0.1:<port>`.

## Phase 4: Extract shared code

**Goal:** the TUI and the app interpret the log with the same code.

1. Create `packages/shared`. It must contain no Node, Bun or React APIs. Its `package.json` should point `main` and `types` at the TypeScript source (`src/index.ts`) so Bun, the daemon bundler and Metro can all consume it. Move into it:
   - `toBlocks` and the `Item` / `Block` types;
   - the `ToolItem` type, so shared code does not import from `ui/ToolLine.tsx`;
   - a new pure function `foldState(lines, initial)` that returns what the `useMemo` in `useSession.ts` computes today: `status`, `commands`, `mode`, `modes`, `model`, `models`, and the map of open permission requests (a request is open until a `permission_resolved` for the same `requestId`). Token and cost totals can move with it. The "optimistic answered" set stays in each client;
   - `claudeModes` (the fallback mode list for Claude before the session reports its own);
   - the SSE block parser (the `data:` / `id:` loop in `packages/client`), as a pure function that takes text chunks and yields `{ id, data }`.
2. Rewire `apps/tui` (`useSession.ts`) and `packages/client` to import from it. Behavior must not change.
3. Add the package to the workspace and to the root `typecheck` script.

This touches working code, so it should be its own commit.

**Check:** `bun run typecheck` passes, and the TUI streams, folds and shows prompts exactly as before.

## Phase 5: The Expo app, core (`apps/mobile`)

**Goal:** connect, list sessions, read a session live, answer permission prompts, send and interrupt. Text is shown as plain text in this phase; markdown comes in Phase 6.

### Setup

- Create the app with Expo and TypeScript in `apps/mobile`, using `expo-router` for navigation, `expo-secure-store` for the token and server address, and `@react-native-async-storage/async-storage` for non-secret preferences.
- It imports `@crewd/protocol` (types and `routes`) and `@crewd/shared` (Phase 4).
- Add `apps/mobile` to the root `typecheck` script.
- **Risk: two copies of React.** `apps/tui` declares `react@^19.3.1`, while each Expo SDK pins its own React and React Native versions. Two different React copies in one Bun workspace can break hooks in Metro. At setup time, first try aligning versions (choose an Expo SDK whose React matches, or adjust the TUI's range). If that is not possible, keep `apps/mobile` out of the root `workspaces` list and consume `packages/protocol` and `packages/shared` through Metro `watchFolders`. Record which option was used in `ARCHITECTURE.md`.

### Network layer (`apps/mobile/src/api.ts`, `src/stream.ts`)

- `api.ts`: a thin wrapper that uses `routes` from `@crewd/protocol`, prepends the saved server address, and adds `Authorization: Bearer <token>`. A 401 sends the user to the Connect screen. A network error (not a 401) shows a "can't reach your Mac" banner with a retry button. It does not clear the saved token.
- `stream.ts`: streams SSE using the shared parser. React Native's built-in `fetch` does not expose streaming response bodies. Use `fetch` from `expo/fetch` (available in recent Expo SDKs), which supports a readable `response.body`. Verify against the chosen SDK version. If it does not stream, fall back to the `react-native-sse` package, which supports custom headers.
- Reconnect with the same backoff and `Last-Event-ID` approach as `packages/client`, plus the 35s no-data watchdog from Phase 2.
- Use `AppState`: on `active`, reconnect streams and refetch the session list; on `background`, abort streams.

### Screens

| Screen | Behavior |
| --- | --- |
| Connect | Fields for server address (must start with `https://`) and token. A "Test connection" button calls `GET /harnesses`. Save both in `expo-secure-store`. Also reachable from a settings button to change them later. |
| Sessions | Lists `GET /sessions` (polled every ~3s while the app is active until Phase 9 replaces polling). Sort `waiting` first, highlighted, then `running`, then by `updatedAt ?? createdAt`. Each row shows harness, title, folder name, status and age. Pull to refresh. |
| Session | See below. |

### Session screen

- On open: `GET /sessions/:id/history?turns=N`, run `toBlocks` and `foldState`, then subscribe to events with `after = last seq`.
- Render with a virtualized list (`FlatList`). Auto-scroll to the bottom only when the user is already at the bottom; otherwise show a "jump to latest" pill.
- Agent text: plain text (replaced by markdown in Phase 6). Thinking: dim and collapsed. Tool lines: one line showing tool name and a status icon; tap to expand input and output, truncating output at about 4 KB with a "show more" control.
- Header: harness, title, status dot, folder name.
- Permission card: pinned directly above the input bar (not inside the scrolling list) so it is always visible. Shows tool, title, a short input preview, and one button per option from `permission_request.options`, coloured by `kind` (`allow`, `always`, `deny`). On tap, mark the request answered locally, `POST` the answer, and on failure restore it. A 404 means it was already handled elsewhere, so refresh quietly instead of showing an error.
- Input bar: text field and send button (`POST /sessions/:id/messages`). While the status is `running` or `waiting`, show an interrupt button (`POST /sessions/:id/interrupt`). Handle the keyboard with `KeyboardAvoidingView` and safe-area insets.
- Do not use a WebView or any HTML rendering for agent or tool text.

### Checks (on a real phone, over Tailscale or ngrok)

- Connect screen: a wrong token shows a clear error; the right one saves and opens the session list.
- Send a prompt and watch it stream.
- Trigger a permission prompt and approve it from the phone.
- Turn on airplane mode mid-stream, turn it off, and confirm replay has no gaps or duplicates.
- Answer the same prompt from the TUI and the phone and confirm the loser ends cleanly.
- Restart the daemon with the app open and confirm it reconnects.
- Lock the phone for a minute, unlock it, and confirm the screen catches up.

## Phase 5b: Getting the app onto the phone

**Open question for the implementer: which phone (iOS or Android), and is there a paid Apple Developer account?** The answer chooses the row below. Do not assume.

| Situation | Approach |
| --- | --- |
| Development, on the same network as Metro | Run Expo Go (the app uses no custom native modules). The bundle comes from the Metro dev server on the Mac, which is only reachable while the phone can reach the Mac (at home, or through Tailscale). |
| Android, use away from home | Build a release APK (`eas build --profile preview` or a local Gradle build) and install it. Free. |
| iOS, no paid account | Build locally with Xcode and a free Apple ID. The install expires after about 7 days and must be reinstalled. |
| iOS, paid account | EAS Build and TestFlight, or ad hoc distribution. |

A standalone build bundles the JavaScript, so it works anywhere the phone can reach the daemon.

## Phase 6: Markdown rendering

**Goal:** agent text is rendered as formatted markdown, without hurting streaming performance or security.

1. **Library.** Use a React Native markdown renderer that produces native components, not HTML. `react-native-markdown-display` is the usual choice. Check its maintenance and compatibility with the chosen Expo SDK at implementation time, and pick a maintained fork if needed.
2. **Elements that must render:** headings, paragraphs, bold and italic, inline code, fenced code blocks, ordered and unordered lists, blockquotes, links, horizontal rules, and tables (agents produce tables often).
3. **Code blocks:** monospace font, a distinct background, horizontal scrolling instead of wrapping, and a copy button (use `expo-clipboard`). Syntax highlighting is not required.
4. **Streaming strategy** (important for phone CPU and battery):
   - Text items that are still open (`open === true` in `toBlocks`) change many times per second. Do not re-parse markdown on every chunk.
   - Render an open item as plain text, and render it as markdown once it closes (`open === false`). This also avoids a half-written code fence flipping the layout while it streams.
   - Memoize rendered markdown by item key and text.
5. **Links:** open only `http` and `https` links, using `Linking.openURL`, after a confirmation prompt that shows the full URL. Ignore every other scheme.
6. **Images in markdown:** do not load remote images automatically.
7. **Thinking and tool output** stay plain text.

**Checks:**
- A reply containing a table, a nested list and a fenced code block renders correctly.
- A long streaming answer stays smooth (no visible lag or dropped frames in the list).
- A link with a `javascript:` or custom scheme does nothing.

## Phase 7: Switching mode and model

**Goal:** change a session's permission mode and model from the app.

**Daemon changes:** none. `POST /sessions/:id/mode` takes `{ mode }` and `POST /sessions/:id/model` takes `{ model }`.

**App changes:**
1. Use `foldState` (Phase 4) to get `mode`, `modes`, `model`, `models` from the log.
2. In the session header, show two chips: the current mode and the current model. Tapping a chip opens a bottom sheet listing the options with labels and descriptions; the current one is marked.
3. On selection, `POST` the change and show a loading state on the chip. **Do not update the chip optimistically.** The log is the source of truth: a `mode` or `model` event arrives on the stream when the change takes effect, and that updates the chip. Clear the loading state when the event arrives, on an error response, or after about 10 seconds.
4. **Errors:** `400` (the harness rejected it) shows the server's message. `409` means the session is closed. A switch on an idle-stopped session starts the agent again first (the daemon does this), so allow several seconds.
5. **Empty lists:** a session that has not started yet may have empty `modes` or `models`. For Claude, fall back to `claudeModes` from `@crewd/shared`. For models, fall back to `GET /harnesses/:id/models?cwd=<session cwd>` and show a spinner while it loads (it can start an agent process; results are cached for 10 minutes).
6. **Bypass confirmation.** `bypassPermissions` appears in the list but requires a confirmation dialog explaining that the agent will run tools without asking. This mirrors the TUI, where bypass is only reachable through an explicit confirmation. It is a confirmation, not a restriction.
7. Remember the last model chosen per harness in AsyncStorage, for use by Phase 8.

**Checks:**
- Switch Claude between modes and see the chip update only after the event arrives.
- Switch the model on a running session and on an idle-stopped session.
- Choose bypass: the confirmation appears, and cancelling makes no request.
- Force a failing switch (for example, an invalid mode through `curl`) and confirm the error text appears.

## Phase 8: Starting new sessions

**Goal:** start a session on the Mac from the phone, in a project folder, with a harness, model and mode of choice.

### Daemon: a project list route

The phone cannot browse the Mac's filesystem. Add one small route.

- Add `projects: '/projects'` to `routes` in `packages/protocol/src/index.ts`, with a response type `ProjectInfo = { cwd: string; lastUsed: number; harnesses: string[] }`. Add a typed wrapper to `packages/client`.
- `GET /projects` builds the list from crewd's own sessions (`sessions.listOurs()`): group by `cwd`, keep the most recent `updatedAt ?? createdAt`, collect the harness ids used there, drop folders that no longer exist (`statSync`), drop throwaway folders under the temp directories (the TUI already has this rule in `isTemp`; move it to a shared place or duplicate it), sort newest first, cap at 50.
- Native sessions found in the harnesses' own stores are not included in this version. Sessions started through the TUI are crewd sessions, so they are covered.

### App: New session screen

A button on the Sessions screen opens a modal with these steps:

1. **Harness.** `GET /harnesses`, show those with `installed && !disabled`, with label and colour. Cache the result and refresh on pull-to-refresh.
2. **Project.** Show the `GET /projects` list (folder name, shortened path, last used). Below it, a text field for typing an absolute path. The daemon already validates it (`POST /sessions` returns 400 "cwd must be an existing absolute directory"), so show the server's message on error.
3. **Model** (optional). Fetch `GET /harnesses/:id/models?cwd=<cwd>` after the project is chosen. This may start an agent process, so show a spinner and allow "default" while it loads. If the response contains `error`, show it and allow "default". Pre-select the last model used for this harness (Phase 7, item 7).
4. **Mode** (optional, Claude and Qoder only). Offer `claudeModes`. Default to `auto`, matching the TUI's default. For ACP harnesses, omit `permissionMode`; the mode can be changed after the session starts (Phase 7).
5. **First message** (optional text field).
6. **Start.** `POST /sessions` with `{ harness, cwd, model?, permissionMode? }`. This call waits for the agent to be ready, so show a spinner and disable the button. On success, open the new session screen. If a first message was entered, `POST` it to `/messages` once the screen is open.

**Errors to handle:** harness not installed (400), invalid folder (400), request timeout or network loss (the session may have been created anyway, so refresh the session list before telling the user it failed).

**Optional extension (not required):** a directory browser backed by a new `GET /fs?path=` route that lists subdirectories under the home directory. Only add it if typing a path and the recent list prove too limiting.

**Checks:**
- Create a Claude session in a recent project with a chosen model, send a message, and see the response stream.
- Create an OpenCode session; confirm the mode picker is absent and appears in the session header after the first event.
- Type a non-existent path and confirm the error message.
- The new session also appears in the TUI.

## Phase 9: Global event stream for the session list

**Goal:** replace 3-second polling with a push stream, so status changes ("waiting", "running", new sessions) appear immediately.

### Daemon

1. **Route.** Add `allEvents: '/events'` to `routes` in `packages/protocol`. The path `/events` avoids clashing with `/sessions/:id`.
2. **Message types.** Each message is an SSE event:
   - `event: snapshot`, data: an array of `SessionMeta` (the same content as `GET /sessions`), sent immediately on connect;
   - `event: session`, data: one `SessionMeta`, sent whenever a session's metadata changes (including a new session, and a session that becomes `dead`);
   - a `: ping` comment every ~15s, as in Phase 2.
   There are no ids and no replay. A reconnect simply receives a new snapshot, which makes the protocol idempotent and avoids sequence bookkeeping.
3. **Publishing.** In `sessions.ts`, add a tiny in-memory subscriber set. Publish from the places where metadata really changes: `create`, `setStatus`, and the `mode`, `model`, `nativeId` and title updates (the spots that call `log.writeMeta`). A single helper that writes the meta and publishes keeps this in one place. **Do not publish from `emit()`**, because it runs for every streamed text chunk. Deleting a session marks it `dead` (files are kept), so publish it as a normal `session` message.
4. **Wire it up** in `server.ts` behind the same auth middleware (no extra work, since it mounts under the existing app).

### App

1. A `useSessionList` hook opens the stream with the shared parser, keeps a map by `id`, and replaces the whole map on each `snapshot`. Sorting follows the Sessions screen rules.
2. If the stream fails or stalls, fall back to the Phase 5 polling until it reconnects.
3. Keep it open while the app is active and on the list screen. The per-session stream remains separate. Close the list stream when the app goes to the background.

### Optional

The TUI's `useAllSessions` could use the same stream later. It is not required for this plan.

**Checks:**
- Start a session from the TUI and see it appear on the phone within a second.
- Make an agent request a permission: the row flips to `waiting` immediately.
- Streaming a long answer does not cause a flood of list updates (confirm in the daemon log or with `curl -N`).
- Kill and restart the daemon; the app reconnects and shows a fresh snapshot.

## Phase 10: Docs

- Update `ARCHITECTURE.md`. Design principle 4 says "no TCP listener", and the "Local security model" tradeoff names the socket as the only trust boundary. Both need to reflect the optional remote listener. Add `apps/mobile`, `packages/shared`, the `/projects` and `/events` routes, and the React-version decision from Phase 5.
- Add a README section: creating `remote.json`, where the token lives, the `tailscale serve` command, the sleep caveat, how to install the app (per Phase 5b), and how to connect it.

## Order

| Phase | Depends on |
| --- | --- |
| 1 Listener and auth | None |
| 2 Streaming hardening | 1 |
| 3 Tailscale and sleep prevention | 1 |
| 3b ngrok testing (optional, replaces the Tailscale setup while testing) | 1, 2 |
| 4 Shared code extraction | None (can run in parallel with 1–3) |
| 5 Expo app, core | 2, 4 |
| 5b Getting the app onto the phone | 5 |
| 6 Markdown rendering | 5 |
| 7 Mode and model switching | 4, 5 |
| 8 New sessions (includes the `/projects` route) | 1, 5, and 7 for the remembered model |
| 9 Global event stream | 2, 5 |
| 10 Docs | All |

The first usable result is after Phase 3 (`curl` over Tailscale works). The first end-to-end result is after Phase 5. Phases 6, 7, 8 and 9 are independent of each other and can be done in any order once Phase 5 works.

## Security notes

- Without the token, the daemon rejects every API call. With it, the holder has full control of the Mac through the agents: they can start sessions in any directory, edit the MCP server list (which defines commands the daemon launches), and switch sessions to bypass-permissions mode. This is an accepted tradeoff for a personal, single-user setup, with no remote restrictions.
- The token protects only against reaching the port. Keep the Tailscale boundary: only the user's own devices should be on the tailnet.
- Do not expose the port publicly (no Funnel, no long-running ngrok) with only this token in front.
- Store the token and server address in `expo-secure-store` (the system keychain or keystore), not in plain storage. Keep the token out of URLs, logs and screenshots.
- Render agent and tool output only through native components. Never inject it into a WebView or HTML, since a rendering bug would otherwise be a path to the stored token.
- Only open `http` and `https` links from agent output, and only after confirmation.

## Deferred (not in this plan)

- Push notifications (for example, the daemon posting to an ntfy.sh topic on `permission_request`).
- Image upload from the phone (`/messages` currently takes absolute paths on the Mac).
- Resuming sessions that exist only in a harness's own store (native sessions).
- Syntax highlighting in code blocks.
- A directory browser for choosing a project folder (see the optional note in Phase 8).
- Multiple Macs in one app.
- Token rotation, per-device tokens and audit trails.
