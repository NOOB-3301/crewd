import { useEffect, useState } from 'react'
import { useKeyboard } from '@opentui/react'
import type { McpServer } from '@crewd/protocol'
import * as client from '@crewd/client'
import { move, type Nav } from '../nav.ts'
import { KeyHints } from '../ui/KeyHints.tsx'
import { pad, theme } from '../ui/theme.ts'

const steps = ['Name', 'Command', 'Arguments, separated by spaces (optional)'] as const

export function Mcp({ nav }: { nav: Nav }) {
  const [list, setList] = useState<McpServer[]>([])
  const [sel, setSel] = useState(0)
  const [err, setErr] = useState('')
  // While adding: the answers so far, one per step.
  const [adding, setAdding] = useState<string[] | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => { client.getMcp().then(setList).catch((e) => setErr(e.message)) }, [])

  async function save(next: McpServer[]) {
    setList(next)
    try {
      await client.putMcp(next)
      setErr('')
    } catch (e: any) {
      setErr(`Could not save: ${e.message}. Your change is shown but not stored; try again.`)
    }
  }

  function submit(v: string) {
    if (!adding) return
    const answers = [...adding, v.trim()]
    if (answers.length === 1 && !answers[0]) return setErr('Give the server a name.')
    if (answers.length === 2 && !answers[1]) return setErr('Give the command that starts the server, for example npx.')
    setErr('')
    setDraft('')
    if (answers.length < steps.length) return setAdding(answers)
    setAdding(null)
    const [name, command, args] = answers as [string, string, string]
    save([...list.filter((s) => s.name !== name), { name, command, args: args ? args.split(/\s+/) : [], enabled: true }])
  }

  useKeyboard((k) => {
    if (adding) {
      if (k.name === 'escape') { setAdding(null); setDraft('') }
      return
    }
    const m = move(k, sel, list.length)
    if (m !== undefined) return setSel(m)
    if (k.name === 'escape') return nav.pop()
    if (k.name === 'q') return nav.quit()
    if (k.sequence === '?') return nav.help()
    if (k.name === 'a') return setAdding([])
    if (k.name === 'space' && list[sel]) {
      save(list.map((s, i) => (i === sel ? { ...s, enabled: s.enabled === false } : s)))
    }
  })

  return (
    <box flexDirection="column" height="100%">
      <box paddingX={1} paddingBottom={1}>
        <text><span fg={theme.muted}>crewd  </span><b>MCP servers</b></text>
      </box>
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        {!list.length && !adding && <text fg={theme.muted}>  No MCP servers yet. Press a to add one.</text>}
        {list.map((s, i) => (
          <text key={s.name}>
            {i === sel && !adding ? '› ' : '  '}
            <span fg={s.enabled === false ? theme.muted : theme.ok}>{s.enabled === false ? '[ ] ' : '[x] '}</span>
            {i === sel ? <b>{pad(s.name, 20)}</b> : pad(s.name, 20)}
            <span fg={theme.muted}> {[s.command, ...(s.args ?? [])].join(' ')}</span>
          </text>
        ))}
        {adding && (
          <box flexDirection="column" marginTop={1} paddingLeft={2}>
            {adding.map((a, i) => <text key={i} fg={theme.muted}>{steps[i]}: {a || '—'}</text>)}
            <text>{steps[adding.length]}</text>
            <box flexDirection="row">
              <text fg={theme.ok}>› </text>
              <input focused value={draft} onInput={setDraft} onSubmit={() => submit(draft)}
                focusedBackgroundColor="transparent" backgroundColor="transparent" flexGrow={1} />
            </box>
          </box>
        )}
      </box>
      {err && <text fg={theme.danger}> {err}</text>}
      <KeyHints hints={adding
        ? [['enter', 'next'], ['esc', 'cancel']]
        : [['space', 'toggle'], ['a', 'add'], ['esc', 'back'], ['?', 'keys'], ['q', 'quit']]} />
    </box>
  )
}
