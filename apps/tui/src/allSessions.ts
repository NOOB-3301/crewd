import { useEffect, useState } from 'react'
import { basename } from 'node:path'
import { tmpdir } from 'node:os'
import type { HarnessInfo, McpServer, SessionMeta } from '@crewd/protocol'
import * as client from '@crewd/client'
import { shortPath } from './ui/theme.ts'

export const recent = (s: SessionMeta) => s.updatedAt ?? s.createdAt

/** Session titles come from the harness store raw: slash-command markup, newlines. Make them one readable line. */
export function cleanTitle(t?: string): string {
  if (!t) return 'untitled'
  const cmd = t.match(/<command-name>\s*([^<]+?)\s*<\/command-name>/)
  const args = t.match(/<command-args>\s*([^<]*?)\s*<\/command-args>/)
  if (cmd) return [cmd[1], args?.[1]].filter(Boolean).join(' ')
  return t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'untitled'
}

const TMP = ['/tmp/', '/private/tmp/', '/private/var/folders/', '/var/folders/', tmpdir() + '/']
/** Throwaway folders (tests, scratch); hidden from Home unless asked. */
export const isTemp = (cwd: string) => TMP.some((p) => (cwd + '/').startsWith(p))
/** Hide temp-folder sessions unless asked; live ones always show. */
export const visibleSessions = <T extends { cwd: string; status?: string }>(all: T[], showTemp = false) =>
  showTemp ? all : all.filter((s) => !isTemp(s.cwd) || s.status === 'running' || s.status === 'waiting')

export type Group = { key: string; name: string; sub: string; color?: string; sessions: SessionMeta[]; live: number; waiting: number; last: number }

/** Every session crewd knows: its own (live) first, plus each installed harness's store, deduped, newest first. Polls. */
// Shared across screens so moving between Home, a card and New session doesn't reload from empty.
const cache = { hs: [] as HarnessInfo[], mcp: [] as McpServer[], live: [] as SessionMeta[], old: {} as Record<string, SessionMeta[]>, loaded: false }

export function useAllSessions() {
  const [hs, setHs] = useState(cache.hs)
  const [mcp, setMcp] = useState(cache.mcp)
  const [live, setLive] = useState(cache.live)
  const [old, setOld] = useState(cache.old)
  const [loaded, setLoaded] = useState(cache.loaded)
  const [err, setErr] = useState('')

  useEffect(() => {
    const load = () => Promise.all([client.harnesses(), client.getMcp(), client.liveSessions()])
      .then(([h, m, l]) => { setHs((cache.hs = h)); setMcp((cache.mcp = m)); setLive((cache.live = l)); setErr('') })
      .catch((e) => setErr(`${e.message}. Retrying every 3s; if it keeps failing, check ~/.crewd/daemon.log.`))
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])

  // Harness stores can be slow to read, so reload one only when its session count changes.
  const installed = hs.filter((h) => h.installed && !h.disabled)
  const counts = installed.map((h) => `${h.id}:${h.count}`).join(',')
  useEffect(() => {
    if (!hs.length) return
    Promise.allSettled(installed.map((h) => client.harnessSessions(h.id).then((s) => setOld((cache.old = { ...cache.old, [h.id]: s })))))
      .then(() => setLoaded((cache.loaded = true)))
  }, [counts])

  const liveIds = new Set(live.flatMap((s) => (s.nativeId ? [s.id, s.nativeId] : [s.id])))
  const past = installed.flatMap((h) => old[h.id] ?? []).filter((s) => !liveIds.has(s.id) && !(s.nativeId && liveIds.has(s.nativeId)))
  const sessions = [...live, ...past].sort((a, b) => recent(b) - recent(a))
  const harness = (id: string) => hs.find((h) => h.id === id)
  return { hs, installed, harness, mcp, sessions, loaded, err, setErr }
}

/** Cards for Home: one per project folder or per agent, newest activity first. */
export function groupSessions(sessions: SessionMeta[], by: 'project' | 'agent', harness: (id: string) => HarnessInfo | undefined): Group[] {
  const map = new Map<string, SessionMeta[]>()
  for (const s of sessions) {
    const k = by === 'project' ? s.cwd : s.harness
    map.set(k, [...(map.get(k) ?? []), s])
  }
  return [...map].map(([key, list]) => {
    const h = by === 'agent' ? harness(key) : undefined
    return {
      key,
      name: by === 'project' ? basename(key) || key : h?.label ?? key,
      sub: by === 'project' ? shortPath(key) : `${new Set(list.map((s) => s.cwd)).size} projects`,
      color: h?.color,
      sessions: list,
      live: list.filter((s) => s.source === 'crewd' && (s.status === 'running' || s.status === 'waiting')).length,
      waiting: list.filter((s) => s.status === 'waiting').length,
      last: Math.max(...list.map(recent)),
    }
  }).sort((a, b) => b.waiting - a.waiting || b.last - a.last)
}
