export const STARTUP_GRACE_MS = 20_000;
export const HEARTBEAT_STALE_MS = 15_000;

export function ownerAlive(state) {
  const pid = state?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function classifyGrace(state, now) {
  if (!state) {
    return {
      verdict: 'warming',
      category: 'absent',
      reason: 'The daemon state file is absent. The daemon never started.',
    };
  }

  const started = Date.parse(state.startedAt);
  const withinStartupGrace = Number.isFinite(started) && now - started < STARTUP_GRACE_MS;

  if (state.opaProvisioning === true) {
    // A daemon killed during setup freezes this flag on disk. Without the liveness gate the
    // corpse reads as a bounded transient for the rest of the session.
    if (ownerAlive(state)) {
      return {
        verdict: 'warming',
        category: 'transient',
        reason: 'The policy engine binary is in download. This is the first run.',
      };
    }
    return {
      verdict: 'warming',
      category: 'no-daemon',
      reason: `The owner process ${state.pid ?? '(none)'} stopped during policy engine setup. The state is stale.`,
    };
  }

  if (state.ready !== true) {
    return {
      verdict: 'warming',
      category: withinStartupGrace ? 'transient' : 'no-daemon',
      reason: `The daemon is not ready (ready=${String(state.ready)}).`,
    };
  }

  if (withinStartupGrace) {
    return {
      verdict: 'warming',
      category: 'transient',
      reason: `The daemon is in the startup window (${now - started}ms of ${STARTUP_GRACE_MS}ms).`,
    };
  }

  // An exited session can leave a frozen ready flag on disk, so owner liveness decides here,
  // not the flag.
  if (!ownerAlive(state)) {
    return {
      verdict: 'warming',
      category: 'no-daemon',
      reason: `The owner process ${state.pid ?? '(none)'} is not alive. The state is stale.`,
    };
  }

  const heartbeat = Date.parse(state.lastHeartbeat);
  if (!Number.isFinite(heartbeat)) {
    return {
      verdict: 'dead',
      category: 'wedged',
      reason: 'The daemon reports ready, has no valid heartbeat, and does not answer.',
    };
  }

  const age = now - heartbeat;
  if (age > HEARTBEAT_STALE_MS) {
    return {
      verdict: 'dead',
      category: 'wedged',
      reason: `The heartbeat is ${age}ms old and the daemon does not answer.`,
    };
  }

  return {
    verdict: 'dead',
    category: 'wedged',
    reason: 'The daemon reports ready with a fresh heartbeat but does not answer.',
  };
}

export function classifyDaemon(state, now, reachable) {
  if (state == null) return { kind: 'absent' };
  if (reachable === true && state.ready) {
    return { kind: 'healthy', pid: state.pid, bundleRevision: state.bundle_revision ?? null };
  }
  const grace = classifyGrace(state, now);
  return { kind: grace.category, reason: grace.reason };
}
