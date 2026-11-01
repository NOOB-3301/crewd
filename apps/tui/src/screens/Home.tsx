import { useEffect, useState } from 'react'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import type { HarnessInfo, McpServer, SessionMeta } from '@crewd/protocol'
import * as client from '@crewd/client'
import { move, type Nav } from '../nav.ts'
import { KeyHints } from '../ui/KeyHints.tsx'
import { RosterRow } from '../ui/RosterRow.tsx'
import { SessionRow } from '../ui/SessionRow.tsx'
import { accent, shortPath, theme } from '../ui/theme.ts'

export function Home({ nav }: { nav: Nav }) {
  const { width } = useTerminalDimensions()
  const [hs, setHs] = useState<HarnessInfo[]>([])
  const [mcp, setMcp] = useState<McpServer[]>([])
  const [preview, setPreview] = useState<Record<string, SessionMeta[]>>({})
  const [sel, setSel] = useState(0)
  const [err, setErr] = useState('')

  useEffect(() => {
    const load = () => Promise.all([client.harnesses(), client.getMcp()])
      .then(([h, m]) => { setHs(h); setMcp(m); setErr('') })
      .catch((e) => setErr(`${e.message}. Retrying every 3s; if it keeps failing, check ~/.crewd/daemon.log.`))
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])

  const h = hs[sel]
  useEffect(() => {
    if (!h?.installed) return
    client.harnessSessions(h.id).then((s) => setPreview((p) => ({ ...p, [h.id]: s }))).catch(() => {})
  }, [h?.id, h?.count])

  const rows = hs.length + 2
  useKeyboard((k) => {
    const m = move(k, sel, rows)
    if (m !== undefined) return setSel(m)
    if (k.name === 'q') return nav.quit()
    if (k.sequence === '?') return nav.help()
    if (k.name === 'n') return nav.push({ name: 'new' })
    if (k.name === 'm') return nav.push({ name: 'mcp' })
    if (k.name === 'return') {
      if (h) return h.installed ? nav.push({ name: 'sessions', harness: h }) : setErr(`${h.label} is not installed. Install its CLI and make sure it is on your PATH.`)
      if (sel === hs.length) return nav.push({ name: 'new' })
      return nav.push({ name: 'mcp' })
    }
  })

  const paneW = Math.max(20, width - 43)
  const sessions = (h && preview[h.id]) ?? []
  const on = mcp.filter((s) => s.enabled !== false).length
  return (
    <box flexDirection="column" height="100%">
      <box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <text><b>crewd</b></text>
        <text fg={theme.muted}>{shortPath(nav.launchCwd)}</text>
      </box>
      <box flexDirection="row" flexGrow={1} paddingTop={1}>
        <box flexDirection="column" width={38} paddingLeft={1}>
          <text fg={theme.muted}>  Old sessions</text>
          {hs.map((x, i) => <RosterRow key={x.id} h={x} selected={i === sel} />)}
          <text> </text>
          <text>{sel === hs.length ? <b>› New session</b> : '  New session'}</text>
          <text>{sel === hs.length + 1 ? <b>› MCP servers</b> : '  MCP servers'}<span fg={theme.muted}> ({on} on)</span></text>
        </box>
        <box flexDirection="column" flexGrow={1} paddingLeft={2}>
          {h && <text fg={accent(h)}><b>{h.label}</b></text>}
          {h && !h.installed && <text fg={theme.muted}>Not installed. Install its CLI and put it on your PATH.</text>}
          {h?.installed && !sessions.length && <text fg={theme.muted}>No sessions yet. Press n to start one.</text>}
          {sessions.slice(0, 12).map((s) => <SessionRow key={s.id} s={s} color={accent(h)} width={paneW} compact />)}
        </box>
      </box>
      {err && <text fg={theme.danger}> {err}</text>}
      <KeyHints hints={[['enter', 'open'], ['n', 'new'], ['m', 'mcp'], ['?', 'keys'], ['q', 'quit']]} />
    </box>
  )
}
