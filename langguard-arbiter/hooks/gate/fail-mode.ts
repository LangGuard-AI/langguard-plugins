import type { ArbiterFault, ArbiterMode, ArbiterVerdict } from '../../types'
import type { Decision, DeniedBy, Judgment, Seam } from './machine.ts'

export const MODEL = {
  block: 'Blocked by an organization policy. The call did not run. Do not retry this call. Do not use another tool to get the same result.',
  no_person: 'This call needs a person to confirm it, and no person can confirm it in this session. The call did not run. Do not retry this call. Tell the user.',
  unchecked: 'LangGuard could not check this call, so the call did not run. Do not retry this call now. Tell the user that LangGuard could not check it.',
  setup: 'LangGuard is not set up on this computer, so the call did not run. Tell the user to run /langguard status.',
  changed: 'The arguments of this call changed after LangGuard checked it, so the call did not run. Do not retry this call. Tell the user.',
  mod_call: 'LangGuard did not permit this call from a plugin.',
  config: 'LangGuard did not permit this change to its settings.',
} as const

export const ASK = {
  reason_policy: 'An organization policy asks you to confirm this call',
  notice_policy: 'Asked by LangGuard',
  reason_unchecked: (cause: string) => `LangGuard could not check this call. ${cause}`,
  reason_setup: 'LangGuard is not set up, so it could not check this call. Your answer covers this same call until LangGuard is set up.',
  reason_error: 'LangGuard had an internal error and could not check this call.',
  notice_unchecked: "LangGuard: Not checked. Your organization's policies were not applied to this call.",
} as const

export const CAUSE = {
  unreachable: (hostName: string) => `It cannot reach ${hostName}.`,
  limited: 'The server is limiting requests.',
  bad_reply: 'Its reply could not be read.',
  network_policy: (hostName: string) => `Claude Code network settings block ${hostName}.`,
} as const

export type ModelKey = keyof typeof MODEL

type Row = { readonly coop: ArbiterVerdict; readonly model: ModelKey; readonly reason: 'unchecked' | 'setup' | 'error' }

const ROWS: { readonly [K in ArbiterFault['kind']]: Row } = {
  unreachable: { coop: 'ASK', model: 'unchecked', reason: 'unchecked' },
  'rate-limited': { coop: 'ASK', model: 'unchecked', reason: 'unchecked' },
  'key-rejected': { coop: 'ASK', model: 'setup', reason: 'setup' },
  'key-wrong-type': { coop: 'ASK', model: 'setup', reason: 'setup' },
  'no-key': { coop: 'ASK', model: 'setup', reason: 'setup' },
  'bad-reply': { coop: 'ASK', model: 'unchecked', reason: 'unchecked' },
  'network-policy': { coop: 'ASK', model: 'unchecked', reason: 'unchecked' },
  internal: { coop: 'ASK', model: 'unchecked', reason: 'error' },
  oversize: { coop: 'BLOCK', model: 'block', reason: 'unchecked' },
  'bad-name': { coop: 'BLOCK', model: 'block', reason: 'unchecked' },
}

export const FAULT_KINDS = Object.keys(ROWS) as readonly ArbiterFault['kind'][]

export function resolveFault(fault: ArbiterFault, mode: ArbiterMode, seam: Seam): ArbiterVerdict {
  if (mode === 'strict' || seam === 'mcp.call') return 'BLOCK'
  if (fault.kind === 'internal' && seam === 'tool.call') return 'BLOCK'
  return ROWS[fault.kind].coop
}

export function decide(judgment: Judgment, mode: ArbiterMode, seam: Seam): Decision {
  const effective = judgment.kind === 'verdict' ? judgment.verdict : resolveFault(judgment.fault, mode, seam)
  return { judgment, mode, effective }
}

// Deck strings only: no server reason or violation may reach the model (L15).
export function modelText(decision: Decision | null, by: Exclude<DeniedBy, 'below'>, seam: Seam): string {
  if (seam === 'mcp.call') return MODEL.mod_call
  if (by === 'final-input') return MODEL.changed
  if (by === 'illegal') return MODEL.unchecked
  if (decision === null) return MODEL.unchecked
  if (decision.judgment.kind === 'fault') return MODEL[ROWS[decision.judgment.fault.kind].model]
  if (by === 'no-person') return MODEL.no_person
  return MODEL.block
}

// `hostName` comes from local config, never from a server reply (L15).
export function developerText(decision: Decision, hostName: string): string {
  if (decision.judgment.kind === 'verdict') return ASK.reason_policy
  const { fault } = decision.judgment
  const row = ROWS[fault.kind]
  if (row.reason === 'setup') return ASK.reason_setup
  if (row.reason === 'error') return ASK.reason_error
  switch (fault.kind) {
    case 'rate-limited':
      return ASK.reason_unchecked(CAUSE.limited)
    case 'bad-reply':
      return ASK.reason_unchecked(CAUSE.bad_reply)
    case 'network-policy':
      return ASK.reason_unchecked(CAUSE.network_policy(hostName))
    default:
      return ASK.reason_unchecked(CAUSE.unreachable(hostName))
  }
}

export const isSetupFault = (judgment: Judgment): boolean => judgment.kind === 'fault' && ROWS[judgment.fault.kind].reason === 'setup'

let configured: ArbiterMode = 'cooperative'
let effective: ArbiterMode = 'cooperative'
let pinned = false

export function setConfiguredMode(mode: ArbiterMode, isPinned: boolean): void {
  configured = mode
  effective = mode
  pinned = isPinned
}

// A stored override may only tighten the configured mode (interrogate A10).
export function applyStoredOverride(stored: unknown): ArbiterMode {
  if (pinned) effective = configured
  else if (stored === 'strict') effective = 'strict'
  else if (stored === 'cooperative' && (configured === 'cooperative' || pinned)) effective = configured
  return effective
}

export type ServerModeResult = 'applied' | 'pinned' | 'looser'

// A server command sets the effective mode. A managed pin wins in both directions (F16), even when the command names the pinned mode, and a command may not loosen the mode below the configured one (interrogate A10).
export function applyServerMode(mode: ArbiterMode): ServerModeResult {
  if (pinned) {
    effective = configured
    return 'pinned'
  }
  if (mode === 'strict') {
    effective = 'strict'
    return 'applied'
  }
  effective = configured
  return configured === 'strict' ? 'looser' : 'applied'
}

export const effectiveMode = (): ArbiterMode => effective

let revoked = false

export function setRevoked(value: boolean): void {
  revoked = value
}

export const isRevoked = (): boolean => revoked

let catches = 0

// A .catch handler makes no $ call (R1), so it only counts; the next check or timer tick publishes the count (F6). A throw from below the mod (next called) is not the mod's.
export function noteCatch(nextCalled: boolean): void {
  if (!nextCalled) catches += 1
}

export const catchCount = (): number => catches

export const hostNameOf = (host: string | null): string => (host === null ? 'LangGuard' : host.replace(/^https?:\/\//, ''))
