import type { EngineInterface, Hook, RenderSurface, Settings, Timer } from 'claude-code'
import type { ArbiterFault, ArbiterHealth, ArbiterMode, ArbiterPosture } from '../types'
import { loadedOptions } from './config.ts'
import { osUserOf, userIdOf } from './identity.ts'
import { MARKER_EVERY_MS, MARKER_WAIT_MS, putMarker, putMarkerWithin, putMode, type MarkerIo } from './evidence/marker.ts'
import { FLUSH_EVERY_MS, flushAll, flushOnce, meter, noteSession, setEvidenceIdentity, type EvidenceContext } from './evidence/queue.ts'
import {
  FIRST_BEAT_MS,
  ackCommand,
  handledOf,
  nextBeatDelay,
  rememberCommand,
  sendHeartbeat,
  type Command,
  type CommandResult,
} from './evidence/heartbeat.ts'
import { applyServerMode, applyStoredOverride, catchCount, effectiveMode, hostNameOf, isRevoked, setConfiguredMode, setRevoked } from './gate/fail-mode.ts'
import type { Judgment } from './gate/machine.ts'
import { allowTierOf, installOf, runProbes, type ProbeIo, type ProbeOutcome } from './health/probe.ts'
import { EFFECT, LOG, isDegraded, setupSentenceOf, statusChanged, statusLineOf, statusShown } from './ui/status.ts'
import { connectOpa, heldSigningOf, type HeldSigning, type StoredSigning, type OpaAuthzFile, type OpaChecksums, type OpaIo, type OpaOutcome } from './local/opa.ts'
import type { LocalAccess } from './local/tier.ts'
import { INDEX_EVERY_MS, endConversation, heldIndex, indexLongPoll, indexSupportsWait, resetIndex, staleSince, syncIndex, usableIndex } from './posture/index.ts'
import { opaSocketPath, sha256Hex } from './vendor/core/pure.ts'
import type { JudgeIo } from './verdict/source.ts'

const HEALTH = { plugin: 'langguard-arbiter', key: 'health' } as const
const POSTURE = { plugin: 'langguard-arbiter', key: 'posture' } as const
const EVIDENCE = { plugin: 'langguard-arbiter', key: 'evidence' } as const

const COMMAND_DESCRIPTION = "LangGuard checks MCP tool calls against your organization's policies."

const postureFor = (mode: ArbiterMode): ArbiterPosture => ({ mode, modeSource: 'config', hostSource: 'config', managedModsOnly: 'unknown', tier: 'unknown', revision: null, outputInspected: 'unknown' })

let posture = postureFor('cooperative')

export function resetPosture(mode: ArbiterMode): void {
  posture = postureFor(mode)
  resetIndex()
}

export const outputInspected = (): ArbiterPosture['outputInspected'] => posture.outputInspected

export function setOutputInspected(value: ArbiterPosture['outputInspected']): void {
  posture = { ...posture, outputInspected: value }
}

function setPostureMode(mode: ArbiterMode, modeSource: ArbiterPosture['modeSource']): void {
  posture = { ...posture, mode, modeSource }
}

const isManagedInstall = (): boolean => posture.tier === 'org' || posture.hostSource === 'managed' || posture.modeSource === 'managed'

const WAIT_MS = 2000

// A `$` call that only labels the health row must not hold a hook: past the wait the fallback stands.
async function within<T>($: EngineInterface, work: Promise<T>, fallback: T, waitMs: number = WAIT_MS): Promise<T> {
  const stop = new AbortController()
  const late = $.clock.sleep(waitMs, { signal: stop.signal }).then(() => fallback, () => fallback)
  try {
    return await Promise.race([work, late])
  } finally {
    stop.abort()
  }
}

const engineVersion = ($: EngineInterface): Promise<string> =>
  within($, $.session.version().then(v => (typeof v?.version === 'string' ? v.version : 'unknown'), () => 'unknown'), 'unknown')

