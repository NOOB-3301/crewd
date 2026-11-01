import type { Ev, Harness, LogLine, ModeId, ModelList, SessionMeta } from '@crewd/protocol'
import { AsyncQueue } from '../../util/async-queue.ts'
import { SdkOrchestrator, toModelInfo, withTimeout, type UserContent } from '../sdk.ts'
import { claudeMessageToEv } from './claude.ts'

// Qoder Agent SDK mirrors Claude's: https://docs.qoder.com/cli/sdk/references-typescript.md
// Optional dependency, so only the parts crewd touches are typed here.
type UserMessage = { type: 'user'; message: { role: 'user'; content: Exclude<UserContent, string> }; parent_tool_use_id: null }
type QoderModel = { value: string; displayName: string; description: string; isDefault?: boolean; isEnabled?: boolean }
type Query = AsyncGenerator<unknown, void> & {
  interrupt(): Promise<unknown>
  setPermissionMode(mode: string): Promise<void>
  setModel(model?: string): Promise<void>
  initializationResult(): Promise<{ models?: QoderModel[] }>
  close(): Promise<void>
}
type SessionInfo = { sessionId: string; summary: string; lastModified: number; customTitle?: string; firstPrompt?: string; cwd?: string; createdAt?: number }
type SessionMessage = { type: 'user' | 'assistant' | 'system'; message: unknown }
type QoderSdk = {
  query(p: { prompt: AsyncIterable<UserMessage>; options: Record<string, unknown> }): Query
  accessTokenFromEnv(envVar?: string): unknown
  qodercliAuth?(): unknown
  listSessions(o?: { dir?: string; limit?: number }): Promise<SessionInfo[]>
  getSessionMessages(sessionId: string): Promise<SessionMessage[]>
}

// A variable specifier keeps tsc and the bundler from resolving the package at build time.
const PKG = '@qoder-ai/qoder-agent-sdk'
async function loadSdk(): Promise<QoderSdk> {
  try {
    return (await import(PKG)) as QoderSdk
  } catch {
    throw new Error('Qoder SDK not installed. Run: bun add @qoder-ai/qoder-agent-sdk in apps/daemon')
  }
}

// crewd has no auth UI: use a PAT from the env, else reuse `qodercli login`.
function auth(sdk: QoderSdk) {
  if (process.env.QODER_PERSONAL_ACCESS_TOKEN) return sdk.accessTokenFromEnv()
  return sdk.qodercliAuth?.()
}

const str = (v: unknown): v is string => typeof v === 'string'
// Asked before init finishes, the CLI reports every model disabled; init's list has the account applied.
// Disabled = not on this account's plan, so they are left out.
const models = (q: Query) => q.initializationResult().then((r) => (r.models ?? []).filter((m) => m.isEnabled !== false))

export class QoderSdkOrchestrator extends SdkOrchestrator {
  private q?: Query

  protected async *runQuery() {
    const sdk = await loadSdk()
    const inbox = this.inbox
    async function* prompt(): AsyncIterable<UserMessage> {
      for await (const c of inbox)
        yield { type: 'user', message: { role: 'user', content: typeof c === 'string' ? [{ type: 'text', text: c }] : c }, parent_tool_use_id: null }
    }
    this.q = sdk.query({
      prompt: prompt(),
      options: {
        cwd: this.cwd,
        resume: this.sessionId,
        auth: auth(sdk),
        ...(this.startModel && { model: this.startModel }),
        mcpServers: Object.fromEntries(
          this.mcp.filter((s) => s.enabled !== false).map((s) => [s.name, { type: 'stdio', command: s.command, args: s.args, env: s.env }]),
        ),
        // shortcut: written from the docs, not run (SDK not installed): assumes Claude's permissionMode values,
        // canUseTool signature and setPermissionMode; check against a real install.
        permissionMode: this.mode,
        canUseTool: (tool: string, input: Record<string, unknown>, opts: { signal: AbortSignal; suggestions?: unknown[] }) =>
          this.canUseTool(tool, input, opts),
      },
    })
    this.loadModels(models(this.q))
    yield* this.q
  }

  async interrupt() {
    await this.q?.interrupt()
  }

  async setMode(mode: ModeId) {
    if (!this.q) throw new Error('Qoder session not started')
    await this.q.setPermissionMode(mode)
    this.emitMode(mode)
  }

  async setModel(model: string) {
    if (!this.q) throw new Error('Qoder session not started')
    await this.q.setModel(model)
    this.emitModel(model)
  }

  // Ending the input lets an idle CLI exit; stop the generator if a turn keeps it busy.
  async close() {
    await Promise.race([super.close(), new Promise((r) => setTimeout(r, 3000))])
    await this.q?.return(undefined)
  }

  protected toEv(msg: unknown): Ev[] {
    return claudeMessageToEv(msg)
  }

  protected readNativeId(msg: unknown) {
    const id = (msg as { session_id?: unknown } | null)?.session_id
    return str(id) ? id : undefined
  }

  static override async listSessions(h: Harness, cwd?: string): Promise<SessionMeta[]> {
    const sdk = await loadSdk().catch(() => undefined)
    if (!sdk) return []
    const list = await sdk.listSessions({ dir: cwd, limit: 200 })
    return list
      .sort((a, b) => b.lastModified - a.lastModified)
      .map((s) => ({
        id: s.sessionId,
        harness: h.id,
        nativeId: s.sessionId,
        cwd: s.cwd ?? cwd ?? '',
        title: s.customTitle ?? s.summary ?? s.firstPrompt,
        status: 'idle',
        createdAt: s.createdAt ?? s.lastModified,
        updatedAt: s.lastModified,
        source: 'native',
      }))
  }

  // A query that never gets a prompt: the CLI starts and answers control requests without calling the model.
  static override async listModels(_h: Harness, cwd: string): Promise<ModelList> {
    const sdk = await loadSdk()
    const inbox = new AsyncQueue<UserMessage>()
    const q = sdk.query({ prompt: inbox, options: { cwd, auth: auth(sdk) } })
    try {
      const list = await withTimeout(models(q), 15000, 'Qoder model list')
      return { models: list.map(toModelInfo), current: list.find((m) => m.isDefault)?.value }
    } finally {
      inbox.close()
      await q.close().catch(() => {})
    }
  }

  static override async loadHistory(_h: Harness, nativeId: string): Promise<LogLine[]> {
    const sdk = await loadSdk().catch(() => undefined)
    if (!sdk) return []
    const out: LogLine[] = []
    const push = (line: { kind: 'user'; text: string } | { kind: 'event'; ev: Ev }) =>
      out.push({ seq: out.length + 1, ts: 0, ...line })
    for (const m of await sdk.getSessionMessages(nativeId)) {
      if (m.type === 'user') {
        const text = userText(m.message)
        if (text) push({ kind: 'user', text })
        else for (const ev of claudeMessageToEv(m)) push({ kind: 'event', ev }) // tool_result-only turns
      } else if (m.type === 'assistant') {
        for (const ev of claudeMessageToEv(m)) push({ kind: 'event', ev })
      }
    }
    return out
  }
}

function userText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (str(content)) return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b: { type?: unknown; text?: unknown }) => (b?.type === 'text' && str(b.text) ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}
