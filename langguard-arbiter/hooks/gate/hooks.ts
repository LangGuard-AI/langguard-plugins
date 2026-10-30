import type { CatchHandler, EngineInterface, Hook, Origin, PreToolUseResult, ToolCallInput } from 'claude-code'
import { loadedOptions } from '../config.ts'
import { SLOW_AFTER_MS, apply, askingRecordFor, callView, ledgerView, markSlow, needsAgentLabel, noteAgentLabel, recordIdForCheck, recordOf, watchSlow } from '../ledger.ts'
import { hashInput, judge, scanWindowDefault, serializeInput, type JudgeContext, type JudgeIo } from '../verdict/source.ts'
import { currentInstallId, localAccess, noteCatches, noteJudgment, noteLocalOff, sessionFacts } from '../state.ts'
import { statusChanged, statusLineOf, statusShown } from '../ui/status.ts'
import type { ArbiterHealth } from '../../types'
import type { Judgment } from './machine.ts'
import { noteAskResolved, noteDecision, noteLocalMismatch } from '../evidence/queue.ts'
import { indexFresh, indexRevision, indexScanWindow, remoteOnlyActive } from '../posture/index.ts'
import type { LocalAccess } from '../local/tier.ts'
import { normalizeToolName } from '../vendor/claude/tool-normalize.ts'
import { ASK, MODEL, catchCount, decide, developerText, effectiveMode, hostNameOf, isRevoked, isSetupFault, modelText, noteCatch } from './fail-mode.ts'
import { whoAnswers, type Action, type Answerer, type CallRef, type Decision, type GatedCall, type RaisedBy, type Seam, type Step } from './machine.ts'

// The engine moves an argument whose name collides with a reserved key of `e`
// (an argument named `tool`) under `$shadowed` (measured on Claude Code).
const SHADOWED = '$shadowed'
const CALL = { plugin: 'langguard-arbiter', key: 'call' } as const
const LEDGER = { plugin: 'langguard-arbiter', key: 'ledger' } as const
const HEALTH = { plugin: 'langguard-arbiter', key: 'health' } as const
const RESERVED_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent', SHADOWED])

// L5 remembers an answer only when the mod observed it in a dialog (interrogate A6).
export const DIALOG_MODES: ReadonlySet<string> = new Set(['default', 'acceptEdits'])
const remembered = new Set<string>()
const observedAsks = new Map<string, string | null>()

const rememberKey = (rawTool: string, argsHash: string): string => `${rawTool}|${argsHash}`

function rememberIfDialog(key: string): void {
  const mode = observedAsks.get(key)
  if (mode === undefined) return
  observedAsks.delete(key)
  if (mode !== null && DIALOG_MODES.has(mode)) remembered.add(key)
}

// The engine lets a plugin raise $.tool.call under the id of an open call, so a collision gets its own ledger id (SC7).
let collisions = 0
function ledgerIdFor(id: string): string {
  if (recordOf(id).phase === 'absent') return id
  collisions += 1
  return `${id}#${collisions}`
}

const raisedByOf = (origin: Origin): RaisedBy => (origin.plugin === 'engine' ? 'model' : { plugin: origin.plugin })

export function inputOf(e: ToolCallInput): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(e)) if (!RESERVED_KEYS.has(key)) input[key] = value
  const shadowed = (e as Record<string, unknown>)[SHADOWED]
  if (shadowed !== null && typeof shadowed === 'object') Object.assign(input, shadowed as Record<string, unknown>)
  return input
}

// The engine spells a server name inside a tool name with `_` for every
// character outside letters, digits, `_` and `-`.
export const toolNameSpelling = (server: string): string => server.replace(/[^A-Za-z0-9_-]/g, '_')

function callRefOf(id: string, rawTool: string, agentId: string | undefined, origin: Origin): CallRef {
  const { normalized } = normalizeToolName(rawTool)
  return { id, rawTool, tool: normalized, ...(agentId !== undefined ? { agentId } : {}), raisedBy: raisedByOf(origin) }
}

// Also in evidence/append.ts: `claude plugin validate` follows $ into a function of the same file. Across an import it refuses a function expression on every engine, and a function declaration before Claude Code 2.1.299, which accepts a declaration; keep $ in the file of the call.
function ioFor($: EngineInterface): JudgeIo {
  return {
    now: () => $.clock.now(),
    fetch: (url, init) => $.http.fetch(url, init),
    after: (ms, fn) => {
      $.clock.after(ms, fn)
    },
  }
}

