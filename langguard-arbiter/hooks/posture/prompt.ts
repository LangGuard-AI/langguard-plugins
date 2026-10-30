import type { EngineInterface, Hook } from 'claude-code'
import { MARKER_WAIT_MS, putMarkerWithin, type MarkerIo } from '../evidence/marker.ts'
import { sessionFacts } from '../state.ts'
import { buildPostureContext } from '../vendor/claude/posture-context.ts'
import { claimContext, contextKeyOf, expireIndex, releaseContext, usableIndex, type Claim } from './index.ts'

type Pending = { readonly text: string; readonly claim: Claim }

// Nothing here may stop a prompt: any fault leaves the prompt without the context.
function pendingContext(now: number | null): Pending | null {
  try {
    if (now !== null) expireIndex(now)
    const index = usableIndex()
    if (index === null) return null
    const claim = claimContext(contextKeyOf(sessionFacts().sessionId, index.revision))
    if (claim === null) return null
    return { text: buildPostureContext(index.screen, { forMod: true }), claim }
  } catch {
    return null
  }
}

// M9, L18: the context goes with the first prompt of a conversation, with the first prompt after a new policy revision, and with the first prompt after the index first loads.
function markerIo($: EngineInterface): MarkerIo {
  return {
    home: async () => (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')),
    sessionId: () => $.session.id(),
    now: () => $.clock.now(),
    write: (path, text) => $.fs.write(path, text),
    sleep: (ms, signal) => $.clock.sleep(ms, { signal }),
  }
}

export const addPostureContext: Hook<'prompt.submit'> = async ($, e, next) => {
  await putMarkerWithin(markerIo($), false, MARKER_WAIT_MS)
  const pending = pendingContext(await $.clock.now().catch(() => null))
  if (pending === null) return next(e)
  try {
    const entered = await next({ ...e, context: [...(e.context ?? []), pending.text] })
    if (entered.drop !== undefined) releaseContext(pending.claim)
    return entered
  } catch (err) {
    releaseContext(pending.claim)
    throw err
  }
}
