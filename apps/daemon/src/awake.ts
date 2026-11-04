import { spawn } from 'node:child_process'
import { daemonLog } from './log.ts'

/**
 * `caffeinate -i` while at least one session is busy, so a turn is not lost to idle sleep.
 * Only enabled on darwin with the remote listener on. Does not cover closing the lid.
 */
let on = false
let busyCount = 0
let proc: ReturnType<typeof spawn> | undefined

export const enable = () => (on = process.platform === 'darwin')

export function note(delta: number) {
  if (!on) return
  busyCount = Math.max(0, busyCount + delta)
  if (busyCount && !proc) {
    proc = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).on('error', (err) => {
      proc = undefined
      busyCount = 0
      daemonLog('caffeinate unavailable', err)
    })
  }
  if (!busyCount && proc) {
    proc.kill()
    proc = undefined
  }
}
