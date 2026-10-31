import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// arbiter-claude/plugin/bin/hook.mjs
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var HOST = "127.0.0.1";
var PORT = Number(process.env.ARBITER_HOOK_DAEMON_PORT) || 52746;
var STARTUP_GRACE_MS = 2e4;
var HEARTBEAT_STALE_MS = 15e3;
var ENFORCEMENT_MODE = process.env.CLAUDE_PLUGIN_OPTION_ENFORCEMENT_MODE === "strict" ? "strict" : "cooperative";
var ENFORCE_RETRY_BUDGET_MS = 2e3;
var ENFORCE_ATTEMPT_TIMEOUT_MS = 1200;
var ADVISORY_TIMEOUT_MS = 1500;
var PORT_PROBE_TIMEOUT_MS = 400;
var CONNECT_ERROR_CODES = /* @__PURE__ */ new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE"
]);
var phase = process.argv[2];
var dataDir = process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), ".config", "arbiter", "plugin-data");
var CANONICAL_BEARER_FILE = process.env.ARBITER_BEARER_FILE ?? join(homedir(), ".config", "arbiter", "bearer");
var LOOPBACK_BEARER_RE = /^arbd_[0-9a-f]{64}$/;
function readCanonicalBearer() {
  try {
    const raw = readFileSync(CANONICAL_BEARER_FILE, "utf8").trim();
    if (LOOPBACK_BEARER_RE.test(raw)) return raw;
  } catch {
  }
  return "";
}
function readLockfileBearer() {
  const path = process.env.ARBITER_LOCKFILE ?? join(homedir(), ".config", "arbiter", "daemon.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data.bearer !== "string" || !data.bearer) return "";
    if (typeof data.port !== "number" || data.port !== PORT) return "";
    const pid = data.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return "";
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e?.code !== "EPERM") return "";
    }
    return data.bearer;
  } catch {
  }
  return "";
}
function resolveLoopbackBearer() {
  return readCanonicalBearer() || readLockfileBearer();
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function warn(msg) {
  try {
    process.stderr.write(`[arbiter] ${msg}
`);
  } catch {
  }
}
function exitWith(code, stdoutText) {
  process.exitCode = code;
  if (stdoutText) {
    process.stdout.write(stdoutText, () => process.exit(code));
  } else {
    process.exit(code);
  }
}
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const guard = setTimeout(finish, 1e3);
    if (typeof guard.unref === "function") guard.unref();
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      clearTimeout(guard);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(guard);
      finish();
    });
  });
}
function stampHarness(bodyRaw) {
  try {
    const parsed = JSON.parse(bodyRaw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bodyRaw;
    parsed.arbiter_harness = "claude";
    return JSON.stringify(parsed);
  } catch {
    return bodyRaw;
  }
}
function postHook(hookPhase, bodyRaw, timeoutMs, bearer = resolveLoopbackBearer()) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(bodyRaw ?? "", "utf8");
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: `/hook/${hookPhase}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          ...bearer ? { Authorization: `Bearer ${bearer}` } : {}
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on(
          "end",
          () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") })
        );
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      const e = new Error(`enforce POST timed out after ${timeoutMs}ms`);
      e.code = "ETIMEDOUT";
      req.destroy(e);
    });
    req.end(payload);
  });
}
async function postHookWithRetry(hookPhase, bodyRaw, budgetMs, bearer) {
  const deadline = Date.now() + budgetMs;
  const backoffs = [0, 150, 300, 600];
  let lastErr;
  for (let i = 0; i < backoffs.length; i++) {
    if (backoffs[i] > 0) await sleep(backoffs[i]);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await postHook(hookPhase, bodyRaw, Math.min(ENFORCE_ATTEMPT_TIMEOUT_MS, remaining), bearer);
    } catch (err) {
      lastErr = err;
      if (!CONNECT_ERROR_CODES.has(err?.code)) throw err;
    }
  }
  throw lastErr ?? Object.assign(new Error("daemon unreachable"), { code: "ECONNREFUSED" });
}
function readDaemonState() {
  try {
    return JSON.parse(readFileSync(join(dataDir, "daemon-state.json"), "utf8"));
  } catch {
    return null;
  }
}
function ownerAlive(state) {
  const pid = state?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function classifyGrace(state, now) {
  if (!state) {
    return { verdict: "warming", category: "absent", reason: "daemon-state.json absent (never started)" };
  }
  const started = Date.parse(state.startedAt);
  const withinStartupGrace = Number.isFinite(started) && now - started < STARTUP_GRACE_MS;
  if (state.opaProvisioning === true) {
    if (ownerAlive(state)) {
      return { verdict: "warming", category: "transient", reason: "OPA binary still provisioning (first-run download)" };
    }
    return {
      verdict: "warming",
      category: "no-daemon",
      reason: `owner pid ${state.pid ?? "(none)"} died during OPA provisioning \u2192 stale warming state`
    };
  }
  if (state.ready !== true) {
    return {
      verdict: "warming",
      category: withinStartupGrace ? "transient" : "no-daemon",
      reason: `daemon not ready (ready=${String(state.ready)})`
    };
  }
  if (withinStartupGrace) {
    return { verdict: "warming", category: "transient", reason: `within startup grace (${now - started}ms < ${STARTUP_GRACE_MS}ms)` };
  }
  if (!ownerAlive(state)) {
    return {
      verdict: "warming",
      category: "no-daemon",
      reason: `owner pid ${state.pid ?? "(none)"} not alive \u2192 stale/never-up`
    };
  }
  const hb = Date.parse(state.lastHeartbeat);
  if (!Number.isFinite(hb)) {
    return { verdict: "dead", category: "wedged", reason: "ready daemon has no valid lastHeartbeat and is unreachable" };
  }
  const age = now - hb;
  if (age > HEARTBEAT_STALE_MS) {
    return { verdict: "dead", category: "wedged", reason: `heartbeat stale by ${age}ms and socket unreachable` };
  }
  return { verdict: "dead", category: "wedged", reason: "ready daemon unreachable despite a fresh heartbeat (wedged)" };
}
var strictMarkerPath = () => join(dataDir, ".arbiter-strict-firstcontact");
function strictAbsentGraceExpired(now) {
  try {
    const first = Number(readFileSync(strictMarkerPath(), "utf8").trim());
    if (Number.isFinite(first)) return now - first > STARTUP_GRACE_MS;
  } catch {
  }
  try {
    writeFileSync(strictMarkerPath(), String(now));
  } catch {
  }
  return false;
}
function clearStrictMarker() {
  try {
    rmSync(strictMarkerPath(), { force: true });
  } catch {
  }
}
function isPortBound(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: HOST, port });
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(PORT_PROBE_TIMEOUT_MS);
    sock.once("connect", () => settle(true));
    sock.once("timeout", () => settle(false));
    sock.once("error", () => settle(false));
  });
}
async function maybeSpawnDaemonFallback(bodyRaw) {
  let event;
  try {
    event = JSON.parse(bodyRaw)?.hook_event_name;
  } catch {
  }
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return;
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return;
  if (await isPortBound(PORT)) return;
  const launch = join(pluginRoot, "monitor", "launch.mjs");
  const host = process.env.CLAUDE_PLUGIN_OPTION_HOST ?? "https://app.langguard.ai";
  const opaPath = join(dataDir, "bin", process.platform === "win32" ? "opa.exe" : "opa");
  try {
    const child = spawn(
      process.execPath,
      [launch, "--host", host, "--opa-path", opaPath, "--data-dir", dataDir],
      { detached: true, stdio: "ignore", env: process.env }
    );
    child.unref();
  } catch {
  }
}
async function handleAdvisory(hookPhase, bodyRaw) {
  if (hookPhase === "screen") {
    try {
      await maybeSpawnDaemonFallback(bodyRaw);
    } catch {
    }
  }
  try {
    const res = await postHook(hookPhase, bodyRaw, ADVISORY_TIMEOUT_MS);
    if (res.status >= 200 && res.status < 300 && res.text) {
      exitWith(0, res.text);
      return;
    }
  } catch {
  }
  exitWith(0);
}
function finishByGrace(extraReason, denyEnvelope) {
  const now = Date.now();
  const state = readDaemonState();
  if (state) clearStrictMarker();
  const g = classifyGrace(state, now);
  const strict = ENFORCEMENT_MODE === "strict";
  const reason = extraReason ? `${extraReason}; ${g.reason}` : g.reason;
  const block = g.verdict === "dead" || strict && g.category === "no-daemon" || strict && g.category === "absent" && strictAbsentGraceExpired(now);
  if (block) {
    if (strict && denyEnvelope) {
      const detail = `LangGuard Arbiter: ${reason} \u2014 BLOCKING (strict mode, fail-CLOSED).`;
      const envelope = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: detail
        }
      };
      warn(detail);
      exitWith(2, JSON.stringify(envelope));
    } else {
      warn(`enforce: ${strict ? "strict \u2014 " : ""}daemon unavailable (${reason}) \u2014 BLOCKING (fail-CLOSED, exit 2).`);
      exitWith(2);
    }
  } else {
    warn(`enforce: daemon warming/unavailable (${reason})${strict ? " [within cold-start grace]" : ""} \u2014 failing OPEN.`);
    exitWith(0);
  }
}
async function handleEnforce(bodyRaw) {
  const deadline = Date.now() + ENFORCE_RETRY_BUDGET_MS;
  let loopbackBearer = readCanonicalBearer();
  while (!loopbackBearer && Date.now() < deadline) {
    await sleep(100);
    loopbackBearer = readCanonicalBearer();
  }
  if (!loopbackBearer) {
    warn(
      `enforce: no arbd_ loopback bearer at ${CANONICAL_BEARER_FILE} after the cold-start poll \u2014 the daemon has not published one yet.`
    );
    finishByGrace("no arbd_ loopback bearer (~/.config/arbiter/bearer absent)", true);
    return;
  }
  let res;
  try {
    res = await postHookWithRetry("enforce", bodyRaw, Math.max(0, deadline - Date.now()), loopbackBearer);
  } catch {
    finishByGrace(null, false);
    return;
  }
  if (res.status >= 200 && res.status < 300) {
    clearStrictMarker();
    exitWith(0, res.text);
    return;
  }
  if (res.status === 401) {
    const lockBearer = readLockfileBearer();
    if (lockBearer && lockBearer !== loopbackBearer) {
      warn(
        "enforce: daemon returned 401 for the arbd_ loopback bearer \u2014 it differs from the daemon owner's published lockfile bearer (interim old-daemon compat). Retrying once with the owner's published lockfile bearer (~/.config/arbiter/daemon.json)."
      );
      try {
        const retry = await postHook("enforce", bodyRaw, ENFORCE_ATTEMPT_TIMEOUT_MS, lockBearer);
        if (retry.status >= 200 && retry.status < 300) {
          clearStrictMarker();
          exitWith(0, retry.text);
          return;
        }
      } catch {
      }
    }
    const reason = `LangGuard Arbiter: loopback bearer mismatch with the daemon owning port ${PORT} \u2014 the daemon expects its arbd_ loopback bearer (~/.config/arbiter/bearer). Restart the Arbiter daemon or re-run setup from the Arbiter Hooks settings page to realign.`;
    if (ENFORCEMENT_MODE === "strict") {
      const detail = `${reason} BLOCKING (strict mode, fail-CLOSED).`;
      const envelope = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: detail
        }
      };
      warn(detail);
      exitWith(2, JSON.stringify(envelope));
    } else {
      warn(`enforce: ${reason} Failing OPEN (cooperative).`);
      exitWith(0);
    }
    return;
  }
  warn(`enforce: daemon reachable but returned HTTP ${res.status} \u2014 failing OPEN.`);
  exitWith(0);
}
function yamlScalar(text, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(text);
  if (!m) return void 0;
  let v = m[1].trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(1, end) || void 0 : void 0;
  }
  if (v.startsWith("#")) return void 0;
  const hash = v.search(/[ \t]#/);
  if (hash >= 0) v = v.slice(0, hash).trim();
  return v || void 0;
}
function readGlobalConfigText() {
  const path = process.env.ARBITER_GLOBAL_CONFIG ?? join(homedir(), ".config", "arbiter", "config.yaml");
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
var configText = readGlobalConfigText();
var REMOTE_SAAS_HOST = process.env.CLAUDE_PLUGIN_OPTION_HOST ?? "https://app.langguard.ai";
function portalBase() {
  try {
    return new URL(REMOTE_SAAS_HOST).origin;
  } catch {
    return "your LangGuard portal";
  }
}
var LGR_RE = /^lgr_/;
var REMOTE_LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);
var stripBrackets = (h) => h.replace(/^\[|\]$/g, "");
function resolveRemoteTarget() {
  const envUrl = (process.env.ARBITER_DAEMON_URL ?? "").trim();
  const raw = (envUrl || (yamlScalar(configText, "daemonUrl") ?? "")).trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { invalid: true, raw, reason: "unparseable daemonUrl" };
  }
  const isHttps = url.protocol === "https:";
  if (!isHttps) {
    if (url.protocol !== "http:") {
      return { invalid: true, raw, reason: `unsupported protocol "${url.protocol}"` };
    }
    if (!REMOTE_LOOPBACK_HOSTS.has(url.hostname)) {
      return { invalid: true, raw, reason: "plain-http is only allowed for loopback \u2014 use https://" };
    }
  }
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const pathBase = url.pathname.replace(/\/+$/, "");
  return { invalid: false, raw, host: url.hostname, port, isHttps, pathBase };
}
var REMOTE = resolveRemoteTarget();
function resolveRemoteCredential() {
  return (process.env.LANGGUARD_API_KEY ?? yamlScalar(configText, "apiKey") ?? process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN ?? "").trim();
}
var REMOTE_ENFORCE_ATTEMPT_TIMEOUT_MS = 2500;
var REMOTE_ENFORCE_BUDGET_MS = 5e3;
var REMOTE_ADVISORY_TIMEOUT_MS = 1500;
async function postHookRemote(hookPhase, bodyRaw, timeoutMs, bearer) {
  const transport = REMOTE.isHttps ? (await import("node:https")).default : http;
  const connectHost = stripBrackets(REMOTE.host);
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(bodyRaw ?? "", "utf8");
    const req = transport.request(
      {
        host: connectHost,
        port: REMOTE.port,
        path: `${REMOTE.pathBase}/hook/${hookPhase}`,
        method: "POST",
        ...REMOTE.isHttps ? { servername: connectHost } : {},
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Authorization: `Bearer ${bearer}`
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on(
          "end",
          () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") })
        );
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      const e = new Error(`remote POST timed out after ${timeoutMs}ms`);
      e.code = "ETIMEDOUT";
      req.destroy(e);
    });
    req.end(payload);
  });
}
async function postHookRemoteWithRetry(hookPhase, bodyRaw, budgetMs, bearer) {
  const deadline = Date.now() + budgetMs;
  const backoffs = [0, 200, 500, 1e3];
  let lastErr;
  for (let i = 0; i < backoffs.length; i++) {
    if (backoffs[i] > 0) await sleep(backoffs[i]);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await postHookRemote(
        hookPhase,
        bodyRaw,
        Math.min(REMOTE_ENFORCE_ATTEMPT_TIMEOUT_MS, remaining),
        bearer
      );
    } catch (err) {
      lastErr = err;
      if (!CONNECT_ERROR_CODES.has(err?.code)) throw err;
    }
  }
  throw lastErr ?? Object.assign(new Error("cloud daemon unreachable"), { code: "ECONNREFUSED" });
}
function remoteEnforceFail(reason) {
  if (ENFORCEMENT_MODE === "strict") {
    const detail = `LangGuard Arbiter: ${reason} \u2014 BLOCKING (strict mode, fail-CLOSED).`;
    const envelope = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: detail
      }
    };
    warn(detail);
    exitWith(2, JSON.stringify(envelope));
  } else {
    warn(`enforce (remote): ${reason} \u2014 failing OPEN (cooperative).`);
    exitWith(0);
  }
}
function maybeWarnHostCollision() {
  try {
    const saasHost = new URL(REMOTE_SAAS_HOST).hostname;
    if (saasHost && stripBrackets(REMOTE.host) === stripBrackets(saasHost)) {
      warn(
        "Arbiter: daemonUrl points at your LangGuard host, not an Arbiter daemon \u2014 hooks will 404"
      );
    }
  } catch {
  }
}
async function handleEnforceRemote(bodyRaw) {
  if (REMOTE.invalid) {
    remoteEnforceFail(
      `invalid daemonUrl (${REMOTE.reason}) \u2014 fix daemonUrl in ~/.config/arbiter/config.yaml`
    );
    return;
  }
  maybeWarnHostCollision();
  const credential = resolveRemoteCredential();
  if (!credential || !LGR_RE.test(credential)) {
    const why = credential ? "the configured API key is not an lgr_ tenant key" : "no API key found";
    remoteEnforceFail(
      `cloud daemon configured but ${why} \u2014 get a key at ${portalBase()}/arbiter/connect (or from your admin) and add apiKey: to ~/.config/arbiter/config.yaml`
    );
    return;
  }
  let res;
  try {
    res = await postHookRemoteWithRetry("enforce", bodyRaw, REMOTE_ENFORCE_BUDGET_MS, credential);
  } catch (err) {
    remoteEnforceFail(
      `cloud daemon ${REMOTE.raw} unreachable (${err?.code ?? "network error"}) \u2014 coverage gap`
    );
    return;
  }
  if (res.status >= 200 && res.status < 300) {
    exitWith(0, res.text);
    return;
  }
  if (res.status === 401) {
    remoteEnforceFail(
      `credential rejected by ${REMOTE.raw} \u2014 get a new key at ${portalBase()}/arbiter/connect (or from your admin) and update apiKey: in ~/.config/arbiter/config.yaml`
    );
    return;
  }
  if (res.status === 404) {
    remoteEnforceFail(
      `${REMOTE.raw} does not appear to be an Arbiter daemon \u2014 check daemonUrl in ~/.config/arbiter/config.yaml`
    );
    return;
  }
  remoteEnforceFail(`cloud daemon ${REMOTE.raw} returned HTTP ${res.status}`);
}
async function handleAdvisoryRemote(hookPhase, bodyRaw) {
  if (REMOTE.invalid) {
    warn(`${hookPhase} (remote): invalid daemonUrl (${REMOTE.reason}) \u2014 skipping (fail-OPEN).`);
    exitWith(0);
    return;
  }
  maybeWarnHostCollision();
  const credential = resolveRemoteCredential();
  if (!credential || !LGR_RE.test(credential)) {
    exitWith(0);
    return;
  }
  try {
    const res = await postHookRemote(hookPhase, bodyRaw, REMOTE_ADVISORY_TIMEOUT_MS, credential);
    if (res.status >= 200 && res.status < 300 && res.text) {
      exitWith(0, res.text);
      return;
    }
  } catch {
  }
  exitWith(0);
}
async function mainRemote(bodyRaw) {
  switch (phase) {
    case "enforce":
      await handleEnforceRemote(bodyRaw);
      return;
    case "screen":
    case "evidence":
    case "verify":
      await handleAdvisoryRemote(phase, bodyRaw);
      return;
    default:
      warn(`unknown phase "${String(phase)}" \u2014 no-op (exit 0).`);
      exitWith(0);
  }
}
async function main() {
  const bodyRaw = stampHarness(await readStdin());
  if (REMOTE) {
    await mainRemote(bodyRaw);
    return;
  }
  switch (phase) {
    case "enforce":
      await handleEnforce(bodyRaw);
      return;
    case "screen":
    case "evidence":
    case "verify":
      await handleAdvisory(phase, bodyRaw);
      return;
    default:
      warn(`unknown phase "${String(phase)}" \u2014 no-op (exit 0).`);
      exitWith(0);
  }
}
main().catch((err) => {
  warn(`shim error (failing OPEN): ${String(err?.stack ?? err)}`);
  exitWith(0);
});
