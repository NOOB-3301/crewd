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
    'markup.raw': { fg: '#E6C07B' },
    'markup.link': { fg: '#7AA7FF', underline: true },
    'markup.link.url': { fg: theme.muted, underline: true },
    'markup.quote': { fg: theme.muted, italic: true },
    'markup.list': { fg: theme.muted },
    keyword: { fg: '#C9A0FF' },
    string: { fg: '#8BD17C' },
    comment: { fg: theme.muted, italic: true },
    number: { fg: '#F2C14E' },
    function: { fg: '#7AA7FF' },
    type: { fg: '#5FD3BC' },
  }, owner)
  return style
}

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const renderer = useRenderer()
  return <markdown content={text} syntaxStyle={syntaxStyle(renderer.nativeScene)} streaming={streaming} />
}
