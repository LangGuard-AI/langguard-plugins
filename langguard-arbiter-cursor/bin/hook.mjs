import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// arbiter-cursor/plugin/bin/hook.mjs
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join as join2, dirname } from "node:path";
import { homedir as homedir2 } from "node:os";
import { fileURLToPath } from "node:url";

// arbiter-cursor/plugin/lib/daemon-paths.mjs
import { join } from "node:path";
import { homedir } from "node:os";
function resolveDataDir(env = process.env) {
  const fromEnv = typeof env.ARBITER_DATA_DIR === "string" ? env.ARBITER_DATA_DIR.trim() : "";
  if (fromEnv) return fromEnv;
  return join(homedir(), ".config", "arbiter");
}

// arbiter-cursor/plugin/lib/tool-normalize.mjs
var RUNNER_SLUG_DENYLIST = /* @__PURE__ */ new Set([
  "node",
  "npx",
  "npm",
  "docker",
  "uvx",
  "python",
  "python3",
  "deno",
  "bunx"
]);
var TOOLNAME_PREFIX_SEPARATORS = ["-", "_"];
function isSlugLike(s) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s) && !s.includes("__") && !s.endsWith("_");
}
function serverFromUrl(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return void 0;
  }
  if (!host) return void 0;
  const generic = /* @__PURE__ */ new Set(["www", "api", "mcp", "app", "com", "org", "net", "io", "ai", "co"]);
  const labels = host.split(".").filter((l) => l.length > 0 && !generic.has(l));
  const pick = labels.length > 0 ? labels[labels.length - 1] : void 0;
  return pick && isSlugLike(pick) ? pick : void 0;
}
function splitToolName(toolName) {
  for (const sep of TOOLNAME_PREFIX_SEPARATORS) {
    const idx = toolName.indexOf(sep);
    if (idx > 0 && idx < toolName.length - 1) {
      const candidateServer = toolName.slice(0, idx);
      const candidateAction = toolName.slice(idx + 1);
      if (isSlugLike(candidateServer) && candidateAction.length > 0) {
        return { server: candidateServer, action: candidateAction };
      }
    }
  }
  return { action: toolName };
}
function normalizeCursorTool(input) {
  const rawToolName = (input.toolName ?? "").trim();
  const split = splitToolName(rawToolName);
  let server;
  if (input.command) {
    const cmd = input.command.trim();
    if (isSlugLike(cmd) && !RUNNER_SLUG_DENYLIST.has(cmd.toLowerCase())) {
      server = cmd;
    }
  }
  if (!server && input.url) {
    server = serverFromUrl(input.url);
  }
  if (!server && split.server) {
    server = split.server;
  }
  let action;
  if (split.server && server && split.server === server) {
    action = split.action;
  } else if (!input.command && !input.url && split.server) {
    action = split.action;
  } else {
    action = rawToolName;
  }
  if (server && action) {
    return { normalized: `${server}.${action}`, server, action, degenerate: false };
  }
  return { normalized: rawToolName, action: rawToolName, degenerate: true };
}

