import { theme } from './theme.ts'

/** One-line hint bar: [key, action] pairs, keys in default color, actions muted. */
export function KeyHints({ hints }: { hints: [string, string][] }) {
  return (
    <text wrapMode="none" flexShrink={1}>
      {hints.map(([k, a], i) => (
        <span key={i}>
          {i ? '   ' : ' '}
          {k}
          <span fg={theme.muted}> {a}</span>
        </span>
      ))}
    </text>
  )
}
