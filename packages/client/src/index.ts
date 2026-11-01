// Typed client for the crewd daemon: HTTP over a Unix socket, plus a small SSE reader.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  routes, SOCKET_NAME,
  type CreateSessionBody, type HarnessInfo, type Usage, type ImageRef, type LogLine, type McpServer, type ModeId, type ModelList, type SessionMeta,
} from '@crewd/protocol'

export const crewdHome = process.env.CREWD_HOME ?? join(homedir(), '.crewd')
export const socketPath = join(crewdHome, SOCKET_NAME)

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch('http://localhost' + path, {
    ...init,
    unix: socketPath,
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
  })
  const body: any = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? `crewd answered ${res.status} for ${path}`)
  return body as T
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export const harnesses = () => call<HarnessInfo[]>(routes.harnesses)
export const harnessSessions = (id: string) => call<SessionMeta[]>(routes.harnessSessions(id))
/** Models the harness offers in cwd (default: home). The daemon caches lists for 10 min; refresh skips that. */
export const harnessModels = (id: string, cwd?: string, refresh = false) =>
  call<ModelList>(`${routes.harnessModels(id)}?${new URLSearchParams({ ...(cwd && { cwd }), ...(refresh && { refresh: '1' }) })}`)
export const createSession = (body: CreateSessionBody) => post<SessionMeta>(routes.sessions, body)
/** Sessions the daemon is running or has run (source 'crewd'), newest first. Daemon: GET routes.sessions. */
export const liveSessions = () => call<SessionMeta[]>(routes.sessions)
export const history = (id: string) => call<LogLine[]>(routes.history(id))
export const send = (id: string, text: string, images?: ImageRef[]) =>
  post<unknown>(routes.messages(id), images?.length ? { text, images } : { text })
export const answerPermission = (id: string, requestId: string, optionId: string) =>
  post<unknown>(routes.permission(id, requestId), { optionId })
export const setMode = (id: string, mode: ModeId) => post<SessionMeta>(routes.mode(id), { mode })
export const setModel = (id: string, model: string) => post<SessionMeta>(routes.model(id), { model })
export const interrupt = (id: string) => post<unknown>(routes.interrupt(id))
export const deleteSession = (id: string) => call<unknown>(routes.session(id), { method: 'DELETE' })
/** Fresh account usage per agent; the daemon never caches it. */
export const usage = () => call<Usage[]>(routes.usage, { cache: 'no-store' })
export const getMcp = () => call<McpServer[]>(routes.mcp)
export const putMcp = (list: McpServer[]) =>
  call<unknown>(routes.mcp, { method: 'PUT', body: JSON.stringify(list) })

/** Streams LogLines for a session; reconnects with backoff from the last seen seq. Returns unsubscribe. */
export function subscribe(id: string, onLine: (line: LogLine) => void, opts: { after?: number } = {}): () => void {
  const ac = new AbortController()
  let last = opts.after
  ;(async () => {
    let delay = 250
    while (!ac.signal.aborted) {
      try {
        const res = await fetch('http://localhost' + routes.events(id), {
          unix: socketPath,
          signal: ac.signal,
          headers: last === undefined ? {} : { 'last-event-id': String(last) },
        })
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
        delay = 250
        const decoder = new TextDecoder()
        let buf = ''
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
          let end: number
          while ((end = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, end)
            buf = buf.slice(end + 2)
            let data = ''
            let evId: string | undefined
            for (const l of block.split('\n')) {
              if (l.startsWith('data:')) data += (data ? '\n' : '') + l.slice(5).trimStart()
              else if (l.startsWith('id:')) evId = l.slice(3).trim()
            }
            if (!data) continue
            const line = JSON.parse(data) as LogLine
            // Replay can overlap what history() already gave us; drop duplicates.
            if (last !== undefined && line.seq <= last) continue
            last = evId !== undefined ? Number(evId) : line.seq
            onLine(line)
          }
        }
      } catch {
        if (ac.signal.aborted) return
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 5000)
    }
  })()
  return () => ac.abort()
}

async function alive(): Promise<boolean> {
  if (!existsSync(socketPath)) return false
  try {
    await harnesses()
    return true
  } catch {
    return false
  }
}

/** Starts the daemon in the background if the socket does not answer, then waits up to ~5s for it. */
export async function ensureDaemon(): Promise<void> {
  if (await alive()) return
  const daemonDir = fileURLToPath(new URL('../../../apps/daemon/', import.meta.url))
  const main = join(daemonDir, 'dist/main.js')
  if (!existsSync(main)) {
    const build = spawnSync('bun', ['run', 'build'], { cwd: daemonDir, stdio: 'ignore' })
    if (build.status !== 0 || !existsSync(main))
      throw new Error(`Could not build the daemon. Run \`bun run build\` in ${daemonDir} and check the output.`)
  }
  const child = spawn('node', [main], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await alive()) return
  }
  throw new Error(`The crewd daemon did not start within 5s. See ${join(crewdHome, 'daemon.log')}, or run \`node ${main}\` to see the error.`)
}
