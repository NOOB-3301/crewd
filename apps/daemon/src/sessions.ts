import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { CreateSessionBody, Harness, LogLine, SessionMeta, SessionStatus } from '@crewd/protocol'
import * as log from './log.ts'
import { mcpFor } from './mcp.ts'
import type { Orchestrator } from './orchestrators/orchestrator.ts'
import * as registry from './registry.ts'

const IDLE_MS = 15 * 60_000
const TITLE_MAX = 60

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
  }
}

type Entry = {
  meta: SessionMeta
  orch?: Orchestrator
  ready?: Promise<void>
  subs: Set<(l: LogLine) => void>
  timer?: NodeJS.Timeout
}
const live = new Map<string, Entry>()

function entry(id: string): Entry {
  let e = live.get(id)
  if (!e) {
    const meta = log.readMeta(id)
    if (!meta) throw new HttpError(404, `no session ${id}`)
    e = { meta, subs: new Set() }
    live.set(id, e)
  }
  return e
}

export const get = (id: string): SessionMeta | undefined => live.get(id)?.meta ?? log.readMeta(id)

function emit(e: Entry, body: log.Entry) {
  const line = log.append(e.meta.id, body)
  e.meta.updatedAt = line.ts
  for (const fn of e.subs) fn(line)
  resetIdle(e)
}

function setStatus(e: Entry, state: SessionStatus) {
  if (e.meta.status === state) return
  e.meta.status = state
  log.writeMeta(e.meta)
  emit(e, { kind: 'event', ev: { type: 'status', state } })
}

function resetIdle(e: Entry) {
  clearTimeout(e.timer)
  if (!e.orch) return
  e.timer = setTimeout(() => void stop(e), IDLE_MS)
  e.timer.unref()
}

// Close the orchestrator but keep the session; the next message resumes via nativeId.
async function stop(e: Entry) {
  const o = e.orch
  clearTimeout(e.timer)
  if (!o) return
  e.orch = e.ready = undefined
  await o.close().catch((err) => log.daemonLog('close failed', e.meta.id, err))
}

function startOrch(e: Entry, h: Harness) {
  const o = registry.create(h, e.meta.cwd, e.meta.nativeId, mcpFor(e.meta.mcp))
  e.orch = o
  // ready never rejects: a failed start is shown in the chat, not as an HTTP error.
  e.ready = o.start().then(
    () => void pump(e, o),
    (err) => {
      if (e.orch === o) e.orch = e.ready = undefined
      emit(e, { kind: 'event', ev: { type: 'error', message: String(err?.message ?? err) } })
      if (e.meta.status === 'running') setStatus(e, 'idle')
    },
  )
  resetIdle(e)
}

async function pump(e: Entry, o: Orchestrator) {
  try {
    for await (const ev of o.events()) {
      if (o.nativeId && o.nativeId !== e.meta.nativeId) {
        e.meta.nativeId = o.nativeId
        log.writeMeta(e.meta)
      }
      // Orchestrators only end turns; interrupted/dead are set by crewd and stay put.
      if (ev.type === 'status') {
        if (e.meta.status === 'running') setStatus(e, ev.state)
        continue
      }
      emit(e, { kind: 'event', ev })
      if (ev.type === 'turn_end' && e.meta.status === 'running') setStatus(e, 'idle')
    }
  } catch (err) {
    emit(e, { kind: 'event', ev: { type: 'error', message: String((err as Error)?.message ?? err) } })
  }
  if (e.orch === o) e.orch = e.ready = undefined
  if (e.meta.status === 'running') setStatus(e, 'idle')
}

