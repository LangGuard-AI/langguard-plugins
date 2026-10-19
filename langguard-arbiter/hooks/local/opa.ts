import {
  OPA_BEARER_ENV,
  OPA_LAUNCH_VERSION,
  OPA_KEY_NAME,
  OPA_PUBKEY_ENV,
  opaDir,
  opaKeyFingerprint,
  opaLaunchArgs,
  opaLogPath,
  opaPersistDir,
  opaSocketPath,
  opaStartLockPath,
  socketPathFits,
} from '../vendor/core/pure.ts'

export type OpaChecksums = { readonly version: string; readonly downloadBaseUrl?: string; readonly assets: Readonly<Record<string, string>> }

export type LocalState = 'on' | 'starting' | 'off-surface' | 'off-failed'

export type OpaCause =
  | 'not-configured'
  | 'binary-missing'
  | 'sha-mismatch'
  | 'download-failed'
  | 'spawn-failed'
  | 'bind-failed'
  | 'bundle-not-loaded'
  | 'sample-mismatch'
  | 'key-unavailable'

// `signed` is true only when this session holds a public key and OPA runs with it, so OPA verifies each bundle it loads. Any other state gives no local ALLOW. `instance` is the labels.id of that OPA process: the local tier is signed only while the socket answers with the same id (review lead note).
export type OpaOutcome = { readonly local: LocalState; readonly cause?: OpaCause; readonly started?: boolean; readonly signed?: boolean; readonly instance?: string }

export type RunResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
export type FetchResult = { readonly status: number; readonly ok: boolean; readonly text: string }

export type OpaIo = {
  readonly run: (argv: readonly string[], init?: { readonly env?: Record<string, string>; readonly timeoutMs?: number }) => Promise<RunResult>
  readonly fetch: (url: string, init?: { readonly socketPath?: string; readonly headers?: Record<string, string> }) => Promise<FetchResult>
  readonly stat: (path: string) => Promise<{ readonly mtimeMs: number } | null>
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly now: () => number
}

export type OpaAuthzFile = { readonly path: string, readonly digest: string }

export type OpaSetup = {
  readonly host: string
  readonly home: string
  readonly token: string
  readonly pinnedKey: string | null
  readonly opaPath: string | null
  readonly authz: OpaAuthzFile | null
  readonly checksums: OpaChecksums
  readonly heldScope: string | null
  readonly holdScope: (scope: string) => void
}

export const PROBE_MS = 300
export const START_WAIT_MS = 10_000
export const BUNDLE_WAIT_MS = 3_000
export const LOCK_STALE_MS = 20_000
export const POLL_MS = 200
export const BUNDLE_PERIOD_MS = 60_000
export const STUCK_MS = 3 * BUNDLE_PERIOD_MS
export const DOWNLOAD_MS = 120_000

const SCOPE_SHAPE = /^[A-Za-z0-9._-]{1,128}$/
// OPA splits a --set value at each comma after it has put the environment into the text, so a token that holds one would put a part of the key into its own error text.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/
const ASSETS: Readonly<Record<string, string>> = {
  'Darwin arm64': 'opa_darwin_arm64',
  'Darwin x86_64': 'opa_darwin_amd64',
  'Linux x86_64': 'opa_linux_amd64',
  'Linux aarch64': 'opa_linux_arm64_static',
  'Linux arm64': 'opa_linux_arm64_static',
}

export type HeldScope = { readonly host: string; readonly scope: string }

// The scope that the key route gave last, kept in the store with the host it belongs to.
export function heldScopeOf(stored: unknown, host: string): string | null {
  const { host: from, scope } = (typeof stored === 'object' && stored !== null ? stored : {}) as { host?: unknown; scope?: unknown }
  return from === host && typeof scope === 'string' && SCOPE_SHAPE.test(scope) ? scope : null
}

const regexEscape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const failed = (cause: OpaCause): OpaOutcome => ({ local: 'off-failed', cause })

type Timed<T> = { readonly value: T } | 'late' | 'failed'

