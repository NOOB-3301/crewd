import { useState } from 'react'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import type { HarnessInfo } from '@crewd/protocol'
import * as client from '@crewd/client'
import type { Nav } from '../nav.ts'
import { groupSessions, isTemp, useAllSessions } from '../allSessions.ts'
import { readPref, writePref } from '../prefs.ts'
import { claudeModes, defaultMode } from '../useSession.ts'
import { KeyHints } from '../ui/KeyHints.tsx'
import { accent, age, pad, shortPath, theme } from '../ui/theme.ts'

const expand = (p: string) => resolve(p.trim().replace(/^~(?=\/|$)/, homedir()))
const looksLikePath = (p: string) => /^[~/.]/.test(p.trim())

/** New session in two steps: pick the project folder, then the agent (and Claude's mode). Either step is skipped when given. */
export function NewSession({ nav, harness, cwd: givenCwd }: { nav: Nav; harness?: HarnessInfo; cwd?: string }) {
  const { height } = useTerminalDimensions()
  const { sessions, installed, harness: byId, loaded } = useAllSessions()
  const [cwd, setCwd] = useState(givenCwd)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [agentSel, setAgentSel] = useState(0)
  const [mode, setMode] = useState(defaultMode)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  // Folder step: known projects (newest first, temp folders left out), filtered by what's typed.
  const projects = groupSessions(sessions.filter((s) => !isTemp(s.cwd)), 'project', byId)
  const typed = looksLikePath(query) ? expand(query) : undefined
  const q = query.trim().toLowerCase()
  const matches = projects.filter((p) => (typed ? p.key.startsWith(typed) : !q || p.key.toLowerCase().includes(q)))
  // A typed path that isn't a known project gets its own first row.
  const rows = [
    ...(typed && !matches.some((p) => p.key === typed) ? [{ key: typed, label: `use ${shortPath(typed)}`, extra: existsSync(typed) ? 'folder' : 'not found' }] : []),
    ...matches.map((p) => ({ key: p.key, label: shortPath(p.key), extra: `${p.sessions.length} session${p.sessions.length === 1 ? '' : 's'} · ${age(p.last)}` })),
  ]
  const fsel = Math.min(sel, Math.max(0, rows.length - 1))

  const agents = harness ? [harness] : installed
  const picked = harness ?? agents[Math.min(agentSel, agents.length - 1)]
  const hasMode = picked?.id === 'claude'

  async function start(h: HarnessInfo) {
    if (!cwd || busy) return
    setBusy(true)
    try {
      const session = await client.createSession({ harness: h.id, cwd, permissionMode: h.id === 'claude' ? mode : undefined })
      if (h.id === 'claude') writePref('tui.json', { ...readPref('tui.json', {}), defaultMode: mode })
      nav.open(session, h)
    } catch (e: any) {
      setErr(`${e.message}. Press enter to retry.`)
      setBusy(false)
    }
  }

  function pickFolder() {
    const r = rows[fsel]
    if (!r) return setErr('Type a folder path, like ~/Projects/app')
    if (!existsSync(r.key)) return setErr(`${shortPath(r.key)} does not exist.`)
    setErr('')
    setCwd(r.key)
  }

  useKeyboard((k) => {
    if (k.name === 'escape') return cwd && !givenCwd ? setCwd(undefined) : nav.pop()
    if (!cwd) {
      // The filter input has focus, so only arrows move (j/k are typed).
      if (k.name === 'up' || k.name === 'down') setSel(Math.max(0, Math.min(rows.length - 1, fsel + (k.name === 'down' ? 1 : -1))))
      return
    }
    if (hasMode && (k.name === 'tab' || (k.ctrl && k.name === 't'))) {
      const i = claudeModes.findIndex((m) => m.id === mode)
      return setMode(claudeModes[(i + (k.shift ? claudeModes.length - 1 : 1)) % claudeModes.length]!.id)
    }
    if (k.name === 'up' || k.name === 'k') return setAgentSel(Math.max(0, agentSel - 1))
    if (k.name === 'down' || k.name === 'j') return setAgentSel(Math.min(agents.length - 1, agentSel + 1))
    if (k.name === 'return' && picked) return void start(picked)
  })

  const listH = Math.max(3, height - 10)
  const fstart = Math.max(0, fsel - listH + 1)
  return (
    <box flexDirection="column" height="100%">
      <box paddingX={1} paddingBottom={1}>
        <text>
          <span fg={theme.muted}>crewd › </span><b>New session</b>
          {cwd ? <span fg={theme.muted}>   in {shortPath(cwd)}</span> : ''}
          {harness ? <span fg={accent(harness)}>   {harness.label}</span> : ''}
        </text>
      </box>
      <box flexDirection="column" flexGrow={1} paddingLeft={2}>
        {!cwd && <>
          <text fg={theme.muted}>Project folder: pick one, or type a path</text>
          <box flexDirection="row" marginTop={1}>
            <text>› </text>
            <input focused value={query} placeholder="filter projects, or ~/path/to/folder" placeholderColor={theme.muted}
              onInput={(v) => { setQuery(v); setSel(0); setErr('') }} onSubmit={pickFolder}
              focusedBackgroundColor="transparent" backgroundColor="transparent" flexGrow={1} />
          </box>
          <box flexDirection="column" marginTop={1}>
            {!rows.length && <text fg={theme.muted}>{loaded ? 'No match. Type a path starting with ~ or /.' : 'Loading projects…'}</text>}
            {rows.slice(fstart, fstart + listH).map((r, i) => (
              <text key={r.key} wrapMode="none">
                {fstart + i === fsel ? <b>› {pad(r.label, 50)}</b> : `  ${pad(r.label, 50)}`}
                <span fg={r.extra === 'not found' ? theme.danger : theme.muted}>  {r.extra}</span>
              </text>
            ))}
          </box>
        </>}
        {cwd && <>
          <text fg={theme.muted}>Agent</text>
          {!agents.length && <text fg={theme.muted}>No agent is installed. Install claude, opencode, qoder or pi and put it on your PATH.</text>}
          {agents.map((h) => (
            <text key={h.id}>
              <span fg={accent(h)}>{h === picked ? '› ● ' : '  ● '}</span>
              {h === picked ? <b>{h.label}</b> : h.label}
            </text>
          ))}
          {hasMode && (
            <text marginTop={1}>
              <span fg={theme.muted}>mode  </span>
              {claudeModes.map((m) => <span key={m.id} fg={m.id === mode ? accent(picked) : theme.muted}>{m.id === mode ? `⏵ ${m.id}` : m.id}   </span>)}
            </text>
          )}
          {busy && picked && <text fg={theme.muted} marginTop={1}>Starting {picked.label} in {shortPath(cwd)}…</text>}
        </>}
      </box>
      {err && <text fg={theme.danger}> {err}</text>}
      <KeyHints hints={!cwd
        ? [['enter', 'pick folder'], ['↑↓', 'move'], ['esc', 'back']]
        : [['enter', 'start'], ['↑↓', 'agent'], ...(hasMode ? [['tab', 'mode'] as [string, string]] : []), ['esc', givenCwd ? 'back' : 'change folder']]} />
    </box>
  )
}
