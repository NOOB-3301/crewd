import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { Redirect, router } from 'expo-router'
import type { SessionMeta } from '@crewd/protocol'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { credentials } from '../src/api'
import { useSessionList } from '../src/useSessionList'
import { accent, age, Banner, c, cleanTitle, folderName, StatusDot } from '../src/ui'

export default function Sessions() {
  const insets = useSafeAreaInsets()
  const { sessions, err, refreshing, refresh } = useSessionList()
  // Connect holds the server and token; without them nothing here can load.
  if (!credentials()) return <Redirect href="/connect" />

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <Text style={styles.barTitle}>Sessions</Text>
        <View style={styles.barRight}>
          <Pressable hitSlop={10} onPress={() => router.push('/new')}>
            <Text style={styles.new}>+ New</Text>
          </Pressable>
          <Pressable hitSlop={10} onPress={() => router.push('/connect')}>
            <Text style={styles.settings}>Settings</Text>
          </Pressable>
        </View>
      </View>
      {!!err && <Banner text={err} onRetry={refresh} />}
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.muted} />}
        ListEmptyComponent={<Text style={styles.empty}>{refreshing ? 'Loading…' : 'No sessions yet.'}</Text>}
        renderItem={({ item }) => <Row s={item} />}
      />
    </View>
  )
}

function Row({ s }: { s: SessionMeta }) {
  const waiting = s.status === 'waiting'
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/sessions/[id]', params: { id: s.id } })}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, waiting && styles.waiting]}
    >
      <View style={styles.rowHead}>
        <Text style={[styles.harness, { color: accent(s.harness) }]}>{s.harness}</Text>
        <StatusDot status={s.status} />
        <Text style={styles.status}>{s.status}</Text>
        <Text style={styles.age}>{age(s.updatedAt ?? s.createdAt)}</Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {cleanTitle(s.title)}
      </Text>
      <Text style={styles.folder} numberOfLines={1}>
        {folderName(s.cwd)}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10 },
  barRight: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  barTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  new: { color: c.input, fontSize: 14, fontWeight: '700' },
  settings: { color: c.input, fontSize: 14 },
  list: { padding: 10, gap: 8 },
  empty: { color: c.muted, fontSize: 14, textAlign: 'center', marginTop: 40 },
  row: { backgroundColor: c.card, borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 12, gap: 4 },
  pressed: { opacity: 0.7 },
  waiting: { borderColor: c.warn },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  harness: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  status: { color: c.muted, fontSize: 12, flex: 1 },
  age: { color: c.faint, fontSize: 12 },
  title: { color: c.text, fontSize: 15 },
  folder: { color: c.muted, fontSize: 12 },
})
