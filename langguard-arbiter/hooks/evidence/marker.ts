export const MARKER_EVERY_MS = 5000
export const MARKER_WAIT_MS = 1000
const ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/

export type MarkerIo = {
  readonly home: () => Promise<string | undefined>
  readonly sessionId: () => Promise<string>
  readonly now: () => Promise<number>
  readonly write: (path: string, text: string) => Promise<void>
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

export const markerPathOf = (home: string, sessionId: string): string | null =>
  home !== '' && ID_SHAPE.test(sessionId) ? `${home.replace(/[\\/]+$/, '')}/.config/arbiter/claude-mod/alive/${sessionId}.json` : null

export const markerText = (sessionId: string, at: number, ended: boolean): string =>
  JSON.stringify(ended ? { v: 1, sessionId, at, ended: true } : { v: 1, sessionId, at })

export async function putMarker(io: MarkerIo, ended: boolean): Promise<void> {
  try {
    const home = await io.home()
    const id = await io.sessionId()
    const at = await io.now()
    const path = markerPathOf(home ?? '', id)
    if (path !== null) await io.write(path, markerText(id, at, ended))
  } catch {
    return
  }
}

export async function putMarkerWithin(io: MarkerIo, ended: boolean, waitMs: number): Promise<void> {
  const stop = new AbortController()
  const late = io.sleep(waitMs, stop.signal).catch(() => undefined)
  try {
    await Promise.race([putMarker(io, ended), late])
  } finally {
    stop.abort()
  }
}

export const modePathOf = (home: string): string | null => (home !== '' ? `${home.replace(/[\\/]+$/, '')}/.config/arbiter/claude-mod/mode` : null)

// The sentinel reads this word when the mod fails to load, so a strict mode that a server command set stays strict.
export async function putMode(io: MarkerIo, mode: 'strict' | 'cooperative'): Promise<void> {
  try {
    const path = modePathOf((await io.home()) ?? '')
    if (path !== null) await io.write(path, mode)
  } catch {
    return
  }
}
