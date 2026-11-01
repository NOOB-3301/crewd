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

export type SessionStatus = 'running' | 'idle' | 'interrupted' | 'dead'

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
}

// crewd's UI vocabulary, not a list of harness events. Orchestrators map what the TUI
// renders differently; everything else becomes `raw` so nothing is dropped.
export type Ev =
  | { type: 'user'; text: string }
  | { type: 'text'; text: string; partial?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'tool'; id: string; name: string; status: 'start' | 'end' | 'error'; input?: unknown; output?: unknown }
  | { type: 'turn_end'; usage?: unknown; costUsd?: number }
  | { type: 'status'; state: SessionStatus }
  | { type: 'commands'; list: string[] }
  | { type: 'error'; message: string }
  | { type: 'raw'; data: unknown }

export type LogLine = { seq: number; ts: number } & ({ kind: 'user'; text: string } | { kind: 'event'; ev: Ev })

export type McpServer = { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }

export type HarnessInfo = Harness & { installed: boolean; caps: Caps; count: number }

// Request bodies
export type CreateSessionBody = { harness: string; cwd: string; resumeId?: string; mcp?: string[] }
export type SendBody = { text: string }

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
  mcp: '/mcp',
} as const
