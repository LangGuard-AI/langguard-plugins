import type { ArbiterFault, ArbiterMode, ArbiterVerdict } from '../../types'

export type Seam = 'tool.call' | 'tool.check' | 'mcp.call'

export type RaisedBy = 'model' | { readonly plugin: string }

export type CallRef = {
  readonly id: string
  readonly rawTool: string
  readonly tool: string
  readonly agentId?: string
  readonly raisedBy: RaisedBy
}

export type Judgment =
  | { readonly kind: 'verdict'; readonly verdict: ArbiterVerdict; readonly from: 'server' | 'cache' | 'local'; readonly argsHash: string | null }
  | { readonly kind: 'fault'; readonly fault: ArbiterFault; readonly argsHash: string | null }

export type Decision = { readonly judgment: Judgment; readonly mode: ArbiterMode; readonly effective: ArbiterVerdict }

export type Answerer = 'engine-dialog' | 'none'

export type DeniedBy = 'policy' | 'fail-mode' | 'final-input' | 'no-person' | 'below' | 'illegal'

export type Settled =
  | { readonly phase: 'settled'; readonly effective: 'ran'; readonly call: CallRef; readonly decision: Decision | null; readonly isError: boolean; readonly at: number }
  | { readonly phase: 'settled'; readonly effective: 'denied'; readonly call: CallRef; readonly decision: Decision | null; readonly by: DeniedBy; readonly at: number }
  | { readonly phase: 'settled'; readonly effective: 'aborted'; readonly call: CallRef; readonly decision: Decision | null; readonly at: number }
  | { readonly phase: 'settled'; readonly effective: 'ran-unchecked'; readonly call: CallRef; readonly decision: Decision | null; readonly at: number }

export type GatedCall =
  | { readonly phase: 'absent' }
  | { readonly phase: 'judging'; readonly call: CallRef; readonly since: number }
  | { readonly phase: 'cleared'; readonly call: CallRef; readonly decision: Decision }
  | { readonly phase: 'asking'; readonly call: CallRef; readonly decision: Decision; readonly checkSeen: boolean }
  | Settled

export type GateEvent =
  | { readonly type: 'begin'; readonly call: CallRef; readonly at: number }
  | { readonly type: 'judged'; readonly decision: Decision; readonly answerer: Answerer; readonly at: number }
  | { readonly type: 'check-seen'; readonly rawTool: string; readonly finalHash: string | null; readonly at: number }
  | { readonly type: 'aborted'; readonly at: number }
  | { readonly type: 'unwound'; readonly result: 'ran' | 'ran-error' | 'denied-below'; readonly at: number }

export type Action =
  | { readonly kind: 'none' }
  | { readonly kind: 'next' }
  | { readonly kind: 'deny'; readonly by: Exclude<DeniedBy, 'below'> }
  | { readonly kind: 'rejudge' }
  | { readonly kind: 'strictest' }
  | { readonly kind: 'ask' }

export type Step = { readonly state: GatedCall; readonly action: Action }

export const PHASES = ['absent', 'judging', 'cleared', 'asking', 'settled'] as const
export const EVENT_TYPES = ['begin', 'judged', 'check-seen', 'aborted', 'unwound'] as const

export const ABSENT: GatedCall = { phase: 'absent' }

const ILLEGAL_CALL: CallRef = { id: '', rawTool: '', tool: '', raisedBy: 'model' }

function callOf(state: GatedCall): CallRef {
  return state.phase === 'absent' ? ILLEGAL_CALL : state.call
}

function decisionOf(state: GatedCall): Decision | null {
  return state.phase === 'cleared' || state.phase === 'asking' ? state.decision : state.phase === 'settled' ? state.decision : null
}

function illegal(state: GatedCall, event: GateEvent, mode: ArbiterMode): Step {
  const call = event.type === 'begin' ? event.call : callOf(state)
  const at = event.at
  if (mode === 'strict') {
    return { state: { phase: 'settled', effective: 'denied', call, decision: decisionOf(state), by: 'illegal', at }, action: { kind: 'deny', by: 'illegal' } }
  }
  return { state: { phase: 'judging', call, since: at }, action: { kind: 'rejudge' } }
}

function judged(call: CallRef, decision: Decision, answerer: Answerer, at: number): Step {
  if (decision.effective === 'ALLOW') return { state: { phase: 'cleared', call, decision }, action: { kind: 'next' } }
  if (decision.effective === 'BLOCK') {
    const by = decision.judgment.kind === 'verdict' ? 'policy' : 'fail-mode'
    return { state: { phase: 'settled', effective: 'denied', call, decision, by, at }, action: { kind: 'deny', by } }
  }
  if (answerer === 'none') return { state: { phase: 'settled', effective: 'denied', call, decision, by: 'no-person', at }, action: { kind: 'deny', by: 'no-person' } }
  return { state: { phase: 'asking', call, decision, checkSeen: false }, action: { kind: 'next' } }
}

