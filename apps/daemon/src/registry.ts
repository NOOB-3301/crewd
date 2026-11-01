import { accessSync, constants, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness, McpServer } from '@crewd/protocol'
import { HOME } from './log.ts'
import { AcpOrchestrator } from './orchestrators/acp.ts'
import type { Orchestrator, OrchestratorClass } from './orchestrators/orchestrator.ts'
import { ClaudeSdkOrchestrator } from './orchestrators/sdk/claude.ts'
import { QoderSdkOrchestrator } from './orchestrators/sdk/qoder.ts'

const BUILTIN: Harness[] = [
  { id: 'claude', label: 'Claude Code', kind: 'sdk' },
  { id: 'qoder', label: 'Qoder', kind: 'sdk' },
  { id: 'opencode', label: 'OpenCode', kind: 'acp', command: ['opencode', 'acp'] },
  { id: 'pi', label: 'Pi', kind: 'acp', command: ['pi-acp'], disabled: true },
]

const SDK: Record<string, OrchestratorClass> = { claude: ClaudeSdkOrchestrator, qoder: QoderSdkOrchestrator }
const SDK_BINARY: Record<string, string> = { claude: 'claude', qoder: 'qodercli' }

// Built-ins plus ~/.crewd/harnesses.json (acp only, same id overrides). Read per call so edits apply live.
export function harnesses(): Harness[] {
  const byId = new Map(BUILTIN.map((h) => [h.id, h]))
  try {
    const extra = JSON.parse(readFileSync(join(HOME, 'harnesses.json'), 'utf8'))
    for (const h of Array.isArray(extra) ? extra : []) {
      if (h?.kind === 'acp' && typeof h.id === 'string' && Array.isArray(h.command) && h.command.length)
        byId.set(h.id, { label: h.id, ...h })
    }
  } catch {}
  return [...byId.values()]
}

export const get = (id: string) => harnesses().find((h) => h.id === id)

export function installed(h: Harness): boolean {
  const bin = h.kind === 'acp' ? h.command?.[0] : SDK_BINARY[h.id]
  if (!bin) return false
  const dirs = bin.includes('/') ? [''] : (process.env.PATH ?? '').split(':')
  return dirs.some((d) => {
    try {
      accessSync(d ? join(d, bin) : bin, constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

export function classFor(h: Harness): OrchestratorClass {
  const cls = h.kind === 'acp' ? AcpOrchestrator : SDK[h.id]
  if (!cls) throw new Error(`no orchestrator for harness ${h.id}`)
  return cls
}

export const create = (h: Harness, cwd: string, sessionId?: string, mcp?: McpServer[]): Orchestrator =>
  new (classFor(h))(h, cwd, sessionId, mcp)
