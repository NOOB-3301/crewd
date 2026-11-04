// The Sessions screen's only window onto the list. Phase 9 swaps the poll below for the GET /events
// stream without touching the screen, so keep everything list-shaped inside this hook.
import { useEffect, useState } from 'react'
import type { SessionMeta } from '@crewd/protocol'
import { listSessions, Unreachable } from './api'
import { useAppActive } from './stream'

/** waiting first (it is waiting on the user), then running, then newest activity. */
export function sortSessions(list: SessionMeta[]): SessionMeta[] {
  const rank = (s: SessionMeta) => (s.status === 'waiting' ? 0 : s.status === 'running' ? 1 : 2)
  return [...list].sort((a, b) => rank(a) - rank(b) || (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
}

export function useSessionList() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [err, setErr] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const active = useAppActive()
  const [nonce, setNonce] = useState(0)

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
    const t = setInterval(load, 3000)
    return () => {
      gone = true
      clearInterval(t)
    }
  }, [active, nonce])

  return { sessions, err, refreshing, refresh: () => setNonce((n) => n + 1) }
}
