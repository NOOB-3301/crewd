// crewd's log folding and SSE block parsing, shared verbatim by every client (TUI, phone).
// No Node, Bun or React APIs may be imported here: Metro bundles this source for the app.
import type { Cmd, Ev, LogLine, ModeId, ModeInfo, ModelInfo, SessionMeta, SessionStatus } from '@crewd/protocol'

export type ToolItem = {
  k: 'tool'; id: string; name: string; status: 'start' | 'end' | 'error'
  input?: unknown; output?: unknown; startTs: number; endTs?: number
}

export type Item = { k: 'text'; text: string; open: boolean } | { k: 'thinking'; text: string; key: string } | (ToolItem & { key: string })
export type Block = { who: 'you'; text: string } | { who: 'agent'; items: Item[] } | { who: 'error'; message: string }
export type Pending = Extract<Ev, { type: 'permission_request' }>

/** Claude's PermissionModes a client offers before the session reports its own list. */
export const claudeModes: ModeInfo[] = ['auto', 'default', 'acceptEdits', 'plan'].map((id) => ({ id, label: id }))

/** Folds the log into speaker blocks: merges partial text, pairs tool start/end by id, merges thinking. */
export function toBlocks(lines: LogLine[]): Block[] {
  const blocks: Block[] = []
  const tools = new Map<string, ToolItem & { key: string }>()
  const agent = (): Item[] => {
    const last = blocks.at(-1)
    if (last?.who === 'agent') return last.items
    const b: Block = { who: 'agent', items: [] }
    blocks.push(b)
    return b.items
  }
  for (const l of lines) {
    if (l.kind === 'user') { blocks.push({ who: 'you', text: l.text }); continue }
    const ev = l.ev
    if (ev.type === 'user') blocks.push({ who: 'you', text: ev.text })
    else if (ev.type === 'error') blocks.push({ who: 'error', message: ev.message })
    else if (ev.type === 'text') {
      const items = agent()
      const last = items.at(-1)
      // Partial chunks append; the final full message that follows them replaces the streamed text.
      if (last?.k === 'text' && last.open) { last.text = ev.partial ? last.text + ev.text : ev.text; last.open = !!ev.partial }
      else items.push({ k: 'text', text: ev.text, open: !!ev.partial })
    } else if (ev.type === 'thinking') {
      const items = agent()
      const last = items.at(-1)
      if (last?.k === 'thinking') last.text += '\n' + ev.text
      else items.push({ k: 'thinking', text: ev.text, key: `th${l.seq}` })
    } else if (ev.type === 'tool') {
      let t = tools.get(ev.id)
      if (!t) {
        t = { k: 'tool', key: `tool${ev.id}`, id: ev.id, name: ev.name, status: ev.status, input: ev.input, startTs: l.ts }
        tools.set(ev.id, t)
        agent().push(t)
      }
      t.input ??= ev.input
      if (ev.status !== 'start') Object.assign(t, { status: ev.status, output: ev.output, endTs: l.ts })
    }
  }
  return blocks
}

/** Everything a session screen shows that the log can answer, seeded from the metadata the client already has. */
export type FoldedState = {
  status: SessionStatus
  tokens: number
  cost: number
  commands: Cmd[]
  mode?: ModeId
  modes: ModeInfo[]
  model?: string
  models: ModelInfo[]
  /** open permission requests, by requestId: requested and not yet resolved by any client */
  requests: Map<string, Pending>
}

function usageTokens(u: unknown): number {
  if (!u || typeof u !== 'object') return 0
  const o = u as Record<string, unknown>
  return [o.input_tokens, o.output_tokens, o.inputTokens, o.outputTokens].reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0)
}

/** Folds the log into the session's current state. Deciding what to do with `requests` stays with each client. */
export function foldState(lines: LogLine[], initial: SessionMeta): FoldedState {
  let status: SessionStatus = initial.status, tokens = 0, cost = 0, commands: Cmd[] = []
  let mode = initial.permissionMode, modes: ModeInfo[] = []
  let model = initial.model, models: ModelInfo[] = []
  const requests = new Map<string, Pending>()
  for (const l of lines) {
    if (l.kind !== 'event') continue
    const ev = l.ev
    if (ev.type === 'status') status = ev.state
    else if (ev.type === 'commands') commands = ev.list
    else if (ev.type === 'mode') { mode = ev.mode; modes = ev.available }
    else if (ev.type === 'model') { model = ev.model ?? model; models = ev.available }
    else if (ev.type === 'permission_request') requests.set(ev.requestId, ev)
    else if (ev.type === 'permission_resolved') requests.delete(ev.requestId)
    // costUsd is the SDK's running total for the session, so keep the latest instead of summing
    else if (ev.type === 'turn_end') { tokens += usageTokens(ev.usage); cost = ev.costUsd ?? cost }
  }
  if (!modes.length && initial.harness === 'claude') modes = claudeModes
  return { status, tokens, cost, commands, mode, modes, model, models, requests }
}

export type SseBlock = { id?: string; data: string }

/** SSE block parser: feed it text chunks, get the blocks they complete. Blocks without data (a `: ping`) are skipped. */
export function sseBlocks(): (chunk: string) => SseBlock[] {
  let buf = ''
  return (chunk) => {
    buf += chunk.replace(/\r\n/g, '\n')
    const out: SseBlock[] = []
    let end: number
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, end)
      buf = buf.slice(end + 2)
      let data = ''
      let id: string | undefined
      for (const l of block.split('\n')) {
        if (l.startsWith('data:')) data += (data ? '\n' : '') + l.slice(5).trimStart()
        else if (l.startsWith('id:')) id = l.slice(3).trim()
      }
      if (data) out.push({ id, data })
    }
    return out
  }
}
