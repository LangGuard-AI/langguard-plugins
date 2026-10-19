import type { ApiContentBlock, CatchHandler, EngineInterface, Hook, SessionAppendInput, SessionAppendMessage } from 'claude-code'
import { effectiveMode, hostNameOf, noteCatch } from '../gate/fail-mode.ts'
import { loadedOptions } from '../config.ts'
import { statusChanged, statusLineOf, statusShown } from '../ui/status.ts'
import type { ArbiterHealth } from '../../types'
import { judgeContext } from '../gate/hooks.ts'
import type { CallRef, GatedCall, Judgment } from '../gate/machine.ts'
import { callView, ledgerView, markWithheld, recordOf, settleAtResult, type Withheld } from '../ledger.ts'
import { localAccess, noteUncheckedRun, outputInspected } from '../state.ts'
import { noteOutputFault, noteOutputLocalBlock, noteRanUnchecked } from './queue.ts'
import { normalizeToolName } from '../vendor/claude/tool-normalize.ts'
import { judgeOutput, type JudgeIo } from '../verdict/source.ts'

// Fixed text only: no server text may reach the model (L15).
export const MODEL_OUTPUT = {
  withhold: '[LangGuard] Output withheld by an organization policy.',
  withhold_unchecked: '[LangGuard] Output withheld. LangGuard could not check it.',
} as const

const CALL = { plugin: 'langguard-arbiter', key: 'call' } as const
const LEDGER = { plugin: 'langguard-arbiter', key: 'ledger' } as const
const HEALTH = { plugin: 'langguard-arbiter', key: 'health' } as const

const MCP_PREFIX = 'mcp__'
// The engine names the origin tool `unknown` when it finds no call for the row's id.
export const UNKNOWN_TOOL = 'unknown'

export const originToolOf = (e: SessionAppendInput): string => (e.origin?.kind === 'tool' ? e.origin.tool : UNKNOWN_TOOL)

const MCP_RESOURCE_TOOLS: ReadonlySet<string> = new Set(['ReadMcpResourceTool', 'ListMcpResourcesTool'])

export const isInspectedTool = (tool: string): boolean => tool.startsWith(MCP_PREFIX) || tool === UNKNOWN_TOOL || MCP_RESOURCE_TOOLS.has(tool)

export const checksOutput = (value: boolean | 'unknown'): boolean => value !== false

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const text = (block as { text?: unknown } | null)?.text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

export function outputTextOf(message: SessionAppendMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'tool_result') parts.push(textOf(block.content))
    else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

// The engine lets a hook drop media blocks but not change them, so output-carrying blocks are dropped.
const OUTPUT_BLOCKS: ReadonlySet<string> = new Set(['text', 'image', 'document'])

export function placeholderFor(message: SessionAppendMessage, text: string): SessionAppendMessage {
  const content: ApiContentBlock[] = []
  let replaced = false
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === 'tool_result') {
      content.push({ ...block, content: [{ type: 'text', text }] })
      replaced = true
    } else if (block && !OUTPUT_BLOCKS.has(block.type)) content.push(block)
  }
  if (!replaced) content.push({ type: 'text', text })
  return { ...message, content }
}

// An output above the engine's inline limit arrives as a preview; the full
// output stays in a file that no verdict reads.
const PERSISTED_OUTPUT = '<persisted-output>'

export const isPersistedOutput = (message: SessionAppendMessage): boolean =>
  message.content.some(block => block.type === 'tool_result' && textOf(block.content).startsWith(PERSISTED_OUTPUT))

export function toolUseIdsOf(message: SessionAppendMessage): string[] {
  const ids: string[] = []
  for (const block of message.content) if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') ids.push(block.tool_use_id)
  return ids
}

function callRefOf(e: SessionAppendInput, tool: string, id: string): CallRef {
  return { id, rawTool: tool, tool: normalizeToolName(tool).normalized, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}), raisedBy: 'model' }
}

function publishCall($: EngineInterface, id: string, at: number): void {
  const view = callView(id, at)
  if (view) void $.state.set({ ...CALL, id }, view).catch(() => {})
}

function recordWithheld($: EngineInterface, e: SessionAppendInput, tool: string, ids: readonly string[], why: Withheld, at: number): void {
  for (const id of ids) {
    markWithheld(callRefOf(e, tool, id), why, at)
    publishCall($, id, at)
  }
  void $.state.set(LEDGER, ledgerView()).catch(() => {})
}

const didNotRun = (record: GatedCall): boolean => record.phase === 'settled' && (record.effective === 'denied' || record.effective === 'aborted')

const isUncheckedRun = (record: GatedCall): boolean => record.phase === 'settled' && record.effective === 'ran-unchecked'

// The engine unwinds tool.call before it appends the result row (measured on Claude Code), so a record not settled here had no unwind.
const reported = new Set<string>()

function settleRuns($: EngineInterface, e: SessionAppendInput, tool: string, ids: readonly string[], at: number): void {
  const open = ids.filter(id => !reported.has(id) && (recordOf(id).phase !== 'settled' || isUncheckedRun(recordOf(id))))
  for (const id of open) {
    if (isUncheckedRun(settleAtResult(callRefOf(e, tool, id), at))) {
      reported.add(id)
      noteRanUnchecked({ rawTool: tool, toolUseId: id, ...(e.agentId !== undefined ? { agentId: e.agentId } : {}) }, at)
      showHealth($, noteUncheckedRun())
    }
    publishCall($, id, at)
  }
  if (open.length > 0) void $.state.set(LEDGER, ledgerView()).catch(() => {})
}

