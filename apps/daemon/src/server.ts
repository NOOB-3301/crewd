import type { HarnessInfo, LogLine } from '@crewd/protocol'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import * as log from './log.ts'
import { readMcp, writeMcp } from './mcp.ts'
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

app.post('/sessions', async (c) => c.json(await sessions.create(await body(c)), 201))
app.get('/sessions', (c) => c.json(sessions.listOurs()))

app.get('/sessions/:id/history', async (c) => {
  const id = c.req.param('id')
  if (sessions.get(id)) return c.json(log.read(id))
  // Native-only id: ask the named harness, else every harness until one knows it.
  const name = c.req.query('harness')
  for (const h of name ? [harness(name)] : registry.harnesses()) {
    const lines = await registry
      .classFor(h)
      .loadHistory(h, id)
      .catch(() => [])
    if (lines.length) return c.json(lines)
  }
  throw new HttpError(404, `no session ${id}`)
})

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
    stream.onAbort(() => {
      unsubscribe()
      q.close()
    })
    for await (const l of q) await stream.writeSSE({ id: String(l.seq), data: JSON.stringify(l) })
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