async function within<T>(io: OpaIo, work: Promise<T>, ms: number): Promise<Timed<T>> {
  const stop = new AbortController()
  const late = io.sleep(ms, stop.signal).then(() => 'late' as const, () => 'late' as const)
  try {
    return await Promise.race([work.then((value): Timed<T> => ({ value }), (): Timed<T> => 'failed'), late])
  } finally {
    stop.abort()
  }
}

const settle = (io: OpaIo, ms: number): Promise<void> => io.sleep(ms, new AbortController().signal).catch(() => undefined)

async function ran(io: OpaIo, argv: readonly string[], init?: Parameters<OpaIo['run']>[1]): Promise<RunResult | null> {
  try {
    return await io.run(argv, init)
  } catch {
    return null
  }
}

// 'down' is a refused or failed connect. 'busy' is a connect that gave no answer in time: the process may be alive and slow, so it is never killed for it.
export type Probe = 'ready' | 'loading' | 'busy' | 'down'

export async function probeOpa(io: OpaIo, socketPath: string): Promise<Probe> {
  const answer = await within(io, io.fetch('http://localhost/health?bundles', { socketPath }), PROBE_MS)
  if (answer === 'late') return 'busy'
  if (answer === 'failed') return 'down'
  return answer.value.status === 200 ? 'ready' : 'loading'
}

// The revision that the bundle OPA holds states in its manifest. OPA does not check the age of a signature, so a replayed older bundle loads; the caller compares this revision with the one of the policy index.
export async function opaRevision(io: OpaIo, socketPath: string): Promise<string | null> {
  const answer = await within(io, io.fetch('http://localhost/v1/data/system/bundles/arbiter/manifest/revision', { socketPath }), PROBE_MS)
  if (answer === 'late' || answer === 'failed' || answer.value.status !== 200) return null
  try {
    const result = (JSON.parse(answer.value.text) as { result?: unknown }).result
    return typeof result === 'string' ? result : null
  } catch {
    return null
  }
}

async function sha256Of(io: OpaIo, path: string): Promise<string | null> {
  for (const argv of [['shasum', '-a', '256', path], ['sha256sum', path]]) {
    const out = await ran(io, argv)
    const hash = out?.exitCode === 0 ? /^([0-9a-f]{64})\b/.exec(out.stdout.trim())?.[1] : undefined
    if (hash !== undefined) return hash
  }
  return null
}

type Binary = { readonly path: string } | { readonly cause: OpaCause }

async function provision(io: OpaIo, setup: OpaSetup, asset: string, expected: string, target: string): Promise<Binary> {
  const base = (setup.checksums.downloadBaseUrl ?? 'https://openpolicyagent.org/downloads').replace(/\/+$/, '')
  const temp = `${target}.${Math.random().toString(36).slice(2)}.tmp`
  const folder = target.slice(0, target.lastIndexOf('/'))
  const got = await ran(io, ['/bin/sh', '-c', 'mkdir -p "$1" && curl -fsSL -o "$2" "$3"', 'sh', folder, temp, `${base}/v${setup.checksums.version}/${asset}`], { timeoutMs: DOWNLOAD_MS })
  if (got?.exitCode !== 0) {
    await ran(io, ['rm', '-f', temp])
    return { cause: 'download-failed' }
  }
  if ((await sha256Of(io, temp)) !== expected) {
    await ran(io, ['rm', '-f', temp])
    return { cause: 'sha-mismatch' }
  }
  const placed = await ran(io, ['/bin/sh', '-c', 'chmod 755 "$1" && mv -f "$1" "$2"', 'sh', temp, target])
  if (placed?.exitCode !== 0) {
    await ran(io, ['rm', '-f', temp])
    return { cause: 'download-failed' }
  }
  return { path: target }
}

async function verifiedBinary(io: OpaIo, setup: OpaSetup, platform: string): Promise<Binary> {
  const asset = ASSETS[platform]
  const expected = asset === undefined ? undefined : setup.checksums.assets[asset]
  if (asset === undefined || expected === undefined) return { cause: 'binary-missing' }
  const explicit = setup.opaPath !== null && setup.opaPath !== ''
  const path = explicit ? (setup.opaPath as string) : `${setup.home.replace(/\/+$/, '')}/.config/arbiter/bin/opa`
  const present = (await ran(io, ['test', '-f', path]))?.exitCode === 0
  if (!present) return explicit ? { cause: 'binary-missing' } : provision(io, setup, asset, expected, path)
  if ((await sha256Of(io, path)) === expected) return { path }
  // Only an explicit opa_path fails closed. The shared daemon replaces a default binary that fails its check, and so does the mod: a changed pin or a cut file would otherwise leave every machine without a local tier.
  return explicit ? { cause: 'sha-mismatch' } : provision(io, setup, asset, expected, path)
}

