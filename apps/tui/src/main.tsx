#!/usr/bin/env bun
import { useEffect, useRef, useState } from 'react'
import { createCliRenderer } from '@opentui/core'
import { createRoot, useKeyboard, useRenderer } from '@opentui/react'
import type { HarnessInfo, SessionMeta } from '@crewd/protocol'
import * as client from '@crewd/client'
import type { Nav, Route, Tile } from './nav.ts'
import { readPref, writePref } from './prefs.ts'
import { copyText } from './ui/clipboard.ts'
import { Group } from './screens/Group.tsx'
import { Help } from './screens/Help.tsx'
import { Home } from './screens/Home.tsx'
import { Mcp } from './screens/Mcp.tsx'
import { Usage } from './screens/Usage.tsx'
import { NewSession } from './screens/NewSession.tsx'
import { Wall } from './screens/Wall.tsx'

type Saved = { id: string; harness: string }[]

/** Reopens the tiles saved in wall.json, skipping sessions that no longer exist. */
async function restoreTiles(): Promise<Tile[]> {
  const saved = readPref<Saved>('wall.json', [])
  if (!Array.isArray(saved) || !saved.length) return []
  const [hs, live] = await Promise.all([client.harnesses(), client.liveSessions()])
  const out: Tile[] = []
  for (const e of saved) {
    const h = hs.find((x) => x.id === e.harness)
    const s = live.find((x) => x.id === e.id) ?? (h && (await client.harnessSessions(h.id).catch(() => [])).find((x) => x.id === e.id))
    if (h && s) out.push({ key: s.id, session: s, harness: h })
  }
  return out
}

export function App({ launchCwd }: { launchCwd: string }) {
  const renderer = useRenderer()
  const [stack, setStack] = useState<Route[]>([{ name: 'home' }])
  const [help, setHelp] = useState(false)
  const [tiles, setTiles] = useState<Tile[]>([])
  const [focus, setFocus] = useState(0)
  const [full, setFull] = useState(false)
  const restored = useRef(false)

  useEffect(() => {
    restoreTiles().catch(() => [] as Tile[]).then((out) => {
      setTiles((t) => [...out, ...t.filter((x) => !out.some((o) => o.key === x.key))])
      restored.current = true
    })
  }, [])
  useEffect(() => {
    if (restored.current) writePref('wall.json', tiles.map((t) => ({ id: t.session.id, harness: t.harness.id })) satisfies Saved)
  }, [tiles])

  function open(session: SessionMeta, harness: HarnessInfo) {
    const i = tiles.findIndex((t) => t.key === session.id || t.session.id === session.id)
    if (i < 0) setTiles([...tiles, { key: session.id, session, harness }])
    setFocus(i < 0 ? tiles.length : i)
    setStack([{ name: 'home' }, { name: 'wall' }])
  }
  function close(i: number) {
    const next = tiles.filter((_, j) => j !== i)
    setTiles(next)
    setFocus(Math.max(0, Math.min(focus, next.length - 1)))
    if (!next.length) { setFull(false); setStack([{ name: 'home' }]) }
  }

  const nav: Nav = {
    push: (r) => setStack((s) => [...s, r]),
    pop: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    home: () => setStack([{ name: 'home' }]),
    wall: () => setStack([{ name: 'home' }, { name: 'wall' }]),
    open,
    help: () => setHelp(true),
    quit: () => { renderer.destroy(); process.exit(0) },
    launchCwd,
    openCount: tiles.length,
  }
  const r = stack.at(-1)!
  // Keyed by depth so pushing the same screen type remounts it with fresh state.
  const key = stack.length
  const onWall = r.name === 'wall' && !help && tiles.length > 0
  return (
    <box flexDirection="column" height="100%">
      {/* Stays mounted behind the other screens so open sessions keep streaming. */}
      {tiles.length > 0 && (
        <Wall
          nav={nav} tiles={tiles} focus={focus} setFocus={setFocus} full={full} setFull={setFull} active={onWall} onClose={close}
          onLive={(k, s) => setTiles((ts) => ts.map((t) => (t.key === k ? { ...t, session: s } : t)))}
        />
      )}
      {help ? <Help onClose={() => setHelp(false)} />
        : r.name === 'new' ? <NewSession key={key} nav={nav} harness={r.harness} cwd={r.cwd} />
        : r.name === 'group' ? <Group key={key} nav={nav} by={r.by} groupKey={r.key} showTemp={r.showTemp} />
        : r.name === 'mcp' ? <Mcp key={key} nav={nav} />
        : r.name === 'usage' ? <Usage key={key} nav={nav} />
        : !onWall ? <Home key={key} nav={nav} />
        : null}
    </box>
  )
}

function Fatal({ message }: { message: string }) {
  const renderer = useRenderer()
  useKeyboard(() => { renderer.destroy(); process.exit(1) })
  return (
    <box flexDirection="column" padding={1}>
      <text fg="#FF6B6B">crewd could not start its background daemon.</text>
      <text>{message}</text>
      <text fg="#8A8F98">Press any key to exit.</text>
    </box>
  )
}

if (import.meta.main) {
  const launchCwd = process.cwd()
  let failure = ''
  try {
    await client.ensureDaemon()
  } catch (e: any) {
    failure = e.message
  }
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  // Mouse capture blocks the terminal's own selection, so copy whatever is drag-selected in the app.
  renderer.on('selection', (sel: { getSelectedText(): string } | null) => {
    const text = sel?.getSelectedText()
    if (text) copyText(text, (t) => renderer.copyToClipboardOSC52(t))
  })
  createRoot(renderer).render(failure ? <Fatal message={failure} /> : <App launchCwd={launchCwd} />)
}
