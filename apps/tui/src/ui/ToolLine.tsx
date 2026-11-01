import { pad, theme } from './theme.ts'

export type ToolItem = {
  k: 'tool'; id: string; name: string; status: 'start' | 'end' | 'error'
  input?: unknown; output?: unknown; startTs: number; endTs?: number
}

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
  return lines.length > n ? [...lines.slice(0, n), `… ${lines.length - n} more lines`].join('\n') : s
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

function Diff({ cs }: { cs: Change[] }) {
  const rows = cs.flatMap((c, i) => [
    ...(i ? [{ t: ' ', text: '⋯' }] : []),
    ...(c.old ? c.old.split('\n').map((text) => ({ t: '-', text })) : []),
    ...c.new.split('\n').map((text) => ({ t: '+', text })),
  ])
  const max = 40
  const shown = rows.slice(0, max)
  return (
    <box flexDirection="column">
      {shown.map((r, i) => (
        <text key={i} fg={r.t === '-' ? theme.danger : r.t === '+' ? theme.ok : theme.muted}>{r.t} {r.text}</text>
      ))}
      {rows.length > max && <text fg={theme.muted}>… {rows.length - max} more lines</text>}
    </box>
  )
}

export function ToolLine({ t, open, selected, width }: { t: ToolItem; open: boolean; selected: boolean; width: number }) {
  const mark = t.status === 'start' ? '…' : t.status === 'error' ? '✗' : '✓'
  const markColor = t.status === 'start' ? theme.muted : t.status === 'error' ? theme.danger : theme.ok
  const dur = t.endTs ? `${((t.endTs - t.startTs) / 1000).toFixed(1)}s` : ''
  const diff = open ? changes(t.input) : undefined
  const argWidth = Math.max(8, width - t.name.length - 16)
  return (
    <box flexDirection="column" paddingLeft={2}>
      <text>
        <span fg={selected ? undefined : theme.muted}>{open ? '▾ ' : '▸ '}</span>
        {selected ? <b>{t.name}</b> : t.name}
        <span fg={theme.muted}>  {pad(mainArg(t.input), argWidth)} </span>
        <span fg={markColor}>{mark}</span>
        <span fg={theme.muted}> {dur}</span>
      </text>
      {open && (
        <box flexDirection="column" paddingLeft={2}>
          {diff ? <Diff cs={diff} /> : <text fg={theme.muted}>{clip(show(t.input))}</text>}
          {t.output !== undefined && <text fg={t.status === 'error' ? theme.danger : undefined}>{clip(show(t.output))}</text>}
        </box>
      )}
    </box>
  )
}
