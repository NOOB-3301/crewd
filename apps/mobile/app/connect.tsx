import { useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { credentials, errorMsg, saveCredentials, testConnection } from '../src/api'
import { c } from '../src/ui'

export default function Connect() {
  const insets = useSafeAreaInsets()
  const saved = credentials()
  const [addr, setAddr] = useState(saved?.server ?? '')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function test() {
    // A blank token field means keep the saved one: changing the address must not force a fresh paste.
    const server = addr.trim().replace(/\/+$/, '')
    const token = (typed.trim() || saved?.token || '').trim()
    if (!server.startsWith('https://')) return setErr('The address must start with https://')
    if (!token) return setErr('Paste the token from ~/.crewd/remote-token on the Mac.')
    setErr('')
    setBusy(true)
    try {
      await testConnection({ server, token })
      await saveCredentials({ server, token })
      // REPLACE on an existing stack mints a second Sessions screen, so two list streams and two polls
      // would live forever; coming back is the route that already exists.
      saved ? router.back() : router.replace('/')
    } catch (e) {
      setErr(errorMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior="padding">
      <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>Connect to your Mac</Text>
        <Text style={styles.help}>
          The HTTPS address tailscale serve or ngrok gives you, and the bearer token in ~/.crewd/remote-token.
        </Text>
        <TextInput
          style={styles.field}
          value={addr}
          onChangeText={setAddr}
          placeholder="https://mac.tailnet.ts.net"
          placeholderTextColor={c.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TextInput
          style={styles.field}
          value={typed}
          onChangeText={setTyped}
          placeholder={saved ? 'Token (blank keeps the saved one)' : 'Token'}
          placeholderTextColor={c.faint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
        {!!err && <Text style={styles.err}>{err}</Text>}
        <Pressable style={styles.button} disabled={busy} onPress={test}>
          {busy ? <ActivityIndicator color={c.bg} /> : <Text style={styles.buttonText}>Test connection</Text>}
        </Pressable>
        {!!saved && (
          <Pressable hitSlop={10} onPress={() => router.back()}>
            <Text style={styles.cancel}>Back</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg, padding: 16, gap: 10 },
  title: { color: c.text, fontSize: 20, fontWeight: '700' },
  help: { color: c.muted, fontSize: 13, lineHeight: 19 },
  field: {
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.card,
    borderRadius: 10,
    padding: 12,
    color: c.text,
    fontSize: 15,
  },
  err: { color: c.danger, fontSize: 13 },
  button: { backgroundColor: c.input, borderRadius: 10, padding: 14, alignItems: 'center' },
  buttonText: { color: '#08201B', fontSize: 15, fontWeight: '700' },
  cancel: { color: c.muted, fontSize: 14, textAlign: 'center', marginTop: 6 },
})
