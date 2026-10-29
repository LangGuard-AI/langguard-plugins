import type { EngineInterface, Hook, RenderElement, RenderInput } from 'claude-code'
import type { ArbiterCallView, ArbiterEvidenceMeter, ArbiterHealth, ArbiterHealthReason, ArbiterLedger, ArbiterMode, ArbiterPosture, ArbiterView } from '../../types'
import { BAND, SETUP_STEP, fixStepsOf, setupOf, stateWordOf } from './status.ts'
import { sanitize } from './text.ts'

const HEALTH = { plugin: 'langguard-arbiter', key: 'health' } as const
const POSTURE = { plugin: 'langguard-arbiter', key: 'posture' } as const
const LEDGER = { plugin: 'langguard-arbiter', key: 'ledger' } as const
const EVIDENCE = { plugin: 'langguard-arbiter', key: 'evidence' } as const
const CALL = { plugin: 'langguard-arbiter', key: 'call' } as const
const VIEW = { plugin: 'langguard-arbiter', key: 'view' } as const

export const PANE_ID = 'langguard-arbiter'

export const PANE = {
  title: 'LangGuard',
  tab_session: '1 Session',
  tab_status: '2 Status',
  close: 'esc close',
  summary: (parts: readonly string[]) => `This conversation: ${parts.join(', ')}.`,
  checked: (n: number) => `${n} checked`,
  allowed: (n: number) => `${n} allowed`,
  empty: 'No MCP calls checked yet in this conversation.',
  all_allowed: 'Every MCP call checked in this conversation was allowed.',
  word: { blocked: 'Blocked', withheld: 'Output withheld', asked: 'Asked to confirm', not_checked: 'Not checked', ran_unchecked: 'Ran with no check' },
  agent_main: 'main',
  agent_named: (agent: string) => `agent: ${agent}`,
  agent_unnamed: 'a subagent',
  labels: ['State', 'Address', 'API key', 'Mode', 'If not checked', 'Records', 'Recorded', 'Policies', 'Installed', 'Local checks', 'Version', 'Shown in'],
  state_ok: (time: string) => `Checking calls. Last check ${time}.`,
  state_starting: 'Starting. No check yet in this session.',
  state_bad: (state: string, setup: string) => `${state}. ${setup}`,
  address_missing: 'Not set',
  key_ok: (prefix: string) => `${prefix}... accepted`,
  key_missing: 'Not set',
  key_rejected: 'Not accepted',
  key_wrong_type: 'Wrong type',
  key_unchecked: 'Not checked yet. Fix the address first.',
  key_pending: 'Set. Not checked yet.',
  mode: { cooperative: 'Cooperative', strict: 'Strict' },
  unchecked: { cooperative: 'LangGuard asks you first.', strict: 'LangGuard blocks the call.' },
  records: (sent: number, queued: number, dropped: number) => `${sent} sent. ${queued} waiting. ${dropped} dropped.`,
  recorded: 'Each MCP call it checks, and tool output that a policy inspects.',
  synced: (time: string) => `Synced ${time}.`,
  stale: 'Not current.',
  sync_pending: 'Not synced yet.',
  sync_missing: (hostName: string) => `Not available from ${hostName}. The LangGuard server may need an update.`,
  set_by_org: 'Set by your organization',
  local: { on: 'On', starting: 'Starting', 'off-surface': 'Off. This surface cannot run local checks. Checks go to the server.', 'off-failed': 'Off. Local checks failed to start. Checks go to the server.' },
  version: (mod: string, engine: string) => `${mod} on Claude Code ${engine}`,
  shown_in: 'Terminal and Desktop. VS Code, claude -p and the Agent SDK get text only.',
  fix: 'To fix it:',
  btn_recheck: 'Check again',
  btn_copy: 'Copy diagnostics',
  btn_key: 'Create a key in LangGuard (needs sign-in)',
  copied: 'Copied.',
  copy_failed: 'Copy did not work here. Select the text below.',
} as const

