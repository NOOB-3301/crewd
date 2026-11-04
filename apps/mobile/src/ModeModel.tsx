// Phase 7: the mode and model chips. The log is the source of truth — a chip keeps its old value with a
// spinner until the `mode`/`model` event arrives on the stream; a POST resolving is not that.
import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ModelList } from '@crewd/protocol'
import type { FoldedState } from '@crewd/shared'
import { ApiError, errorMsg, harnessModels, setMode, setModel } from './api'
import { c } from './ui'

/** An accepted switch can take seconds (an idle session gets started again first), but not forever. */
const PENDING_MS = 10_000

/** Same key and shape app/new.tsx reads: a JSON map of harness id -> last model chosen there. */
export const MODEL_KEY = 'crewd.lastModel'

export async function rememberModel(harness: string, model: string) {
  try {
    const raw = await AsyncStorage.getItem(MODEL_KEY)
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    await AsyncStorage.setItem(MODEL_KEY, JSON.stringify({ ...map, [harness]: model }))
  } catch {} // a preference that would not save is not worth a message
}

type Kind = 'mode' | 'model'
type Option = { id: string; label: string; description?: string }

type Props = {
  sessionId: string
  harness: string
  cwd: string
  state: FoldedState
  onError: (msg: string) => void
}

export default function ModeModel({ sessionId, harness, cwd, state, onError }: Props) {
  const [sheet, setSheet] = useState<Kind | null>(null)
  const [pending, setPending] = useState<{ kind: Kind; value: string } | null>(null)
  const [fetched, setFetched] = useState<ModelList | null>(null)

  const current = (kind: Kind) => (kind === 'mode' ? state.mode : state.model)
  const listed = (kind: Kind): Option[] => (kind === 'mode' ? state.modes : state.models.length ? state.models : (fetched?.models ?? []))

  // Clear the spinner when the log reports what we asked for.
  useEffect(() => {
    if (pending && current(pending.kind) === pending.value) setPending(null)
  }, [pending, state.mode, state.model])

  // …or give up on it, so a quiet harness never leaves the chip spinning.
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => setPending(null), PENDING_MS)
    return () => clearTimeout(t)
  }, [pending])

  // A session that has not reported models asks the harness instead, which may start an agent process.
  useEffect(() => {
    if (sheet !== 'model' || state.models.length || fetched) return
    let gone = false
    harnessModels(harness, cwd).then(
      (r) => {
        if (!gone) setFetched(r)
      },
      (e: unknown) => {
        if (!gone) setFetched({ models: [], error: errorMsg(e) })
      },
    )
    return () => {
      gone = true
    }
  }, [sheet, state.models.length, fetched, harness, cwd])

  async function apply(kind: Kind, value: string) {
    setSheet(null)
    setPending({ kind, value })
    try {
      if (kind === 'mode') await setMode(sessionId, value)
      else {
        await setModel(sessionId, value)
        void rememberModel(harness, value)
      }
    } catch (e) {
      setPending(null)
      onError(e instanceof ApiError && e.status === 409 ? 'That session is closed.' : errorMsg(e))
    }
  }

  /** Mirrors the TUI: bypass is listed, but only reachable through an explicit confirmation. */
  function choose(kind: Kind, value: string) {
    if (value !== 'bypassPermissions') return void apply(kind, value)
    Alert.alert('Switch to bypassPermissions?', 'The agent will run every tool without asking.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Switch', style: 'destructive', onPress: () => void apply(kind, value) },
    ])
  }

  // Nothing to list yet and the harness is still being asked: that is the spinner the plan wants.
  const loading = sheet === 'model' && !state.models.length && !fetched
  const options = sheet ? listed(sheet) : []

  return (
    <View style={s.row}>
      {(['mode', 'model'] as const).map((kind) => (
        <Pressable key={kind} onPress={() => setSheet(kind)} style={({ pressed }) => [s.chip, pressed && s.pressed]}>
          {pending?.kind === kind && <ActivityIndicator size="small" color={c.warn} />}
          <Text style={s.chipText} numberOfLines={1}>
            {current(kind) ?? (kind === 'model' ? 'default' : kind)}
          </Text>
        </Pressable>
      ))}

      {!!sheet && (
        <Modal transparent visible animationType="slide" onRequestClose={() => setSheet(null)}>
          <View style={s.wrap}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setSheet(null)} />
            <View style={s.sheet}>
              <Text style={s.sheetTitle}>{sheet === 'mode' ? 'Permission mode' : 'Model'}</Text>
              {loading ? (
                <ActivityIndicator color={c.input} style={s.loading} />
              ) : (
                <ScrollView>
                  {options.map((o) => (
                    <Pressable key={o.id} onPress={() => choose(sheet, o.id)} style={({ pressed }) => [s.opt, pressed && s.pressed]}>
                      <Text style={[s.optLabel, o.id === current(sheet) && s.optCurrent]} numberOfLines={1}>
                        {o.id === current(sheet) ? '⏵ ' : '   '}
                        {o.label}
                      </Text>
                      {!!o.description && <Text style={s.optDesc}>{o.description}</Text>}
                    </Pressable>
                  ))}
                  {!options.length && (
                    <Text style={s.optDesc}>
                      {fetched?.error ?? `${harness} has not reported any ${sheet === 'mode' ? 'modes' : 'models'} for this session.`}
                    </Text>
                  )}
                </ScrollView>
              )}
            </View>
          </View>
        </Modal>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  // two chips must share a narrow header row and ellipsize rather than overflow it
  row: { flexDirection: 'row', gap: 6, marginTop: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    maxWidth: '45%',
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.card,
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  chipText: { color: c.muted, fontSize: 12, flexShrink: 1 },
  pressed: { opacity: 0.6 },
  wrap: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 34,
    backgroundColor: c.bg,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderTopWidth: 1,
    borderColor: c.line,
    maxHeight: '60%',
  },
  sheetTitle: { color: c.text, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  loading: { marginVertical: 24 },
  opt: { paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: c.line },
  optLabel: { color: c.text, fontSize: 15, flexShrink: 1 },
  optCurrent: { color: c.input, fontWeight: '700' },
  optDesc: { color: c.muted, fontSize: 13, marginTop: 2, flexShrink: 1 },
})
