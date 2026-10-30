import type { Judgment } from '../gate/machine.ts'

// ALLOW only, module memory only: a cached verdict never reaches disk (R23, D2).
export const CACHE_TTL_MS = 60_000

const entries = new Map<string, number>()
const inflight = new Map<string, Promise<Judgment>>()

export function cacheKey(host: string, revision: string | null, tool: string, argsHash: string): string {
  return JSON.stringify([host, revision, tool, argsHash])
}

export function cacheGet(key: string, now: number): boolean {
  const expiresAt = entries.get(key)
  if (expiresAt === undefined) return false
  if (expiresAt <= now) {
    entries.delete(key)
    return false
  }
  return true
}

export function cachePut(key: string, now: number): void {
  entries.set(key, now + CACHE_TTL_MS)
}

// A new policy-index revision empties the cache: no entry keyed under the old one is reachable again (R23).
export function cacheClear(): void {
  entries.clear()
}

export function coalesce(key: string, run: () => Promise<Judgment>): Promise<Judgment> {
  const pending = inflight.get(key)
  if (pending) return pending
  const started = run().finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, started)
  return started
}