export function judgeContext(io: JudgeIo, local: LocalAccess | null = null): JudgeContext {
  const { config } = loadedOptions()
  return {
    host: config.host,
    authorization: config.key?.header() ?? null,
    revoked: isRevoked(),
    sessionId: sessionFacts().sessionId,
    userId: sessionFacts().userId,
    installId: currentInstallId(),
    indexRevision,
    remoteOnlyActive: remoteOnlyActive(),
    scanWindow: scanWindowDefault,
    tenantWindow: indexScanWindow(),
    io,
    local,
    indexFresh,
  }
}

// A recorded local ALLOW that the server answered differently turns the local tier off and queues one evidence event. It runs after the verdict went out, so it makes no gate decision.
function mismatchHandler($: EngineInterface): LocalAccess['onMismatch'] {
  return found => {
    showHealth($, noteLocalOff(found.revision))
    noteLocalMismatch({ rawTool: found.rawTool }, found.serverVerdict, found.argsHash, Date.now())
  }
}

const contextFor = ($: EngineInterface): JudgeContext => judgeContext(ioFor($), localAccess(mismatchHandler($)))

// Also in state.ts and evidence/append.ts: `claude plugin validate` follows $ only into a function declared in the same file.
function showHealth($: EngineInterface, health: ArbiterHealth): void {
  void $.state.set(HEALTH, health).catch(() => {})
  const text = statusLineOf(health.reasons, effectiveMode(), hostName())
  if (!statusChanged(text)) return
  try {
    $.ui.status(text)
    statusShown(text)
  } catch {
    return
  }
}

// A health publish that throws must not reach the .catch handler, which would deny a call the server allowed.
function noteHealth($: EngineInterface, judgment: Judgment, at: number): void {
  try {
    const health = noteJudgment(judgment, at)
    if (health !== null) showHealth($, health)
    const caught = noteCatches(catchCount())
    if (caught !== null) showHealth($, caught)
  } catch {
    return
  }
}

// SC3: off the verdict path; a clock that fails leaves the call with no tail.
function startSlowTimer($: EngineInterface, id: string, at: number): void {
  try {
    watchSlow(
      id,
      $.clock.after(SLOW_AFTER_MS, () => {
        if (markSlow(id)) publish($, id, at)
      }),
    )
  } catch {
    return
  }
}

function publish($: EngineInterface, id: string, at: number): void {
  const view = callView(id, at)
  if (view) void $.state.set({ ...CALL, id }, view).catch(() => {})
  void $.state.set(LEDGER, ledgerView()).catch(() => {})
}

// Off the verdict path: a slow or failed $.agent.list() leaves the call without a label (SC4).
async function labelAgent($: EngineInterface, agentId: string, id: string, at: number): Promise<void> {
  const agents = await $.agent.list().catch(() => null)
  if (agents === null) return
  noteAgentLabel(agentId, agents.find(agent => agent.id === agentId)?.name)
  publish($, id, at)
}

const noticeOf = (decision: Decision | null): string | null =>
  decision === null ? null : decision.judgment.kind === 'verdict' ? ASK.notice_policy : ASK.notice_unchecked

const decisionOf = (state: GatedCall): Decision | null => (state.phase === 'cleared' || state.phase === 'asking' || state.phase === 'settled' ? state.decision : null)

// The ASK that a person answered may be the one tool.check raised after a later mod changed the arguments, so the settled record names it before the tool.call decision does.
function askedDecision(id: string, local: Decision): Decision | null {
  const settled = decisionOf(recordOf(id))
  return settled?.effective === 'ASK' ? settled : local.effective === 'ASK' ? local : null
}

const hostName = (): string => hostNameOf(loadedOptions().config.host)

function denyText(state: GatedCall, action: Extract<Action, { kind: 'deny' }>, seam: Seam): string {
  return modelText(decisionOf(state), action.by, seam)
}

export function withRememberedAnswer(decision: Decision, rawTool: string, memory: ReadonlySet<string> = remembered): Decision {
  if (decision.mode !== 'cooperative' || decision.effective !== 'ASK' || !isSetupFault(decision.judgment)) return decision
  const argsHash = decision.judgment.argsHash
  if (argsHash === null || !memory.has(rememberKey(rawTool, argsHash))) return decision
  return { ...decision, effective: 'ALLOW' }
}

const answererFor = (raisedBy: RaisedBy): Answerer => {
  if (raisedBy !== 'model') return 'none'
  const { isInteractive, desktopAskFallback } = sessionFacts()
  return whoAnswers({ isInteractive, recordedMode: null, desktopAskFallback })
}

