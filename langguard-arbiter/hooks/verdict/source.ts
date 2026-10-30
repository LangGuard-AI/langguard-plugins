import type { HttpInit, HttpResponse } from 'claude-code'
import type { ArbiterFault } from '../../types'
import type { Judgment } from '../gate/machine.ts'
import { allowStands, askLocal, askStands, type LocalAccess } from '../local/tier.ts'
import { cacheGet, cacheKey, cachePut, coalesce } from './cache.ts'
import {
  DEFAULT_CATASTROPHIC_DENY_LIST,
  PII_SCAN_MAX_CHARS_FALLBACK,
  buildInvokeRequest,
  checkpointForHookPhase,
  isCatastrophicMatch,
  NON_AUTHORITATIVE_RULES,
  parseInvokeReply,
  stableStringify,
  type InvokeReply,
  type LocalRecord,
  type VerdictRequest,
} from '../vendor/core/pure.ts'
import { normalizeToolName } from '../vendor/claude/tool-normalize.ts'

export const MAX_INPUT_BYTES = 1024 * 1024
export const MAX_INPUT_DEPTH = 64
export const VERDICT_WAIT_MS = 3000
export const SERVER_TIMEOUT_MS = 2500
export const BREAKER_FAULTS = 2
export const BREAKER_OPEN_MS = 15_000
export const MAX_IN_FLIGHT = 8
export const MAX_RECORDS_IN_FLIGHT = 16
export const INTERCEPTOR_PATH = '/api/interceptor'
export const HARNESS = 'claude'

export type JudgeIo = {
  readonly now: () => Promise<number>
  readonly fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  readonly after: (ms: number, fn: () => void) => void
}

export type JudgeContext = {
  readonly host: string | null
  readonly authorization: string | null
  readonly revoked: boolean
  readonly sessionId: string
  readonly userId?: string | null
  // The id of this install, as the heartbeat reports it. Null or absent: the request carries none.
  readonly installId?: string | null
  readonly indexRevision: () => string | null
  readonly remoteOnlyActive: boolean
  readonly scanWindow: number
  // The scan window of the organization from the policy index, for the local tier. Null or absent: the window of the mod.
  readonly tenantWindow?: number | null
  readonly io: JudgeIo
  // The local tier. Null or absent: every call goes to the server.
  readonly local?: LocalAccess | null
  readonly indexFresh?: (now: number) => boolean
}

export type JudgeCall = { readonly rawTool: string; readonly input: unknown; readonly agentId?: string }

const verdictOf = (verdict: 'ALLOW' | 'BLOCK' | 'ASK', from: 'server' | 'cache' | 'local', argsHash: string | null): Judgment => ({ kind: 'verdict', verdict, from, argsHash })
const faultOf = (fault: ArbiterFault, argsHash: string | null): Judgment => ({ kind: 'fault', fault, argsHash })

// A loop, not recursion: hostile input can be deep enough to overflow the stack (R8). A shared reference counts as over the limit; a walk over paths would cost 2^depth on a diamond-shaped input.
export function measureDepth(value: unknown, limit: number): number {
  let depth = 0
  let level: unknown[] = [value]
  const visited = new Set<object>()
  while (level.length > 0) {
    const next: unknown[] = []
    for (const item of level) {
      if (item === null || typeof item !== 'object') continue
      if (visited.has(item)) return limit + 1
      visited.add(item)
      for (const child of Object.values(item as Record<string, unknown>)) next.push(child)
    }
    if (next.length === 0) return depth
    depth += 1
    if (depth > limit) return depth
    level = next
  }
  return depth
}

const encoder = new TextEncoder()

export function serializeInput(input: unknown): { readonly text: string } | { readonly oversize: true } {
  if (measureDepth(input, MAX_INPUT_DEPTH) > MAX_INPUT_DEPTH) return { oversize: true }
  let text: string
  try {
    text = JSON.stringify(input) ?? 'null'
  } catch {
    return { oversize: true }
  }
  if (text.length > MAX_INPUT_BYTES || encoder.encode(text).length > MAX_INPUT_BYTES) return { oversize: true }
  return { text }
}

export async function hashInput(input: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(stableStringify(input)))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export const isBadName = (rawTool: string): boolean => {
  const { normalized, isNativeTool } = normalizeToolName(rawTool)
  return !isNativeTool && !normalized.includes('.')
}

