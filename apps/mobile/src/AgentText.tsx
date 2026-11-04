// The single seam for markdown: Phase 6 replaces this file and nothing else.
// Contract: `open` means the text is still streaming, and streaming text stays plain —
// markdown-it parses the whole string, so re-parsing every chunk is what costs the frames (plan 6.4).
import { memo, useMemo } from 'react'
import { Alert, Linking, StyleSheet, Text } from 'react-native'
import { Markdown, type RenderRules } from '@believer/react-native-markdown-display'
import CodeBlock from './CodeBlock'
import { c } from './ui'

/** Only web links, and only after the user has read the whole URL (plan Security notes). */
function askOpen(href: unknown) {
  const link = typeof href === 'string' ? href : ''
  if (!/^https?:\/\//i.test(link)) return
  Alert.alert('Open this link?', link, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Open', onPress: () => void Linking.openURL(link).catch(() => {}) },
  ])
}

const style = StyleSheet.create({
  // text props on `body` cascade down to every leaf Text the renderer builds
  body: { color: c.text, fontSize: 15, lineHeight: 22 },
  heading1: { fontSize: 24 },
  heading2: { fontSize: 20 },
  heading3: { fontSize: 18 },
  heading4: { fontSize: 16 },
  heading5: { fontSize: 15 },
  heading6: { fontSize: 14, textTransform: 'uppercase' },
  paragraph: { marginVertical: 4 },
  blockquote: { backgroundColor: c.card, borderColor: c.faint },
  code_inline: { backgroundColor: c.line, borderWidth: 0, color: c.text, fontFamily: 'monospace', fontSize: 13, paddingHorizontal: 4, paddingVertical: 1 },
  hr: { backgroundColor: c.line, height: 1, marginVertical: 8 },
  link: { color: c.input, textDecorationLine: 'underline' },
  table: { borderColor: c.line },
  th: { color: c.text },
  td: { color: c.text },
  tr: { borderColor: c.line },
})

const trim = (content: string) => (content.endsWith('\n') ? content.slice(0, -1) : content)

const rules: RenderRules = {
  fence: (node) => <CodeBlock key={node.key} code={trim(node.content)} />,
  code_block: (node) => <CodeBlock key={node.key} code={trim(node.content)} />,
  // never rendered: a remote image is a fetch the agent chose, not the user (plan 6.6)
  image: () => null,
  link: (node, children) => (
    <Text key={node.key} style={style.link} onPress={() => askOpen(node.attributes.href)}>
      {children}
    </Text>
  ),
}

export default memo(function AgentText({ text, open }: { text: string; open: boolean }) {
  const md = useMemo(
    () =>
      open ? null : (
        <Markdown style={style} rules={rules}>
          {text}
        </Markdown>
      ),
    [text, open],
  )
  if (open)
    return (
      <Text selectable style={style.body}>
        {text}
        <Text style={s.caret}> ▍</Text>
      </Text>
    )
  return md
})

const s = StyleSheet.create({
  caret: { color: c.warn },
})
