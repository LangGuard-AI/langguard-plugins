#!/usr/bin/env node
import { readFileSync } from 'node:fs';
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
import { connect } from '../lib/herdr-client.mjs';
import { POSTURE_SUMMARY, POSTURE_TOKEN, derivePosture } from '../lib/posture.mjs';

const LEGEND =
  'Legend: ENFORCING proven, UNPROVEN no proof yet, WARMING starting, EXPOSED no daemon, WEDGED unreachable, UNCOVERED no plugin.';

const dataDir = defaultDataDir();
const port = defaultPort();
const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const out = (line) => process.stdout.write(`${line}\n`);

function firstContactAt() {
  // The watch process stamps its own start time. It is a truer first-contact mark than the
  // start of this short-lived report.
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, 'sentinel.lock'), 'utf8'));
    const started = Date.parse(parsed?.startedAt);
    return Number.isFinite(started) ? started : Date.now();
  } catch {
    return Date.now();
  }
}

function agentInputFor(label) {
  if (typeof label !== 'string' || label.length === 0) return { kind: 'none' };
  return coverageFor(label).supported
    ? { kind: 'supported', label }
    : { kind: 'unsupported', label };
}

function sessionIdOf(pane) {
  const session = pane?.agent_session;
  if (!session || session.kind !== 'id') return null;
  return typeof session.value === 'string' && session.value.length > 0 ? session.value : null;
}

function label(posture) {
  return POSTURE_TOKEN[posture] ?? posture.toUpperCase();
}

function daemonDetail(daemon) {
  if (typeof daemon.reason === 'string') return daemon.reason;
  if (daemon.kind === 'healthy') return 'The daemon answers on the local port.';
  return 'The daemon state file is absent. The daemon never started.';
}

function holdOpen() {
  out('');
  out('Press any key to close.');
  return new Promise((resolve) => {
    const input = process.stdin;
    if (!input.isTTY) {
      resolve();
      return;
    }
    input.setRawMode?.(true);
    input.resume();
    input.once('data', () => {
      input.setRawMode?.(false);
      input.pause();
      resolve();
    });
  });
}

async function main() {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    out('This report needs a herdr session. No herdr socket is available.');
    return;
  }

  const client = connect(socketPath);
  let panes = [];
  try {
    const listed = await client.call('pane.list', {});
    panes = Array.isArray(listed?.panes) ? listed.panes : [];
  } catch (error) {
    out(`The pane list is not available. ${String(error?.message ?? error)}`);
  }

  const now = Date.now();
  const state = readDaemonState(dataDir);
  const reachable = await probeHealth(port, 1000);
  const daemon = classifyDaemon(state, now, reachable);
  daemon.firstContactAgeMs = now - firstContactAt();
  const bearer = readBearer(dataDir);

  out('Arbiter coverage report');
  out('');
  out('Daemon');
  out(`  state           ${daemon.kind}`);
  out(`  detail          ${daemonDetail(daemon)}`);
  out(`  port            ${port}`);
  if (daemon.bundleRevision != null) out(`  policy bundle   ${daemon.bundleRevision}`);
  out('');

  const agentPanes = panes.filter((pane) => typeof pane?.agent === 'string' && pane.agent.length > 0);
  if (agentPanes.length === 0) {
    out('No pane runs an agent.');
    out('');
    out(LEGEND);
    client.close();
    return;
  }

  out('Panes');
  for (const pane of agentPanes) {
    const agent = agentInputFor(pane.agent);
    const coverage = coverageFor(pane.agent);
    const sessionId = sessionIdOf(pane);
    let probe = null;
    if (agent.kind === 'supported' && bearer !== null && sessionId !== null) {
      probe = await probeSession(port, bearer, sessionId, 1500);
    }
    const posture = derivePosture({
      daemon,
      agent,
      probe,
      probeProvenUnderPid: probe === 'proven' ? (daemon.pid ?? null) : null,
    });

    out('');
    out(`  ${pane.pane_id}`);
    out(`    workspace     ${pane.workspace_id ?? 'unknown'}`);
    out(`    agent         ${pane.agent}`);
    out(`    status        ${pane.agent_status ?? 'unknown'}`);
    out(`    coverage      ${label(posture)}`);
    out(`    detail        ${POSTURE_SUMMARY[posture]}`);
    if (agent.kind === 'unsupported') {
      out('    to fix        Arbiter has no plugin for this agent today.');
      continue;
    }
    if (posture !== 'enforcing') {
      out('    to fix        Make sure the Arbiter plugin is installed for this agent:');
      for (const line of coverage.install) out(`                  ${line}`);
    }
  }

  out('');
  out(LEGEND);
  client.close();
}

await main();
await holdOpen();
process.exit(0);