type Keyed = { readonly key: string; readonly scope?: string }
type Signing = Keyed | null | 'unavailable'
type Route = { readonly signing: Signing; readonly routeScope: string | undefined }

// The key route is asked on every start. A pinned key with a held scope still starts when the route does not answer, because the local tier exists for the time that the server is down (P8).
async function signingFor(io: OpaIo, setup: OpaSetup): Promise<Route> {
  const unreachable = (): Route => ({
    signing: setup.pinnedKey !== null && setup.heldScope !== null ? { key: setup.pinnedKey, scope: setup.heldScope } : 'unavailable',
    routeScope: undefined,
  })
  const reply = await within(io, io.fetch(`${setup.host}/api/arbiter/bundle-key`, { headers: { Authorization: `Bearer ${setup.token}` } }), START_WAIT_MS)
  if (reply === 'late' || reply === 'failed') return unreachable()
  if (reply.value.status === 404) return { signing: setup.pinnedKey === null ? null : { key: setup.pinnedKey }, routeScope: undefined }
  if (reply.value.status !== 200) return unreachable()
  try {
    const body = JSON.parse(reply.value.text) as { public_key_pem?: unknown; scope?: unknown }
    const scope = typeof body.scope === 'string' && SCOPE_SHAPE.test(body.scope) ? body.scope : undefined
    const key = setup.pinnedKey ?? (typeof body.public_key_pem === 'string' && body.public_key_pem.includes('PUBLIC KEY') ? body.public_key_pem : undefined)
    if (key === undefined || scope === undefined) return unreachable()
    return { signing: { key, scope }, routeScope: scope }
  } catch {
    return unreachable()
  }
}

type Observed = {
  readonly authz: boolean
  readonly authzDigest?: string
  readonly keyid?: string
  readonly scope?: string
  readonly fingerprint?: string
  readonly instance?: string
  readonly launch?: string
}

const known = (key: string, value: unknown): Record<string, string> => (typeof value === 'string' && value !== '' ? { [key]: value } : {})

// What the OPA found on the socket says about itself at data.system.authz.attest: the facts that the launch set (authorization on, the digest of the authorization file, the instance, the signing key and scope). The authorization policy answers only this and the revision; GET /v1/config is refused.
async function observedFacts(io: OpaIo, socketPath: string): Promise<Observed | null> {
  const answer = await within(io, io.fetch('http://localhost/v1/data/system/authz/attest', { socketPath }), PROBE_MS)
  if (answer === 'late' || answer === 'failed' || answer.value.status !== 200) return null
  try {
    const result = (JSON.parse(answer.value.text) as { result?: Record<string, unknown> }).result
    if (result === undefined || result === null || typeof result !== 'object') return null
    return {
      authz: result.authz === true,
      ...known('authzDigest', result.authz_digest),
      ...known('keyid', result.keyid),
      ...known('scope', result.scope),
      ...known('fingerprint', result.fingerprint),
      ...known('instance', result.instance),
      ...known('launch', result.launch),
    }
  } catch {
    return null
  }
}

// An OPA that was started without the authorization policy answers GET /v1/policies with the rules in it. One that was started with it refuses.
async function refusesPolicyList(io: OpaIo, socketPath: string): Promise<boolean> {
  const answer = await within(io, io.fetch('http://localhost/v1/policies', { socketPath }), PROBE_MS)
  return answer !== 'late' && answer !== 'failed' && (answer.value.status === 401 || answer.value.status === 403)
}

const lockedLike = (observed: Observed, authz: OpaAuthzFile): boolean =>
  observed.authz && observed.authzDigest === authz.digest && observed.launch === OPA_LAUNCH_VERSION

