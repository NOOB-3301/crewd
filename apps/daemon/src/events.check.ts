// Self-check: bun apps/daemon/src/events.check.ts
// The three things the phone depends on that the TUI never exercised: metadata publishing,
// history tailed to a turn boundary, and the project list the phone picks folders from.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogLine, SessionMeta } from '@crewd/protocol'

const dir = mkdtempSync(join(tmpdir(), 'crewd-events-'))
process.env.CREWD_HOME = dir
const log = await import('./log.ts')
const sessions = await import('./sessions.ts')
const { app } = await import('./server.ts')

function session(id: string, cwd: string, lines: LogLine[] = []) {
  const meta: SessionMeta = { id, harness: 'claude', cwd, status: 'idle', createdAt: 1, source: 'crewd' }
  mkdirSync(join(dir, 'sessions', id), { recursive: true })
  log.writeMeta(meta)
  if (lines.length) writeFileSync(join(dir, 'sessions', id, 'log.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return meta
}

const user = (seq: number, text: string): LogLine => ({ seq, ts: seq, kind: 'user', text })
const said = (seq: number, text: string): LogLine => ({ seq, ts: seq, kind: 'event', ev: { type: 'user', text } })
const saidAt = (seq: number): LogLine => ({ seq, ts: seq, kind: 'event', ev: { type: 'text', text: 'x' } })
// Two kinds of user line, because the log holds both.
const lines = [user(1, 'first'), saidAt(2), said(3, 'second'), saidAt(4), user(5, 'third'), saidAt(6)]
session('tail', dir, lines)

const history = async (query: string) => {
  const res = await app.request(`/sessions/tail/history${query}`)
  return ((await res.json()) as LogLine[]).map((l) => l.seq)
}
assert.deepEqual(await history(''), [1, 2, 3, 4, 5, 6], 'no turns means the whole log')
assert.deepEqual(await history('?turns=1'), [5, 6], 'last turn only')
assert.deepEqual(await history('?turns=2'), [3, 4, 5, 6], 'an ev.type user line is a turn boundary too')
assert.deepEqual(await history('?turns=3'), [1, 2, 3, 4, 5, 6])
assert.deepEqual(await history('?turns=99'), [1, 2, 3, 4, 5, 6], 'more turns than the log')
assert.deepEqual(await history('?turns=0'), [1, 2, 3, 4, 5, 6], 'zero is not a request')
assert.deepEqual(await history('?turns=nope'), [1, 2, 3, 4, 5, 6], 'garbage is not a request')
assert.deepEqual(await history('?turns=-2'), [1, 2, 3, 4, 5, 6], 'a negative count never cuts')

// The plan's premise: an open permission request always sits in the last turn, so a tail keeps it.
session('ask', dir, [user(1, 'a'), saidAt(2), user(3, 'b'), { seq: 4, ts: 4, kind: 'event', ev: { type: 'permission_request', requestId: 'p', tool: 'Bash', options: [] } }])
const asked = await app.request('/sessions/ask/history?turns=1')
assert.ok(JSON.stringify(await asked.json()).includes('"permission_request"'), 'the tail still carries the open request')

// /projects: real folders only, newest first, throwaway ones dropped.
const real = process.cwd()
session('p-old', real, [user(1, 'x')])
session('p-new', real)
log.writeMeta({ ...sessions.get('p-old')!, updatedAt: 50 })
session('p-temp', mkdtempSync(join(tmpdir(), 'crewd-events-scratch-')))
session('p-gone', join(dir, 'deleted-folder'))
const projects = (await (await app.request('/projects')).json()) as { cwd: string; harnesses: string[] }[]
assert.deepEqual(projects.map((p) => p.cwd), [real], 'only the existing non-temp folder')
assert.deepEqual(projects[0]?.harnesses, ['claude'], 'harnesses are collected once per folder')

// The global stream: a snapshot on connect, then a message per metadata change.
const res = await app.request('/events')
const reader = res.body!.getReader()
const first = new TextDecoder().decode((await reader.read()).value)
assert.match(first, /^event: snapshot\ndata: \[/, 'snapshot arrives immediately')
await reader.cancel()

const seen: string[] = []
const unsubscribe = sessions.subscribeMeta((m) => seen.push(`${m.id}:${m.status}`))
assert.deepEqual(await history('?turns=1'), [5, 6], 'subscribing changes nothing else')
await sessions.remove('ask')
assert.deepEqual(seen, ['ask:dead'], 'deleting a session publishes it as a normal session message')
unsubscribe()
await sessions.remove('tail')
assert.deepEqual(seen, ['ask:dead'], 'the unsubscribe really unsubscribed')

console.log('events.check: ok')
