import type { HttpInit, HttpResponse } from 'claude-code'
import type { ArbiterVerdict } from '../../types'
import { composeVerdict, type ComposeApprovalStatus } from '../vendor/core/decision/verdict-composer.ts'
import {
  HOOKS_SERVER_CONTENT_LIMIT,
  OPA_BUNDLE,
  PII_SCAN_MAX_CHARS_FALLBACK,
  checkpointForHookPhase,
  dropNulls,
  isConfident,
  localPolicyInput,
  type InterceptorViolation,
  type LocalLeg,
  type RiskTier,
} from '../vendor/core/pure.ts'
import { PROBE_MS } from './opa.ts'

// The whole local step, the two revision reads included, has this one budget. A reply after it moves the call to the server.
export const LOCAL_BUDGET_MS = PROBE_MS

// The bundle mirrors the scope map under the tenant id and under "default". The mod cannot know the server-resolved tenant, and the daemon sends the same value when ARBITER_TENANT_ID is unset (bundle-builder.ts collectScope).
export const LOCAL_TENANT = 'default'

export type TierIo = {
  readonly fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  readonly after: (ms: number, fn: () => void) => void
}

// What the session knows about the OPA that it may ask. `allowTier` is the L22b input: true only for a tier (b) install that the managed settings read proves (health/probe.ts allowTierOf). `instance` is the labels.id of the signed OPA that the session attached to.
export type LocalAccess = {
  readonly socketPath: string
  readonly signed: boolean
  readonly instance?: string | null
  readonly allowTier: boolean
  readonly sample: () => boolean
  readonly onMismatch: (found: { readonly rawTool: string; readonly argsHash: string | null; readonly serverVerdict: ArbiterVerdict }) => void
}

// `agentName` and `aiAppId` are the ones of the server request: the rego derives the agent key of a remembered rule from them.
// `text` is what the server would get as `content.args` (enforce) or `content.output` (evidence), cut to the scan window of the mod.
export type LocalCall = {
  readonly tool: string
  readonly rawTool?: string
  readonly isNativeTool: boolean
  readonly agentName?: string
  readonly aiAppId?: string
  // The user name that the verdict request sends. Absent or null: the policy input holds 'unknown', as the server writes it.
  readonly userId?: string | null
  readonly leg: LocalLeg
  readonly text: string
  readonly sessionId: string
  // The scan window of the organization, from the policy index: the server compares it with the length of an argument text it cannot parse. Absent: the window of the mod.
  readonly window?: number
}

// `signed` is false when the process on the socket is not the signed OPA of the attach: after OPA died, another process may hold the socket (review lead note).
export type LocalAnswer = { readonly kind: 'verdict'; readonly verdict: ArbiterVerdict; readonly appliedRule: string; readonly signed: boolean } | { readonly kind: 'server' }

const TO_SERVER: LocalAnswer = { kind: 'server' }

const isRiskTier = (value: unknown): value is RiskTier => value === 'low' || value === 'medium' || value === 'high' || value === 'critical'

const isApprovalStatus = (value: unknown): value is ComposeApprovalStatus => value === 'approved' || value === 'not_approved' || value === 'banned' || value === 'unresolved'

// OPA answers a rule that no loaded document defines with {} and no `result`.
async function resultOf(io: TierIo, socketPath: string, path: string, input?: unknown): Promise<unknown> {
  const response = await io.fetch(`http://localhost/v1/data/${path}`, {
    socketPath,
    ...(input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) }),
  })
  if (response.status !== 200) throw new Error('not ok')
  const body: unknown = JSON.parse(response.text)
  return body !== null && typeof body === 'object' ? (body as { result?: unknown }).result : undefined
}

