export type ArbiterVerdict = 'ALLOW' | 'BLOCK' | 'ASK'
export type ArbiterMode = 'cooperative' | 'strict'

export type ArbiterFault =
  | { kind: 'no-key' }
  | { kind: 'key-rejected'; status: 401 | 403 }
  | { kind: 'unreachable'; cause: 'network' | 'timeout' | 'http-5xx' | 'tls' }
  | { kind: 'rate-limited' }
  | { kind: 'bad-reply' }
  | { kind: 'network-policy' }
  | { kind: 'internal'; cause: 'throw' | 'timeout' }
  | { kind: 'oversize' }
  | { kind: 'bad-name' }

export type ArbiterHealthReason =
  | { kind: 'not-configured'; missing: 'host' | 'key' | 'both' }
  | { kind: 'bad-host'; why: 'not-https' | 'shared-host' | 'not-langguard' | 'login' }
  | { kind: 'bad-mode' }
  | { kind: 'fault'; fault: ArbiterFault; since: number }
  | { kind: 'index-stale'; since: number }
  | { kind: 'evidence-backlog'; queued: number; dropped: number }
  | { kind: 'revoked'; at: number }
  | { kind: 'catch-fired'; count: number }
  | { kind: 'unchecked-run'; count: number }

export type ArbiterLocalState = 'on' | 'starting' | 'off-surface' | 'off-failed'

export type ArbiterLocalCause =
  | 'not-configured'
  | 'binary-missing'
  | 'sha-mismatch'
  | 'download-failed'
  | 'spawn-failed'
  | 'bind-failed'
  | 'bundle-not-loaded'
  | 'sample-mismatch'
  | 'key-unavailable'

export type ArbiterHealth = {
  reasons: ArbiterHealthReason[]
  local: ArbiterLocalState
  localCause?: ArbiterLocalCause
  lastVerdictAt?: number
  lastSyncAt?: number
  host: string | null
  // The host option as typed, only when it did not parse.
  hostText?: string
  keyPrefix?: string
  keyAccepted?: true
  // Set by the M1 probe run: keySet false when the key option is empty, hostChecked when probes 1 to 3 passed.
  keySet?: false
  hostChecked?: true
  displayName?: string
  modVersion: string
  engineVersion: string
}

export type ArbiterPosture = {
  mode: ArbiterMode
  modeSource: 'config' | 'managed' | 'server-command'
  hostSource: 'config' | 'managed'
  managedModsOnly: boolean | 'unknown'
  tier: 'user' | 'org' | 'unknown'
  revision: string | null
  outputInspected: boolean | 'unknown'
}

export type ArbiterCallView = {
  id: string
  tool: string
  server: string
  agentId?: string
  agentLabel?: string
  phase: 'judging' | 'cleared' | 'asking' | 'settled'
  verdict?: ArbiterVerdict
  from?: 'server' | 'cache' | 'fault'
  outcome?: 'ran' | 'denied' | 'aborted' | 'ran-unchecked'
  withheld?: 'policy' | 'fault'
  slow?: true
  at: number
}

export type ArbiterLedger = {
  order: string[]
  counts: { checked: number; allowed: number; asked: number; blocked: number; withheld: number; faults: number }
}

export type ArbiterEvidenceMeter = { seq: number; queued: number; dropped: number; lastFlushAt?: number }

export type ArbiterView = { tab: 'session' | 'status'; copied?: true; copyFailed?: true }

declare module 'claude-code' {
  interface PluginState {
    'langguard-arbiter': {
      health: ArbiterHealth
      posture: ArbiterPosture
      ledger: ArbiterLedger
      call: StateFamily<ArbiterCallView>
      evidence: ArbiterEvidenceMeter
      view: ArbiterView
    }
  }
}
