import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// arbiter-cursor/plugin/bin/hook.mjs
import http2 from "node:http";
import { spawn } from "node:child_process";
import { readFileSync as readFileSync3, writeFileSync as writeFileSync3, rmSync as rmSync3 } from "node:fs";
import { join as join4, dirname as dirname3 } from "node:path";
import { homedir as homedir4 } from "node:os";
import { fileURLToPath } from "node:url";

// arbiter-cursor/plugin/lib/daemon-paths.mjs
import { join } from "node:path";
import { homedir } from "node:os";
function resolveDataDir(env = process.env) {
  const fromEnv = typeof env.ARBITER_DATA_DIR === "string" ? env.ARBITER_DATA_DIR.trim() : "";
  if (fromEnv) return fromEnv;
  return join(homedir(), ".config", "arbiter");
}

// arbiter-cursor/plugin/lib/ipc-auth.mjs
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { dirname, join as join2, win32 } from "node:path";
import { homedir as homedir2 } from "node:os";
var MODE_TABLE = Object.freeze({
  enforce: Object.freeze({ VERIFIED: "relay", UNVERIFIED: "block", ABSENT: "grace" }),
  advisory: Object.freeze({ VERIFIED: "relay", UNVERIFIED: "nothing", ABSENT: "nothing" })
});
var BODY_LIMIT_BYTES = 4 * 1024 * 1024;
var KEY_RE = /^[0-9a-f]{64}$/;
var MAC_RE = /^[0-9a-f]{64}$/;
var TAG_BYTES = 16;
var POSTURE_LOG_LIMIT_BYTES = 1024 * 1024;
var SOCKET_PATH_LIMIT = 100;
var RETRY_BACKOFFS_MS = [0, 150, 300, 600];
var EXEC_TIMEOUT_MS = 3e3;
var RUN_DIR_TRUST_TTL_MS = 60 * 60 * 1e3;
var RETRIED_REASONS = /* @__PURE__ */ new Set(["timeout", "reset", "unreachable", "silent"]);
var ALIVE_FILE = "daemon.alive";
var POWERSHELL = "WindowsPowerShell\\v1.0\\powershell.exe";
var O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function runDirPath(env = process.env) {
  const explicit = (env.ARBITER_RUN_DIR ?? "").trim();
  if (explicit) return explicit;
  const bearerFile = (env.ARBITER_BEARER_FILE ?? "").trim();
  return join2(bearerFile ? dirname(bearerFile) : join2(homedir2(), ".config", "arbiter"), "run");
}
function ensureRunDir(dir, deps = {}) {
  const windows = (deps.platform ?? process.platform) === "win32";
  try {
    if (!windows) {
      mkdirSync(dirname(dir), { recursive: true });
      try {
        mkdirSync(dir, { mode: 448 });
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }
    }
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) return { ok: false, dir, reason: "symlink" };
    if (!st.isDirectory()) return { ok: false, dir, reason: "not-directory" };
    if (windows) return { ok: true, dir };
    const euid = process.geteuid?.() ?? -1;
    if (euid >= 0 && st.uid !== euid) return { ok: false, dir, reason: "owner" };
    if ((st.mode & 63) !== 0) return { ok: false, dir, reason: "mode" };
    return { ok: true, dir };
  } catch {
    return { ok: false, dir, reason: "io" };
  }
}
var SYSTEM_SID = "S-1-5-18";
var ADMINISTRATORS_SID = "S-1-5-32-544";
var SDDL_ALIASES = { SY: SYSTEM_SID, BA: ADMINISTRATORS_SID };
var SDDL_ACCOUNT_RIDS = { LA: "500", LG: "501" };
var ALLOW_ACE_TYPES = /* @__PURE__ */ new Set(["A", "OA", "XA", "ZA"]);
var OWNER_PLACEHOLDERS = /* @__PURE__ */ new Set(["CO", "S-1-3-0", "OW", "S-1-3-4"]);
var SDDL_TRUSTEE = "S-1-[0-9-]+|[A-Z]{2}";
var SDDL_RE = new RegExp(`^O:(${SDDL_TRUSTEE})(?:G:(?:${SDDL_TRUSTEE}))?D:([A-Z_]*)(.*)$`);
function parseSddl(sddl) {
  const parts = SDDL_RE.exec(sddl.trim());
  if (!parts) return null;
  if (parts[2].includes("NO_ACCESS_CONTROL")) return null;
  const text = parts[3];
  const aces = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (depth === 0 && char !== "(") return text.startsWith("S:", i) ? { owner: parts[1], aces } : null;
    if (char === "(" && depth++ === 0) start = i + 1;
    if (char === ")" && --depth === 0) {
      const fields = text.slice(start, i).split(";");
      if (fields.length < 6) return null;
      aces.push({ type: fields[0], trustee: fields[5] });
    }
  }
  return depth === 0 ? { owner: parts[1], aces } : null;
}
function trusteeSid(trustee, userSid) {
  const alias = SDDL_ALIASES[trustee];
  if (alias) return alias;
  const rid = SDDL_ACCOUNT_RIDS[trustee];
  if (rid && userSid.endsWith(`-${rid}`)) return userSid;
  return trustee;
}
function judgeAcl(sddl, userSid) {
  const acl = parseSddl(sddl);
  if (acl === null) return { ok: false, reason: "acl-unreadable", detail: "no owner and DACL in the Get-Acl output" };
  const allowed = /* @__PURE__ */ new Set([userSid.toUpperCase(), SYSTEM_SID, ADMINISTRATORS_SID]);
  const foreign = /* @__PURE__ */ new Set();
  if (!allowed.has(trusteeSid(acl.owner, userSid).toUpperCase())) foreign.add(`O:${acl.owner}`);
  for (const ace of acl.aces) {
    if (!ALLOW_ACE_TYPES.has(ace.type) || OWNER_PLACEHOLDERS.has(ace.trustee.toUpperCase())) continue;
    if (!allowed.has(trusteeSid(ace.trustee, userSid).toUpperCase())) foreign.add(ace.trustee);
  }
  return foreign.size === 0 ? { ok: true } : { ok: false, reason: "acl-foreign", principals: [...foreign] };
}
function parseUserSid(whoami) {
  return /\bS-1-\d+(?:-\d+)+\b/.exec(whoami)?.[0] ?? null;
}
var ownerOnlyGrants = (userSid) => [userSid, SYSTEM_SID, ADMINISTRATORS_SID].map((sid) => `*${sid}:(OI)(CI)F`);
function makeOwnerOnlyDir(dir, userSid, exec) {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir);
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    return;
  }
  try {
    exec("icacls.exe", [dir, "/inheritance:r", "/grant:r", ...ownerOnlyGrants(userSid)]);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
var currentUserSid = (exec) => parseUserSid(exec("whoami.exe", ["/user", "/fo", "csv", "/nh"]));
var powershell = (exec, command, timeoutMs) => exec(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", command], timeoutMs);
var quotedForPowershell = (text) => `'${text.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;
function readSddls(dirs, exec) {
  const lines = powershell(exec, `(Get-Acl -LiteralPath ${dirs.map(quotedForPowershell).join(",")}).Sddl`).split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.length === dirs.length ? lines : null;
}
var runDirTrustDir = (env = process.env) => join2((env.LOCALAPPDATA ?? "").trim() || join2(homedir2(), "AppData", "Local"), "LangGuard", "arbiter-run-trust");
function secureWindowsRunDir(dir, exec, trustDir) {
  try {
    const userSid = currentUserSid(exec);
    if (userSid === null) return { ok: false, reason: "acl-unreadable", detail: "whoami gave no SID" };
    const dirs = trustDir === void 0 ? [dir] : [dir, trustDir];
    for (const each of dirs) makeOwnerOnlyDir(each, userSid, exec);
    const sddls = readSddls(dirs, exec);
    if (sddls === null) return { ok: false, reason: "acl-unreadable", detail: "Get-Acl did not give one SDDL for each directory" };
    for (const [index, sddl] of sddls.entries()) {
      const judged = judgeAcl(sddl, userSid);
      if (!judged.ok) return index === 0 ? judged : { ...judged, dir: dirs[index] };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "acl-unreadable", detail: String(err?.message ?? err) };
  }
}
function system32Exec(env = process.env) {
  const system32 = win32.join(env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows", "System32");
  return (file, args, timeoutMs = EXEC_TIMEOUT_MS) => execFileSync(win32.join(system32, file), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: timeoutMs });
}
function runDirTrustFile(runDir, env = process.env) {
  return join2(runDirTrustDir(env), `${createHash("sha256").update(runDir).digest("hex").slice(0, 32)}.json`);
}
function readRunDirTrust(runDir, env = process.env) {
  try {
    const record = JSON.parse(readFileSync(runDirTrustFile(runDir, env), "utf8"));
    return (record?.state === "ok" || record?.state === "failed") && Number.isFinite(record.checkedAt) ? record : null;
  } catch {
    return null;
  }
}
function writeRunDirTrust(runDir, state, { env = process.env, now = Date.now } = {}) {
  try {
    const file = runDirTrustFile(runDir, env);
    const temp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}`;
    writeFileSync(temp, JSON.stringify({ dir: runDir, state, checkedAt: now() }), { mode: 384 });
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}
function recordedRunDirCheck(runDir, env, now) {
  const trust = readRunDirTrust(runDir, env);
  if (trust?.state === "failed") return "failedUntilDaemonStart";
  const age = now() - (trust?.checkedAt ?? Number.NaN);
  return age >= 0 && age < RUN_DIR_TRUST_TTL_MS ? "passedThisHour" : "due";
}
function shimTrustsRunDir(runDir, { env = process.env, exec, now = Date.now }) {
  const recorded = recordedRunDirCheck(runDir, env, now);
  if (recorded !== "due") return recorded === "passedThisHour";
  const check = secureWindowsRunDir(runDir, exec, runDirTrustDir(env));
  if (check.ok || check.reason === "acl-foreign") writeRunDirTrust(runDir, check.ok ? "ok" : "failed", { env, now });
  return check.ok;
}
function loadOrCreateIpcKey(dir, deps = {}) {
  const run = ensureRunDir(dir, deps);
  if (!run.ok) return run;
  const path = join2(dir, "ipc-key");
  const temp = join2(dir, `.ipc-key.${process.pid}.${randomBytes(6).toString("hex")}`);
  try {
    const fd = openSync(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 384);
    try {
      writeSync(fd, `${randomBytes(32).toString("hex")}
`);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, path);
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  } catch {
  } finally {
    try {
      unlinkSync(temp);
    } catch {
    }
  }
  let key;
  try {
    const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    try {
      key = readFileSync(fd, "utf8").trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    return { ok: false, dir, reason: "key-unreadable" };
  }
  return KEY_RE.test(key) ? { ok: true, key, dir } : { ok: false, dir, reason: "key-malformed" };
}
function socketPath(env = process.env, port = 52746) {
  const explicit = (env.ARBITER_SOCKET ?? "").trim();
  if (explicit) return explicit;
  const primary = join2(runDirPath(env), port === 52746 ? "S.arbiter.sock" : `S.arbiter.${port}.sock`);
  if (Buffer.byteLength(primary) < SOCKET_PATH_LIMIT) return primary;
  const name = createHash("sha256").update(primary).digest("hex").slice(0, 12);
  return join2("/tmp", `arbiter-${process.geteuid?.() ?? 0}`, `S.${name}.sock`);
}
function ownerOnly(st, euid, isType) {
  return !st.isSymbolicLink() && isType(st) && st.uid === euid && (st.mode & 63) === 0;
}
function checkSocket(path, deps = {}) {
  const euid = (deps.geteuid ?? (() => process.geteuid?.() ?? -1))();
  const entry = (at) => {
    try {
      return lstatSync(at);
    } catch (err) {
      return err?.code === "ENOENT" ? "absent" : "untrusted";
    }
  };
  const dir = entry(dirname(path));
  if (typeof dir === "string") return dir;
  if (!ownerOnly(dir, euid, (st) => st.isDirectory())) return "untrusted";
  const sock = entry(path);
  if (typeof sock === "string") return sock;
  return ownerOnly(sock, euid, (st) => st.isSocket()) ? "ok" : "untrusted";
}
function deriveIpcKeys(key) {
  const master = Buffer.from(key, "hex");
  return {
    req: createHmac("sha256", master).update("arbiter-ipc-req-v1").digest(),
    resp: createHmac("sha256", master).update("arbiter-ipc-resp-v1").digest(),
    enc: Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), "arbiter-ipc-enc-v1", 32))
  };
}
var ivFor = (direction, nonce) => createHash("sha256").update(`arbiter-ipc-iv-v1
${direction}
${nonce}`).digest().subarray(0, 12);
var requestAad = ({ method, path, ts, nonce }) => Buffer.from(["req", method.toUpperCase(), path, ts, nonce].join("\n"));
var responseAad = ({ nonce, status }) => Buffer.from(["resp", nonce, String(status)].join("\n"));
function seal(keys, iv, aad, plain) {
  const cipher = createCipheriv("aes-256-gcm", keys.enc, iv);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(typeof plain === "string" ? Buffer.from(plain, "utf8") : plain), cipher.final(), cipher.getAuthTag()]);
}
function open(keys, iv, aad, sealed) {
  if (sealed.length < TAG_BYTES) return null;
  const split = sealed.length - TAG_BYTES;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keys.enc, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(split));
    return Buffer.concat([decipher.update(sealed.subarray(0, split)), decipher.final()]);
  } catch {
    return null;
  }
}
var sealRequestBody = (keys, bound, plain) => seal(keys, ivFor("req", bound.nonce), requestAad(bound), plain);
var openResponseBody = (keys, bound, sealed) => open(keys, ivFor("resp", bound.nonce), responseAad(bound), sealed);
var sha256Hex = (body) => createHash("sha256").update(body).digest("hex");
function requestMac(keys, { method, path, ts, nonce, body }) {
  const text = [method.toUpperCase(), path, ts, nonce, sha256Hex(body)].join("\n");
  return createHmac("sha256", keys.req).update(text).digest("hex");
}
function responseMac(keys, { nonce, status, body }) {
  const text = [nonce, String(status), sha256Hex(body)].join("\n");
  return createHmac("sha256", keys.resp).update(text).digest("hex");
}
function responseMacValid(keys, { nonce, status, body, mac }) {
  if (typeof mac !== "string" || !MAC_RE.test(mac)) return false;
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(responseMac(keys, { nonce, status, body }), "hex"));
}
function readEndpoint(runDir) {
  try {
    const path = join2(runDir, "daemon-endpoint.json");
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    if (process.platform !== "win32") {
      if (st.uid !== process.geteuid?.() || (st.mode & 18) !== 0) return null;
    }
    const endpoint = JSON.parse(readFileSync(path, "utf8"));
    return endpoint && typeof endpoint === "object" ? endpoint : null;
  } catch {
    return null;
  }
}
function isHeldExclusive(path) {
  try {
    closeSync(openSync(path, fsConstants.O_RDONLY));
    return false;
  } catch (err) {
    return err?.code !== "ENOENT";
  }
}
function classifyAttempt(attempt, context) {
  const result = classifyAnswer(attempt, context);
  if (result.kind === "VERIFIED" || context.daemonAlive === void 0) return result;
  if (context.daemonAlive()) {
    if (result.kind === "ABSENT") return { kind: "UNVERIFIED", reason: "unreachable" };
    return result.reason === "timeout" ? { kind: "UNVERIFIED", reason: "silent" } : result;
  }
  return result.kind === "ABSENT" ? result : { kind: "ABSENT", reason: "stale-endpoint" };
}
function classifyAnswer(attempt, context) {
  if ("code" in attempt) {
    if (attempt.code === "ETIMEDOUT") return { kind: "UNVERIFIED", reason: "timeout" };
    if (attempt.code === "ECONNRESET" || attempt.code === "EPIPE") return { kind: "UNVERIFIED", reason: "reset" };
    return { kind: "ABSENT", reason: String(attempt.code ?? "no connection") };
  }
  if (attempt.mac === void 0) return { kind: "UNVERIFIED", reason: "no-mac" };
  if (!responseMacValid(context.keys, { ...attempt, nonce: context.nonce })) return { kind: "UNVERIFIED", reason: "bad-mac" };
  const plain = openResponseBody(context.keys, { nonce: context.nonce, status: attempt.status }, attempt.body);
  if (plain === null) return { kind: "UNVERIFIED", reason: "bad-cipher" };
  if (attempt.status === 401 || attempt.status === 403) return { kind: "UNVERIFIED", reason: "refused" };
  return { kind: "VERIFIED", status: attempt.status, text: plain.toString("utf8") };
}
function sendOnce({ socket, method, path, body, headers, timeoutMs }) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), timeoutMs);
    const settle = (attempt) => {
      clearTimeout(timer);
      resolve(attempt);
    };
    const req = http.request(
      { socketPath: socket, path, method, headers: { "Content-Type": "application/octet-stream", "Content-Length": body.length, ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", (err) => settle({ code: err?.code ?? "ECONNRESET" }));
        res.on("end", () => {
          const mac = res.headers["x-arbiter-resp-mac"];
          settle({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), mac: typeof mac === "string" ? mac : void 0 });
        });
      }
    );
    req.on("error", (err) => settle({ code: err?.code ?? "ECONNRESET" }));
    req.end(body);
  });
}
function appendPostureEvent(runDir, event, deps = {}) {
  try {
    if (!ensureRunDir(runDir, deps).ok) return;
    const flags = fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | O_NOFOLLOW;
    const fd = openSync(join2(runDir, "posture.jsonl"), flags, 384);
    try {
      if (fstatSync(fd).size < POSTURE_LOG_LIMIT_BYTES) writeSync(fd, `${JSON.stringify(event)}
`);
    } finally {
      closeSync(fd);
    }
  } catch {
  }
}
async function callDaemon(options) {
  const body = Buffer.from(options.body ?? "", "utf8");
  if (body.length + TAG_BYTES > BODY_LIMIT_BYTES) return { kind: "UNVERIFIED", reason: "too-large" };
  const result = await exchange(options, body);
  if (result.kind === "UNVERIFIED") {
    appendPostureEvent(runDirPath(options.env ?? process.env), {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      event: "unverified",
      harness: options.harness,
      phase: options.phase,
      reason: result.reason
    }, { platform: options.platform });
  }
  return result;
}
async function exchange(options, body) {
  const env = options.env ?? process.env;
  const method = options.method ?? "POST";
  const runDir = runDirPath(env);
  const platform = options.platform ?? process.platform;
  const pipe = platform === "win32";
  const exec = options.exec ?? system32Exec(env);
  if (pipe && !shimTrustsRunDir(runDir, { env, exec, now: options.now })) return { kind: "UNVERIFIED", reason: "run-dir" };
  const loaded = loadOrCreateIpcKey(runDir, { platform });
  if (!loaded.ok) return { kind: "UNVERIFIED", reason: loaded.reason.startsWith("key") ? "key" : "run-dir" };
  const keys = deriveIpcKeys(loaded.key);
  const deadline = Date.now() + (options.budgetMs ?? 0);
  const daemonAlive = pipe ? options.daemonAlive ?? (() => isHeldExclusive(join2(runDir, ALIVE_FILE))) : void 0;
  let unverified = null;
  let absent = { kind: "ABSENT", reason: "no attempt" };
  for (let i = 0; i < RETRY_BACKOFFS_MS.length; i++) {
    if (i > 0) {
      if (Date.now() + RETRY_BACKOFFS_MS[i] >= deadline) break;
      await sleep(RETRY_BACKOFFS_MS[i]);
    }
    let socket;
    if (pipe) {
      const recorded = readEndpoint(runDir)?.pipe;
      socket = typeof recorded === "string" ? recorded : "";
    } else {
      socket = socketPath(env, options.port);
      const checked = checkSocket(socket);
      if (checked === "untrusted") return { kind: "UNVERIFIED", reason: "socket" };
      if (checked === "absent") {
        absent = { kind: "ABSENT", reason: "ENOENT" };
        continue;
      }
    }
    const timeoutMs = i === 0 ? options.timeoutMs : Math.min(options.timeoutMs, deadline - Date.now());
    const ts = String(Date.now());
    const nonce = randomBytes(16).toString("hex");
    const bound = { method, path: options.path, ts, nonce };
    const sealed = sealRequestBody(keys, bound, body);
    const headers = { "X-Arbiter-Ts": ts, "X-Arbiter-Nonce": nonce, "X-Arbiter-Mac": requestMac(keys, { ...bound, body: sealed }) };
    const attempt = socket === "" ? { code: "ENOENT" } : await sendOnce({ socket, method, path: options.path, body: sealed, headers, timeoutMs });
    const result = classifyAttempt(attempt, { keys, nonce, daemonAlive });
    if (result.kind === "VERIFIED") return result;
    if (result.kind === "ABSENT") absent = result;
    else if (RETRIED_REASONS.has(result.reason)) unverified = result;
    else return result;
  }
  return unverified ?? absent;
}
async function daemonAnswersSigned(options) {
  const result = await exchange({ ...options, method: "GET", path: "/health", budgetMs: 0 }, Buffer.alloc(0));
  return result.kind === "VERIFIED";
}
function unverifiedReason(result, _port, { advisory = false } = {}) {
  const endpoint = process.platform === "win32" ? "the Arbiter pipe" : "the Arbiter socket";
  const outcome = advisory ? "Nothing was added to the context. The call was not blocked." : "Blocked.";
  if (result.reason === "too-large") {
    return `LangGuard Arbiter: this hook input is larger than ${BODY_LIMIT_BYTES / 1024 / 1024} MiB, the limit of the Arbiter daemon. ${outcome}`;
  }
  if (result.reason === "unreachable" || result.reason === "silent") {
    return `LangGuard Arbiter: your Arbiter daemon runs and gives no answer. ${outcome} A daemon that gives no answer for 30 s is replaced at the next session start or prompt.`;
  }
  const cause = result.reason === "run-dir" || result.reason === "key" ? "the Arbiter run directory (~/.config/arbiter/run) is not a private directory of this user" : result.reason === "socket" ? "the Arbiter socket (~/.config/arbiter/run/S.arbiter.sock) or its directory is not private to this user" : `the process on ${endpoint} did not prove that it is your Arbiter daemon (${result.reason})`;
  return `LangGuard Arbiter: ${cause}. ${outcome} Close the program that holds ${endpoint} or fix the directory, then restart your editor.`;
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
function normalizeCommand(token) {
  const deescaped = token.startsWith("\\") ? token.slice(1) : token;
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

// arbiter-cursor/plugin/lib/quarantine.mjs
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2, renameSync as renameSync2, rmSync as rmSync2, mkdirSync as mkdirSync2, chmodSync } from "node:fs";
import { join as join3, dirname as dirname2 } from "node:path";
import { homedir as homedir3 } from "node:os";
import { createHash as createHash2, randomBytes as randomBytes2 } from "node:crypto";
var QUARANTINE_DEVICE_MESSAGE = "LangGuard: this agent is quarantined. Contact your administrator.";
var AI_APP_ID_REQUEST_HEADER = "x-langguard-ai-app-id";
var HARNESS_REQUEST_HEADER = "x-langguard-harness";
var USER_ID_REQUEST_HEADER = "x-langguard-user-id";
var SELF_CHECK_TIMEOUT_MS = 1500;
var CHECK_CACHE_MS = 1e4;
var REFUSAL_BACKOFF_MS = 10 * 6e4;
var REFUSAL_STATUSES = /* @__PURE__ */ new Set([401, 403, 404]);
var NO_TENANT_HOSTS = /* @__PURE__ */ new Set(["app.langguard.ai", "staging.app.langguard.ai", "dev.app.langguard.ai"]);
var MAX_ID_LENGTH = 128;
var LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);
function quarantineFile(env = process.env) {
  const v = typeof env.ARBITER_QUARANTINE_FILE === "string" ? env.ARBITER_QUARANTINE_FILE.trim() : "";
  return v || join3(homedir3(), ".config", "arbiter", "quarantine.json");
}
function quarantineCheckFile(env = process.env) {
  const v = typeof env.ARBITER_QUARANTINE_CHECK_FILE === "string" ? env.ARBITER_QUARANTINE_CHECK_FILE.trim() : "";
  return v || join3(homedir3(), ".config", "arbiter", "quarantine-check.json");
}
function quarantineRefusalFile(env = process.env) {
  const v = typeof env.ARBITER_QUARANTINE_REFUSAL_FILE === "string" ? env.ARBITER_QUARANTINE_REFUSAL_FILE.trim() : "";
  return v || join3(homedir3(), ".config", "arbiter", "quarantine-refusal.json");
}
function parseQuarantineField(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const id = value.id;
  if (typeof id !== "string" || !id.trim() || id.length > MAX_ID_LENGTH) return void 0;
  const exp = value.expiresAt === void 0 ? null : value.expiresAt;
  if (exp !== null && (typeof exp !== "string" || !exp || Number.isNaN(Date.parse(exp)))) return void 0;
  return { id: id.trim(), expiresAt: exp };
}
function isExpired(state, nowMs) {
  if (!state.expiresAt) return false;
  const t = Date.parse(state.expiresAt);
  return Number.isFinite(t) && t <= nowMs;
}
function writeAtomic(path, text) {
  mkdirSync2(dirname2(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${randomBytes2(4).toString("hex")}.tmp`;
  try {
    writeFileSync2(tmp, text, { mode: 384 });
    renameSync2(tmp, path);
  } finally {
    try {
      rmSync2(tmp, { force: true });
    } catch {
    }
  }
  try {
    chmodSync(path, 384);
  } catch {
  }
}
function deleteMarker(env = process.env) {
  try {
    rmSync2(quarantineFile(env), { force: true });
  } catch {
  }
}
function readActiveMarker(env = process.env, nowMs = Date.now()) {
  let raw;
  try {
    raw = readFileSync2(quarantineFile(env), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = void 0;
  }
  const state = parseQuarantineField(parsed);
  if (!state) return { id: "unknown", expiresAt: null, learnedAt: new Date(nowMs).toISOString() };
  if (isExpired(state, nowMs)) {
    deleteMarker(env);
    return null;
  }
  const learnedAt = typeof parsed.learnedAt === "string" ? parsed.learnedAt : new Date(nowMs).toISOString();
  return { ...state, learnedAt };
}
function writeMarker(state, env = process.env, nowMs = Date.now()) {
  try {
    writeAtomic(
      quarantineFile(env),
      `${JSON.stringify({ id: state.id, expiresAt: state.expiresAt, learnedAt: new Date(nowMs).toISOString() })}
`
    );
  } catch {
  }
}
function applyQuarantineAnswer(answer, env = process.env, nowMs = Date.now()) {
  if (answer === void 0) return;
  if (answer === null || isExpired(answer, nowMs)) {
    deleteMarker(env);
    return;
  }
  const current = readActiveMarker(env, nowMs);
  if (current && current.id === answer.id && current.expiresAt === answer.expiresAt) return;
  writeMarker(answer, env, nowMs);
}
function takeQuarantineField(text) {
  if (typeof text !== "string" || !text) return { answer: void 0, text };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { answer: void 0, text };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { answer: void 0, text };
  if (!Object.prototype.hasOwnProperty.call(parsed, "quarantine")) return { answer: void 0, text };
  const answer = parseQuarantineField(parsed.quarantine);
  delete parsed.quarantine;
  return { answer, text: JSON.stringify(parsed) };
}
function readCheck(env, nowMs) {
  try {
    const c = JSON.parse(readFileSync2(quarantineCheckFile(env), "utf8"));
    const t = Date.parse(c?.checkedAt);
    if (!Number.isFinite(t) || t > nowMs || nowMs - t >= CHECK_CACHE_MS) return null;
    return { quarantined: c.quarantined === true };
  } catch {
    return null;
  }
}
function writeCheck(env, nowMs, quarantined) {
  try {
    writeAtomic(
      quarantineCheckFile(env),
      `${JSON.stringify({ checkedAt: new Date(nowMs).toISOString(), quarantined })}
`
    );
  } catch {
  }
}
function refusalTarget(url, key) {
  return createHash2("sha256").update(`${url}
${key}`).digest("hex").slice(0, 32);
}
function isRefused(env, nowMs, target) {
  try {
    const r = JSON.parse(readFileSync2(quarantineRefusalFile(env), "utf8"));
    const t = Date.parse(r?.refusedAt);
    return r.target === target && Number.isFinite(t) && t <= nowMs && nowMs - t < REFUSAL_BACKOFF_MS;
  } catch {
    return false;
  }
}
function writeRefusal(env, nowMs, target, status) {
  try {
    writeAtomic(
      quarantineRefusalFile(env),
      `${JSON.stringify({ refusedAt: new Date(nowMs).toISOString(), status, target })}
`
    );
  } catch {
  }
}
function clearRefusal(env) {
  try {
    rmSync2(quarantineRefusalFile(env), { force: true });
  } catch {
  }
}
function headerValue(v) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  return t && t.length <= 256 && /^[\x20-\x7e]+$/.test(t) ? t : "";
}
function selfCheckHeaders({ aiAppId, harness, userId } = {}) {
  const out = {};
  const app = headerValue(aiAppId);
  const h = headerValue(harness).toLowerCase();
  const user = headerValue(userId);
  if (app) out[AI_APP_ID_REQUEST_HEADER] = app;
  if (h) out[HARNESS_REQUEST_HEADER] = h;
  if (user) out[USER_ID_REQUEST_HEADER] = user;
  return out;
}
function selfUrl(serverUrl) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return null;
  }
  if (NO_TENANT_HOSTS.has(url.hostname.replace(/\.$/, ""))) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}/api/arbiter/quarantine/self`;
}
async function checkSelfQuarantine({
  serverUrl,
  apiKey,
  aiAppId,
  harness,
  userId,
  env = process.env,
  now = Date.now,
  timeoutMs = SELF_CHECK_TIMEOUT_MS,
  cache = true
}) {
  const t0 = now();
  if (cache) {
    const cached = readCheck(env, t0);
    if (cached && !cached.quarantined) return { status: "none" };
  }
  const url = selfUrl(serverUrl ?? "");
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!url || !/^lgr_/.test(key) || typeof fetch !== "function") return { status: "unknown" };
  const target = refusalTarget(url, key);
  if (isRefused(env, t0, target)) return { status: "unknown" };
  let body;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...selfCheckHeaders({ aiAppId, harness, userId })
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (res.status !== 200) {
      if (REFUSAL_STATUSES.has(res.status)) writeRefusal(env, now(), target, res.status);
      return { status: "unknown" };
    }
    body = await res.json();
  } catch {
    return { status: "unknown" };
  }
  clearRefusal(env);
  const t1 = now();
  if (body && body.quarantined === false) {
    deleteMarker(env);
    writeCheck(env, t1, false);
    return { status: "none" };
  }
  if (body && body.quarantined === true) {
    const state = parseQuarantineField({ id: body.id, expiresAt: body.expiresAt ?? null });
    if (!state) return { status: "unknown" };
    if (isExpired(state, t1)) {
      deleteMarker(env);
      return { status: "none" };
    }
    applyQuarantineAnswer(state, env, t1);
    writeCheck(env, t1, true);
    return { status: "quarantined", state };
  }
  return { status: "unknown" };
}
async function recheckMarker({
  serverUrl,
  apiKey,
  aiAppId,
  harness,
  userId,
  env = process.env,
  now = Date.now
}) {
  const t0 = now();
  const cached = readCheck(env, t0);
  if (cached) {
    return true;
  }
  const r = await checkSelfQuarantine({
    serverUrl,
    apiKey,
    aiAppId,
    harness,
    userId,
    env,
    now,
    cache: false
  });
  if (r.status === "none") return false;
  if (r.status === "unknown") writeCheck(env, now(), true);
  return true;
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
  const path = process.env.ARBITER_GLOBAL_CONFIG ?? join4(homedir4(), ".config", "arbiter", "config.yaml");
  try {
    return readFileSync3(path, "utf8");
  } catch {
    return "";
  }
}
var configText = readGlobalConfigText();
var ENFORCEMENT_MODE = yamlScalar(configText, "enforcementMode") === "strict" || process.env.ARBITER_ENFORCE === "1" ? "strict" : "cooperative";
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
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
  return dirname3(dirname3(fileURLToPath(import.meta.url)));
}
function spawnDaemon() {
  const pluginRoot = resolvePluginRoot();
  const launch = join4(pluginRoot, "monitor", "launch.mjs");
  const child = spawn(process.execPath, [launch, "--data-dir", dataDir], {
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
function callLoopback(hookPhase, bodyRaw, timeoutMs, budgetMs = 0, posturePhase = hookPhase) {
  return callDaemon({
    host: HOST,
    port: PORT,
    path: `/hook/${hookPhase}`,
    body: bodyRaw,
    timeoutMs,
    budgetMs,
    dataDir,
    harness: "cursor",
    phase: posturePhase
  });
}
function readDaemonState() {
  try {
    return JSON.parse(readFileSync3(join4(dataDir, "daemon-state.json"), "utf8"));
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
var strictMarkerPath = () => join4(dataDir, ".arbiter-strict-firstcontact");
function strictAbsentGraceExpired(now) {
  try {
    const first = Number(readFileSync3(strictMarkerPath(), "utf8").trim());
    if (Number.isFinite(first)) return now - first > STARTUP_GRACE_MS;
  } catch {
  }
  try {
    writeFileSync3(strictMarkerPath(), String(now));
  } catch {
  }
  return false;
}
function clearStrictMarker() {
  try {
    rmSync3(strictMarkerPath(), { force: true });
  } catch {
  }
}
async function maybeSpawnDaemonPrimary() {
  if (await daemonAnswersSigned({ host: HOST, port: PORT, timeoutMs: PORT_PROBE_TIMEOUT_MS })) return;
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
  const res = await callLoopback(hookPhase, JSON.stringify(translated.ccBody), ADVISORY_TIMEOUT_MS);
  if (MODE_TABLE.advisory[res.kind] === "relay" && res.status >= 200 && res.status < 300) {
    const q = handleReplyQuarantine(res.text);
    if (q.blocked) return;
    if (!q.text) {
      exitWith(0);
      return;
    }
    let daemonResponse;
    try {
      daemonResponse = JSON.parse(q.text);
    } catch {
      exitWith(0);
      return;
    }
    if (hookPhase === "screen") emit(shapeScreenOutput(daemonResponse));
    else if (hookPhase === "evidence") emit(shapeEvidenceOutput(daemonResponse));
    else emit(shapeVerifyOutput(daemonResponse));
    return;
  }
  if (res.kind === "UNVERIFIED") warn(`${hookPhase}: ${unverifiedReason(res, PORT, { advisory: true })}`);
  if (await quarantineFallback()) return;
  exitWith(0);
}
function relayEnforceResponse(res) {
  clearStrictMarker();
  const q = handleReplyQuarantine(res.text);
  if (q.blocked) return;
  let daemonResponse;
  try {
    daemonResponse = JSON.parse(q.text);
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
  const res = await callLoopback(
    "enforce",
    JSON.stringify(translated.ccBody),
    ENFORCE_ATTEMPT_TIMEOUT_MS,
    ENFORCE_RETRY_BUDGET_MS
  );
  const action = MODE_TABLE.enforce[res.kind];
  if (action === "block") {
    emit(enforceDenyOutput(unverifiedReason(res, PORT)));
    return;
  }
  if (action === "grace") {
    if (await quarantineFallback()) return;
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
  if (await quarantineFallback()) return;
  warn(`enforce: daemon reachable but returned HTTP ${res.status} \u2014 failing OPEN.`);
  exitWith(0);
}
async function handleEnforceShell(translated) {
  const command = translated.ccBody?.tool_input?.command ?? "";
  const bodyRaw = JSON.stringify(translated.ccBody);
  if (isCatastrophicShellMatch(command, DEFAULT_CATASTROPHIC_DENY_LIST)) {
    const reason = "LangGuard Arbiter: this shell command matches the catastrophic deny-list \u2014 blocked by the offline backstop (no daemon required).";
    await Promise.race([
      callLoopback("enforce", bodyRaw, CATASTROPHIC_AUDIT_TIMEOUT_MS, 0, "shell"),
      sleep2(CATASTROPHIC_AUDIT_TIMEOUT_MS)
    ]);
    emit(catastrophicDenyOutput(reason));
    return;
  }
  const res = await callLoopback("enforce", bodyRaw, ENFORCE_ATTEMPT_TIMEOUT_MS, ENFORCE_RETRY_BUDGET_MS, "shell");
  if (MODE_TABLE.enforce[res.kind] === "block") {
    emit(enforceDenyOutput(unverifiedReason(res, PORT)));
    return;
  }
  if (res.kind === "ABSENT") {
    armKickerFromGrace();
    if (await quarantineFallback()) return;
    warn("enforce (shell audit): daemon unreachable \u2014 failing OPEN (offline catastrophic backstop already ran).");
    exitWith(0);
    return;
  }
  if (res.status >= 200 && res.status < 300) {
    relayEnforceResponse(res);
    return;
  }
  if (await quarantineFallback()) return;
  warn(`enforce (shell audit): daemon reachable but returned HTTP ${res.status} \u2014 failing OPEN.`);
  exitWith(0);
}
var REMOTE_SAAS_HOST = process.env.LANGGUARD_HOST ?? yamlScalar(configText, "host") ?? "https://app.langguard.ai";
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
  return (process.env.LANGGUARD_API_KEY ?? yamlScalar(configText, "apiKey") ?? "").trim();
}
var REMOTE_ENFORCE_ATTEMPT_TIMEOUT_MS = 2500;
var REMOTE_ENFORCE_BUDGET_MS = 5e3;
var REMOTE_ADVISORY_TIMEOUT_MS = 1500;
async function postHookRemote(hookPhase, bodyRaw, timeoutMs, bearer) {
  const transport = REMOTE.isHttps ? (await import("node:https")).default : http2;
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
    if (backoffs[i] > 0) await sleep2(backoffs[i]);
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
    emit(enforceDenyOutput(`LangGuard Arbiter: ${reason} \u2014 BLOCKING (strict mode, fail-CLOSED).`));
  } else {
    warn(`enforce (remote): ${reason} \u2014 failing OPEN (cooperative).`);
    exitWith(0);
  }
}
function relayEnforceResponseRemote(res) {
  const q = handleReplyQuarantine(res.text);
  if (q.blocked) return;
  let daemonResponse;
  try {
    daemonResponse = JSON.parse(q.text);
  } catch {
    emit(enforceDenyOutput("Arbiter cloud daemon returned an unparseable enforce response \u2014 failing CLOSED."));
    return;
  }
  emit(shapeEnforceOutput(daemonResponse));
}
function maybeWarnHostCollision() {
  try {
    const saasHost = new URL(REMOTE_SAAS_HOST).hostname;
    if (saasHost && stripBrackets(REMOTE.host) === stripBrackets(saasHost)) {
      warn("Arbiter: daemonUrl points at your LangGuard host, not an Arbiter daemon \u2014 hooks will 404");
    }
  } catch {
  }
}
async function handleEnforceRemote(translated) {
  if (translated.cursorEvent === "beforeShellExecution") {
    const command = translated.ccBody?.tool_input?.command ?? "";
    if (isCatastrophicShellMatch(command, DEFAULT_CATASTROPHIC_DENY_LIST)) {
      emit(catastrophicDenyOutput(
        "LangGuard Arbiter: this shell command matches the catastrophic deny-list \u2014 blocked by the offline backstop (no daemon required)."
      ));
      return;
    }
  }
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
    res = await postHookRemoteWithRetry(
      "enforce",
      JSON.stringify(translated.ccBody),
      REMOTE_ENFORCE_BUDGET_MS,
      credential
    );
  } catch (err) {
    if (await quarantineFallback()) return;
    remoteEnforceFail(
      `cloud daemon ${REMOTE.raw} unreachable (${err?.code ?? "network error"}) \u2014 coverage gap`
    );
    return;
  }
  if (res.status >= 200 && res.status < 300) {
    relayEnforceResponseRemote(res);
    return;
  }
  if (await quarantineFallback()) return;
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
async function handleAdvisoryRemote(hookPhase, translated) {
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
    const res = await postHookRemote(
      hookPhase,
      JSON.stringify(translated.ccBody),
      REMOTE_ADVISORY_TIMEOUT_MS,
      credential
    );
    if (res.status >= 200 && res.status < 300) {
      const q = handleReplyQuarantine(res.text);
      if (q.blocked) return;
      if (!q.text) {
        exitWith(0);
        return;
      }
      let daemonResponse;
      try {
        daemonResponse = JSON.parse(q.text);
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
  if (await quarantineFallback()) return;
  exitWith(0);
}
async function mainRemote(translated) {
  if (phase === "enforce") {
    await handleEnforceRemote(translated);
    return;
  }
  await handleAdvisoryRemote(phase, translated);
}
function quarantineUserId() {
  if (REMOTE) return void 0;
  const v = (process.env.ARBITER_USER_ID ?? "").trim();
  return v || void 0;
}
function quarantineCheckArgs() {
  const aiAppId = (process.env.ARBITER_AI_APP_ID ?? "").trim();
  const userId = quarantineUserId();
  return {
    serverUrl: REMOTE_SAAS_HOST,
    // the SaaS host, never the daemonUrl
    apiKey: resolveRemoteCredential(),
    // lgr_ key: off-machine only, never over loopback
    harness: "cursor",
    ...aiAppId ? { aiAppId } : {},
    ...userId ? { userId } : {}
  };
}
function quarantineBlockOutput() {
  if (phase === "prompt") {
    return {
      stdout: JSON.stringify({ continue: false, user_message: QUARANTINE_DEVICE_MESSAGE }),
      stderr: QUARANTINE_DEVICE_MESSAGE,
      exitCode: 2
    };
  }
  if (phase === "screen") {
    return {
      stdout: JSON.stringify({ additional_context: QUARANTINE_DEVICE_MESSAGE }),
      stderr: QUARANTINE_DEVICE_MESSAGE,
      exitCode: 0
    };
  }
  return enforceDenyOutput(QUARANTINE_DEVICE_MESSAGE);
}
function blockQuarantined() {
  emit(quarantineBlockOutput());
}
async function quarantineGate() {
  if (!readActiveMarker()) return false;
  if (phase === "screen" && !REMOTE) {
    try {
      await maybeSpawnDaemonPrimary();
    } catch {
    }
  }
  if (!await recheckMarker(quarantineCheckArgs())) return false;
  blockQuarantined();
  return true;
}
async function quarantineFallback() {
  if (phase !== "enforce" && phase !== "screen") return false;
  const r = await checkSelfQuarantine(quarantineCheckArgs());
  if (r.status !== "quarantined") return false;
  blockQuarantined();
  return true;
}
function handleReplyQuarantine(text) {
  const { answer, text: clean } = takeQuarantineField(text);
  if (answer && (phase === "enforce" || phase === "screen")) {
    blockQuarantined();
    return { blocked: true, text: clean };
  }
  return { blocked: false, text: clean };
}
async function main() {
  const raw = await readStdin();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = void 0;
  }
  if (phase === "prompt" || phase === "pretool") {
    if (await quarantineGate()) return;
    if (phase === "prompt") exitWith(0, JSON.stringify({ continue: true }));
    else emitPassive();
    return;
  }
  if ((phase === "enforce" || phase === "screen") && await quarantineGate()) return;
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
  if (REMOTE) {
    await mainRemote(translated);
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