export type WirePhase = 'enforce' | 'evidence'

export type WireCall = {
  readonly rawTool: string
  readonly tool: string
  readonly argsHash: string | null
  readonly serialized: string
  readonly agentId?: string
  readonly phase?: WirePhase
}

export const INSTALL_ID_MAX = 128

// The server keys the fleet traffic counter on this id. The state holds 'unknown' until the session starts; a value of another shape stays out of the request.
export const installIdFor = (id: string | null | undefined): string | null =>
  typeof id === 'string' && id !== 'unknown' && id.length <= INSTALL_ID_MAX && /^[\w.:-]+$/.test(id) ? id : null

type BodyContext = Pick<JudgeContext, 'sessionId' | 'scanWindow' | 'userId' | 'installId'>

export function verdictRequestFor(call: WireCall, ctx: BodyContext, record?: LocalRecord): VerdictRequest {
  const phase = call.phase ?? 'enforce'
  const checkpoint = checkpointForHookPhase(phase)
  const text = call.serialized.slice(0, ctx.scanWindow)
  const installId = installIdFor(ctx.installId)
  return {
    session_id: ctx.sessionId,
    tool: call.tool,
    raw_tool: call.rawTool,
    phase,
    ...(checkpoint ? { checkpoint } : {}),
    ...(call.argsHash !== null ? { args_hash: call.argsHash } : {}),
    content: phase === 'evidence' ? { output: text } : { args: text },
    agent_name: HARNESS,
    ...(installId !== null ? { install_id: installId } : {}),
    ...(ctx.userId ? { user_id: ctx.userId } : {}),
    ai_app_id: `${HARNESS}:${ctx.sessionId}`,
    ...(record !== undefined ? { record } : {}),
  }
}

// params.timeoutMs (R7) and config.langguard.agent_id (R30) ride beside the shared envelope.
export function invokeBodyFor(call: WireCall, ctx: BodyContext, id: string, record?: LocalRecord) {
  const envelope = buildInvokeRequest(verdictRequestFor(call, ctx, record), id)
  return {
    ...envelope,
    params: {
      ...envelope.params,
      timeoutMs: SERVER_TIMEOUT_MS,
      config: { langguard: { ...envelope.params.config.langguard, ...(call.agentId !== undefined ? { agent_id: call.agentId } : {}) } },
    },
  }
}

const requestId = (): string => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

type ServerAnswer = { readonly verdict: 'ALLOW' | 'BLOCK' | 'ASK'; readonly rule?: string } | { readonly fault: ArbiterFault }

// A valid key of a type that the route does not take answers 403 with the error key_scope. Any other 401 or 403 is a key that the server does not accept.
export function keyFaultOf(response: Pick<HttpResponse, 'status' | 'text'>): ArbiterFault | null {
  if (response.status === 401) return { kind: 'key-rejected', status: 401 }
  if (response.status !== 403) return null
  try {
    return (JSON.parse(response.text) as { error?: unknown } | null)?.error === 'key_scope' ? { kind: 'key-wrong-type' } : { kind: 'key-rejected', status: 403 }
  } catch {
    return { kind: 'key-rejected', status: 403 }
  }
}

function answerOf(response: HttpResponse): ServerAnswer {
  const keyFault = keyFaultOf(response)
  if (keyFault !== null) return { fault: keyFault }
  if (response.status === 429) return { fault: { kind: 'rate-limited' } }
  if (response.status >= 500) return { fault: { kind: 'unreachable', cause: 'http-5xx' } }
  if (!response.ok) return { fault: { kind: 'bad-reply' } }
  let json: InvokeReply
  try {
    json = JSON.parse(response.text) as InvokeReply
  } catch {
    return { fault: { kind: 'bad-reply' } }
  }
  if (json !== null && typeof json === 'object' && json.error?.code === -32000) return { fault: { kind: 'unreachable', cause: 'timeout' } }
  try {
    const reply = parseInvokeReply(json)
    return { verdict: reply.verdict, ...(reply.applied_rule !== undefined ? { rule: reply.applied_rule } : {}) }
  } catch {
    return { fault: { kind: 'bad-reply' } }
  }
}

