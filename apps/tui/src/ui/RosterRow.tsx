import type { HarnessInfo } from '@crewd/protocol'
import { accent, pad, theme } from './theme.ts'

export function RosterRow({ h, selected }: { h: HarnessInfo; selected: boolean }) {
  const usable = h.installed && !h.disabled
  const right = !h.installed ? 'not installed' : h.disabled ? 'off' : String(h.count)
  return (
    <text>
      <span fg={accent(h)}>{selected ? '› ' : '  '}</span>
      <span fg={usable ? accent(h) : theme.muted}>● </span>
      <span fg={usable ? undefined : theme.muted}>{selected ? <b>{pad(h.label, 16)}</b> : pad(h.label, 16)}</span>
      <span fg={theme.muted}>{right.padStart(13)}</span>
    </text>
  )
}
