import type { ToolItem } from '@crewd/shared'
import { pad, theme } from './theme.ts'

const argKeys = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt']

export function mainArg(input: unknown): string {
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = argKeys.map((k) => o[k]).find((x) => typeof x === 'string') ?? Object.values(o).find((x) => typeof x === 'string')
  return String(v ?? '').split('\n')[0]!
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? '')
const clip = (s: string, n = 20) => {
  const lines = s.split('\n')
  return lines.length > n ? [...lines.slice(0, n), `… ${lines.length - n} more lines (enter again for all)`].join('\n') : s
}

const lineCount = (s: string) => s.split('\n').length
/** Whether the open view cuts anything, i.e. a 'full output' step would show more. */
export function clipped(t: ToolItem): boolean {
  const cs = changes(t.input)
  const inputLong = cs ? cs.reduce((n, c) => n + (c.old ? lineCount(c.old) : 0) + lineCount(c.new), 0) + cs.length - 1 > 40 : lineCount(show(t.input)) > 20
  return inputLong || (t.output !== undefined && lineCount(show(t.output)) > 20)
}

type Change = { old: string; new: string }
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** Edit/MultiEdit/Write-style inputs as before/after pairs; undefined for any other tool. */
export function changes(input: unknown): Change[] | undefined {
  if (!input || typeof input !== 'object') return
  const o = input as Record<string, unknown>
  const one = (x: Record<string, unknown>): Change | undefined => {
    const n = str(x.new_string) ?? str(x.newText) ?? str(x.new_str)
    if (n === undefined) return
    return { old: str(x.old_string) ?? str(x.oldText) ?? str(x.old_str) ?? '', new: n }
  }
  if (Array.isArray(o.edits)) {
    const cs = o.edits.map((e) => (e && typeof e === 'object' ? one(e as Record<string, unknown>) : undefined))
    return cs.every(Boolean) && cs.length ? (cs as Change[]) : undefined
  }
  const c = one(o)
  if (c) return [c]
  const w = str(o.content)
  return w !== undefined && str(o.file_path) ? [{ old: '', new: w }] : undefined
}

function Diff({ cs, max }: { cs: Change[]; max: number }) {
  const rows = cs.flatMap((c, i) => [
    ...(i ? [{ t: ' ', text: '⋯' }] : []),
    ...(c.old ? c.old.split('\n').map((text) => ({ t: '-', text })) : []),
    ...c.new.split('\n').map((text) => ({ t: '+', text })),
  ])
  const shown = rows.slice(0, max)
  return (
    <box flexDirection="column">
      {shown.map((r, i) => (
        <text key={i} fg={r.t === '-' ? theme.danger : r.t === '+' ? theme.ok : theme.muted}>{r.t} {r.text}</text>
      ))}
      {rows.length > max && <text fg={theme.muted}>… {rows.length - max} more lines (enter again for all)</text>}
    </box>
  )
}

export function ToolLine({ t, open, full, selected, width, onClick }: {
  t: ToolItem; open: boolean; full?: boolean; selected: boolean; width: number; onClick?: () => void
}) {
  const cut = (v: unknown) => (full ? show(v) : clip(show(v)))
  const mark = t.status === 'start' ? '…' : t.status === 'error' ? '✗' : '✓'
  const markColor = t.status === 'start' ? theme.muted : t.status === 'error' ? theme.danger : theme.ok
  const dur = t.endTs ? `${((t.endTs - t.startTs) / 1000).toFixed(1)}s` : ''
  const diff = open ? changes(t.input) : undefined
  const argWidth = Math.max(8, width - t.name.length - 16)
  return (
    <box flexDirection="column" paddingLeft={2}>
      {/* click target is the header only, so drag-selecting the output to copy it does not fold it */}
      <text onMouseDown={onClick}>
        <span fg={selected ? undefined : theme.muted}>{open ? '▾ ' : '▸ '}</span>
        {selected ? <b>{t.name}</b> : t.name}
        <span fg={theme.muted}>  {pad(mainArg(t.input), argWidth)} </span>
        <span fg={markColor}>{mark}</span>
        <span fg={theme.muted}> {dur}</span>
      </text>
      {open && (
        <box flexDirection="column" paddingLeft={2}>
          {diff ? <Diff cs={diff} max={full ? Infinity : 40} /> : <text fg={theme.muted}>{cut(t.input)}</text>}
          {t.output !== undefined && <text fg={t.status === 'error' ? theme.danger : undefined}>{cut(t.output)}</text>}
        </box>
      )}
    </box>
  )
}