export async function create(body: CreateSessionBody): Promise<SessionMeta> {
  const h = registry.get(body?.harness)
  if (!h) throw new HttpError(400, `unknown harness ${body?.harness}`)
  if (!registry.installed(h)) throw new HttpError(400, `${h.label} is not installed`)
  if (!str(body.cwd) || !isAbsolute(body.cwd) || !statSync(body.cwd, { throwIfNoEntry: false })?.isDirectory())
    throw new HttpError(400, 'cwd must be an existing absolute directory')
  if (body.resumeId !== undefined && !str(body.resumeId)) throw new HttpError(400, 'resumeId must be a string')
  if (body.mcp !== undefined && !(Array.isArray(body.mcp) && body.mcp.every(str)))
    throw new HttpError(400, 'mcp must be an array of names')

  const now = Date.now()
  const meta: SessionMeta = {
    id: randomUUID(),
    harness: h.id,
    nativeId: body.resumeId,
    cwd: body.cwd,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    source: 'crewd',
    mcp: body.mcp,
  }
  const e: Entry = { meta, subs: new Set() }
  live.set(meta.id, e)
  log.writeMeta(meta)

  // Copy the native transcript in once, so history and SSE replay show it without
  // duplicating the turns crewd later adds to the same native session.
  if (body.resumeId) {
    const past = await registry.classFor(h).loadHistory(h, body.resumeId).catch(() => [])
    for (const l of past) emit(e, { kind: 'event', ev: l.kind === 'user' ? { type: 'user', text: l.text } : l.ev })
    const first = past.find((l) => l.kind === 'user')
    if (first?.kind === 'user') meta.title = first.text.slice(0, TITLE_MAX)
    log.writeMeta(meta)
  }

  startOrch(e, h)
  await e.ready
  return meta
}

export async function send(id: string, text: string): Promise<SessionMeta> {
  const e = entry(id)
  if (e.meta.status === 'dead') throw new HttpError(409, 'session is closed')
  const h = registry.get(e.meta.harness)
  if (!h) throw new HttpError(400, `unknown harness ${e.meta.harness}`)

  emit(e, { kind: 'user', text })
  e.meta.title ??= text.slice(0, TITLE_MAX)
  log.writeMeta(e.meta)
  setStatus(e, 'running')

  if (!e.orch) startOrch(e, h)
  const o = e.orch!
  await e.ready
  if (e.orch === o) {
    await o.send(text).catch((err) => {
      emit(e, { kind: 'event', ev: { type: 'error', message: String(err?.message ?? err) } })
      setStatus(e, 'idle')
    })
  }
  return e.meta
}

export async function interrupt(id: string): Promise<SessionMeta> {
  const e = entry(id)
  await e.orch?.interrupt()
  if (e.meta.status === 'running') setStatus(e, 'idle')
  return e.meta
}

export async function remove(id: string): Promise<SessionMeta> {
  const e = entry(id)
  setStatus(e, 'dead')
  await stop(e)
  return e.meta
}

export function subscribe(id: string, fn: (l: LogLine) => void): () => void {
  const e = entry(id)
  e.subs.add(fn)
  return () => e.subs.delete(fn)
}

/** crewd sessions for a harness plus the harness's own list; crewd wins on the same nativeId. */
export async function listForHarness(h: Harness, cwd?: string): Promise<SessionMeta[]> {
  const ours = log
    .listMetas()
    .filter((m) => m.harness === h.id && (!cwd || m.cwd === cwd))
    .map((m) => live.get(m.id)?.meta ?? m)
  const taken = new Set(ours.map((m) => m.nativeId).filter(Boolean))
  const native = !registry.installed(h)
    ? []
    : await registry
        .classFor(h)
        .listSessions(h, cwd)
        .catch((err) => (log.daemonLog('listSessions failed', h.id, err), []))
  return [...ours, ...native.filter((m) => !taken.has(m.nativeId))].sort(
    (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
  )
}

/** Daemon start: a session that was mid-turn when the daemon died can't still be running. */
export function recover() {
  for (const m of log.listMetas()) if (m.status === 'running') setStatus(entry(m.id), 'interrupted')
}

export async function closeAll() {
  await Promise.all(
    [...live.values()].map((e) => {
      if (e.meta.status === 'running') setStatus(e, 'interrupted')
      return stop(e)
    }),
  )
}

function str(v: unknown): v is string {
  return typeof v === 'string'
}
