import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOST = '127.0.0.1';
const BEARER_PATTERN = /^arbd_[0-9a-f]{64}$/;

export function defaultDataDir() {
  return process.env.ARBITER_DATA_DIR || join(homedir(), '.config', 'arbiter');
}

export function defaultPort() {
  return Number(process.env.ARBITER_HOOK_DAEMON_PORT) || 52746;
}

export function readBearer(dataDir = defaultDataDir()) {
  let token;
  try {
    token = readFileSync(join(dataDir, 'bearer'), 'utf8').trim();
  } catch {
    return null;
  }
  // Only a daemon token may cross loopback. Any other credential in this file is discarded.
  return BEARER_PATTERN.test(token) ? token : null;
}

export function readDaemonState(dataDir = defaultDataDir()) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, 'daemon-state.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function get(port, path, headers, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // The daemon rejects any request that carries an Origin header, and Node sets a correct
    // Host on its own.
    const call = request({ host: HOST, port, path, method: 'GET', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => settle({ status: response.statusCode ?? 0, body }));
      response.on('error', () => settle(null));
    });
    call.setTimeout(timeoutMs, () => {
      call.destroy();
      settle(null);
    });
    call.on('error', () => settle(null));
    call.end();
  });
}

function parseBody(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export async function probeHealth(port = defaultPort(), timeoutMs = 800) {
  const response = await get(port, '/health', {}, timeoutMs);
  if (!response || response.status < 200 || response.status >= 300) return false;
  const parsed = parseBody(response.body);
  if (parsed && typeof parsed.status === 'string') return parsed.status === 'ok';
  return true;
}

export async function probeSession(port, bearer, sessionId, timeoutMs = 1500) {
  if (typeof bearer !== 'string' || !BEARER_PATTERN.test(bearer)) return 'unreachable';
  if (typeof sessionId !== 'string' || sessionId.length === 0) return 'unreachable';

  const path = `/decisions?session=${encodeURIComponent(sessionId)}&limit=1`;
  const response = await get(
    port,
    path,
    { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
    timeoutMs,
  );
  if (!response || response.status < 200 || response.status >= 300) return 'unreachable';

  const parsed = parseBody(response.body);
  if (!parsed) return 'unreachable';
  const actions = parsed.actions;
  if (Array.isArray(actions) && actions.length > 0) return 'proven';
  return 'silent';
}
