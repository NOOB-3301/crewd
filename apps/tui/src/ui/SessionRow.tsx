import type { SessionMeta } from '@crewd/protocol'
import { age, glyph, pad, shortPath, theme } from './theme.ts'

/** title, cwd, age, native tag. `compact` drops the cwd for narrow panes. */
export function SessionRow({ s, color, selected, width, compact }: {
  s: SessionMeta; color: string; selected?: boolean; width: number; compact?: boolean
}) {
  const tail = 6 + (compact ? 0 : 26) + 8
  return (
    <text wrapMode="none">
      <span fg={color}>{selected ? '› ' : '  '}</span>
      <span fg={s.status === 'dead' ? theme.danger : color}>{glyph[s.status]} </span>
      {selected ? <b>{pad(s.title || 'untitled', Math.max(8, width - tail))}</b> : pad(s.title || 'untitled', Math.max(8, width - tail))}
      {!compact && <span fg={theme.muted}> {pad(shortPath(s.cwd), 25)}</span>}
      <span fg={theme.muted}>{age(s.updatedAt ?? s.createdAt).padStart(4)}</span>
      <span fg={theme.muted}>{s.source === 'native' ? '  native' : ''}</span>
    </text>
  )
}
