import type { Caps, Ev, Harness, LogLine, McpServer, ModeId, ModelList, PermissionOption, SessionMeta } from '@crewd/protocol'

/** A permission question as the orchestrator asks it; sessions.ts adds the requestId and relays it. */
export type PermissionAsk = { tool: string; title?: string; input?: unknown; options: PermissionOption[] }
/** Image file already read by the daemon. */
export type Image = { mime: string; data: string }

// The one detail a person needs to judge a tool call: the command, path or URL.
export function summary(input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>
  const v = i.command ?? i.file_path ?? i.filePath ?? i.notebook_path ?? i.url ?? i.path ?? i.pattern ?? i.query
  return typeof v === 'string' ? v.slice(0, 200) : undefined
}

// One instance per running session. sessionId undefined = new session, set = resume.
export abstract class Orchestrator {
  nativeId?: string
  /** Mode to start in (create body or the session's last mode); harness default when undefined. */
  startMode?: ModeId
  /** Model to start with (create body or the session's last model); harness default when undefined. */
  startModel?: string
  /** Set by sessions.ts. Resolves with the chosen option id, or undefined when cancelled (interrupt, delete, agent abort). */
  askUser: (req: PermissionAsk, signal?: AbortSignal) => Promise<string | undefined> = async () => undefined

  constructor(
    readonly harness: Harness,
    readonly cwd: string,
    readonly sessionId?: string,
    readonly mcp: McpServer[] = [],
  ) {
    this.nativeId = sessionId
  }

  abstract start(): Promise<void>
  abstract send(text: string, images?: Image[]): Promise<void>
  abstract interrupt(): Promise<void>
  abstract setMode(mode: ModeId): Promise<void>
  async setModel(_model: string): Promise<void> {
    throw new Error(`${this.harness.label} can't switch models`)
  }
  abstract close(): Promise<void>
  abstract events(): AsyncIterable<Ev>
  abstract caps(): Caps

  // Old-sessions screen: work without a running session.
  static async listSessions(_h: Harness, _cwd?: string): Promise<SessionMeta[]> {
    return []
  }
  static async loadHistory(_h: Harness, _nativeId: string): Promise<LogLine[]> {
    return []
  }
  /** Models the harness offers in cwd, without a crewd session (may start a short-lived agent). */
  static async listModels(_h: Harness, _cwd: string): Promise<ModelList> {
    return { models: [] }
  }
}

export type OrchestratorClass = (new (h: Harness, cwd: string, sessionId?: string, mcp?: McpServer[]) => Orchestrator) & {
  listSessions(h: Harness, cwd?: string): Promise<SessionMeta[]>
  loadHistory(h: Harness, nativeId: string): Promise<LogLine[]>
  listModels(h: Harness, cwd: string): Promise<ModelList>
}