const MODE_OVERRIDE_KEY = 'modeOverride'
const INSTALL_ID_KEY = 'installId'
const REVOKED_KEY = 'revoked'
const OPA_SIGNING_KEY = 'opaSigning'
const MODE_ROW = 'langguard-arbiter.enforcement_mode'

export type SessionFacts = { readonly isInteractive: boolean | null; readonly desktopAskFallback: boolean; readonly sessionId: string; readonly userId: string | null }

let facts: SessionFacts = { isInteractive: null, desktopAskFallback: false, sessionId: 'unknown', userId: null }

export const sessionFacts = (): SessionFacts => facts

async function desktopFallback($: EngineInterface, surface: RenderSurface | null): Promise<boolean> {
  if (surface !== 'desktop') return false
  const surfaces = await $.session.surfaces().catch(() => ['desktop' as const])
  return surfaces.length === 0
}

const IDENTITY_WAIT_MS = 2500
const IDENTITY_RUN_MS = 2000

const outputOf = (run: Promise<{ readonly exitCode: number; readonly stdout: string }>): Promise<string | null> =>
  run.then(r => (r.exitCode === 0 ? r.stdout : null), () => null)

// The four sources of identity.ts, in order. Each failure (a missing git, a surface with no $.process, a timeout) leaves the next source.
async function userIdOfSession($: EngineInterface): Promise<string | null> {
  const explicit = userIdOf(await $.env.get('ARBITER_USER_ID').catch(() => undefined))
  if (explicit !== null) return explicit
  const email = userIdOf(await outputOf($.process.run(['git', 'config', 'user.email'], { timeoutMs: IDENTITY_RUN_MS })))
  if (email !== null) return email
  const osUser = osUserOf(await outputOf($.process.run(['whoami'], { timeoutMs: IDENTITY_RUN_MS })))
  if (osUser !== null) return osUser
  return userIdOf(await $.env.get('USER').catch(() => undefined))
}

let health: ArbiterHealth | null = null

let localOutcome: OpaOutcome = { local: 'starting' }

// The local tier answers a call only while it is on and not turned off by a record that the server answered differently (interrogate A15). The socket path is known after the first start step.
let localSocket: string | null = null
// The revision of the index that decided the call whose record the server answered differently. The tier stays off while the mod holds that revision; a new revision (a policy published between two syncs may explain the mismatch) gives it another sample. null: no mismatch in this session.
let mismatchRevision: string | null = null

const localIsOff = (): boolean => mismatchRevision !== null && mismatchRevision === (heldIndex()?.revision ?? null)

const OFF_BY_SAMPLE: OpaOutcome = { local: 'off-failed', cause: 'sample-mismatch' }

// L22b: a local ALLOW and a local ASK stand only when the managed settings read proves a tier (b) install (allowTierOf). Self-install (a) stays unproven, and tier (c), an unknown tier and a failed read leave the local tier with BLOCK only.
let allowTier = false

export function localAccess(onMismatch: LocalAccess['onMismatch']): LocalAccess | null {
  if (localIsOff() || localOutcome.local !== 'on' || localSocket === null) return null
  return { socketPath: localSocket, signed: localOutcome.signed === true, instance: localOutcome.instance ?? null, allowTier, onMismatch }
}

// A record of a local ALLOW that the server answered with another verdict. The tier stays off until the mod accepts another revision of the index. A mismatch of a revision that the mod no longer holds changes nothing.
export function noteLocalOff(revision: string): ArbiterHealth {
  if (revision === (heldIndex()?.revision ?? null)) mismatchRevision = revision
  return noteLocal(localOutcome)
}

// A typo in the managed Mode option. The engine hands the mod the default for it, so parseOptions cannot see it.
let managedModeInvalid = false

const baseHealth = (engine: string): ArbiterHealth => {
  const { config, reasons } = loadedOptions()
  return {
    reasons: managedModeInvalid && !reasons.some(r => r.kind === 'bad-mode') ? [...reasons, { kind: 'bad-mode' }] : reasons,
    local: localOutcome.local,
    ...(localOutcome.cause === undefined ? {} : { localCause: localOutcome.cause }),
    host: config.host,
    ...(config.hostText === null ? {} : { hostText: config.hostText }),
    modVersion: config.version,
    engineVersion: engine,
  }
}

