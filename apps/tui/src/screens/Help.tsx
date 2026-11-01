import { useKeyboard } from '@opentui/react'
import { KeyHints } from '../ui/KeyHints.tsx'
import { theme } from '../ui/theme.ts'

const keys: [string, string][] = [
  ['↑↓  j k', 'move'],
  ['enter', 'open, or expand a tool line in chat'],
  ['esc', 'back; in chat, stop the current turn'],
  ['n', 'new session'],
  ['m', 'MCP servers (from home)'],
  ['q', 'quit (not in chat)'],
  ['/', 'command palette in chat'],
  ['tab', 'chat: switch between input and transcript'],
  ['t', 'chat transcript: show or hide thinking'],
  ['ctrl+o', 'chat: sessions'],
  ['ctrl+n', 'chat: new session'],
  ['pgup pgdn', 'chat: scroll'],
  ['ctrl+c', 'quit anywhere'],
]

export function Help({ onClose }: { onClose: () => void }) {
  useKeyboard(() => onClose())
  return (
    <box flexDirection="column" height="100%">
      <box paddingX={1} paddingBottom={1}><text><span fg={theme.muted}>crewd  </span><b>Keys</b></text></box>
      <box flexDirection="column" flexGrow={1} paddingLeft={2}>
        {keys.map(([k, a]) => <text key={k}>{k.padEnd(12)}<span fg={theme.muted}>{a}</span></text>)}
      </box>
      <KeyHints hints={[['any key', 'close']]} />
    </box>
  )
}
