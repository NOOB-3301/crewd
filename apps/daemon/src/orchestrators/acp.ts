import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import type { Caps, Ev, Harness, LogLine, McpServer, SessionMeta } from '@crewd/protocol'
import { AsyncQueue } from '../util/async-queue.ts'
import { Orchestrator } from './orchestrator.ts'

// Agent Client Protocol: JSON-RPC 2.0, newline-delimited, over the agent's stdio.
// Spec: https://agentclientprotocol.com/protocol/schema

// JSON payloads from the agent are read defensively with optional chaining.
type Json = Record<string, any>
type AgentCaps = { loadSession?: boolean; sessionCapabilities?: { list?: object; fork?: object } }
type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void }

const METHOD_NOT_FOUND = -32601

class Rpc {
  private nextId = 0
  private pending = new Map<number, Pending>()
  private stderr: string[] = []
  private proc: ChildProcess
  onNotify: (method: string, params: Json) => void = () => {}
  /** Resolves with an error message, or undefined on a clean exit. */
  readonly exited: Promise<string | undefined>

  constructor(command: string[], cwd: string) {
    const [bin, ...args] = command
    if (!bin) throw new Error('ACP harness has no command')
    this.proc = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdin!.on('error', () => {}) // EPIPE after the agent dies is reported via exit
    createInterface({ input: this.proc.stdout! }).on('line', (l) => this.onLine(l))
    createInterface({ input: this.proc.stderr! }).on('line', (l) => {
      this.stderr.push(l)
      if (this.stderr.length > 20) this.stderr.shift()
    })
    this.exited = new Promise((resolve) => {
      const fail = (msg?: string) => {
        for (const p of this.pending.values()) p.reject(new Error(msg ?? `${bin} exited`))
        this.pending.clear()
        resolve(msg)
      }
      this.proc.on('error', (e) => fail(`${bin}: ${e.message}`))
      this.proc.on('exit', (code, signal) => {
        if (code === 0 || signal) return fail()
        fail(`${command.join(' ')} exited with code ${code}\n${this.stderr.join('\n')}`.trim())
      })
    })
  }

  /** onSettled runs synchronously with the response, before later lines are handled. */
  request(method: string, params: Json, onSettled?: () => void): Promise<Json> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => (onSettled?.(), resolve(v)),
        reject: (e) => (onSettled?.(), reject(e)),
      })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: Json) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  async close(graceMs = 2000) {
    this.proc.stdin!.end()
    const timer = setTimeout(() => this.proc.kill('SIGTERM'), graceMs)
    await this.exited
    clearTimeout(timer)
  }

  private write(msg: Json) {
    if (this.proc.stdin!.writable) this.proc.stdin!.write(JSON.stringify(msg) + '\n')
  }

  private onLine(line: string) {
    let msg: Json
    try {
      msg = JSON.parse(line)
    } catch {
      return // agents sometimes log to stdout; not protocol traffic
    }
    if (msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else p.resolve(msg.result ?? {})
    } else if (msg.id !== undefined) {
      const result = handleAgentRequest(msg.method, msg.params ?? {})
      this.write(result ? { jsonrpc: '2.0', id: msg.id, result } : {
        jsonrpc: '2.0', id: msg.id, error: { code: METHOD_NOT_FOUND, message: `${msg.method} not supported` },
      })
    } else {
      this.onNotify(msg.method, msg.params ?? {})
    }
  }
}

// Agent -> client requests. fs/* and terminal/* are not advertised, so they get method-not-found.
function handleAgentRequest(method: string, params: Json): Json | undefined {
  if (method !== 'session/request_permission') return undefined
  // shortcut: no approval UI in v1, so every tool call is auto-allowed (allow_once preferred); add a prompt in the TUI to gate it.
  const options: Json[] = params.options ?? []
  const pick = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always')
  return { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } }
}

async function initialize(rpc: Rpc) {
  const init = await rpc.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'crewd', version: '0.0.0' },
  })
  return (init.agentCapabilities ?? {}) as AgentCaps
}

/** Short-lived agent process for the static helpers; always killed. */
async function withAgent<T>(h: Harness, cwd: string, timeoutMs: number, fn: (rpc: Rpc, caps: AgentCaps) => Promise<T>) {
  const rpc = new Rpc(h.command ?? [], cwd)
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${h.id}: ACP agent timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([timeout, initialize(rpc).then((caps) => fn(rpc, caps))])
  } finally {
    clearTimeout(timer)
    await rpc.close(500)
  }
}

const toAcpMcp = (m: McpServer) => ({
  name: m.name,
  command: m.command,
  args: m.args ?? [],
  env: Object.entries(m.env ?? {}).map(([name, value]) => ({ name, value })),
})

const chunkText = (u: Json): string | undefined => (u.content?.type === 'text' ? u.content.text : undefined)

