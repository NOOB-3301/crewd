// Presentation vocabulary shared by the screens: the palette and the log-to-label helpers.
// Mirrors apps/tui/src/ui/theme.ts and allSessions.ts, minus the Node APIs (no path/os/homedir on a phone).
import { Text, View } from 'react-native'
import type { SessionStatus } from '@crewd/protocol'

export const c = {
  bg: '#101014',
  card: '#191A20',
  line: '#2A2D35',
  text: '#E8E9ED',
  muted: '#8A8F98',
  faint: '#5C6068',
  danger: '#FF6B6B',
  ok: '#8BD17C',
  warn: '#FFD75F',
  input: '#5FD3BC',
}

const accents: Record<string, string> = { claude: '#F2C14E', qoder: '#5FD3BC', opencode: '#C9A0FF' }
const fallback = ['#E58FB5', '#9AD06B', '#F29B6B', '#6FC3E8', '#D7A8E0']

export function accent(harness: string): string {
  if (accents[harness]) return accents[harness]!
  let hash = 0
  for (const ch of harness) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return fallback[hash % fallback.length]!
}

const status: Record<SessionStatus, { glyph: string; color: string }> = {
  running: { glyph: '●', color: c.ok },
  waiting: { glyph: '◆', color: c.warn },
  idle: { glyph: '○', color: c.muted },
  interrupted: { glyph: '◌', color: c.muted },
  dead: { glyph: '×', color: c.faint },
}

export function StatusDot({ status: s }: { status: SessionStatus }) {
  return <Text style={{ color: status[s].color, fontSize: 13 }}>{status[s].glyph}</Text>
}

/** Same buckets the TUI uses: now / m / h / d. */
export function age(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

export const folderName = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? cwd

/** Titles arrive raw from the harness store: slash-command markup, newlines. Make one readable line. */
export function cleanTitle(t?: string): string {
  if (!t) return 'untitled'
  const cmd = t.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/)
  const args = t.match(/<command-args>\s*([^<]*?)\s*<\/command-args>/)
  if (cmd) return [cmd[1], args?.[1]].filter(Boolean).join(' ')
  return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'untitled'
}

// The fields a tool call is really about, in the order the TUI reads them.
const argKeys = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description', 'prompt']

/** One line describing a tool's input, for a collapsed row and for a permission card. */
export function preview(input: unknown): string {
  if (typeof input === 'string') return input.split('\n')[0]!
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = argKeys.map((k) => o[k]).find((x) => typeof x === 'string') ?? Object.values(o).find((x) => typeof x === 'string')
  return String(v ?? '').split('\n')[0]!
}

export const show = (v: unknown) => (typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? ''))

/** Lost contact with the Mac: say so, offer retry, keep the token. */
export function Banner({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.danger, paddingHorizontal: 12, paddingVertical: 8 }}>
      <Text style={{ flex: 1, color: '#1B0E0E', fontSize: 13 }}>{text}</Text>
      {onRetry && (
        <Text onPress={onRetry} style={{ color: '#1B0E0E', fontWeight: '700', fontSize: 13, paddingLeft: 12 }}>
          Retry
        </Text>
      )}
    </View>
  )
}