export const INSTALL = {
  self: 'Self-installed. You can turn it off in /plugin.',
  managed: 'Managed by your organization. Other mods are allowed.',
  enforced: 'Managed by your organization. Enforced: other mods cannot load.',
  unknown: 'Install type not known.',
  safe_mode: 'Starting Claude Code in safe mode still turns it off.',
} as const

export const CMD = {
  text: (state: string, mode: string, parts: readonly string[]) => `LangGuard: ${state}. Mode: ${mode}. This conversation: ${parts.join(', ')}. Run /langguard status for setup and connection.`,
  status_text: (f: { state: string; hostName: string; keyState: string; mode: string; install: string; modVersion: string; fix: string }) =>
    `LangGuard: ${f.state}. Address: ${f.hostName}. API key: ${f.keyState}. Mode: ${f.mode}. ${f.install} Version ${f.modVersion}. ${f.fix}`.trimEnd(),
  usage: 'Usage: /langguard, or /langguard status.',
} as const

export const DIAG = (f: { modVersion: string; engineVersion: string; hostName: string; key: string; mode: string; installType: string; state: string; reasonKinds: string; sent: number; queued: number; dropped: number; time: string }) =>
  `LangGuard diagnostics. Mod ${f.modVersion}. Claude Code ${f.engineVersion}. Address ${f.hostName}. API key ${f.key}. Mode ${f.mode}. Install ${f.installType}. State ${f.state}. Health ${f.reasonKinds}. Records ${f.sent} sent, ${f.queued} waiting, ${f.dropped} dropped. Policies synced ${f.time}.`

const ZERO: ArbiterLedger['counts'] = { checked: 0, allowed: 0, asked: 0, blocked: 0, withheld: 0, faults: 0 }

export const SESSION_ROWS_MAX = 50
const TOOL_COLUMNS = { inline: 36, docked: 20 } as const
const TOOL_GAP = 2
const WORD_COLUMNS = 20
const LABEL_COLUMNS = 16
const RIGHT_AT = 54
// Below this body width the pane draws its docked form, whatever the surface calls its seat.
const NARROW_BELOW = 80

