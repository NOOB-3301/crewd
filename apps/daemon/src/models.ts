import type { Harness, ModelInfo, ModelList } from '@crewd/protocol'
import * as log from './log.ts'
import * as registry from './registry.ts'

// Listing models starts an agent process (seconds), so lists are kept per harness + cwd.
const TTL = 10 * 60_000
const cache = new Map<string, { at: number; v: Promise<ModelList> }>()
const key = (h: Harness, cwd: string) => `${h.id}\0${cwd}`

/** Cached list; concurrent callers share one probe. Failures come back as { models: [], error } and are not kept. */
export function list(h: Harness, cwd: string, refresh = false): Promise<ModelList> {
  const k = key(h, cwd)
  const hit = cache.get(k)
  if (hit && !refresh && Date.now() - hit.at < TTL) return hit.v
  const v = registry
    .classFor(h)
    .listModels(h, cwd)
    .catch((err): ModelList => {
      if (cache.get(k)?.v === v) cache.delete(k)
      log.daemonLog('model list failed', h.id, cwd, err)
      return { models: [], error: String(err?.message ?? err) }
    })
  cache.set(k, { at: Date.now(), v })
  return v
}

/** A live session reported its list: refresh the cache for free, keeping the probed default. */
export function remember(h: Harness, cwd: string, models: ModelInfo[]) {
  if (!models.length) return
  const k = key(h, cwd)
  const prev = cache.get(k)?.v ?? Promise.resolve<ModelList>({ models: [] })
  cache.set(k, { at: Date.now(), v: prev.then((p) => ({ models, current: p.current })) })
}
