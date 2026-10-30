import type { Register } from 'claude-code'
import { loadOptions } from './config.ts'
import { failAppend, withholdOutput } from './evidence/append.ts'
import { setConfiguredMode, setRevoked } from './gate/fail-mode.ts'
import {
  askAtPreToolUse,
  failConfigSet,
  failMcpCall,
  failToolCall,
  failToolCheck,
  gateMcpCall,
  gateToolCall,
  gateToolCheck,
  guardConfig,
  guardNotice,
  recordPermissionRequest,
} from './gate/hooks.ts'
import { addPostureContext } from './posture/prompt.ts'
import { endSession, flushOnTurnComplete, recheckOnPress, resetPosture, startSession } from './state.ts'
import { drawBand, drawPresence } from './ui/band.tsx'
import { drawPane, runCommand } from './ui/pane.tsx'
import { drawToolGroup, drawToolResult, drawToolRow } from './ui/tool-row.tsx'

const GATED = { tool: /^mcp__/ } as const
const OWN_ROWS = { key: /^langguard-arbiter\./ } as const
const TOOL_RESULT = { door: 'tool-result' } as const
const TOOL_ROW = { component: 'ToolUse', props: GATED } as const
const TOOL_RESULT_ROW = { component: 'ToolResult', props: GATED } as const
const TOOL_GROUP = { component: 'ToolGroup' } as const
const BAND = { component: 'AbovePrompt' } as const
const FOOTER = { component: 'SessionMode' } as const
const PANE = { component: 'Pane', requestId: 'langguard-arbiter' } as const
const COMMAND = { command: 'langguard' } as const
const RECHECK = { plugin: 'langguard-arbiter', element: 'pane.btn.recheck' } as const

export const register: Register = (on, options) => {
  const { config } = loadOptions(options)
  resetPosture(config.mode)
  setConfiguredMode(config.mode, false)
  setRevoked(false)
  on('session.start', startSession)
  on('prompt.submit', addPostureContext)
  on('turn.complete', flushOnTurnComplete)
  on('session.end', endSession)
  on('tool.call', GATED, gateToolCall).catch(failToolCall)
  on('tool.check', GATED, gateToolCheck).catch(failToolCheck)
  on('mcp.call', gateMcpCall).catch(failMcpCall)
  on('config.set', OWN_ROWS, guardConfig).catch(failConfigSet)
  on('ui.notice', guardNotice)
  on('classic.PermissionRequest', recordPermissionRequest)
  on('classic.PreToolUse', GATED, askAtPreToolUse)
  on('session.append', TOOL_RESULT, withholdOutput).catch(failAppend)
  on('ui.render', TOOL_ROW, drawToolRow)
  on('ui.render', TOOL_RESULT_ROW, drawToolResult)
  on('ui.render', TOOL_GROUP, drawToolGroup)
  on('ui.render', BAND, drawBand)
  on('ui.render', FOOTER, drawPresence)
  on('ui.render', PANE, drawPane)
  on('command.run', COMMAND, runCommand)
  on('ui.press', RECHECK, recheckOnPress)
}
