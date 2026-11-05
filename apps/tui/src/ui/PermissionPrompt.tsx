import type { PermissionOption } from '@crewd/protocol'
import type { Pending } from '@crewd/shared'
import { mainArg } from './ToolLine.tsx'
import { theme } from './theme.ts'

const keyFor: Record<PermissionOption['kind'], string> = { allow: '1/y', always: '2/a', deny: '3/n' }

/** The option a key picks: 1/y first allow, 2/a always, 3/n or esc deny. */
export function permissionChoice(k: { name: string }, req: Pending): string | undefined {
  const kind = ['1', 'y'].includes(k.name) ? 'allow' : ['2', 'a'].includes(k.name) ? 'always' : ['3', 'n', 'escape'].includes(k.name) ? 'deny' : undefined
  return kind && req.options.find((o) => o.kind === kind)?.id
}

export function PermissionPrompt({ req, color }: { req: Pending; color: string }) {
  const detail = req.title || mainArg(req.input)
  const keyed = new Set<string>()
  return (
    <box border borderStyle="heavy" borderColor={color} flexDirection="column" paddingX={1} flexShrink={0}>
      <text wrapMode="none"><span fg={color}><b>◆ {req.tool}</b></span><span fg={theme.muted}> wants permission</span></text>
      {detail && <text fg={theme.muted}>{detail.length > 400 ? detail.slice(0, 399) + '…' : detail}</text>}
      <text wrapMode="none">
        {req.options.map((o) => {
          const k = keyed.has(o.kind) ? '' : (keyed.add(o.kind), keyFor[o.kind])
          return <span key={o.id}><span fg={o.kind === 'deny' ? theme.danger : color}>{k && `${k} `}</span>{o.label}{'   '}</span>
        })}
      </text>
    </box>
  )
}
