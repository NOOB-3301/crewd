import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import type { HarnessInfo, LogLine, ProjectInfo } from '@crewd/protocol'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as log from './log.ts'
import { readMcp, writeMcp } from './mcp.ts'
import * as models from './models.ts'
import * as registry from './registry.ts'
import * as sessions from './sessions.ts'
import * as usage from './usage.ts'
import { HttpError } from './sessions.ts'
import { AsyncQueue } from './util/async-queue.ts'

export const app = new Hono()

const body = (c: { req: { json(): Promise<any> } }) =>
  c.req.json().catch(() => {
    throw new HttpError(400, 'invalid JSON body')
  })

function harness(id: string) {
  const h = registry.get(id)
  if (!h) throw new HttpError(404, `unknown harness ${id}`)
  return h
}

/** SSE comment every 15s: carriers and mobile proxies cut a quiet connection. Clients skip blocks without data. */
function keepalive(stream: { write(chunk: string): Promise<unknown> }) {
  const t = setInterval(() => void stream.write(': ping\n\n'), 15_000)
  return () => clearInterval(t)
}

/** Cut at the Nth-from-last user line: turn boundaries keep toBlocks correct, and an open prompt is always in the last turn. */
function tailTurns(lines: LogLine[], turns: number) {
  const isUser = (l: LogLine) => l.kind === 'user' || (l.kind === 'event' && l.ev.type === 'user')
  let seen = 0
  const start = lines.findLastIndex((l) => isUser(l) && ++seen >= turns)
  return start < 0 ? lines : lines.slice(start)
}

app.get('/harnesses', async (c) => {
  const list = await Promise.all(
    registry.harnesses().map(
      async (h): Promise<HarnessInfo> => ({
        ...h,
        installed: registry.installed(h),
        // Constructors are side-effect free; caps() is an instance method.
        caps: registry.create(h, process.cwd()).caps(),
        count: (await sessions.listForHarness(h)).length,
      }),
    ),
  )
  return c.json(list)
})

app.get('/harnesses/:id/sessions', async (c) =>
  c.json(await sessions.listForHarness(harness(c.req.param('id')), c.req.query('cwd'))),
)

app.get('/harnesses/:id/models', async (c) => {
  const h = harness(c.req.param('id'))
  if (!registry.installed(h)) throw new HttpError(400, `${h.label} is not installed`)
  const cwd = c.req.query('cwd') || homedir()
  if (!isAbsolute(cwd) || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
    throw new HttpError(400, 'cwd must be an existing absolute directory')
  return c.json(await models.list(h, cwd, c.req.query('refresh') === '1'))
})

app.post('/sessions', async (c) => c.json(await sessions.create(await body(c)), 201))
app.get('/sessions', (c) => c.json(sessions.listOurs()))

app.get('/sessions/:id/history', async (c) => {
  const id = c.req.param('id')
  const turns = Number(c.req.query('turns'))
  const cut = (lines: LogLine[]) => (turns > 0 ? tailTurns(lines, turns) : lines)
  if (sessions.get(id)) return c.json(cut(log.read(id)))
  // Native-only id: ask the named harness, else every harness until one knows it.
  const name = c.req.query('harness')
  for (const h of name ? [harness(name)] : registry.harnesses()) {
    const lines = await registry
      .classFor(h)
      .loadHistory(h, id)
      .catch(() => [])
    if (lines.length) return c.json(cut(lines))
  }
  throw new HttpError(404, `no session ${id}`)
})

/**
 * GET /projects: folders crewd has sessions in, for the phone's new-session picker.
 * The phone cannot browse the Mac's disk. crewd's own sessions only in this version.
 */
app.get('/projects', (c) => {
  // Throwaway scratch folders are noise; apps/tui/src/allSessions.ts keeps the matching client-side rule.
  const tmp = ['/tmp/', '/private/tmp/', '/private/var/folders/', '/var/folders/', `${log.HOME}/tmp/`]
  const map = new Map<string, ProjectInfo>()
  for (const s of sessions.listOurs()) {
    if (tmp.some((p) => (s.cwd + '/').startsWith(p))) continue
    const found = map.get(s.cwd)
    if (found) {
      if (!found.harnesses.includes(s.harness)) found.harnesses.push(s.harness)
    } else {
      map.set(s.cwd, { cwd: s.cwd, lastUsed: s.updatedAt ?? s.createdAt, harnesses: [s.harness] })
    }
  }
  return c.json(
    [...map.values()]
      .filter((p) => statSync(p.cwd, { throwIfNoEntry: false })?.isDirectory())
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, 50),
  )
})

/**
 * GET /events: the session list as a push stream. One snapshot on connect, then a message
 * per metadata change. No ids and no replay, so reconnecting just takes a fresh snapshot.
 */
app.get('/events', (c) =>
  streamSSE(c, async (stream) => {
    const q = new AsyncQueue<{ event: string; data: string }>()
    q.push({ event: 'snapshot', data: JSON.stringify(sessions.listOurs()) })
    const unsubscribe = sessions.subscribeMeta((m) => q.push({ event: 'session', data: JSON.stringify(m) }))
    const stop = keepalive(stream)
    stream.onAbort(() => q.close())
    try {
      for await (const m of q) await stream.writeSSE(m)
    } finally {
      stop()
      unsubscribe()
    }
  }),
)

app.post('/sessions/:id/messages', async (c) => {
  const { text, images } = await body(c)
  if (typeof text !== 'string' || (!text.trim() && !images?.length)) throw new HttpError(400, 'text is required')
  return c.json(await sessions.send(c.req.param('id'), text, images))
})

app.post('/sessions/:id/permissions/:requestId', async (c) => {
  const { optionId } = await body(c)
  return c.json(sessions.answer(c.req.param('id'), c.req.param('requestId'), optionId))
})

app.post('/sessions/:id/mode', async (c) => c.json(await sessions.setMode(c.req.param('id'), (await body(c)).mode)))
app.post('/sessions/:id/model', async (c) => c.json(await sessions.setModel(c.req.param('id'), (await body(c)).model)))

app.post('/sessions/:id/interrupt', async (c) => c.json(await sessions.interrupt(c.req.param('id'))))

app.delete('/sessions/:id', async (c) => c.json(await sessions.remove(c.req.param('id'))))

app.get('/sessions/:id/events', (c) => {
  const id = c.req.param('id')
  if (!sessions.get(id)) throw new HttpError(404, `no session ${id}`)
  const after = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0) || 0
  return streamSSE(c, async (stream) => {
    // Backlog read and subscribe happen in one tick, so no line falls between them.
    const q = new AsyncQueue<LogLine>()
    for (const l of log.read(id, after)) q.push(l)
    const unsubscribe = sessions.subscribe(id, (l) => q.push(l))
    const stop = keepalive(stream)
    stream.onAbort(() => q.close())
    try {
      for await (const l of q) await stream.writeSSE({ id: String(l.seq), data: JSON.stringify(l) })
    } finally {
      stop()
      unsubscribe()
    }
  })
})

app.get('/usage', async (c) => {
  c.header('cache-control', 'no-store')
  return c.json(await usage.all())
})

app.get('/mcp', (c) => c.json(readMcp()))
app.put('/mcp', async (c) => {
  try {
    return c.json(writeMcp(await body(c)))
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(400, (err as Error).message)
  }
})

app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status)
  log.daemonLog('request failed', c.req.method, c.req.path, err)
  return c.json({ error: err.message }, 500)
})