// A fetch the host refused is its policy switch (F14); any other rejection is
// the network (F1). The engine spells a refusal `<plugin>: $.http.fetch: <reason>`
// and a network failure `<plugin>: $.http.fetch(<url>) failed: <ERRNO>: ...`.
// Only the text after the last `$.http.fetch` segment is read, so neither the
// URL nor an errno such as ECONNREFUSED can name a refusal.
const REFUSAL = /refus|polic|nonessential|not allowed|disabled/i
const ERRNO = /^E[A-Z0-9_]+\b/

export function fetchFailureText(message: string): string {
  const at = message.lastIndexOf('$.http.fetch')
  const rest = at < 0 ? message : message.slice(at)
  const colon = rest.indexOf(': ')
  return colon < 0 ? rest : rest.slice(colon + 2)
}

export function fetchFault(err: unknown): ArbiterFault {
  const text = fetchFailureText(err instanceof Error ? err.message : String(err))
  if (!ERRNO.test(text) && REFUSAL.test(text)) return { kind: 'network-policy' }
  return { kind: 'unreachable', cause: 'network' }
}

type HostState = { faults: number; openUntil: number; inFlight: number; records: number; waiters: (() => void)[] }
const hosts = new Map<string, HostState>()

function hostState(host: string): HostState {
  let state = hosts.get(host)
  if (!state) {
    state = { faults: 0, openUntil: 0, inFlight: 0, records: 0, waiters: [] }
    hosts.set(host, state)
  }
  return state
}

const isBreakerFault = (fault: ArbiterFault): boolean => fault.kind === 'unreachable' || fault.kind === 'rate-limited' || fault.kind === 'bad-reply' || fault.kind === 'network-policy'

function recordAnswer(state: HostState, answer: ServerAnswer, now: number): void {
  if ('verdict' in answer || !isBreakerFault(answer.fault)) {
    state.faults = 0
    return
  }
  state.faults += 1
  if (state.faults >= BREAKER_FAULTS) state.openUntil = now + BREAKER_OPEN_MS
}

function takeSlot(state: HostState): Promise<void> {
  if (state.inFlight < MAX_IN_FLIGHT) {
    state.inFlight += 1
    return Promise.resolve()
  }
  return new Promise<void>(resolve => {
    state.waiters.push(() => {
      state.inFlight += 1
      resolve()
    })
  })
}

function freeSlot(state: HostState): void {
  state.inFlight -= 1
  const waiter = state.waiters.shift()
  if (waiter) waiter()
}

