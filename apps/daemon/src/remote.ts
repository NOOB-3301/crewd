import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { app } from './server.ts'
import { HOME, daemonLog } from './log.ts'

const CONFIG = join(HOME, 'remote.json')
const TOKEN = join(HOME, 'remote-token')

/** `{ "port": n }` in ~/.crewd/remote.json. Missing or invalid means remote access stays off. */
export function remotePort(): number | undefined {
  try {
    const port = JSON.parse(readFileSync(CONFIG, 'utf8')).port
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
  } catch {
    return undefined
  }
}

/** Created 0600 on first remote start, reused after. Never logged, never in a URL. */
export function token(): string {
  try {
    const saved = readFileSync(TOKEN, 'utf8').trim()
    if (saved) return saved
  } catch {}
  const fresh = randomBytes(32).toString('base64url')
  writeFileSync(TOKEN, fresh, { mode: 0o600 })
  chmodSync(TOKEN, 0o600) // writeFileSync's mode is masked by the umask
  daemonLog('remote token created at', TOKEN)
  return fresh
}

// Hash first so the comparison length never depends on the token itself.
const sameToken = (a: string, b: string) => {
  const hash = (s: string) => createHash('sha256').update(s).digest()
  return timingSafeEqual(hash(a), hash(b))
}

/**
 * Auth-only front for the existing app. Forwarding the raw request keeps routing, error
 * shapes and SSE identical to the socket, so the phone and the TUI see one API.
 * No CORS, no Host check: a browser page cannot send the bearer header cross-origin
 * without a preflight the daemon never answers, and it cannot guess the token.
 */
export function remoteApp() {
  const remote = new Hono()
  remote.use('/*', async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const got = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    if (!got || !sameToken(got, token())) {
      daemonLog('remote denied', c.req.method, c.req.path) // path only, never headers
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })
  remote.all('/*', (c) => app.fetch(c.req.raw))
  return remote
}
