import type { HttpResponse } from 'claude-code'
import { cacheClear } from '../verdict/cache.ts'
import type { JudgeIo } from '../verdict/source.ts'
import type { PostureInput } from '../vendor/claude/posture-context.ts'

export const INDEX_PATH = '/api/arbiter/policy-index'
export const INDEX_EVERY_MS = 60_000
export const INDEX_TIMEOUT_MS = 10_000
// `$.http.fetch` has a fixed 30 s timeout and cannot be aborted: the wait and the timeout of a request that may be held stay under it.
export const INDEX_WAIT_SECONDS = 15
export const INDEX_LONG_TIMEOUT_MS = 25_000
export const INDEX_PREFERENCE_APPLIED = 'preference-applied'
// An index that no sync refreshed for three periods is stale, whatever the timer did.
export const STALE_AFTER_MS = 3 * INDEX_EVERY_MS
// A fetch cannot be cancelled, so a request that the timer outran stays open. The next sync waits for it, and a request open past this age no longer holds the path.
const UNANSWERED_STALE_MS = 600_000
const REVISION_MAX = 256

export type PolicyIndex = {
  readonly revision: string
  readonly screen: PostureInput
  readonly outputInspected: boolean
  readonly remoteOnly: boolean
  readonly scanWindow: number | null
}

export type IndexContext = { readonly host: string | null; readonly authorization: string | null; readonly io: JudgeIo }

export type SyncOutcome = 'loaded' | 'kept' | 'failed' | 'busy' | 'skipped'

type SyncState = {
  index: PolicyIndex | null
  etag: string | null
  longPoll: boolean
  supportsWait: boolean
  lastOkAt: number | null
  failedSince: number | null
  openSince: number | null
}

const fresh = (): SyncState => ({ index: null, etag: null, longPoll: false, supportsWait: false, lastOkAt: null, failedSince: null, openSince: null })

let sync = fresh()
let contextSent: string | null = null

export function resetIndex(): void {
  sync = fresh()
  contextSent = null
}

// The index is never an input to a verdict (R24): only its revision keys the cache, and only its remote-only flag skips it.
export const heldIndex = (): PolicyIndex | null => sync.index

export const indexLongPoll = (): boolean => sync.longPoll

export const indexSupportsWait = (): boolean => sync.supportsWait

export const staleSince = (): number | null => sync.failedSince

// An index that failed to refresh is held but not used: nothing reads it until a sync succeeds again.
export const usableIndex = (): PolicyIndex | null => (sync.failedSince === null ? sync.index : null)

export const indexRevision = (): string | null => sync.index?.revision ?? null

// The local tier asks only while a sync refreshed the index within three periods (interrogate A7). The timer marks a stale index late, so the age is read here.
export const indexFresh = (now: number): boolean => sync.index !== null && sync.failedSince === null && sync.lastOkAt !== null && now - sync.lastOkAt < STALE_AFTER_MS

// Skip the decision cache while a policy that only the server decides is active (interrogate A8). Without a usable index the 60 s limit is the only bound.
// A stale index keeps the last remote-only answer: an outage must not turn the cache on for classes only the server decides (A8).
export const remoteOnlyActive = (): boolean => heldIndex()?.remoteOnly === true

// The scan window of the organization: the local tier needs it to flag a cut argument text as the server flags it.
export const indexScanWindow = (): number | null => heldIndex()?.scanWindow ?? null

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

export function parseIndex(text: string): PolicyIndex | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(json)) return null
  const { revision, screen, output_inspected: outputInspected, remote_only_classes_active: remoteOnly, pii_scan_max_chars: scanWindow } = json
  if (typeof revision !== 'string' || revision === '' || revision.length > REVISION_MAX) return null
  if (typeof outputInspected !== 'boolean' || !isRecord(screen)) return null
  const { banned, requires_ask: requiresAsk, posture, guardrails } = screen
  if (!isStrings(banned) || !isStrings(requiresAsk) || !isStrings(guardrails) || !isRecord(posture)) return null
  const { compliance_regimes: regimes, enforce_not_approved: enforceNotApproved, scope_default_tier: tier } = posture
  if (!isStrings(regimes) || typeof enforceNotApproved !== 'boolean' || typeof tier !== 'string') return null
  return {
    revision,
    screen: {
      banned,
      requires_ask: requiresAsk,
      posture: { compliance_regimes: regimes, enforce_not_approved: enforceNotApproved, scope_default_tier: tier as PostureInput['posture']['scope_default_tier'] },
      guardrails,
    },
    outputInspected,
    remoteOnly: remoteOnly === true,
    scanWindow: typeof scanWindow === 'number' && Number.isInteger(scanWindow) && scanWindow > 0 ? scanWindow : null,
  }
}