async function askServer(host: string, authorization: string, call: WireCall, ctx: JudgeContext): Promise<ServerAnswer> {
  const state = hostState(host)
  const startedAt = await ctx.io.now()
  if (startedAt < state.openUntil) return { fault: { kind: 'unreachable', cause: 'network' } }

  // $.http.fetch cannot be aborted, so the slot frees when the race settles, not when the fetch does: a fetch that never settles must not hold its slot.
  let settled = false
  let slotHeld = false
  const release = (): void => {
    if (!slotHeld) return
    slotHeld = false
    freeSlot(state)
  }
  const late = new Promise<ServerAnswer>(resolve => {
    ctx.io.after(VERDICT_WAIT_MS, () => resolve({ fault: { kind: 'unreachable', cause: 'timeout' } }))
  })
  const asked = (async (): Promise<ServerAnswer> => {
    await takeSlot(state)
    slotHeld = true
    if (settled) {
      release()
      return { fault: { kind: 'unreachable', cause: 'timeout' } }
    }
    try {
      const response = await ctx.io.fetch(`${host}${INTERCEPTOR_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify(invokeBodyFor(call, ctx, requestId())),
      })
      return answerOf(response)
    } catch (err) {
      return { fault: fetchFault(err) }
    } finally {
      release()
    }
  })()
  const answer = await Promise.race([asked, late])
  settled = true
  release()
  recordAnswer(state, answer, await ctx.io.now())
  return answer
}

// The header that marks a record request, so that a test world can tell it from a verdict request. The server reads the `record` field of the body, not this header.
export const RECORD_HEADER = 'X-Arbiter-Record'

// A server that could not decide (engine outage, a policy that failed to evaluate) answers ASK under a rule of NON_AUTHORITATIVE_RULES. That answer is no evidence against a local decision. A reply without a rule comes from a server that does not send it, and counts.
const isAuthoritative = (answer: { readonly rule?: string }): boolean => answer.rule === undefined || !NON_AUTHORITATIVE_RULES.includes(answer.rule)

// The server never sees a call that the mod decides locally, so the violation, the alert, the stats, the blocked-trace row, the MCP counters, the usage count and the approval request of that decision exist only if the mod sends the call. This is that copy: the body of a verdict request plus the local outcome (`record`), sent once for each local decision. The local tier decides; the server records.
// The record is off the verdict path. Nothing awaits it, it takes no in-flight slot of the verdict path, and it neither feeds the breaker nor ignores it: a fault of the record is no finding, and an open breaker means no record. Records have a slot count of their own per host, freed when the fetch settles ($.http.fetch cannot be aborted, so a timeout does not free it). The server answer matters for one case only. A local ALLOW that the server answers with another authoritative verdict ends the local tier for the revision of the index that decided (access.onMismatch). The server answer to a local BLOCK or ASK is ignored.
async function recordOnServer(host: string, authorization: string, wire: WireCall, ctx: JudgeContext, record: LocalRecord, access: LocalAccess | null, revision: string | null): Promise<void> {
  try {
    const state = hostState(host)
    const startedAt = await ctx.io.now()
    if (startedAt < state.openUntil || state.records >= MAX_RECORDS_IN_FLIGHT) return
    state.records += 1
    const free = (): void => {
      state.records -= 1
    }
    const late = new Promise<null>(resolve => {
      ctx.io.after(VERDICT_WAIT_MS, () => resolve(null))
    })
    const asked = (async () =>
      ctx.io.fetch(`${host}${INTERCEPTOR_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization, [RECORD_HEADER]: '1' },
        body: JSON.stringify(invokeBodyFor(wire, ctx, requestId(), record)),
      }))().then(answerOf, () => null)
    asked.then(free, free)
    const answer = await Promise.race([asked, late])
    if (record.verdict === 'ALLOW' && access !== null && revision !== null && answer !== null && 'verdict' in answer && answer.verdict !== 'ALLOW' && isAuthoritative(answer)) {
      access.onMismatch({ rawTool: wire.rawTool, argsHash: wire.argsHash, serverVerdict: answer.verdict, revision })
    }
  } catch {
    return
  }
}

type LocalStep = { readonly judgment: Judgment } | null

// The local step of the pipeline. It runs on a held index and answers only while OPA holds the bundle of that index. A local BLOCK stands whatever the age of the index or the result of its last sync: violations are monotonic, and no index field decides a BLOCK. A local ALLOW and a local ASK stand only on a fresh index (interrogate A7).
async function localStep(wire: WireCall, isNativeTool: boolean, revision: string | null, host: string, authorization: string, ctx: JudgeContext): Promise<LocalStep> {
  const access = ctx.local
  if (!access || revision === null) return null
  const fresh = ctx.indexFresh?.(await ctx.io.now()) === true
  const leg = wire.phase ?? 'enforce'
  const answer = await askLocal(
    { tool: wire.tool, rawTool: wire.rawTool, isNativeTool, agentName: HARNESS, aiAppId: `${HARNESS}:${ctx.sessionId}`, userId: ctx.userId, leg, text: wire.serialized.slice(0, ctx.scanWindow), sessionId: ctx.sessionId, ...(ctx.tenantWindow ? { window: ctx.tenantWindow } : {}) },
    access,
    ctx.io,
    revision,
  )
  if (answer.kind === 'server') return null
  if (answer.verdict !== 'BLOCK' && !fresh) return null
  if (answer.verdict === 'ALLOW' && !allowStands({ ...access, signed: answer.signed })) return null
  if (answer.verdict === 'ASK' && !askStands(access)) return null
  void recordOnServer(host, authorization, wire, ctx, { verdict: answer.verdict, catastrophic: false }, access, revision)
  return { judgment: verdictOf(answer.verdict, 'local', wire.argsHash) }
}

