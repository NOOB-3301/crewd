import { useReducer, useRef, useState } from 'react'
import { useKeyboard, useTerminalDimensions } from '@opentui/react'
import { join } from 'node:path'
import type { ImageRef, SessionMeta } from '@crewd/protocol'
import { crewdHome } from '@crewd/client'
import type { Nav, Tile as TileT } from '../nav.ts'
import type { SessionState } from '../useSession.ts'
import { Palette, filterCommands } from '../ui/Palette.tsx'
import { PromptInput } from '../ui/PromptInput.tsx'
import { permissionChoice } from '../ui/PermissionPrompt.tsx'
import { StatusBar } from '../ui/StatusBar.tsx'
import { Tile } from '../ui/Tile.tsx'
import { accent, theme } from '../ui/theme.ts'

/** Columns for n tiles: 1, 2 side by side, 2x2, 3x2, then 3 wide. */
export const columns = (n: number) => (n <= 1 ? 1 : n <= 4 ? 2 : 3)

/** The open sessions: tiles (or the focused one full screen), one input that sends to the focused tile. */
export function Wall({ nav, tiles, focus, setFocus, full, setFull, active, onClose, onLive }: {
  nav: Nav; tiles: TileT[]; focus: number; setFocus: (i: number) => void; full: boolean; setFull: (f: boolean) => void
  active: boolean; onClose: (i: number) => void; onLive: (key: string, s: SessionMeta) => void
}) {
  const { width } = useTerminalDimensions()
  const cur = useRef<SessionState | undefined>(undefined)
  const [, changed] = useReducer((x: number) => x + 1, 0)
  const [input, setInput] = useState('')
  const [palSel, setPalSel] = useState(0)
  const [logFocus, setLogFocus] = useState(false)
  // /permissions or /model picker: selected row, and whether bypassPermissions is waiting for its confirm.
  const [picker, setPicker] = useState<{ kind: 'mode' | 'model'; sel: number; confirm: boolean } | null>(null)

  const s = cur.current
  const modes = s?.modes ?? []
  const choices = picker?.kind === 'model' ? (s?.models ?? []) : modes
  const current = picker?.kind === 'model' ? s?.model : s?.mode
  const pickStart = picker ? Math.max(0, Math.min(picker.sel - 4, choices.length - 10)) : 0
  const typing = active && !logFocus && !picker && !s?.pending
  const paletteOpen = typing && /^\/\S*$/.test(input)
  const palItems = paletteOpen ? filterCommands(s?.commands ?? [], input) : []

  function runCommand(c: { name: string } | undefined) {
    const cmd = c?.name
    if (cmd === 'new') return nav.push({ name: 'new' })
    if (cmd === 'sessions') return nav.home()
    if (cmd === 'stop') { setInput(''); return s?.stop() }
    if (cmd === 'permissions' || cmd === 'mode') {
      setInput('')
      return setPicker({ kind: 'mode', sel: Math.max(0, modes.findIndex((m) => m.id === s?.mode)), confirm: false })
    }
    if (cmd === 'model') {
      setInput('')
      const models = s?.models ?? []
      if (!models.length) return s?.setErr(`${s.harness.label} has not reported any models for this session yet. Type /model <id> to set one.`)
      return setPicker({ kind: 'model', sel: Math.max(0, models.findIndex((m) => m.id === s?.model)), confirm: false })
    }
    if (cmd) setInput(`/${cmd} `)
  }

  async function submit(text: string, images: ImageRef[]) {
    if (paletteOpen) return runCommand(palItems[palSel])
    if ((!text && !images.length) || !s) return
    setInput('')
    const typedModel = /^\/model\s+(\S+)\s*$/.exec(text)?.[1]
    if (typedModel && !images.length) return void s.setModel(typedModel)
    // shortcut: a failed send restores the text but drops the image chips; keep chips on failure if it bites.
    if (!(await s.send(text, images))) setInput(text)
  }

  useKeyboard((k) => {
    if (!active) return
    const eat = () => k.preventDefault() // keeps the input from also acting on keys used here (ctrl+w deletes a word there)
    const n = tiles.length
    if (k.ctrl && k.name === 'o') { eat(); return nav.home() }
    if (k.ctrl && k.name === 'n') { eat(); return nav.push({ name: 'new' }) }
    if (k.ctrl && k.name === 'w') { eat(); return onClose(focus) }
    if (k.ctrl && k.name === 'f') { eat(); return setFull(!full) }
    if ((k.meta || k.option) && /^[1-9]$/.test(k.name)) { eat(); return Number(k.name) <= n && setFocus(Number(k.name) - 1) }
    if (k.ctrl && (k.name === 'left' || k.name === 'right')) { eat(); return setFocus((focus + (k.name === 'right' ? 1 : n - 1)) % n) }
    if ((k.name === 'tab' && k.shift) || (k.ctrl && k.name === 't')) { eat(); return void s?.cycleMode() }
    if (k.name === 'tab') { eat(); return setLogFocus((f) => !f) }
    if (!s) return
    if (picker) {
      eat()
      if (k.name === 'escape') return setPicker(null)
      if (k.name === 'up' || k.name === 'down') return setPicker({ ...picker, sel: Math.max(0, Math.min(choices.length - 1, picker.sel + (k.name === 'down' ? 1 : -1))), confirm: false })
      const m = choices[picker.sel]
      if (k.name === 'return' && m) {
        if (picker.kind === 'model') { setPicker(null); return void s.setModel(m.id) }
        if (m.id === 'bypassPermissions' && !picker.confirm) return setPicker({ ...picker, confirm: true })
        setPicker(null)
        return void s.setMode(m.id)
      }
      return
    }
    if (s.pending) {
      const id = permissionChoice(k, s.pending)
      if (id) { eat(); void s.answer(s.pending.requestId, id) }
      return
    }
    if (k.name === 'escape') {
      if (paletteOpen) return setInput('')
      if (s.status === 'running') return void s.stop()
      if (logFocus) return setLogFocus(false)
      return
    }
    if (paletteOpen && (k.name === 'up' || k.name === 'down')) {
      return setPalSel((i) => Math.max(0, Math.min(palItems.length - 1, i + (k.name === 'down' ? 1 : -1))))
    }
    if (logFocus && k.sequence === '?') return nav.help()
  })

  const cols = columns(tiles.length)
  const rows = Array.from({ length: Math.ceil(tiles.length / cols) }, (_, r) => tiles.slice(r * cols, r * cols + cols))
  const color = accent(s?.harness)
  const label = s?.harness.label ?? ''
  const tileW = full ? width : Math.floor(width / cols)
  return (
    <box visible={active} flexDirection="column" height="100%">
      <box flexDirection="column" flexGrow={1}>
        {rows.map((row, r) => (
          <box key={r} flexDirection="row" flexGrow={1} flexBasis={0} visible={!full || Math.floor(focus / cols) === r}>
            {row.map((t, c) => {
              const i = r * cols + c
              return (
                <Tile
                  key={t.key} t={t} n={i + 1} focused={i === focus} full={full} hidden={full && i !== focus}
                  logFocus={logFocus} active={active} width={tileW} report={cur} changed={changed}
                  onLive={(x) => onLive(t.key, x)}
                />
              )
            })}
          </box>
        ))}
      </box>
      {s?.err && <text fg={theme.danger} paddingX={1} flexShrink={0}>{s.err}</text>}
      {picker && (
        <box flexDirection="column" flexShrink={0} paddingX={1}>
          <text fg={theme.muted}>{label} {picker.kind} · ↑↓ pick · enter switch · esc cancel</text>
          {/* model lists can be long: show 10 rows around the selection */}
          {choices.slice(pickStart, pickStart + 10).map((m, j) => { const i = pickStart + j; return (
            <text key={m.id} wrapMode="none">
              <span fg={color}>{i === picker.sel ? '› ' : '  '}{m.id === current ? '⏵ ' : '  '}</span>
              {i === picker.sel ? <b>{m.label}</b> : m.label}
              <span fg={theme.muted}>  {m.description ?? ''}</span>
            </text>
          ) })}
          {picker.confirm && <text fg={theme.danger}>bypassPermissions runs every tool without asking. Press enter again to switch, esc to cancel.</text>}
        </box>
      )}
      {paletteOpen && <Palette items={palItems} selected={Math.min(palSel, palItems.length - 1)} color={color} vendor={label} width={width - 4} />}
      <box border={['top']} borderColor={theme.muted} paddingX={1} flexShrink={0}>
        <PromptInput
          focused={typing}
          color={color}
          value={input}
          placeholder={s?.pending ? 'answer the permission request above' : `ask ${label}, or / for commands`}
          imageDir={join(crewdHome, 'tmp')}
          onChange={(v) => {
            setInput(v)
            setPalSel(0)
            if (v.startsWith('/')) s?.goLive().catch((e) => s.setErr(`Could not load ${label}'s commands: ${e.message}`))
          }}
          onSubmit={submit}
        />
      </box>
      <StatusBar
        state={s?.status ?? 'idle'}
        tokens={s?.tokens ?? 0}
        cost={s?.cost ?? 0}
        mode={s?.mode}
        model={s?.model}
        color={color}
        hints={s?.pending
          ? [['y', 'allow'], ['a', 'always'], ['n', 'deny'], ['alt+1-9', 'tile']]
          : logFocus
            ? [['↑↓', 'pick'], ['enter', 'open/full'], ['e', 'all tools'], ['t', 'thinking'], ['tab', 'input']]
            : [['tab', 'tools'], ['esc', 'stop'], ['ctrl+o', 'list'], ['ctrl+n', 'new'], ['ctrl+f', full ? 'tiles' : 'full'], ['ctrl+w', 'close'], ['shift+tab', 'mode'], ['/', 'commands']]}
      />
    </box>
  )
}