// arbiter-cursor/plugin/lib/cursor-translate.mjs
var USER_MESSAGE_KEY = "userMessage";
var AGENT_MESSAGE_KEY = "agentMessage";
function str(v) {
  return typeof v === "string" ? v : void 0;
}
function sessionIdOf(body) {
  return str(body?.conversation_id) ?? str(body?.session_id) ?? "unknown";
}
function coerceToolInput(raw) {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
    }
  }
  return {};
}
function coerceToolResponse(raw) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}
function isShellEvent(body) {
  if (str(body?.hook_event_name) === "beforeShellExecution") return true;
  if (str(body?.hook_event_name) === "beforeMCPExecution") return false;
  return typeof body?.command === "string" && typeof body?.tool_name !== "string";
}
function toCanonicalMcpToolName(input) {
  const { server, action, degenerate } = normalizeCursorTool(input);
  if (!degenerate) return `mcp__${server}__${action}`;
  const sanitized = (input.toolName ?? "").trim().replaceAll(".", "_").replace(/_{2,}/g, "_");
  return `mcp__${sanitized}`;
}
function translateInbound(phase2, body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const session_id = sessionIdOf(body);
  switch (phase2) {
    case "screen":
      return {
        cursorEvent: "sessionStart",
        ccBody: {
          hook_event_name: "SessionStart",
          session_id,
          arbiter_harness: "cursor"
        }
      };
    case "enforce": {
      if (isShellEvent(body)) {
        return {
          cursorEvent: "beforeShellExecution",
          ccBody: {
            hook_event_name: "PreToolUse",
            session_id,
            tool_name: "Bash",
            tool_input: {
              command: str(body.command) ?? "",
              ...str(body.cwd) ? { cwd: body.cwd } : {}
            },
            arbiter_harness: "cursor"
          }
        };
      }
      return {
        cursorEvent: "beforeMCPExecution",
        ccBody: {
          hook_event_name: "PreToolUse",
          session_id,
          tool_name: toCanonicalMcpToolName({
            toolName: str(body.tool_name) ?? "",
            command: str(body.command),
            url: str(body.url)
          }),
          tool_input: coerceToolInput(body.tool_input),
          arbiter_harness: "cursor"
        }
      };
    }
    case "evidence":
      return {
        cursorEvent: "afterMCPExecution",
        ccBody: {
          hook_event_name: "PostToolUse",
          session_id,
          tool_name: toCanonicalMcpToolName({
            toolName: str(body.tool_name) ?? "",
            command: str(body.command),
            url: str(body.url)
          }),
          tool_input: coerceToolInput(body.tool_input),
          tool_response: coerceToolResponse(body.result_json),
          arbiter_harness: "cursor"
        }
      };
    case "verify":
      return {
        cursorEvent: "stop",
        ccBody: {
          hook_event_name: "Stop",
          session_id,
          arbiter_harness: "cursor"
        }
      };
    default:
      return null;
  }
}
function enforceEnvelope(permission, reason) {
  return JSON.stringify({
    permission,
    [USER_MESSAGE_KEY]: reason,
    [AGENT_MESSAGE_KEY]: reason
  });
}
function shapeEnforceOutput(daemonResponse) {
  const hso = daemonResponse?.hookSpecificOutput;
  const raw = hso?.permissionDecision;
  const reason = typeof hso?.permissionDecisionReason === "string" ? hso.permissionDecisionReason : void 0;
  if (raw === "allow") {
    return { stdout: "{}", stderr: "", exitCode: 0 };
  }
  if (raw === "ask") {
    const askReason = reason ?? "LangGuard Arbiter: this tool call requires human approval.";
    return { stdout: enforceEnvelope("ask", askReason), stderr: "", exitCode: 0 };
  }
  const denyReason = raw === "deny" ? reason ?? "Blocked by LangGuard Arbiter" : "Arbiter daemon rendered no usable verdict \u2014 failing CLOSED.";
  return { stdout: enforceEnvelope("deny", denyReason), stderr: denyReason, exitCode: 2 };
}
function enforceDenyOutput(reason) {
  return { stdout: enforceEnvelope("deny", reason), stderr: reason, exitCode: 2 };
}
function catastrophicDenyOutput(reason) {
  const userMessage = "Catastrophic command blocked by LangGuard Arbiter";
  return {
    stdout: JSON.stringify({
      permission: "deny",
      [USER_MESSAGE_KEY]: userMessage,
      [AGENT_MESSAGE_KEY]: reason
    }),
    stderr: reason,
    exitCode: 2
  };
}
function shapeScreenOutput(daemonResponse) {
  const ctx = daemonResponse?.hookSpecificOutput?.additionalContext;
  if (typeof ctx === "string" && ctx.length > 0) {
    return { stdout: JSON.stringify({ additional_context: ctx }), stderr: "", exitCode: 0 };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}
function shapeEvidenceOutput(daemonResponse) {
  if (daemonResponse?.decision === "block") {
    const reason = typeof daemonResponse.reason === "string" ? daemonResponse.reason : "Flagged by LangGuard Arbiter";
    return { stdout: JSON.stringify({ additional_context: reason }), stderr: "", exitCode: 0 };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}
function shapeVerifyOutput(daemonResponse) {
  if (daemonResponse?.decision === "block") {
    const reason = typeof daemonResponse.reason === "string" ? daemonResponse.reason : "Flagged by LangGuard Arbiter";
    return { stdout: JSON.stringify({ followup_message: reason }), stderr: "", exitCode: 0 };
  }
  return { stdout: "", stderr: "", exitCode: 0 };
}

// arbiter-cursor/plugin/lib/shell-catastrophic.mjs
var DEFAULT_CATASTROPHIC_DENY_LIST = [
  "rm -rf /",
  "rm -rf ~",
  "mkfs.",
  "dd if=",
  ":(){:|:&};:",
  // fork bomb
  "git push --force",
  // force-push to any remote
  "git push -f"
];
var RUNNER_PREFIXES = /* @__PURE__ */ new Set(["sudo", "env", "nice", "xargs", "eval", "exec", "command"]);
var ROOT_CATASTROPHIC_TARGETS = /* @__PURE__ */ new Set([
  "/",
  "/.",
  "/*",
  "~",
  "~/",
  "~/*",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/media",
  "/mnt",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var"
]);
function pathBasename(p) {
  const idx = p.lastIndexOf("/");
  return idx >= 0 ? p.slice(idx + 1) : p;
}
function normalizeCommand(token2) {
  const deescaped = token2.startsWith("\\") ? token2.slice(1) : token2;
  return pathBasename(deescaped);
}
function findRealCommandIndex(argv) {
  let i = 0;
  while (i < argv.length) {
    const tok = normalizeCommand(argv[i]);
    if (RUNNER_PREFIXES.has(tok)) {
      i++;
      if (tok === "env") {
        while (i < argv.length && (argv[i].includes("=") || argv[i].startsWith("-"))) {
          i++;
        }
      }
      continue;
    }
    break;
  }
  return i;
}
function hasRecursiveAndForceFlags(tokens, flagStart) {
  let hasRecursive = false;
  let hasForce = false;
  for (let i = flagStart; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--recursive" || tok === "-r" || tok === "-R") {
      hasRecursive = true;
    } else if (tok === "--force" || tok === "-f") {
      hasForce = true;
    } else if (tok.startsWith("-") && !tok.startsWith("--")) {
      const letters = tok.slice(1);
      if (/[rR]/.test(letters)) hasRecursive = true;
      if (/f/.test(letters)) hasForce = true;
    }
  }
  return hasRecursive && hasForce;
}
function hasRootTarget(tokens, start) {
  for (let i = start; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("-")) continue;
    const bare = tok.endsWith("/") && tok.length > 1 ? tok.slice(0, -1) : tok;
    if (ROOT_CATASTROPHIC_TARGETS.has(bare)) return true;
    const withoutGlob = tok.endsWith("/*") ? tok.slice(0, -2) : null;
    if (withoutGlob && ROOT_CATASTROPHIC_TARGETS.has(withoutGlob)) return true;
  }
  return false;
}
function isCatastrophicShellMatch(command, denyList) {
  const collapsed = command.replace(/\s+/g, "");
  if (collapsed.includes(":(){:|:&};:")) return true;
  return splitOnSeparators(command).some((seg) => isCatastrophicSegment(seg, denyList));
}
function splitOnSeparators(command) {
  const segs = [];
  let cur = "";
  let quote = "";
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r" || ch === ";") {
      segs.push(cur);
      cur = "";
      i++;
      continue;
    }
    if (ch === "|") {
      segs.push(cur);
      cur = "";
      i += command[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      segs.push(cur);
      cur = "";
      i += command[i + 1] === "&" ? 2 : 1;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) segs.push(cur);
  return segs.length > 0 ? segs : [command];
}
function isCatastrophicSegment(command, denyList) {
  const normalized = command.replace(/\s+/g, " ").trim();
  const argv = simpleSplit(normalized);
  const cmdIdx = findRealCommandIndex(argv);
  const realCmd = cmdIdx < argv.length ? normalizeCommand(argv[cmdIdx]) : "";
  if (realCmd === "rm") {
    const flagStart = cmdIdx + 1;
    if (hasRecursiveAndForceFlags(argv, flagStart) && hasRootTarget(argv, flagStart)) {
      return true;
    }
  }
  const argvNormalized = argv.join(" ");
  return denyList.some((entry) => {
    const entryTrimmed = entry.replace(/\s+/g, " ").trim();
    if (entryTrimmed.startsWith("rm ")) return false;
    return normalized.includes(entryTrimmed) || argvNormalized.includes(entryTrimmed);
  });
}
function simpleSplit(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === " " || s[i] === "	") {
      i++;
      continue;
    }
    let tok = "";
    while (i < s.length && s[i] !== " " && s[i] !== "	") {
      if (s[i] === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          tok += s[i++];
        }
        i++;
      } else if (s[i] === "'") {
        i++;
        while (i < s.length && s[i] !== "'") {
          tok += s[i++];
        }
        i++;
      } else {
        tok += s[i++];
      }
    }
    if (tok) tokens.push(tok);
  }
  return tokens;
}

