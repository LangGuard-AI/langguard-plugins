import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'
import type { ArbiterCallView } from '../../types'

const CALL = { plugin: 'langguard-arbiter', key: 'call' } as const
const GATED = /^mcp__/

type RenderHook<C extends 'ToolUse' | 'ToolResult' | 'ToolGroup'> = ($: EngineInterface, e: RenderInput<C>, next: (e: RenderInput<C>) => Promise<RenderElement>) => Promise<RenderElement>

export type RowLine = {
  readonly key: 'row.blocked' | 'row.withheld' | 'row.unchecked' | 'row.unchecked_withheld'
  readonly marker: 'x' | '~'
  readonly color: 'error' | 'warning'
  readonly bold: boolean
  readonly word: string
  readonly text: string
  readonly when: (view: ArbiterCallView) => boolean
}

// The M4 table of the UX spec, first match wins. `word` is the part section 7 colors.
export const ROW_LINES: readonly RowLine[] = [
  {
    key: 'row.unchecked_withheld',
    marker: '~',
    color: 'warning',
    bold: false,
    word: 'Output withheld.',
    text: 'Output withheld. LangGuard could not check it. The tool ran.',
    when: view => view.withheld === 'fault',
  },
  {
    key: 'row.withheld',
    marker: 'x',
    color: 'error',
    bold: true,
    word: 'Output withheld',
    text: 'Output withheld by an organization policy. The tool ran.',
    when: view => view.withheld === 'policy',
  },
  {
    key: 'row.unchecked',
    marker: '~',
    color: 'warning',
    bold: false,
    word: 'Not checked.',
    text: 'Not checked. LangGuard could not check this call, so it did not run.',
    when: view => view.withheld === undefined && view.verdict === 'BLOCK' && view.from === 'fault' && view.outcome !== 'ran-unchecked',
  },
  {
    key: 'row.blocked',
    marker: 'x',
    color: 'error',
    bold: true,
    word: 'Blocked',
    text: 'Blocked by an organization policy',
    when: view => view.withheld === undefined && view.verdict === 'BLOCK' && (view.from === 'server' || view.from === 'cache'),
  },
]

export const rowLineOf = (view: ArbiterCallView | undefined): RowLine | null =>
  view === undefined || view.phase === 'judging' ? null : (ROW_LINES.find(row => row.when(view)) ?? null)

export const ROW_CHECKING = 'checking with LangGuard'

const isSlow = (view: ArbiterCallView | undefined): boolean => view?.phase === 'judging' && view.slow === true

function tailTree($: EngineInterface, e: RenderInput) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key="row.checking" paddingLeft={2}>
      <Text dimColor>{ROW_CHECKING}</Text>
    </Box>
  )
}

function lineTree($: EngineInterface, e: RenderInput, line: RowLine) {
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box key={line.key} paddingLeft={2}>
      <Text>
        <Text color={line.color} bold={line.bold}>
          {line.marker} {line.word}
        </Text>
        {line.text.slice(line.word.length)}
      </Text>
    </Box>
  )
}

export const drawToolRow: RenderHook<'ToolUse'> = async ($, e, next) => {
  const engine = await next(e)
  const view = (await $.state.get({ ...CALL, id: e.props.tool_use_id })).value
  const line = rowLineOf(view)
  if (line === null && !isSlow(view)) return engine
  const { Box } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {engine}
      {line === null ? tailTree($, e) : lineTree($, e, line)}
    </Box>
  )
}

// O1: the engine draws the deny text under a standalone row, so the row line above stands alone.
export const drawToolResult: RenderHook<'ToolResult'> = async ($, e, next) => {
  const view = (await $.state.get({ ...CALL, id: e.props.tool_use_id })).value
  if (rowLineOf(view) === null) return next(e)
  const { Box } = $.ui.resolve(e)
  return <Box />
}

// O1, O5: the terminal folds an MCP call into one group line, held or finished, where no ToolUse row draws.
export const drawToolGroup: RenderHook<'ToolGroup'> = async ($, e, next) => {
  const engine = await next(e)
  if (e.props.isExpanded) return engine
  const lines: RowLine[] = []
  let slow = false
  for (const call of e.props.calls) {
    if (call.tool_use_id === undefined || !GATED.test(call.tool)) continue
    const view = (await $.state.get({ ...CALL, id: call.tool_use_id })).value
    const line = rowLineOf(view)
    if (line !== null && !lines.includes(line)) lines.push(line)
    slow ||= isSlow(view)
  }
  if (lines.length === 0 && !slow) return engine
  const { Box } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {engine}
      {lines.map(line => lineTree($, e, line))}
      {slow ? tailTree($, e) : null}
    </Box>
  )
}
