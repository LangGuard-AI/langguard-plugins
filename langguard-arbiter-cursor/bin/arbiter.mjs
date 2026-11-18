import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);

// arbiter-cursor/plugin/bin/arbiter.mjs
import { fileURLToPath } from "node:url";

// arbiter-core/src/service/cli.ts
import { spawnSync } from "node:child_process";
import { homedir as homedir2 } from "node:os";
import { parseArgs } from "node:util";

// arbiter-core/src/daemon/ipc-mac.ts
import { dirname, join } from "node:path";
import { homedir } from "node:os";
function runDirPath(env = process.env) {
  const explicit = (env["ARBITER_RUN_DIR"] ?? "").trim();
  if (explicit) return explicit;
  const bearerFile = (env["ARBITER_BEARER_FILE"] ?? "").trim();
  return join(bearerFile ? dirname(bearerFile) : join(homedir(), ".config", "arbiter"), "run");
}

// arbiter-core/src/daemon/ipc-pipe.ts
import { lstatSync as lstatSync2, mkdtempSync, readFileSync as readFileSync2, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// arbiter-core/plugin-lib/ipc-auth.mjs
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
var MODE_TABLE = Object.freeze({
  enforce: Object.freeze({ VERIFIED: "relay", UNVERIFIED: "block", ABSENT: "grace" }),
  advisory: Object.freeze({ VERIFIED: "relay", UNVERIFIED: "nothing", ABSENT: "nothing" })
});
var BODY_LIMIT_BYTES = 4 * 1024 * 1024;
var POSTURE_LOG_LIMIT_BYTES = 1024 * 1024;
var RUN_DIR_TRUST_TTL_MS = 60 * 60 * 1e3;
var O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
var SDDL_TRUSTEE = "S-1-[0-9-]+|[A-Z]{2}";
var SDDL_RE = new RegExp(`^O:(${SDDL_TRUSTEE})(?:G:(?:${SDDL_TRUSTEE}))?D:([A-Z_]*)(.*)$`);

// arbiter-core/src/daemon/ipc-pipe.ts
var ENDPOINT_FILE = "daemon-endpoint.json";
var endpointPath = (runDir) => join2(runDir, ENDPOINT_FILE);
function ownerOnlyText(path) {
  try {
    const st = lstatSync2(path);
    if (!st.isFile()) return null;
    if (process.platform !== "win32" && (st.uid !== process.geteuid?.() || (st.mode & 18) !== 0)) return null;
    return readFileSync2(path, "utf8");
  } catch {
    return null;
  }
}
function readEndpoint(runDir) {
  try {
    const parsed = JSON.parse(ownerOnlyText(endpointPath(runDir)) ?? "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
var TAKEOVER_PROBES = 3;
var TAKEOVER_PROBE_INTERVAL_MS = 15e3;
var TAKEOVER_SILENCE_MS = TAKEOVER_PROBE_INTERVAL_MS * (TAKEOVER_PROBES - 1);

// arbiter-core/src/daemon/ipc-socket.ts
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { dirname as dirname2, join as join3 } from "node:path";
var SOCKET_PATH_LIMIT = 100;
var PROBE_MS = 300;
var DEFAULT_DAEMON_PORT = 52746;
function resolveSocketPath(env = process.env, runDir = runDirPath(env), port = DEFAULT_DAEMON_PORT) {
  const explicit = (env["ARBITER_SOCKET"] ?? "").trim();
  if (explicit) return explicit;
  const primary = join3(runDir, port === DEFAULT_DAEMON_PORT ? "S.arbiter.sock" : `S.arbiter.${port}.sock`);
  if (Buffer.byteLength(primary) < SOCKET_PATH_LIMIT) return primary;
  const name = createHash("sha256").update(primary).digest("hex").slice(0, 12);
  return join3("/tmp", `arbiter-${process.geteuid?.() ?? 0}`, `S.${name}.sock`);
}
function socketAnswers(path, timeoutMs = PROBE_MS) {
  return new Promise((resolve) => {
    const sock = connect({ path });
    const settle = (live) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => settle(true), timeoutMs);
    sock.once("connect", () => settle(true));
    sock.once("error", () => settle(false));
  });
}

// arbiter-core/src/service/install.ts
import { lstatSync as lstatSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, readdirSync, renameSync as renameSync3, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";

// arbiter-core/src/service/units.ts
import { createHash as createHash2 } from "node:crypto";
var SERVICE_LABEL = "ai.langguard.arbiterd";
var SYSTEMD_SOCKET_UNIT = "arbiterd.socket";
var SYSTEMD_SERVICE_UNIT = "arbiterd.service";
var WINDOWS_TASK_NAME = "LangGuard\\Arbiter";
var VERSION_FILES = ["monitor/launch.mjs", "opa/opa-checksums.json", "opa/system-authz.rego"];
function versionOf(manifest) {
  const text = Object.keys(manifest.files).sort().map((rel) => `${rel}
${manifest.files[rel]}
`).join("");
  return createHash2("sha256").update(text).digest("hex").slice(0, 16);
}
var sha256Hex = (bytes) => createHash2("sha256").update(bytes).digest("hex");
function plainPath(path, what) {
  if (/[\r\n"\0]/.test(path)) throw new Error(`${what} has a character that a unit file cannot hold: ${JSON.stringify(path)}`);
  return path;
}
var xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
var systemd = (text) => text.replace(/%/g, "%%");
function renderEntry(spec) {
  return `// arbiterd.mjs: the LangGuard Arbiter daemon that \`arbiter install\` set up. Do not edit:
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DATA_DIR = ${JSON.stringify(spec.dataDir)};
const root = dirname(fileURLToPath(import.meta.url));
const refuse = (why) => {
  process.stderr.write(\`[arbiterd] \${new Date().toISOString()} not started: \${why}\\n\`);
  process.exit(0);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

let version = '';
try {
  version = readFileSync(join(root, 'current'), 'utf8').trim();
} catch {
  refuse('no current version');
}
if (!/^[0-9a-f]{16}$/.test(version)) refuse('current names no version');
const dir = join(root, 'versions', version);
let files = {};
try {
  files = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).files ?? {};
} catch {
  refuse(\`version \${version} has no manifest\`);
}
const listed = Object.keys(files).sort();
if (sha(listed.map((rel) => \`\${rel}\\n\${files[rel]}\\n\`).join('')).slice(0, 16) !== version) refuse(\`the manifest of \${version} is not the manifest of that version\`);
for (const rel of listed) {
  let got = '';
  try {
    got = sha(readFileSync(join(dir, rel)));
  } catch {
    /* a missing file does not match */
  }
  if (got !== files[rel]) refuse(\`\${rel} of \${version} does not match its sha256\`);
}
process.argv.splice(2, process.argv.length - 2, '--data-dir', DATA_DIR);
await import(pathToFileURL(join(dir, 'monitor', 'launch.mjs')).href);
`;
}
function renderLaunchAgent(spec) {
  const program = [plainPath(spec.nodePath, "node"), plainPath(spec.entry, "the entry")];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(spec.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}
function renderSystemdSocket(spec) {
  if (!spec.socketPath) throw new Error("a systemd socket unit needs the socket path");
  if (/\s/.test(spec.socketPath)) throw new Error(`ListenStream cannot hold a path with white space: ${JSON.stringify(spec.socketPath)}`);
  return `[Unit]
Description=LangGuard Arbiter daemon socket

[Socket]
ListenStream=${systemd(plainPath(spec.socketPath, "the socket path"))}
SocketMode=0600
DirectoryMode=0700

[Install]
WantedBy=sockets.target
`;
}
function renderSystemdService(spec) {
  const quote = (arg) => `"${systemd(plainPath(arg, "an ExecStart argument"))}"`;
  return `[Unit]
Description=LangGuard Arbiter daemon
Requires=${SYSTEMD_SOCKET_UNIT}
After=${SYSTEMD_SOCKET_UNIT}

[Service]
Type=simple
ExecStart=${quote(spec.nodePath)} ${quote(spec.entry)}
Restart=on-failure
RestartSec=2
StandardOutput=append:${systemd(plainPath(spec.log, "the log"))}
StandardError=append:${systemd(plainPath(spec.log, "the log"))}
`;
}
function renderScheduledTask(spec) {
  if (!spec.userId) throw new Error("a Scheduled Task needs the user id (DOMAIN\\user)");
  const user = xml(spec.userId);
  const triggers = [
    ...spec.atBoot ? ["    <BootTrigger>\n      <Enabled>true</Enabled>\n    </BootTrigger>"] : [],
    `    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>`
  ];
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>LangGuard Arbiter daemon (arbiter install)</Description>
  </RegistrationInfo>
  <Triggers>
${triggers.join("\n")}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>${spec.atBoot ? "S4U" : "InteractiveToken"}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>255</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(plainPath(spec.nodePath, "node"))}</Command>
      <Arguments>"${xml(plainPath(spec.entry, "the entry"))}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
function utf16le(text) {
  return Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, "utf16le")]);
}

// arbiter-core/src/service/install.ts
function serviceRoot(os, home, env) {
  if (os === "darwin") return join4(home, "Library", "Application Support", "LangGuard", "Arbiter");
  if (os === "win32") return join4(env["LOCALAPPDATA"] || join4(home, "AppData", "Local"), "LangGuard", "Arbiter");
  return join4(env["XDG_DATA_HOME"] || join4(home, ".local", "share"), "arbiter");
}
function unitDir(ctx) {
  if (ctx.os === "darwin") return join4(ctx.home, "Library", "LaunchAgents");
  if (ctx.os === "linux") return join4(ctx.env["XDG_CONFIG_HOME"] || join4(ctx.home, ".config"), "systemd", "user");
  return serviceRoot(ctx.os, ctx.home, ctx.env);
}
function windowsUser(env) {
  const user = env["USERNAME"] ?? "";
  if (!user) throw new Error("USERNAME is not set: cannot name the task principal");
  return env["USERDOMAIN"] ? `${env["USERDOMAIN"]}\\${user}` : user;
}
function serviceSpec(ctx, atBoot) {
  if (atBoot && ctx.os !== "win32") throw new Error("--at-boot is for Windows only: macOS and Linux start the daemon at login");
  const root = serviceRoot(ctx.os, ctx.home, ctx.env);
  return {
    os: ctx.os,
    nodePath: ctx.nodePath,
    root,
    dataDir: ctx.dataDir,
    ...ctx.socketPath ? { socketPath: ctx.socketPath } : {},
    atBoot,
    ...ctx.os === "win32" ? { userId: windowsUser(ctx.env) } : {},
    entry: join4(root, "arbiterd.mjs"),
    log: join4(root, "arbiterd.log")
  };
}
function serviceLayout(ctx, spec) {
  const dir = unitDir(ctx);
  const units = ctx.os === "darwin" ? [{ path: join4(dir, `${SERVICE_LABEL}.plist`), bytes: Buffer.from(renderLaunchAgent(spec)) }] : ctx.os === "linux" ? [
    { path: join4(dir, SYSTEMD_SOCKET_UNIT), bytes: Buffer.from(renderSystemdSocket(spec)) },
    { path: join4(dir, SYSTEMD_SERVICE_UNIT), bytes: Buffer.from(renderSystemdService(spec)) }
  ] : [{ path: join4(dir, "arbiterd-task.xml"), bytes: utf16le(renderScheduledTask(spec)) }];
  return { root: spec.root, versions: join4(spec.root, "versions"), current: join4(spec.root, "current"), entry: spec.entry, log: spec.log, units };
}
function supervisor(ctx, layout) {
  const run = (argv) => ctx.io.exec(argv);
  if (ctx.os === "darwin") {
    const domain = `gui/${ctx.uid ?? process.getuid?.() ?? 0}`;
    const target = `${domain}/${SERVICE_LABEL}`;
    const plist = layout.units[0]?.path ?? "";
    return {
      loaded: () => run(["launchctl", "print", target]).code === 0,
      load: () => ({ argv: [["launchctl", "bootstrap", domain, plist]] }),
      // kickstart does not read the plist again: a changed plist needs bootout + bootstrap.
      reload: (unitsChanged) => unitsChanged ? [["launchctl", "bootout", target], ["launchctl", "bootstrap", domain, plist]] : [["launchctl", "kickstart", "-k", target]],
      unload: () => [["launchctl", "bootout", target]],
      forget: () => []
    };
  }
  if (ctx.os === "linux") {
    const user = (...args) => ["systemctl", "--user", ...args];
    return {
      loaded: () => run(user("is-enabled", SYSTEMD_SOCKET_UNIT)).code === 0 && run(user("is-active", SYSTEMD_SOCKET_UNIT)).code === 0,
      load: (daemonUp) => daemonUp ? {
        argv: [user("daemon-reload"), user("enable", SYSTEMD_SOCKET_UNIT)],
        note: "an Arbiter daemon is running now: the socket unit is enabled and starts at the next login (or run `arbiter install` again after that daemon exits)"
      } : { argv: [user("daemon-reload"), user("enable", "--now", SYSTEMD_SOCKET_UNIT)] },
      reload: (unitsChanged) => [...unitsChanged ? [user("daemon-reload"), user("restart", SYSTEMD_SOCKET_UNIT)] : [], user("try-restart", SYSTEMD_SERVICE_UNIT)],
      unload: () => [user("disable", "--now", SYSTEMD_SOCKET_UNIT), user("stop", SYSTEMD_SERVICE_UNIT)],
      forget: () => [user("daemon-reload")]
    };
  }
  const xmlFile = layout.units[0]?.path ?? "";
  const create = ["schtasks", "/create", "/tn", WINDOWS_TASK_NAME, "/xml", xmlFile, "/f"];
  const start = ["schtasks", "/run", "/tn", WINDOWS_TASK_NAME];
  const end = ["schtasks", "/end", "/tn", WINDOWS_TASK_NAME];
  return {
    loaded: () => run(["schtasks", "/query", "/tn", WINDOWS_TASK_NAME]).code === 0,
    load: (daemonUp) => ({
      argv: [create, ...daemonUp ? [] : [start]],
      ...daemonUp ? { note: "an Arbiter daemon is running now: the task starts at the next logon" } : {}
    }),
    reload: (unitsChanged) => [...unitsChanged ? [create] : [], end, start],
    unload: () => [end, ["schtasks", "/delete", "/tn", WINDOWS_TASK_NAME, "/f"]],
    forget: () => []
  };
}
function runAll(ctx, commands, what, tolerateAll = false) {
  for (const argv of commands) {
    const res = ctx.io.exec(argv);
    const tolerated = tolerateAll || ["bootout", "stop", "/end", "try-restart"].some((verb) => argv.includes(verb));
    if (res.code !== 0 && !tolerated) throw new Error(`${what}: \`${argv.join(" ")}\` exited ${res.code}: ${res.stdout.trim()}`);
  }
}
var readOr = (path) => {
  try {
    return readFileSync3(path);
  } catch {
    return null;
  }
};
function converge(path, bytes, mode = 384) {
  const now = readOr(path);
  if (now && now.equals(bytes)) return false;
  mkdirSync2(dirname3(path), { recursive: true, mode: 448 });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync3(temp, bytes, { mode });
  renameSync3(temp, path);
  return true;
}
function pluginManifest(pluginRoot) {
  const files = {};
  for (const rel of VERSION_FILES) {
    const bytes = readOr(join4(pluginRoot, rel));
    if (!bytes) throw new Error(`${join4(pluginRoot, rel)} is missing: run arbiter from the built plugin`);
    if (rel === "monitor/launch.mjs" && /from ['"][^'"]*\.ts['"]/.test(bytes.toString("utf8"))) {
      throw new Error(`${join4(pluginRoot, rel)} is the source launcher: run arbiter from the built plugin (dist-plugin)`);
    }
    files[rel] = sha256Hex(bytes);
  }
  return { files };
}
function versionIntact(dir, version) {
  try {
    const manifest = JSON.parse(readFileSync3(join4(dir, "manifest.json"), "utf8"));
    if (versionOf(manifest) !== version) return false;
    return Object.entries(manifest.files).every(([rel, sha]) => sha256Hex(readFileSync3(join4(dir, rel))) === sha);
  } catch {
    return false;
  }
}
function convergeVersion(layout, pluginRoot, manifest, version) {
  const dir = join4(layout.versions, version);
  if (versionIntact(dir, version)) return false;
  const temp = `${dir}.tmp-${process.pid}`;
  rmSync3(temp, { recursive: true, force: true });
  for (const rel of VERSION_FILES) {
    mkdirSync2(dirname3(join4(temp, rel)), { recursive: true, mode: 448 });
    writeFileSync3(join4(temp, rel), readFileSync3(join4(pluginRoot, rel)), { mode: 384 });
  }
  writeFileSync3(join4(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}
`, { mode: 384 });
  if (!versionIntact(temp, version)) throw new Error(`the copy of version ${version} does not match its manifest`);
  rmSync3(dir, { recursive: true, force: true });
  renameSync3(temp, dir);
  return true;
}
function pruneVersions(layout, keep) {
  let names = [];
  try {
    names = readdirSync(layout.versions);
  } catch {
    return;
  }
  for (const name of names) if (name !== keep) rmSync3(join4(layout.versions, name), { recursive: true, force: true });
}
async function installService(ctx, opts = {}) {
  const spec = serviceSpec(ctx, opts.atBoot ?? false);
  const layout = serviceLayout(ctx, spec);
  const manifest = pluginManifest(ctx.pluginRoot);
  const version = versionOf(manifest);
  const changed = [];
  const notes = [];
  mkdirSync2(layout.root, { recursive: true, mode: 448 });
  if (convergeVersion(layout, ctx.pluginRoot, manifest, version)) changed.push(`version ${version}`);
  if (converge(layout.entry, Buffer.from(renderEntry(spec)))) changed.push(layout.entry);
  if (converge(layout.current, Buffer.from(`${version}
`))) changed.push(`current -> ${version}`);
  let unitsChanged = false;
  for (const unit of layout.units) {
    if (converge(unit.path, unit.bytes, 420)) {
      unitsChanged = true;
      changed.push(unit.path);
    }
  }
  const sup = supervisor(ctx, layout);
  if (!sup.loaded()) {
    const load = sup.load(await ctx.io.listening());
    runAll(ctx, load.argv, "load");
    changed.push("loaded");
    if (load.note) notes.push(load.note);
  } else if (changed.length > 0) {
    runAll(ctx, sup.reload(unitsChanged), "reload");
    changed.push("restarted");
  }
  pruneVersions(layout, version);
  return { version, changed, notes };
}
async function uninstallService(ctx) {
  const spec = serviceSpec(ctx, false);
  const layout = serviceLayout(ctx, spec);
  const changed = [];
  const sup = supervisor(ctx, layout);
  const exists = (path) => {
    try {
      lstatSync3(path);
      return true;
    } catch {
      return false;
    }
  };
  const unitFiles = layout.units.map((u) => u.path).filter(exists);
  if (unitFiles.length > 0 || sup.loaded()) {
    runAll(ctx, sup.unload(), "unload", true);
    changed.push("unloaded");
  }
  for (const path of [...unitFiles, layout.root].filter(exists)) {
    rmSync3(path, { recursive: true, force: true });
    changed.push(path);
  }
  if (changed.length > 0) runAll(ctx, sup.forget(), "forget", true);
  return { changed };
}
async function serviceStatus(ctx) {
  const layout = serviceLayout(ctx, serviceSpec(ctx, false));
  const current = readOr(layout.current)?.toString("utf8").trim() ?? null;
  return {
    installed: layout.units.every((u) => readOr(u.path) !== null),
    version: current,
    loaded: supervisor(ctx, layout).loaded(),
    listening: await ctx.io.listening()
  };
}

// arbiter-core/src/service/cli.ts
var USAGE = "usage: arbiter install [--at-boot] [--data-dir <dir>] | arbiter uninstall | arbiter status";
function realServiceIo(endpoint) {
  return {
    exec: (argv) => {
      const [cmd, ...args] = argv;
      const res = spawnSync(cmd ?? "", args, { encoding: "utf8" });
      return { code: res.status ?? 1, stdout: `${res.stdout ?? ""}${res.stderr ?? ""}${res.error ? String(res.error) : ""}` };
    },
    listening: async () => {
      const path = endpoint();
      return path !== void 0 && await socketAnswers(path);
    }
  };
}
async function runServiceCli(argv, input) {
  const out = input.out ?? ((line) => process.stdout.write(`${line}
`));
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, options: { "at-boot": { type: "boolean" }, "data-dir": { type: "string" } } });
  } catch (err) {
    out(`${err.message}
${USAGE}`);
    return 2;
  }
  const [command, ...rest] = parsed.positionals;
  if (rest.length > 0 || !["install", "uninstall", "status"].includes(command ?? "")) {
    out(USAGE);
    return 2;
  }
  const platform = input.os ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    out(`arbiter: ${platform} has no service support; the plugin starts the daemon on demand`);
    return 1;
  }
  const env = input.env ?? process.env;
  const socketPath = platform === "win32" ? void 0 : resolveSocketPath(env);
  const dataDir = typeof parsed.values["data-dir"] === "string" ? parsed.values["data-dir"] : input.dataDir;
  const ctx = {
    os: platform,
    home: input.home ?? homedir2(),
    env,
    pluginRoot: input.pluginRoot,
    nodePath: process.execPath,
    dataDir,
    ...socketPath ? { socketPath } : {},
    ...process.getuid ? { uid: process.getuid() } : {},
    io: input.io ?? realServiceIo(() => platform === "win32" ? readEndpoint(runDirPath(env))?.pipe : socketPath)
  };
  try {
    if (command === "install") {
      const res = await installService(ctx, { atBoot: parsed.values["at-boot"] === true });
      out(res.changed.length === 0 ? `arbiter: installed, version ${res.version}, nothing to change` : `arbiter: installed version ${res.version}: ${res.changed.join(", ")}`);
      for (const note of res.notes) out(`arbiter: note: ${note}`);
    } else if (command === "uninstall") {
      const res = await uninstallService(ctx);
      out(res.changed.length === 0 ? "arbiter: not installed, nothing to change" : `arbiter: removed ${res.changed.join(", ")}`);
    } else {
      out(JSON.stringify(await serviceStatus(ctx)));
    }
    return 0;
  } catch (err) {
    out(`arbiter: ${command} failed: ${err.message}`);
    return 1;
  }
}

// arbiter-cursor/plugin/lib/daemon-paths.mjs
import { join as join5 } from "node:path";
import { homedir as homedir3 } from "node:os";
function resolveDataDir(env = process.env) {
  const fromEnv = typeof env.ARBITER_DATA_DIR === "string" ? env.ARBITER_DATA_DIR.trim() : "";
  if (fromEnv) return fromEnv;
  return join5(homedir3(), ".config", "arbiter");
}

// arbiter-cursor/plugin/bin/arbiter.mjs
process.exitCode = await runServiceCli(process.argv.slice(2), {
  pluginRoot: fileURLToPath(new URL("..", import.meta.url)),
  dataDir: resolveDataDir(process.env)
});
