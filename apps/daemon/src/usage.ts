import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { harnesses } from './registry.ts'
import type { Usage, UsageMeter } from '@crewd/protocol'

const run = promisify(execFile)
const DAY = 86_400_000

/** Claude Code's OAuth login: macOS keychain, else ~/.claude/.credentials.json. Only read to make the one usage request. */
async function claudeLogin(): Promise<{ accessToken: string; subscriptionType?: string; expiresAt?: number }> {
  let raw = ''
  if (process.platform === 'darwin') {
    raw = await run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']).then((r) => r.stdout, () => '')
  }
  if (!raw) raw = (() => { try { return readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8') } catch { return '' } })()
  const login = (() => { try { return JSON.parse(raw).claudeAiOauth } catch { return undefined } })()
  if (!login?.accessToken) throw new Error('No Claude login found. Run `claude` once and sign in.')
  return login
}

const dayName = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'long' })

/** "today", "tonight", "tomorrow night", "Saturday afternoon" ... */
export function when(t: Date, now: Date): string {
  const h = t.getHours()
  const part = h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'
  const days = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY)
  if (days <= 0) return part === 'night' || part === 'evening' ? 'tonight' : `this ${part}`
  return `${days === 1 ? 'tomorrow' : dayName(t)} ${part}`
}

/** Headline from the weekly window: when the current pace would hit 100% and whether the reset comes first. */
export function pace(percent: number, resetsAt: string, now = new Date()): string {
  const end = Date.parse(resetsAt)
  const start = end - 7 * DAY
  const elapsed = now.getTime() - start
  if (percent >= 100) return `You've hit your weekly limit. It resets ${dayName(new Date(end))}.`
  if (percent <= 0 || elapsed <= 0) return "You're well within your limit."
  const hitsAt = start + (elapsed * 100) / percent
  if (hitsAt >= end) return "You're on pace to stay within your limit."
  return `Heads up. At this pace you'll run out ${when(new Date(hitsAt), now)}, before ${dayName(new Date(end))}'s reset.`
}

async function claude(): Promise<Usage> {
  const login = await claudeLogin()
  if (login.expiresAt && login.expiresAt < Date.now()) throw new Error('Your Claude login expired. Open `claude` once to refresh it.')
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${login.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Claude usage answered ${res.status}`)
  const d: any = await res.json()
  // Anthropic reports only percentages, never token or dollar totals, for subscription plans.
  const pct = (label: string, w: { utilization: number; resets_at: string } | undefined): UsageMeter[] =>
    w ? [{ label, unit: 'percent', used: w.utilization, remaining: 100 - w.utilization, total: 100, percent: w.utilization, resetsAt: w.resets_at }] : []
  const meters = [...pct('Current session (5h)', d.five_hour), ...pct('Weekly', d.seven_day)]
  const type: string | undefined = login.subscriptionType
  return {
    harness: 'claude',
    label: 'Claude Code',
    source: 'account',
    plan: type && type[0]!.toUpperCase() + type.slice(1),
    message: d.seven_day ? pace(d.seven_day.utilization, d.seven_day.resets_at) : undefined,
    meters,
    breakdown: d.seven_day_breakdown?.rows?.map((r: any) => ({ label: r.display_name, percent: r.percent })),
  }
}

type QoderUsage = {
  userType?: string
  totalUsagePercentage?: number
  upgradeUrl?: string
  isQuotaExceeded?: boolean
  userQuota?: { total?: number; used?: number; remaining?: number; percentage?: number; unit?: string }
  addOnQuota?: { total?: number; used?: number; percentage?: number }
}

/** Qoder: the SDK's getUsageInfo() on a short-lived query. No chat message is sent. */
async function qoder(): Promise<Usage> {
  // Optional dependency, loaded only when asked, as in orchestrators/sdk/qoder.ts.
  const sdk: any = await import('@qoder-ai/qoder-agent-sdk').catch(() => {
    throw new Error('Qoder SDK not installed in the daemon.')
  })
  const auth = process.env.QODER_PERSONAL_ACCESS_TOKEN ? sdk.accessTokenFromEnv() : sdk.qodercliAuth?.()
  async function* idle() {
    await new Promise(() => {}) // never yields: the query stays open only until we read usage
  }
  const q = sdk.query({ prompt: idle(), options: { cwd: process.cwd(), auth } })
  try {
    const d: QoderUsage | null = await Promise.race([
      q.getUsageInfo(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Qoder usage timed out after 30s')), 30_000)),
    ])
    if (!d) throw new Error('Qoder did not return usage. Run `qodercli login` and try again.')
    const meter = (label: string, q: { total?: number; used?: number; remaining?: number; percentage?: number } | undefined): UsageMeter[] =>
      q ? [{ label, unit: 'credits', used: q.used, remaining: q.remaining, total: q.total, percent: q.percentage }] : []
    const meters = [...meter('Credits', d.userQuota), ...meter('Add-on credits', d.addOnQuota?.total ? d.addOnQuota : undefined)]
    const message = d.isQuotaExceeded
      ? `You're out of Qoder credits.${d.upgradeUrl ? ` Upgrade: ${d.upgradeUrl}` : ''}`
      : `${Math.round(d.totalUsagePercentage ?? 0)}% of your Qoder credits used.`
    return {
      harness: 'qoder',
      label: 'Qoder',
      source: 'account',
      plan: d.userType === 'personal_standard' ? 'Personal' : d.userType,
      message,
      meters,
    }
  } finally {
    await q.return?.(undefined)
  }
}

