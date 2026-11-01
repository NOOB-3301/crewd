import { useState } from 'react'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import type { Nav } from '../nav.ts'
import { groupSessions, useAllSessions, visibleSessions, type Group } from '../allSessions.ts'
import { readPref, writePref } from '../prefs.ts'
import { KeyHints } from '../ui/KeyHints.tsx'
import { accent, age, pad, shortPath, theme } from '../ui/theme.ts'

export type HomeView = 'project' | 'agent'
const CARD_W = 30
const CARD_H = 6

/** First screen: sessions grouped into cards, by project folder or by agent. enter opens the card's session list. */
export function Home({ nav }: { nav: Nav }) {
  const { width, height } = useTerminalDimensions()
  const { sessions, harness, mcp, loaded, err } = useAllSessions()
  const [view, setView] = useState<HomeView>(() => readPref<{ homeView?: HomeView }>('tui.json', {}).homeView ?? 'project')
  const [showTemp, setShowTemp] = useState(false)
  const [sel, setSel] = useState(0)

  const shown = visibleSessions(sessions, showTemp)
  const hidden = sessions.length - shown.length
  const groups = groupSessions(shown, view, harness)
  const cols = Math.max(1, Math.floor((width - 2) / (CARD_W + 1)))
  const rowsFit = Math.max(1, Math.floor((height - 6) / CARD_H))
  const cur = Math.min(sel, Math.max(0, groups.length - 1))
  const firstRow = Math.max(0, Math.floor(cur / cols) - rowsFit + 1)
  const visible = groups.slice(firstRow * cols, (firstRow + rowsFit) * cols)

  function switchView(v: HomeView) {
    setView(v)
    setSel(0)
    writePref('tui.json', { ...readPref('tui.json', {}), homeView: v })
  }

  useKeyboard((k) => {
    const n = groups.length
    if (k.name === 'left' || k.name === 'h') return setSel(Math.max(0, cur - 1))
    if (k.name === 'right' || k.name === 'l') return setSel(Math.min(n - 1, cur + 1))
    if (k.name === 'up' || k.name === 'k') return setSel(Math.max(0, cur - cols))
    if (k.name === 'down' || k.name === 'j') return setSel(Math.min(n - 1, cur + cols))
    if (k.name === 'tab' || k.name === 'v') return switchView(view === 'project' ? 'agent' : 'project')
    if (k.sequence === '.') return setShowTemp((t) => !t)
    if (k.ctrl && k.name === 'o') return nav.openCount ? nav.wall() : undefined
    if (k.name === 'q') return nav.quit()
    if (k.sequence === '?') return nav.help()
    if (k.name === 'n') return nav.push({ name: 'new' })
    if (k.name === 'm') return nav.push({ name: 'mcp' })
    if (k.name === 'u') return nav.push({ name: 'usage' })
    const g = groups[cur]
    if (k.name === 'return' && g) return nav.push({ name: 'group', by: view, key: g.key, showTemp })
  })

  const tab = (v: HomeView, label: string) => (view === v ? <b>[ {label} ]</b> : <span fg={theme.muted}>  {label}  </span>)
  const on = mcp.filter((s) => s.enabled !== false).length
  return (
    <box flexDirection="column" height="100%">
      <box flexDirection="row" justifyContent="space-between" paddingX={1}>
        <text>
          <b>crewd</b>{'   '}{tab('project', 'by project')}{tab('agent', 'by agent')}
          {nav.openCount ? <span fg={theme.muted}>   {nav.openCount} open · ctrl+o</span> : ''}
        </text>
        <text fg={theme.muted}>{shortPath(nav.launchCwd)}</text>
      </box>
      <box flexDirection="row" flexWrap="wrap" flexGrow={1} paddingX={1} paddingTop={1}>
        {!groups.length && <text fg={theme.muted}>{loaded ? 'No sessions yet. Press n to start one.' : 'Loading sessions…'}</text>}
        {visible.map((g, i) => <Card key={g.key} g={g} selected={firstRow * cols + i === cur} color={view === 'agent' ? accent(harness(g.key)) : undefined} />)}
      </box>
      {err && <text fg={theme.danger}> {err}</text>}
      <text fg={theme.muted} paddingX={1}>
        {groups.length} {view === 'project' ? 'projects' : 'agents'} · {shown.length} sessions
        {hidden ? ` · ${hidden} in temp folders hidden (. to show)` : showTemp ? ' · showing temp folders (. to hide)' : ''} · MCP {on} on
      </text>
      <KeyHints hints={[['enter', 'open'], ['←↑↓→', 'move'], ['tab', 'project/agent'], ['n', 'new'], ['m', 'mcp'], ['u', 'usage'],
        ...(nav.openCount ? [['ctrl+o', 'open sessions'] as [string, string]] : []), ['?', 'keys'], ['q', 'quit']]} />
    </box>
  )
}

function Card({ g, selected, color }: { g: Group; selected: boolean; color?: string }) {
  const border = g.waiting ? theme.warn : selected ? color ?? '#FFFFFF' : theme.muted
  const w = CARD_W - 4
  return (
    <box width={CARD_W} height={CARD_H} marginRight={1} border borderStyle={selected ? 'double' : 'rounded'} borderColor={border} paddingX={1} flexDirection="column">
      <text wrapMode="none" fg={color}>{selected ? <b>{pad(g.name, w)}</b> : pad(g.name, w)}</text>
      <text wrapMode="none" fg={theme.muted}>{pad(g.sub, w)}</text>
      <text wrapMode="none">
        <b>{g.sessions.length}</b><span fg={theme.muted}> session{g.sessions.length === 1 ? '' : 's'} · {age(g.last)}</span>
      </text>
      <text wrapMode="none">
        {g.waiting ? <span fg={theme.warn}>◆ {g.waiting} waiting  </span> : ''}
        {g.live ? <span fg={color}>● {g.live} live</span> : ''}
      </text>
    </box>
  )
}
