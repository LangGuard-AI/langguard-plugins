import type { PluginOptions } from 'claude-code'
import type { ArbiterHealthReason, ArbiterMode } from '../types'

export const MOD_VERSION = '1.0.23'

export type ApiKey = { readonly header: () => string; readonly toJSON: () => '[redacted]' }

export type ArbiterConfig = {
  readonly host: string | null
  readonly hostText: string | null
  readonly key: ApiKey | null
  readonly mode: ArbiterMode
  readonly version: string
}

type HostResult = { readonly host: string } | { readonly missing: true } | { readonly reason: ArbiterHealthReason }

const NOT_HTTPS: ArbiterHealthReason = { kind: 'bad-host', why: 'not-https' }
const HAS_LOGIN: ArbiterHealthReason = { kind: 'bad-host', why: 'login' }
const BAD_MODE: ArbiterHealthReason = { kind: 'bad-mode' }
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname) || hostname.endsWith('.localhost')
}

function parseHost(raw: unknown): HostResult {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return { missing: true }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { reason: NOT_HTTPS }
  }
  if (url.username !== '' || url.password !== '') return { reason: HAS_LOGIN }
  if (url.hostname.includes('lgr_')) return { reason: NOT_HTTPS }
  const isSecure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname))
  return isSecure ? { host: url.origin } : { reason: NOT_HTTPS }
}

// Only the exact value cooperative gives cooperative mode. A missing or empty value keeps the plugin.json default, cooperative (P6). Any other value is strict, with a reason.
function parseMode(raw: unknown): { mode: ArbiterMode; reasons: ArbiterHealthReason[] } {
  if (raw === undefined || raw === null || raw === '' || raw === 'cooperative') return { mode: 'cooperative', reasons: [] }
  return { mode: 'strict', reasons: raw === 'strict' ? [] : [BAD_MODE] }
}

function parseKey(raw: unknown): ApiKey | null {
  const token = typeof raw === 'string' ? raw.trim() : ''
  if (token === '') return null
  return Object.freeze({ header: () => `Bearer ${token}`, toJSON: () => '[redacted]' as const })
}

const textOf = (raw: unknown): string | null => (typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null)

// A person may paste a key or a URL with a password into the host field, and the text as typed reaches $.state and the screen (UX spec section 8 rule 9). The userinfo ends at the last @.
function typedHostOf(raw: unknown): string | null {
  const text = textOf(raw)?.replace(/lgr_\S*/gi, 'lgr_...')
  if (text === undefined) return null
  const at = text.lastIndexOf('@')
  return at < 0 ? text : `${/^[a-z][a-z0-9+.-]*:\/\//i.exec(text)?.[0] ?? ''}${text.slice(at + 1)}`
}

export function parseOptions(options: PluginOptions | null | undefined): { config: ArbiterConfig; reasons: ArbiterHealthReason[] } {
  const given: PluginOptions = options ?? {}
  const { host: rawHost, api_token: rawKey, enforcement_mode: rawMode } = given
  const host = parseHost(rawHost)
  const key = parseKey(rawKey)
  const { mode, reasons: modeReasons } = parseMode(rawMode)
  const reasons: ArbiterHealthReason[] = []
  if ('missing' in host && key === null) reasons.push({ kind: 'not-configured', missing: 'both' })
  else if ('missing' in host) reasons.push({ kind: 'not-configured', missing: 'host' })
  if ('reason' in host) reasons.push(host.reason)
  if (key === null && !('missing' in host)) reasons.push({ kind: 'not-configured', missing: 'key' })
  reasons.push(...modeReasons)
  return {
    config: {
      host: 'host' in host ? host.host : null,
      hostText: 'reason' in host ? typedHostOf(rawHost) : null,
      key,
      mode,
      version: MOD_VERSION,
    },
    reasons,
  }
}

let loaded = parseOptions(undefined)

export function loadOptions(options: PluginOptions): { config: ArbiterConfig; reasons: ArbiterHealthReason[] } {
  loaded = parseOptions(options)
  return loaded
}

export function loadedOptions(): { config: ArbiterConfig; reasons: ArbiterHealthReason[] } {
  return loaded
}
