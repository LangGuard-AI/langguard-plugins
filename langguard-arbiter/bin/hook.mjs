import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// arbiter-claude/plugin/bin/hook.mjs
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
var phase = process.argv[2];
var token = process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN ?? "";
var dataDir = process.env.CLAUDE_PLUGIN_DATA ?? join(homedir(), ".config", "arbiter", "plugin-data");
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
function postHook(hookPhase, bodyRaw, timeoutMs) {
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
          ...token ? { Authorization: `Bearer ${token}` } : {}
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
async function postHookWithRetry(hookPhase, bodyRaw, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const backoffs = [0, 150, 300, 600];
  let lastErr;
  for (let i = 0; i < backoffs.length; i++) {
    if (backoffs[i] > 0) await sleep(backoffs[i]);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await postHook(hookPhase, bodyRaw, Math.min(ENFORCE_ATTEMPT_TIMEOUT_MS, remaining));
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
  if (!state) return { verdict: "warming", reason: "daemon-state.json absent (never started)" };
  if (state.ready !== true) {
    return { verdict: "warming", reason: `daemon not ready (ready=${String(state.ready)})` };
  }
  if (state.opaProvisioning === true) {
    return { verdict: "warming", reason: "OPA binary still provisioning (first-run download)" };
  }
  const started = Date.parse(state.startedAt);
  if (Number.isFinite(started) && now - started < STARTUP_GRACE_MS) {
    return { verdict: "warming", reason: `within startup grace (${now - started}ms < ${STARTUP_GRACE_MS}ms)` };
  }
  if (!ownerAlive(state)) {
    return {
      verdict: "warming",
      reason: `owner pid ${state.pid ?? "(none)"} not alive \u2192 stale/never-up`
    };
  }
  const hb = Date.parse(state.lastHeartbeat);
  if (!Number.isFinite(hb)) {
    return { verdict: "dead", reason: "ready daemon has no valid lastHeartbeat and is unreachable" };
  }
  const age = now - hb;
  if (age > HEARTBEAT_STALE_MS) {
    return { verdict: "dead", reason: `heartbeat stale by ${age}ms and socket unreachable` };
  }
  return { verdict: "dead", reason: "ready daemon unreachable despite a fresh heartbeat (wedged)" };
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
async function handleEnforce(bodyRaw) {
  if (!token) {
    warn("enforce: CLAUDE_PLUGIN_OPTION_API_TOKEN is empty (sensitive userConfig not injected) \u2014 failing OPEN.");
    exitWith(0);
    return;
  }
  let res;
  try {
    res = await postHookWithRetry("enforce", bodyRaw, ENFORCE_RETRY_BUDGET_MS);
  } catch (err) {
    const { verdict, reason } = classifyGrace(readDaemonState(), Date.now());
    if (verdict === "warming") {
      warn(`enforce: daemon warming/never-up (${reason}) \u2014 failing OPEN.`);
      exitWith(0);
    } else {
      warn(`enforce: daemon was up and is now unreachable (${reason}) \u2014 BLOCKING (fail-CLOSED, exit 2).`);
      exitWith(2);
    }
    return;
  }
  if (res.status >= 200 && res.status < 300) {
    exitWith(0, res.text);
    return;
  }
  warn(`enforce: daemon reachable but returned HTTP ${res.status} \u2014 failing OPEN.`);
  exitWith(0);
}
async function main() {
  const bodyRaw = await readStdin();
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
