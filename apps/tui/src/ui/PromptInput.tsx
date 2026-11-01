/* Growing prompt input with image chips. In Chat, replace the `› ` text + <input> inside the bordered box with:
 *
 *   <box border={["top"]} borderColor={theme.muted} paddingX={1} flexShrink={0}>
 *     <PromptInput focused={focus === 'input'} color={color} value={input}
 *       placeholder={`ask ${harness.label}, or / for commands`}
 *       imageDir={join(homedir(), '.crewd', 'tmp')}
 *       onChange={(v) => { setInput(v); setPalSel(0); if (v.startsWith('/')) goLive()... }}
 *       onSubmit={(text, images) => paletteOpen ? runCommand(palItems[palSel]) : sendText(text, images)} />
 *   </box>
 *
 * Keys: enter sends, ctrl+j / shift+enter / alt+enter newline, ctrl+v pastes a clipboard image (else clipboard text),
 * backspace on empty text drops the last chip. Pasted/dropped image paths become chips.
 */
import { useEffect, useRef, useState } from 'react'
import { decodePasteBytes, stripAnsiSequences, type KeyEvent, type PasteEvent, type TextareaRenderable } from '@opentui/core'
import type { ImageRef } from '@crewd/protocol'
import { imagePathsIn, readClipboardImage } from './clipboard'
import { theme } from './theme'

type Props = {
  focused: boolean
  color: string
  placeholder?: string
  disabled?: boolean
  value: string
  onChange(v: string): void
  onSubmit(text: string, images: ImageRef[]): void
  imageDir: string
  maxLines?: number
}

const bindings = [
  { name: 'return', action: 'submit' as const },
  { name: 'kpenter', action: 'submit' as const },
  { name: 'linefeed', action: 'newline' as const }, // ctrl+j in legacy terminals
  { name: 'j', ctrl: true, action: 'newline' as const }, // ctrl+j under kitty protocol
  { name: 'return', shift: true, action: 'newline' as const },
  { name: 'return', meta: true, action: 'newline' as const },
]

export function PromptInput({ focused, color, placeholder, disabled, value, onChange, onSubmit, imageDir, maxLines = 8 }: Props) {
  const ref = useRef<TextareaRenderable>(null)
  const [images, setImages] = useState<ImageRef[]>([])
  const [lines, setLines] = useState(1)
  const measure = () => ref.current && setLines(ref.current.editorView.getTotalVirtualLineCount())

  // Parent-driven changes (clear after send, palette completion) flow back into the buffer.
  useEffect(() => {
    const t = ref.current
    if (t && t.plainText !== value) {
      t.setText(value)
      t.gotoBufferEnd()
    }
  }, [value])

  const insert = (raw: string) => {
    const found = imagePathsIn(raw)
    if (found.images.length) setImages((xs) => [...xs, ...found.images])
    if (found.text) ref.current?.insertText(found.text)
  }

  const pasteClipboard = async (textFallback: boolean) => {
    const img = await readClipboardImage(imageDir).catch(() => null)
    if (img) return setImages((xs) => [...xs, img])
    if (textFallback && process.platform === 'darwin') insert(await new Response(Bun.spawn(['pbpaste']).stdout).text())
  }

  const submit = () => {
    const text = (ref.current?.plainText ?? value).trim()
    if (disabled || (!text && !images.length)) return
    onSubmit(text, images)
    setImages([])
    ref.current?.setText('')
    onChange('')
  }

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={0}>
      {images.length > 0 && <text fg={color}>{images.map((_, i) => `[Image #${i + 1}]`).join(' ')}</text>}
      <box flexDirection="row">
        <text fg={color} flexShrink={0}>› </text>
        <textarea
          ref={ref}
          focused={focused && !disabled}
          placeholder={placeholder}
          placeholderColor={theme.muted}
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          wrapMode="word"
          keyBindings={bindings}
          height={Math.min(Math.max(lines, 1), maxLines)}
          flexGrow={1}
          flexBasis={0}
          onSubmit={submit}
          onSizeChange={measure}
          onContentChange={() => {
            measure()
            const v = ref.current?.plainText ?? ''
            if (v !== value) onChange(v)
          }}
          onKeyDown={(k: KeyEvent) => {
            if (k.ctrl && k.name === 'v') {
              k.preventDefault()
              void pasteClipboard(true)
            } else if (k.name === 'backspace' && !ref.current?.plainText && images.length) {
              k.preventDefault()
              setImages((xs) => xs.slice(0, -1))
            }
          }}
          onPaste={(e: PasteEvent) => {
            e.preventDefault()
            const raw = stripAnsiSequences(decodePasteBytes(e.bytes))
            // Cmd+V with an image on the clipboard arrives as an empty paste in some terminals.
            if (!raw.trim()) void pasteClipboard(false)
            else insert(raw)
          }}
        />
      </box>
    </box>
  )
}
