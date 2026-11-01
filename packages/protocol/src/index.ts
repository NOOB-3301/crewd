// Shared contract between the crewd daemon and its clients.

export type HarnessKind = 'acp' | 'sdk'

export type Harness = {
  id: string
  label: string
  kind: HarnessKind
  /** acp only: command that starts the agent in ACP mode, e.g. ["opencode", "acp"] */
  command?: string[]
  /** accent color for the TUI; falls back to a palette entry */
  color?: string
  /** hidden from pickers until its binary exists */
  disabled?: boolean
}

export type Caps = { list: boolean; load: boolean; fork: boolean; interrupt: boolean }

/** running = turn in progress; waiting = turn blocked on a permission_request the user must answer. */
export type SessionStatus = 'running' | 'waiting' | 'idle' | 'interrupted' | 'dead'

/** A mode id as the harness names it: Claude's PermissionMode ('auto', 'default', 'acceptEdits', 'plan',
 * 'bypassPermissions', ...) or an ACP agent's own SessionMode id (e.g. OpenCode 'build' / 'plan'). */
export type ModeId = string
export type ModeInfo = { id: ModeId; label: string; description?: string }

/** One answer the user can pick for a permission request. kind drives the TUI keys (1/y allow, 2/a always, 3/n deny). */
export type PermissionOption = { id: string; label: string; kind: 'allow' | 'always' | 'deny' }

export type SessionMeta = {
  id: string
  harness: string
  /** the harness's own session id, used to resume */
  nativeId?: string
  /** fixed for the session's life: Claude resume is keyed by cwd */
  cwd: string
  title?: string
  status: SessionStatus
  createdAt: number
  updatedAt?: number
  /** crewd = started here (has log.jsonl); native = found in the harness's own store */
  source: 'crewd' | 'native'
  /** MCP server names picked at create time; undefined = the enabled ones */
  mcp?: string[]
  /** current mode; undefined until the harness reports one (or for harnesses without modes) */
  permissionMode?: ModeId
}

/** A slash command as the harness reports it (name without the leading slash). */
export type Cmd = { name: string; description?: string; hint?: string }

// crewd's UI vocabulary, not a list of harness events. Orchestrators map what the TUI
// renders differently; everything else becomes `raw` so nothing is dropped.
export type Ev =
  | { type: 'user'; text: string }
  | { type: 'text'; text: string; partial?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; status: 'start' | 'end' | 'error'; input?: unknown; output?: unknown }
  | { type: 'turn_end'; usage?: unknown; costUsd?: number }
  | { type: 'status'; state: SessionStatus }
  | { type: 'commands'; list: Cmd[] }
  /** the agent asks before running a tool; answer with POST routes.permission(sessionId, requestId) */
  | { type: 'permission_request'; requestId: string; tool: string; title?: string; input?: unknown; options: PermissionOption[] }
  /** sent once a request is answered (by any client), interrupted, or cancelled by the agent; optionId absent = cancelled */
  | { type: 'permission_resolved'; requestId: string; optionId?: string }
  /** current mode plus the modes this session can switch to (Claude: its PermissionModes; ACP: the agent's own) */
  | { type: 'mode'; mode: ModeId; available: ModeInfo[] }
  | { type: 'error'; message: string }
  | { type: 'raw'; data: unknown }

export type LogLine = { seq: number; ts: number } & ({ kind: 'user'; text: string } | { kind: 'event'; ev: Ev })

export type McpServer = { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }

export type HarnessInfo = Harness & { installed: boolean; caps: Caps; count: number }

// Request bodies
export type CreateSessionBody = { harness: string; cwd: string; resumeId?: string; mcp?: string[]; permissionMode?: ModeId }
/** images: absolute paths to image files on this machine; the daemon reads and encodes them for the harness. */
export type ImageRef = { path: string; mime: string }
export type SendBody = { text: string; images?: ImageRef[] }
export type PermissionAnswerBody = { optionId: string }
export type ModeBody = { mode: ModeId }

export const SOCKET_NAME = 'crewd.sock'

export const routes = {
  harnesses: '/harnesses',
  harnessSessions: (id: string) => `/harnesses/${encodeURIComponent(id)}/sessions`,
  sessions: '/sessions',
  session: (id: string) => `/sessions/${encodeURIComponent(id)}`,
  history: (id: string) => `/sessions/${encodeURIComponent(id)}/history`,
  messages: (id: string) => `/sessions/${encodeURIComponent(id)}/messages`,
  interrupt: (id: string) => `/sessions/${encodeURIComponent(id)}/interrupt`,
  events: (id: string) => `/sessions/${encodeURIComponent(id)}/events`,
  permission: (id: string, requestId: string) => `/sessions/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`,
  mode: (id: string) => `/sessions/${encodeURIComponent(id)}/mode`,
  mcp: '/mcp',
} as const
