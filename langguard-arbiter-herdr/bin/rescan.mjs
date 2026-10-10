#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../lib/herdr-client.mjs';

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const lockPath = join(stateDir, 'sentinel.lock');
const sentinelPath = join(dirname(fileURLToPath(import.meta.url)), 'sentinel.mjs');
const socketPath = process.env.HERDR_SOCKET_PATH;

function sentinelPid() {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    return typeof parsed?.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

function wake(pid) {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 'SIGHUP');
    return true;
  } catch {
    return false;
  }
}

function start() {
  const child = spawn(process.execPath, [sentinelPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

const woken = wake(sentinelPid());
if (!woken) start();

// Action output never reaches the user, so the only confirmation is a notification.
if (typeof socketPath === 'string' && socketPath.length > 0) {
  const client = connect(socketPath);
  const body = woken
    ? 'The Arbiter coverage watch reads the current state now.'
    : 'The Arbiter coverage watch is starting.';
  try {
    await client.call('notification.show', { title: 'Arbiter rescan', body }, 2000);
  } catch (error) {
    process.stderr.write(`rescan: ${String(error?.message ?? error)}\n`);
  }
  client.close();
}

process.exit(0);
