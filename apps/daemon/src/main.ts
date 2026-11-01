import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { createAdaptorServer } from '@hono/node-server'
import { SOCKET_NAME } from '@crewd/protocol'
import { HOME, SESSIONS_DIR, daemonLog } from './log.ts'
import { app } from './server.ts'
import * as sessions from './sessions.ts'

const SOCK = join(HOME, SOCKET_NAME)
// macOS caps unix socket paths at 104 bytes and Node silently truncates longer ones.
if (Buffer.byteLength(SOCK) > 103) {
  console.error(`socket path too long (${SOCK}); use a shorter CREWD_HOME`)
  process.exit(1)
}

// A connectable socket means another daemon owns it (e.g. two TUIs racing to auto-start).
const alive = await new Promise<boolean>((resolve) => {
  const s = connect(SOCK)
  s.once('connect', () => (s.end(), resolve(true)))
  s.once('error', () => resolve(false))
})
if (alive) {
  console.error(`crewd already running on ${SOCK}`)
  process.exit(1)
}

mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 })
try {
  unlinkSync(SOCK)
} catch {}

sessions.recover()

process.umask(0o077) // socket is created 0600 from the start; chmod below makes it explicit
const server = createAdaptorServer({ fetch: app.fetch })
server.on('error', (err) => {
  daemonLog('server error', err)
  process.exit(1)
})
server.listen(SOCK, () => {
  chmodSync(SOCK, 0o600)
  daemonLog(`listening on ${SOCK} (pid ${process.pid})`)
})

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  daemonLog(`${signal}: shutting down`)
  await Promise.race([sessions.closeAll(), new Promise((r) => setTimeout(r, 5000))])
  ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
  server.close()
  try {
    unlinkSync(SOCK)
  } catch {}
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => daemonLog('unhandled rejection', err))
