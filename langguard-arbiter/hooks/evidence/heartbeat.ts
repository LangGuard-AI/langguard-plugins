import type { ArbiterMode } from '../../types'
import { SEND_TIMEOUT_MS, postJson, type EvidenceContext } from './queue.ts'
import { HARNESS } from '../verdict/source.ts'

export const HEARTBEAT_EVERY_MS = 60_000
// R4: the first beat comes soon after boot, so a short session still reports its mode and still hears a command.
export const FIRST_BEAT_MS = 5000
export const HEARTBEAT_JITTER = 0.1
export const HEARTBEAT_PATH = '/api/arbiter/heartbeat'
export const DAEMON_VERSION_MAX = 64
const SEEN_MAX = 200

export const ackPath = (id: string): string => `/api/arbiter/commands/${encodeURIComponent(id)}/ack`

// 60 s, spread by plus or minus 10 percent so a fleet does not beat together. `random` is in [0, 1).
export const nextBeatDelay = (random: number): number => Math.round(HEARTBEAT_EVERY_MS * (1 - HEARTBEAT_JITTER + 2 * HEARTBEAT_JITTER * random))

export type HeartbeatFacts = {
  readonly installId: string
  readonly mode: ArbiterMode
  readonly modVersion: string
  readonly engineVersion: string
  readonly tier: string
  readonly bundleRevision: string | null
  readonly at: number
}

// R4: the mod version, the Claude Code version and the tier ride in the one string the server stores for the version.
export const daemonVersionOf = (facts: Pick<HeartbeatFacts, 'modVersion' | 'engineVersion' | 'tier'>): string =>
  `mod-${facts.modVersion} claude-${facts.engineVersion} tier-${facts.tier}`.slice(0, DAEMON_VERSION_MAX)

export function heartbeatBody(facts: HeartbeatFacts) {
  return {
    install_id: facts.installId,
    daemon_version: daemonVersionOf(facts),
    owner_harness: HARNESS,
    enforcement_mode: facts.mode,
    ...(facts.bundleRevision !== null ? { bundle_revision: facts.bundleRevision } : {}),
    active_harnesses: [{ harness: HARNESS, plugin_version: facts.modVersion, ask_capable: true, sessions: 1, last_active_at: new Date(facts.at).toISOString() }],
  }
}

export type Command = { readonly id: string; readonly type: string; readonly mode?: unknown }
export type AckOutcome = 'applied' | 'ignored' | 'failed'
export type CommandResult = { readonly outcome: AckOutcome; readonly detail?: string }

export function parseCommands(text: string): Command[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return []
  }
  const list = typeof json === 'object' && json !== null ? (json as { commands?: unknown }).commands : undefined
  if (!Array.isArray(list)) return []
  const commands: Command[] = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const { id, type, payload } = item as { id?: unknown; type?: unknown; payload?: unknown }
    if (typeof id !== 'string' || id === '' || typeof type !== 'string') continue
    const mode = payload !== null && typeof payload === 'object' ? (payload as { mode?: unknown }).mode : undefined
    commands.push({ id, type, mode })
  }
  return commands
}

export async function sendHeartbeat(ctx: EvidenceContext, facts: HeartbeatFacts): Promise<Command[] | null> {
  const response = await postJson(ctx, HEARTBEAT_PATH, heartbeatBody(facts), SEND_TIMEOUT_MS)
  if (typeof response === 'string' || !response.ok) return null
  return parseCommands(response.text)
}

export async function ackCommand(ctx: EvidenceContext, installId: string, id: string, result: CommandResult): Promise<boolean> {
  const response = await postJson(ctx, ackPath(id), { install_id: installId, outcome: result.outcome, ...(result.detail !== undefined ? { detail: result.detail } : {}) }, SEND_TIMEOUT_MS)
  return typeof response !== 'string' && response.ok
}

type Handled = { readonly result: CommandResult; acked: boolean }
const handled = new Map<string, Handled>()

export const handledOf = (id: string): Handled | undefined => handled.get(id)

export function rememberCommand(id: string, result: CommandResult, acked: boolean): void {
  handled.set(id, { result, acked })
  if (handled.size > SEEN_MAX) {
    const oldest = handled.keys().next().value
    if (oldest !== undefined) handled.delete(oldest)
  }
}
