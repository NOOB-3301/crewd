import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { Readable, Writable } from 'node:stream'
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type ClientConnection,
  type McpServer as AcpMcpServer,
  type PermissionOptionKind,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModeState,
  type SessionUpdate,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk'
import type { Caps, Ev, Harness, LogLine, McpServer, ModeId, ModeInfo, PermissionOption, SessionMeta } from '@crewd/protocol'
import { AsyncQueue } from '../util/async-queue.ts'
import { Orchestrator, summary, type Image } from './orchestrator.ts'

// Agent Client Protocol over the agent's stdio, via the official SDK (stable ACP v1).
// Spec: https://agentclientprotocol.com/protocol/schema

type Agent = {
  conn: ClientConnection
  /** initialize result; rejects if the agent fails to start. */
  ready: Promise<AgentCapabilities>
  /** Resolves with an error message, or undefined on a clean exit. */
  exited: Promise<string | undefined>
  close(graceMs?: number): Promise<void>
}
type OnPermission = (p: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionResponse>

/** Spawns the agent and initializes. fs/* and terminal/* are not advertised, so the SDK answers them method-not-found. */
function spawnAgent(h: Harness, cwd: string, onUpdate: (u: SessionUpdate) => void, onPermission?: OnPermission): Agent {
  const [bin, ...args] = h.command ?? []
  if (!bin) throw new Error('ACP harness has no command')
  const proc = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  proc.stdin.on('error', () => {}) // EPIPE after the agent dies is reported via exit
  const stderr: string[] = []
  createInterface({ input: proc.stderr }).on('line', (l) => {
    stderr.push(l)
    if (stderr.length > 20) stderr.shift()
  })
  const exited = new Promise<string | undefined>((resolve) => {
    proc.on('error', (e) => resolve(`${bin}: ${e.message}`))
    proc.on('exit', (code, signal) =>
      resolve(code === 0 || signal ? undefined : `${h.command!.join(' ')} exited with code ${code}\n${stderr.join('\n')}`.trim()),
    )
  })

  const conn = client({ name: 'crewd' })
    .onNotification(methods.client.session.update, ({ params }) => onUpdate(params.update))
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
      onPermission ? onPermission(params, signal) : { outcome: { outcome: 'cancelled' } },
    )
    .connect(ndJsonStream(Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>, Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>))
  // Requests in flight when the agent dies fail with its exit message instead of hanging.
  void exited.then((err) => conn.close(new Error(err ?? `${bin} exited`)))

  const ready = conn.agent
    .request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'crewd', version: '0.0.0' },
    })
    .then((init) => init.agentCapabilities ?? {})
  ready.catch(() => {}) // callers await it; this only stops an unhandled rejection when they don't
  return {
    conn,
    ready,
    exited,
    async close(graceMs = 2000) {
      conn.close()
      proc.stdin.end()
      const timer = setTimeout(() => proc.kill('SIGTERM'), graceMs)
      await exited
      clearTimeout(timer)
    },
  }
}

/** Short-lived agent process for the static helpers; always killed. Every session/update is collected. */
async function withAgent<T>(h: Harness, cwd: string, timeoutMs: number, fn: (a: Agent, caps: AgentCapabilities, updates: SessionUpdate[]) => Promise<T>) {
  const updates: SessionUpdate[] = []
  const a = spawnAgent(h, cwd, (u) => updates.push(u))
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${h.id}: ACP agent timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([timeout, a.ready.then((caps) => fn(a, caps, updates))])
  } finally {
    clearTimeout(timer)
    await a.close(500)
  }
}

const toAcpMcp = (m: McpServer): AcpMcpServer => ({
  name: m.name,
  command: m.command,
  args: m.args ?? [],
  env: Object.entries(m.env ?? {}).map(([name, value]) => ({ name, value })),
})

const chunkText = (u: SessionUpdate): string | undefined =>
  'content' in u && u.content && !Array.isArray(u.content) && u.content.type === 'text' ? u.content.text : undefined

// What session/load replays: history crewd already logged.
const HISTORY = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'])

const toolName = (t: ToolCallUpdate) => t.title ?? t.kind ?? 'tool'

function updateToEv(u: SessionUpdate): Ev[] {
  const text = chunkText(u)
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
      if (text !== undefined) return [{ type: 'text', text, partial: true }]
      break
    case 'agent_thought_chunk':
      if (text !== undefined) return [{ type: 'thinking', text }]
      break
    case 'user_message_chunk':
      if (text !== undefined) return [{ type: 'user', text }]
      break
    case 'tool_call': {
      const evs: Ev[] = [{ type: 'tool', id: u.toolCallId, name: toolName(u), status: 'start', input: u.rawInput }]
      return evs.concat(toolEnd(u)) // some agents report a tool already finished
    }
    case 'tool_call_update': {
      const end = toolEnd(u)
      if (end.length) return end
      break
    }
    case 'available_commands_update':
      return [
        {
          type: 'commands',
          list: u.availableCommands.map((c) => ({ name: c.name, description: c.description || undefined, hint: c.input?.hint || undefined })),
        },
      ]
  }
  return [{ type: 'raw', data: u }]
}