function refreshed(at: number): void {
  sync.lastOkAt = at
  sync.failedSince = null
}

function failed(at: number): void {
  if (sync.failedSince === null) sync.failedSince = at
}

// A sync that never ran, or never ended, leaves the held index to age: three periods without a refresh make it stale.
export function expireIndex(now: number): void {
  if (sync.lastOkAt !== null && now - sync.lastOkAt >= STALE_AFTER_MS) failed(now)
}

// A different revision leaves the cache keyed under the old one unreachable and empty (R23).
function accept(index: PolicyIndex, etag: string | null, at: number): void {
  const changed = sync.index?.revision !== index.revision
  sync.index = index
  sync.etag = etag
  refreshed(at)
  if (changed) cacheClear()
}

export const INDEX_MIN_HELD_MS = 5_000

export function readResponse(response: HttpResponse | 'timeout' | 'failed', at: number, elapsedMs?: number): SyncOutcome {
  sync.longPoll = false
  if (typeof response === 'string') {
    failed(at)
    return 'failed'
  }
  const held = response.headers[INDEX_PREFERENCE_APPLIED] !== undefined
  if (response.status === 304 && sync.index !== null && sync.etag !== null) {
    refreshed(at)
    sync.longPoll = held && (elapsedMs === undefined || elapsedMs >= INDEX_MIN_HELD_MS)
    sync.supportsWait = held
    return 'kept'
  }
  const index = response.status === 200 ? parseIndex(response.text) : null
  if (index === null) {
    failed(at)
    return 'failed'
  }
  accept(index, response.headers.etag ?? null, at)
  sync.longPoll = held
  sync.supportsWait = held
  return 'loaded'
}

export async function syncIndex(ctx: IndexContext): Promise<SyncOutcome> {
  const { host, authorization } = ctx
  if (host === null || authorization === null) return 'skipped'
  const now = await ctx.io.now()
  expireIndex(now)
  if (sync.openSince !== null && now - sync.openSince < UNANSWERED_STALE_MS) return 'busy'
  const stamp = now
  sync.openSince = stamp
  const waits = sync.etag !== null
  const late = new Promise<'timeout'>(resolve => {
    ctx.io.after(waits ? INDEX_LONG_TIMEOUT_MS : INDEX_TIMEOUT_MS, () => resolve('timeout'))
  })
  const sent = ctx.io
    .fetch(`${host}${INDEX_PATH}`, {
      method: 'GET',
      headers: { Authorization: authorization, Accept: 'application/json', Prefer: `wait=${INDEX_WAIT_SECONDS}`, ...(sync.etag !== null ? { 'If-None-Match': sync.etag } : {}) },
    })
    .catch((): 'failed' => 'failed')
    .finally(() => {
      if (sync.openSince === stamp) sync.openSince = null
    })
  const response = await Promise.race([sent, late])
  if (response === 'timeout' && sync.openSince === stamp) sync.openSince = null
  const answeredAt = await ctx.io.now()
  return readResponse(response, answeredAt, answeredAt - stamp)
}

// The conversation and the revision of the last context that entered a prompt (M9). A new key sends it again.
export const contextKeyOf = (conversation: string, revision: string): string => JSON.stringify([conversation, revision])

export type Claim = { readonly key: string; readonly prior: string | null }

// A claim is made before the prompt goes down, so two prompts typed together cannot both carry the context.
export function claimContext(key: string): Claim | null {
  if (contextSent === key) return null
  const claim = { key, prior: contextSent }
  contextSent = key
  return claim
}

// A prompt that did not enter did not carry the context, so the next prompt sends it.
export function releaseContext(claim: Claim): void {
  if (contextSent === claim.key) contextSent = claim.prior
}

// Any end of a conversation (a /clear, a resume, an exit) starts the next one afresh.
export function endConversation(): void {
  contextSent = null
}
