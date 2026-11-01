import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServer } from '@crewd/protocol'
import { HOME } from './log.ts'

const FILE = join(HOME, 'mcp.json')

export function readMcp(): McpServer[] {
  try {
    const list = JSON.parse(readFileSync(FILE, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function writeMcp(list: unknown): McpServer[] {
  const ok =
    Array.isArray(list) &&
    list.every((s) => s && typeof s.name === 'string' && s.name && typeof s.command === 'string' && s.command)
  if (!ok) throw new Error('expected an array of {name, command, args?, env?, enabled?}')
  writeFileSync(FILE, JSON.stringify(list, null, 2))
  return list as McpServer[]
}

/** Servers for a session: the ones named at create time, else the enabled ones. */
export function mcpFor(names?: string[]): McpServer[] {
  const all = readMcp()
  return names ? all.filter((s) => names.includes(s.name)) : all.filter((s) => s.enabled !== false)
}