function toolEnd(u: ToolCallUpdate): Ev[] {
  if (u.status !== 'completed' && u.status !== 'failed') return []
  const status = u.status === 'completed' ? 'end' : 'error'
  return [{ type: 'tool', id: u.toolCallId, name: toolName(u), status, output: u.rawOutput ?? u.content }]
}

const KIND: Record<PermissionOptionKind, PermissionOption['kind']> = {
  allow_once: 'allow',
  allow_always: 'always',
  reject_once: 'deny',
  reject_always: 'deny',
}

export class AcpOrchestrator extends Orchestrator {
  private agent?: Agent
  private agentCaps: AgentCapabilities = {}
  private out = new AsyncQueue<Ev>()
  private replaying = false
  private closing = false
  private modes?: ModeInfo[]
  /** set when the agent exposes modes as a 'mode' config option (newer agents, e.g. OpenCode) instead of `modes` */
  private modeConfigId?: string

  async start() {
    const agent = (this.agent = spawnAgent(
      this.harness,
      this.cwd,
      (u) => this.onUpdate(u),
      (p, signal) => this.onPermission(p, signal),
    ))
    void agent.exited.then((err) => {
      if (this.closing) return
      this.out.push({ type: 'error', message: err ?? `${this.harness.id} agent exited` })
      this.out.push({ type: 'status', state: 'dead' })
      this.out.close()
    })
    try {
      await this.open(agent)
    } catch (err) {
      await this.close()
      throw err
    }
  }

