#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR || process.cwd();
const lockPath = join(stateDir, 'sentinel.lock');
const sentinelPath = join(dirname(fileURLToPath(import.meta.url)), 'sentinel.mjs');

function sentinelPid() {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    return typeof parsed?.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (!alive(sentinelPid())) {
  const child = spawn(process.execPath, [sentinelPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

process.exit(0);
