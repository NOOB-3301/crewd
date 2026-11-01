import { theme } from './theme.ts'

export const crewdCommands = ['new', 'sessions', 'stop']

/** Commands matching what was typed after `/`; crewd's own first. */
export function filterCommands(harnessCmds: string[], typed: string): string[] {
  const q = typed.replace(/^\//, '').toLowerCase()
  const all = [...new Set([...crewdCommands, ...harnessCmds.map((c) => c.replace(/^\//, ''))])]
  return all.filter((c) => c.toLowerCase().startsWith(q)).concat(all.filter((c) => !c.toLowerCase().startsWith(q) && c.toLowerCase().includes(q)))
}

export function Palette({ items, selected, color }: { items: string[]; selected: number; color: string }) {
  const start = Math.max(0, Math.min(selected - 3, items.length - 6))
  const shown = items.slice(start, start + 6)
  if (!items.length) return <text fg={theme.muted} flexShrink={0}> no matching commands</text>
  return (
    <box flexDirection="column" flexShrink={0}>
      {shown.map((c, i) => {
        const on = start + i === selected
        return (
          <text key={c}>
            <span fg={color}>{on ? ' › ' : '   '}</span>
            {on ? <b>/{c}</b> : <span fg={theme.muted}>/{c}</span>}
            {crewdCommands.includes(c) && <span fg={theme.muted}>  crewd</span>}
          </text>
        )
      })}
    </box>
  )
}
