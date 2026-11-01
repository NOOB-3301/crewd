import { theme } from './theme.ts'

export function ThinkingLine({ text, open, selected }: { text: string; open: boolean; selected: boolean }) {
  const n = text.split('\n').length
  return (
    <box flexDirection="column" paddingLeft={2}>
      <text fg={theme.muted}>
        {open ? '▾ ' : '▸ '}
        {selected ? <b>thinking</b> : 'thinking'}  {n} {n === 1 ? 'line' : 'lines'}
      </text>
      {open && <text fg={theme.muted} paddingLeft={2}><i>{text}</i></text>}
    </box>
  )
}
