import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// arbiter-codex/plugin/bin/hook.mjs
import http2 from "node:http";
import { spawn } from "node:child_process";
import { readFileSync as readFileSync3, writeFileSync as writeFileSync3, rmSync as rmSync3 } from "node:fs";
import { join as join4 } from "node:path";
import { homedir as homedir4 } from "node:os";

// arbiter-codex/plugin/lib/daemon-paths.mjs
import { join } from "node:path";
import { homedir } from "node:os";
function resolveDataDir(env = process.env) {
  const fromEnv = typeof env.PLUGIN_DATA === "string" ? env.PLUGIN_DATA.trim() : "";
  if (fromEnv) return fromEnv;
  return join(homedir(), ".config", "arbiter");
}

// arbiter-codex/plugin/lib/quarantine.mjs
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { join as join2, dirname } from "node:path";
import { homedir as homedir2 } from "node:os";
import { createHash, randomBytes } from "node:crypto";
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
  return v || join2(homedir2(), ".config", "arbiter", "quarantine.json");
}
function quarantineCheckFile(env = process.env) {
  const v = typeof env.ARBITER_QUARANTINE_CHECK_FILE === "string" ? env.ARBITER_QUARANTINE_CHECK_FILE.trim() : "";
  return v || join2(homedir2(), ".config", "arbiter", "quarantine-check.json");
}
function quarantineRefusalFile(env = process.env) {
  const v = typeof env.ARBITER_QUARANTINE_REFUSAL_FILE === "string" ? env.ARBITER_QUARANTINE_REFUSAL_FILE.trim() : "";
  return v || join2(homedir2(), ".config", "arbiter", "quarantine-refusal.json");
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
  mkdirSync(dirname(path), { recursive: true, mode: 448 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 384 });
    renameSync(tmp, path);
  } finally {
    try {
      rmSync(tmp, { force: true });
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
    rmSync(quarantineFile(env), { force: true });
  } catch {
  }
}
function readActiveMarker(env = process.env, nowMs = Date.now()) {
  let raw;
  try {
    raw = readFileSync(quarantineFile(env), "utf8");
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
    const c = JSON.parse(readFileSync(quarantineCheckFile(env), "utf8"));
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
  return createHash("sha256").update(`${url}
${key}`).digest("hex").slice(0, 32);
}
function isRefused(env, nowMs, target) {
  try {
    const r = JSON.parse(readFileSync(quarantineRefusalFile(env), "utf8"));
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
    rmSync(quarantineRefusalFile(env), { force: true });
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

// arbiter-codex/plugin/lib/ipc-auth.mjs
import http from "node:http";
import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash as createHash2, createHmac, hkdfSync, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync as mkdirSync2,
  openSync,
  readFileSync as readFileSync2,
  renameSync as renameSync2,
  rmSync as rmSync2,
  unlinkSync,
  writeFileSync as writeFileSync2,
  writeSync
} from "node:fs";
import { dirname as dirname2, join as join3, win32 } from "node:path";
import { homedir as homedir3 } from "node:os";
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
  return join3(bearerFile ? dirname2(bearerFile) : join3(homedir3(), ".config", "arbiter"), "run");
}
function ensureRunDir(dir, deps = {}) {
  const windows = (deps.platform ?? process.platform) === "win32";
  try {
    if (!windows) {
      mkdirSync2(dirname2(dir), { recursive: true });
      try {
        mkdirSync2(dir, { mode: 448 });
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
  mkdirSync2(dirname2(dir), { recursive: true });
  try {
    mkdirSync2(dir);
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    return;
  }
  try {
    exec("icacls.exe", [dir, "/inheritance:r", "/grant:r", ...ownerOnlyGrants(userSid)]);
  } catch (err) {
    rmSync2(dir, { recursive: true, force: true });
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
var runDirTrustDir = (env = process.env) => join3((env.LOCALAPPDATA ?? "").trim() || join3(homedir3(), "AppData", "Local"), "LangGuard", "arbiter-run-trust");
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
  return join3(runDirTrustDir(env), `${createHash2("sha256").update(runDir).digest("hex").slice(0, 32)}.json`);
}
function readRunDirTrust(runDir, env = process.env) {
  try {
    const record = JSON.parse(readFileSync2(runDirTrustFile(runDir, env), "utf8"));
    return (record?.state === "ok" || record?.state === "failed") && Number.isFinite(record.checkedAt) ? record : null;
  } catch {
    return null;
  }
}
function writeRunDirTrust(runDir, state, { env = process.env, now = Date.now } = {}) {
  try {
    const file = runDirTrustFile(runDir, env);
    const temp = `${file}.${process.pid}.${randomBytes2(6).toString("hex")}`;
    writeFileSync2(temp, JSON.stringify({ dir: runDir, state, checkedAt: now() }), { mode: 384 });
    renameSync2(temp, file);
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
  const path = join3(dir, "ipc-key");
  const temp = join3(dir, `.ipc-key.${process.pid}.${randomBytes2(6).toString("hex")}`);
  try {
    const fd = openSync(temp, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 384);
    try {
      writeSync(fd, `${randomBytes2(32).toString("hex")}
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
      key = readFileSync2(fd, "utf8").trim();
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
  const primary = join3(runDirPath(env), port === 52746 ? "S.arbiter.sock" : `S.arbiter.${port}.sock`);
  if (Buffer.byteLength(primary) < SOCKET_PATH_LIMIT) return primary;
  const name = createHash2("sha256").update(primary).digest("hex").slice(0, 12);
  return join3("/tmp", `arbiter-${process.geteuid?.() ?? 0}`, `S.${name}.sock`);
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
  const dir = entry(dirname2(path));
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
var ivFor = (direction, nonce) => createHash2("sha256").update(`arbiter-ipc-iv-v1
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
var sha256Hex = (body) => createHash2("sha256").update(body).digest("hex");
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
    const path = join3(runDir, "daemon-endpoint.json");
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    if (process.platform !== "win32") {
      if (st.uid !== process.geteuid?.() || (st.mode & 18) !== 0) return null;
    }
    const endpoint = JSON.parse(readFileSync2(path, "utf8"));
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
    const fd = openSync(join3(runDir, "posture.jsonl"), flags, 384);
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
  const daemonAlive = pipe ? options.daemonAlive ?? (() => isHeldExclusive(join3(runDir, ALIVE_FILE))) : void 0;
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
    const nonce = randomBytes2(16).toString("hex");
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
var ENFORCEMENT_MODE = yamlScalar(configText, "enforcementMode") === "strict" || process.env.ARBITER_CODEX_ENFORCE === "1" ? "strict" : "cooperative";
var sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
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
function callLoopback(hookPhase, bodyRaw, timeoutMs, budgetMs = 0) {
  return callDaemon({
    host: HOST,
    port: PORT,
    path: `/hook/${hookPhase}`,
    body: bodyRaw,
    timeoutMs,
    budgetMs,
    dataDir,
    harness: "codex",
    phase: hookPhase
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
async function maybeSpawnDaemonFallback(bodyRaw) {
  let event;
  try {
    event = JSON.parse(bodyRaw)?.hook_event_name;
  } catch {
  }
  if (event !== "SessionStart" && event !== "UserPromptSubmit") return;
  const pluginRoot = process.env.PLUGIN_ROOT;
  if (!pluginRoot) return;
  if (await daemonAnswersSigned({ host: HOST, port: PORT, timeoutMs: PORT_PROBE_TIMEOUT_MS })) return;
  const launch = join4(pluginRoot, "monitor", "launch.mjs");
  try {
    const child = spawn(
      process.execPath,
      [launch, "--data-dir", dataDir],
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
  const res = await callLoopback(hookPhase, bodyRaw, ADVISORY_TIMEOUT_MS);
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
    emit(hookPhase === "screen" ? shapeScreenResult(daemonResponse) : shapeBlockableResult(daemonResponse));
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
  const res = await callLoopback("enforce", bodyRaw, ENFORCE_ATTEMPT_TIMEOUT_MS, ENFORCE_RETRY_BUDGET_MS);
  const action = MODE_TABLE.enforce[res.kind];
  if (action === "block") {
    emit(enforceDenyResult(unverifiedReason(res, PORT)));
    return;
  }
  if (action === "grace") {
    if (await quarantineFallback()) return;
    failEnforceViaGraceTable("Arbiter daemon unavailable");
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
    emit(enforceDenyResult(`LangGuard Arbiter: ${reason} \u2014 BLOCKING (strict mode, fail-CLOSED).`));
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
    emit(enforceDenyResult("Arbiter cloud daemon returned an unparseable enforce response \u2014 failing CLOSED."));
    return;
  }
  emit(shapeEnforceResult(daemonResponse));
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
      emit(hookPhase === "screen" ? shapeScreenResult(daemonResponse) : shapeBlockableResult(daemonResponse));
      return;
    }
  } catch {
  }
  if (await quarantineFallback()) return;
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
var hookBody = "";
function hookEventName() {
  try {
    const v = JSON.parse(hookBody)?.hook_event_name;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}
function isNativeToolCall() {
  try {
    const name = JSON.parse(hookBody)?.tool_name;
    return typeof name === "string" && !name.startsWith("mcp__");
  } catch {
    return false;
  }
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
    harness: "codex",
    ...aiAppId ? { aiAppId } : {},
    ...userId ? { userId } : {}
  };
}
function blockQuarantined() {
  if (phase === "enforce") {
    emit(enforceDenyResult(QUARANTINE_DEVICE_MESSAGE));
    return;
  }
  if (hookEventName() === "SessionStart") {
    warn(QUARANTINE_DEVICE_MESSAGE);
    exitWith(
      0,
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: QUARANTINE_DEVICE_MESSAGE }
      })
    );
    return;
  }
  emit({
    stdout: JSON.stringify({ decision: "block", reason: QUARANTINE_DEVICE_MESSAGE }),
    stderr: QUARANTINE_DEVICE_MESSAGE,
    exitCode: 2
  });
}
async function quarantineGate() {
  if (!readActiveMarker()) return false;
  if (phase === "screen" && !REMOTE) {
    try {
      await maybeSpawnDaemonFallback(hookBody);
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
  const bodyRaw = stampHarness(await readStdin());
  hookBody = bodyRaw;
  if (phase === "enforce" || phase === "screen") {
    if (await quarantineGate()) return;
    if (phase === "enforce" && isNativeToolCall()) {
      exitWith(0);
      return;
    }
  }
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