// arbiter-cursor/plugin/bin/hook.mjs
var HOST = "127.0.0.1";
var PORT = Number(process.env.ARBITER_HOOK_DAEMON_PORT) || 52746;
var STARTUP_GRACE_MS = 2e4;
var HEARTBEAT_STALE_MS = 15e3;
var ENFORCE_RETRY_BUDGET_MS = 2e3;
var ENFORCE_ATTEMPT_TIMEOUT_MS = 1200;
var ADVISORY_TIMEOUT_MS = 1500;
var PORT_PROBE_TIMEOUT_MS = 400;
var CATASTROPHIC_AUDIT_TIMEOUT_MS = 300;
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
function readLockfileBearer() {
  const path = process.env.ARBITER_LOCKFILE ?? join2(homedir2(), ".config", "arbiter", "daemon.json");
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data.bearer !== "string" || !data.bearer) return "";
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
var configText = readGlobalConfigText();
var resolvedToken = process.env.LANGGUARD_API_KEY?.trim() || yamlScalar(configText, "apiKey") || process.env.ARBITER_TOKEN?.trim() || readLockfileBearer();
var TOKEN_SHAPE = /^[\x21-\x7E]+$/;
var token = resolvedToken && TOKEN_SHAPE.test(resolvedToken) ? resolvedToken : "";
var tokenUnusable = Boolean(resolvedToken) && !token;
var ENFORCEMENT_MODE = yamlScalar(configText, "enforcementMode") === "strict" || process.env.ARBITER_ENFORCE === "1" ? "strict" : "cooperative";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function warn(msg) {
  try {
    process.stderr.write(`[arbiter] ${msg}
`);
  } catch {
  }
}
var kickerArmed = false;
function armKicker() {
  kickerArmed = true;
}
function resolvePluginRoot() {
  if (process.env.PLUGIN_ROOT) return process.env.PLUGIN_ROOT;
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
function spawnDaemon() {
  const pluginRoot = resolvePluginRoot();
  const launch = join2(pluginRoot, "monitor", "launch.mjs");
  const opaPath = join2(dataDir, "bin", process.platform === "win32" ? "opa.exe" : "opa");
  const child = spawn(process.execPath, [launch, "--opa-path", opaPath, "--data-dir", dataDir], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
}
function runKickerIfArmed() {
  if (!kickerArmed) return;
  kickerArmed = false;
  try {
    spawnDaemon();
  } catch {
  }
}
function exitWith(code, stdoutText) {
  process.exitCode = code;
  if (stdoutText) {
    process.stdout.write(stdoutText, () => {
      runKickerIfArmed();
      process.exit(code);
    });
  } else {
    runKickerIfArmed();
    process.exit(code);
  }
}
function emit(result) {
  if (result.stderr) warn(result.stderr);
  exitWith(result.exitCode, result.stdout || void 0);
}
function emitPassive() {
  exitWith(0, "{}");
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
function postHook(hookPhase, bodyRaw, timeoutMs, bearer = token) {
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
async function maybeSpawnDaemonPrimary() {
  if (await isPortBound(PORT)) return;
  try {
    spawnDaemon();
  } catch {
  }
}
async function handleAdvisory(hookPhase, translated) {
  if (hookPhase === "screen") {
    try {
      await maybeSpawnDaemonPrimary();
    } catch {
    }
  }
  try {
    const res = await postHook(hookPhase, JSON.stringify(translated.ccBody), ADVISORY_TIMEOUT_MS);
    if (res.status >= 200 && res.status < 300 && res.text) {
      let daemonResponse;
      try {
        daemonResponse = JSON.parse(res.text);
      } catch {
        exitWith(0);
        return;
      }
      if (hookPhase === "screen") emit(shapeScreenOutput(daemonResponse));
      else if (hookPhase === "evidence") emit(shapeEvidenceOutput(daemonResponse));
      else emit(shapeVerifyOutput(daemonResponse));
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
    emit(enforceDenyOutput("Arbiter daemon returned an unparseable enforce response \u2014 failing CLOSED."));
    return;
  }
  emit(shapeEnforceOutput(daemonResponse));
}
function armKickerFromGrace() {
  const g = classifyGrace(readDaemonState(), Date.now());
  if (g.category === "absent" || g.category === "no-daemon") armKicker();
}
async function handleEnforceMcp(translated) {
  if (!token) {
    warnNoCredential("enforce");
    exitWith(0);
    return;
  }
  const bodyRaw = JSON.stringify(translated.ccBody);
  let res;
  try {
    res = await postHookWithRetry("enforce", bodyRaw, ENFORCE_RETRY_BUDGET_MS);
  } catch {
    const now = Date.now();
    const state = readDaemonState();
    if (state) clearStrictMarker();
    const g = classifyGrace(state, now);
    const strict = ENFORCEMENT_MODE === "strict";
    if (g.category === "absent" || g.category === "no-daemon") armKicker();
    const block = g.verdict === "dead" || strict && g.category === "no-daemon" || strict && g.category === "absent" && strictAbsentGraceExpired(now);
    if (block) {
      emit(enforceDenyOutput(
        `Arbiter daemon unavailable (${g.reason}) \u2014 ${strict ? "strict mode, " : ""}BLOCKING (fail-CLOSED).`
      ));
    } else {
      warn(`enforce: daemon warming/unavailable (${g.reason})${strict ? " [within cold-start grace]" : ""} \u2014 failing OPEN.`);
      exitWith(0);
    }
    return;
  }
  if (res.status >= 200 && res.status < 300) {
    relayEnforceResponse(res);
    return;
  }
  if (res.status === 401) {
    const retry = await retryWithLockfileBearer(bodyRaw);
    if (retry) {
      relayEnforceResponse(retry);
      return;
    }
    const reason = bearerMismatchReason();
    if (ENFORCEMENT_MODE === "strict") {
      emit(enforceDenyOutput(`${reason} BLOCKING (strict mode, fail-CLOSED).`));
    } else {
      warn(`enforce: ${reason} Failing OPEN (cooperative).`);
      exitWith(0);
    }
    return;
  }
  warn(`enforce: daemon reachable but returned HTTP ${res.status} \u2014 failing OPEN.`);
  exitWith(0);
}
async function handleEnforceShell(translated) {
  const command = translated.ccBody?.tool_input?.command ?? "";
  if (isCatastrophicShellMatch(command, DEFAULT_CATASTROPHIC_DENY_LIST)) {
    const reason = "LangGuard Arbiter: this shell command matches the catastrophic deny-list \u2014 blocked by the offline backstop (no daemon required).";
    try {
      await Promise.race([
        postHook("enforce", JSON.stringify(translated.ccBody), CATASTROPHIC_AUDIT_TIMEOUT_MS).catch(() => {
        }),
        sleep(CATASTROPHIC_AUDIT_TIMEOUT_MS)
      ]);
    } catch {
    }
    emit(catastrophicDenyOutput(reason));
    return;
  }
  if (!token) {
    warnNoCredential("enforce (shell audit)");
    exitWith(0);
    return;
  }
  const bodyRaw = JSON.stringify(translated.ccBody);
  let res;
  try {
    res = await postHookWithRetry("enforce", bodyRaw, ENFORCE_RETRY_BUDGET_MS);
  } catch {
    armKickerFromGrace();
    warn("enforce (shell audit): daemon unreachable \u2014 failing OPEN (advisory posture; offline catastrophic backstop already ran).");
    exitWith(0);
    return;
  }
  if (res.status >= 200 && res.status < 300) {
    relayEnforceResponse(res);
    return;
  }
  if (res.status === 401) {
    const retry = await retryWithLockfileBearer(bodyRaw);
    if (retry) {
      relayEnforceResponse(retry);
      return;
    }
    warn(`enforce (shell audit): ${bearerMismatchReason()} Failing OPEN (advisory posture).`);
    exitWith(0);
    return;
  }
  warn(`enforce (shell audit): daemon reachable but returned HTTP ${res.status} \u2014 failing OPEN.`);
  exitWith(0);
}
async function retryWithLockfileBearer(bodyRaw) {
  const lockBearer = readLockfileBearer();
  if (!lockBearer || lockBearer === token) return null;
  warn(
    "enforce: daemon returned 401 for the configured key \u2014 this harness's key differs from the daemon owner's loopback bearer (cross-harness key mismatch). Retrying once with the owner's published lockfile bearer (~/.config/arbiter/daemon.json)."
  );
  try {
    const retry = await postHook("enforce", bodyRaw, ENFORCE_ATTEMPT_TIMEOUT_MS, lockBearer);
    if (retry.status >= 200 && retry.status < 300) return retry;
  } catch {
  }
  return null;
}
function bearerMismatchReason() {
  return `LangGuard Arbiter: loopback key mismatch with the daemon owning port ${PORT} \u2014 align keys (reuse ONE lgr_ key across harnesses, or set LANGGUARD_API_KEY machine-wide) or re-run setup from the Arbiter Hooks settings page.`;
}
function warnNoCredential(context) {
  if (tokenUnusable) {
    warn(
      `${context}: the resolved LangGuard API key ("${resolvedToken.slice(0, 8)}\u2026") contains characters that cannot be sent in an Authorization header (an unedited placeholder?) \u2014 treating as NO credential, failing OPEN. Put a real lgr_ key in ~/.config/arbiter/config.yaml (see the Arbiter Hooks settings page).`
    );
  } else {
    warn(`${context}: no LangGuard API key (LANGGUARD_API_KEY / config.yaml apiKey / ARBITER_TOKEN / lockfile) \u2014 failing OPEN.`);
  }
}
async function main() {
  const raw = await readStdin();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = void 0;
  }
  if (phase !== "screen" && phase !== "enforce" && phase !== "evidence" && phase !== "verify") {
    warn(`unknown phase "${String(phase)}" \u2014 answering {} (exit 0).`);
    emitPassive();
    return;
  }
  const translated = translateInbound(phase, body);
  if (!translated) {
    warn(`${phase}: unparseable or non-object stdin \u2014 answering {} locally (exit 0), not forwarded.`);
    emitPassive();
    return;
  }
  if (phase === "enforce") {
    if (translated.cursorEvent === "beforeShellExecution") await handleEnforceShell(translated);
    else await handleEnforceMcp(translated);
    return;
  }
  await handleAdvisory(phase, translated);
}
main().catch((err) => {
  warn(`shim error (failing OPEN): ${String(err?.stack ?? err)}`);
  emitPassive();
});