function noteLocal(given: OpaOutcome): ArbiterHealth {
  localOutcome = given
  const outcome = localIsOff() ? OFF_BY_SAMPLE : given
  const { localCause: dropped, ...current } = health ?? baseHealth('unknown')
  void dropped
  health = { ...current, local: outcome.local, ...(outcome.cause === undefined ? {} : { localCause: outcome.cause }) }
  return health
}

export function noteUncheckedRun(): ArbiterHealth {
  const current = health ?? baseHealth('unknown')
  const prior = current.reasons.find(r => r.kind === 'unchecked-run')
  const count = prior?.kind === 'unchecked-run' ? prior.count + 1 : 1
  health = { ...current, reasons: [...current.reasons.filter(r => r.kind !== 'unchecked-run'), { kind: 'unchecked-run', count }] }
  return health
}

// The faults of the server path that the M11 precedence table names. A fault of one call's input (oversize, bad name) or of the mod (internal) is no health reason.
const HEALTH_FAULTS: ReadonlySet<ArbiterFault['kind']> = new Set(['no-key', 'key-rejected', 'key-wrong-type', 'unreachable', 'rate-limited', 'bad-reply', 'network-policy'])

const sameFault = (a: ArbiterFault, b: ArbiterFault): boolean => JSON.stringify(a) === JSON.stringify(b)

// M11: a server fault holds until the server answers again. A verdict from the cache or the local tier says nothing of the server. Null when the published health stays as it is.
export function noteJudgment(judgment: Judgment, at: number): ArbiterHealth | null {
  const current = health ?? baseHealth('unknown')
  const prior = current.reasons.find(r => r.kind === 'fault')
  const others = current.reasons.filter(r => r.kind !== 'fault')
  if (judgment.kind === 'verdict') {
    health = judgment.from === 'server' ? { ...current, reasons: others, lastVerdictAt: at, keyAccepted: true } : { ...current, lastVerdictAt: at }
    return health
  }
  if (!HEALTH_FAULTS.has(judgment.fault.kind)) return null
  if (prior?.kind === 'fault' && sameFault(prior.fault, judgment.fault)) return null
  health = { ...current, reasons: [...others, { kind: 'fault', fault: judgment.fault, since: at }] }
  return health
}

export function noteCatches(count: number): ArbiterHealth | null {
  const current = health ?? baseHealth('unknown')
  const prior = current.reasons.find(r => r.kind === 'catch-fired')
  if (count === 0 || (prior?.kind === 'catch-fired' && prior.count === count)) return null
  health = { ...current, reasons: [...current.reasons.filter(r => r.kind !== 'catch-fired'), { kind: 'catch-fired', count }] }
  return health
}

function noteRevoked(at: number): ArbiterHealth {
  const current = health ?? baseHealth('unknown')
  health = { ...current, reasons: [...current.reasons.filter(r => r.kind !== 'revoked'), { kind: 'revoked', at }] }
  return health
}

// M11 row 16 raises only for records that were lost, not for a queue that is merely full.
function noteBacklog(queued: number, dropped: number): ArbiterHealth | null {
  const current = health ?? baseHealth('unknown')
  const had = current.reasons.some(r => r.kind === 'evidence-backlog')
  if (dropped === 0 && !had) return null
  health = { ...current, reasons: [...current.reasons.filter(r => r.kind !== 'evidence-backlog'), { kind: 'evidence-backlog', queued, dropped }] }
  return health
}

// The index route that failed or went unrefreshed is a health reason (M11 row 16). A sync that went through stamps the time of the last one.
function noteIndex(stale: number | null, syncedAt: number | null): ArbiterHealth {
  const current = health ?? baseHealth('unknown')
  const others = current.reasons.filter(r => r.kind !== 'index-stale')
  health = {
    ...current,
    reasons: stale === null ? others : [...others, { kind: 'index-stale', since: stale }],
    ...(syncedAt !== null ? { lastSyncAt: syncedAt } : {}),
  }
  return health
}

