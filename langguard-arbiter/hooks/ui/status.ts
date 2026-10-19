import type { ArbiterHealth, ArbiterHealthReason, ArbiterLedger, ArbiterMode } from '../../types'

export const BAND_REASONS: ReadonlySet<ArbiterHealthReason['kind']> = new Set(['not-configured', 'bad-host', 'bad-mode', 'fault', 'revoked', 'catch-fired', 'unchecked-run'])

export const PRESENCE = 'LangGuard'

export const BAND = {
  brand: 'LangGuard',
  checking: 'Checking calls',
  setup: 'Setup needed',
  offline: 'Offline',
  error: 'Error',
  off: 'Turned off by your organization',
  blocked: (n: number) => `${n} blocked`,
  asked: (n: number) => `${n} asked to confirm`,
  notChecked: (n: number) => `${n} not checked`,
  open: '/langguard',
  status: '/langguard status',
} as const

export const EFFECT = { cooperative: 'Unchecked MCP calls ask you first.', strict: 'Unchecked MCP calls are blocked.' } as const

export const STATUS = {
  revoked: (effect: string) => `Turned off by your organization. ${effect}`,
  no_host: (effect: string) => `No address set. ${effect} Run /langguard status`,
  host_shape: (effect: string) => `The address must start with https://. ${effect}`,
  host_shared: (effect: string) => `Wrong address. ${effect} Run /langguard status`,
  bad_mode: (effect: string) => `Mode not valid. ${effect} Run /langguard status`,
  not_lg: (effect: string) => `Not a LangGuard address. ${effect}`,
  no_key: (effect: string) => `No API key. ${effect} Run /langguard status`,
  key_rejected: (effect: string) => `Key not accepted. ${effect} Run /langguard status`,
  tls: (effect: string) => `Secure connection failed. ${effect}`,
  unreachable: (effect: string, hostName: string) => `Cannot reach ${hostName}. ${effect}`,
  network_policy: (effect: string) => `Network settings block LangGuard. ${effect}`,
  limited: (effect: string) => `The server is limiting requests. ${effect}`,
  bad_reply: (effect: string) => `LangGuard sent a bad reply. ${effect}`,
  error: (effect: string) => `Internal error. ${effect} Run /reload-plugins`,
  unchecked_run: (n: number) => `${n === 1 ? '1 MCP call ran' : `${n} MCP calls ran`} with no check. Run /langguard status`,
  dropped: (n: number) => `${n === 1 ? '1 record' : `${n} records`} could not be sent to your organization.`,
} as const

export const SETUP = {
  revoked: () => 'Your organization turned off LangGuard on this device.',
  no_host: () => 'LangGuard has no address set.',
  host_shape: () => 'The LangGuard address must start with https://.',
  host_shared: () => "app.langguard.ai is the shared address. Use your organization's own address, like https://yourcompany.app.langguard.ai.",
  host_login: () => 'The LangGuard address must not hold a login name or password.',
  bad_mode: () => 'The LangGuard mode must be cooperative or strict. LangGuard uses strict mode until you fix it.',
  not_lg: (hostName: string) => `${hostName} answers, but it is not a LangGuard address.`,
  no_key: () => 'LangGuard has no API key.',
  key_rejected: () => 'LangGuard did not accept this API key. It may be mistyped or revoked.',
  tls: (hostName: string) => `Cannot make a secure connection to ${hostName}. If your network uses a proxy, check HTTPS_PROXY.`,
  unreachable: (hostName: string) => `Cannot reach ${hostName}. Check the address and your network.`,
  network_policy: (hostName: string) => `Claude Code network settings block the connection to ${hostName}.`,
} as const

export const LOG = {
  intro: (hostName: string) =>
    `LangGuard is on. It checks MCP tool calls against your organization's policies at ${hostName}. Your organization receives a record of each call it checks, and of tool output that a policy inspects. You see LangGuard only when a call is blocked or needs your answer. Details: /langguard`,
  intro_managed: (hostName: string) =>
    `LangGuard is on. Managed by your organization at ${hostName}. It checks MCP tool calls against your organization's policies. Your organization receives a record of each call it checks, and of tool output that a policy inspects. Starting Claude Code in safe mode still turns it off. Details: /langguard status`,
  setup: (setup: string, effect: string) => `${setup} ${effect} To fix it, run /langguard status.`,
} as const

