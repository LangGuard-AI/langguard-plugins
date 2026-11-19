import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEARTBEAT_STALE_MS,
  STARTUP_GRACE_MS,
  classifyDaemon,
  classifyGrace,
  ownerAlive,
} from '../lib/grace.mjs';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const LIVE_PID = process.pid;

function findDeadPid() {
  for (let candidate = 4_194_303; candidate > 4_194_000; candidate -= 1) {
    try {
      process.kill(candidate, 0);
    } catch {
      return candidate;
    }
  }
  return null;
}

const DEAD_PID = findDeadPid();

function iso(offsetMs) {
  return new Date(NOW - offsetMs).toISOString();
}

test('the grace windows hold their documented values', () => {
  assert.equal(STARTUP_GRACE_MS, 20000);
  assert.equal(HEARTBEAT_STALE_MS, 15000);
});

test('ownerAlive accepts a live pid and rejects everything else', () => {
  assert.equal(ownerAlive({ pid: LIVE_PID }), true);
  assert.equal(ownerAlive({ pid: DEAD_PID }), false);
  assert.equal(ownerAlive({ pid: 0 }), false);
  assert.equal(ownerAlive({ pid: -1 }), false);
  assert.equal(ownerAlive({ pid: 1.5 }), false);
  assert.equal(ownerAlive({ pid: '123' }), false);
  assert.equal(ownerAlive({}), false);
  assert.equal(ownerAlive(null), false);
});

test('an absent state file is absent, not a failure', () => {
  const result = classifyGrace(null, NOW);
  assert.equal(result.category, 'absent');
  assert.equal(result.verdict, 'warming');
  assert.equal(typeof result.reason, 'string');
});

test('provisioning with a live owner is a bounded transient', () => {
  const result = classifyGrace(
    { pid: LIVE_PID, startedAt: iso(60_000), opaProvisioning: true, ready: false },
    NOW,
  );
  assert.equal(result.category, 'transient');
  assert.equal(result.verdict, 'warming');
});

test('provisioning with a dead owner is no-daemon and never transient', () => {
  const result = classifyGrace(
    { pid: DEAD_PID, startedAt: iso(60_000), opaProvisioning: true, ready: false },
    NOW,
  );
  assert.equal(result.category, 'no-daemon');
  assert.notEqual(result.category, 'transient');
  assert.equal(result.verdict, 'warming');
});

test('a ready daemon with a live owner past the grace window is wedged', () => {
  const result = classifyGrace(
    {
      pid: LIVE_PID,
      startedAt: iso(STARTUP_GRACE_MS + 1000),
      ready: true,
      lastHeartbeat: iso(1000),
    },
    NOW,
  );
  assert.equal(result.category, 'wedged');
  assert.equal(result.verdict, 'dead');
});

test('a ready daemon with a dead owner past the grace window is no-daemon', () => {
  const result = classifyGrace(
    {
      pid: DEAD_PID,
      startedAt: iso(STARTUP_GRACE_MS + 1000),
      ready: true,
      lastHeartbeat: iso(1000),
    },
    NOW,
  );
  assert.equal(result.category, 'no-daemon');
  assert.equal(result.verdict, 'warming');
});

test('a not ready daemon inside the grace window is transient', () => {
  const result = classifyGrace({ pid: LIVE_PID, startedAt: iso(1000), ready: false }, NOW);
  assert.equal(result.category, 'transient');
});

test('a not ready daemon past the grace window is no-daemon', () => {
  const result = classifyGrace(
    { pid: LIVE_PID, startedAt: iso(STARTUP_GRACE_MS + 1000), ready: false },
    NOW,
  );
  assert.equal(result.category, 'no-daemon');
});

test('a ready daemon inside the grace window is transient', () => {
  const result = classifyGrace(
    { pid: LIVE_PID, startedAt: iso(1000), ready: true, lastHeartbeat: iso(0) },
    NOW,
  );
  assert.equal(result.category, 'transient');
});

test('a stale heartbeat on a live owner is wedged', () => {
  const result = classifyGrace(
    {
      pid: LIVE_PID,
      startedAt: iso(STARTUP_GRACE_MS + 1000),
      ready: true,
      lastHeartbeat: iso(HEARTBEAT_STALE_MS + 1000),
    },
    NOW,
  );
  assert.equal(result.category, 'wedged');
  assert.equal(result.verdict, 'dead');
});

test('a missing heartbeat on a live ready owner is wedged', () => {
  const result = classifyGrace(
    { pid: LIVE_PID, startedAt: iso(STARTUP_GRACE_MS + 1000), ready: true },
    NOW,
  );
  assert.equal(result.category, 'wedged');
  assert.equal(result.verdict, 'dead');
});

test('classifyDaemon reports absent when there is no state', () => {
  assert.deepEqual(classifyDaemon(null, NOW, true), { kind: 'absent' });
  assert.deepEqual(classifyDaemon(undefined, NOW, false), { kind: 'absent' });
});

test('classifyDaemon reports healthy only when the port answers', () => {
  const state = {
    pid: LIVE_PID,
    ready: true,
    bundle_revision: 12,
    startedAt: iso(STARTUP_GRACE_MS + 1000),
    lastHeartbeat: iso(500),
  };
  assert.deepEqual(classifyDaemon(state, NOW, true), {
    kind: 'healthy',
    pid: LIVE_PID,
    bundleRevision: 12,
  });
  const unreachable = classifyDaemon(state, NOW, false);
  assert.equal(unreachable.kind, 'wedged');
  assert.equal(typeof unreachable.reason, 'string');
});

test('classifyDaemon reports a null bundle revision when the state has none', () => {
  const state = {
    pid: LIVE_PID,
    ready: true,
    startedAt: iso(STARTUP_GRACE_MS + 1000),
    lastHeartbeat: iso(500),
  };
  assert.deepEqual(classifyDaemon(state, NOW, true), {
    kind: 'healthy',
    pid: LIVE_PID,
    bundleRevision: null,
  });
});
