// Self-check: bun apps/daemon/src/remote.check.ts
// Remote config parsing, the token file, and the auth gate on every route shape a client can send.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'crewd-remote-'))
process.env.CREWD_HOME = dir // read by log.ts at import, so it has to come first
const remote = await import('./remote.ts')
const cfg = join(dir, 'remote.json')
const tokenFile = join(dir, 'remote-token')

// Absent or invalid config means no remote listener at all, never a default port.
assert.equal(remote.remotePort(), undefined, 'no remote.json')
for (const bad of ['garbage{', '{}', '{"port":"8791"}', '{"port":0}', '{"port":-1}', '{"port":65536}', '{"port":1.5}', '{"port":null}']) {
  writeFileSync(cfg, bad)
  assert.equal(remote.remotePort(), undefined, `rejects ${bad}`)
}
writeFileSync(cfg, '{"port": 8791}')
assert.equal(remote.remotePort(), 8791)

const t = remote.token()
assert.match(t, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url')
assert.equal(readFileSync(tokenFile, 'utf8'), t, 'stored with no trailing newline')
assert.equal(statSync(tokenFile).mode & 0o777, 0o600, 'owner read-write only')
assert.equal(remote.token(), t, 'reused on later starts')
writeFileSync(tokenFile, `${t}\n`)
assert.equal(remote.token(), t, 'a pasted newline does not change the token')

const gate = remote.remoteApp()
const ask = (authorization?: string) => gate.request('/sessions', authorization ? { headers: { authorization } } : undefined)
assert.equal((await ask()).status, 401, 'no header')
assert.equal((await ask('nope')).status, 401, 'not a bearer header')
assert.equal((await ask('Bearer')).status, 401, 'empty token')
assert.equal((await ask('Bearer ')).status, 401, 'blank token')
assert.equal((await ask('Basic ' + t)).status, 401, 'wrong scheme')
assert.equal((await ask(`Bearer ${t}x`)).status, 401, 'one character off the end')
assert.equal((await ask(`Bearer ${t.slice(0, 20)}`)).status, 401, 'a token prefix')
assert.equal((await ask(`Bearer ${t}`)).status, 200, 'the right token reaches the app')
const denied = await gate.request('/projects')
assert.equal(denied.status, 401, 'every route is behind the token')
assert.deepEqual(await denied.json(), { error: 'unauthorized' }, '401 is a JSON body, not text')

// Failed attempts are logged by path only: the token and the headers must not reach daemon.log.
const logged = readFileSync(join(dir, 'daemon.log'), 'utf8')
assert.ok(!logged.includes(t), 'token never logged')
assert.ok(!logged.includes('Bearer'), 'authorization header never logged')
assert.ok(logged.includes('remote denied GET /sessions'), 'the attempt itself is logged')

console.log('remote.check: ok')
