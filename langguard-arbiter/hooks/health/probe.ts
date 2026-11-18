import type { HttpInit, HttpResponse, Settings } from 'claude-code'
import type { ArbiterFault, ArbiterHealthReason, ArbiterPosture } from '../../types'
import { fetchFailureText, fetchFault, keyFaultOf } from '../verdict/source.ts'

export const SHARED_HOST = 'app.langguard.ai'
export const HEALTH_PATH = '/api/health'
export const WHOAMI_PATH = '/api/arbiter/whoami'
export const PROBE_WAIT_MS = 2500

export type ProbeIo = {
  readonly fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  readonly after: (ms: number, fn: () => void) => void
}

export type ProbeInput = {
  readonly host: string | null
  readonly authorization: string | null
  readonly configReasons: readonly ArbiterHealthReason[]
}

// hostProven: probes 1 to 3 passed. keySet: the key option holds a key, which the reasons no longer say once a later probe fails.
export type ProbeOutcome = { readonly reason: ArbiterHealthReason | null; readonly keyPrefix: string | null; readonly hostProven: boolean; readonly keySet: boolean }

const TLS = /CERT|SSL|TLS|self.signed/i

function failureOf(err: unknown): ArbiterFault {
  const text = fetchFailureText(err instanceof Error ? err.message : String(err))
  return TLS.test(text) ? { kind: 'unreachable', cause: 'tls' } : fetchFault(err)
}

async function probeGet(io: ProbeIo, url: string, headers: Record<string, string>): Promise<HttpResponse | { readonly fault: ArbiterFault }> {
  const late = new Promise<{ fault: ArbiterFault }>(resolve => {
    io.after(PROBE_WAIT_MS, () => resolve({ fault: { kind: 'unreachable', cause: 'timeout' } }))
  })
  const asked = io.fetch(url, { method: 'GET', headers }).catch((err: unknown) => ({ fault: failureOf(err) }))
  return Promise.race([asked, late])
}

const jsonOf = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// The body of server/http/app.ts registerHealthRoute.
const isLangGuardHealth = (text: string): boolean => {
  const body = jsonOf(text)
  return body !== null && typeof body.status === 'string' && typeof body.opa === 'object' && typeof body.opencite === 'object'
}

// The server sends the first 12 characters of the key. A longer value could be the key itself (R9).
const KEY_PREFIX = /^lgr_[A-Za-z0-9_-]{1,8}$/

const prefixOf = (text: string): string | null => {
  const value = jsonOf(text)?.keyPrefix
  return typeof value === 'string' && KEY_PREFIX.test(value) ? value : null
}

const faultReason = (fault: ArbiterFault, since: number): ArbiterHealthReason => ({ kind: 'fault', fault, since })

// The four probes of M1 in order. The first failure is the one reason; no probe runs after it. The key goes only to a host that answered as LangGuard.
// An arbiter key passes every check of the server but /v1/logs refuses its evidence records, so whoami naming that scope is a key of the wrong type. A server that names no scope is not a fault.
export async function runProbes(input: ProbeInput, io: ProbeIo, now: number): Promise<ProbeOutcome> {
  const none = { reason: null, keyPrefix: null, hostProven: false, keySet: input.authorization !== null }
  const first = input.configReasons.find(r => r.kind !== 'bad-mode' && !(r.kind === 'not-configured' && r.missing === 'key'))
  if (first !== undefined) return { ...none, reason: first }
  if (input.host === null) return { ...none, reason: { kind: 'not-configured', missing: 'host' } }
  if (new URL(input.host).hostname.replace(/\.$/, '') === SHARED_HOST) return { ...none, reason: { kind: 'bad-host', why: 'shared-host' } }
  const health = await probeGet(io, `${input.host}${HEALTH_PATH}`, {})
  if ('fault' in health) return { ...none, reason: faultReason(health.fault, now) }
  if (health.status >= 500 && health.status < 600) return { ...none, reason: faultReason({ kind: 'unreachable', cause: 'http-5xx' }, now) }
  if (health.status !== 200 || !isLangGuardHealth(health.text)) return { ...none, reason: { kind: 'bad-host', why: 'not-langguard' } }
  const proven = { ...none, hostProven: true }
  if (input.authorization === null) return { ...proven, reason: { kind: 'not-configured', missing: 'key' } }
  const whoami = await probeGet(io, `${input.host}${WHOAMI_PATH}`, { Authorization: input.authorization })
  if ('fault' in whoami) return { ...proven, reason: faultReason(whoami.fault, now) }
  const keyFault = keyFaultOf(whoami)
  if (keyFault !== null) return { ...proven, reason: faultReason(keyFault, now) }
  if (whoami.status >= 500 && whoami.status < 600) return { ...proven, reason: faultReason({ kind: 'unreachable', cause: 'http-5xx' }, now) }
  if (whoami.status === 200 && jsonOf(whoami.text)?.scope === 'arbiter') return { ...proven, reason: faultReason({ kind: 'key-wrong-type' }, now) }
  return { ...proven, keyPrefix: whoami.status === 200 ? prefixOf(whoami.text) : null }
}

export type Install = Pick<ArbiterPosture, 'tier' | 'hostSource' | 'managedModsOnly'> & { readonly modePinned: boolean; readonly modeInvalid: boolean }

const PLUGIN_ID = /^langguard-arbiter@/
const GUARD = 'cc-plugin-sec-default@builtin'

const recordOf = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== ''

// M12 from the managed source (O13). Only managed prependPlugins with the same id turned on in managed enabledPlugins proves tier org. Nothing proves tier user (L22, S5). Null: the read failed.
export function installOf(policy: Settings | null): Install {
  if (policy === null) return { tier: 'unknown', hostSource: 'config', managedModsOnly: 'unknown', modePinned: false, modeInvalid: false }
  const enabled = recordOf(policy.enabledPlugins)
  const prepend = Array.isArray(policy.prependPlugins) ? policy.prependPlugins.filter((id): id is string => typeof id === 'string') : null
  const isOrg = (prepend ?? []).some(id => PLUGIN_ID.test(id) && enabled[id] === true)
  const configs = recordOf(policy.pluginConfigs)
  const pins = Object.entries(configs)
    .filter(([id]) => PLUGIN_ID.test(id))
    .map(([, row]) => recordOf(recordOf(row).options))
  const guardOn = prepend === null || prepend.includes(GUARD)
  return {
    tier: isOrg ? 'org' : 'unknown',
    hostSource: pins.some(options => isSet(options.host)) ? 'managed' : 'config',
    managedModsOnly: guardOn && recordOf(recordOf(configs[GUARD]).options).allowManagedModsOnly === true,
    modePinned: pins.some(options => isSet(options.enforcement_mode)),
    // The engine reads a stored option outside the options of plugin.json as unset, so register() gets the default for a typo. Only this raw value shows it.
    modeInvalid: pins.some(options => isSet(options.enforcement_mode) && options.enforcement_mode !== 'cooperative' && options.enforcement_mode !== 'strict'),
  }
}

// L22b: tier (b) is an org install whose managed settings leave other mods allowed. A managedModsOnly of 'unknown' (a failed read) and true (tier (c)) give false, and so does a self-install, which the managed read cannot prove.
export const allowTierOf = (install: Pick<Install, 'tier' | 'managedModsOnly'>): boolean => install.tier === 'org' && install.managedModsOnly === false
