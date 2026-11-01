import { useEffect, useMemo, useRef, useState } from 'react'
import type { ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import type { Cmd, HarnessInfo, LogLine, SessionMeta, SessionStatus } from '@crewd/protocol'
import * as client from '@crewd/client'
import type { Nav } from '../nav.ts'
import { Markdown } from '../ui/Markdown.tsx'
import { Palette, filterCommands } from '../ui/Palette.tsx'
import { Rail } from '../ui/Rail.tsx'
import { StatusBar } from '../ui/StatusBar.tsx'
import { ThinkingLine } from '../ui/ThinkingLine.tsx'
import { ToolLine, type ToolItem } from '../ui/ToolLine.tsx'
import { accent, glyph, shortPath, theme } from '../ui/theme.ts'

type Item = { k: 'text'; text: string; open: boolean } | { k: 'thinking'; text: string; key: string } | (ToolItem & { key: string })
export type Block = { who: 'you'; text: string } | { who: 'agent'; items: Item[] } | { who: 'error'; message: string }

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

export function Chat({ nav, session: initial, harness }: { nav: Nav; session: SessionMeta; harness: HarnessInfo }) {
  const { width } = useTerminalDimensions()
  const [session, setSession] = useState(initial)
  const [past, setPast] = useState<LogLine[]>([]) // native history kept on screen after we take the session over
  const [lines, setLines] = useState<LogLine[]>([])
  const [input, setInput] = useState('')
  const [palSel, setPalSel] = useState(0)
  const [focus, setFocus] = useState<'input' | 'log'>('input')
  const [logSel, setLogSel] = useState(0)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showThinking, setShowThinking] = useState(false)
  const [err, setErr] = useState('')
  const scroll = useRef<ScrollBoxRenderable>(null)

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
  const { status, tokens, cost, commands } = useMemo(() => {
    let status: SessionStatus = session.status, tokens = 0, cost = 0, commands: Cmd[] = []
    for (const l of lines) {
      if (l.kind !== 'event') continue
      const ev = l.ev
      if (ev.type === 'status') status = ev.state
      else if (ev.type === 'commands') commands = ev.list
      // costUsd is the SDK's running total for the session, so keep the latest instead of summing
      else if (ev.type === 'turn_end') { tokens += usageTokens(ev.usage); cost = ev.costUsd ?? cost }
    }
    return { status, tokens, cost, commands }
  }, [lines, session.status])

  const selectable = blocks.flatMap((b) => (b.who === 'agent' ? b.items.filter((i) => i.k !== 'text') : [])) as (Item & { key: string })[]
  const paletteOpen = focus === 'input' && /^\/\S*$/.test(input)
  const palItems = paletteOpen ? filterCommands(commands, input) : []

  async function stop() {
    try { await client.interrupt(session.id) } catch (e: any) { setErr(`Could not stop the turn: ${e.message}`) }
  }

  // A session found in the harness's own store has no live process; resuming it gives us one (and its commands).
  const live = useRef<Promise<SessionMeta> | null>(null)
  function goLive(): Promise<SessionMeta> {
    if (session.source !== 'native') return Promise.resolve(session)
    live.current ??= client.createSession({ harness: harness.id, cwd: session.cwd, resumeId: session.nativeId ?? session.id }).then((s) => {
      setPast(all)
      setLines([])
      setSession(s)
      return s
    }, (e) => { live.current = null; throw e })
    return live.current
  }

  async function sendText(text: string) {
    setInput('')
    setErr('')
    try {
      const s = await goLive()
      await client.send(s.id, text)
    } catch (e: any) {
      setInput(text)
      setErr(`Not sent: ${e.message}. Press enter to retry.`)
    }
  }

  function runCommand(c: { name: string } | undefined) {
    const cmd = c?.name
    if (cmd === 'new') return nav.push({ name: 'new', harness })
    if (cmd === 'sessions') return nav.push({ name: 'sessions', harness })
    if (cmd === 'stop') { setInput(''); return stop() }
    if (cmd) setInput(`/${cmd} `)
  }

  function toggle(key: string) {
    setOpen((o) => { const n = new Set(o); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  useKeyboard((k) => {
    if (k.ctrl && k.name === 'o') return nav.push({ name: 'sessions', harness })
    if (k.ctrl && k.name === 'n') return nav.push({ name: 'new', harness })
    if (k.name === 'tab') return setFocus((f) => (f === 'input' ? 'log' : 'input'))
    if (k.name === 'pageup' || k.name === 'pagedown') return scroll.current?.scrollBy(k.name === 'pageup' ? -10 : 10)
    if (k.name === 'escape') {
      if (paletteOpen) return setInput('')
      if (status === 'running') return void stop()
      if (focus === 'log') return setFocus('input')
      return
    }
    if (paletteOpen && (k.name === 'up' || k.name === 'down')) {
      return setPalSel((i) => Math.max(0, Math.min(palItems.length - 1, i + (k.name === 'down' ? 1 : -1))))
    }
    if (focus !== 'log') return
    if (k.sequence === '?') return nav.help()
    if (k.name === 't') return setShowThinking((v) => !v)
    const cur = selectable[logSel]
    if (k.name === 'return' && cur) return toggle(cur.key)
    const d = k.name === 'up' || k.name === 'k' ? -1 : k.name === 'down' || k.name === 'j' ? 1 : 0
    if (d && selectable.length) {
      const i = Math.max(0, Math.min(selectable.length - 1, logSel + d))
      setLogSel(i)
      scroll.current?.scrollChildIntoView(selectable[i]!.key, { align: 'nearest' })
    }
  })

  const color = accent(harness)
  const selKey = focus === 'log' ? selectable[logSel]?.key : undefined
  const w = width - 6
  return (
    <box flexDirection="column" height="100%">
      <box
        border borderColor={theme.muted} flexGrow={1} flexDirection="column"
        title={` ${harness.label}  ${shortPath(session.cwd)}  ${glyph[status]} ${status} `} titleColor={color}
      >
        <scrollbox ref={scroll} stickyScroll stickyStart="bottom" flexGrow={1} paddingX={1} paddingTop={1}>
          {!blocks.length && <text fg={theme.muted}>Ask {harness.label} anything about {shortPath(session.cwd)}</text>}
          {blocks.map((b, i) =>
            b.who === 'you' ? (
              <Rail key={i} color={theme.muted} label="you"><text>{b.text}</text></Rail>
            ) : b.who === 'error' ? (
              <Rail key={i} color={theme.danger} label="error"><text fg={theme.danger}>{b.message}</text></Rail>
            ) : (
              <Rail key={i} color={color} label={harness.label}>
                {b.items.map((it, j) =>
                  it.k === 'text' ? <Markdown key={j} text={it.text} streaming={it.open} />
                  : it.k === 'thinking' ? <box key={it.key} id={it.key}><ThinkingLine text={it.text} open={showThinking || open.has(it.key)} selected={selKey === it.key} /></box>
                  : <box key={it.key} id={it.key}><ToolLine t={it} open={open.has(it.key)} selected={selKey === it.key} width={w} /></box>,
                )}
              </Rail>
            ),
          )}
        </scrollbox>
        {err && <text fg={theme.danger} paddingX={1} flexShrink={0}>{err}</text>}
        {paletteOpen && <Palette items={palItems} selected={Math.min(palSel, palItems.length - 1)} color={color} vendor={harness.label} width={width - 4} />}
        <box border={["top"]} borderColor={theme.muted} flexDirection="row" paddingX={1} flexShrink={0}>
          <text fg={color}>› </text>
          <input
            focused={focus === 'input'}
            value={input}
            placeholder={`ask ${harness.label}, or / for commands`}
            placeholderColor={theme.muted}
            focusedBackgroundColor="transparent"
            backgroundColor="transparent"
            onInput={(v) => {
              setInput(v)
              setPalSel(0)
              if (v.startsWith('/')) goLive().catch((e) => setErr(`Could not load ${harness.label}'s commands: ${e.message}`))
            }}
            onSubmit={() => (paletteOpen ? runCommand(palItems[palSel]) : input.trim() ? sendText(input.trim()) : undefined)}
            flexGrow={1}
          />
        </box>
      </box>
      <StatusBar
        state={status}
        tokens={tokens}
        cost={cost}
        hints={focus === 'log'
          ? [['enter', 'expand'], ['t', 'thinking'], ['tab', 'input'], ['esc', 'stop']]
          : [['esc', 'stop'], ['ctrl+o', 'sessions'], ['ctrl+n', 'new'], ['/', 'commands'], ["tab", "tools"]]}
      />
    </box>
  )
}
