// Server-sent events for the phone: expo/fetch gives a real streaming body (plain React Native fetch does not).
// Same replay-and-backoff rules as packages/client, plus the 35s no-bytes watchdog from the plan (Phase 2.3).
import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { fetch } from 'expo/fetch'
import { routes, type LogLine, type SessionMeta } from '@crewd/protocol'
import { sseBlocks } from '@crewd/shared'
import { authHeaders, credentials, goToConnect, url } from './api'

/** The daemon writes a `: ping` every 15s, so 35s of silence means the connection died, not the session. */
const WATCHDOG_MS = 35_000
const MAX_BACKOFF_MS = 5000

/** Streams a session's log lines after `after` until the returned closer runs. Reconnects by itself. */
export function subscribeSession(id: string, opts: { after?: number }, onLine: (line: LogLine) => void): () => void {
  const creds = credentials()
  if (!creds) return () => {}
  let last = opts.after
  let stopped = false
  let conn: AbortController | null = null

  void (async () => {
    let delay = 250
    while (!stopped) {
      const ac = (conn = new AbortController())
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => ac.abort(), WATCHDOG_MS)
      const beat = () => {
        clearTimeout(timer)
        timer = setTimeout(() => ac.abort(), WATCHDOG_MS)
      }
      try {
        const res = await fetch(url(routes.events(id), creds), {
          signal: ac.signal,
          headers: {
            ...authHeaders(creds),
            accept: 'text/event-stream',
            ...(last === undefined ? {} : { 'last-event-id': String(last) }),
          },
        })
        if (res.status === 401) {
          stopped = true
          goToConnect()
          return
        }
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
        delay = 250
        const decoder = new TextDecoder()
        const blocks = sseBlocks()
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          beat()
          if (!value) continue
          for (const block of blocks(decoder.decode(value, { stream: true }))) {
            const line = JSON.parse(block.data) as LogLine
            // Replay overlaps what history() already returned, so drop what we have seen.
            if (last !== undefined && line.seq <= last) continue
            last = block.id !== undefined ? Number(block.id) : line.seq
            onLine(line)
          }
        }
      } catch {
        if (stopped) return
      } finally {
        clearTimeout(timer)
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, MAX_BACKOFF_MS)
    }
  })()

  return () => {
    stopped = true
    conn?.abort()
  }
}

/**
 * GET /events: the whole session list as a push stream. `snapshot` replaces it, `session` is one row that changed.
 * The messages carry no ids and the daemon keeps no backlog (Phase 9), so unlike subscribeSession there is no
 * Last-Event-ID bookkeeping: a reconnect simply takes the fresh snapshot. `live(false)` is the hook's cue to poll.
 */
export function subscribeAllSessions(sink: { snapshot: (list: SessionMeta[]) => void; session: (m: SessionMeta) => void; live: (on: boolean) => void }): () => void {
  const creds = credentials()
  if (!creds) return () => {}
  let stopped = false
  let conn: AbortController | null = null

  void (async () => {
    let delay = 250
    while (!stopped) {
      const ac = (conn = new AbortController())
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => ac.abort(), WATCHDOG_MS)
      const beat = () => {
        clearTimeout(timer)
        timer = setTimeout(() => ac.abort(), WATCHDOG_MS)
      }
      try {
        const res = await fetch(url(routes.allEvents, creds), { signal: ac.signal, headers: { ...authHeaders(creds), accept: 'text/event-stream' } })
        if (res.status === 401) {
          stopped = true
          goToConnect()
          return
        }
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
        delay = 250
        sink.live(true)
        const decoder = new TextDecoder()
        const blocks = sseBlocks()
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          beat()
          if (!value) continue
          for (const block of blocks(decoder.decode(value, { stream: true }))) {
            if (block.event === 'snapshot') sink.snapshot(JSON.parse(block.data) as SessionMeta[])
            else if (block.event === 'session') sink.session(JSON.parse(block.data) as SessionMeta)
          }
        }
      } catch {
        if (stopped) return
      } finally {
        clearTimeout(timer)
      }
      sink.live(false)
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, MAX_BACKOFF_MS)
    }
  })()

  return () => {
    stopped = true
    conn?.abort()
    sink.live(false)
  }
}

/** Android suspends the app out of sight, so streams belong to the foreground: close on background, replay on return. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'))
    return () => sub.remove()
  }, [])
  return active
}
