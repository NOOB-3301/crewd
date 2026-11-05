import { useEffect, useMemo, useRef, useState } from 'react'
import type { HarnessInfo, ImageRef, LogLine, ModeId, SessionMeta } from '@crewd/protocol'
import * as client from '@crewd/client'
import { foldState, toBlocks } from '@crewd/shared'
import { readPref } from './prefs.ts'

export const defaultMode = (): ModeId => readPref<{ defaultMode?: ModeId }>('tui.json', {}).defaultMode ?? 'auto'

/** One session's log: history + live stream folded into what a chat view or a tile shows, plus its actions. */
export function useSession(initial: SessionMeta, harness: HarnessInfo, onLive?: (s: SessionMeta) => void) {
  const [session, setSession] = useState(initial)
  const [past, setPast] = useState<LogLine[]>([]) // native history kept on screen after we take the session over
  const [lines, setLines] = useState<LogLine[]>([])
  const [answered, setAnswered] = useState<Set<string>>(new Set())
  const [err, setErr] = useState('')

  useEffect(() => {
    let unsub = () => {}
    let gone = false
    client.history(session.id).then((h) => {
      if (gone) return
      setLines(h)
      if (session.source === 'crewd') unsub = client.subscribe(session.id, (l) => setLines((p) => [...p, l]), { after: h.at(-1)?.seq })
    }).catch((e) => setErr(`Could not load this session: ${e.message}. Press ctrl+o to go back to the list.`))
    return () => { gone = true; unsub() }
  }, [session.id])

  // shortcut: refolds the whole log on every line; fine for normal sessions, memoize per block if huge logs lag.
  const all = useMemo(() => [...past, ...lines], [past, lines])
  const blocks = useMemo(() => toBlocks(all), [all])
  const derived = useMemo(() => foldState(lines, session), [lines, session])
  // `answered` stays per client, out of foldState: a request this screen sent an answer for must not show again.
  const pending = [...derived.requests.values()].find((a) => !answered.has(a.requestId))

  // A session found in the harness's own store has no live process; resuming it gives us one (and its commands).
  const live = useRef<Promise<SessionMeta> | null>(null)
  function goLive(): Promise<SessionMeta> {
    if (session.source !== 'native') return Promise.resolve(session)
    live.current ??= client.createSession({
      harness: harness.id, cwd: session.cwd, resumeId: session.nativeId ?? session.id,
      permissionMode: harness.id === 'claude' ? defaultMode() : undefined,
    }).then((s) => {
      setPast(all)
      setLines([])
      setSession(s)
      onLive?.(s)
      return s
    }, (e) => { live.current = null; throw e })
    return live.current
  }

  /** Resolves true once sent; on failure sets err and resolves false so the caller can restore the draft. */
  async function send(text: string, images?: ImageRef[]): Promise<boolean> {
    setErr('')
    try {
      const s = await goLive()
      await client.send(s.id, text, images)
      return true
    } catch (e: any) {
      setErr(`Not sent: ${e.message}. Press enter to retry.`)
      return false
    }
  }

  async function stop() {
    try { await client.interrupt(session.id) } catch (e: any) { setErr(`Could not stop the turn: ${e.message}`) }
  }

  async function answer(requestId: string, optionId: string) {
    setAnswered((a) => new Set(a).add(requestId))
    try { await client.answerPermission(session.id, requestId, optionId) } catch (e: any) {
      setAnswered((a) => { const n = new Set(a); n.delete(requestId); return n })
      setErr(`Could not answer the permission request: ${e.message}`)
    }
  }

  async function setMode(mode: ModeId) {
    try {
      const s = await goLive()
      await client.setMode(s.id, mode)
      setErr('')
    } catch (e: any) { setErr(`Could not switch to ${mode}: ${e.message}`) }
  }

  async function setModel(model: string) {
    try {
      const s = await goLive()
      await client.setModel(s.id, model)
      setErr('')
    } catch (e: any) { setErr(`Could not switch to ${model}: ${e.message}`) }
  }

  /** Next mode in the session's list, skipping bypassPermissions (only reachable through /permissions). */
  function cycleMode() {
    const list = derived.modes.filter((m) => m.id !== 'bypassPermissions')
    if (!list.length) return setErr(`${harness.label} has not reported any modes for this session yet.`)
    const i = list.findIndex((m) => m.id === derived.mode)
    return setMode(list[(i + 1) % list.length]!.id)
  }

  return { session, harness, blocks, ...derived, pending, err, setErr, goLive, send, stop, answer, setMode, setModel, cycleMode }
}

export type SessionState = ReturnType<typeof useSession>