export const gateToolCall: Hook<'tool.call'> = async ($, e, next) => {
  const at = await $.clock.now()
  const mode = effectiveMode()
  const ctx = { seam: 'tool.call' as const, mode }
  const id = ledgerIdFor(e.tool_use_id)
  const call = callRefOf(id, e.tool, e.agentId, next.origin)
  apply(id, { type: 'begin', call, at }, ctx)
  if (e.agentId !== undefined && needsAgentLabel(e.agentId)) void labelAgent($, e.agentId, id, at).catch(() => {})
  startSlowTimer($, id, at)

  let judgment: Judgment
  let decision: Decision
  let step: Step
  try {
    judgment = await judge({ rawTool: e.tool, input: inputOf(e), ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) }, contextFor($))
    noteHealth($, judgment, at)
    decision = withRememberedAnswer(decide(judgment, mode, 'tool.call'), e.tool)
    step = apply(id, { type: 'judged', decision, answerer: answererFor(call.raisedBy), at }, ctx)
  } catch (error) {
    settleThrown($, id, mode, at)
    throw error
  }
  const { state, action } = step
  publish($, id, at)
  const evidenceCall = { rawTool: e.tool, toolUseId: e.tool_use_id, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) }
  noteDecision('tool.call', evidenceCall, decision, at)

  if (action.kind === 'deny') {
    if (decision.effective === 'ASK') noteAskResolved('tool.call', evidenceCall, decision, 'denied', at)
    return { deny: denyText(state, action, 'tool.call') }
  }
  if (action.kind !== 'next') return { deny: MODEL.unchecked }

  const ran = await next(e)
  const after = await $.clock.now()
  const current = recordOf(id)
  if (current.phase !== 'settled') {
    apply(id, { type: 'unwound', result: ran.deny !== undefined ? 'denied-below' : ran.isError === true ? 'ran-error' : 'ran', at: after }, ctx)
  }
  // A person's no reaches next as an errored result, the shape of a tool that failed (measured on Claude Code 2.1.287 and 2.1.312), so only a clean result shows a yes.
  const answered = ran.deny !== undefined ? 'denied' : ran.isError === true ? 'errored' : 'ran'
  if (answered === 'ran' && current.phase === 'asking' && current.checkSeen && isSetupFault(decision.judgment) && decision.judgment.argsHash !== null) {
    rememberIfDialog(rememberKey(e.tool, decision.judgment.argsHash))
  }
  const asked = askedDecision(id, decision)
  if (asked !== null) noteAskResolved('tool.call', evidenceCall, asked, answered, after)
  publish($, id, after)
  return ran
}

// The hash of a final input, measured before it is hashed: stableStringify
// recurses, and a hash over an input deeper than the cap would overflow the
// stack (R8). An oversize input has no hash, and the gate judges it again.
export const finalHashOf = async (input: unknown): Promise<string | null> => ('oversize' in serializeInput(input) ? null : hashInput(input))

export const gateToolCheck: Hook<'tool.check'> = async ($, e, next) => {
  if (e.tool_use_id === undefined) return next(e)
  const at = await $.clock.now()
  const mode = effectiveMode()
  const ctx = { seam: 'tool.check' as const, mode }
  const finalHash = await finalHashOf(e.input)
  const id = recordIdForCheck(e.tool_use_id, e.tool, finalHash)
  if (recordOf(id).phase === 'absent') apply(id, { type: 'begin', call: callRefOf(id, e.tool, undefined, next.origin), at }, ctx)
  let { state, action } = apply(id, { type: 'check-seen', rawTool: e.tool, finalHash, at }, ctx)

  if (action.kind === 'rejudge') {
    const prior = state.phase === 'absent' ? null : state.call
    const judgment = await judge({ rawTool: e.tool, input: e.input, ...(prior?.agentId !== undefined ? { agentId: prior.agentId } : {}) }, contextFor($))
    noteHealth($, judgment, at)
    const decision = decide(judgment, mode, 'tool.check')
    noteDecision('tool.check', { rawTool: e.tool, toolUseId: e.tool_use_id, ...(prior?.agentId !== undefined ? { agentId: prior.agentId } : {}) }, decision, at)
    ;({ state, action } = apply(id, { type: 'judged', decision, answerer: answererFor(prior?.raisedBy ?? raisedByOf(next.origin)), at }, ctx))
    if (state.phase === 'asking') ({ state, action } = apply(id, { type: 'check-seen', rawTool: e.tool, finalHash: judgment.argsHash, at }, ctx))
    if (action.kind === 'next') action = { kind: 'strictest' }
  }
  publish($, id, at)

  switch (action.kind) {
    case 'strictest':
      return next(e)
    case 'ask': {
      const below = await next(e)
      if (below.decision === 'deny') return below
      const decision = decisionOf(state)
      const notice = noticeOf(decision)
      if (notice !== null) $.ui.notice(id, notice)
      return { decision: 'ask', reason: decision ? developerText(decision, hostName()) : ASK.reason_error }
    }
    case 'deny':
      return { decision: 'deny', reason: denyText(state, action, 'tool.check') }
    default:
      return { decision: 'deny', reason: MODEL.unchecked }
  }
}

