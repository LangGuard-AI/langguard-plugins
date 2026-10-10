#!/usr/bin/env node
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultDataDir,
  defaultPort,
  probeHealth,
  probeSession,
  readBearer,
  readDaemonState,
} from '../lib/arbiter-client.mjs';
import { coverageFor } from '../lib/coverage.mjs';
import { classifyDaemon } from '../lib/grace.mjs';
import { connect, subscribe } from '../lib/herdr-client.mjs';
import { POSTURE_TOKEN, derivePosture } from '../lib/posture.mjs';

const SOURCE = 'langguard-arbiter';
const TICK_MS = 2500;
const BADGE_TTL_MS = 7500;
const BADGE_MIN_INTERVAL_MS = 5000;
const NOTIFY_INTERVAL_MS = 600_000;
const HEALTH_TIMEOUT_MS = 800;
const PROBE_TIMEOUT_MS = 1500;
const PROBE_BACKOFF_START_MS = 5000;
const PROBE_BACKOFF_MAX_MS = 60_000;
const UNPROVEN_REPROBE_MS = 15_000;
const ALERT_POSTURES = new Set(['exposed', 'wedged', 'unsupported']);
// `pane.agent_status_changed` is absent on purpose. As a manifest event it is global, but as a
// subscription it is a per-pane filter and herdr rejects it without a `pane_id`, which would
// force a subscribe and unsubscribe for every pane that opens or closes. The tick already reads
// agent.list, which carries the current status, so dropping it costs one tick of latency.
const EVENT_TYPES = [
  'pane.agent_detected',
  'pane.created',
  'pane.closed',
  'pane.exited',
];

const dataDir = defaultDataDir();
const port = defaultPort();
const socketPath = process.env.HERDR_SOCKET_PATH;
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const lockPath = join(stateDir, 'sentinel.lock');

const panes = new Map();
const notifiedAt = new Map();
const firstContactAt = Date.now();

let daemonSignature = '';
let ticking = false;
let immediateRequested = false;
let tickTimer = null;
let client = null;
let stream = null;
let stopping = false;

function warn(error) {
  process.stderr.write(`sentinel: ${String(error?.message ?? error)}\n`);
}

function pidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid() {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    return typeof parsed?.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

function acquireLock() {
  const owner = readLockPid();
  if (owner !== null && owner !== process.pid && pidAlive(owner)) return false;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    // A state directory we cannot write must not stop the watch. The guard is best effort.
    warn(error);
  }
  return true;
}

function releaseLock() {
  if (readLockPid() !== process.pid) return;
  try {
    unlinkSync(lockPath);
  } catch (error) {
    warn(error);
  }
}

function recordFor(paneId) {
  let record = panes.get(paneId);
  if (record) return record;
  record = {
    paneId,
    workspaceId: null,
    agentLabel: null,
    agentStatus: 'unknown',
    posture: 'unknown',
    probe: null,
    probeProvenUnderPid: null,
    backoffUntil: 0,
    backoffMs: 0,
    lastProbeAt: 0,
    lastToken: null,
    lastWriteAt: 0,
  };
  panes.set(paneId, record);
  return record;
}

function agentInputFor(label) {
  if (typeof label !== 'string' || label.length === 0) return { kind: 'none' };
  return coverageFor(label).supported
    ? { kind: 'supported', label }
    : { kind: 'unsupported', label };
}

function sessionIdOf(entry) {
  const session = entry?.agent_session;
  if (!session || session.kind !== 'id') return null;
  return typeof session.value === 'string' && session.value.length > 0 ? session.value : null;
}

function applyBackoff(record) {
  record.probe = 'unreachable';
  record.backoffMs =
    record.backoffMs > 0
      ? Math.min(record.backoffMs * 2, PROBE_BACKOFF_MAX_MS)
      : PROBE_BACKOFF_START_MS;
  record.backoffUntil = Date.now() + record.backoffMs;
}

async function runProbe(record, sessionId, daemonPid) {
  const bearer = readBearer(dataDir);
  if (bearer === null) {
    applyBackoff(record);
    return;
  }
  const result = await probeSession(port, bearer, sessionId, PROBE_TIMEOUT_MS);
  if (result === 'unreachable') {
    applyBackoff(record);
    return;
  }
  record.backoffMs = 0;
  record.backoffUntil = 0;
  record.probe = result;
  record.probeProvenUnderPid =
    result === 'proven' && typeof daemonPid === 'number' ? daemonPid : null;
}

async function writeBadge(record, now) {
  const token = POSTURE_TOKEN[record.posture] ?? null;
  if (token === null) return;
  if (token === record.lastToken && now - record.lastWriteAt < BADGE_MIN_INTERVAL_MS) return;
  await client.call('pane.report_metadata', {
    pane_id: record.paneId,
    source: SOURCE,
    tokens: { arbiter: token },
    ttl_ms: BADGE_TTL_MS,
    seq: now,
  });
  record.lastToken = token;
  record.lastWriteAt = now;
}