// The reasons a probe run owns. A fault of the run replaces any fault, so health holds one fault at most.
const PROBE_FAULTS: ReadonlySet<ArbiterFault['kind']> = new Set(['no-key', 'key-rejected', 'key-wrong-type', 'unreachable', 'network-policy'])

export function noteProbe(outcome: ProbeOutcome): ArbiterHealth {
  const current = health ?? baseHealth('unknown')
  const isFault = outcome.reason?.kind === 'fault'
  const others = current.reasons.filter(r => r.kind !== 'not-configured' && r.kind !== 'bad-host' && !(r.kind === 'fault' && (isFault || PROBE_FAULTS.has(r.fault.kind))))
  const { keyPrefix, keyAccepted, ...rest } = current
  delete rest.hostChecked
  delete rest.keySet
  const rejected = outcome.reason?.kind === 'fault' && (outcome.reason.fault.kind === 'key-rejected' || outcome.reason.fault.kind === 'key-wrong-type')
  const key = outcome.keyPrefix !== null ? { keyPrefix: outcome.keyPrefix, keyAccepted: true as const } : rejected ? {} : { ...(keyPrefix === undefined ? {} : { keyPrefix }), ...(keyAccepted === undefined ? {} : { keyAccepted }) }
  health = { ...rest, ...key, ...(outcome.keySet ? {} : { keySet: false as const }), ...(outcome.hostProven ? { hostChecked: true as const } : {}), reasons: outcome.reason === null ? others : [...others, outcome.reason] }
  return health
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

function probeIo($: EngineInterface): ProbeIo {
  return {
    fetch: (url, init) => $.http.fetch(url, init),
    after: (ms, fn) => {
      $.clock.after(ms, fn)
    },
  }
}

// M1: no verdict path runs this. A revoked device sends no key, so its probes would only say what row 1 already says.
async function probeAndPublish($: EngineInterface): Promise<ArbiterHealth | null> {
  if (isRevoked()) return health
  const { config, reasons } = loadedOptions()
  const outcome = await runProbes({ host: config.host, authorization: config.key?.header() ?? null, configReasons: reasons }, probeIo($), Date.now())
  const next = noteProbe(outcome)
  showHealth($, next)
  return next
}

const INTRO_KEY = 'introShown'

// M2 and SC6: one setup line per start with a setup reason; else, while healthy, each intro once per machine.
async function startLines($: EngineInterface, current: ArbiterHealth | null): Promise<void> {
  if (current === null) return
  const hostName = hostNameOf(loadedOptions().config.host)
  const setup = setupSentenceOf(current.reasons, hostName)
  if (setup !== null) {
    $.ui.log(LOG.setup(setup, EFFECT[effectiveMode()]))
    return
  }
  if (isDegraded(current.reasons)) return
  const kind = isManagedInstall() ? 'managed' : 'self'
  const shown = await $.store.get(INTRO_KEY).catch(() => null)
  if (kind === 'managed' ? shown === 'managed' : shown !== undefined) return
  $.ui.log(kind === 'managed' ? LOG.intro_managed(hostName) : LOG.intro(hostName))
  await $.store.set(INTRO_KEY, kind).catch(() => undefined)
}

const policyOf = ($: EngineInterface): Promise<Settings | null> =>
  within(
    $,
    $.settings.read({ source: 'policy' }).catch(() => null),
    null,
  )

// The Status tab action r (M1). It runs beside the press, so the pane draws again as the probes publish.
export const recheckOnPress: Hook<'ui.press'> = async ($, e, next) => {
  void probeAndPublish($).catch(() => undefined)
  return next(e)
}

function opaIo($: EngineInterface): OpaIo {
  return {
    run: (argv, init) => $.process.run(argv, init),
    fetch: async (url, init) => {
      const reply = await $.http.fetch(url, init)
      return { status: reply.status, ok: reply.ok, text: reply.text }
    },
    stat: async path => {
      try {
        return { mtimeMs: (await $.fs.stat(path)).mtimeMs }
      } catch {
        return null
      }
    },
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
    now: () => Date.now(),
  }
}

// The authorization policy of the machine OPA ships in the mod folder. The digest of its text goes to the OPA as a label, so a later session can find an OPA that an older mod or a person started with another file. The label is not a proof: a process of the same user can start an OPA with other rules and the same label.
async function readAuthz($: EngineInterface): Promise<OpaAuthzFile | null> {
  const path = `${$.plugin.root}/opa/system-authz.rego`
  try {
    return { path, digest: sha256Hex(await $.fs.read(path)) }
  } catch {
    return null
  }
}

async function readChecksums($: EngineInterface): Promise<OpaChecksums | null> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(`${$.plugin.root}/opa/opa-checksums.json`))
    const { version, assets, downloadBaseUrl } = parsed as { version?: unknown; assets?: unknown; downloadBaseUrl?: unknown }
    if (typeof version !== 'string' || typeof assets !== 'object' || assets === null) return null
    return { version, assets: assets as Record<string, string>, ...(typeof downloadBaseUrl === 'string' ? { downloadBaseUrl } : {}) }
  } catch {
    return null
  }
}

