import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import type { LogLine, PermissionOption, SessionMeta } from '@crewd/protocol'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { answer, ApiError, errorMsg, history, interrupt, send, sessionMeta } from '../../src/api'
import AgentText from '../../src/AgentText'
import { subscribeSession, useAppActive } from '../../src/stream'
import { accent, age, Banner, c, cleanTitle, folderName, preview, show, StatusDot } from '../../src/ui'
import { foldState, toBlocks, type Pending, type ToolItem } from '@crewd/shared'

/** The tail the plan loads on open: enough to read, small enough to fold in one pass. */
const TURNS = 40
/** Tool output is the part that gets long; past this the rest is a tap away. */
const OUTPUT_LIMIT = 4096

type Row =
  | { key: string; kind: 'you'; text: string }
  | { key: string; kind: 'error'; text: string }
  | { key: string; kind: 'agent'; text: string; open: boolean }
  | { key: string; kind: 'thinking'; text: string }
  | { key: string; kind: 'tool'; tool: ToolItem }

export default function Session() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const insets = useSafeAreaInsets()
  const active = useAppActive()
  const [meta, setMeta] = useState<SessionMeta | null>(null)
  const [lines, setLines] = useState<LogLine[]>([])
  const [answered, setAnswered] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [offline, setOffline] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [draft, setDraft] = useState('')
  const [reload, setReload] = useState(0)
  const list = useRef<FlatList<Row>>(null)

  // Tail first, then subscribe from its last seq: the backlog and the live edge meet with no gap and no duplicate.
  useEffect(() => {
    if (!active) return
    let gone = false
    let close = () => {}
    Promise.all([sessionMeta(id), history(id, TURNS)])
      .then(([m, h]) => {
        if (gone) return
        setMeta(m)
        setLines(h)
        setErr('')
        setOffline(false)
        close = subscribeSession(id, { after: h.at(-1)?.seq }, (l) => setLines((prev) => [...prev, l]))
      })
      .catch((e: unknown) => {
        if (gone) return
        setErr(errorMsg(e))
        setOffline(!(e instanceof ApiError))
      })
    return () => {
      gone = true
      close()
    }
  }, [id, active, reload])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    toBlocks(lines).forEach((b, bi) => {
      if (b.who === 'you') out.push({ key: `b${bi}`, kind: 'you', text: b.text })
      else if (b.who === 'error') out.push({ key: `b${bi}`, kind: 'error', text: b.message })
      else
        b.items.forEach((it, ii) => {
          const key = `b${bi}-${'key' in it ? it.key : `t${ii}`}`
          if (it.k === 'text') out.push({ key, kind: 'agent', text: it.text, open: it.open })
          else if (it.k === 'thinking') out.push({ key, kind: 'thinking', text: it.text })
          else out.push({ key, kind: 'tool', tool: it })
        })
    })
    return out
  }, [lines])

  const state = useMemo(() => (meta ? foldState(lines, meta) : null), [lines, meta])
  const pending = state ? [...state.requests.values()].find((r) => !answered.includes(r.requestId)) : undefined
  const busy = state?.status === 'running' || state?.status === 'waiting'

  // Follow the stream only while the user is already at the bottom, otherwise it fights their scroll-back.
  useEffect(() => {
    if (atBottom) list.current?.scrollToEnd({ animated: false })
  }, [rows, atBottom])

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent
    setAtBottom(contentOffset.y + layoutMeasurement.height >= contentSize.height - 40)
  }, [])

  const retry = useCallback(() => {
    setErr('')
    setOffline(false)
    setReload((n) => n + 1)
  }, [])

  /** Optimistic: drop the card now, put it back if the POST fails. A 404 means another client got there first. */
  async function ask(requestId: string, optionId: string) {
    setAnswered((a) => [...a, requestId])
    try {
      await answer(id, requestId, optionId)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return setReload((n) => n + 1)
      setAnswered((a) => a.filter((r) => r !== requestId))
      setErr(errorMsg(e))
    }
  }

  async function submit() {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    try {
      await send(id, text)
    } catch (e) {
      setDraft(text)
      setErr(errorMsg(e))
      setOffline(!(e instanceof ApiError))
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        {meta && (
          <>
            <View style={styles.headRow}>
              <Text style={[styles.harness, { color: accent(meta.harness) }]}>{meta.harness}</Text>
              {state && <StatusDot status={state.status} />}
              {state && <Text style={styles.statusText}>{state.status}</Text>}
              <Text style={styles.age}>{age(meta.updatedAt ?? meta.createdAt)}</Text>
            </View>
            <Text style={styles.title} numberOfLines={2}>
              {cleanTitle(meta.title)}
            </Text>
            <Text style={styles.folder} numberOfLines={1}>
              {folderName(meta.cwd)}
            </Text>
          </>
        )}
      </View>

      {offline && <Banner text={err || "Can't reach your Mac."} onRetry={retry} />}

      <View style={styles.body}>
        <FlatList
          ref={list}
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={({ item }) => <RowView row={item} />}
          contentContainerStyle={styles.list}
          onScroll={onScroll}
          scrollEventThrottle={100}
          ListEmptyComponent={meta ? <Text style={styles.empty}>Nothing said yet.</Text> : undefined}
        />
        {!atBottom && (
          <Pressable
            style={[styles.pill, { bottom: 12 }]}
            onPress={() => {
              setAtBottom(true)
              list.current?.scrollToEnd({ animated: true })
            }}
          >
            <Text style={styles.pillText}>jump to latest</Text>
          </Pressable>
        )}
      </View>

      {!offline && !!err && <Text style={styles.err}>{err}</Text>}
      {pending && <Permission req={pending} onAnswer={(o) => void ask(pending.requestId, o)} />}

      <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => void submit()}
          placeholder={busy ? 'Send a follow-up' : 'Message'}
          placeholderTextColor={c.faint}
          multiline
        />
        {busy && (
          <Pressable hitSlop={8} style={styles.barBtn} onPress={() => void interrupt(id).catch((e: unknown) => setErr(errorMsg(e)))}>
            <Text style={[styles.barBtnText, { color: c.danger }]}>Stop</Text>
          </Pressable>
        )}
        <Pressable hitSlop={8} style={styles.barBtn} onPress={() => void submit()}>
          <Text style={[styles.barBtnText, { color: c.input }]}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

function RowView({ row }: { row: Row }) {
  if (row.kind === 'you') return <Text style={styles.you}>{row.text}</Text>
  if (row.kind === 'error') return <Text style={styles.errorText}>{row.text}</Text>
  if (row.kind === 'agent') return <AgentText text={row.text} open={row.open} />
  if (row.kind === 'thinking') return <Thinking text={row.text} />
  return <Tool tool={row.tool} />
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Pressable onPress={() => setOpen((o) => !o)}>
      <Text style={styles.thinkingHead}>{open ? '▾ thinking' : '▸ thinking'}</Text>
      {open && <Text style={styles.thinking}>{text}</Text>}
    </Pressable>
  )
}

