import type { Timer } from 'claude-code'
import type { ArbiterCallView, ArbiterLedger, ArbiterMode } from '../types'
import { sanitize } from './ui/text.ts'
import { ABSENT, step, type CallRef, type Decision, type GateEvent, type GatedCall, type Seam, type Step } from './gate/machine.ts'

const records = new Map<string, GatedCall>()
const order: string[] = []
const withheld = new Map<string, Withheld>()
const agentLabels = new Map<string, string | null>()
const slowTimers = new Map<string, Timer>()
const slow = new Set<string>()

export type Withheld = 'policy' | 'fault'

// Bounds the ledger so a plugin that queries $.tool.check with fabricated ids cannot grow module memory or published state.
export const MAX_RECORDS = 500

export function recordOf(id: string): GatedCall {
  return records.get(id) ?? ABSENT
}

// One id can hold several records: tool.call keys a call that reuses an open id as `id#n` (SC7). A tool.check must land on the record of its own call,
// because a record keeps the call it began with. A check for a tool that holds no record of the id gets a key of its own, `id#c<n>`: it must not
// rewrite the record of a call that already ran, and it is judged as a call of its own (fail closed).
let checkKeys = 0

export function recordIdForCheck(id: string, rawTool: string, finalHash: string | null): string {
  const newestFirst = order.filter(key => key === id || key.startsWith(`${id}#`)).reverse()
  const toolOf = (key: string): string | null => {
    const record = records.get(key)
    return record === undefined || record.phase === 'absent' ? null : record.call.rawTool
  }
  const hashOf = (key: string): string | null => {
    const record = records.get(key)
    return record === undefined || record.phase === 'absent' || record.phase === 'judging' ? null : (record.decision?.judgment.argsHash ?? null)
  }
  const sameTool = newestFirst.filter(key => toolOf(key) === rawTool)
  const own = sameTool.find(key => finalHash !== null && hashOf(key) === finalHash) ?? sameTool.find(key => recordOf(key).phase !== 'settled') ?? sameTool[0]
  if (own !== undefined) return own
  if (newestFirst.length === 0) return id
  checkKeys += 1
  return `${id}#c${checkKeys}`
}

export type AskingCall = Extract<GatedCall, { phase: 'asking' }>

// The call at PreToolUse is the newest record of its id with the same tool and arguments. An older record of a reused id never stands for it.
export function askingRecordFor(id: string, rawTool: string, argsHash: string): AskingCall | null {
  for (const key of [...order].reverse()) {
    if (key !== id && !key.startsWith(`${id}#`)) continue
    const record = records.get(key)
    if (record === undefined || record.phase === 'absent' || record.phase === 'judging') continue
    if (record.call.rawTool === rawTool && record.decision?.judgment.argsHash === argsHash) return record.phase === 'asking' ? record : null
  }
  return null
}

function evict(): void {
  while (order.length > MAX_RECORDS) {
    const at = order.findIndex(id => records.get(id)?.phase !== 'judging')
    if (at < 0) return
    const id = order[at] as string
    records.delete(id)
    withheld.delete(id)
    stopSlow(id)
    order.splice(at, 1)
  }
}

export function apply(id: string, event: GateEvent, ctx: { readonly seam: Seam; readonly mode: ArbiterMode }): Step {
  const before = recordOf(id)
  const result = step(before, event, ctx)
  if (before.phase === 'absent' && result.state.phase !== 'absent') order.push(id)
  records.set(id, result.state)
  if (result.state.phase !== 'judging') stopSlow(id)
  evict()
  return result
}

export const SLOW_AFTER_MS = 1000

export function watchSlow(id: string, timer: Timer): void {
  slowTimers.get(id)?.cancel()
  slowTimers.set(id, timer)
}

function stopSlow(id: string): void {
  slowTimers.get(id)?.cancel()
  slowTimers.delete(id)
  slow.delete(id)
}

// True when the flag changed, so the caller publishes the view.
export function markSlow(id: string): boolean {
  slowTimers.delete(id)
  if (recordOf(id).phase !== 'judging' || slow.has(id)) return false
  slow.add(id)
  return true
}

export function settleAtResult(call: CallRef, at: number): GatedCall {
  const ctx = { seam: 'tool.call', mode: 'strict' } as const
  if (recordOf(call.id).phase === 'absent') apply(call.id, { type: 'begin', call, at }, ctx)
  if (recordOf(call.id).phase !== 'settled') apply(call.id, { type: 'unwound', result: 'ran', at }, ctx)
  return recordOf(call.id)
}

