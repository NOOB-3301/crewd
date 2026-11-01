import { homedir } from 'node:os'
import type { Harness, SessionStatus } from '@crewd/protocol'

// Accents only: the app never paints a background, so it follows the terminal's theme.
export const theme = {
  muted: '#8A8F98',
  subtle: '#3B3F46',
  danger: '#FF6B6B',
  ok: '#8BD17C',
  warn: '#FFD75F',
}

const accents: Record<string, string> = {
  claude: '#F2C14E',
  qoder: '#5FD3BC',
  opencode: '#C9A0FF',
  pi: '#7AA7FF',
}
const fallback = ['#E58FB5', '#9AD06B', '#F29B6B', '#6FC3E8', '#D7A8E0']

export function accent(h: Pick<Harness, 'id' | 'color'> | undefined): string {
  if (!h) return theme.muted
  if (h.color) return h.color
  if (accents[h.id]) return accents[h.id]!
  let hash = 0
  for (const c of h.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0
  return fallback[hash % fallback.length]!
}

export const glyph: Record<SessionStatus, string> = { running: '●', waiting: '◆', idle: '○', interrupted: '◌', dead: '×' }

export function shortPath(p: string): string {
  const home = homedir()
  return p === home || p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
}

export function age(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))