export const SETUP_STEP = {
  key: 'Create an Arbiter key in LangGuard: Settings, Arbiter Management, Deployment.',
  set_key: 'Open /plugin, choose langguard-arbiter, and set the key in its options.',
  set_host: "Open /plugin, choose langguard-arbiter, and set your organization's address in its options.",
  set_mode: 'Open /plugin, choose langguard-arbiter, and set the mode to cooperative or strict in its options.',
  network: 'Check your network, your proxy, and the address in the langguard-arbiter options.',
  admin: 'Ask your admin.',
  recheck: 'LangGuard checks again when you save the options. Or press r.',
} as const

const HOST_STEPS = [SETUP_STEP.set_host, SETUP_STEP.recheck] as const
const MODE_STEPS = [SETUP_STEP.set_mode, SETUP_STEP.recheck] as const
const KEY_STEPS = [SETUP_STEP.key, SETUP_STEP.set_key, SETUP_STEP.recheck] as const
const NETWORK_STEPS = [SETUP_STEP.network, SETUP_STEP.recheck] as const
const ADMIN_STEPS = [SETUP_STEP.admin] as const

type BandWord = 'off' | 'setup' | 'offline' | 'error' | null

type Row = { readonly word: BandWord; readonly steps: readonly string[]; readonly setup: ((hostName: string) => string) | null; readonly status: (effect: string, hostName: string, reason: ArbiterHealthReason) => string; readonly matches: (reason: ArbiterHealthReason) => boolean }

const fault = (reason: ArbiterHealthReason) => (reason.kind === 'fault' ? reason.fault : null)

// The M11 precedence table, first match wins.
export const PRECEDENCE: readonly Row[] = [
  { word: 'off', setup: SETUP.revoked, steps: ADMIN_STEPS, status: STATUS.revoked, matches: r => r.kind === 'revoked' },
  { word: 'setup', setup: SETUP.no_host, steps: HOST_STEPS, status: STATUS.no_host, matches: r => r.kind === 'not-configured' && r.missing !== 'key' },
  { word: 'setup', setup: SETUP.host_shape, steps: HOST_STEPS, status: STATUS.host_shape, matches: r => r.kind === 'bad-host' && r.why === 'not-https' },
  { word: 'setup', setup: SETUP.host_login, steps: HOST_STEPS, status: STATUS.host_shared, matches: r => r.kind === 'bad-host' && r.why === 'login' },
  { word: 'setup', setup: SETUP.host_shared, steps: HOST_STEPS, status: STATUS.host_shared, matches: r => r.kind === 'bad-host' && r.why === 'shared-host' },
  { word: 'setup', setup: SETUP.not_lg, steps: HOST_STEPS, status: STATUS.not_lg, matches: r => r.kind === 'bad-host' && r.why === 'not-langguard' },
  { word: 'setup', setup: SETUP.no_key, steps: KEY_STEPS, status: STATUS.no_key, matches: r => (r.kind === 'not-configured' && r.missing === 'key') || fault(r)?.kind === 'no-key' },
  // O14: whoami never answers 403, so a 403 reads as row 7.
  { word: 'setup', setup: SETUP.key_rejected, steps: KEY_STEPS, status: STATUS.key_rejected, matches: r => fault(r)?.kind === 'key-rejected' },
  { word: 'setup', setup: SETUP.bad_mode, steps: MODE_STEPS, status: STATUS.bad_mode, matches: r => r.kind === 'bad-mode' },
  { word: 'offline', setup: SETUP.tls, steps: NETWORK_STEPS, status: STATUS.tls, matches: r => { const f = fault(r); return f?.kind === 'unreachable' && f.cause === 'tls' } },
  { word: 'offline', setup: SETUP.unreachable, steps: NETWORK_STEPS, status: STATUS.unreachable, matches: r => fault(r)?.kind === 'unreachable' },
  { word: 'offline', setup: SETUP.network_policy, steps: ADMIN_STEPS, status: STATUS.network_policy, matches: r => fault(r)?.kind === 'network-policy' },
  { word: 'offline', setup: null, steps: [], status: STATUS.limited, matches: r => fault(r)?.kind === 'rate-limited' },
  { word: 'error', setup: null, steps: [], status: STATUS.bad_reply, matches: r => fault(r)?.kind === 'bad-reply' },
  { word: 'error', setup: null, steps: [], status: STATUS.error, matches: r => r.kind === 'catch-fired' },
  { word: 'error', setup: null, steps: [], status: (effect, hostName, r) => STATUS.unchecked_run(r.kind === 'unchecked-run' ? r.count : 0), matches: r => r.kind === 'unchecked-run' },
  { word: null, setup: null, steps: [], status: (effect, hostName, r) => STATUS.dropped(r.kind === 'evidence-backlog' ? r.dropped : 0), matches: r => r.kind === 'evidence-backlog' && r.dropped > 0 },
]

