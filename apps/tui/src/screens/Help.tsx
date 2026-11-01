import { useKeyboard } from '@opentui/react'
import { KeyHints } from '../ui/KeyHints.tsx'
import { theme } from '../ui/theme.ts'

const keys: [string, string][] = [
  ['↑↓  j k', 'move'],
  ['enter', 'open a session (adds a tile), or expand a tool line'],
  ['n', 'new session (from the list)'],
  ['m', 'MCP servers (from the list)'],
  ['q', 'quit (from the list)'],
  ['/', 'command palette; /permissions picks the mode'],
  ['esc', 'stop the turn; in a permission prompt, deny'],
  ['1/y 2/a 3/n', 'permission prompt: allow, always, deny'],
  ['shift+tab', 'next mode (also ctrl+t)'],
  ['tab', 'switch between input and transcript'],
  ['t', 'transcript: show or hide thinking'],
  ['alt+1..9', 'focus tile n (also ctrl+left/right)'],
  ['ctrl+f', 'focused tile full screen and back'],
  ['ctrl+w', 'close the tile (session keeps running)'],
  ['ctrl+o', 'session list and back to the tiles'],
  ['ctrl+n', 'new session as a tile'],
  ['pgup pgdn', 'scroll the focused tile'],
  ['ctrl+c', 'quit anywhere'],
]

export function Help({ onClose }: { onClose: () => void }) {
  useKeyboard(() => onClose())
  return (
    <box flexDirection="column" height="100%">
      <box paddingX={1} paddingBottom={1}><text><span fg={theme.muted}>crewd  </span><b>Keys</b></text></box>
      <box flexDirection="column" flexGrow={1} paddingLeft={2}>
        {keys.map(([k, a]) => <text key={k}>{k.padEnd(14)}<span fg={theme.muted}>{a}</span></text>)}
      </box>
      <KeyHints hints={[['any key', 'close']]} />
    </box>
  )
}