// The instance that the launch set, read from data.system.authz.instance: the authorization policy refuses GET /v1/config.
async function instanceOf(io: TierIo, socketPath: string): Promise<string | null> {
  const response = await io.fetch('http://localhost/v1/data/system/authz/instance', { socketPath })
  if (response.status !== 200) return null
  const id = (JSON.parse(response.text) as { result?: unknown }).result
  return typeof id === 'string' && id !== '' ? id : null
}

const isViolation = (value: unknown): value is InterceptorViolation => {
  if (value === null || typeof value !== 'object') return false
  const { policy_id: id, status } = value as Record<string, unknown>
  return typeof id === 'string' && (status === 'block' || status === 'notify')
}

// The same rules as clients/arbiter-core/src/decision/local-eval.ts, composed and judged as gate.ts does. The scan window is not read: what the server scans is the mod's to set, not a listener's on the socket (review FO-2).
const UNATTRIBUTED = 'unknown'

const KEY_SHAPE = /^p_[A-Za-z0-9_]{1,200}$/
const MAX_KEYS = 512

type Shipped = { readonly violations: InterceptorViolation[]; readonly server: boolean }

// `rawKeys` undefined: a bundle of an older shape that ships no policy module. Anything the rego does not answer in the expected shape counts as "server" for the call.
async function shippedOutcomes(io: TierIo, socketPath: string, rawKeys: unknown, input: unknown): Promise<Shipped> {
  if (rawKeys === undefined) return { violations: [], server: false }
  if (!Array.isArray(rawKeys) || rawKeys.length > MAX_KEYS) return { violations: [], server: true }
  const keys = rawKeys.filter((key): key is string => typeof key === 'string' && KEY_SHAPE.test(key))
  const outcomes = await Promise.all(keys.map(key => resultOf(io, socketPath, `langguard/violations/policy_outcome/${key}`, input).catch((): 'error' => 'error')))
  const violations: InterceptorViolation[] = []
  let server = keys.length !== rawKeys.length
  for (const outcome of outcomes) {
    const { violation, clean } = (outcome !== null && typeof outcome === 'object' ? outcome : {}) as { violation?: unknown; clean?: unknown }
    if (clean === true) continue
    if (isViolation(violation)) violations.push(violation)
    else server = true
  }
  return { violations, server }
}