export function markWithheld(call: CallRef, why: Withheld, at: number): void {
  if (recordOf(call.id).phase === 'absent') {
    order.push(call.id)
    records.set(call.id, { phase: 'settled', effective: 'ran', call, decision: null, isError: false, at })
  }
  withheld.set(call.id, why)
  evict()
}

export const AGENT_LABEL_COLUMNS = 32

export const needsAgentLabel = (agentId: string): boolean => !agentLabels.has(agentId)

// null caches a missing name, so $.agent.list() is not asked again for that agent.
export function noteAgentLabel(agentId: string, name: string | undefined): void {
  if (agentLabels.size >= MAX_RECORDS) agentLabels.delete(agentLabels.keys().next().value as string)
  const label = name === undefined ? '' : sanitize(name, AGENT_LABEL_COLUMNS)
  agentLabels.set(agentId, label === '' ? null : label)
}

// Section 5, interrogate A4: an oversize or badly named input is a BLOCK in both modes, drawn and counted as one.
const isInputFault = (decision: Decision): boolean => decision.judgment.kind === 'fault' && (decision.judgment.fault.kind === 'oversize' || decision.judgment.fault.kind === 'bad-name')

const isFaultOutcome = (record: GatedCall): boolean =>
  record.phase === 'settled' && (record.effective === 'ran-unchecked' || (record.effective === 'denied' && (record.by === 'final-input' || record.by === 'illegal')))

export function counts(): ArbiterLedger['counts'] {
  const out = { checked: 0, allowed: 0, asked: 0, blocked: 0, withheld: 0, faults: 0 }
  for (const id of order) {
    const record = records.get(id)
    if (!record || record.phase === 'absent' || record.phase === 'judging') continue
    if (isFaultOutcome(record)) {
      out.checked += 1
      out.faults += 1
      continue
    }
    const why = withheld.get(id)
    if (why !== undefined) {
      out.checked += 1
      if (why === 'policy') out.withheld += 1
      else out.faults += 1
      continue
    }
    const decision = record.decision
    if (!decision) continue
    out.checked += 1
    if (decision.judgment.kind === 'fault' && !isInputFault(decision)) out.faults += 1
    else if (decision.effective === 'ALLOW') out.allowed += 1
    else if (decision.effective === 'BLOCK') out.blocked += 1
    else if (record.phase === 'settled' && record.effective === 'denied' && record.by === 'no-person') out.blocked += 1
    else out.asked += 1
  }
  return out
}

export const ledgerView = (): ArbiterLedger => ({ order: [...order], counts: counts() })

const serverOf = (call: CallRef): string => call.tool.split('.')[0] ?? call.tool

export function callView(id: string, at: number): ArbiterCallView | null {
  const record = records.get(id)
  if (!record || record.phase === 'absent') return null
  const view: ArbiterCallView = { id, tool: record.call.tool, server: serverOf(record.call), phase: record.phase, at }
  if (record.call.agentId !== undefined) {
    view.agentId = record.call.agentId
    const label = agentLabels.get(record.call.agentId)
    if (label) view.agentLabel = label
  }
  const decision = record.phase === 'judging' ? null : record.decision
  if (isFaultOutcome(record)) {
    view.from = 'fault'
    view.verdict = 'BLOCK'
  } else if (decision) {
    if (isInputFault(decision)) {
      view.from = 'server'
      view.verdict = 'BLOCK'
    } else if (decision.judgment.kind === 'fault') {
      view.from = 'fault'
      if (decision.effective === 'ALLOW') view.verdict = 'ALLOW'
      else if (decision.effective === 'BLOCK' || (record.phase === 'settled' && record.effective === 'denied')) view.verdict = 'BLOCK'
      else view.verdict = 'ASK'
    } else {
      view.from = decision.judgment.from === 'cache' ? 'cache' : 'server'
      view.verdict = record.phase === 'settled' && record.effective === 'denied' && record.by === 'no-person' ? 'BLOCK' : decision.effective
    }
  }
  if (record.phase === 'judging' && slow.has(id)) view.slow = true
  if (record.phase === 'settled') view.outcome = record.effective
  const why = withheld.get(id)
  if (why !== undefined) view.withheld = why
  return view
}