function Tool({ tool }: { tool: ToolItem }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  const out = show(tool.output)
  const mark = tool.status === 'start' ? '…' : tool.status === 'error' ? '✗' : '✓'
  const color = tool.status === 'start' ? c.muted : tool.status === 'error' ? c.danger : c.ok
  return (
    <View>
      <Pressable style={styles.toolHead} onPress={() => setOpen((o) => !o)}>
        <Text style={{ color: c.text, fontSize: 13, width: 16 }}>{mark}</Text>
        <Text style={styles.toolName}>{tool.name}</Text>
        <Text style={styles.toolArg} numberOfLines={1}>
          {preview(tool.input)}
        </Text>
        <Text style={{ color }}>{tool.status}</Text>
      </Pressable>
      {open && (
        <View style={styles.toolBody}>
          {tool.input !== undefined && <Text style={styles.toolInput}>{show(tool.input)}</Text>}
          {tool.output !== undefined && (
            <>
              <Text style={styles.toolOutput}>{full ? out : out.slice(0, OUTPUT_LIMIT)}</Text>
              {!full && out.length > OUTPUT_LIMIT && (
                <Pressable onPress={() => setFull(true)}>
                  <Text style={styles.showMore}>{`show more (${(out.length - OUTPUT_LIMIT).toLocaleString()} more chars)`}</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      )}
    </View>
  )
}

const kindColor: Record<PermissionOption['kind'], string> = { allow: c.ok, always: c.input, deny: c.danger }

/** Pinned above the input bar, never in the list: an unanswered prompt must not scroll out of sight. */
function Permission({ req, onAnswer }: { req: Pending; onAnswer: (optionId: string) => void }) {
  return (
    <View style={styles.perm}>
      <Text style={styles.permTool}>◆ {req.tool} wants permission</Text>
      <Text style={styles.permDetail} numberOfLines={3}>
        {req.title || preview(req.input) || show(req.input)}
      </Text>
      <View style={styles.permRow}>
        {req.options.map((o) => (
          <Pressable key={o.id} style={[styles.permBtn, { borderColor: kindColor[o.kind] }]} onPress={() => onAnswer(o.id)}>
            <Text style={{ color: kindColor[o.kind], fontSize: 13 }}>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg },
  header: { paddingHorizontal: 12, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: c.line },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  harness: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  statusText: { color: c.muted, fontSize: 12, flex: 1 },
  age: { color: c.faint, fontSize: 12 },
  title: { color: c.text, fontSize: 15, fontWeight: '600' },
  folder: { color: c.muted, fontSize: 12 },
  body: { flex: 1 },
  list: { padding: 12, gap: 8 },
  empty: { color: c.muted, fontSize: 14, textAlign: 'center', marginTop: 30 },
  you: { color: c.input, fontSize: 15, textAlign: 'right' },
  errorText: { color: c.danger, fontSize: 14 },
  thinkingHead: { color: c.faint, fontSize: 12 },
  thinking: { color: c.faint, fontSize: 13, marginTop: 2 },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  toolName: { color: c.text, fontSize: 13, fontWeight: '600' },
  toolArg: { color: c.muted, fontSize: 13, flex: 1 },
  toolBody: { paddingLeft: 14, marginTop: 4, gap: 4 },
  toolInput: { color: c.muted, fontSize: 12, fontFamily: 'monospace' },
  toolOutput: { color: c.text, fontSize: 12, fontFamily: 'monospace' },
  showMore: { color: c.input, fontSize: 12 },
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: c.card,
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  pillText: { color: c.text, fontSize: 12 },
  err: { color: c.danger, fontSize: 12, paddingHorizontal: 12, paddingBottom: 4 },
  perm: { margin: 10, padding: 12, backgroundColor: c.card, borderWidth: 1, borderColor: c.warn, borderRadius: 10, gap: 6 },
  permTool: { color: c.warn, fontSize: 14, fontWeight: '700' },
  permDetail: { color: c.muted, fontSize: 13 },
  permRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  permBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: c.line,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.card,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: c.text,
    fontSize: 15,
    maxHeight: 120,
  },
  barBtn: { paddingHorizontal: 8, paddingVertical: 10 },
  barBtnText: { fontSize: 15, fontWeight: '700' },
})
