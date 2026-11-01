import type { Caps, Ev, Harness, LogLine, McpServer, SessionMeta } from '@crewd/protocol'

// One instance per running session. sessionId undefined = new session, set = resume.
export abstract class Orchestrator {
  nativeId?: string

  constructor(
    readonly harness: Harness,
    readonly cwd: string,
    readonly sessionId?: string,
    readonly mcp: McpServer[] = [],
  ) {
    this.nativeId = sessionId
  }

  abstract start(): Promise<void>
  abstract send(text: string): Promise<void>
  abstract interrupt(): Promise<void>
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
}

export type OrchestratorClass = (new (h: Harness, cwd: string, sessionId?: string, mcp?: McpServer[]) => Orchestrator) & {
  listSessions(h: Harness, cwd?: string): Promise<SessionMeta[]>
  loadHistory(h: Harness, nativeId: string): Promise<LogLine[]>
}
