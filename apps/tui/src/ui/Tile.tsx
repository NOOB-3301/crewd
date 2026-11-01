import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ScrollBoxRenderable } from '@opentui/core'
import { useKeyboard } from '@opentui/react'
import type { SessionMeta } from '@crewd/protocol'
import type { Tile as TileT } from '../nav.ts'
import { useSession, type Item, type SessionState } from '../useSession.ts'
import { Markdown } from './Markdown.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { Rail } from './Rail.tsx'
import { ThinkingLine } from './ThinkingLine.tsx'
import { ToolLine } from './ToolLine.tsx'
import { accent, glyph, shortPath, theme } from './theme.ts'

const preview = (items: Item[]) => {
  const t = items.find((x) => x.k === 'text')
  const first = (t && t.k === 'text' ? t.text : '').trim().split('\n')[0]!.replace(/[#*`>]/g, '').slice(0, 90)
  return `${first || 'tool calls'}  (${items.length} ${items.length === 1 ? 'item' : 'items'})`
}

/** One open session: bordered transcript (+ its permission prompt). The focused tile hands its state to the wall through `report`. */
export function Tile({ t, n, focused, full, hidden, logFocus, active, width, report, changed, onLive }: {
  t: TileT; n: number; focused: boolean; full: boolean; hidden: boolean; logFocus: boolean; active: boolean; width: number
  report: RefObject<SessionState | undefined>; changed: () => void; onLive: (s: SessionMeta) => void
}) {
  const s = useSession(t.session, t.harness, onLive)
  const [logSel, setLogSel] = useState(0)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showThinking, setShowThinking] = useState(false)
  const scroll = useRef<ScrollBoxRenderable>(null)

  if (focused) report.current = s
  // Re-render the wall when something it shows for the focused tile changes (status bar, palette, prompt keys).
  useEffect(() => { if (focused) changed() }, [focused, s.session, s.status, s.mode, s.modes, s.commands, s.pending, s.err, s.tokens, s.cost])

  // Only the latest agent reply is shown in full; older ones fold to one line until opened (enter).
  const lastAgent = s.blocks.map((b) => b.who).lastIndexOf('agent')
  const isOld = (i: number) => i < lastAgent && s.blocks[i]!.who === 'agent'
  const selectable = s.blocks.flatMap((b, i) =>
    b.who !== 'agent' ? []
    : isOld(i) ? [{ key: `b${i}` }, ...(open.has(`b${i}`) ? b.items.filter((x) => x.k !== 'text') : [])]
    : b.items.filter((x) => x.k !== 'text'),
  ) as { key: string }[]

  useKeyboard((k) => {
    if (!active || !focused) return
    if (k.name === 'pageup' || k.name === 'pagedown') return scroll.current?.scrollBy(k.name === 'pageup' ? -10 : 10)
    if (!logFocus) return
    if (k.name === 't') return setShowThinking((v) => !v)
    const cur = selectable[logSel]
    if (k.name === 'return' && cur) return setOpen((o) => { const x = new Set(o); x.has(cur.key) ? x.delete(cur.key) : x.add(cur.key); return x })
    const d = k.name === 'up' || k.name === 'k' ? -1 : k.name === 'down' || k.name === 'j' ? 1 : 0
    if (d && selectable.length) {
      const i = Math.max(0, Math.min(selectable.length - 1, logSel + d))
      setLogSel(i)
      scroll.current?.scrollChildIntoView(selectable[i]!.key, { align: 'nearest' })
    }
  })

  const color = accent(t.harness)
  const waiting = s.status === 'waiting'
  const selKey = focused && logFocus ? selectable[logSel]?.key : undefined
  // Small tiles show the recent end of the conversation only.
  const skip = full ? 0 : Math.max(0, s.blocks.length - 12)
  const blocks = s.blocks.slice(skip)
  const w = width - 6
  // OpenTUI drops a title wider than the box, so narrow tiles get a clipped one.
  const title = ` ${full ? '' : `${n} `}${t.harness.label}  ${glyph[s.status]} ${s.status}${s.mode ? `  ⏵ ${s.mode}` : ''}  ${shortPath(s.session.cwd)} `
  return (
    <box
      visible={!hidden} flexGrow={1} flexBasis={0} flexDirection="column"
      border borderStyle="rounded"
      borderColor={waiting ? theme.warn : focused || full ? color : theme.subtle}
      title={title.length > width - 6 ? title.slice(0, Math.max(0, width - 8)) + '… ' : title}
      titleColor={waiting ? theme.warn : color}
    >
      <scrollbox ref={scroll} stickyScroll stickyStart="bottom" flexGrow={1} paddingX={1} paddingTop={full ? 1 : 0}>
        {!blocks.length && <text fg={theme.muted}>Ask {t.harness.label} anything about {shortPath(s.session.cwd)}</text>}
        {blocks.map((b, bi) => {
          const i = bi + skip
          return b.who === 'you' ? (
            <Rail key={i} color={theme.muted} label="you"><text>{b.text}</text></Rail>
          ) : b.who === 'error' ? (
            <Rail key={i} color={theme.danger} label="error"><text fg={theme.danger}>{b.message}</text></Rail>
          ) : isOld(i) && !open.has(`b${i}`) ? (
            <box key={i} id={`b${i}`} maxWidth={110} paddingLeft={2} marginBottom={1}>
              <text fg={theme.muted} wrapMode="none">
                <span fg={selKey === `b${i}` ? color : undefined}>▸ </span>{t.harness.label} · {preview(b.items)}
              </text>
            </box>
          ) : (
            <Rail key={i} color={color} label={t.harness.label}>
              {isOld(i) && <box id={`b${i}`}><text fg={theme.muted}>▾ collapse</text></box>}
              {b.items.map((it, j) =>
                it.k === 'text' ? <Markdown key={j} text={it.text} streaming={it.open} />
                : it.k === 'thinking' ? <box key={it.key} id={it.key}><ThinkingLine text={it.text} open={showThinking || open.has(it.key)} selected={selKey === it.key} /></box>
                : <box key={it.key} id={it.key}><ToolLine t={it} open={open.has(it.key)} selected={selKey === it.key} width={w} /></box>,
              )}
            </Rail>
          )
        })}
      </scrollbox>
      {s.pending && <PermissionPrompt req={s.pending} color={color} />}
    </box>
  )
}
