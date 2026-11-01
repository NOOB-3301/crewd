import type { Cmd } from '@crewd/protocol'
import { theme } from './theme.ts'

export type PalItem = Cmd & { crewd?: boolean }

export const crewdCommands: PalItem[] = [
  { name: 'new', description: 'start a new session', crewd: true },
  { name: 'sessions', description: 'list sessions', crewd: true },
  { name: 'stop', description: 'stop the current turn', crewd: true },
]

/** Commands matching what was typed after `/`: prefix matches first, then substring; crewd's own win name clashes. */
export function filterCommands(harnessCmds: Cmd[], typed: string): PalItem[] {
  const q = typed.replace(/^\//, '').toLowerCase()
  const seen = new Set<string>()
  const all = [...crewdCommands, ...harnessCmds.map((c) => ({ ...c, name: c.name.replace(/^\//, '') }))].filter((c) => !seen.has(c.name) && seen.add(c.name))
  const n = (c: PalItem) => c.name.toLowerCase()
  return all.filter((c) => n(c).startsWith(q)).concat(all.filter((c) => !n(c).startsWith(q) && n(c).includes(q)))
}

export function Palette({ items, selected, color, vendor, width }: { items: PalItem[]; selected: number; color: string; vendor: string; width: number }) {
  const start = Math.max(0, Math.min(selected - 3, items.length - 8))
  const shown = items.slice(start, start + 8)
  if (!items.length) return <text fg={theme.muted} flexShrink={0}> no matching commands</text>
  const nameW = Math.min(28, Math.max(...shown.map((c) => c.name.length + 1)))
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.muted}> {items.length} commands · ↑↓ pick · enter use</text>
      {shown.map((c, i) => {
        const on = start + i === selected
        const tag = c.crewd ? 'crewd' : vendor
        const name = `/${c.name}`.padEnd(nameW).slice(0, nameW)
        const rest = Math.max(0, width - nameW - tag.length - 8)
        const desc = (c.hint ? `${c.hint}  ` : '') + (c.description ?? '')
        return (
          <text key={c.name}>
            <span fg={color}>{on ? ' › ' : '   '}</span>
            {on ? <b>{name}</b> : <span>{name}</span>}
            <span fg={c.crewd ? theme.muted : color}> {tag} </span>
            <span fg={theme.muted}>{desc.length > rest ? desc.slice(0, Math.max(0, rest - 1)) + '…' : desc}</span>
          </text>
        )
      })}
    </box>
  )
}
