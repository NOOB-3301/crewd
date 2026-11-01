import { useEffect, useState } from 'react'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { useKeyboard } from '@opentui/react'
import type { HarnessInfo } from '@crewd/protocol'
import * as client from '@crewd/client'
import { move, type Nav } from '../nav.ts'
import { KeyHints } from '../ui/KeyHints.tsx'
import { accent, shortPath, theme } from '../ui/theme.ts'

export function NewSession({ nav, harness }: { nav: Nav; harness?: HarnessInfo }) {
  const [hs, setHs] = useState<HarnessInfo[]>([])
  const [picked, setPicked] = useState(harness)
  const [sel, setSel] = useState(0)
  const [cwd, setCwd] = useState(nav.launchCwd)
  const [recent, setRecent] = useState<string[]>([])
  const [recentSel, setRecentSel] = useState(-1)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    client.harnesses().then((h) => setHs(h.filter((x) => x.installed && !x.disabled))).catch((e) => setErr(e.message))
  }, [])

  useEffect(() => {
    if (!picked) return
    client.harnessSessions(picked.id)
      .then((s) => setRecent([...new Set(s.sort((a, b) => b.createdAt - a.createdAt).map((x) => x.cwd))].filter((c) => c !== nav.launchCwd).slice(0, 8)))
      .catch(() => {})
  }, [picked?.id])

  async function start() {
    if (!picked || busy) return
    setBusy(true)
    try {
      const dir = resolve(cwd.trim().replace(/^~(?=\/|$)/, homedir()))
      const session = await client.createSession({ harness: picked.id, cwd: dir })
      nav.replace({ name: 'chat', session, harness: picked })
    } catch (e: any) {
      setErr(`${e.message}. Check the directory exists, then press enter to retry.`)
      setBusy(false)
    }
  }

  useKeyboard((k) => {
    if (k.name === 'escape') return picked && !harness ? setPicked(undefined) : nav.pop()
    if (!picked) {
      const m = move(k, sel, hs.length)
      if (m !== undefined) return setSel(m)
      if (k.name === 'q') return nav.quit()
      if (k.sequence === '?') return nav.help()
      if (k.name === 'return' && hs[sel]) setPicked(hs[sel])
      return
    }
    // The cwd input has focus here, so only arrows move (j/k are typed).
    if (k.name === 'up' || k.name === 'down') {
      const i = Math.max(-1, Math.min(recent.length - 1, recentSel + (k.name === 'down' ? 1 : -1)))
      setRecentSel(i)
      setCwd(i < 0 ? nav.launchCwd : recent[i]!)
    }
  })

  return (
    <box flexDirection="column" height="100%">
      <box paddingX={1} paddingBottom={1}>
        <text><span fg={theme.muted}>crewd  </span><b>New session</b></text>
      </box>
      <box flexDirection="column" flexGrow={1} paddingLeft={2}>
        {!picked && <>
          <text fg={theme.muted}>Pick a harness</text>
          {!hs.length && !err && <text fg={theme.muted}>No harness is installed. Install claude, opencode, qoder or pi and put it on your PATH.</text>}
          {hs.map((h, i) => (
            <text key={h.id}>
              <span fg={accent(h)}>{i === sel ? '› ● ' : '  ● '}</span>
              {i === sel ? <b>{h.label}</b> : h.label}
            </text>
          ))}
        </>}
        {picked && <>
          <text><span fg={accent(picked)}>● {picked.label}</span><span fg={theme.muted}>  working directory</span></text>
          <box flexDirection="row" marginTop={1}>
            <text fg={accent(picked)}>› </text>
            <input
              focused
              value={cwd}
              onInput={(v) => { setCwd(v); setErr('') }}
              onSubmit={start}
              focusedBackgroundColor="transparent"
              backgroundColor="transparent"
              flexGrow={1}
            />
          </box>
          {recent.length > 0 && <text fg={theme.muted} marginTop={1}>Recent</text>}
          {recent.map((r, i) => (
            <text key={r} fg={i === recentSel ? undefined : theme.muted}>{i === recentSel ? '› ' : '  '}{shortPath(r)}</text>
          ))}
          {busy && <text fg={theme.muted} marginTop={1}>Starting {picked.label}…</text>}
        </>}
      </box>
      {err && <text fg={theme.danger}> {err}</text>}
      <KeyHints hints={picked
        ? [['enter', 'start'], ['↑↓', 'recent'], ['esc', 'back']]
        : [['enter', 'pick'], ['esc', 'back'], ['?', 'keys'], ['q', 'quit']]} />
    </box>
  )
}
