import { useEffect, useMemo, useRef, useState } from 'react'
import type { Cmd, Ev, HarnessInfo, ImageRef, LogLine, ModeId, ModeInfo, SessionMeta, SessionStatus } from '@crewd/protocol'
import * as client from '@crewd/client'
import type { ToolItem } from './ui/ToolLine.tsx'
import { readPref } from './prefs.ts'

export type Item = { k: 'text'; text: string; open: boolean } | { k: 'thinking'; text: string; key: string } | (ToolItem & { key: string })
export type Block = { who: 'you'; text: string } | { who: 'agent'; items: Item[] } | { who: 'error'; message: string }
export type Pending = Extract<Ev, { type: 'permission_request' }>

/** Claude's PermissionModes the TUI offers before the session reports its own list. */
export const claudeModes: ModeInfo[] = ['auto', 'default', 'acceptEdits', 'plan'].map((id) => ({ id, label: id }))
export const defaultMode = (): ModeId => readPref<{ defaultMode?: ModeId }>('tui.json', {}).defaultMode ?? 'auto'

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

function usageTokens(u: unknown): number {
  if (!u || typeof u !== 'object') return 0
  const o = u as Record<string, unknown>
  return [o.input_tokens, o.output_tokens, o.inputTokens, o.outputTokens].reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0)
}

/** One session's log: history + live stream folded into what a chat view or a tile shows, plus its actions. */
export function useSession(initial: SessionMeta, harness: HarnessInfo, onLive?: (s: SessionMeta) => void) {
  const [session, setSession] = useState(initial)
  const [past, setPast] = useState<LogLine[]>([]) // native history kept on screen after we take the session over
  const [lines, setLines] = useState<LogLine[]>([])
  const [answered, setAnswered] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')

  useEffect(() => {
    let unsub = () => {}
    let gone = false
    client.history(session.id).then((h) => {
      if (gone) return
      setLines(h)
      if (session.source === 'crewd') unsub = client.subscribe(session.id, (l) => setLines((p) => [...p, l]), { after: h.at(-1)?.seq })
    }).catch((e) => setErr(`Could not load this session: ${e.message}. Press ctrl+o to go back to the list.`))
    return () => { gone = true; unsub() }
  }, [session.id])

  // shortcut: refolds the whole log on every line; fine for normal sessions, memoize per block if huge logs lag.
  const all = useMemo(() => [...past, ...lines], [past, lines])
  const blocks = useMemo(() => toBlocks(all), [all])
  const derived = useMemo(() => {
    let status: SessionStatus = session.status, tokens = 0, cost = 0, commands: Cmd[] = []
    let mode = session.permissionMode, modes: ModeInfo[] = []
    const asks = new Map<string, Pending>()
    for (const l of lines) {
      if (l.kind !== 'event') continue
      const ev = l.ev
      if (ev.type === 'status') status = ev.state
      else if (ev.type === 'commands') commands = ev.list
      else if (ev.type === 'mode') { mode = ev.mode; modes = ev.available }
      else if (ev.type === 'permission_request') asks.set(ev.requestId, ev)
      else if (ev.type === 'permission_resolved') asks.delete(ev.requestId)
      // costUsd is the SDK's running total for the session, so keep the latest instead of summing
      else if (ev.type === 'turn_end') { tokens += usageTokens(ev.usage); cost = ev.costUsd ?? cost }
    }
    if (!modes.length && harness.id === 'claude') modes = claudeModes
    const pending = [...asks.values()].find((a) => !answered.has(a.requestId))
    return { status, tokens, cost, commands, mode, modes, pending }
  }, [lines, session.status, session.permissionMode, answered])

  // A session found in the harness's own store has no live process; resuming it gives us one (and its commands).
  const live = useRef<Promise<SessionMeta> | null>(null)
  function goLive(): Promise<SessionMeta> {
    if (session.source !== 'native') return Promise.resolve(session)
    live.current ??= client.createSession({
      harness: harness.id, cwd: session.cwd, resumeId: session.nativeId ?? session.id,
      permissionMode: harness.id === 'claude' ? defaultMode() : undefined,
    }).then((s) => {
      setPast(all)
      setLines([])
      setSession(s)
      onLive?.(s)
      return s
    }, (e) => { live.current = null; throw e })
    return live.current
  }

  /** Resolves true once sent; on failure sets err and resolves false so the caller can restore the draft. */
  async function send(text: string, images?: ImageRef[]): Promise<boolean> {
    setErr('')
    try {
      const s = await goLive()
      await client.send(s.id, text, images)
      return true
    } catch (e: any) {
      setErr(`Not sent: ${e.message}. Press enter to retry.`)
      return false
    }
  }

  async function stop() {
    try { await client.interrupt(session.id) } catch (e: any) { setErr(`Could not stop the turn: ${e.message}`) }
  }

  async function answer(requestId: string, optionId: string) {
    setAnswered((a) => new Set(a).add(requestId))
    try { await client.answerPermission(session.id, requestId, optionId) } catch (e: any) {
      setAnswered((a) => { const n = new Set(a); n.delete(requestId); return n })
      setErr(`Could not answer the permission request: ${e.message}`)
    }
  }

  async function setMode(mode: ModeId) {
    try {
      const s = await goLive()
      await client.setMode(s.id, mode)
      setErr('')
    } catch (e: any) { setErr(`Could not switch to ${mode}: ${e.message}`) }
  }

  /** Next mode in the session's list, skipping bypassPermissions (only reachable through /permissions). */
  function cycleMode() {
    const list = derived.modes.filter((m) => m.id !== 'bypassPermissions')
    if (!list.length) return setErr(`${harness.label} has not reported any modes for this session yet.`)
    const i = list.findIndex((m) => m.id === derived.mode)
    return setMode(list[(i + 1) % list.length]!.id)
  }

  return { session, harness, blocks, ...derived, err, setErr, goLive, send, stop, answer, setMode, cycleMode }
}

export type SessionState = ReturnType<typeof useSession>
