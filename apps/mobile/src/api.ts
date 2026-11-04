// crewd's HTTP API over the saved server address + bearer token.
// The token is never logged, rendered or put in a URL: it only ever goes in the Authorization header.
import { fetch } from 'expo/fetch'
import * as SecureStore from 'expo-secure-store'
import { router } from 'expo-router'
import {
  routes,
  type CreateSessionBody,
  type HarnessInfo,
  type LogLine,
  type ModeId,
  type ModelList,
  type ProjectInfo,
  type SessionMeta,
} from '@crewd/protocol'

export type Credentials = { server: string; token: string }

const SERVER_KEY = 'crewd.server'
const TOKEN_KEY = 'crewd.token'

/** Cached so every request can be built synchronously; filled by loadCredentials at boot. */
let saved: Credentials | null = null

export const credentials = () => saved

/** A pasted token usually carries a trailing newline, and the daemon compares bytes. */
function normalize(c: Credentials): Credentials {
  return { server: c.server.trim().replace(/\/+$/, ''), token: c.token.trim() }
}

export async function loadCredentials(): Promise<Credentials | null> {
  const [server, token] = await Promise.all([SecureStore.getItemAsync(SERVER_KEY), SecureStore.getItemAsync(TOKEN_KEY)])
  saved = server && token ? normalize({ server, token }) : null
  return saved
}

export async function saveCredentials(c: Credentials): Promise<Credentials> {
  saved = normalize(c)
  await Promise.all([SecureStore.setItemAsync(SERVER_KEY, saved.server), SecureStore.setItemAsync(TOKEN_KEY, saved.token)])
  return saved
}

export const url = (path: string, c: Credentials) => c.server + path

export function authHeaders(c: Credentials): Record<string, string> {
  return {
    authorization: `Bearer ${c.token.trim()}`,
    // ngrok's free tier answers app-like clients with an interstitial HTML page instead of JSON (plan Phase 3b)
    'ngrok-skip-browser-warning': '1',
  }
}

/** The Mac was not reachable at all (off, asleep, no network). The token is still good, so keep it. */
export class Unreachable extends Error {}

/** crewd answered with a non-2xx. 401 means the saved token no longer works. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export const errorMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A rejected token is not recoverable in place: collect a new one. */
export function goToConnect() {
  // A 401 can only come after the navigator is up, but keep the throw path cheap if the app is mid-teardown.
  try {
    router.replace('/connect')
  } catch {}
}

type Init = {
  method?: 'POST' | 'DELETE'
  body?: unknown
  /** use these instead of the saved pair, for the Connect screen's test */
  auth?: Credentials
  /** a 401 during the Connect screen's own test must show inline instead of re-entering it */
  on401?: 'connect' | 'throw'
}

async function request<T>(path: string, init: Init = {}): Promise<T> {
  const creds = init.auth ?? saved
  if (!creds) throw new Unreachable('No Mac configured yet.')
  const headers: Record<string, string> = { ...authHeaders(creds), ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) }
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(url(path, creds), {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    throw new Unreachable(`Can't reach your Mac at ${creds.server}.`)
  }
  const data: any = await res.json().catch(() => null)
  if (res.status === 401) {
    if (init.on401 === 'throw') throw new ApiError(401, 'That token was rejected.')
    goToConnect()
    throw new ApiError(401, 'The saved token was rejected.')
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `crewd answered ${res.status}.`)
  return data as T
}

export const testConnection = (c: Credentials) =>
  request<HarnessInfo[]>(routes.harnesses, { auth: c, on401: 'throw' })

export const listSessions = () => request<SessionMeta[]>(routes.sessions)

/** GET /sessions/:id/history exists only for a session id, so the header's title/harness come from the list. */
export async function sessionMeta(id: string): Promise<SessionMeta> {
  const list = await request<SessionMeta[]>(routes.sessions)
  const found = list.find((s) => s.id === id)
  if (!found) throw new ApiError(404, `crewd has no session ${id}.`)
  return found
}

export const history = (id: string, turns: number) => request<LogLine[]>(`${routes.history(id)}?turns=${turns}`)
export const send = (id: string, text: string) => request<unknown>(routes.messages(id), { method: 'POST', body: { text } })
export const answer = (id: string, requestId: string, optionId: string) =>
  request<unknown>(routes.permission(id, requestId), { method: 'POST', body: { optionId } })
export const interrupt = (id: string) => request<unknown>(routes.interrupt(id), { method: 'POST' })

/** Installed harnesses with their labels and colours, for the new-session picker. */
export const harnesses = () => request<HarnessInfo[]>(routes.harnesses)
/** May start an agent process to ask, so it can take seconds; results are cached 10 minutes server-side. */
export const harnessModels = (id: string, cwd: string) =>
  request<ModelList>(`${routes.harnessModels(id)}?cwd=${encodeURIComponent(cwd)}`)
/** Folders crewd has sessions in; the phone cannot browse the Mac's disk. */
export const projects = () => request<ProjectInfo[]>(routes.projects)
/** Waits for the agent to be ready, so callers show a spinner. */
export const createSession = (body: CreateSessionBody) => request<SessionMeta>(routes.sessions, { method: 'POST', body })
export const setMode = (id: string, mode: ModeId) => request<SessionMeta>(routes.mode(id), { method: 'POST', body: { mode } })
export const setModel = (id: string, model: string) => request<SessionMeta>(routes.model(id), { method: 'POST', body: { model } })
