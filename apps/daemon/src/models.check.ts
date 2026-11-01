// Self-check: bun apps/daemon/src/models.check.ts
// Drives a fake ACP agent: model list probe (+ cleanup), the daemon's cache, and switching models in a live session.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ev, Harness } from '@crewd/protocol'

const dir = mkdtempSync(join(tmpdir(), 'crewd-models-'))
process.env.CREWD_HOME = dir
const calls = join(dir, 'calls.txt')
const agent = join(dir, 'agent.mjs')
// Minimal JSON-RPC agent: logs every method it gets to calls.txt.
writeFileSync(agent, `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const opts = (current) => [{ id: 'm', name: 'Model', category: 'model', type: 'select', currentValue: current,
  options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B', description: 'big' }] }]
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l)
  appendFileSync(${JSON.stringify(calls)}, m.method + (m.params?.value ? ' ' + m.params.value : '') + '\\n')
  if (m.method === 'initialize') reply(m.id, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { delete: {} } } })
  else if (m.method === 'session/new') reply(m.id, { sessionId: 's1', configOptions: opts('b') })
  else if (m.method === 'session/set_config_option') reply(m.id, { configOptions: opts(m.params.value) })
  else if (m.id !== undefined) reply(m.id, {})
})
`)
const log = () => readFileSync(calls, 'utf8').trim().split('\n')
const count = (method: string) => log().filter((l) => l === method).length

const h: Harness = { id: 'fake', label: 'Fake', kind: 'acp', command: [process.execPath, agent] }
const models = await import('./models.ts')
const { AcpOrchestrator } = await import('./orchestrators/acp.ts')

// Probe: list + current from the 'model' config option, throwaway session deleted.
const l = await models.list(h, dir)
assert.deepEqual(l, { models: [{ id: 'a', label: 'A', description: undefined }, { id: 'b', label: 'B', description: 'big' }], current: 'b' })
assert.equal(count('session/new'), 1)
assert.equal(count('session/delete'), 1, 'probe session is deleted')

// Cache: hit, then refresh, then concurrent callers share one probe.
await models.list(h, dir)
assert.equal(count('session/new'), 1, 'second call is cached')
await models.list(h, dir, true)
assert.equal(count('session/new'), 2, 'refresh probes again')
await Promise.all([models.list(h, join(dir, '..')), models.list(h, join(dir, '..'))])
assert.equal(count('session/new'), 3, 'concurrent calls share one probe')

// A live session's list replaces the cached one and keeps the probed default.
models.remember(h, dir, [{ id: 'z', label: 'Z' }])
assert.deepEqual(await models.list(h, dir), { models: [{ id: 'z', label: 'Z' }], current: 'b' })

// Live session: start model applied via set_config_option, then switch, then reject unknown ids.
const o = new AcpOrchestrator(h, dir)
o.startModel = 'a'
const evs: Ev[] = []
void (async () => { for await (const e of o.events()) evs.push(e) })()
await o.start()
await o.setModel('b')
await assert.rejects(o.setModel('nope'), /has no model nope/)
await o.close()
const modelEvs = evs.filter((e) => e.type === 'model')
assert.deepEqual(modelEvs.map((e) => e.type === 'model' && e.model), ['a', 'b'])
assert.ok(log().includes('session/set_config_option a') && log().includes('session/set_config_option b'))

// SDK harnesses: init reports a display name (Qoder) or wire id (Claude); both map back to the list id.
const { SdkOrchestrator } = await import('./orchestrators/sdk.ts')
class FakeSdk extends SdkOrchestrator {
  constructor(private init: string[], private listMs: number) { super(h, dir) }
  protected async *runQuery() {
    this.loadModels(new Promise((r) => setTimeout(r, this.listMs)).then(() => [{ value: 'big', displayName: 'Big One' }, { value: 'haiku', displayName: 'Haiku', resolvedModel: 'claude-haiku-x' }]))
    for (const model of this.init) { await new Promise((r) => setTimeout(r, 5)); yield { type: 'system', subtype: 'init', model } }
    await new Promise((r) => setTimeout(r, this.listMs + 10)) // a real session outlives the list request
  }
  protected toEv() { return [] }
  protected readNativeId() { return undefined }
  async interrupt() {}
  async setMode() {}
}
async function run(init: string[], startModel?: string, listMs = 0) {
  const f = new FakeSdk(init, listMs)
  f.startModel = startModel
  const out: (string | undefined)[] = []
  await f.start()
  for await (const e of f.events()) if (e.type === 'model') out.push(e.model)
  return out
}
assert.deepEqual(await run(['Big One']), [undefined, 'big'], 'display name -> id (list first, then init)')
assert.deepEqual(await run(['Big One'], undefined, 20), ['Big One', 'big'], 'display name -> id once the list arrives (init first)')
assert.deepEqual(await run(['claude-haiku-x', 'claude-haiku-x'], 'haiku'), ['haiku'], 'wire id of the current pick: no extra event')
assert.deepEqual(await run(['Other']), [undefined, 'Other'], 'unknown name kept as reported')
console.log('models.check: ok')
