// The Sessions screen's only window onto the list. It is push-driven by GET /events (Phase 9) and falls
// back to the Phase 5 poll when that stream is down, so keep everything list-shaped inside this hook.
import { useEffect, useState } from 'react'
import type { SessionMeta } from '@crewd/protocol'
import { listSessions, Unreachable } from './api'
import { subscribeAllSessions, useAppActive } from './stream'

/** waiting first (it is waiting on the user), then running, then newest activity. */
export function sortSessions(list: SessionMeta[]): SessionMeta[] {
  const rank = (s: SessionMeta) => (s.status === 'waiting' ? 0 : s.status === 'running' ? 1 : 2)
  return [...list].sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
}

export function useSessionList() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [err, setErr] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [live, setLive] = useState(false)
  const active = useAppActive()
  const [nonce, setNonce] = useState(0)

  // Open on the list screen, closed on background: the closer aborts the in-flight read.
  useEffect(() => {
    if (!active) return
    return subscribeAllSessions({
      snapshot: (list) => {
        setSessions(sortSessions(list))
        setErr('')
      },
      session: (m) =>
        setSessions((prev) => sortSessions(prev.some((s) => s.id === m.id) ? prev.map((s) => (s.id === m.id ? m : s)) : [...prev, m])),
      live: setLive,
    })
  }, [active])

  // Pull to refresh always asks once; while the stream is down or stalled that becomes the 3s poll.
  useEffect(() => {
    if (!active) return
    let gone = false
    const load = () =>
      listSessions()
        .then(
          (s) => {
            if (gone) return
            setSessions(sortSessions(s))
            setErr('')
          },
          (e: unknown) => {
            if (gone) return
            setErr(e instanceof Unreachable ? e.message : `Could not list sessions: ${String((e as Error).message ?? e)}`)
          },
        )
        .finally(() => !gone && setRefreshing(false))
    setRefreshing(true)
    load()
    if (live) return () => void (gone = true)
    const t = setInterval(load, 3000)
    return () => {
      gone = true
      clearInterval(t)
    }
  }, [active, nonce, live])

  return { sessions, err, refreshing, refresh: () => setNonce((n) => n + 1) }
}