// The dialog of an MCP tool with no allow rule prints the reason of the engine, not the reason of tool.check. The reason of a PreToolUse ask is printed too. The hook asks only for a call that the mod holds as an ASK, with the text of tool.check. It never allows, and for every other call it passes the answer from below.
export const askAtPreToolUse: Hook<'classic.PreToolUse'> = async ($, e, next) => {
  const below = await next(e)
  if (below.deny !== undefined) return below
  const hash = await finalHashOf(inputOf(e))
  const held = hash === null ? null : askingRecordFor(e.tool_use_id, e.tool, hash)
  if (held === null) return below
  const answer: PreToolUseResult = { ask: developerText(held.decision, hostName()) }
  if (below.updatedInput !== undefined) answer.updatedInput = below.updatedInput
  if (below.additionalContext !== undefined) answer.additionalContext = below.additionalContext
  return answer
}

export const gateMcpCall: Hook<'mcp.call'> = async ($, e, next) => {
  const rawTool = e.tool === '' ? `mcp__${toolNameSpelling(e.server)}` : `mcp__${toolNameSpelling(e.server)}__${e.tool}`
  const judgment = await judge({ rawTool, input: e.args ?? {} }, contextFor($))
  noteHealth($, judgment, Date.now())
  const decision = decide(judgment, effectiveMode(), 'mcp.call')
  noteDecision('mcp.call', { rawTool }, decision, Date.now())
  return decision.effective === 'ALLOW' ? next(e) : { deny: MODEL.mod_call }
}

// Only the owner's own /config change may alter an Arbiter row (R10); the engine does not attest a bridge change as the owner's.
export const guardConfig: Hook<'config.set'> = ($, e, next) => (e.origin.kind === 'composer' ? next(e) : { deny: MODEL.config })

// Another plugin's notice must not appear under a call LangGuard is asking about (UX spec section 8 rule 10).
export const guardNotice: Hook<'ui.notice'> = ($, e, next) => {
  if (next.origin.plugin !== $.plugin.name && recordOf(e.tool_use_id).phase === 'asking') return { deny: 'LangGuard is asking about this call; another notice is refused' }
  return next(e)
}

// The mode is readable at classic.PermissionRequest only (probe S9). The
// record keys on tool and input hash, because the event carries no tool_use_id.
export const recordPermissionRequest: Hook<'classic.PermissionRequest'> = async ($, e, next) => {
  const hash = await finalHashOf(e.tool_input)
  if (hash !== null) observedAsks.set(rememberKey(e.tool_name, hash), e.permission_mode ?? null)
  return next(e)
}

// failToolCall denies a call whose hook threw before next, so a record still judging settles as a fault deny, not as a slow call or a later ran-unchecked.
function settleThrown($: EngineInterface, id: string, mode: Decision['mode'], at: number): void {
  if (recordOf(id).phase !== 'judging') return
  const decision: Decision = { judgment: { kind: 'fault', fault: { kind: 'internal', cause: 'throw' }, argsHash: null }, mode, effective: 'BLOCK' }
  apply(id, { type: 'judged', decision, answerer: 'none', at }, { seam: 'tool.call', mode })
  try {
    publish($, id, at)
  } catch {
    return
  }
}

// The .catch handlers: constants that make no $ call (R1, interrogate A3).
export const failToolCall: CatchHandler<Hook<'tool.call'>> = ($, e, next) => {
  noteCatch(next.called)
  return next.called ? next(e) : { deny: MODEL.unchecked }
}

export const failToolCheck: CatchHandler<Hook<'tool.check'>> = async ($, e, next) => {
  noteCatch(next.called)
  if (effectiveMode() === 'strict') return { decision: 'deny', reason: MODEL.unchecked }
  const below = await next(e)
  return below.decision === 'deny' ? below : { decision: 'ask', reason: ASK.reason_error }
}

export const failMcpCall: CatchHandler<Hook<'mcp.call'>> = ($, e, next) => {
  noteCatch(next.called)
  return { deny: MODEL.mod_call }
}

export const failConfigSet: CatchHandler<Hook<'config.set'>> = ($, e, next) => {
  noteCatch(next.called)
  return { deny: MODEL.config }
}
