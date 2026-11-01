import { useState } from 'react'
import { useAnimationTick } from '@opentui/react'
import type { SessionStatus } from '@crewd/protocol'
import { KeyHints } from './KeyHints.tsx'
import { theme } from './theme.ts'

const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

export function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** Key hints on the left; spinner (only while running), mode, model, tokens and cost on the right. */
export function StatusBar({ hints, state, tokens, cost, mode, model, color }: {
  hints: [string, string][]; state: SessionStatus; tokens: number; cost: number; mode?: string; model?: string; color?: string
}) {
  const [f, setF] = useState(0)
  useAnimationTick(state === 'running' ? 12 : undefined, () => setF((x) => (x + 1) % frames.length))
  return (
    <box flexDirection="row" justifyContent="space-between" height={1}>
      <KeyHints hints={hints} />
      <text fg={theme.muted} flexShrink={0} wrapMode="none">
        {state === 'running' ? `${frames[f]}  ` : ''}
        {state === 'waiting' ? <span fg={theme.warn}>◆ waiting  </span> : ''}
        {mode ? <span fg={color}>⏵ {mode}  </span> : ''}
        {model ? `${model}  ` : ''}
        {tokens ? `${fmtTokens(tokens)} tok  ` : ''}
        {cost ? `$${cost.toFixed(2)} ` : ''}
      </text>
    </box>
  )
}
