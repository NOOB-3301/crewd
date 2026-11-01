import { useState } from 'react'
import { basename } from 'node:path'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { move, type Nav } from '../nav.ts'
import { useAllSessions, visibleSessions } from '../allSessions.ts'
import type { HomeView } from './Home.tsx'
import { KeyHints } from '../ui/KeyHints.tsx'
import { SessionRow } from '../ui/SessionRow.tsx'
import { accent, shortPath, theme } from '../ui/theme.ts'

/** One card's sessions: a project's sessions across agents, or an agent's sessions across projects. enter resumes. */
export function Group({ nav, by, groupKey, showTemp }: { nav: Nav; by: HomeView; groupKey: string; showTemp?: boolean }) {
  const { width, height } = useTerminalDimensions()
  const { sessions: all, harness, installed, loaded, err, setErr } = useAllSessions()
  const [sel, setSel] = useState(0)
  const sessions = visibleSessions(all, showTemp).filter((s) => (by === 'project' ? s.cwd : s.harness) === groupKey)
  const h = by === 'agent' ? harness(groupKey) : undefined
  const title = by === 'project' ? basename(groupKey) || groupKey : h?.label ?? groupKey
  const sub = by === 'project' ? shortPath(groupKey) : `${sessions.length} sessions`
  const lead = (s: (typeof sessions)[number]) => (by === 'project' ? harness(s.harness)?.label ?? s.harness : shortPath(s.cwd))
  const leadW = Math.min(by === 'project' ? 14 : 34, Math.max(6, ...sessions.map((s) => lead(s).length)))
  const cur = Math.min(sel, Math.max(0, sessions.length - 1))

  useKeyboard((k) => {
    const m = move(k, cur, sessions.length)
    if (m !== undefined) return setSel(m)
    if (k.name === 'escape' || k.name === 'backspace') return nav.pop()
    if (k.ctrl && k.name === 'o') return nav.openCount ? nav.wall() : undefined
    if (k.sequence === '?') return nav.help()
    if (k.name === 'q') return nav.quit()
    if (k.name === 'n') return nav.push(by === 'project' ? { name: 'new', cwd: groupKey } : { name: 'new', harness: installed.find((x) => x.id === groupKey) })
    const s = sessions[cur]
    if (k.name === 'return' && s) {
      const sh = harness(s.harness)
      return sh ? nav.open(s, sh) : setErr(`${s.harness} is not configured in crewd any more.`)
    }
  })

  const visible = Math.max(3, height - 6)
  const start = Math.max(0, cur - visible + 1)
  return (
    <box flexDirection="column" height="100%">
      <box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <text><span fg={theme.muted}>crewd › </span><b><span fg={h ? accent(h) : undefined}>{title}</span></b><span fg={theme.muted}>   {sub}</span></text>
        {nav.openCount ? <text fg={theme.muted}>{nav.openCount} open · ctrl+o</text> : null}
      </box>
      <box flexDirection="column" flexGrow={1} paddingTop={1} paddingLeft={1}>
        {!sessions.length && <text fg={theme.muted}>  {loaded ? 'No sessions here yet. Press n to start one.' : 'Loading sessions…'}</text>}
        {sessions.slice(start, start + visible).map((s, i) => {
          const sh = harness(s.harness)
          return <SessionRow key={s.id} s={s} lead={lead(s)} leadW={leadW} leadColor={by === 'project' ? accent(sh) : undefined}
            color={accent(sh)} selected={start + i === cur} width={width - 3} />
        })}
      </box>
      {err && <text fg={theme.danger}> {err}</text>}
      <KeyHints hints={[['enter', 'resume'], ['↑↓', 'move'], ['n', by === 'project' ? 'new here' : `new ${title}`], ['esc', 'back'],
        ...(nav.openCount ? [['ctrl+o', 'open sessions'] as [string, string]] : []), ['q', 'quit']]} />
    </box>
  )
}
