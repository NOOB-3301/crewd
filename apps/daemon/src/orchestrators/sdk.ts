import type { Caps, Ev } from '@crewd/protocol'
import { AsyncQueue } from '../util/async-queue.ts'
import { Orchestrator } from './orchestrator.ts'

// Shared plumbing for vendor SDKs whose query() takes an async iterable of user messages
// and yields a stream of messages (Claude Agent SDK, and Qoder which mirrors it).
export abstract class SdkOrchestrator extends Orchestrator {
  protected inbox = new AsyncQueue<string>()
  protected outbox = new AsyncQueue<Ev>()
  private pump?: Promise<void>

  async start() {
    this.pump = (async () => {
      try {
        for await (const msg of this.runQuery()) {
          const id = this.readNativeId(msg)
          if (id) this.nativeId = id
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

  async send(text: string) {
    this.inbox.push(text)
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

  /** Start the vendor query, consuming this.inbox as user input. */
  protected abstract runQuery(): AsyncIterable<unknown>
  /** Vendor message -> zero or more crewd events (unknown -> raw). */
  protected abstract toEv(msg: unknown): Ev[]
  protected abstract readNativeId(msg: unknown): string | undefined
}