function startedLike(observed: Observed, signing: Keyed | null): boolean {
  if (signing === null) return observed.keyid === undefined
  return observed.keyid === OPA_KEY_NAME && observed.scope === signing.scope && observed.fingerprint === opaKeyFingerprint(signing.key)
}

async function prepareFolder(io: OpaIo, home: string): Promise<boolean> {
  const folder = opaDir(home)
  const out = await ran(io, ['/bin/sh', '-c', 'mkdir -p "$1" && chmod 700 "$1"', 'sh', folder])
  return out?.exitCode === 0
}

async function waitFor(io: OpaIo, socketPath: string, budgetMs: number, until: (probe: Probe) => boolean): Promise<Probe> {
  let waited = 0
  let last: Probe = await probeOpa(io, socketPath)
  while (!until(last) && waited < budgetMs) {
    await settle(io, POLL_MS)
    waited += POLL_MS
    last = await probeOpa(io, socketPath)
  }
  return last
}

const outcomeOf = (probe: Probe, started: boolean, signedBy: string | null = null): OpaOutcome =>
  probe === 'ready'
    ? { local: 'on', started, signed: signedBy !== null, ...(signedBy === null ? {} : { instance: signedBy }) }
    : probe === 'loading' || probe === 'busy'
      ? { local: 'starting', started }
      : failed('bind-failed')

const nonce = (): string => Math.random().toString(36).slice(2)

// A lock older than LOCK_STALE_MS is renamed first, and one session wins the rename. The age is read again from the renamed folder: a fresh lock that another session made after this one read the old age is put back and never removed.
async function breakStale(io: OpaIo, lock: string): Promise<boolean> {
  const made = await io.stat(lock).catch(() => null)
  if (made === null || io.now() - made.mtimeMs <= LOCK_STALE_MS) return false
  const moved = `${lock}.${nonce()}`
  if ((await ran(io, ['mv', lock, moved]))?.exitCode !== 0) return false
  const aged = await io.stat(moved).catch(() => null)
  const stale = aged !== null && io.now() - aged.mtimeMs > LOCK_STALE_MS
  if (!stale) await ran(io, ['/bin/sh', '-c', '[ -e "$2" ] || mv "$1" "$2"', 'sh', moved, lock])
  await ran(io, ['rmdir', moved])
  return stale
}

async function takeLock(io: OpaIo, lock: string, socketPath: string): Promise<'held' | 'alive' | 'timeout'> {
  let waited = 0
  let broke = false
  for (;;) {
    if ((await ran(io, ['mkdir', lock]))?.exitCode === 0) return 'held'
    if ((await probeOpa(io, socketPath)) !== 'down') return 'alive'
    if (!broke && (await breakStale(io, lock))) {
      broke = true
      continue
    }
    if (waited >= START_WAIT_MS) return 'timeout'
    await settle(io, POLL_MS)
    waited += POLL_MS
  }
}

