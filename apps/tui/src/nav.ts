import type { HarnessInfo, SessionMeta } from '@crewd/protocol'

export type Route =
  | { name: 'home' }
  | { name: 'sessions'; harness: HarnessInfo }
  | { name: 'new'; harness?: HarnessInfo }
  | { name: 'chat'; session: SessionMeta; harness: HarnessInfo }
  | { name: 'mcp' }

export type Nav = {
  push: (r: Route) => void
  replace: (r: Route) => void
  pop: () => void
  help: () => void
  quit: () => void
  launchCwd: string
}

/** Shared list movement: ↑↓ / j k. Returns the new index, or undefined if the key is not a move. */
export function move(key: { name: string }, i: number, len: number): number | undefined {
  if (key.name === 'up' || key.name === 'k') return Math.max(0, i - 1)
  if (key.name === 'down' || key.name === 'j') return Math.min(len - 1, i + 1)
}