  private async open(agent: Agent) {
    const caps = (this.agentCaps = await agent.ready)
    const mcpServers = this.mcp.filter((m) => m.enabled !== false).map(toAcpMcp)
    let res: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }
    if (this.sessionId && caps.sessionCapabilities?.resume) {
      // resume: no replay at all
      res = await agent.conn.agent.request(methods.agent.session.resume, { sessionId: this.sessionId, cwd: this.cwd, mcpServers })
    } else if (this.sessionId && caps.loadSession) {
      this.replaying = true
      try {
        res = await agent.conn.agent.request(methods.agent.session.load, { sessionId: this.sessionId, cwd: this.cwd, mcpServers })
      } finally {
        this.replaying = false
      }
    } else {
      const created = await agent.conn.agent.request(methods.agent.session.new, { cwd: this.cwd, mcpServers })
      this.nativeId = created.sessionId
      res = created
    }
    const current = this.readModes(res)
    if (current === undefined) return // no modes advertised: no mode event
    if (this.startMode && this.startMode !== current && this.modes!.some((m) => m.id === this.startMode)) await this.setMode(this.startMode)
    else this.out.push({ type: 'mode', mode: current, available: this.modes! })
  }

  /** Stores the advertised modes and returns the current one; a 'mode' config option wins over legacy `modes`. */
  private readModes(r: { modes?: SessionModeState | null; configOptions?: SessionConfigOption[] | null }): ModeId | undefined {
    const cfg = r.configOptions?.find((o) => o.category === 'mode')
    if (cfg?.type === 'select') {
      this.modeConfigId = cfg.id
      this.modes = cfg.options
        .flatMap((o) => ('options' in o ? o.options : [o]))
        .map((o) => ({ id: o.value, label: o.name, description: o.description ?? undefined }))
      return cfg.currentValue
    }
    if (!r.modes) return undefined
    this.modes = r.modes.availableModes.map((m) => ({ id: m.id, label: m.name, description: m.description ?? undefined }))
    return r.modes.currentModeId
  }

  private onUpdate(u: SessionUpdate) {
    if (this.replaying && HISTORY.has(u.sessionUpdate)) return
    if (u.sessionUpdate === 'current_mode_update' && this.modes)
      return this.out.push({ type: 'mode', mode: u.currentModeId, available: this.modes })
    if (u.sessionUpdate === 'config_option_update') {
      const mode = this.readModes(u)
      if (mode !== undefined) this.out.push({ type: 'mode', mode, available: this.modes! })
    }
    for (const ev of updateToEv(u)) this.out.push(ev)
  }

  private async onPermission(p: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const optionId = await this.askUser(
      {
        tool: toolName(p.toolCall),
        title: summary(p.toolCall.rawInput),
        input: p.toolCall.rawInput,
        options: p.options.map((o) => ({ id: o.optionId, label: o.name, kind: KIND[o.kind] })),
      },
      signal,
    )
    return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } }
  }

  async send(text: string, images: Image[] = []) {
    const agent = this.agent
    if (!agent || !this.nativeId) throw new Error('ACP session not started')
    if (images.length && !this.agentCaps.promptCapabilities?.image) {
      this.out.push({ type: 'error', message: `${this.harness.label} can't take images; sent the text only` })
      images = []
    }
    this.out.push({ type: 'status', state: 'running' })
    const prompt = [...images.map((i) => ({ type: 'image' as const, mimeType: i.mime, data: i.data })), { type: 'text' as const, text }]
    // Not awaited: the turn streams via session/update; the response only marks its end.
    agent.conn.agent.request(methods.agent.session.prompt, { sessionId: this.nativeId, prompt }).then(
      (res) => this.out.push({ type: 'turn_end', usage: res }), // { stopReason, usage? }
      (err: Error) => this.out.push({ type: 'error', message: err.message }),
    )
  }

  async interrupt() {
    if (this.nativeId) await this.agent?.conn.agent.notify(methods.agent.session.cancel, { sessionId: this.nativeId })
  }

  async setMode(mode: ModeId) {
    if (!this.agent || !this.nativeId) throw new Error('ACP session not started')
    if (!this.modes?.some((m) => m.id === mode)) throw new Error(`${this.harness.label} has no mode ${mode}`)
    const sessionId = this.nativeId
    if (this.modeConfigId)
      await this.agent.conn.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: this.modeConfigId, value: mode })
    else await this.agent.conn.agent.request(methods.agent.session.setMode, { sessionId, modeId: mode })
    this.out.push({ type: 'mode', mode, available: this.modes })
  }

  async close() {
    this.closing = true
    await this.agent?.close()
    this.out.close()
  }

  events() {
    return this.out
  }

  caps(): Caps {
    const sc = this.agentCaps.sessionCapabilities
    // fork is unstable-only in ACP v1, so it is missing from the stable types.
    return { list: !!sc?.list, load: !!this.agentCaps.loadSession, fork: !!(sc as { fork?: unknown })?.fork, interrupt: true }
  }

  static override async listSessions(h: Harness, cwd?: string): Promise<SessionMeta[]> {
    return withAgent(h, cwd ?? homedir(), 5000, async (a, caps) => {
      if (!caps.sessionCapabilities?.list) return []
      return (await listAll(a, cwd)).map((s) => ({
        id: s.sessionId,
        harness: h.id,
        nativeId: s.sessionId,
        cwd: s.cwd,
        title: s.title ?? undefined,
        status: 'idle' as const,
        createdAt: s.updatedAt ? Date.parse(s.updatedAt) : 0,
        updatedAt: s.updatedAt ? Date.parse(s.updatedAt) : undefined,
        source: 'native' as const,
      }))
    })
  }

  static override async loadHistory(h: Harness, nativeId: string): Promise<LogLine[]> {
    return withAgent(h, homedir(), 15000, async (a, caps, updates) => {
      if (!caps.loadSession) return []
      // session/load needs the session's cwd; find it via session/list when the agent has it.
      const known = caps.sessionCapabilities?.list ? (await listAll(a)).find((s) => s.sessionId === nativeId) : undefined
      updates.length = 0
      await a.conn.agent.request(methods.agent.session.load, { sessionId: nativeId, cwd: known?.cwd ?? homedir(), mcpServers: [] })
      return toLogLines(updates)
    })
  }
}

async function listAll(a: Agent, cwd?: string): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const res = await a.conn.agent.request(methods.agent.session.list, { ...(cwd && { cwd }), ...(cursor && { cursor }) })
    sessions.push(...res.sessions)
    cursor = res.nextCursor ?? undefined
    if (!cursor) break
  }
  return sessions
}

// Replayed chunks arrive word-by-word; merge consecutive chunks of the same kind into one line.
function toLogLines(updates: SessionUpdate[]): LogLine[] {
  const lines: LogLine[] = []
  const ts = Date.now()
  let prevKind: string | undefined
  for (const u of updates) {
    const last = lines.at(-1)
    const text = chunkText(u)
    if (text !== undefined && u.sessionUpdate === prevKind && last) {
      if (last.kind === 'user') last.text += text
      else if (last.ev.type === 'text' || last.ev.type === 'thinking') last.ev.text += text
      continue
    }
    prevKind = text !== undefined ? u.sessionUpdate : undefined
    for (const ev of updateToEv(u)) {
      const seq = lines.length + 1
      if (ev.type === 'user') lines.push({ seq, ts, kind: 'user', text: ev.text })
      else lines.push({ seq, ts, kind: 'event', ev: ev.type === 'text' ? { type: 'text', text: ev.text } : ev })
    }
  }
  return lines
}
