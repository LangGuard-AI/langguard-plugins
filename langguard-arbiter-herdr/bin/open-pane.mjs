#!/usr/bin/env node
// Opens one of this plugin's panes. Actions need this indirection because manifest commands
// are argv arrays with no shell, so they cannot expand HERDR_BIN_PATH themselves.

import { spawn } from 'node:child_process';

const ENTRYPOINTS = new Set(['report', 'remediate']);

const entrypoint = process.argv[2];
if (!ENTRYPOINTS.has(entrypoint)) {
  process.stderr.write(`open-pane: unknown entrypoint ${JSON.stringify(entrypoint)}\n`);
  process.exit(0);
}

const herdr = process.env.HERDR_BIN_PATH ?? 'herdr';
const pluginId = process.env.HERDR_PLUGIN_ID ?? 'langguard-arbiter-herdr';

const args = [
  'plugin', 'pane', 'open',
  '--plugin', pluginId,
  '--entrypoint', entrypoint,
  '--placement', 'popup',
];

// The pane resolves its own target from HERDR_PANE_ID, which herdr injects into the pane
// process only when the action carried a pane context. Forward it explicitly so remediate
// still knows which agent the user meant.
const env = { ...process.env };
if (process.env.HERDR_PANE_ID) {
  args.push('--env', `ARBITER_TARGET_PANE=${process.env.HERDR_PANE_ID}`);
}

const child = spawn(herdr, args, { env, stdio: 'ignore', detached: false });
child.on('error', (err) => {
  process.stderr.write(`open-pane: failed to run ${herdr}: ${String(err)}\n`);
  process.exit(0);
});
child.on('close', () => process.exit(0));