// The serialization of the input (up to 1 MB) runs in a task of its own, after the verdict went out.
function recordCatastrophic(call: JudgeCall, ctx: JudgeContext): void {
  const { host, authorization } = ctx
  if (ctx.revoked || host === null || authorization === null) return
  ctx.io.after(0, () => {
    void (async () => {
      const serialized = serializeInput(call.input)
      const oversize = 'oversize' in serialized
      const wire: WireCall = {
        rawTool: call.rawTool,
        tool: normalizeToolName(call.rawTool).normalized,
        argsHash: oversize ? null : await hashInput(call.input),
        serialized: oversize ? '' : serialized.text,
        ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
      }
      await recordOnServer(host, authorization, wire, ctx, { verdict: 'BLOCK', catastrophic: true }, null, null)
    })().catch(() => undefined)
  })
}

export async function judge(call: JudgeCall, ctx: JudgeContext): Promise<Judgment> {
  if (isCatastrophicMatch(call.rawTool, {}, DEFAULT_CATASTROPHIC_DENY_LIST)) {
    if (!isBadName(call.rawTool)) recordCatastrophic(call, ctx)
    return verdictOf('BLOCK', 'local', null)
  }
  if (isBadName(call.rawTool)) return faultOf({ kind: 'bad-name' }, null)

  const serialized = serializeInput(call.input)
  if ('oversize' in serialized) return faultOf({ kind: 'oversize' }, null)
  const argsHash = await hashInput(call.input)
  const input = call.input !== null && typeof call.input === 'object' && !Array.isArray(call.input) ? (call.input as Record<string, unknown>) : { input: call.input }
  if (isCatastrophicMatch(call.rawTool, input, DEFAULT_CATASTROPHIC_DENY_LIST)) {
    recordCatastrophic(call, ctx)
    return verdictOf('BLOCK', 'local', argsHash)
  }

  if (ctx.revoked) return faultOf({ kind: 'key-rejected', status: 401 }, argsHash)
  const { host, authorization } = ctx
  if (host === null || authorization === null) return faultOf({ kind: 'no-key' }, argsHash)

  const { normalized: tool, isNativeTool } = normalizeToolName(call.rawTool)
  const revision = ctx.indexRevision()
  const key = cacheKey(host, revision, tool, argsHash)
  const now = await ctx.io.now()
  if (!ctx.remoteOnlyActive && cacheGet(key, now)) return verdictOf('ALLOW', 'cache', argsHash)

  return coalesce(key, async () => {
    const wire: WireCall = { rawTool: call.rawTool, tool, argsHash, serialized: serialized.text, ...(call.agentId !== undefined ? { agentId: call.agentId } : {}) }
    const local = await localStep(wire, isNativeTool, revision, host, authorization, ctx)
    if (local !== null) return local.judgment
    const answer = await askServer(host, authorization, wire, ctx)
    if ('fault' in answer) return faultOf(answer.fault, argsHash)
    if (answer.verdict === 'ALLOW' && !ctx.remoteOnlyActive && ctx.indexRevision() === revision) cachePut(key, await ctx.io.now())
    return verdictOf(answer.verdict, 'server', argsHash)
  })
}

export type OutputCall = { readonly rawTool: string; readonly text: string; readonly argsHash: string | null; readonly agentId?: string }

export async function judgeOutput(call: OutputCall, ctx: JudgeContext): Promise<Judgment> {
  if (ctx.revoked) return faultOf({ kind: 'key-rejected', status: 401 }, call.argsHash)
  const { host, authorization } = ctx
  if (host === null || authorization === null) return faultOf({ kind: 'no-key' }, call.argsHash)
  const { normalized: tool, isNativeTool } = normalizeToolName(call.rawTool)
  const wire: WireCall = {
    rawTool: call.rawTool,
    tool,
    argsHash: call.argsHash,
    serialized: call.text.slice(0, ctx.scanWindow),
    phase: 'evidence',
    ...(call.agentId !== undefined ? { agentId: call.agentId } : {}),
  }
  // Only a local BLOCK stands on this leg (tier.ts); any other local answer goes to the server.
  const local = await localStep(wire, isNativeTool, ctx.indexRevision(), host, authorization, ctx)
  if (local !== null) return local.judgment
  const answer = await askServer(host, authorization, wire, ctx)
  return 'fault' in answer ? faultOf(answer.fault, call.argsHash) : verdictOf(answer.verdict, 'server', call.argsHash)
}

export const scanWindowDefault = PII_SCAN_MAX_CHARS_FALLBACK
