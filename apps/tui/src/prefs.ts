import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { crewdHome } from '@crewd/client'

/** Small JSON files the TUI keeps in ~/.crewd (tui.json, wall.json). Missing or broken file = fallback. */
export function readPref<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(join(crewdHome, file), 'utf8')) as T } catch { return fallback }
}

export function writePref(file: string, value: unknown) {
  try {
    mkdirSync(crewdHome, { recursive: true })
    writeFileSync(join(crewdHome, file), JSON.stringify(value, null, 2))
  } catch {} // a preference that fails to save is not worth interrupting the user for
}
