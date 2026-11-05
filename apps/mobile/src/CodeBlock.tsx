// Fenced code, the plan's way (Phase 6.3): monospace on its own background, scrolled sideways instead
// of wrapped, and copyable. No syntax highlighting — that is on the plan's deferred list.
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { c } from './ui'

export default function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <View style={s.box}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.inner}>
        {/* a horizontal ScrollView lays its child out at natural width, so the code scrolls instead of wrapping */}
        <Text style={s.code}>{code}</Text>
      </ScrollView>
      <Pressable
        hitSlop={8}
        onPress={() => {
          void Clipboard.setStringAsync(code).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        <Text style={s.copy}>{copied ? 'copied' : 'copy'}</Text>
      </Pressable>
    </View>
  )
}

const s = StyleSheet.create({
  box: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 8, padding: 8, gap: 6 },
  inner: { paddingRight: 8 },
  code: { color: c.text, fontSize: 12, lineHeight: 18, fontFamily: 'monospace' },
  copy: { color: c.input, fontSize: 12, fontWeight: '700' },
})
