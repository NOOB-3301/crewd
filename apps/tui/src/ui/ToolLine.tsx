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

export function ToolLine({ t, open, selected, width }: { t: ToolItem; open: boolean; selected: boolean; width: number }) {
  const mark = t.status === 'start' ? '…' : t.status === 'error' ? '✗' : '✓'
  const markColor = t.status === 'start' ? theme.muted : t.status === 'error' ? theme.danger : theme.ok
  const dur = t.endTs ? `${((t.endTs - t.startTs) / 1000).toFixed(1)}s` : ''
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
          <text fg={theme.muted}>{clip(show(t.input))}</text>
          {t.output !== undefined && <text fg={t.status === 'error' ? theme.danger : undefined}>{clip(show(t.output))}</text>}
        </box>
      )}
    </box>
  )
}
