import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Ev, LogLine, SessionMeta } from '@crewd/protocol'

// The only module that writes session files. Sync IO keeps append order trivially correct.
export const HOME = process.env.CREWD_HOME ?? join(homedir(), '.crewd')
export const SESSIONS_DIR = join(HOME, 'sessions')

export type Entry = { kind: 'user'; text: string } | { kind: 'event'; ev: Ev }

const lastSeq = new Map<string, number>()

// Ids become path segments; reject anything that could escape SESSIONS_DIR.
const validId = (id: string) => /^[\w-]+$/.test(id)
const dir = (id: string) => {
  if (!validId(id)) throw new Error(`invalid session id: ${id}`)
  return join(SESSIONS_DIR, id)
}

export function append(id: string, entry: Entry): LogLine {
  let seq = lastSeq.get(id)
  if (seq === undefined) seq = read(id).at(-1)?.seq ?? 0
  const line = { seq: seq + 1, ts: Date.now(), ...entry } as LogLine
  mkdirSync(dir(id), { recursive: true })
  appendFileSync(join(dir(id), 'log.jsonl'), JSON.stringify(line) + '\n')
  lastSeq.set(id, line.seq)
  return line
}

// shortcut: reads the whole file per call, fine for chat-sized logs; index by offset if logs get huge.
export function read(id: string, afterSeq = 0): LogLine[] {
  let text: string
  try {
    text = readFileSync(join(dir(id), 'log.jsonl'), 'utf8')
  } catch {
    return []
  }
  const out: LogLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw) continue
    try {
      const line = JSON.parse(raw) as LogLine
      if (line.seq > afterSeq) out.push(line)
    } catch {} // torn last line after a crash
  }
  return out
}

export function readMeta(id: string): SessionMeta | undefined {
  if (!validId(id)) return undefined
  try {
    return JSON.parse(readFileSync(join(dir(id), 'meta.json'), 'utf8'))
  } catch {
    return undefined
  }
}

export function writeMeta(meta: SessionMeta) {
  mkdirSync(dir(meta.id), { recursive: true })
  writeFileSync(join(dir(meta.id), 'meta.json'), JSON.stringify(meta, null, 2))
}

export function listMetas(): SessionMeta[] {
  let ids: string[]
  try {
    ids = readdirSync(SESSIONS_DIR)
  } catch {
    return []
  }
  return ids.map(readMeta).filter((m): m is SessionMeta => !!m)
}

export function daemonLog(...parts: unknown[]) {
  const text = parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === 'string' ? p : JSON.stringify(p)))
  try {
    appendFileSync(join(HOME, 'daemon.log'), `${new Date().toISOString()} ${text.join(' ')}\n`)
  } catch {}
}