const SUFFIX: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 }
/** "51.2M" -> 51_200_000, "$0.00" -> 0 */
const num = (v: string) => {
  const n = parseFloat(v.replace(/[$,]/g, ''))
  return n * (SUFFIX[v.slice(-1).toUpperCase()] ?? 1)
}

/** `opencode stats` prints box tables ("│Input   2.0M │"); read the label/value rows. Values are rounded by OpenCode. */
async function opencodeStats(days?: number): Promise<Map<string, number>> {
  const { stdout } = await run('opencode', ['stats', ...(days ? ['--days', String(days)] : [])], { timeout: 30_000, maxBuffer: 1 << 20 })
  const rows = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const m = /^│\s*([A-Za-z][A-Za-z /]*?)\s{2,}(\$?[\d.,]+[KMB]?)\s*│$/.exec(line)
    if (m) rows.set(m[1]!, num(m[2]!))
  }
  return rows
}

/** OpenCode has no account quota: these are totals counted on this machine. */
async function opencode(): Promise<Usage> {
  const [week, all] = await Promise.all([opencodeStats(7), opencodeStats()])
  const meters: UsageMeter[] = []
  for (const [when, r] of [['7 days', week], ['all time', all]] as const) {
    for (const [key, label] of [['Input', 'Input tokens'], ['Output', 'Output tokens'], ['Cache Read', 'Cache read tokens']] as const)
      if (r.has(key)) meters.push({ label: `${label} (${when})`, unit: 'tokens', used: r.get(key) })
    if (r.has('Total Cost')) meters.push({ label: `Cost (${when})`, unit: 'usd', used: r.get('Total Cost') })
    if (r.has('Sessions')) meters.push({ label: `Sessions (${when})`, unit: 'count', used: r.get('Sessions') })
  }
  return { harness: 'opencode', label: 'OpenCode', source: 'local', message: 'Local totals from this machine. OpenCode has no account quota to report.', meters }
}

const providers: Record<string, () => Promise<Usage>> = { claude, qoder, opencode }

/** One entry per enabled harness, fetched fresh on every call. A provider that fails reports `error` and the rest still load. */
export async function all(): Promise<Usage[]> {
  return Promise.all(
    harnesses().filter((h) => !h.disabled).map(async (h): Promise<Usage> => {
      const fetchUsage = providers[h.id]
      if (!fetchUsage) return { harness: h.id, label: h.label, source: 'none', message: `${h.label} does not expose usage.`, meters: [] }
      return fetchUsage().catch((e): Usage => ({ harness: h.id, label: h.label, source: 'none', meters: [], error: e.message }))
    }),
  )
}
