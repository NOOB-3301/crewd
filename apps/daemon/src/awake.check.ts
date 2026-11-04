// Self-check: bun apps/daemon/src/awake.check.ts
// One caffeinate per busy period, none when idle, and a killed child does not disable the assertion forever.
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CREWD_HOME = mkdtempSync(join(tmpdir(), 'crewd-awake-'))
const awake = await import('./awake.ts')
const pid = () => execSync('pgrep -x caffeinate || true').toString().trim()
const settled = async (want: boolean) => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50))
    if ((await pid()).length > 0 === want) return true
  }
  return false
}

// Off until main.ts enables it with the remote listener.
awake.note(1)
assert.equal(await settled(false), true, 'no assertion while remote is disabled')

awake.enable()
awake.note(1)
assert.ok(await settled(true), 'busy session holds the assertion')
const first = pid()
awake.note(1) // a second busy session must not spawn a second caffeinate
await new Promise((r) => setTimeout(r, 200))
assert.equal(pid(), first, 'one child for any number of busy sessions')

awake.note(-1)
awake.note(-1)
assert.ok(await settled(false), 'idle releases it')

awake.note(1)
assert.ok(await settled(true), 're-armed')
execSync(`kill ${pid()}`) // crash it the way a killall or a suspended Mac would
assert.ok(await settled(false), 'the dead child is forgotten')
// The counter tracks sessions, not children, so the crash leaves one session still busy and
// nothing respawns until a transition happens. Idle, then busy again, must re-arm.
awake.note(-1)
awake.note(1)
assert.ok(await settled(true), 'the next busy session re-arms it')
awake.note(-1)
assert.ok(await settled(false), 'released again')

// A negative drift from session recovery at boot must not go below zero and block the next hold.
awake.note(-5)
awake.note(1)
assert.ok(await settled(true), 'a clamped counter still re-arms')
awake.note(-1)
assert.ok(await settled(false), 'and releases')

console.log('awake.check: ok')
