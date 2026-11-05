import { useEffect, useState } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { loadCredentials } from '../src/api'
import { c } from '../src/ui'

export default function RootLayout() {
  // No screen may fire a request before the saved server and token are in memory.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    loadCredentials().then(() => setReady(true))
  }, [])
  if (!ready) return <View style={{ flex: 1, backgroundColor: c.bg }} />

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }} />
    </SafeAreaProvider>
  )
}
