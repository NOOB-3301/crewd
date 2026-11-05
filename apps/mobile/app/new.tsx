// New session: harness, folder, then the optional model / mode / first message. Mirrors apps/tui/src/screens/NewSession.tsx
// minus the Node APIs, so a folder is either tapped from GET /projects or typed as an absolute path.
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, KeyboardAvoidingView, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { router, Stack } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { HarnessInfo, ModelList, ProjectInfo } from '@crewd/protocol'
import { claudeModes } from '@crewd/shared'
import { createSession, errorMsg, harnessModels, harnesses, listSessions, projects, send, Unreachable } from '../src/api'
import { MODEL_KEY, rememberModel } from '../src/ModeModel'
import { accent, age, c, folderName } from '../src/ui'

/** Harnesses change rarely and the modal opens often; pull-to-refresh replaces it. */
let harnessCache: HarnessInfo[] | null = null

/** The map of harness id -> last model there, read the same way src/ModeModel.tsx writes it. */
async function rememberedModel(harness: string): Promise<string> {
  try {
    const raw = await AsyncStorage.getItem(MODEL_KEY)
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>)[harness] : undefined
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

export default function NewSession() {
  const insets = useSafeAreaInsets()
  const [agents, setAgents] = useState<HarnessInfo[]>(harnessCache ?? [])
  const [harness, setHarness] = useState(harnessCache?.[0]?.id ?? '')
  const [known, setKnown] = useState<ProjectInfo[]>([])
  const [picked, setPicked] = useState('')
  const [typed, setTyped] = useState('')
  // The field commits here on blur/enter, so typing a path does not re-ask for models on every keystroke.
  const [custom, setCustom] = useState('')
  const [modelList, setModelList] = useState<ModelList | null>(null)
  const [model, setModel] = useState('')
  const [mode, setMode] = useState('auto')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState('')
  // The started session, so a later failure is the message's and Start must not create twice.
  const [created, setCreated] = useState<{ id: string; cwd: string } | null>(null)

  const h = agents.find((a) => a.id === harness)
  const color = h ? h.color || accent(h.id) : c.input
  const folder = custom || picked
  const cwd = typed.trim() || folder

  const load = useCallback((fresh: boolean) => {
    setRefreshing(true)
    Promise.all([fresh || !harnessCache ? harnesses() : Promise.resolve(harnessCache), projects()])
      .then(
        ([hs, ps]) => {
          const visible = hs.filter((x) => x.installed && !x.disabled)
          harnessCache = visible
          setAgents(visible)
          setKnown(ps)
          setHarness((cur) => (visible.some((x) => x.id === cur) ? cur : (visible[0]?.id ?? '')))
          setErr('')
        },
        (e: unknown) => setErr(errorMsg(e)),
      )
      .finally(() => setRefreshing(false))
  }, [])

  useEffect(() => void load(false), [load])

  // The models are asked for the committed folder only: the daemon may start an agent to answer, so typing must not re-ask.
  useEffect(() => {
    setModelList(null)
    setModel('')
    if (!harness || !folder) return
    let gone = false
    Promise.all([
      harnessModels(harness, folder).catch((e: unknown) => ({ models: [], error: errorMsg(e) }) as ModelList),
      rememberedModel(harness),
    ]).then(([list, saved]) => {
      if (gone) return
      setModelList(list)
      if (saved && list.models.some((m) => m.id === saved)) setModel(saved)
    })
    return () => {
      gone = true
    }
  }, [harness, folder])

  async function start() {
    if (!h || !cwd || busy) return
    setBusy(true)
    setErr('')
    // Knowing what existed before is the only way to tell a lost request from a real failure.
    const made = created?.cwd === cwd ? created : null
    const before = made ? null : await listSessions().then((s) => new Set(s.map((x) => x.id)), () => null)
    let id = made?.id ?? ''
    try {
      if (!id) {
        id = (await createSession({ harness: h.id, cwd, model: model || undefined, permissionMode: h.kind === 'sdk' ? mode : undefined })).id
        setCreated({ id, cwd })
        // Only a list we actually saw rewrites the memory, so a pick made while it loads survives.
        if (modelList && model) void rememberModel(h.id, model)
      }
      if (text.trim()) await send(id, text.trim())
      router.replace({ pathname: '/sessions/[id]', params: { id } })
    } catch (e) {
      setBusy(false)
      if (id) return setErr(`The session is running but your message did not send: ${errorMsg(e)}. Tap Start to retry.`)
      if (!(e instanceof Unreachable)) return setErr(errorMsg(e))
      // The daemon may have started it before the link dropped: look, instead of reporting a failure the list contradicts.
      const fresh = before && (await listSessions().catch(() => null))?.filter((s) => !before.has(s.id))
      const late = fresh?.find((s) => s.harness === h.id && s.cwd === cwd) ?? fresh?.[0]
      if (late) return router.replace({ pathname: '/sessions/[id]', params: { id: late.id } })
      setErr(`${errorMsg(e)} The session may have started anyway, so check the list.`)
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <Stack.Screen options={{ presentation: 'modal' }} />
      <View style={[styles.bar, { paddingTop: insets.top + 8 }]}>
        <Text style={styles.barTitle}>New session</Text>
        <Pressable hitSlop={10} onPress={() => router.back()}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
      </View>

      {!!err && <Text style={styles.err}>{err}</Text>}

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={c.muted} />}
      >
        <Text style={styles.label}>Agent</Text>
        <View style={styles.chips}>
          {agents.map((a) => (
            <Pressable key={a.id} style={[styles.chip, a.id === harness && { borderColor: a.color || accent(a.id) }]} onPress={() => setHarness(a.id)}>
              <Text style={[styles.chipText, { color: a.color || accent(a.id) }]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>
        {!agents.length && <Text style={styles.note}>{refreshing ? 'Loading agents…' : 'No agent is installed on the Mac.'}</Text>}

        <Text style={styles.label}>Project folder</Text>
        {known.map((p) => (
          <Pressable
            key={p.cwd}
            style={[styles.proj, p.cwd === cwd && styles.projOn]}
            onPress={() => {
              setPicked(p.cwd)
              setTyped('')
              setCustom('')
            }}
          >
            <Text style={styles.projName} numberOfLines={1}>
              {folderName(p.cwd)}
            </Text>
            <Text style={styles.projPath} numberOfLines={1} ellipsizeMode="head">
              {p.cwd}
            </Text>
            <Text style={styles.projAge}>{age(p.lastUsed)}</Text>
          </Pressable>
        ))}
        <TextInput
          style={styles.field}
          value={typed}
          onChangeText={(v) => {
            setTyped(v)
            setPicked('')
          }}
          onBlur={() => setCustom(typed.trim())}
          onSubmitEditing={() => setCustom(typed.trim())}
          placeholder="absolute path on the Mac, e.g. /Users/you/Projects/app"
          placeholderTextColor={c.faint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
        />
        {!known.length && !refreshing && <Text style={styles.note}>No recent folders — type a path.</Text>}

        {!!h && !!folder && (
          <>
            <Text style={styles.label}>Model</Text>
            <View style={styles.chips}>
              <Pressable style={[styles.chip, !model && { borderColor: color }]} onPress={() => setModel('')}>
                <Text style={[styles.chipText, !model && { color }]}>{`default${modelList?.current ? ` (${modelList.current})` : ''}`}</Text>
              </Pressable>
              {(modelList?.models ?? []).map((m) => (
                <Pressable key={m.id} style={[styles.chip, m.id === model && { borderColor: color }]} onPress={() => setModel(m.id)}>
                  <Text style={[styles.chipText, m.id === model && { color }]}>{m.label}</Text>
                </Pressable>
              ))}
            </View>
            {!modelList && (
              <View style={styles.spin}>
                <ActivityIndicator size="small" color={c.muted} />
                <Text style={styles.note}>asking {h.label} for its models</Text>
              </View>
            )}
            {!!modelList?.error && <Text style={styles.note}>Could not list models: {modelList.error}</Text>}
          </>
        )}

        {/* Modes are the Claude-SDK ones; an ACP agent names its own and sets them after the session starts (Phase 7). */}
        {!!h && h.kind === 'sdk' && (
          <>
            <Text style={styles.label}>Mode</Text>
            <View style={styles.chips}>
              {claudeModes.map((m) => (
                <Pressable key={m.id} style={[styles.chip, m.id === mode && { borderColor: color }]} onPress={() => setMode(m.id)}>
                  <Text style={[styles.chipText, m.id === mode && { color }]}>{m.id}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        <Text style={styles.label}>First message</Text>
        <TextInput
          style={[styles.field, styles.message]}
          value={text}
          onChangeText={setText}
          placeholder="optional"
          placeholderTextColor={c.faint}
          multiline
        />

        <Pressable style={[styles.start, (!h || !cwd || busy) && styles.startOff]} disabled={!h || !cwd || busy} onPress={() => void start()}>
          {busy ? (
            <View style={styles.spin}>
              <ActivityIndicator size="small" color={c.bg} />
              <Text style={styles.startText}>{`Starting ${h?.label ?? ''} in ${folderName(cwd)}…`}</Text>
            </View>
          ) : (
            <Text style={styles.startText}>Start</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingBottom: 10 },
  barTitle: { color: c.text, fontSize: 18, fontWeight: '700' },
  cancel: { color: c.input, fontSize: 14 },
  err: { color: c.danger, fontSize: 13, paddingHorizontal: 14, paddingBottom: 8 },
  body: { padding: 14, gap: 8 },
  label: { color: c.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginTop: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: c.line, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  chipText: { color: c.muted, fontSize: 14 },
  proj: { borderWidth: 1, borderColor: c.line, borderRadius: 10, padding: 10, gap: 2 },
  projOn: { borderColor: c.input },
  projName: { color: c.text, fontSize: 15, fontWeight: '600' },
  projPath: { color: c.muted, fontSize: 12 },
  projAge: { color: c.faint, fontSize: 11 },
  field: {
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.card,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    color: c.text,
    fontSize: 14,
  },
  message: { minHeight: 76, textAlignVertical: 'top' },
  note: { color: c.muted, fontSize: 12 },
  spin: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  start: { backgroundColor: c.input, borderRadius: 10, paddingVertical: 13, marginTop: 16, alignItems: 'center' },
  startOff: { opacity: 0.4 },
  startText: { color: '#08201B', fontSize: 15, fontWeight: '700' },
})