const newInstance = (): string => {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function startOpa(io: OpaIo, setup: OpaSetup, authz: OpaAuthzFile, binary: string, socketPath: string, signing: Keyed | null): Promise<OpaOutcome> {
  const args = opaLaunchArgs({
    host: setup.host,
    socketPath,
    persistDir: opaPersistDir(setup.home, setup.host),
    bearerEnv: OPA_BEARER_ENV,
    authz: { ...authz, instance: newInstance() },
    ...(signing === null ? {} : { signing: { keyEnv: OPA_PUBKEY_ENV, ...(signing.scope === undefined ? {} : { scope: signing.scope }), fingerprint: opaKeyFingerprint(signing.key) } }),
  })
  const env: Record<string, string> = { [OPA_BEARER_ENV]: setup.token, ARBITER_OPA_LOG: opaLogPath(setup.home, setup.host) }
  if (signing !== null) env[OPA_PUBKEY_ENV] = signing.key
  await ran(io, ['rm', '-f', socketPath])
  const launched = await ran(io, ['/bin/sh', '-c', 'set -m; nohup "$0" "$@" >>"$ARBITER_OPA_LOG" 2>&1 </dev/null &', binary, ...args], { env })
  if (launched?.exitCode !== 0) return failed('spawn-failed')
  const alive = await waitFor(io, socketPath, START_WAIT_MS, probe => probe !== 'down')
  if (alive === 'down') return failed(await opaProcessAlive(io, socketPath) ? 'bind-failed' : 'spawn-failed')
  const loaded = alive === 'ready' ? alive : await waitFor(io, socketPath, BUNDLE_WAIT_MS, probe => probe === 'ready')
  const observed = signing === null || loaded !== 'ready' ? null : await observedFacts(io, socketPath)
  return outcomeOf(loaded, true, observed?.instance ?? null)
}

const processPattern = (socketPath: string): string => `unix://${regexEscape(socketPath)}( |$)`

async function opaProcessAlive(io: OpaIo, socketPath: string): Promise<boolean> {
  return (await ran(io, ['pgrep', '-f', '--', processPattern(socketPath)]))?.exitCode === 0
}

async function bundleStuck(io: OpaIo, socketPath: string): Promise<boolean> {
  const made = await io.stat(socketPath).catch(() => null)
  return made !== null && io.now() - made.mtimeMs > STUCK_MS
}

// What a session may attach to: an OPA that answers, that is not stuck on its bundle, that states this authorization file and refuses the policy list, and that states the signing this session would start it with. null means that the caller must start one.
async function attachable(io: OpaIo, socketPath: string, authz: OpaAuthzFile, route: () => Promise<Route>): Promise<OpaOutcome | null> {
  const probe = await probeOpa(io, socketPath)
  if (probe === 'down') return null
  if (probe === 'busy') return (await opaProcessAlive(io, socketPath)) ? { local: 'starting', started: false } : null
  if (probe === 'loading' && (await bundleStuck(io, socketPath))) return null
  const observed = await observedFacts(io, socketPath)
  if (observed === null || !lockedLike(observed, authz) || !(await refusesPolicyList(io, socketPath))) return null
  const { signing } = await route()
  let signedBy: string | null = null
  if (signing !== 'unavailable') {
    if (!startedLike(observed, signing)) return null
    signedBy = signing !== null ? (observed.instance ?? null) : null
  }
  return outcomeOf(probe, false, signedBy)
}

export async function connectOpa(io: OpaIo, setup: OpaSetup): Promise<OpaOutcome> {
  if (setup.host === '' || setup.token === '' || setup.home === '' || !TOKEN_SHAPE.test(setup.token)) return failed('not-configured')
  const platform = await io.run(['uname', '-sm']).then(out => (out.exitCode === 0 ? out.stdout.trim() : null), () => 'off-surface' as const)
  if (platform === 'off-surface') return { local: 'off-surface' }
  if (platform === null) return failed('spawn-failed')

  const socketPath = opaSocketPath(setup.home, setup.host)
  if (!socketPathFits(socketPath)) return failed('bind-failed')
  const { authz } = setup
  if (authz === null) return failed('spawn-failed')

  let asked: Promise<Route> | null = null
  const route = (): Promise<Route> => {
    asked ??= signingFor(io, setup).then(answer => {
      if (answer.routeScope !== undefined && answer.routeScope !== setup.heldScope) setup.holdScope(answer.routeScope)
      return answer
    })
    return asked
  }

  const found = await attachable(io, socketPath, authz, route)
  if (found !== null) return found

  const binary = await verifiedBinary(io, setup, platform)
  if ('cause' in binary) return failed(binary.cause)
  if (!(await prepareFolder(io, setup.home))) return failed('bind-failed')
  const { signing } = await route()
  if (signing === 'unavailable') return failed('key-unavailable')

  const lock = opaStartLockPath(setup.home, setup.host)
  const took = await takeLock(io, lock, socketPath)
  if (took === 'timeout') return { local: 'starting', started: false }
  if (took === 'alive') return outcomeOf(await probeOpa(io, socketPath), false)
  try {
    const now = await attachable(io, socketPath, authz, route)
    if (now !== null) return now
    await ran(io, ['pkill', '-f', '--', processPattern(socketPath)])
    return await startOpa(io, setup, authz, binary.path, socketPath, signing)
  } finally {
    await ran(io, ['rmdir', lock])
  }
}
