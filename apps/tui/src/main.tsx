#!/usr/bin/env bun
import { useState } from 'react'
import { createCliRenderer } from '@opentui/core'
import { createRoot, useKeyboard, useRenderer } from '@opentui/react'
import { ensureDaemon } from '@crewd/client'
import type { Nav, Route } from './nav.ts'
import { Chat } from './screens/Chat.tsx'
import { Help } from './screens/Help.tsx'
import { Home } from './screens/Home.tsx'
import { Mcp } from './screens/Mcp.tsx'
import { NewSession } from './screens/NewSession.tsx'
import { Sessions } from './screens/Sessions.tsx'

export function App({ launchCwd, first = { name: 'home' } }: { launchCwd: string; first?: Route }) {
  const renderer = useRenderer()
  const [stack, setStack] = useState<Route[]>([first])
  const [help, setHelp] = useState(false)
  const nav: Nav = {
    push: (r) => setStack((s) => [...s, r]),
    replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
    pop: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    help: () => setHelp(true),
    quit: () => { renderer.destroy(); process.exit(0) },
    launchCwd,
  }
  const r = stack.at(-1)!
  // Keyed by depth so pushing the same screen type remounts it with fresh state.
  const key = stack.length
  if (help) return <Help onClose={() => setHelp(false)} />
  if (r.name === 'sessions') return <Sessions key={key} nav={nav} harness={r.harness} />
  if (r.name === 'new') return <NewSession key={key} nav={nav} harness={r.harness} />
  if (r.name === 'chat') return <Chat key={key} nav={nav} session={r.session} harness={r.harness} />
  if (r.name === 'mcp') return <Mcp key={key} nav={nav} />
  return <Home key={key} nav={nav} />
}

function Fatal({ message }: { message: string }) {
  const renderer = useRenderer()
  useKeyboard(() => { renderer.destroy(); process.exit(1) })
  return (
    <box flexDirection="column" padding={1}>
      <text fg="#FF6B6B">crewd could not start its background daemon.</text>
      <text>{message}</text>
      <text fg="#8A8F98">Press any key to exit.</text>
    </box>
  )
}

if (import.meta.main) {
  const launchCwd = process.cwd()
  let failure = ''
  try {
    await ensureDaemon()
  } catch (e: any) {
    failure = e.message
  }
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(failure ? <Fatal message={failure} /> : <App launchCwd={launchCwd} />)
}