export const clockTime = (at: number): string => {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const hostNameOf = (host: string | null): string | null => (host === null ? null : host.replace(/^https?:\/\//, ''))

export function summaryParts(counts: ArbiterLedger['counts']): string[] {
  const parts = [PANE.checked(counts.checked), PANE.allowed(counts.allowed)]
  if (counts.blocked + counts.withheld > 0) parts.push(BAND.blocked(counts.blocked + counts.withheld))
  if (counts.asked > 0) parts.push(BAND.asked(counts.asked))
  if (counts.faults > 0) parts.push(BAND.notChecked(counts.faults))
  return parts
}

export type SessionWord = { readonly marker: 'x' | '?' | '~'; readonly word: string; readonly color: 'error' | 'permission' | 'warning'; readonly bold: boolean }

// The M7 Session table, first match wins. Null for an allowed call and for a call with no verdict yet.
export function sessionWordOf(view: ArbiterCallView): SessionWord | null {
  if (view.phase === 'judging') return null
  if (view.withheld === 'policy') return { marker: 'x', word: PANE.word.withheld, color: 'error', bold: true }
  if (view.outcome === 'ran-unchecked') return { marker: '~', word: PANE.word.ran_unchecked, color: 'warning', bold: false }
  if (view.withheld === 'fault' || view.from === 'fault') return { marker: '~', word: PANE.word.not_checked, color: 'warning', bold: false }
  if (view.verdict === 'BLOCK') return { marker: 'x', word: PANE.word.blocked, color: 'error', bold: true }
  if (view.verdict === 'ASK') return { marker: '?', word: PANE.word.asked, color: 'permission', bold: false }
  return null
}

export const agentTextOf = (view: ArbiterCallView): string =>
  view.agentId === undefined ? PANE.agent_main : view.agentLabel === undefined ? PANE.agent_unnamed : PANE.agent_named(sanitize(view.agentLabel, 32))

const HOST_KINDS: ReadonlySet<ArbiterHealthReason['kind']> = new Set(['bad-host'])

// Every key that the server accepts starts with this, so it names no part of the key (R9).
const KEY_FAMILY = 'lgr_'

export function keyStateOf(health: ArbiterHealth | undefined): string {
  const reasons = health?.reasons ?? []
  if (reasons.some(r => HOST_KINDS.has(r.kind) || (r.kind === 'not-configured' && r.missing !== 'key'))) return PANE.key_unchecked
  if (health?.keySet === false || reasons.some(r => (r.kind === 'not-configured' && r.missing === 'key') || (r.kind === 'fault' && r.fault.kind === 'no-key'))) return PANE.key_missing
  if (reasons.some(r => r.kind === 'fault' && r.fault.kind === 'key-rejected')) return PANE.key_rejected
  if (reasons.some(r => r.kind === 'fault' && r.fault.kind === 'key-wrong-type')) return PANE.key_wrong_type
  if (health?.keyPrefix !== undefined) return PANE.key_ok(health.keyPrefix)
  return health?.keyAccepted === true ? PANE.key_ok(KEY_FAMILY) : PANE.key_pending
}

const ADDRESS_COLUMNS = { inline: 78, docked: 42, text: 64 } as const

// As typed (frame m1_status_160).
export function addressOf(health: ArbiterHealth | undefined, columns: number): string {
  const typed = health?.hostText ?? health?.host ?? null
  if (typed !== null && (health?.reasons ?? []).some(r => r.kind === 'bad-host')) return sanitize(typed, columns)
  return hostNameOf(health?.host ?? null) ?? PANE.address_missing
}

export type InstallType = 'self' | 'managed' | 'enforced' | 'unknown'

// The M12 table, first match wins. Copy never claims more than the tier gives (L9).
export function installTypeOf(posture: ArbiterPosture | undefined): InstallType {
  const pinned = posture?.hostSource === 'managed' || posture?.modeSource === 'managed'
  if (posture?.tier === 'org' && pinned && posture.managedModsOnly === true) return 'enforced'
  if (pinned) return 'managed'
  if (posture?.tier === 'user') return 'self'
  return 'unknown'
}

export const installLinesOf = (type: InstallType): string[] => (type === 'managed' || type === 'enforced' ? [INSTALL[type], INSTALL.safe_mode] : [INSTALL[type]])

const KEY_PAGE = '/settings/agent-hooks'

// Section 8 rule 6. The href is the configured origin, never server data.
export function keyLinkOf(health: ArbiterHealth | undefined): string | null {
  const reasons = health?.reasons ?? []
  const host = health?.host ?? null
  if (host === null || health?.hostChecked !== true || reasons.some(r => r.kind === 'bad-host' || (r.kind === 'not-configured' && r.missing !== 'key'))) return null
  const keyFailed = health.keySet === false || reasons.some(r => (r.kind === 'not-configured' && r.missing === 'key') || (r.kind === 'fault' && (r.fault.kind === 'no-key' || r.fault.kind === 'key-rejected' || r.fault.kind === 'key-wrong-type')))
  return keyFailed ? `${host}${KEY_PAGE}` : null
}

export function stateTextOf(health: ArbiterHealth | undefined, mode: ArbiterMode): { readonly bad: boolean; readonly text: string } {
  const reasons = health?.reasons ?? []
  const word = stateWordOf(reasons)
  if (word !== null) return { bad: true, text: PANE.state_bad(word, setupOf(reasons, mode, hostNameOf(health?.host ?? null) ?? PANE.title) ?? '') }
  return { bad: false, text: health?.lastVerdictAt === undefined ? PANE.state_starting : PANE.state_ok(clockTime(health.lastVerdictAt)) }
}

const sentOf = (evidence: ArbiterEvidenceMeter | undefined): number => Math.max(0, (evidence?.seq ?? 0) - (evidence?.queued ?? 0) - (evidence?.dropped ?? 0))

export type PolicyState = { readonly text: string; readonly stale: boolean } | null

export function policiesOf(health: ArbiterHealth | undefined): PolicyState {
  const stale = (health?.reasons ?? []).some(r => r.kind === 'index-stale')
  const at = health?.lastSyncAt
  if (stale && at === undefined) return { text: PANE.sync_missing(hostNameOf(health?.host ?? null) ?? PANE.title), stale: false }
  if (at === undefined) return null
  return { text: PANE.synced(clockTime(at)), stale }
}

const reasonKindOf = (reason: ArbiterHealthReason): string => {
  switch (reason.kind) {
    case 'fault': {
      const { fault } = reason
      return ['fault', fault.kind, 'cause' in fault ? fault.cause : 'status' in fault ? String(fault.status) : ''].filter(Boolean).join('/')
    }
    case 'bad-host':
      return `bad-host/${reason.why}`
    case 'not-configured':
      return `not-configured/${reason.missing}`
    default:
      return reason.kind
  }
}

export type Snapshot = {
  readonly health: ArbiterHealth | undefined
  readonly posture: ArbiterPosture | undefined
  readonly ledger: ArbiterLedger | undefined
  readonly evidence: ArbiterEvidenceMeter | undefined
}

const modeOf = (s: Snapshot): ArbiterMode => s.posture?.mode ?? 'cooperative'

const stateWordOrChecking = (s: Snapshot): string => stateWordOf(s.health?.reasons ?? []) ?? BAND.checking

export function diagTextOf(s: Snapshot): string {
  const { health, evidence } = s
  return DIAG({
    modVersion: health?.modVersion ?? 'unknown',
    engineVersion: health?.engineVersion ?? 'unknown',
    hostName: hostNameOf(health?.host ?? null) ?? 'none',
    key: health?.keyPrefix === undefined ? 'not known' : `${health.keyPrefix}...`,
    mode: PANE.mode[modeOf(s)],
    installType: installTypeOf(s.posture),
    state: stateWordOrChecking(s),
    reasonKinds: (health?.reasons ?? []).map(reasonKindOf).join(', ') || 'none',
    sent: sentOf(evidence),
    queued: evidence?.queued ?? 0,
    dropped: evidence?.dropped ?? 0,
    time: health?.lastSyncAt === undefined ? 'never' : clockTime(health.lastSyncAt),
  })
}

export const commandTextOf = (s: Snapshot): string => CMD.text(stateWordOrChecking(s), PANE.mode[modeOf(s)], summaryParts(s.ledger?.counts ?? ZERO))

export function commandStatusTextOf(s: Snapshot): string {
  const reasons = s.health?.reasons ?? []
  const hostName = hostNameOf(s.health?.host ?? null)
  const steps = fixStepsOf(reasons).filter(step => step !== SETUP_STEP.recheck)
  const setup = stateWordOf(reasons) === null ? null : setupOf(reasons, modeOf(s), hostName ?? PANE.title)
  const fix = setup === null ? '' : steps.length === 0 ? setup : `${setup} ${PANE.fix} ${steps.map((step, i) => `${i + 1}. ${step}`).join(' ')}`
  return CMD.status_text({
    state: stateWordOrChecking(s),
    hostName: addressOf(s.health, ADDRESS_COLUMNS.text),
    keyState: keyStateOf(s.health).replace(/\.$/, ''),
    mode: PANE.mode[modeOf(s)],
    install: installLinesOf(installTypeOf(s.posture)).join(' '),
    modVersion: s.health?.modVersion ?? 'unknown',
    fix,
  })
}

async function snapshotOf($: EngineInterface): Promise<Snapshot> {
  const [health, posture, ledger, evidence] = await Promise.all([$.state.get(HEALTH), $.state.get(POSTURE), $.state.get(LEDGER), $.state.get(EVIDENCE)])
  return { health: health.value, posture: posture.value, ledger: ledger.value, evidence: evidence.value }
}

const DRAWING_SURFACES: ReadonlySet<string> = new Set(['terminal', 'desktop'])

export const runCommand: Hook<'command.run'> = async ($, e) => {
  const arg = e.args.trim()
  if (arg !== '' && arg !== 'status') return { text: CMD.usage }
  const tab: ArbiterView['tab'] = arg === 'status' ? 'status' : 'session'
  const surfaces = await $.session.surfaces().catch(() => [])
  if (surfaces.some(surface => DRAWING_SURFACES.has(surface))) {
    await $.state.set(VIEW, { tab }).catch(() => {})
    const opened = await $.ui.open({ id: PANE_ID, title: PANE.title, focus: true, closeOnEscape: true, rows: 16, columns: 58 }).catch(() => null)
    if (opened?.isPlaced === true) return {}
  }
  const s = await snapshotOf($)
  return { text: tab === 'status' ? commandStatusTextOf(s) : commandTextOf(s) }
}

type SessionRow = { readonly id: string; readonly view: ArbiterCallView; readonly word: SessionWord }

// Newest first. No reads when every checked call was allowed.
async function sessionRowsOf($: EngineInterface, ledger: ArbiterLedger | undefined): Promise<SessionRow[]> {
  const counts = ledger?.counts ?? ZERO
  if (counts.checked === counts.allowed) return []
  const rows: SessionRow[] = []
  for (const id of [...(ledger?.order ?? [])].reverse()) {
    if (rows.length >= SESSION_ROWS_MAX) break
    const view = (await $.state.get({ ...CALL, id })).value
    const word = view === undefined ? null : sessionWordOf(view)
    if (view !== undefined && word !== null) rows.push({ id, view, word })
  }
  return rows
}

type PaneProps = RenderInput<'Pane'>['props']

export const drawPane = async ($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> => {
  const { Box, Button, Link, Text } = $.ui.resolve(e)
  const props: PaneProps = e.props
  const narrow = props.placement === 'dock' || props.bodyColumns < NARROW_BELOW
  const view = (await $.state.get(VIEW)).value
  const tab: ArbiterView['tab'] = view?.tab ?? 'session'
  const s = await snapshotOf($)
  const setTab = (next: ArbiterView['tab']) => () => void $.state.set(VIEW, { tab: next }).catch(() => {})

  // Section 7: brackets mark the open tab, so NO_COLOR keeps the mark. A plain Button with a hotkey draws "1: ", so the hotkeys sit on Buttons that draw nothing.
  const tabOf = (id: ArbiterView['tab'], label: string) =>
    tab === id ? <Text key={`pane.tab.${id}`}>{`[${label}]`}</Text> : <Button key={`pane.tab.${id}`} label={label} plain dimColor onPress={setTab(id)} />
  const headOf = (inlineActions: RenderElement | null) => (
    <Box key="pane.head" flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">
        <Box key="pane.tabs" flexDirection="row">
          {tabOf('session', PANE.tab_session)}
          <Text>{'   '}</Text>
          {tabOf('status', PANE.tab_status)}
          <Box display="none">
            <Button key="pane.hotkey.session" label={PANE.tab_session} hotkey="1" onPress={setTab('session')} />
            <Button key="pane.hotkey.status" label={PANE.tab_status} hotkey="2" onPress={setTab('status')} />
          </Box>
        </Box>
        {inlineActions === null ? null : <Text>{'   '}</Text>}
        {inlineActions}
      </Box>
      <Text dimColor>{PANE.close}</Text>
    </Box>
  )
  const head = headOf(null)

  if (tab === 'session') {
    const counts = s.ledger?.counts ?? ZERO
    const rows = await sessionRowsOf($, s.ledger)
    const toolColumns = narrow ? TOOL_COLUMNS.docked : TOOL_COLUMNS.inline
    const agentColumns = Math.max(8, props.bodyColumns - 12 - TOOL_COLUMNS.inline - TOOL_GAP - WORD_COLUMNS)
    const summary =
      counts.checked === 0 ? (
        <Box key="pane.empty">
          <Text>{PANE.empty}</Text>
        </Box>
      ) : (
        <Box key="pane.summary">
          <Text>
          {'This conversation: '}
          {summaryParts(counts).map((part, i) => (
            <Text key={`part.${i}`}>
              {i === 0 ? '' : ', '}
              {i === 1 ? <Text color="success">{part}</Text> : part}
            </Text>
          ))}
          {'.'}
          </Text>
        </Box>
      )
    return (
      <Box flexDirection="column">
        {head}
        {summary}
        {counts.checked > 0 && rows.length === 0 && counts.checked === counts.allowed ? (
          <Box key="pane.all_allowed">
            <Text>{PANE.all_allowed}</Text>
          </Box>
        ) : null}
        {rows.map(({ id, view: call, word }) => (
          <Box key={`pane.row.${id}`} flexDirection="column">
            <Box flexDirection="row">
              <Text>
                <Text color={word.color} bold={word.bold}>
                  {word.marker}
                </Text>
                {` ${clockTime(call.at)}  `}
              </Text>
              <Box width={toolColumns + TOOL_GAP}>
                <Text>{sanitize(call.tool, toolColumns)}</Text>
              </Box>
              <Box width={narrow ? undefined : WORD_COLUMNS}>
                <Text color={word.color} bold={word.bold}>
                  {word.word}
                </Text>
              </Box>
              {narrow ? null : <Text>{sanitize(agentTextOf(call), agentColumns)}</Text>}
            </Box>
            {narrow && call.agentId !== undefined ? (
              <Box paddingLeft={12}>
                <Text>{sanitize(agentTextOf(call), Math.max(8, props.bodyColumns - 12))}</Text>
              </Box>
            ) : null}
          </Box>
        ))}
      </Box>
    )
  }

  const mode = modeOf(s)
  const health = s.health
  const state = stateTextOf(health, mode)
  const pinned = s.posture?.modeSource === 'managed'
  const hostPinned = s.posture?.hostSource === 'managed'
  const keyLink = keyLinkOf(health)
  const policies = policiesOf(health)
  const steps = state.bad ? fixStepsOf(health?.reasons ?? []) : []
  const diag = diagTextOf(s)
  const indent = narrow ? 0 : 2
  const [stateLabel, address, apiKey, modeLabel, ifUnchecked, records, recorded, policiesLabel, installed, localLabel, version, shownIn] = PANE.labels
  const row = (key: string, label: string, value: RenderElement | string, right: string | null = null) => (
    <Box key={key} flexDirection="row" paddingLeft={indent}>
      <Box width={LABEL_COLUMNS} flexShrink={0}>
        <Text>{label}</Text>
      </Box>
      <Box flexDirection={narrow ? 'column' : 'row'} flexGrow={1}>
        <Box width={narrow || right === null ? undefined : RIGHT_AT - indent - LABEL_COLUMNS} flexShrink={1}>
          {typeof value === 'string' ? <Text>{value}</Text> : value}
        </Box>
        {right === null ? null : <Text dimColor>{right}</Text>}
      </Box>
    </Box>
  )
  const copy = async (surface: Parameters<typeof $.ui.copy>[0]['surface']) => {
    const result = await $.ui.copy({ text: diag, surface }).catch(() => ({ isCopied: false as const }))
    await $.state.set(VIEW, result.isCopied ? { tab: 'status', copied: true } : { tab: 'status', copyFailed: true }).catch(() => {})
  }
  const columns = narrow ? ADDRESS_COLUMNS.docked : ADDRESS_COLUMNS.inline
  const stateRow = row(
    'pane.state',
    stateLabel as string,
    state.bad ? (
      <Text>
        <Text color="warning" bold>
          {'! '}
        </Text>
        {state.text}
      </Text>
    ) : (
      state.text
    ),
  )
  const fix =
    steps.length === 0 ? null : (
      <Box key="pane.fix" flexDirection="column" paddingLeft={indent}>
        <Text>{PANE.fix}</Text>
        {steps.map((step, i) => (
          <Box key={`pane.step.${i}`} flexDirection="row">
            <Box width={3} flexShrink={0}>
              <Text>{`${i + 1}.`}</Text>
            </Box>
            <Text>{step}</Text>
          </Box>
        ))}
      </Box>
    )
  // Inline, the actions sit on the tab row: with a managed install the 14 body rows hold nothing else.
  const actionsRow = (
    <Box key="pane.actions" flexDirection="row" paddingLeft={narrow ? indent : 0}>
      <Button key="pane.btn.recheck" label={PANE.btn_recheck} hotkey="r" plain onPress={() => {}} />
      <Text>{'   '}</Text>
      <Button key="pane.btn.copy" label={PANE.btn_copy} hotkey="c" plain onPress={press => void copy(press.surface).catch(() => {})} />
      {view?.copied === true ? <Text>{`   ${PANE.copied}`}</Text> : null}
    </Box>
  )
  const below = [
    keyLink === null ? null : (
      <Box key="pane.keylink" paddingLeft={indent}>
        <Link href={keyLink} label={PANE.btn_key} />
      </Box>
    ),
    view?.copyFailed === true ? (
      <Box key="pane.copy_failed" flexDirection="column" paddingLeft={indent}>
        <Text>{PANE.copy_failed}</Text>
        <Text>{diag}</Text>
      </Box>
    ) : null,
  ]
  // While a setup reason holds, the fix comes first, so that the 14 rows of an inline pane show it.
  return (
    <Box flexDirection="column">
      {narrow ? head : headOf(actionsRow)}
      {stateRow}
      {state.bad ? fix : null}
      {narrow && state.bad ? actionsRow : null}
      {state.bad || !narrow ? below : null}
      {row('pane.address', address as string, addressOf(health, columns), hostPinned ? PANE.set_by_org : null)}
      {row('pane.key', apiKey as string, keyStateOf(health))}
      {row('pane.mode', modeLabel as string, PANE.mode[mode], pinned ? PANE.set_by_org : null)}
      {row('pane.unchecked', ifUnchecked as string, PANE.unchecked[mode])}
      {row('pane.records', records as string, PANE.records(sentOf(s.evidence), s.evidence?.queued ?? 0, s.evidence?.dropped ?? 0))}
      {row('pane.recorded', recorded as string, PANE.recorded)}
      {row(
        'pane.policies',
        policiesLabel as string,
        policies === null ? (
          PANE.sync_pending
        ) : policies.stale ? (
          <Text>
            {`${policies.text} `}
            <Text color="warning">{PANE.stale}</Text>
          </Text>
        ) : (
          policies.text
        ),
      )}
      {row(
        'pane.installed',
        installed as string,
        <Box flexDirection="column">
          {installLinesOf(installTypeOf(s.posture)).map((line, i) => (
            <Text key={`pane.install.${i}`}>{line}</Text>
          ))}
        </Box>,
      )}
      {row('pane.local', localLabel as string, PANE.local[health?.local ?? 'starting'])}
      {row('pane.version', version as string, PANE.version(health?.modVersion ?? 'unknown', health?.engineVersion ?? 'unknown'))}
      {row('pane.shown_in', shownIn as string, PANE.shown_in)}
      {narrow && !state.bad ? actionsRow : null}
      {narrow && !state.bad ? below : null}
    </Box>
  )
}
