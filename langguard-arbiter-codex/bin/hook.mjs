import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// arbiter-codex/plugin/bin/hook.mjs
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";

// arbiter-codex/plugin/lib/daemon-paths.mjs
import { join } from "node:path";
import { homedir } from "node:os";
function resolveDataDir(env = process.env) {
  const fromEnv = typeof env.PLUGIN_DATA === "string" ? env.PLUGIN_DATA.trim() : "";
  if (fromEnv) return fromEnv;
  return join(homedir(), ".config", "arbiter");
}

// arbiter-codex/plugin/bin/hook.mjs
var HOST = "127.0.0.1";
var PORT = Number(process.env.ARBITER_HOOK_DAEMON_PORT) || 52746;
var STARTUP_GRACE_MS = 2e4;
var HEARTBEAT_STALE_MS = 15e3;
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
var CANONICAL_BEARER_RE = /^arbd_[0-9a-f]{64}$/;
var TOKEN_SHAPE = /^[\x21-\x7E]+$/;
var BEARER_POLL_INTERVAL_MS = 100;
var phase = process.argv[2];
var dataDir = resolveDataDir(process.env);
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
  const path = process.env.ARBITER_GLOBAL_CONFIG ?? join2(homedir2(), ".config", "arbiter", "config.yaml");
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
function readCanonicalBearer() {
  const path = process.env.ARBITER_BEARER_FILE ?? join2(homedir2(), ".config", "arbiter", "bearer");
  try {
    const v = readFileSync(path, "utf8").trim();
    return CANONICAL_BEARER_RE.test(v) ? v : "";
  } catch {
    return "";
  }
}
function readLockfileBearer() {
  const path = process.env.ARBITER_LOCKFILE ?? join2(homedir2(), ".config", "arbiter", "daemon.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data.bearer !== "string" || !data.bearer) return "";
    if (typeof data.port !== "number" || data.port !== PORT) return "";
    if (!TOKEN_SHAPE.test(data.bearer)) return "";
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
var configText = readGlobalConfigText();
var ENFORCEMENT_MODE = yamlScalar(configText, "enforcementMode") === "strict" || process.env.ARBITER_CODEX_ENFORCE === "1" ? "strict" : "cooperative";
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
function emit(result) {
  if (result.stderr) warn(result.stderr);
  exitWith(result.exitCode, result.stdout || void 0);
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
    parsed.arbiter_harness = "codex";
    return JSON.stringify(parsed);
  } catch {
    return bodyRaw;
  }
}
function coerceCodexDecision(decision) {
  return decision === "allow" ? "allow" : "deny";
}
function shapeEnforceResult(daemonResponse) {
  const hso = daemonResponse?.hookSpecificOutput;
  const raw = hso?.permissionDecision;
  const decision = coerceCodexDecision(raw);
  if (decision === "allow") return { stdout: "", stderr: "", exitCode: 0 };
  let reason = typeof hso?.permissionDecisionReason === "string" ? hso.permissionDecisionReason : void 0;
  if (raw === "ask") {
    const note = "Approval happens in LangGuard \u2014 denied here (Codex has no interactive approval path). Ask an admin to approve this tool in LangGuard, then retry.";
    reason = reason ? `${reason} ${note}` : note;
  }
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      ...reason ? { permissionDecisionReason: reason } : {}
    }
  };
  return {
    stdout: JSON.stringify(out),
    stderr: reason ?? "Blocked by LangGuard Arbiter",
    exitCode: 2
  };
}
function shapeBlockableResult(daemonResponse) {
  if (daemonResponse?.decision === "block") {
    const reason = typeof daemonResponse.reason === "string" ? daemonResponse.reason : "Blocked by LangGuard Arbiter";
    return { stdout: JSON.stringify({ decision: "block", reason }), stderr: reason, exitCode: 2 };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}
function shapeScreenResult(daemonResponse) {
  if (typeof daemonResponse?.hookSpecificOutput?.additionalContext === "string") {
    return { stdout: JSON.stringify(daemonResponse), stderr: "", exitCode: 0 };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}
function enforceDenyResult(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
  return { stdout: JSON.stringify(out), stderr: reason, exitCode: 2 };
}
function postHook(hookPhase, bodyRaw, timeoutMs, bearer = "") {
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
    return JSON.parse(readFileSync(join2(dataDir, "daemon-state.json"), "utf8"));
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
    return { verdict: "warming", category: "transient", reason: "OPA binary still provisioning (first-run download)" };
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
var strictMarkerPath = () => join2(dataDir, ".arbiter-strict-firstcontact");
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
  const pluginRoot = process.env.PLUGIN_ROOT;
  if (!pluginRoot) return;
  if (await isPortBound(PORT)) return;
  const launch = join2(pluginRoot, "monitor", "launch.mjs");
  const opaPath = join2(dataDir, "bin", process.platform === "win32" ? "opa.exe" : "opa");
  try {
    const child = spawn(
      process.execPath,
      [launch, "--opa-path", opaPath, "--data-dir", dataDir],
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
    const res = await postHook(hookPhase, bodyRaw, ADVISORY_TIMEOUT_MS, resolveLoopbackBearer());
    if (res.status >= 200 && res.status < 300 && res.text) {
      let daemonResponse;
      try {
        daemonResponse = JSON.parse(res.text);
      } catch {
        exitWith(0);
        return;
      }
      emit(hookPhase === "screen" ? shapeScreenResult(daemonResponse) : shapeBlockableResult(daemonResponse));
      return;
    }
  } catch {
  }
  exitWith(0);
}
function relayEnforceResponse(res) {
  clearStrictMarker();
  let daemonResponse;
  try {
    daemonResponse = JSON.parse(res.text);
  } catch {
    emit(enforceDenyResult("Arbiter daemon returned an unparseable enforce response \u2014 failing CLOSED."));
    return;
  }
  emit(shapeEnforceResult(daemonResponse));
}
function failEnforceViaGraceTable(reasonPrefix) {
  const now = Date.now();
  const state = readDaemonState();
  if (state) clearStrictMarker();
  const g = classifyGrace(state, now);
  const strict = ENFORCEMENT_MODE === "strict";
  const block = g.verdict === "dead" || strict && g.category === "no-daemon" || strict && g.category === "absent" && strictAbsentGraceExpired(now);
  if (block) {
    emit(enforceDenyResult(
      `${reasonPrefix} (${g.reason}) \u2014 ${strict ? "strict mode, " : ""}BLOCKING (fail-CLOSED).`
    ));
  } else {
    warn(`enforce: ${reasonPrefix} (${g.reason})${strict ? " [within cold-start grace]" : ""} \u2014 failing OPEN.`);
    exitWith(0);
  }
}
async function handleEnforce(bodyRaw) {
  const deadline = Date.now() + ENFORCE_RETRY_BUDGET_MS;
  let bearer = resolveLoopbackBearer();
  while (!bearer && Date.now() < deadline) {
    await sleep(BEARER_POLL_INTERVAL_MS);
    bearer = resolveLoopbackBearer();
  }
  if (!bearer) {
    failEnforceViaGraceTable(
      "no loopback bearer (~/.config/arbiter/bearer absent, no pid-live daemon.json for this port)"
    );
    return;
  }
  const postBudget = Math.max(deadline - Date.now(), ENFORCE_ATTEMPT_TIMEOUT_MS);
  let res;
  try {
    res = await postHookWithRetry("enforce", bodyRaw, postBudget, bearer);
  } catch {
    failEnforceViaGraceTable("Arbiter daemon unavailable");
    return;
  }
  if (res.status >= 200 && res.status < 300) {
    relayEnforceResponse(res);
    return;
  }
  if (res.status === 401) {
    const lockBearer = readLockfileBearer();
    if (lockBearer && lockBearer !== bearer) {
      warn(
        "enforce: daemon returned 401 for the canonical loopback bearer \u2014 the resident daemon predates the canonical ~/.config/arbiter/bearer file and only accepts the legacy bearer it published in the lockfile. Retrying once with the pid-live lockfile bearer (interim compat)."
      );
      try {
        const retry = await postHook("enforce", bodyRaw, ENFORCE_ATTEMPT_TIMEOUT_MS, lockBearer);
        if (retry.status >= 200 && retry.status < 300) {
          relayEnforceResponse(retry);
          return;
        }
      } catch {
      }
    }
    const reason = `LangGuard Arbiter: loopback bearer mismatch with the daemon owning port ${PORT} \u2014 the daemon rejected the canonical loopback bearer. Restart the daemon (a resident old daemon lingers across a plugin update) or re-run setup from the Arbiter Hooks settings page.`;
    if (ENFORCEMENT_MODE === "strict") {
      emit(enforceDenyResult(`${reason} BLOCKING (strict mode, fail-CLOSED).`));
    } else {
      warn(`enforce: ${reason} Failing OPEN (cooperative).`);
      exitWith(0);
    }
    return;
  }
  warn(`enforce: daemon reachable but returned HTTP ${res.status} \u2014 failing OPEN.`);
  exitWith(0);
}
async function main() {
  const bodyRaw = stampHarness(await readStdin());
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