async function evaluate(call: LocalCall, access: LocalAccess, io: TierIo, expectedRevision: string): Promise<LocalAnswer> {
  const checkpoint = checkpointForHookPhase(call.leg)
  const { socketPath } = access
  const revision = (): Promise<unknown> => resultOf(io, socketPath, `system/bundles/${OPA_BUNDLE}/manifest/revision`)
  if ((await revision()) !== expectedRevision) return TO_SERVER
  const agentName = call.agentName ?? UNATTRIBUTED
  // The input of the policies that ship: the input that the server builds for this call, under `policy_input`. The rest is the input of the rules of the aggregator.
  const policyInput = dropNulls(
    localPolicyInput({
      tool: call.tool,
      sessionId: call.sessionId,
      agentName,
      aiAppId: call.aiAppId ?? `${agentName}:${call.sessionId}`,
      userId: call.userId,
      leg: call.leg,
      text: call.text,
      truncationLimits: [HOOKS_SERVER_CONTENT_LIMIT, call.window ?? PII_SCAN_MAX_CHARS_FALLBACK],
    }),
  )
  const input = {
    tool: call.tool,
    raw_tool: call.rawTool ?? call.tool,
    tenant_id: LOCAL_TENANT,
    session_actions: [],
    ...(checkpoint ? { phase: checkpoint } : {}),
    ...(call.agentName === undefined ? {} : { agent_name: call.agentName }),
    ...(call.aiAppId === undefined ? {} : { ai_app_id: call.aiAppId }),
    policy_input: policyInput,
  }
  const [instance, rawTier, rawViolations, rawApproval, rawMode, rawRemoteOnly, rawServerPolicy, rawKeys] = await Promise.all([
    access.signed ? instanceOf(io, socketPath).catch(() => null) : Promise.resolve(null),
    resultOf(io, socketPath, 'langguard/scope_tier/tier', input),
    resultOf(io, socketPath, 'langguard/violations/result', input),
    resultOf(io, socketPath, 'langguard/violations/approval_status', input),
    resultOf(io, socketPath, 'langguard/violations/effective_mode', input),
    resultOf(io, socketPath, 'langguard/violations/remote_only_classes_active', input),
    resultOf(io, socketPath, 'langguard/violations/server_policy_applies', input),
    resultOf(io, socketPath, 'langguard/violations/local_keys', input),
  ])
  // Each shipped policy answers for itself, so a module that throws costs only its own call (it counts as a policy that stays on the server for this call).
  const shipped = await shippedOutcomes(io, socketPath, rawKeys, input)
  if ((await revision()) !== expectedRevision) return TO_SERVER
  if (typeof rawTier !== 'string') return TO_SERVER

  if (rawViolations !== undefined && !Array.isArray(rawViolations)) return TO_SERVER
  const made = (rawViolations ?? []).filter(isViolation)
  if (made.length !== (rawViolations ?? []).length) return TO_SERVER
  const violations = [...made, ...shipped.violations]
  const approvalAuthoritative = isApprovalStatus(rawApproval)
  const approvalStatus: ComposeApprovalStatus = isApprovalStatus(rawApproval) ? rawApproval : 'unresolved'
  const modeAuthoritative = rawMode === 'enforce' || rawMode === 'permissive'
  const mode = modeAuthoritative && rawMode === 'permissive' ? 'permissive' : 'enforce'
  const remoteOnlyClassesActive = rawRemoteOnly !== false || shipped.server

  const nativeApproved = call.isNativeTool && approvalAuthoritative && approvalStatus !== 'banned'
  const composed = composeVerdict({
    approval_status: nativeApproved ? 'approved' : approvalStatus,
    scope_tier: isRiskTier(rawTier) ? rawTier : null,
    isNativeTool: call.isNativeTool,
    isCatastrophic: false,
    violations,
    engineUnreachable: false,
    mode,
  })
  const confident = isConfident(composed.appliedRule, { isNativeTool: call.isNativeTool && approvalAuthoritative, approvalStatus, approvalAuthoritative, modeAuthoritative, mode, remoteOnlyClassesActive })
  if (!confident) return TO_SERVER
  // A policy that stays on the server applies to this call: only a BLOCK stands. A BLOCK of a policy that ran here is a block on the server too; the server answers ASK instead only when it cannot evaluate another policy, and the machine is then the stricter side.
  if (composed.verdict !== 'BLOCK' && (rawServerPolicy === true || shipped.server)) return TO_SERVER
  // The evidence leg: the output is read by the server for the classes that run only there, so only a BLOCK stands here.
  if (call.leg === 'evidence' && composed.verdict !== 'BLOCK') return TO_SERVER
  const signed = access.signed && typeof access.instance === 'string' && instance === access.instance
  return { kind: 'verdict', verdict: composed.verdict, appliedRule: composed.appliedRule, signed }
}

export async function askLocal(call: LocalCall, access: LocalAccess, io: TierIo, expectedRevision: string): Promise<LocalAnswer> {
  const late = new Promise<LocalAnswer>(resolve => {
    io.after(LOCAL_BUDGET_MS, () => resolve(TO_SERVER))
  })
  const work = evaluate(call, access, io, expectedRevision).catch((): LocalAnswer => TO_SERVER)
  return Promise.race([work, late])
}

// A local ALLOW stands only under a signed bundle (an unsigned one on disk can be edited) and on an install that the operator trusts with it (L22).
export const allowStands = (access: LocalAccess): boolean => access.signed && access.allowTier

// In tier (c) or unknown only a local BLOCK stands: a squatted socket can answer a confident ASK for a call that the server blocks (L22a).
export const askStands = (access: LocalAccess): boolean => access.allowTier