// Also in gate/hooks.ts and state.ts: `claude plugin validate` follows $ only into a function declared in the same file.
function showHealth($: EngineInterface, health: ArbiterHealth): void {
  void $.state.set(HEALTH, health).catch(() => {})
  const text = statusLineOf(health.reasons, effectiveMode(), hostNameOf(loadedOptions().config.host))
  if (!statusChanged(text)) return
  try {
    $.ui.status(text)
    statusShown(text)
  } catch {
    return
  }
}

// Also in gate/hooks.ts: `claude plugin validate` follows $ into a function of the same file. Across an import it refuses a function expression on every engine, and a function declaration before Claude Code 2.1.299, which accepts a declaration; keep $ in the file of the call.
function ioFor($: EngineInterface): JudgeIo {
  return {
    now: () => $.clock.now(),
    fetch: (url, init) => $.http.fetch(url, init),
    after: (ms, fn) => {
      $.clock.after(ms, fn)
    },
  }
}

async function judgeRow($: EngineInterface, e: SessionAppendInput, tool: string, id: string | undefined): Promise<Judgment> {
  const record = id === undefined ? null : recordOf(id)
  const call = record === null || record.phase === 'absent' ? null : record.call
  const judged = record !== null && (record.phase === 'cleared' || record.phase === 'asking' || record.phase === 'settled') ? record.decision : null
  return judgeOutput(
    {
      rawTool: tool === UNKNOWN_TOOL && call !== null ? call.rawTool : tool,
      text: outputTextOf(e.message),
      argsHash: judged?.judgment.argsHash ?? null,
      ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
    },
    judgeContext(ioFor($), localAccess(() => undefined)),
  )
}

async function rowFor($: EngineInterface, e: SessionAppendInput): Promise<SessionAppendMessage> {
  const tool = originToolOf(e)
  if (!isInspectedTool(tool)) return e.message
  const ids = toolUseIdsOf(e.message)
  if (ids.length > 0 && ids.every(id => didNotRun(recordOf(id)))) return e.message
  const at = await $.clock.now()
  if (tool.startsWith(MCP_PREFIX)) settleRuns($, e, tool, ids, at)
  if (!checksOutput(outputInspected())) return e.message
  const judgment = await judgeRow($, e, tool, ids[0])
  // session.append has no dialog, so an evidence ASK withholds like a BLOCK (UX spec M4).
  const policy = judgment.kind === 'verdict' && judgment.verdict !== 'ALLOW'
  // An ALLOW of a persisted-output preview did not read the output: a fault.
  if (judgment.kind === 'verdict' && !policy && !isPersistedOutput(e.message)) return e.message
  const message = policy ? placeholderFor(e.message, MODEL_OUTPUT.withhold) : uncheckedRow(e.message)
  if (message !== e.message) recordWithheld($, e, tool, ids, policy ? 'policy' : 'fault', at)
  if (message !== e.message && !policy) noteFaultEvents(e, tool, ids, judgment, at)
  if (policy && judgment.kind === 'verdict' && judgment.from === 'local') noteLocalBlocks(e, tool, ids, judgment.argsHash, at)
  return message
}

function noteFaultEvents(e: SessionAppendInput, tool: string, ids: readonly string[], judgment: Judgment, at: number): void {
  const reason = judgment.kind === 'fault' ? judgment.fault.kind : 'persisted-output'
  const agent = e.agentId !== undefined ? { agentId: e.agentId } : {}
  for (const id of ids.length > 0 ? ids : [undefined]) noteOutputFault({ rawTool: tool, ...agent, ...(id !== undefined ? { toolUseId: id } : {}) }, reason, at)
}

function noteLocalBlocks(e: SessionAppendInput, tool: string, ids: readonly string[], argsHash: string | null, at: number): void {
  const agent = e.agentId !== undefined ? { agentId: e.agentId } : {}
  for (const id of ids.length > 0 ? ids : [undefined]) noteOutputLocalBlock({ rawTool: tool, ...agent, ...(id !== undefined ? { toolUseId: id } : {}) }, argsHash, at)
}

const uncheckedRow = (message: SessionAppendMessage): SessionAppendMessage =>
  effectiveMode() === 'strict' ? placeholderFor(message, MODEL_OUTPUT.withhold_unchecked) : message

export const withholdOutput: Hook<'session.append'> = async ($, e, next) => {
  const message = await rowFor($, e)
  return message === e.message ? next(e) : next({ ...e, message })
}

// The engine keeps a .catch answer only within its grace: no $ call, nothing that can throw (R1).
export const failAppend: CatchHandler<Hook<'session.append'>> = ($, e, next) => {
  noteCatch(next.called)
  if (next.called || !isInspectedTool(originToolOf(e)) || !checksOutput(outputInspected())) return next(e)
  const message = uncheckedRow(e.message)
  return message === e.message ? next(e) : next({ ...e, message })
}
