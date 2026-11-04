// Self-check: bun packages/shared/check.ts  (the fixtures in fixtures/claude are raw harness transcripts,
// not crewd log lines, so the lines below are written in the LogLine shape the daemon's log.jsonl uses.)
import assert from 'node:assert/strict'
import type { Ev, LogLine, SessionMeta } from '@crewd/protocol'
import { claudeModes, foldState, sseBlocks, toBlocks } from './src/index.ts'

const T = 1000
const E = (seq: number, ev: Ev): LogLine => ({ seq, ts: seq * T, kind: 'event', ev })
const U = (seq: number, text: string): LogLine => ({ seq, ts: seq * T, kind: 'user', text })
const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id: 's', harness: 'claude', cwd: '/x', status: 'idle', createdAt: 0, source: 'crewd', ...over })

assert.deepEqual(toBlocks([
  U(1, 'hi'),
  E(2, { type: 'thinking', text: 'a' }),
  E(3, { type: 'thinking', text: 'b' }),
  E(4, { type: 'text', text: 'Hel', partial: true }),
  E(5, { type: 'text', text: 'lo', partial: true }),
  E(6, { type: 'text', text: 'Hello there' }),
  E(7, { type: 'tool', id: 't1', name: 'Bash', status: 'start', input: { command: 'ls' } }),
  E(8, { type: 'tool', id: 't1', name: 'Bash', status: 'end', output: 'file' }),
  U(9, 'again'),
  E(10, { type: 'error', message: 'boom' }),
  E(11, { type: 'text', text: 'ok', partial: true }),
]), [
  { who: 'you', text: 'hi' },
  { who: 'agent', items: [
    { k: 'thinking', text: 'a\nb', key: 'th2' },
    // the final full message replaces the streamed chunks instead of appending to them
    { k: 'text', text: 'Hello there', open: false },
    { k: 'tool', key: 'toolt1', id: 't1', name: 'Bash', status: 'end', input: { command: 'ls' }, output: 'file', startTs: 7000, endTs: 8000 },
  ] },
  { who: 'you', text: 'again' },
  { who: 'error', message: 'boom' },
  { who: 'agent', items: [{ k: 'text', text: 'ok', open: true }] },
], 'toBlocks')

assert.deepEqual(foldState([
  E(1, { type: 'status', state: 'running' }),
  E(2, { type: 'commands', list: [{ name: 'compact' }] }),
  E(3, { type: 'mode', mode: 'plan', available: [{ id: 'plan', label: 'Plan' }] }),
  E(4, { type: 'model', model: undefined, available: [{ id: 'm1', label: 'M1' }] }),
  E(5, { type: 'permission_request', requestId: 'p1', tool: 'Bash', options: [] }),
  E(6, { type: 'turn_end', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.2 }),
  E(7, { type: 'permission_request', requestId: 'p2', tool: 'Edit', options: [] }),
  E(8, { type: 'permission_resolved', requestId: 'p1', optionId: 'allow' }),
  // costUsd absent keeps the running total; user lines and unknown events change nothing
  U(9, 'ignored'),
  E(10, { type: 'turn_end', usage: { inputTokens: 1 } }),
], session({ status: 'idle', permissionMode: 'auto', model: 'seed' })), {
  status: 'running',
  tokens: 16,
  cost: 0.2,
  commands: [{ name: 'compact' }],
  mode: 'plan',
  modes: [{ id: 'plan', label: 'Plan' }],
  model: 'seed',
  models: [{ id: 'm1', label: 'M1' }],
  requests: new Map([['p2', { type: 'permission_request', requestId: 'p2', tool: 'Edit', options: [] }]]),
}, 'foldState')

assert.deepEqual(foldState([], session()).modes, claudeModes, 'Claude falls back before it reports modes')
assert.deepEqual(foldState([], session({ harness: 'opencode' })).modes, [], 'other harnesses get no fallback')

const push = sseBlocks()
assert.deepEqual(push('id: 7\ndata: {"a":1}\n'), [], 'incomplete block is buffered')
assert.deepEqual(push('\n'), [{ id: '7', data: '{"a":1}' }], 'completed by the blank line in the next chunk')
assert.deepEqual(push(': ping\r\n\r\ndata: x\ndata: y\n\n'), [{ id: undefined, data: 'x\ny' }], 'no-data blocks skipped')

console.log('shared.check: ok')
