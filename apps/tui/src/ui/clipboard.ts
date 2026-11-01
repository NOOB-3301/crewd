import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ImageRef } from '@crewd/protocol'

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

// Writes the clipboard image (if any) as PNG into dir. Path goes in via argv, never into the script text.
export async function readClipboardImage(dir: string): Promise<ImageRef | null> {
  if (process.platform !== 'darwin') return null // shortcut: macOS only; add wl-paste/xclip for Linux
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${Date.now()}.png`)
  const script = [
    'on run argv',
    'set png to the clipboard as «class PNGf»',
    'set f to open for access POSIX file (item 1 of argv) with write permission',
    'try',
    'write png to f',
    'end try',
    'close access f',
    'end run',
  ]
  const p = Bun.spawn(['osascript', ...script.flatMap((l) => ['-e', l]), path], { stdout: 'ignore', stderr: 'ignore' })
  const ok = (await p.exited) === 0 && existsSync(path) && statSync(path).size > 0
  if (!ok) rmSync(path, { force: true })
  return ok ? { path, mime: 'image/png' } : null
}

// 'quoted' | "quoted" | file://url | /abs or ~/path with backslash-escaped spaces (terminal drag-drop), plus trailing blanks.
const CANDIDATE = /(?<=^|\s)(?:(['"])(.+?)\1|file:\/\/(\S+)|((?:\/|~\/)(?:\\.|[^\s\\'"])+))[ \t]*/g

export function imagePathsIn(text: string): { images: ImageRef[]; text: string } {
  const images: ImageRef[] = []
  const rest = text.replace(CANDIDATE, (m, _q, quoted?: string, url?: string, bare?: string) => {
    let p = quoted ?? (url ? safeDecode(url.replace(/^localhost(?=\/)/, '')) : bare!.replace(/\\(.)/g, '$1'))
    if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
    const mime = MIME[p.match(/\.(\w+)$/)?.[1]?.toLowerCase() ?? '']
    if (!mime || !p.startsWith('/') || !existsSync(p) || !statSync(p).isFile()) return m
    images.push({ path: p, mime })
    return ''
  })
  return { images, text: images.length ? rest.trim() : text }
}

// pbcopy works in every macOS terminal; OSC52 covers ssh/Linux where the terminal allows it.
export function copyText(text: string, osc52: (t: string) => boolean): void {
  if (process.platform === 'darwin') {
    const p = Bun.spawn(['pbcopy'], { stdin: 'pipe', stdout: 'ignore', stderr: 'ignore' })
    p.stdin.write(text)
    p.stdin.end()
  } else osc52(text)
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}
