import {
  getSessionMessages,
  listSessions,
  query,
  type PermissionMode,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { Ev, Harness, LogLine, SessionMeta } from '@crewd/protocol'
import { SdkOrchestrator } from '../sdk.ts'

const str = (v: unknown): v is string => typeof v === 'string'

/** Claude SDK message -> crewd events. Pure; Qoder reuses it because its SDK mirrors these shapes. */
export function claudeMessageToEv(msg: unknown): Ev[] {
  try {
    const m = msg as any
    if (!m || typeof m !== 'object') return [{ type: 'raw', data: msg }]

    if (m.type === 'system' && m.subtype === 'init' && Array.isArray(m.slash_commands))
      return [{ type: 'commands', list: m.slash_commands.filter(str) }, { type: 'raw', data: m }]
    if (m.type === 'system' && m.subtype === 'commands_changed' && Array.isArray(m.commands))
      return [{ type: 'commands', list: m.commands.map((c: any) => (str(c) ? c : c?.name)).filter(str) }]

    const content = m.message?.content
    if (m.type === 'assistant' && Array.isArray(content)) {
      return content.flatMap((b: any): Ev[] => {
        if (b?.type === 'text' && str(b.text)) return [{ type: 'text', text: b.text }]
        // Redacted thinking arrives as an empty string plus a signature; nothing to show.
        if (b?.type === 'thinking') return b.thinking ? [{ type: 'thinking', text: b.thinking }] : []
        if (b?.type === 'tool_use') return [{ type: 'tool', id: b.id, name: b.name, status: 'start', input: b.input }]
        return [{ type: 'raw', data: b }]
      })
    }
    if (m.type === 'user' && Array.isArray(content)) {
      const results = content.filter((b: any) => b?.type === 'tool_result')
      if (results.length)
        return results.map((b: any): Ev => ({
          type: 'tool',
          id: b.tool_use_id,
          name: '', // the result block does not repeat the tool name; match by id
          status: b.is_error ? 'error' : 'end',
          output: b.content,
        }))
    }
    if (m.type === 'result') {
      const end: Ev = { type: 'turn_end', usage: m.usage, costUsd: m.total_cost_usd }
      if (!m.is_error) return [end]
      const message = Array.isArray(m.errors) && m.errors.length ? m.errors.join('\n') : str(m.result) ? m.result : m.subtype
      return [{ type: 'error', message: String(message ?? 'Claude turn failed') }, end]
    }
    return [{ type: 'raw', data: m }]
  } catch {
    return [{ type: 'raw', data: msg }]
  }
}

export class ClaudeSdkOrchestrator extends SdkOrchestrator {
  private q?: Query

  protected runQuery() {
    const inbox = this.inbox
    async function* prompt(): AsyncIterable<SDKUserMessage> {
      for await (const text of inbox) yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
    }
    this.q = query({
      prompt: prompt(),
      options: {
        cwd: this.cwd,
        resume: this.sessionId,
        mcpServers: Object.fromEntries(this.mcp.map((s) => [s.name, { command: s.command, args: s.args, env: s.env }])),
        // No approval UI yet: anything the mode doesn't auto-allow is denied.
        permissionMode: (process.env.CREWD_CLAUDE_PERMISSION_MODE ?? 'acceptEdits') as PermissionMode,
      },
    })
    return this.q
  }

  async interrupt() {
    await this.q?.interrupt()
  }

  // Ending the input stream lets an idle CLI exit cleanly; force-kill if a turn keeps it busy.
  async close() {
    await Promise.race([super.close(), new Promise((r) => setTimeout(r, 3000))])
    this.q?.close()
  }

  protected toEv(msg: unknown) {
    return claudeMessageToEv(msg)
  }

  protected readNativeId(msg: unknown) {
    const id = (msg as { session_id?: unknown } | null)?.session_id
    return str(id) ? id : undefined
  }

  static async listSessions(h: Harness, cwd?: string): Promise<SessionMeta[]> {
    // SDK reads ~/.claude/projects (honours CLAUDE_CONFIG_DIR) with the CLI's own path rules.
    const list = await listSessions({ dir: cwd, limit: 200 })
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

  static async loadHistory(_h: Harness, nativeId: string): Promise<LogLine[]> {
    const msgs = await getSessionMessages(nativeId)
    const out: LogLine[] = []
    // The SDK's SessionMessage carries no timestamp, so ts is 0.
    const push = (line: { kind: 'user'; text: string } | { kind: 'event'; ev: Ev }) => out.push({ seq: out.length + 1, ts: 0, ...line } as LogLine)
    for (const m of msgs) {
      const content = (m.message as any)?.content
      if (m.type === 'user') {
        const text = str(content)
          ? content
          : Array.isArray(content)
            ? content.filter((b: any) => b?.type === 'text' && str(b.text)).map((b: any) => b.text).join('\n')
            : ''
        if (text) push({ kind: 'user', text })
        else for (const ev of claudeMessageToEv(m)) push({ kind: 'event', ev }) // tool_result-only turns
      } else if (m.type === 'assistant') {
        for (const ev of claudeMessageToEv(m)) push({ kind: 'event', ev })
      }
    }
    return out
  }
}
