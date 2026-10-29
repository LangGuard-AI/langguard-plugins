import type { HttpResponse } from 'claude-code'
import type { ArbiterVerdict } from '../../types'
import type { Decision, Judgment } from '../gate/machine.ts'
import { normalizeToolName } from '../vendor/claude/tool-normalize.ts'
import { buildOtlpPayload, type AuditRecord } from '../vendor/core/pure.ts'
import { HARNESS, type JudgeIo } from '../verdict/source.ts'

export const QUEUE_MAX = 500
export const BATCH_MAX = 50
export const FLUSH_EVERY_MS = 5000
export const RETRY_AFTER_MS = 500
export const SEND_TIMEOUT_MS = 5000
// The route the daemon uses; it takes `ingest` keys only (P7). An `arbiter` key gets 403 and the batch is dropped.
export const EVIDENCE_PATH = '/v1/logs'
export const SESSION_TOOL = 'arbiter.session'

export type EvidenceKind = 'decision' | 'session_start' | 'session_end' | 'ask_resolved' | 'ran_unchecked'
export type EvidenceSource = 'remote' | 'cache' | 'local' | 'fail-mode' | 'none'

export type EvidenceInput = {
  readonly kind: EvidenceKind
  readonly hookEvent: string
  readonly tool: string
  readonly verdict: ArbiterVerdict
  readonly source: EvidenceSource
  readonly argsHash: string | null
  readonly at: number
  readonly agentId?: string
  readonly toolUseId?: string
  readonly outcome?: 'ran' | 'denied'
  readonly reason?: string
}

export type EvidenceEvent = EvidenceInput & { readonly seq: number; readonly sessionId: string; readonly installId: string; readonly userId: string | null }

export type EvidenceContext = { readonly host: string | null; readonly authorization: string | null; readonly io: JudgeIo }

export type EvidenceMeter = { seq: number; queued: number; dropped: number; lastFlushAt?: number }

let pending: EvidenceEvent[] = []
let dropped = 0
let lastFlushAt: number | undefined
let sessionId = 'unknown'
let installId = 'unknown'
let userId: string | null = null
let inFlight: Promise<void> | null = null
const seqBySession = new Map<string, number>()

export function setEvidenceIdentity(session: string, install: string, user: string | null = null): void {
  sessionId = session
  installId = install
  userId = user
}

// 0 drops first, 2 last: an ALLOW the server did not see, then any other event, then a BLOCK.
// Only an ALLOW that a cache or the local rules gave is cheap to lose. An ALLOW under a fault ran with no check, and R25 keeps it.
const isRoutineAllow = (event: EvidenceEvent): boolean => event.kind === 'decision' && event.verdict === 'ALLOW' && (event.source === 'cache' || event.source === 'local')

const rankOf = (event: EvidenceEvent): 0 | 1 | 2 => (event.verdict === 'BLOCK' ? 2 : isRoutineAllow(event) ? 0 : 1)

function trim(): void {
  while (pending.length > QUEUE_MAX) {
    let at = 0
    let lowest = 3
    for (let i = 0; i < pending.length; i += 1) {
      const rank = rankOf(pending[i] as EvidenceEvent)
      if (rank < lowest) {
        lowest = rank
        at = i
        if (rank === 0) break
      }
    }
    pending.splice(at, 1)
    dropped += 1
  }
}

export function enqueue(input: EvidenceInput): void {
  const seq = (seqBySession.get(sessionId) ?? 0) + 1
  seqBySession.set(sessionId, seq)
  pending.push({ ...input, seq, sessionId, installId, userId })
  trim()
}

export const meter = (): EvidenceMeter => ({
  seq: seqBySession.get(sessionId) ?? 0,
  queued: pending.length,
  dropped,
  ...(lastFlushAt !== undefined ? { lastFlushAt } : {}),
})

const sourceOf = (judgment: Judgment): EvidenceSource => (judgment.kind === 'fault' ? 'fail-mode' : judgment.from === 'server' ? 'remote' : judgment.from)

const reasonOf = (judgment: Judgment): string | undefined => (judgment.kind === 'fault' ? judgment.fault.kind : undefined)

export type DecisionCall = { readonly rawTool: string; readonly agentId?: string; readonly toolUseId?: string }

const baseOf = (call: DecisionCall, hookEvent: string, at: number) => ({
  hookEvent,
  tool: normalizeToolName(call.rawTool).normalized,
  at,
  ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
  ...(call.toolUseId !== undefined ? { toolUseId: call.toolUseId } : {}),
})

