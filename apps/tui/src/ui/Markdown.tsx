import { SyntaxStyle } from '@opentui/core'
import { useRenderer } from '@opentui/react'
import { theme } from './theme.ts'

// One style per process; it is owned by the renderer's native scene and freed with it.
let style: SyntaxStyle | undefined

function syntaxStyle(owner: Parameters<typeof SyntaxStyle.create>[0]) {
  style ??= SyntaxStyle.fromStyles({
    default: {},
    'markup.heading': { bold: true },
    'markup.strong': { bold: true },
    'markup.italic': { italic: true },
    'markup.raw': { fg: '#9AA5B1' },
    'markup.link': { fg: '#7AA7FF' },
    'markup.link.url': { fg: theme.muted },
    'markup.quote': { fg: theme.muted, italic: true },
    'markup.list': { fg: theme.muted },
    keyword: { fg: '#B49CD6' },
    string: { fg: '#8DB383' },
    comment: { fg: theme.muted, italic: true },
    number: { fg: '#C9A96A' },
    function: { fg: '#8AA4D6' },
    type: { fg: '#7DB8AA' },
  }, owner)
  return style
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const renderer = useRenderer()
  return <markdown content={text} syntaxStyle={syntaxStyle(renderer.nativeScene)} streaming={streaming} />
}