function markerIo($: EngineInterface): MarkerIo {
  return {
    home: async () => (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')),
    sessionId: () => $.session.id(),
    now: () => $.clock.now(),
    write: (path, text) => $.fs.write(path, text),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  }
}

let installId = 'unknown'

export const currentInstallId = (): string => installId

const newInstallId = (): string => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)

// No get-then-set here is atomic: two sessions that start together may each mint one, and the re-read adopts the one the store kept (L11).
async function installIdOf($: EngineInterface): Promise<string> {
  const stored = await $.store.get(INSTALL_ID_KEY).catch(() => undefined)
  if (typeof stored === 'string' && stored !== '') return stored
  const minted = newInstallId()
  await $.store.set(INSTALL_ID_KEY, minted).catch(() => undefined)
  const kept = await $.store.get(INSTALL_ID_KEY).catch(() => undefined)
  return typeof kept === 'string' && kept !== '' ? kept : minted
}

async function modeIsPinned($: EngineInterface): Promise<boolean> {
  const rows = await $.config.list().catch(() => [])
  return rows.some(row => row.key === MODE_ROW && row.isLocked)
}

function evidenceContext($: EngineInterface): EvidenceContext {
  const { config } = loadedOptions()
  return { host: config.host, authorization: isRevoked() ? null : (config.key?.header() ?? null), io: ioFor($) }
}

// Also in gate/hooks.ts and evidence/append.ts: `claude plugin validate` follows $ only into a function declared in the same file.
function showHealth($: EngineInterface, next: ArbiterHealth): void {
  void $.state.set(HEALTH, next).catch(() => {})
  const text = statusLineOf(next.reasons, effectiveMode(), hostNameOf(loadedOptions().config.host))
  if (!statusChanged(text)) return
  try {
    $.ui.status(text)
    statusShown(text)
  } catch {
    return
  }
}

function publishEvidence($: EngineInterface): void {
  const current = meter()
  void $.state.set(EVIDENCE, current).catch(() => {})
  const next = noteBacklog(current.queued, current.dropped)
  if (next !== null) showHealth($, next)
}

async function flushTick($: EngineInterface): Promise<void> {
  await flushOnce(evidenceContext($)).catch(() => {})
  publishEvidence($)
  const caught = noteCatches(catchCount())
  if (caught !== null) showHealth($, caught)
}

// While no usable index stands the output check stays on (RC-17): the value is unknown, not false.
function postureFromIndex(): ArbiterPosture {
  const usable = usableIndex()
  posture = { ...posture, revision: heldIndex()?.revision ?? null, outputInspected: usable === null ? 'unknown' : usable.outputInspected }
  return posture
}