// A server verdict is in the server's own log, so the evidence skips it. A local decision reaches the server as a record, and the mod still queues its own evidence of it: the server keeps its GRAIL record, and the evidence queue keeps the mod's /v1/logs entry. One local decision has both.
export function noteDecision(hookEvent: string, call: DecisionCall, decision: Decision, at: number): void {
  const { judgment } = decision
  if (judgment.kind === 'verdict' && judgment.from === 'server') return
  const reason = reasonOf(judgment)
  enqueue({ ...baseOf(call, hookEvent, at), kind: 'decision', verdict: decision.effective, source: sourceOf(judgment), argsHash: judgment.argsHash, ...(reason !== undefined ? { reason } : {}) })
}

export function noteAskResolved(hookEvent: string, call: DecisionCall, decision: Decision, outcome: 'ran' | 'denied', at: number): void {
  enqueue({ ...baseOf(call, hookEvent, at), kind: 'ask_resolved', verdict: 'ASK', source: sourceOf(decision.judgment), argsHash: decision.judgment.argsHash, outcome })
}

// A strict-mode withhold that no server verdict caused: the output was held back and the server never saw the row.
export function noteOutputFault(call: DecisionCall, reason: string, at: number): void {
  enqueue({ ...baseOf(call, 'session.append', at), kind: 'decision', verdict: 'BLOCK', source: 'fail-mode', argsHash: null, reason })
}

// The server answered the record of a local ALLOW with another verdict, so the local tier went off until the next revision of the index (interrogate A15). The record holds no reason text of a policy.
export function noteLocalMismatch(call: DecisionCall, serverVerdict: ArbiterVerdict, argsHash: string | null, at: number): void {
  enqueue({ ...baseOf(call, 'local.sample', at), kind: 'decision', verdict: serverVerdict, source: 'local', argsHash, reason: 'local-sample-mismatch' })
}

// A BLOCK of an output that only the local tier saw: the server has no record of it.
export function noteOutputLocalBlock(call: DecisionCall, argsHash: string | null, at: number): void {
  enqueue({ ...baseOf(call, 'session.append', at), kind: 'decision', verdict: 'BLOCK', source: 'local', argsHash })
}

export function noteRanUnchecked(call: DecisionCall, at: number): void {
  enqueue({ ...baseOf(call, 'session.append', at), kind: 'ran_unchecked', verdict: 'ALLOW', source: 'none', argsHash: null, outcome: 'ran' })
}

export function noteSession(kind: 'session_start' | 'session_end', at: number): void {
  enqueue({ kind, hookEvent: kind, tool: SESSION_TOOL, verdict: 'ALLOW', source: 'none', argsHash: null, at })
}

type Attribute = { key: string; value: { stringValue: string } }

const attributesOf = (event: EvidenceEvent): Attribute[] => {
  const pairs: [string, string | undefined][] = [
    ['arbiter.harness', HARNESS],
    ['arbiter.install_id', event.installId],
    ['arbiter.event', event.kind],
    ['arbiter.source', event.source],
    ['arbiter.agent_id', event.agentId],
    ['arbiter.tool_use_id', event.toolUseId],
    ['arbiter.args_hash', event.argsHash ?? undefined],
    ['arbiter.outcome', event.outcome],
  ]
  return pairs.flatMap(([key, value]) => (value === undefined ? [] : [{ key, value: { stringValue: value } }]))
}

const recordOf = (event: EvidenceEvent): AuditRecord => ({
  session_id: event.sessionId,
  tool: event.tool,
  verdict: event.verdict,
  applied_rule: event.source,
  hook_event: event.hookEvent,
  bundle_revision: '',
  ts: new Date(event.at).toISOString(),
  seq: event.seq,
  ...(event.userId !== null ? { user_id: event.userId } : {}),
  ...(event.reason !== undefined ? { reason: event.reason } : {}),
})

type OtlpLogs = { resourceLogs: { scopeLogs: { logRecords: { attributes: Attribute[] }[] }[] }[] }

// The shared builder owns the record layout; the install id, agent id and tool use id ride beside it as attributes.
export function payloadFor(batch: readonly EvidenceEvent[]): unknown {
  const payload = buildOtlpPayload(batch.map(recordOf)) as OtlpLogs
  const records = payload.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? []
  records.forEach((record, i) => record.attributes.push(...attributesOf(batch[i] as EvidenceEvent)))
  return payload
}

