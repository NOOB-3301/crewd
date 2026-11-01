import type { HarnessInfo, SessionMeta } from '@crewd/protocol'

export type Route =
  | { name: 'home' }
  | { name: 'new'; harness?: HarnessInfo; cwd?: string }
  | { name: 'group'; by: 'project' | 'agent'; key: string; showTemp?: boolean }
  | { name: 'wall' }
  | { name: 'mcp' }
  | { name: 'usage' }

/** One open session in the wall. key stays the id it was opened with, so resuming a native session keeps the tile mounted. */
export type Tile = { key: string; session: SessionMeta; harness: HarnessInfo }

export type Nav = {
  push: (r: Route) => void
  pop: () => void
  /** back to the session list (open tiles stay open) */
  home: () => void
  /** to the open sessions, if any */
  wall: () => void
  /** adds the session as a tile (or focuses it if open) and shows the wall */
  open: (session: SessionMeta, harness: HarnessInfo) => void
  help: () => void
  quit: () => void
  launchCwd: string
  openCount: number
}

/** Shared list movement: ↑↓ / j k. Returns the new index, or undefined if the key is not a move. */
export function move(key: { name: string }, i: number, len: number): number | undefined {
  if (key.name === 'up' || key.name === 'k') return Math.max(0, i - 1)
  if (key.name === 'down' || key.name === 'j') return Math.min(len - 1, i + 1)
}
