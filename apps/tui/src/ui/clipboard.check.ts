// Self-check: bun apps/tui/src/ui/clipboard.check.ts  (on macOS this OVERWRITES the clipboard with a 1x1 PNG)
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imagePathsIn, readClipboardImage } from './clipboard'

const dir = mkdtempSync(join(tmpdir(), 'crewd-clip-'))
const a = join(dir, 'a.png'), spaced = join(dir, 'my shot.JPG'), txt = join(dir, 'notes.txt')
for (const f of [a, spaced, txt]) writeFileSync(f, 'x')

let r = imagePathsIn(`look at ${a} please`)
assert.deepEqual(r, { images: [{ path: a, mime: 'image/png' }], text: 'look at please' }, 'plain path')

r = imagePathsIn(`'${spaced}' and "${a}"`)
assert.deepEqual(r.images.map((i) => [i.path, i.mime]), [[spaced, 'image/jpeg'], [a, 'image/png']], 'quoted paths')
assert.equal(r.text, 'and')

r = imagePathsIn(spaced.replace(/ /g, '\\ ') + ' ')
assert.deepEqual(r, { images: [{ path: spaced, mime: 'image/jpeg' }], text: '' }, 'backslash-escaped spaces')

r = imagePathsIn(`file://${encodeURI(spaced)}`)
assert.deepEqual(r.images, [{ path: spaced, mime: 'image/jpeg' }], 'file:// url')

for (const s of [`see ${txt}`, `see ${join(dir, 'missing.png')}`, 'and/or a.png', 'no paths here']) {
  assert.deepEqual(imagePathsIn(s), { images: [], text: s }, `ignored: ${s}`)
}

if (process.platform === 'darwin') {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const src = join(dir, 'src.png')
  writeFileSync(src, png)
  const set = Bun.spawnSync(['osascript', '-e', 'on run argv', '-e', 'set the clipboard to (read POSIX file (item 1 of argv) as «class PNGf»)', '-e', 'end run', src])
  assert.equal(set.exitCode, 0, 'put PNG on clipboard')
  const img = await readClipboardImage(join(dir, 'out'))
  assert.ok(img && img.mime === 'image/png', 'clipboard image read')
  assert.deepEqual([...readFileSync(img.path).subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature')
  Bun.spawnSync(['osascript', '-e', 'set the clipboard to "crewd"'])
  assert.equal(await readClipboardImage(join(dir, 'out')), null, 'text clipboard -> null')
}

rmSync(dir, { recursive: true, force: true })
console.log('clipboard.check ok')