// A fetch cannot be cancelled, so a request that the timer outran stays open. The next request on its path waits for it, and a request that stays open past this age no longer holds the path.
const UNANSWERED_STALE_MS = 600_000
const unanswered = new Map<string, number>()

const isBusy = (path: string): boolean => {
  const since = unanswered.get(path)
  return since !== undefined && Date.now() - since < UNANSWERED_STALE_MS
}

export type PostResult = HttpResponse | 'timeout' | 'failed' | 'busy'

export async function postJson(ctx: EvidenceContext, path: string, body: unknown, timeoutMs: number): Promise<PostResult> {
  if (ctx.host === null || ctx.authorization === null) return 'failed'
  if (isBusy(path)) return 'busy'
  const { host, authorization } = ctx
  const stamp = Date.now()
  unanswered.set(path, stamp)
  const late = new Promise<'timeout'>(resolve => {
    ctx.io.after(timeoutMs, () => resolve('timeout'))
  })
  const sent = ctx.io
    .fetch(`${host}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(body) })
    .catch((): 'failed' => 'failed')
    .finally(() => {
      if (unanswered.get(path) === stamp) unanswered.delete(path)
    })
  return Promise.race([sent, late])
}

const pause = (ctx: EvidenceContext, ms: number): Promise<void> =>
  new Promise<void>(resolve => {
    ctx.io.after(ms, resolve)
  })

// `hold` is a request that nobody answered: it may still land, so the batch waits for the next tick and is not sent again.
type SendResult = 'sent' | 'retry' | 'hold' | 'drop'

function resultOf(response: PostResult): SendResult {
  if (response === 'timeout' || response === 'busy') return 'hold'
  if (response === 'failed') return 'retry'
  if (response.ok) return 'sent'
  return response.status === 408 || response.status === 429 || response.status >= 500 ? 'retry' : 'drop'
}

// `deadline` is a clock time that a send must end by. Without one the timer flush has no bound but its own timeout.
async function sendBatch(ctx: EvidenceContext, timeoutMs: number, deadline?: number): Promise<boolean> {
  const batch = pending.splice(0, BATCH_MAX)
  if (batch.length === 0) return true
  const body = payloadFor(batch)
  let result = resultOf(await postJson(ctx, EVIDENCE_PATH, body, timeoutMs))
  if (result === 'retry') {
    const left = deadline === undefined ? SEND_TIMEOUT_MS : deadline - (await ctx.io.now()) - RETRY_AFTER_MS
    if (left > RETRY_AFTER_MS) {
      await pause(ctx, RETRY_AFTER_MS)
      result = resultOf(await postJson(ctx, EVIDENCE_PATH, body, Math.min(SEND_TIMEOUT_MS, left)))
    }
  }
  if (result === 'sent') {
    lastFlushAt = await ctx.io.now().catch(() => lastFlushAt)
    return true
  }
  if (result === 'drop') dropped += batch.length
  else {
    pending = [...batch, ...pending]
    trim()
  }
  return result === 'drop'
}

const canSend = (ctx: EvidenceContext): boolean => ctx.host !== null && ctx.authorization !== null

// One batch, from the timer. A flush still in flight answers the same promise, so a hung request holds no second one.
export function flushOnce(ctx: EvidenceContext): Promise<void> {
  if (inFlight !== null) return inFlight
  if (pending.length === 0 || !canSend(ctx)) return Promise.resolve()
  const run = sendBatch(ctx, SEND_TIMEOUT_MS)
    .then(() => undefined)
    .finally(() => {
      inFlight = null
    })
  inFlight = run
  return run
}

// The whole flush, the wait for a flush in flight included, ends by `budgetMs`. A send that is still open then is left open.
export async function flushAll(ctx: EvidenceContext, budgetMs: number): Promise<void> {
  const startedAt = await ctx.io.now()
  const deadline = startedAt + budgetMs
  if (inFlight !== null) {
    await Promise.race([inFlight, pause(ctx, Math.max(0, budgetMs))])
    if (inFlight !== null) return
  }
  while (pending.length > 0 && canSend(ctx)) {
    const left = deadline - (await ctx.io.now())
    if (left <= RETRY_AFTER_MS) return
    if (!(await sendBatch(ctx, Math.min(SEND_TIMEOUT_MS, left), deadline))) return
  }
}
