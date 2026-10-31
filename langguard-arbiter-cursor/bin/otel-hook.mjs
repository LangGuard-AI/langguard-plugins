#!/usr/bin/env node
// otel-hook.mjs — advisory Cursor hook that exports the event as one OTLP/HTTP JSON span.
//
// Declared by hooks/hooks.json as `node "${PLUGIN_ROOT}/bin/otel-hook.mjs"` on every
// Cursor hook event. Policy stays in hook.mjs; this file only ships activity.
//
// Fail-OPEN always: empty stdout, exit 0. A missing host/key, a timeout, or a 4xx
// must never block a tool call. Cursor runs hooks fail-open at the harness too.
//
// Config (first match wins):
//   OTEL_EXPORTER_OTLP_ENDPOINT + OTEL_EXPORTER_OTLP_HEADERS
//   LANGGUARD_HOST + LANGGUARD_API_KEY
//   ~/.config/arbiter/config.yaml  host: / apiKey:
//   ~/.cursor/hooks/otel_config.json
//
// If CURSOR_OTEL_HOOK or ~/.cursor/hooks/otel_hook.sh is executable, stdin is
// handed to that script and this file does not POST. That keeps an existing
// cursor-otel-hook install as the richer exporter without a second hooks.json.
//
// PURE NODE — node: builtins only.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const POST_TIMEOUT_MS = 2000;
const SERVICE_NAME = 'cursor-agent';

