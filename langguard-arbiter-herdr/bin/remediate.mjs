#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { coverageFor } from '../lib/coverage.mjs';
import { connect } from '../lib/herdr-client.mjs';

const SUPPORTED_HARNESSES = 'claude, codex, cursor, antigravity';
const SHELL_CHARS = /[|&;<>$`()'"\\\n]/;
const COMMAND_HEAD = /^[a-z][a-z0-9._-]*$/;

const out = (line) => process.stdout.write(`${line}\n`);

function targetPaneId() {
  // Inside a popup, HERDR_PANE_ID is the popup's own pane, which runs no agent. The launcher
  // forwards the pane the user acted on, so that one wins when it is set.
  const forwarded = process.env.ARBITER_TARGET_PANE;
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded;
  const direct = process.env.HERDR_PANE_ID;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  try {
    const context = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON ?? '{}');
    const focused = context?.focused_pane_id;
    return typeof focused === 'string' && focused.length > 0 ? focused : null;
  } catch {
    return null;
  }
}

// A coverage entry may carry a written instruction instead of a command. Only a line that
// parses into a bare argument list is ever offered to run.
function parseCommand(line) {
  if (SHELL_CHARS.test(line)) return null;
  const argv = line.trim().split(/\s+/);
  if (argv.length < 2) return null;
  if (!COMMAND_HEAD.test(argv[0])) return null;
  return argv;
}

function ask(question) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    reader.once('line', (line) => {
      reader.close();
      resolve(line);
    });
    reader.once('close', () => resolve(''));
  });
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

function run(argv) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(typeof code === 'number' ? code : 1));
  });
}

async function readAgentLabel(paneId) {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (typeof socketPath !== 'string' || socketPath.length === 0) return null;
  const client = connect(socketPath);
  try {
    const result = await client.call('pane.get', { pane_id: paneId });
    const agent = result?.pane?.agent;
    return typeof agent === 'string' && agent.length > 0 ? agent : null;
  } catch {
    return null;
  } finally {
    client.close();
  }
}

async function main() {
  out('Arbiter coverage fix');
  out('');

  const paneId = targetPaneId();
  if (paneId === null) {
    out('No pane is selected. Open this command from the pane you want to check.');
    return;
  }

  const agentLabel = await readAgentLabel(paneId);
  if (agentLabel === null) {
    out(`Pane ${paneId} runs no agent, or herdr does not answer.`);
    return;
  }

  const coverage = coverageFor(agentLabel);
  out(`Pane    ${paneId}`);
  out(`Agent   ${agentLabel}`);
  out('');

  if (!coverage.supported) {
    out(`Arbiter has no plugin for ${agentLabel}. This pane has no policy control.`);
    out(`Arbiter supports these harnesses today: ${SUPPORTED_HARNESSES}.`);
    out('There is nothing to install for this agent.');
    return;
  }

  out(`Arbiter supports ${agentLabel} through the ${coverage.harness} harness.`);
  out('These are the install steps:');
  for (const line of coverage.install) out(`  ${line}`);
  out('');

  const commands = coverage.install.map(parseCommand);
  if (commands.some((argv) => argv === null)) {
    out('These steps are manual. Do them yourself in the order above.');
    return;
  }

  const answer = (await ask('Run these now? [y/N] ')).trim();
  if (answer !== 'y' && answer !== 'Y') {
    out('Nothing ran.');
    return;
  }

  for (const argv of commands) {
    out('');
    out(`Running: ${argv.join(' ')}`);
    const code = await run(argv);
    if (code !== 0) {
      out(`The command stopped with exit code ${code}. The remaining steps did not run.`);
      return;
    }
  }
  out('');
  out('All steps completed. Run the rescan action to refresh the coverage badge.');
}

await main();
await holdOpen();
process.exit(0);
