import { useEffect, useState } from 'react'
import { useKeyboard } from '@opentui/react'
import type { Usage as UsageT, UsageMeter } from '@crewd/protocol'
import * as client from '@crewd/client'
import type { Nav } from '../nav.ts'
import { KeyHints } from '../ui/KeyHints.tsx'
import { accent, pad, theme } from '../ui/theme.ts'

const reset = (iso?: string) =>
  iso ? 'resets ' + new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''

const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n * 100) / 100)

/** "1.2M of 5M credits · 3.8M left" from whatever the provider gave us. */
function amounts(m: UsageMeter) {
  const unit = m.unit === 'percent' ? '' : m.unit === 'usd' ? '' : ` ${m.unit}`
  const fmt = (n: number) => (m.unit === 'usd' ? `$${n.toFixed(2)}` : m.unit === 'percent' ? `${Math.round(n)}%` : compact(n))
  const parts = [
    m.used !== undefined && m.total ? `${fmt(m.used)} of ${fmt(m.total)}${unit}` : m.used !== undefined ? `${fmt(m.used)}${unit}` : '',
    m.remaining !== undefined && m.unit !== 'percent' ? `${fmt(m.remaining)} left` : '',
  ].filter(Boolean)
  return parts.join(' · ')
}

const bar = (p: number, n = 30) => {
  const on = Math.round((Math.min(100, Math.max(0, p)) / 100) * n)
  return '█'.repeat(on) + '░'.repeat(n - on)
}

/** Account usage per agent. Mounted fresh on every open, so it always asks the daemon again; r refetches. */
export function Usage({ nav }: { nav: Nav }) {
  const [list, setList] = useState<UsageT[] | null>(null)
  const [err, setErr] = useState('')
  const load = () => {
    setList(null)
    setErr('')
    client.usage().then(setList).catch((e) => setErr(`Could not load usage: ${e.message}`))
  }
  useEffect(load, [])

  useKeyboard((k) => {
    if (k.name === 'escape' || k.name === 'backspace') return nav.pop()
    if (k.name === 'r') return load()
    if (k.name === 'q') return nav.quit()
    if (k.sequence === '?') return nav.help()
  })

  return (
    <box flexDirection="column" height="100%">
      <box paddingX={1} paddingBottom={1}><text><span fg={theme.muted}>crewd  </span><b>Usage</b></text></box>
      <box flexDirection="column" flexGrow={1} paddingLeft={2}>
        {!list && !err && <text fg={theme.muted}>Loading…</text>}
        {list?.map((u) => (
          <box key={u.harness} flexDirection="column" marginBottom={1}>
            <text><b>Your usage</b>{u.plan && <span fg={theme.muted}>  {u.plan}</span>} <span fg={accent({ id: u.harness, color: undefined })}>· {u.label}</span>{u.source === 'local' && <span fg={theme.muted}> (this machine)</span>}</text>
            {u.error ? <text fg={theme.danger}>{u.error}</text> : u.source === 'none' ? <text fg={theme.muted}>{u.message}</text> : (
              <>
                {u.message && <text paddingTop={1}>{u.message}</text>}
                <box flexDirection="column" paddingTop={1}>
                  {u.meters.map((m) => (
                    <text key={m.label}>
                      {pad(m.label, 28)}
                      {m.percent !== undefined && <span fg={m.percent >= 90 ? theme.danger : m.percent >= 70 ? theme.warn : theme.ok}>{bar(m.percent, 20)} {pad(`${Math.round(m.percent)}%`, 5)}</span>}
                      <span fg={theme.muted}>{amounts(m)}{m.resetsAt ? `  ${reset(m.resetsAt)}` : ''}</span>
                    </text>
                  ))}
                </box>
                {!!u.breakdown?.length && (
                  <box flexDirection="column" paddingTop={1}>
                    <text fg={theme.muted}>Weekly by source</text>
                    {u.breakdown.map((r) => <text key={r.label}>  {pad(r.label, 14)}<span fg={theme.muted}>{r.percent}%</span></text>)}
                  </box>
                )}
              </>
            )}
          </box>
        ))}
      </box>
      {err && <text fg={theme.danger}> {err}</text>}
      <KeyHints hints={[['r', 'refresh'], ['esc', 'back'], ['?', 'keys'], ['q', 'quit']]} />
    </box>
  )
}
