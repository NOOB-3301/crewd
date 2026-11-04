// The single seam for markdown: Phase 6 replaces this file and nothing else.
// Contract: `open` means the text is still streaming (plain rendering while open is the plan's CPU rule).
import { Text } from 'react-native'
import { c } from './ui'

export default function AgentText({ text, open }: { text: string; open: boolean }) {
  return (
    <Text selectable style={{ color: c.text, fontSize: 15, lineHeight: 22 }}>
      {open ? text + ' ▍' : text}
    </Text>
  )
}