function firstRow(reasons: readonly ArbiterHealthReason[]): { row: Row; reason: ArbiterHealthReason } | null {
  for (const row of PRECEDENCE) {
    const reason = reasons.find(row.matches)
    if (reason !== undefined) return { row, reason }
  }
  return null
}

// The setup sentence of the first matching row, or its status line where the row has none (M11). Null while no row matches.
export function setupOf(reasons: readonly ArbiterHealthReason[], mode: ArbiterMode, hostName: string): string | null {
  const found = firstRow(reasons)
  if (found === null) return null
  return found.row.setup === null ? found.row.status(EFFECT[mode], hostName, found.reason) : found.row.setup(hostName)
}

// M2: the setup sentence of the first matching row, only for a row that has one.
export function setupSentenceOf(reasons: readonly ArbiterHealthReason[], hostName: string): string | null {
  const found = firstRow(reasons)
  return found?.row.setup ? found.row.setup(hostName) : null
}

// The band word of the first matching row, or null while no reason in BAND_REASONS holds.
export function stateWordOf(reasons: readonly ArbiterHealthReason[]): string | null {
  if (!isDegraded(reasons)) return null
  return BAND[firstRow(reasons)?.row.word ?? 'error']
}

// The fix steps of the first matching row.
export function fixStepsOf(reasons: readonly ArbiterHealthReason[]): readonly string[] {
  return firstRow(reasons)?.row.steps ?? []
}

export const isDegraded = (reasons: readonly ArbiterHealthReason[]): boolean => reasons.some(r => BAND_REASONS.has(r.kind))

// `hostName` comes from local config, never from a server reply (section 8 rule 7).
export function statusLineOf(reasons: readonly ArbiterHealthReason[], mode: ArbiterMode, hostName: string): string | undefined {
  const found = firstRow(reasons)
  return found === null ? undefined : found.row.status(EFFECT[mode], hostName, found.reason)
}

let shownStatus: string | undefined

// $.ui.status goes out only when the line changes, so a healthy session makes no call.
export const statusChanged = (text: string | undefined): boolean => text !== shownStatus

// Called only after $.ui.status returned, so a line that the engine refused goes out again at the next publish.
export function statusShown(text: string | undefined): void {
  shownStatus = text
}

const ZERO: ArbiterLedger['counts'] = { checked: 0, allowed: 0, asked: 0, blocked: 0, withheld: 0, faults: 0 }

export type BandCount = { readonly key: 'band.count.blocked' | 'band.count.asked' | 'band.count.not_checked'; readonly text: string; readonly color: 'error' | 'permission' | 'warning'; readonly bold: boolean }

export type BandModel = { readonly word: string; readonly degraded: boolean; readonly counts: readonly BandCount[]; readonly action: string | null }

export const LEFT_GAP = '  '
export const COUNT_GAP = '   '

const leftWidth = (word: string, counts: readonly BandCount[]): number =>
  1 + BAND.brand.length + LEFT_GAP.length + word.length + counts.reduce((sum, c) => sum + COUNT_GAP.length + c.text.length, 0)

// M3 rules 4 and 5. Null when the band does not show.
export function bandOf(health: ArbiterHealth | undefined, ledger: ArbiterLedger | undefined, columns: number, alwaysVisible: boolean): BandModel | null {
  const reasons = health?.reasons ?? []
  const c = ledger?.counts ?? ZERO
  const degraded = isDegraded(reasons)
  const raised = alwaysVisible || c.blocked + c.withheld + c.asked + c.faults > 0 || degraded
  if (!raised) return null
  const word = degraded ? BAND[firstRow(reasons)?.row.word ?? 'error'] : BAND.checking
  const all: BandCount[] = []
  if (c.blocked + c.withheld > 0) all.push({ key: 'band.count.blocked', text: BAND.blocked(c.blocked + c.withheld), color: 'error', bold: true })
  if (c.asked > 0) all.push({ key: 'band.count.asked', text: BAND.asked(c.asked), color: 'permission', bold: false })
  if (c.faults > 0) all.push({ key: 'band.count.not_checked', text: BAND.notChecked(c.faults), color: 'warning', bold: false })
  const action = degraded ? BAND.status : BAND.open
  const counts = [...all]
  while (counts.length > 0 && leftWidth(word, counts) + 1 + action.length > columns) counts.pop()
  return { word, degraded, counts, action: leftWidth(word, counts) + 1 + action.length > columns ? null : action }
}
