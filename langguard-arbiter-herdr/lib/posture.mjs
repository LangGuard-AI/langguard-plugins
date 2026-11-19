import { STARTUP_GRACE_MS } from './grace.mjs';

export const POSTURE_TOKEN = Object.freeze({
  enforcing: 'ENFORCING',
  unproven: 'UNPROVEN',
  warming: 'WARMING',
  exposed: 'EXPOSED',
  wedged: 'WEDGED',
  unsupported: 'UNCOVERED',
  unmonitored: null,
  unknown: null,
});

export const POSTURE_SUMMARY = Object.freeze({
  enforcing: 'Arbiter is live and this agent sent a decision through it.',
  unproven: 'Arbiter is live but this agent has not sent a decision yet.',
  warming: 'Arbiter is starting. Coverage is not confirmed yet.',
  exposed: 'Arbiter does not run. This agent has no policy control.',
  wedged: 'Arbiter runs but does not answer. Coverage is broken.',
  unsupported: 'Arbiter has no plugin for this agent. It has no policy control.',
  unmonitored: 'No agent runs in this pane.',
  unknown: 'Coverage is not known.',
});

const DAEMON_RESOLVERS = Object.freeze({
  healthy: (daemon, proofValid) => (proofValid ? 'enforcing' : 'unproven'),
  transient: () => 'warming',
  absent: (daemon) => {
    const age = daemon.firstContactAgeMs;
    if (typeof age !== 'number' || !Number.isFinite(age)) return 'unknown';
    return age < STARTUP_GRACE_MS ? 'warming' : 'exposed';
  },
  'no-daemon': () => 'exposed',
  wedged: () => 'wedged',
});

export function derivePosture(input) {
  try {
    const { daemon, agent, probe, probeProvenUnderPid } = input ?? {};
    if (!agent || typeof agent !== 'object') return 'unknown';
    if (agent.kind === 'none') return 'unmonitored';
    // A daemon cannot protect an agent that has no Arbiter plugin to call it, so the daemon
    // state does not apply here.
    if (agent.kind === 'unsupported') return 'unsupported';
    if (agent.kind !== 'supported') return 'unknown';
    if (!daemon || typeof daemon !== 'object') return 'unknown';

    // Proof belongs to the daemon process that answered it. A restart voids it.
    const proofValid =
      probe === 'proven' &&
      daemon.kind === 'healthy' &&
      typeof daemon.pid === 'number' &&
      typeof probeProvenUnderPid === 'number' &&
      daemon.pid === probeProvenUnderPid;

    if (typeof daemon.kind !== 'string') return 'unknown';
    if (!Object.hasOwn(DAEMON_RESOLVERS, daemon.kind)) return 'unknown';
    return DAEMON_RESOLVERS[daemon.kind](daemon, proofValid);
  } catch {
    return 'unknown';
  }
}
