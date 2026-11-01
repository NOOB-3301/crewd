import type { Caps, Ev, ModeId, ModeInfo, PermissionOption } from '@crewd/protocol'
import { AsyncQueue } from '../util/async-queue.ts'
import { Orchestrator, summary, type Image } from './orchestrator.ts'

/** Anthropic-style user content; Claude and Qoder take the same blocks. */
export type UserContent =
  | string
  | ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } })[]

export const CLAUDE_MODES: ModeInfo[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'default', label: 'Ask' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan' },
  { id: 'bypassPermissions', label: 'Bypass' },
]

const OPTIONS: PermissionOption[] = [
  { id: 'allow', label: 'Allow once', kind: 'allow' },
  { id: 'always', label: 'Always allow', kind: 'always' },
  { id: 'deny', label: 'Deny', kind: 'deny' },
]

// Shared plumbing for vendor SDKs whose query() takes an async iterable of user messages
// and yields a stream of messages (Claude Agent SDK, and Qoder which mirrors it).
export abstract class SdkOrchestrator extends Orchestrator {
  protected inbox = new AsyncQueue<UserContent>()
  protected outbox = new AsyncQueue<Ev>()
  protected mode: ModeId = 'auto'
  private pump?: Promise<void>

  async start() {
    this.emitMode(this.startMode ?? 'auto')
    this.pump = (async () => {
      try {
        for await (const msg of this.runQuery()) {
          const id = this.readNativeId(msg)
          if (id) this.nativeId = id
          this.syncMode(msg)
          for (const ev of this.toEv(msg)) this.outbox.push(ev)
        }
      } catch (err) {
        this.outbox.push({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        this.outbox.push({ type: 'status', state: 'idle' })
        this.outbox.close()
      }
    })()
  }

  async send(text: string, images: Image[] = []) {
    this.inbox.push(
      images.length
        ? [...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mime, data: i.data } })), { type: 'text', text }]
        : text,
    )
  }

  async close() {
    this.inbox.close()
    await this.pump
  }

  events() {
    return this.outbox
  }

  caps(): Caps {
    return { list: true, load: true, fork: true, interrupt: true }
  }

  protected emitMode(mode: ModeId) {
    this.mode = mode
    this.outbox.push({ type: 'mode', mode, available: CLAUDE_MODES })
  }

  // init (each turn) and status messages carry the CLI's actual mode: catches a refused `auto` and mode
  // changes made inside the CLI (e.g. leaving plan mode).
  private syncMode(msg: unknown) {
    const m = msg as { type?: string; permissionMode?: unknown }
    if (m?.type !== 'system' || typeof m.permissionMode !== 'string' || m.permissionMode === this.mode) return
    if (this.mode === 'auto')
      this.outbox.push({ type: 'error', message: `Auto mode is not available on this account; using ${m.permissionMode}.` })
    this.emitMode(m.permissionMode)
  }

  /** canUseTool for Claude-shaped SDKs: relays the ask, maps the answer to a PermissionResult. */
  protected async canUseTool(
    tool: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown[]; title?: string },
  ) {
    const choice = await this.askUser({ tool, title: summary(input) ?? opts.title, input, options: OPTIONS }, opts.signal)
    if (choice === 'allow') return { behavior: 'allow' as const, updatedInput: input }
    if (choice === 'always') return { behavior: 'allow' as const, updatedInput: input, updatedPermissions: opts.suggestions }
    if (choice === 'deny') return { behavior: 'deny' as const, message: 'The user denied this.' }
    return { behavior: 'deny' as const, message: 'The user cancelled this.', interrupt: true }
  }

  /** Start the vendor query, consuming this.inbox as user input and starting in this.mode. */
  protected abstract runQuery(): AsyncIterable<unknown>
  /** Vendor message -> zero or more crewd events (unknown -> raw). */
  protected abstract toEv(msg: unknown): Ev[]
  protected abstract readNativeId(msg: unknown): string | undefined
}