const INDEX_FOLLOW_GAP_MS = 250
const INDEX_RETRY_MS = 3_000
const INDEX_RETRIES_MAX = 5
let indexRetries = 0

async function indexTick($: EngineInterface): Promise<void> {
  const ctx = evidenceContext($)
  const wasOff = localIsOff()
  const outcome = await syncIndex({ host: ctx.host, authorization: ctx.authorization, io: ctx.io }).catch((): 'failed' => 'failed')
  if (outcome === 'skipped') return
  if (wasOff && !localIsOff()) showHealth($, noteLocal(localOutcome))
  const synced = outcome === 'loaded' || outcome === 'kept' ? await $.clock.now().catch(() => Date.now()) : null
  showHealth($, noteIndex(staleSince(), synced))
  void $.state.set(POSTURE, postureFromIndex()).catch(() => {})
  if ((outcome === 'loaded' || outcome === 'kept') && indexLongPoll()) {
    indexRetries = 0
    followIndex($, INDEX_FOLLOW_GAP_MS)
  } else if (outcome === 'failed' && indexSupportsWait() && indexRetries < INDEX_RETRIES_MAX) {
    indexRetries += 1
    followIndex($, INDEX_RETRY_MS)
  }
}

function followIndex($: EngineInterface, gapMs: number): void {
  if (indexFollow !== null) return
  try {
    indexFollow = $.clock.after(gapMs, () => {
      indexFollow = null
      void indexTick($)
    })
  } catch {
    indexFollow = null
  }
}

const SERVER_COMMAND_TEXT = {
  pinned: 'the mode is set by your organization',
  looser: 'the configured mode is stricter',
  mode: 'invalid enforcement mode',
  bundle: 'this client keeps no bundle',
  internal: 'internal error',
} as const

async function applyModeCommand($: EngineInterface, mode: unknown): Promise<CommandResult> {
  if (mode !== 'strict' && mode !== 'cooperative') return { outcome: 'failed', detail: SERVER_COMMAND_TEXT.mode }
  const result = applyServerMode(mode)
  if (result !== 'applied') return { outcome: 'ignored', detail: SERVER_COMMAND_TEXT[result] }
  await $.store.set(MODE_OVERRIDE_KEY, mode).catch(() => undefined)
  setPostureMode(effectiveMode(), 'server-command')
  void putMode(markerIo($), effectiveMode())
  void $.state.set(POSTURE, posture).catch(() => {})
  if (health !== null) showHealth($, health)
  return { outcome: 'applied', detail: `enforcementMode=${mode}` }
}

async function applyRevoke($: EngineInterface): Promise<CommandResult> {
  setRevoked(true)
  await $.store.set(REVOKED_KEY, true).catch(() => undefined)
  showHealth($, noteRevoked(Date.now()))
  return { outcome: 'applied', detail: 'revoked' }
}

async function applyCommand($: EngineInterface, command: Command): Promise<CommandResult> {
  try {
    switch (command.type) {
      case 'set_enforcement_mode':
        return await applyModeCommand($, command.mode)
      case 'revoke_self':
        return await applyRevoke($)
      case 'refresh_bundle':
        return { outcome: 'ignored', detail: SERVER_COMMAND_TEXT.bundle }
      default:
        return { outcome: 'ignored', detail: `unknown command type: ${command.type.slice(0, 32)}` }
    }
  } catch {
    return { outcome: 'failed', detail: SERVER_COMMAND_TEXT.internal }
  }
}

// A command the server delivers again is not applied again. It is acknowledged again only when the first acknowledgment did not arrive.
async function handleCommand($: EngineInterface, ctx: EvidenceContext, command: Command): Promise<void> {
  const prior = handledOf(command.id)
  if (prior?.acked) return
  const result = prior?.result ?? (await applyCommand($, command))
  rememberCommand(command.id, result, await ackCommand(ctx, installId, command.id, result))
}