function changedHash(state: GatedCall, finalHash: string | null, mode: ArbiterMode, at: number): Step {
  const call = callOf(state)
  if (mode === 'strict' && finalHash !== null) {
    return { state: { phase: 'settled', effective: 'denied', call, decision: decisionOf(state), by: 'final-input', at }, action: { kind: 'deny', by: 'final-input' } }
  }
  return { state: { phase: 'judging', call, since: at }, action: { kind: 'rejudge' } }
}

function sameHash(state: GatedCall, rawTool: string, finalHash: string | null): boolean {
  const decision = decisionOf(state)
  return finalHash !== null && decision !== null && callOf(state).rawTool === rawTool && decision.judgment.argsHash === finalHash
}

export function step(state: GatedCall, event: GateEvent, ctx: { readonly seam: Seam; readonly mode: ArbiterMode }): Step {
  const { mode } = ctx
  switch (state.phase) {
    case 'absent':
      switch (event.type) {
        case 'begin':
          return { state: { phase: 'judging', call: event.call, since: event.at }, action: { kind: 'none' } }
        case 'check-seen':
          return { state: { phase: 'judging', call: ILLEGAL_CALL, since: event.at }, action: { kind: 'rejudge' } }
        case 'judged':
        case 'aborted':
        case 'unwound':
          return illegal(state, event, mode)
      }
      break
    case 'judging':
      switch (event.type) {
        case 'judged':
          return judged(state.call, event.decision, event.answerer, event.at)
        case 'check-seen':
          return { state, action: { kind: 'rejudge' } }
        case 'unwound':
          return { state: { phase: 'settled', effective: 'ran-unchecked', call: state.call, decision: null, at: event.at }, action: { kind: 'none' } }
        case 'aborted':
          return { state: { phase: 'settled', effective: 'aborted', call: state.call, decision: null, at: event.at }, action: { kind: 'none' } }
        case 'begin':
          return illegal(state, event, mode)
      }
      break
    case 'cleared':
      switch (event.type) {
        case 'check-seen':
          return sameHash(state, event.rawTool, event.finalHash) ? { state, action: { kind: 'strictest' } } : changedHash(state, event.finalHash, mode, event.at)
        case 'unwound':
          return event.result === 'denied-below'
            ? { state: { phase: 'settled', effective: 'denied', call: state.call, decision: state.decision, by: 'below', at: event.at }, action: { kind: 'none' } }
            : { state: { phase: 'settled', effective: 'ran', call: state.call, decision: state.decision, isError: event.result === 'ran-error', at: event.at }, action: { kind: 'none' } }
        case 'aborted':
          return { state: { phase: 'settled', effective: 'aborted', call: state.call, decision: state.decision, at: event.at }, action: { kind: 'none' } }
        case 'begin':
        case 'judged':
          return illegal(state, event, mode)
      }
      break
    case 'asking':
      switch (event.type) {
        case 'check-seen':
          return sameHash(state, event.rawTool, event.finalHash) ? { state: { ...state, checkSeen: true }, action: { kind: 'ask' } } : changedHash(state, event.finalHash, mode, event.at)
        case 'unwound':
          if (event.result === 'denied-below') {
            return { state: { phase: 'settled', effective: 'denied', call: state.call, decision: state.decision, by: 'below', at: event.at }, action: { kind: 'none' } }
          }
          if (!state.checkSeen) return { state: { phase: 'settled', effective: 'ran-unchecked', call: state.call, decision: state.decision, at: event.at }, action: { kind: 'none' } }
          return { state: { phase: 'settled', effective: 'ran', call: state.call, decision: state.decision, isError: event.result === 'ran-error', at: event.at }, action: { kind: 'none' } }
        case 'aborted':
          return { state: { phase: 'settled', effective: 'aborted', call: state.call, decision: state.decision, at: event.at }, action: { kind: 'none' } }
        case 'begin':
        case 'judged':
          return illegal(state, event, mode)
      }
      break
    case 'settled':
      switch (event.type) {
        case 'check-seen':
          return { state: { phase: 'judging', call: state.call, since: event.at }, action: { kind: 'rejudge' } }
        case 'begin':
        case 'judged':
        case 'aborted':
        case 'unwound':
          return illegal(state, event, mode)
      }
      break
  }
  return illegal(state, event, mode)
}

export const SELF_ANSWERING_MODES: readonly string[] = []

export function whoAnswers(
  facts: { readonly isInteractive: boolean | null; readonly recordedMode: string | null; readonly desktopAskFallback: boolean },
  selfAnswering: readonly string[] = SELF_ANSWERING_MODES,
): Answerer {
  if (facts.desktopAskFallback) return 'engine-dialog'
  if (facts.isInteractive === false) return 'none'
  if (facts.recordedMode !== null && selfAnswering.includes(facts.recordedMode)) return 'none'
  return 'engine-dialog'
}
