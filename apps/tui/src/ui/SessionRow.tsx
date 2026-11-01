import type { SessionMeta } from '@crewd/protocol'
import { cleanTitle } from '../allSessions.ts'
import { age, glyph, pad, theme } from './theme.ts'

/** marker, lead column (agent name or project), status glyph, title, age, mode / waiting tag. */
export function SessionRow({ s, lead, leadColor, leadW, color, selected, width }: {
  s: SessionMeta; lead: string; leadColor?: string; leadW: number; color: string; selected?: boolean; width: number
}) {
  const waiting = s.status === 'waiting'
  const isLive = s.source === 'crewd' && s.status !== 'dead'
  const tag = waiting ? 'waiting' : isLive && s.permissionMode ? `⏵ ${s.permissionMode}` : ''
  const titleW = Math.max(10, width - 2 - leadW - 2 - 2 - 5 - 14)
  const title = cleanTitle(s.title)
  return (
    <text wrapMode="none">
      <span fg={color}>{selected ? '› ' : '  '}</span>
      <span fg={leadColor ?? theme.muted}>{pad(lead, leadW)}  </span>
      <span fg={s.status === 'dead' ? theme.danger : waiting ? theme.warn : isLive ? color : theme.muted}>{glyph[s.status]} </span>
      {selected || waiting ? <b>{pad(title, titleW)}</b> : pad(title, titleW)}
      <span fg={theme.muted}>{age(s.updatedAt ?? s.createdAt).padStart(5)}</span>
      <span fg={waiting ? theme.warn : color}>{'  ' + pad(tag, 12)}</span>
    </text>
  )
}