async function heartbeatTick($: EngineInterface): Promise<void> {
  const ctx = evidenceContext($)
  if (ctx.host === null || ctx.authorization === null) return
  try {
    const commands = await sendHeartbeat(ctx, {
      installId,
      mode: effectiveMode(),
      modVersion: loadedOptions().config.version,
      engineVersion: health?.engineVersion ?? 'unknown',
      tier: posture.tier,
      bundleRevision: posture.revision,
      at: Date.now(),
    })
    for (const command of commands ?? []) await handleCommand($, ctx, command)
  } catch {
    return
  }
}

const LOCAL_RECHECK_MS = 10_000
const LOCAL_RECHECKS_MAX = 18

let localTimer: Timer | null = null
let localChecks = 0

async function localTick($: EngineInterface): Promise<void> {
  const { config } = loadedOptions()
  const token = isRevoked() ? '' : (config.key?.header().slice('Bearer '.length) ?? '')
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined)) || ''
  const checksums = await readChecksums($)
  const host = config.host ?? ''
  localSocket = home === '' || host === '' ? null : opaSocketPath(home, host)
  const held = heldSigningOf(await $.store.get(OPA_SIGNING_KEY).catch(() => undefined), host)
  const hold = (signing: HeldSigning | null): void => {
    const stored: StoredSigning | null = signing === null ? null : { host, ...signing }
    void $.store.set(OPA_SIGNING_KEY, stored).catch(() => undefined)
  }
  const outcome: OpaOutcome =
    checksums === null
      ? { local: 'off-failed', cause: 'binary-missing' }
      : await connectOpa(opaIo($), { host, home, token, authz: await readAuthz($), checksums, held, hold }).catch((): OpaOutcome => ({ local: 'off-failed', cause: 'spawn-failed' }))
  localChecks += 1
  const settled: OpaOutcome = outcome.local === 'starting' && localChecks >= LOCAL_RECHECKS_MAX ? { local: 'off-failed', cause: 'bundle-not-loaded' } : outcome
  showHealth($, noteLocal(settled))
  $.ui.log(`local checks ${settled.local}${settled.cause === undefined ? '' : ` ${settled.cause}`}${settled.started === true ? ' started' : ''}`, { to: 'debug' })
  const again = !localIsOff() && (settled.local === 'starting' || (settled.cause === 'key-unavailable' && localChecks < LOCAL_RECHECKS_MAX))
  if (again) localTimer = $.clock.after(LOCAL_RECHECK_MS, () => void localTick($))
}

let flushTimer: Timer | null = null
let beatTimer: Timer | null = null
let indexTimer: Timer | null = null
let indexFollow: Timer | null = null
let firstIndexTimer: Timer | null = null
let markerTimer: Timer | null = null
let firstBeatPending = true

function stopTimers(): void {
  flushTimer?.cancel()
  beatTimer?.cancel()
  indexTimer?.cancel()
  indexFollow?.cancel()
  indexRetries = 0
  firstIndexTimer?.cancel()
  markerTimer?.cancel()
  localTimer?.cancel()
  localTimer = null
  flushTimer = null
  beatTimer = null
  indexTimer = null
  indexFollow = null
  firstIndexTimer = null
  markerTimer = null
}

function beat($: EngineInterface): void {
  firstBeatPending = false
  void heartbeatTick($)
    .then(() => scheduleBeat($))
    .catch(() => undefined)
}

function scheduleBeat($: EngineInterface): void {
  if (isRevoked()) return
  beatTimer = $.clock.after(firstBeatPending ? FIRST_BEAT_MS : nextBeatDelay(Math.random()), () => beat($))
}

function startTimers($: EngineInterface): void {
  stopTimers()
  firstBeatPending = true
  localChecks = 0
  try {
    markerTimer = $.clock.every(MARKER_EVERY_MS, () => void putMarker(markerIo($), false))
    flushTimer = $.clock.every(FLUSH_EVERY_MS, () => void flushTick($))
    indexTimer = $.clock.every(INDEX_EVERY_MS, () => void indexTick($))
    scheduleBeat($)
    firstIndexTimer = $.clock.after(0, () => void indexTick($))
    localTimer = $.clock.after(0, () => void localTick($))
  } catch {
    stopTimers()
  }
}

