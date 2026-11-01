import { useEffect, useState } from 'react'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import type { HarnessInfo, SessionMeta } from '@crewd/protocol'
import * as client from '@crewd/client'
import { move, type Nav } from '../nav.ts'
import { KeyHints } from '../ui/KeyHints.tsx'
import { SessionRow } from '../ui/SessionRow.tsx'
import { accent, theme } from '../ui/theme.ts'

export function Sessions({ nav, harness }: { nav: Nav; harness: HarnessInfo }) {
  const { width } = useTerminalDimensions()
  const [list, setList] = useState<SessionMeta[] | null>(null)
  const [sel, setSel] = useState(0)
  const [err, setErr] = useState('')

  useEffect(() => {
    const load = () => client.harnessSessions(harness.id)
      .then((s) => { setList(s.sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))); setErr('') })
      .catch((e) => setErr(`${e.message}. Retrying every 3s.`))
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [harness.id])

  useKeyboard((k) => {
    const m = move(k, sel, list?.length ?? 0)
    if (m !== undefined) return setSel(m)
    if (k.name === 'escape') return nav.pop()
    if (k.name === 'q') return nav.quit()
    if (k.sequence === '?') return nav.help()
    if (k.name === 'n') return nav.push({ name: 'new', harness })
    const s = list?.[sel]
    if (k.name === 'return' && s) return nav.push({ name: 'chat', session: s, harness })
  })

  const color = accent(harness)
  // Keep the view scrolled so the selection stays visible.
  const visible = 30
  const start = Math.max(0, sel - visible + 3)
  return (
    <box flexDirection="column" height="100%">
      <box paddingX={1} paddingBottom={1}>
        <text><span fg={theme.muted}>crewd  </span><span fg={color}><b>{harness.label}</b></span><span fg={theme.muted}>  sessions</span></text>
      </box>
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        {list === null && <text fg={theme.muted}>  Loading…</text>}
        {list?.length === 0 && <text fg={theme.muted}>  No {harness.label} sessions yet. Press n to start one.</text>}
        {list?.slice(start, start + visible).map((s, i) => (
          <SessionRow key={s.id} s={s} color={color} selected={start + i === sel} width={width - 3} />
        ))}
      </box>
      {err && <text fg={theme.danger}> {err}</text>}
      <KeyHints hints={[['enter', 'open'], ['n', 'new'], ['esc', 'back'], ['?', 'keys'], ['q', 'quit']]} />
    </box>
  )
}
