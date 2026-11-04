import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { CreateSessionBody, Harness, ImageRef, LogLine, ModeId, SessionMeta, SessionStatus } from '@crewd/protocol'
import * as awake from './awake.ts'
import * as log from './log.ts'
import { mcpFor } from './mcp.ts'
import * as models from './models.ts'
import type { Image, Orchestrator, PermissionAsk } from './orchestrators/orchestrator.ts'
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
  /** open permission requests: requestId -> option ids + settle(optionId | undefined = cancelled) */
  pending: Map<string, { options: string[]; settle: (optionId?: string) => void }>
}
const live = new Map<string, Entry>()

// Metadata only, for the global /events stream. Deliberately not fed by emit(), which runs per text chunk.
const metaSubs = new Set<(m: SessionMeta) => void>()
export function subscribeMeta(fn: (m: SessionMeta) => void) {
  metaSubs.add(fn)
  return () => void metaSubs.delete(fn)
}

function writeMeta(meta: SessionMeta) {
  log.writeMeta(meta)
  for (const fn of metaSubs) fn(meta)
}

function entry(id: string): Entry {
  let e = live.get(id)
  if (!e) {
    const meta = log.readMeta(id)
    if (!meta) throw new HttpError(404, `no session ${id}`)
    e = { meta, subs: new Set(), pending: new Map() }
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

/** a turn is in progress (possibly blocked on the user) */
const busy = (s: SessionStatus) => s === 'running' || s === 'waiting'

function setStatus(e: Entry, state: SessionStatus) {
  if (e.meta.status === state) return
  const was = busy(e.meta.status)
  e.meta.status = state
  writeMeta(e.meta)
  emit(e, { kind: 'event', ev: { type: 'status', state } })
  if (was !== busy(state)) awake.note(busy(state) ? 1 : -1)
}

function resetIdle(e: Entry) {
  clearTimeout(e.timer)
  if (!e.orch) return
  e.timer = setTimeout(() => void stop(e), IDLE_MS)
  e.timer.unref()
}

// The request is logged, so a client that connects later replays it from history.
function ask(e: Entry, req: PermissionAsk, signal?: AbortSignal): Promise<string | undefined> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const settle = (optionId?: string) => {
      if (!e.pending.delete(requestId)) return
      emit(e, { kind: 'event', ev: { type: 'permission_resolved', requestId, ...(optionId && { optionId }) } })
      if (!e.pending.size && e.meta.status === 'waiting') setStatus(e, 'running')
      resolve(optionId)
    }
    e.pending.set(requestId, { options: req.options.map((o) => o.id), settle })
    signal?.addEventListener('abort', () => settle(), { once: true })
    emit(e, { kind: 'event', ev: { type: 'permission_request', requestId, ...req } })
    if (e.meta.status !== 'dead') setStatus(e, 'waiting')
  })
}

const cancelPending = (e: Entry) => {
  for (const p of [...e.pending.values()]) p.settle()
}

// Close the orchestrator but keep the session; the next message resumes via nativeId.
async function stop(e: Entry) {
  const o = e.orch
  clearTimeout(e.timer)
  cancelPending(e)
  if (!o) return
  e.orch = e.ready = undefined
  await o.close().catch((err) => log.daemonLog('close failed', e.meta.id, err))
}

function startOrch(e: Entry, h: Harness) {
  const o = registry.create(h, e.meta.cwd, e.meta.nativeId, mcpFor(e.meta.mcp))
  o.startMode = e.meta.permissionMode
  o.startModel = e.meta.model
  o.askUser = (req, signal) => ask(e, req, signal)
  e.orch = o
  // ready never rejects: a failed start is shown in the chat, not as an HTTP error.
  e.ready = o.start().then(
    () => void pump(e, o),
    (err) => {
      if (e.orch === o) e.orch = e.ready = undefined
      emit(e, { kind: 'event', ev: { type: 'error', message: String(err?.message ?? err) } })
      if (busy(e.meta.status)) setStatus(e, 'idle')
    },
  )
  resetIdle(e)
}

async function pump(e: Entry, o: Orchestrator) {
  try {
    for await (const ev of o.events()) {
      if (o.nativeId && o.nativeId !== e.meta.nativeId) {
        e.meta.nativeId = o.nativeId
        writeMeta(e.meta)
      }
      // Orchestrators only end turns; interrupted/dead are set by crewd and stay put.
      if (ev.type === 'status') {
        if (busy(e.meta.status)) setStatus(e, ev.state)
        continue
      }
      if (ev.type === 'mode' && ev.mode !== e.meta.permissionMode) {
        e.meta.permissionMode = ev.mode
        writeMeta(e.meta)
      }
      if (ev.type === 'model') {
        if (ev.model !== undefined && ev.model !== e.meta.model) {
          e.meta.model = ev.model
          writeMeta(e.meta)
        }
        const h = registry.get(e.meta.harness)
        if (h) models.remember(h, e.meta.cwd, ev.available)
      }
      emit(e, { kind: 'event', ev })
      if (ev.type === 'turn_end' && busy(e.meta.status)) {
        setStatus(e, 'idle')
        cancelPending(e)
      }
    }
  } catch (err) {
    emit(e, { kind: 'event', ev: { type: 'error', message: String((err as Error)?.message ?? err) } })
  }
  if (e.orch === o) e.orch = e.ready = undefined
  if (busy(e.meta.status)) setStatus(e, 'idle')
  cancelPending(e)
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
  if (body.permissionMode !== undefined && !str(body.permissionMode)) throw new HttpError(400, 'permissionMode must be a string')
  if (body.model !== undefined && !(str(body.model) && body.model)) throw new HttpError(400, 'model must be a non-empty string')

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
    permissionMode: body.permissionMode,
    model: body.model,
  }
  const e: Entry = { meta, subs: new Set(), pending: new Map() }
  live.set(meta.id, e)
  writeMeta(meta)

  // Copy the native transcript in once, so history and SSE replay show it without
  // duplicating the turns crewd later adds to the same native session.
  if (body.resumeId) {
    const past = await registry.classFor(h).loadHistory(h, body.resumeId).catch(() => [])
    for (const l of past) emit(e, { kind: 'event', ev: l.kind === 'user' ? { type: 'user', text: l.text } : l.ev })
    const first = past.find((l) => l.kind === 'user')
    if (first?.kind === 'user') meta.title = first.text.slice(0, TITLE_MAX)
    writeMeta(meta)
  }

  startOrch(e, h)
  await e.ready
  return meta
}