function yamlScalar(text, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(text);
  if (!m) return undefined;
  let v = m[1].trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(1, end) || undefined : undefined;
  }
  if (v.startsWith('#')) return undefined;
  const hash = v.search(/[ \t]#/);
  if (hash >= 0) v = v.slice(0, hash).trim();
  return v || undefined;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readJson(path) {
  const raw = readText(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function nested(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function resolveLegacyHook() {
  const candidates = [
    process.env.CURSOR_OTEL_HOOK,
    join(homedir(), '.cursor', 'hooks', 'otel_hook.sh'),
    join(homedir(), '.cursor', 'hooks', 'otel_hook.ps1'),
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      accessSync(path, fsConstants.X_OK);
      if (existsSync(path)) return path;
    } catch {
      /* not executable / missing */
    }
  }
  return '';
}

function resolveExportTarget() {
  const envEndpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim();
  const envHeaders = (process.env.OTEL_EXPORTER_OTLP_HEADERS || '').trim();
  if (envEndpoint) {
    return { url: tracesUrl(envEndpoint), headers: parseHeaderBag(envHeaders) };
  }

  const configText = readText(
    process.env.ARBITER_GLOBAL_CONFIG ?? join(homedir(), '.config', 'arbiter', 'config.yaml'),
  );
  const host = firstString(process.env.LANGGUARD_HOST, yamlScalar(configText, 'host'));
  const apiKey = firstString(process.env.LANGGUARD_API_KEY, yamlScalar(configText, 'apiKey'));
  if (host && apiKey) {
    return { url: tracesUrl(host), headers: { Authorization: `Bearer ${apiKey}` } };
  }

  const otelCfg = readJson(join(homedir(), '.cursor', 'hooks', 'otel_config.json'));
  if (otelCfg && typeof otelCfg === 'object') {
    const endpoint = firstString(
      otelCfg.OTEL_EXPORTER_OTLP_ENDPOINT,
      otelCfg.OTEL_ENDPOINT,
    );
    if (endpoint) {
      const headers = otelCfg.OTEL_EXPORTER_OTLP_HEADERS;
      const bag =
        headers && typeof headers === 'object' && !Array.isArray(headers)
          ? Object.fromEntries(
              Object.entries(headers)
                .filter(([, v]) => typeof v === 'string' && v)
                .map(([k, v]) => [k, String(v)]),
            )
          : {};
      return { url: tracesUrl(endpoint), headers: bag };
    }
  }

  return null;
}

function tracesUrl(raw) {
  const trimmed = raw.replace(/\/+$/, '');
  if (/\/v1\/(traces|logs)$/.test(trimmed)) return trimmed.replace(/\/v1\/logs$/, '/v1/traces');
  return `${trimmed}/v1/traces`;
}

function parseHeaderBag(raw) {
  const headers = {};
  if (!raw) return headers;
  for (const part of raw.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key && value) headers[key] = value;
  }
  return headers;
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function randomHex(n) {
  const buf = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return hex(buf);
}

function attr(key, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}

function pickAttrs(body) {
  const cursor = body && typeof body.cursor === 'object' ? body.cursor : {};
  const user = body && typeof body.user === 'object' ? body.user : {};
  const pairs = [
    attr('cursor.hook.event', firstString(body.hook_event_name, body.event)),
    attr(
      'cursor.user.id',
      firstString(
        body['cursor.user.id'],
        nested(body, ['cursor', 'user', 'id']),
        cursor.user_id,
        user.id,
        body.user_id,
        body.userId,
      ),
    ),
    attr(
      'cursor.user.account_id',
      firstString(
        body['cursor.user.account_id'],
        nested(body, ['cursor', 'user', 'account_id']),
        cursor.account_id,
        body.account_id,
      ),
    ),
    attr('user.email', firstString(body.user_email, body['user.email'], user.email)),
    attr('session.id', firstString(body.conversation_id, body.session_id, body.generation_id)),
    attr('gen_ai.request.model', firstString(body.model, body.model_name)),
    attr('gen_ai.agent.name', firstString(body.agent, body.agent_name)),
    attr('cursor.tool.name', firstString(body.tool_name, body.tool, nested(body, ['tool', 'name']))),
    attr('cursor.command', firstString(body.command)),
    attr('cursor.mcp.server', firstString(body.url, body.server, body.mcp_server)),
  ];
  return pairs.filter(Boolean);
}

function buildPayload(body) {
  const nowNs = String(BigInt(Date.now()) * 1000000n);
  const name = firstString(body.hook_event_name, body.event, 'cursor.hook');
  const resourceAttrs = [
    attr('service.name', SERVICE_NAME),
    attr(
      'cursor.user.id',
      firstString(
        body['cursor.user.id'],
        nested(body, ['cursor', 'user', 'id']),
        body.user_id,
        body.userId,
      ),
    ),
    attr(
      'cursor.user.account_id',
      firstString(body['cursor.user.account_id'], nested(body, ['cursor', 'user', 'account_id'])),
    ),
  ].filter(Boolean);

  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttrs },
        scopeSpans: [
          {
            scope: { name: 'langguard.cursor.hooks' },
            spans: [
              {
                traceId: randomHex(16),
                spanId: randomHex(8),
                name,
                kind: 1,
                startTimeUnixNano: nowNs,
                endTimeUnixNano: nowNs,
                attributes: pickAttrs(body),
              },
            ],
          },
        ],
      },
    ],
  };
}

function postJson(urlString, headers, payload) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      resolve();
      return;
    }
    const lib = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = lib(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...headers,
        },
        timeout: POST_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', resolve);
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(JSON.stringify(payload));
  });
}

function delegate(script, stdin) {
  return new Promise((resolve) => {
    const child = spawn(script, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, POST_TIMEOUT_MS + 1000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve();
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.end(stdin);
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  const legacy = resolveLegacyHook();
  if (legacy) {
    await delegate(legacy, raw);
    return;
  }

  const target = resolveExportTarget();
  if (!target) return;

  let body = {};
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    body = { hook_event_name: 'unparseable' };
  }
  if (typeof body !== 'object' || body === null) body = {};

  await postJson(target.url, target.headers, buildPayload(body));
}

main()
  .catch(() => {})
  .finally(() => {
    process.stdout.write('');
    process.exit(0);
  });