async function notifyGaps(now) {
  const counts = new Map();
  for (const record of panes.values()) {
    if (!ALERT_POSTURES.has(record.posture)) continue;
    const key = record.workspaceId ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [workspaceId, count] of counts) {
    if (now - (notifiedAt.get(workspaceId) ?? 0) < NOTIFY_INTERVAL_MS) continue;
    notifiedAt.set(workspaceId, now);
    const subject = count === 1 ? 'pane has' : 'panes have';
    await client.call('notification.show', {
      title: 'Arbiter coverage gap',
      body: `${count} ${subject} no policy control in workspace ${workspaceId}. Open the Arbiter coverage report for the details.`,
    });
  }
}

async function tick() {
  const now = Date.now();
  const state = readDaemonState(dataDir);
  const reachable = await probeHealth(port, HEALTH_TIMEOUT_MS);
  const daemon = classifyDaemon(state, now, reachable);
  daemon.firstContactAgeMs = now - firstContactAt;

  const signature = `${daemon.kind}:${daemon.pid ?? ''}`;
  const daemonChanged = signature !== daemonSignature;
  daemonSignature = signature;

  const listed = await client.call('agent.list', {});
  const entries = Array.isArray(listed?.agents) ? listed.agents : [];
  const seen = new Set();

  for (const entry of entries) {
    const paneId = entry?.pane_id;
    if (typeof paneId !== 'string') continue;
    seen.add(paneId);

    const record = recordFor(paneId);
    const previousPosture = record.posture;
    const previousStatus = record.agentStatus;

    record.workspaceId = typeof entry.workspace_id === 'string' ? entry.workspace_id : null;
    record.agentLabel = typeof entry.agent === 'string' ? entry.agent : null;
    record.agentStatus = typeof entry.agent_status === 'string' ? entry.agent_status : 'unknown';

    const agent = agentInputFor(record.agentLabel);
    record.posture = derivePosture({
      daemon,
      agent,
      probe: record.probe,
      probeProvenUnderPid: record.probeProvenUnderPid,
    });

    const sessionId = sessionIdOf(entry);
    const enteredUnproven = record.posture === 'unproven' && previousPosture !== 'unproven';
    const startedWorking = record.agentStatus === 'working' && previousStatus !== 'working';
    // An agent that becomes covered part way through a session raises none of the edge
    // triggers above, so without this a settled `unproven` pane could never reach `enforcing`.
    // Re-probing only that one posture keeps the cost to one loopback GET per pane per period.
    const unprovenDue =
      record.posture === 'unproven' && now - record.lastProbeAt >= UNPROVEN_REPROBE_MS;
    const wantsProbe =
      agent.kind === 'supported' &&
      sessionId !== null &&
      (enteredUnproven || startedWorking || daemonChanged || unprovenDue);
    if (wantsProbe && now >= record.backoffUntil) {
      record.lastProbeAt = now;
      runProbe(record, sessionId, daemon.pid).catch(warn);
    }

    try {
      await writeBadge(record, now);
    } catch (error) {
      warn(error);
    }
  }

  for (const paneId of panes.keys()) {
    if (!seen.has(paneId)) panes.delete(paneId);
  }

  await notifyGaps(now);
}

function scheduleTick(delayMs) {
  if (stopping) return;
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = setTimeout(runTick, delayMs);
}

function requestTick() {
  immediateRequested = true;
  if (!ticking) scheduleTick(0);
}

async function runTick() {
  if (ticking) return;
  ticking = true;
  immediateRequested = false;
  try {
    await tick();
  } catch (error) {
    warn(error);
  } finally {
    ticking = false;
    scheduleTick(immediateRequested ? 0 : TICK_MS);
  }
}

function onFrame(kind, data) {
  const paneId = typeof data?.pane_id === 'string' ? data.pane_id : null;
  if (kind === 'pane_closed' || kind === 'pane_exited') {
    if (paneId !== null) panes.delete(paneId);
    return;
  }
  if (kind === 'pane_agent_detected' || kind === 'pane_created') requestTick();
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  if (tickTimer) clearTimeout(tickTimer);
  stream?.close();
  client?.close();
  releaseLock();
  process.exit(code);
}

if (typeof socketPath !== 'string' || socketPath.length === 0) {
  process.exit(0);
}

if (!acquireLock()) {
  process.exit(0);
}

client = connect(socketPath);
stream = subscribe(socketPath, EVENT_TYPES, onFrame);
stream.onError(warn);
stream.onClose(() => shutdown(0));

process.on('SIGHUP', requestTick);
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

runTick();