function updateToEv(u: Json): Ev[] {
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
      const name = u.title ?? u.kind ?? 'tool'
      const evs: Ev[] = [{ type: 'tool', id: u.toolCallId, name, status: 'start', input: u.rawInput }]
      return evs.concat(toolEnd(u)) // some agents report a tool already finished
    }
    case 'tool_call_update': {
      const end = toolEnd(u)
      if (end.length) return end
      break
    }
    case 'available_commands_update':
      return [{ type: 'commands', list: (u.availableCommands ?? []).map((c: Json) => c.name) }]
  }
  return [{ type: 'raw', data: u }]
}

function toolEnd(u: Json): Ev[] {
  if (u.status !== 'completed' && u.status !== 'failed') return []
  const status = u.status === 'completed' ? 'end' : 'error'
  return [{ type: 'tool', id: u.toolCallId, name: u.title ?? u.kind ?? 'tool', status, output: u.rawOutput ?? u.content }]
}

export class AcpOrchestrator extends Orchestrator {
  private rpc?: Rpc
  private agentCaps: AgentCaps = {}
  private out = new AsyncQueue<Ev>()
  private replaying = false
  private closing = false

  async start() {
    const rpc = (this.rpc = new Rpc(this.harness.command ?? [], this.cwd))
    const caps = (this.agentCaps = await initialize(rpc))
    rpc.onNotify = (method, params) => {
      if (method !== 'session/update' || this.replaying) return // load replays history crewd already logged
      for (const ev of updateToEv(params.update ?? {})) this.out.push(ev)
    }
    void rpc.exited.then((err) => {
      if (this.closing) return
      this.out.push({ type: 'error', message: err ?? `${this.harness.id} agent exited` })
      this.out.push({ type: 'status', state: 'dead' })
      this.out.close()
    })

    const mcpServers = this.mcp.filter((m) => m.enabled !== false).map(toAcpMcp)
    if (this.sessionId && caps.loadSession) {
      this.replaying = true
      await rpc.request('session/load', { sessionId: this.sessionId, cwd: this.cwd, mcpServers }, () => {
        this.replaying = false
      })
      this.nativeId = this.sessionId
    } else {
      const res = await rpc.request('session/new', { cwd: this.cwd, mcpServers })
      this.nativeId = res.sessionId
    }
  }

  async send(text: string) {
    const rpc = this.rpc
    if (!rpc || !this.nativeId) throw new Error('ACP session not started')
    this.out.push({ type: 'status', state: 'running' })
    // Not awaited: the turn streams via session/update; the response only marks its end.
    rpc.request('session/prompt', { sessionId: this.nativeId, prompt: [{ type: 'text', text }] }).then(
      (res) => this.out.push({ type: 'turn_end', usage: res }), // { stopReason, usage? }
      (err: Error) => this.out.push({ type: 'error', message: err.message }),
    )
  }

  async interrupt() {
    if (this.nativeId) this.rpc?.notify('session/cancel', { sessionId: this.nativeId })
  }

  async close() {
    this.closing = true
    await this.rpc?.close()
    this.out.close()
  }

  events() {
    return this.out
  }

  caps(): Caps {
    const sc = this.agentCaps.sessionCapabilities
    return { list: !!sc?.list, load: !!this.agentCaps.loadSession, fork: !!sc?.fork, interrupt: true }
  }

  static override async listSessions(h: Harness, cwd?: string): Promise<SessionMeta[]> {
    return withAgent(h, cwd ?? homedir(), 5000, async (rpc, caps) => {
      if (!caps.sessionCapabilities?.list) return []
      return (await listAll(rpc, cwd)).map((s) => ({
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
    return withAgent(h, homedir(), 15000, async (rpc, caps) => {
      if (!caps.loadSession) return []
      // session/load needs the session's cwd; find it via session/list when the agent has it.
      const known = caps.sessionCapabilities?.list ? (await listAll(rpc)).find((s) => s.sessionId === nativeId) : undefined
      const updates: Json[] = []
      rpc.onNotify = (method, params) => {
        if (method === 'session/update' && params.update) updates.push(params.update)
      }
      await rpc.request('session/load', { sessionId: nativeId, cwd: known?.cwd ?? homedir(), mcpServers: [] })
      return toLogLines(updates)
    })
  }
}

async function listAll(rpc: Rpc, cwd?: string): Promise<Json[]> {
  const sessions: Json[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const res = await rpc.request('session/list', { ...(cwd && { cwd }), ...(cursor && { cursor }) })
    sessions.push(...(res.sessions ?? []))
    cursor = res.nextCursor ?? undefined
    if (!cursor) break
  }
  return sessions
}

// Replayed chunks arrive word-by-word; merge consecutive chunks of the same kind into one line.
function toLogLines(updates: Json[]): LogLine[] {
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