function readImages(images: unknown): Image[] {
  if (images === undefined) return []
  if (!Array.isArray(images)) throw new HttpError(400, 'images must be an array')
  return images.map((i: ImageRef) => {
    if (!str(i?.path) || !str(i?.mime) || !i.mime.startsWith('image/'))
      throw new HttpError(400, 'each image needs a path and an image/* mime')
    try {
      return { mime: i.mime, data: readFileSync(i.path).toString('base64') }
    } catch (err) {
      throw new HttpError(400, `cannot read image ${i.path}: ${(err as Error).message}`)
    }
  })
}

export async function send(id: string, text: string, imageRefs?: unknown): Promise<SessionMeta> {
  const e = entry(id)
  if (e.meta.status === 'dead') throw new HttpError(409, 'session is closed')
  const h = registry.get(e.meta.harness)
  if (!h) throw new HttpError(400, `unknown harness ${e.meta.harness}`)
  const images = readImages(imageRefs)

  emit(e, { kind: 'user', text })
  e.meta.title ??= text.slice(0, TITLE_MAX)
  writeMeta(e.meta)
  setStatus(e, 'running')

  if (!e.orch) startOrch(e, h)
  const o = e.orch!
  await e.ready
  if (e.orch === o) {
    await o.send(text, images).catch((err) => {
      emit(e, { kind: 'event', ev: { type: 'error', message: String(err?.message ?? err) } })
      setStatus(e, 'idle')
    })
  }
  return e.meta
}

export async function interrupt(id: string): Promise<SessionMeta> {
  const e = entry(id)
  // idle first, so answering the open prompts as cancelled doesn't flip the status back to running
  if (busy(e.meta.status)) setStatus(e, 'idle')
  cancelPending(e)
  await e.orch?.interrupt()
  return e.meta
}

export function answer(id: string, requestId: string, optionId: unknown): SessionMeta {
  const e = entry(id)
  const p = e.pending.get(requestId)
  if (!p) throw new HttpError(404, `no open permission request ${requestId}`)
  if (!str(optionId) || !p.options.includes(optionId)) throw new HttpError(400, `optionId must be one of ${p.options.join(', ')}`)
  p.settle(optionId)
  return e.meta
}

export async function setMode(id: string, mode: unknown): Promise<SessionMeta> {
  const e = entry(id)
  if (!str(mode) || !mode) throw new HttpError(400, 'mode is required')
  if (e.meta.status === 'dead') throw new HttpError(409, 'session is closed')
  const h = registry.get(e.meta.harness)
  if (!h) throw new HttpError(400, `unknown harness ${e.meta.harness}`)
  if (!e.orch) startOrch(e, h)
  await e.ready
  if (!e.orch) throw new HttpError(409, 'session failed to start')
  await e.orch.setMode(mode as ModeId).catch((err) => {
    throw new HttpError(400, String(err?.message ?? err))
  })
  return e.meta
}

export async function setModel(id: string, model: unknown): Promise<SessionMeta> {
  const e = entry(id)
  if (!str(model) || !model) throw new HttpError(400, 'model is required')
  if (e.meta.status === 'dead') throw new HttpError(409, 'session is closed')
  const h = registry.get(e.meta.harness)
  if (!h) throw new HttpError(400, `unknown harness ${e.meta.harness}`)
  if (!e.orch) startOrch(e, h)
  await e.ready
  if (!e.orch) throw new HttpError(409, 'session failed to start')
  await e.orch.setModel(model).catch((err) => {
    throw new HttpError(400, String(err?.message ?? err))
  })
  return e.meta
}

/** crewd's own sessions, running and past, newest first. */
export const listOurs = (): SessionMeta[] =>
  log
    .listMetas()
    .map((m) => live.get(m.id)?.meta ?? m)
    .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))

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

/** Daemon start: a session that was mid-turn when the daemon died can't still be running, nor its prompts open. */
export function recover() {
  for (const m of log.listMetas()) {
    if (!busy(m.status)) continue
    const e = entry(m.id)
    const open = new Set<string>()
    for (const l of log.read(m.id)) {
      if (l.kind !== 'event') continue
      if (l.ev.type === 'permission_request') open.add(l.ev.requestId)
      if (l.ev.type === 'permission_resolved') open.delete(l.ev.requestId)
    }
    for (const requestId of open) emit(e, { kind: 'event', ev: { type: 'permission_resolved', requestId } })
    setStatus(e, 'interrupted')
  }
}

export async function closeAll() {
  await Promise.all(
    [...live.values()].map((e) => {
      if (busy(e.meta.status)) setStatus(e, 'interrupted')
      return stop(e)
    }),
  )
}

function str(v: unknown): v is string {
  return typeof v === 'string'
}