export const startSession: Hook<'session.start'> = async ($, e, next) => {
  await putMarkerWithin(markerIo($), false, MARKER_WAIT_MS)
  facts = {
    isInteractive: e.isInteractive,
    sessionId: await $.session.id().catch(() => 'unknown'),
    desktopAskFallback: await desktopFallback($, e.surface),
    userId: await within($, userIdOfSession($).catch(() => null), null, IDENTITY_WAIT_MS),
  }
  const { config } = loadedOptions()
  const install = installOf(await policyOf($))
  posture = { ...posture, tier: install.tier, hostSource: install.hostSource, managedModsOnly: install.managedModsOnly }
  managedModeInvalid = install.modeInvalid
  const pinned = (await modeIsPinned($)) || install.modePinned
  if (pinned) setConfiguredMode(managedModeInvalid ? 'strict' : config.mode, true)
  applyStoredOverride(await $.store.get(MODE_OVERRIDE_KEY).catch(() => undefined))
  setPostureMode(effectiveMode(), pinned ? 'managed' : effectiveMode() === config.mode ? 'config' : 'server-command')
  void putMode(markerIo($), effectiveMode())
  setRevoked((await $.store.get(REVOKED_KEY).catch(() => undefined)) === true)
  installId = await installIdOf($)
  setEvidenceIdentity(facts.sessionId, installId, facts.userId)
  localOutcome = { local: 'starting' }
  mismatchRevision = null
  allowTier = allowTierOf(install)
  health = baseHealth(await engineVersion($))
  if (isRevoked()) noteRevoked(Date.now())
  noteSession('session_start', Date.now())
  await Promise.allSettled([
    $.state.set(HEALTH, health),
    $.state.set(POSTURE, posture),
    $.command.register({ name: 'langguard', description: COMMAND_DESCRIPTION, argumentHint: '[status]' }),
  ])
  showHealth($, health)
  startTimers($)
  const probed = probeAndPublish($)
    .catch(() => null)
    .then(current => startLines($, current))
    .catch(() => undefined)
  await within($, probed, undefined)
  return next(e)
}

// A turn that ends before the timed first beat sends it now, so a `claude -p` run that is over in seconds still beats (R4).
export const flushOnTurnComplete: Hook<'turn.complete'> = ($, e, next) => {
  void flushTick($)
  if (firstBeatPending && beatTimer !== null) {
    beatTimer.cancel()
    beat($)
  }
  return next(e)
}

// The session.end bound is short (1.5 s), so the flush keeps a margin for the engine's own end step.
const END_MARGIN_MS = 300

// After a /clear or /resume the process goes on under a new session id and no session.start fires, so the new session starts here.
async function startClearedSession($: EngineInterface, budgetMs: number): Promise<void> {
  const id = await within($, $.session.id().catch(() => facts.sessionId), facts.sessionId, Math.max(0, budgetMs))
  facts = { ...facts, sessionId: id }
  setEvidenceIdentity(id, installId, facts.userId)
  noteSession('session_start', Date.now())
}

// /clear and /resume move the process to another session without a new session.start, so the timers stay and the session restarts here.
const continuesProcess = (reason: string): boolean => reason === 'clear' || reason === 'resume'

export const endSession: Hook<'session.end'> = async ($, e, next) => {
  endConversation()
  noteSession('session_end', Date.now())
  if (!continuesProcess(e.reason)) stopTimers()
  await putMarkerWithin(markerIo($), true, Math.min(MARKER_WAIT_MS, Math.max(0, next.budget.remainingMs - END_MARGIN_MS)))
  await flushAll(evidenceContext($), next.budget.remainingMs - END_MARGIN_MS).catch(() => {})
  publishEvidence($)
  const ended = await next(e)
  if (continuesProcess(e.reason)) await startClearedSession($, next.budget.remainingMs - END_MARGIN_MS)
  return ended
}
