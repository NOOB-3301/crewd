import type { ReactNode } from 'react'

const bar = '▌'
const railChars = {
  topLeft: bar, bottomLeft: bar, vertical: bar, topRight: ' ', bottomRight: ' ', horizontal: ' ',
  topT: ' ', bottomT: ' ', leftT: bar, rightT: ' ', cross: ' ',
}

/** The crew rail: a 1-column colored bar beside everything one speaker wrote. */
export function Rail({ color, label, children }: { color: string; label: string; children: ReactNode }) {
  return (
    <box border={['left']} borderColor={color} customBorderChars={railChars} flexDirection="column" marginBottom={1} paddingLeft={1}>
      <text fg={color}><b>{label}</b></text>
      {children}
    </box>
  )
}
