# LangGuard Plugins

Official plugin marketplace for [LangGuard](https://langguard.ai) — AI
governance, policy enforcement, and agent compliance. Serves **Claude Code**
(via `.claude-plugin/marketplace.json`), **OpenAI Codex**
(via `.agents/plugins/marketplace.json`), **Cursor** (via the
self-describing `langguard-arbiter-cursor/` plugin directory — Cursor
discovers a plugin by its `.cursor-plugin/plugin.json`, no repo-level index
file), and **Google Antigravity** (via the self-describing
`langguard-arbiter-antigravity/` plugin directory — installed with
`agy plugin install` pointing at this repo subpath, or by dropping the folder
into Antigravity's plugins directory; no repo-level index file and no
marketplace) from one repo.

This marketplace ships:

- **`langguard`** (Claude Code) — governance MCP tools, skills, and role-based
  context (below).
- **`langguard-arbiter`** (Claude Code) — in-harness policy *enforcement* on every
  MCP tool call ([see below](#langguard-arbiter--in-harness-policy-enforcement)).
- **`langguard-arbiter`** (OpenAI Codex) — the same enforcement plugin, built for
  Codex ([see below](#langguard-arbiter-on-openai-codex)).
- **`langguard-arbiter`** (Cursor) — the same enforcement plugin, built for
  Cursor, where the ASK verdict uses its native Ask prompt ([see below](#langguard-arbiter-on-cursor)).
- **`langguard-arbiter`** (Google Antigravity) — the same enforcement plugin,
  built for Antigravity with the ASK verdict rendered as its `force_ask` approval
  prompt ([see below](#langguard-arbiter-on-google-antigravity)).

## What you get

Installing the `langguard` plugin adds the following to Claude Code:

- **MCP server** with 25 governance tools (`get_rules`, `list_policies`,
  `list_violations`, `list_traces`, `update_violation_status`, …)
- **Three skills**, namespaced as `/langguard:rules`, `/langguard:compliance`,
  `/langguard:audit`
- **A SessionStart hook** that loads governance instructions tailored to your
  configured role:
  - `compliance` *(default)* — agents enforce active LangGuard policies as
    mandatory guardrails (read-only)
  - `operations` — agents can investigate, manage policies, and resolve
    violations on your behalf (read-write)

## Install

In Claude Code:

```
/plugin marketplace add LangGuard-AI/langguard-plugins
/plugin install langguard@langguard-plugins
```

You will be prompted for three values at install time:

| Field | Description |
|---|---|
| `api_endpoint` | Your LangGuard URL (default `https://app.langguard.ai`) |
| `api_key` | API key from `<api_endpoint>/settings/api-keys` (stored in OS keychain) |
| `governance_mode` | `compliance` (read-only enforcer) or `operations` (read-write agent) |

To create an API key, sign in to your LangGuard instance and visit
`/settings/api-keys`.

## Usage

After install, restart your Claude Code session. The MCP server connects
automatically and the SessionStart hook injects governance instructions.

Try one of the skills:

```
/langguard:rules
/langguard:compliance
/langguard:audit
```

Or just ask the agent:

> "What governance policies apply to this project?"
>
> "Run a compliance audit and show me open violations."

## Updating configuration

To change your endpoint, key, or governance mode:

```
/plugin config langguard
```

## Self-hosted LangGuard

If you run LangGuard on your own infrastructure, set `api_endpoint` to your
instance URL (no trailing slash). The plugin uses the standard
`/api/mcp` HTTP transport with `Bearer` auth.

---

# `langguard-arbiter` — in-harness policy enforcement

A second plugin in this marketplace. Where `langguard` gives the agent governance
*tools and context*, **`langguard-arbiter` enforces**: it intercepts every MCP tool
call at the pre-action seam and returns a deterministic verdict against your active
LangGuard policies — no LLM in the enforcement loop.

## What you get

- **A `PreToolUse` enforcement hook** on `mcp__*` tool calls — deterministic
  **ALLOW / DENY / ASK** against your active policies.
- **Screen / evidence / verify hooks** (SessionStart, PostToolUse, Stop) for advisory
  context and a best-effort audit trail.
- **A background `monitor`** hosting a **session-local policy daemon** on `127.0.0.1`:
  it provisions a checksum-verified OPA binary and keeps a policy-bundle sync channel
  open so evaluation can run locally as bundle delivery rolls out. Today every verdict
  rides a low-latency remote check against your LangGuard host.

## Requirements

- **Claude Code v2.1.105+** (background `monitor` support)
- **Node.js on your PATH** (the monitor and hooks run under Node)

## Install

```
/plugin marketplace add LangGuard-AI/langguard-plugins
/plugin install langguard-arbiter@langguard-plugins
```

You will be prompted for three values at install time:

| Field | Description |
|---|---|
| `host` | Your LangGuard URL (default `https://app.langguard.ai`; `https://` required unless loopback) |
| `api_token` | An `lgr_` API key — mint one on the **Arbiter Hooks** page at `<host>/settings/agent-hooks` (ingest scope, shown once; stored in OS keychain) |
| `enforcement_mode` | `cooperative` (default, fails open if the daemon dies or the key is revoked) or `strict` (fails closed past a short cold-start grace — recommended for managed/enterprise) |

If you also run the Codex, Cursor, and/or Antigravity plugin on the same machine,
**use the same `lgr_` key for all of them** (or set `LANGGUARD_API_KEY` once) — all
four harnesses share one loopback daemon, and a key mismatch degrades enforcement for
whichever harness attached later.

## How enforcement behaves

- On `mcp__*` calls the hook returns **allow / deny / ask**. In **cooperative** mode it
  **fails OPEN with a warning** while the daemon is warming, never started, or has
  crashed (cold start, OPA download, no Node) so a fresh session is never locked out;
  it fails CLOSED only when a daemon is alive but unresponsive (wedged). In **strict**
  mode a dead or never-starting daemon, a revoked key, and a loopback key mismatch all
  fail CLOSED once past a bounded cold-start grace.
- Enforcement is **cooperative + audited**, not a tamper-proof perimeter — a developer
  can uninstall the plugin. For hard, locked-down enforcement, deploy via Claude Code
  **managed settings** (force-install + lock).

## Enterprise / managed rollout

IT can force-install and pin the host fleet-wide via Claude Code `managed-settings.json`
(`enabledPlugins` + `strictKnownMarketplaces` + `allowManagedHooksOnly`) — no per-user
`/plugin install`. See the LangGuard enterprise deployment guide.

---

# `langguard-arbiter` on OpenAI Codex

The same enforcement plugin, packaged for **OpenAI Codex** (CLI and IDE extension —
one install covers both; they share configuration layers). Codex reads this repo's
`.agents/plugins/marketplace.json` and installs from `langguard-arbiter-codex/`.
Same plugin name, same muscle memory as the Claude Code install.

## What you get

- **A `PreToolUse` enforcement hook** on `mcp__*` tool calls — deterministic
  **ALLOW / DENY** against your active LangGuard policies, no LLM in the
  enforcement loop.
- **Screen / evidence / verify hooks** (SessionStart, UserPromptSubmit, PostToolUse,
  Stop, SubagentStop) for advisory context and a best-effort audit trail.
- **A session-local policy daemon**, spawned on demand by the hooks: it provisions a
  checksum-verified OPA binary, syncs your policy bundle from your LangGuard host,
  and evaluates on `127.0.0.1`. Codex has no background-monitor concept, so the
  hooks own the daemon lifecycle (spawn-if-not-running on session start).

## Requirements

- **Codex CLI v0.124.0+** (stable hooks with MCP tool-call coverage; the plugin
  system itself needs v0.117.0+)
- **Node.js on your PATH** (the hooks and daemon run under Node)

## Install

In Codex:

```
/plugin marketplace add LangGuard-AI/langguard-plugins
/plugin install langguard-arbiter@langguard-plugins
/reload-plugins
```

Then **trust the hooks** — Codex skips plugin-bundled hooks until you review them:

```
/hooks    →  review and trust the LangGuard Arbiter hooks
```

Trust is pinned to the hook code's hash, so after a plugin update Codex will
re-prompt and you must re-trust via `/hooks`.

## Configure

Codex plugins have no install-time prompts. Arbiter reads the standard LangGuard
client config at `~/.config/arbiter/config.yaml`:

```yaml
host: https://app.langguard.ai   # your LangGuard URL (https required, except loopback)
apiKey: lgr_...                  # mint one at <host>/settings/agent-hooks
enforcementMode: cooperative     # or: strict
```

Environment variables override the file: `LANGGUARD_API_KEY` (key) and
`LANGGUARD_HOST` (host). The **Arbiter Hooks** settings page in LangGuard mints a
key and emits a ready-to-paste snippet that writes this file for you.

**Also running the Claude Code, Cursor, or Antigravity plugin on this machine? Use
the same key.**
All four plugins share one local daemon on `127.0.0.1:52746`, authenticated with the
`lgr_` key of whichever plugin started it — so reuse **one** key across harnesses (or
set `LANGGUARD_API_KEY` once, machine-wide) rather than minting a fresh key per
install. If the keys differ anyway, the hook retries once with the bearer the running
daemon published in `~/.config/arbiter/daemon.json`; a persistent mismatch is reported
as a **loopback key mismatch** — cooperative mode warns and fails open, strict mode
blocks with the same actionable reason.

## How enforcement behaves

- On `mcp__*` calls the hook returns **allow / deny**. **ASK collapses to
  DENY** — Codex has no interactive approval ("ask") path from a hook; the deny
  reason tells the agent that approval happens in LangGuard.
- **Cooperative** (default): fails OPEN with a warning while the daemon is warming
  up, never started, or your key is missing/revoked — a fresh session is never
  locked out.
- **Strict** (`enforcementMode: strict`): fails CLOSED (deny) when the daemon is
  down, after a bounded first-contact grace for cold starts. A daemon that is alive
  but unresponsive blocks in **both** modes.
- Codex itself fails open at the harness level (a hook that times out or fails to
  spawn lets the tool call proceed), and hooks only fire once trusted — so this is
  **cooperative + audited** enforcement, not a tamper-proof perimeter.

## Enterprise / managed rollout

Deploy the hooks as **managed hooks** via Codex `requirements.toml` — managed hooks
are trusted by policy (no per-user `/hooks` prompt), and `allow_managed_hooks_only`
stops users from adding unmanaged ones. Pair with `[admin] plugin_marketplaces`
allowlists (`allow_external_marketplaces = false`) to pin this marketplace
fleet-wide.

---

# `langguard-arbiter` on Cursor

The same enforcement plugin, packaged for **Cursor**. Cursor installs from the
self-describing `langguard-arbiter-cursor/` plugin directory in this repo (a Cursor
plugin is discovered by its `.cursor-plugin/plugin.json`; there is no repo-level
registration file for Cursor). Same plugin name, same one-key config, same muscle
memory as the Claude Code and Codex installs — plus the piece the Codex port cannot
offer: **the ASK verdict surfaces as Cursor's native Ask approval prompt**.

## What you get

- **A `beforeMCPExecution` enforcement hook** on every MCP tool call — deterministic
  **ALLOW / DENY / ASK** against your active LangGuard policies, no LLM in the
  enforcement loop. ASK-tier verdicts trigger Cursor's native Ask dialog so a
  human approves or rejects in-flow.
- **A `beforeShellExecution` backstop** — best-effort catastrophic-command deny on
  native shell (works even with the local daemon down); full shell policy evaluation
  otherwise rides the same enforce path.
- **Screen / evidence / verify hooks** (`sessionStart`, `afterMCPExecution`, `stop`)
  for advisory context and a best-effort audit trail. `afterMCPExecution` cannot
  hard-block (advisory correction only); `stop` is followup-only.
- **A `/setup-arbiter` command** that verifies config + daemon health and walks you
  through setup — without ever handling your API key in chat.
- **A session-local policy daemon**, spawned on demand by the hooks: it provisions a
  checksum-verified OPA binary (SHA-256 pins bundled in `opa/opa-checksums.json`),
  syncs your policy bundle from your LangGuard host, and evaluates on
  `127.0.0.1:52746` — the same daemon the Claude Code, Codex, and Antigravity
  plugins share.

## Requirements

- **Cursor with plugin support** (the Cursor Marketplace, launched Feb 2026; the
  exact minimum version is being pinned during live verification — any 2026 Cursor
  3.x with the Customize page qualifies)
- **Node.js 20+ on your PATH** (the hooks and daemon run under Node)
- Note: **Cursor cloud agents do not run MCP hooks** — enforcement covers local
  (desktop) agent sessions.

## Install

One-click from [cursor.com/marketplace](https://cursor.com/marketplace) (search for
**LangGuard Arbiter**), or in-app: open Cursor's **Customize** page → Plugins →
search "LangGuard Arbiter" → Install.

Teams can also import this repo as a **repo-backed team marketplace**
(GitHub/GitLab/Bitbucket/Azure DevOps) and distribute the plugin in Default Off /
Default On / **Required** mode. *Open question (tracked as a pre-publish verify
item): whether Cursor's repo-backed indexer accepts a multi-plugin repo where only
`langguard-arbiter-cursor/` carries a `.cursor-plugin/` manifest — if it does not,
the contingency is mirroring that directory to a dedicated repo; the plugin contents
are unchanged either way.*

## Configure

Cursor plugins take no install-time secrets. Arbiter reads the standard LangGuard
client config at `~/.config/arbiter/config.yaml` — identical to the Codex plugin:

```yaml
host: https://app.langguard.ai   # your LangGuard URL (https required, except loopback)
apiKey: lgr_...                  # mint one at <host>/settings/agent-hooks
enforcementMode: cooperative     # or: strict
```

Environment variables override the file: `LANGGUARD_API_KEY` (key) and
`LANGGUARD_HOST` (host). The **Arbiter Hooks** settings page in LangGuard mints a
key and emits a ready-to-paste snippet that writes this file for you — run it in
your own terminal, and **never paste the key into the agent chat**.

After configuring, run `/setup-arbiter` in Cursor to verify config, probe the local
daemon, and get an enforcement-readiness report.

**Also running the Claude Code, Codex, or Antigravity plugin on this machine? Use
the same `lgr_` key** (or set `LANGGUARD_API_KEY` once, machine-wide). All four
harnesses share the one loopback daemon on `127.0.0.1:52746`, authenticated with the key of
whichever plugin started it — a key mismatch degrades enforcement for whichever
harness attached later (cooperative warns and fails open; strict blocks with an
actionable reason).

## How enforcement behaves

- On MCP calls the hook returns **allow / deny / ask** — the ASK verdict maps to Cursor's
  native Ask prompt, so it is resolved by a human in the session rather
  than collapsing to deny (the Codex limitation does not apply here).
- **Cooperative** (default): fails OPEN with a warning while the daemon is warming
  up, never started, or your key is missing/revoked — a fresh session is never
  locked out.
- **Strict** (`enforcementMode: strict`): fails CLOSED (deny) when the daemon is
  down, after a bounded first-contact grace for cold starts. A daemon that is alive
  but unresponsive blocks in **both** modes.
- **Native shell** gets a best-effort catastrophic-command deny that works even
  with the daemon completely down; it is a backstop, not full shell governance.
- Cursor itself runs hooks **fail-open at the harness level** (a hook that crashes
  or fails to spawn lets the tool call proceed), and a developer can uninstall the
  plugin or edit local hooks outside Required mode — so this is **cooperative +
  audited** enforcement, not a tamper-proof perimeter.

## Enterprise / managed rollout

Ranked by reliability:

1. **Team-marketplace Required mode** — import this repo (or a mirror) as a team
   marketplace and mark the plugin **Required**: always installed, cannot be
   uninstalled, auto-updated on repo re-index (at most every 10 minutes).
2. **MDM system-level hooks** — deploy a system `hooks.json` via Jamf/Intune/etc.
   (macOS `/Library/Application Support/Cursor/hooks.json`, Windows
   `C:\ProgramData\Cursor\hooks.json`); the managed layer may additionally set
   `failClosed: true` to close the harness-level fail-open ceiling for the fleet.
3. **Enterprise dashboard hooks** — supported, but ranked below the two above due
   to an open delivery-reliability report (forum.cursor.com/t/152082); validate on
   your tenant before relying on it.

---

# `langguard-arbiter` on Google Antigravity

The same enforcement plugin, packaged for **Google Antigravity** (the desktop app
and the `agy` CLI). Antigravity has no plugin marketplace: the self-describing
`langguard-arbiter-antigravity/` directory in this repo *is* the plugin — install it
with the `agy` CLI or by dropping the folder into Antigravity's plugins directory
(no repo-level registration file). Same plugin name, same one-key config, same
muscle memory as the other installs — and **the ASK verdict surfaces as Antigravity's
`force_ask` approval prompt**, which always asks, even when an Always-Allow grant
is cached (that is the point: policy requires a human to look at this exact call).

Antigravity capability claims below carry a "pending live verification" caveat
until the pre-launch live-verify pass completes.

## What you get

- **A `PreToolUse` enforcement hook** on every tool call (the matcher is `*` on
  purpose — one event covers MCP, shell, and everything else, and the hook
  classifies) — deterministic **ALLOW / DENY / FORCE-ASK** against your active
  LangGuard policies, no LLM in the enforcement loop. ASK-tier verdicts render
  Antigravity's `force_ask` prompt so a human approves or rejects in-flow.
- **A best-effort catastrophic-command deny on native shell** (works even with the
  local daemon down); it is a backstop, not full shell governance.
- **Screen / evidence / verify hooks** (`PreInvocation`, `PostToolUse`, `Stop`) for
  advisory context and a best-effort audit trail — all advisory, never blocking;
  `Stop` is audit-only.
- **A `setup-arbiter` skill** that verifies config + daemon health, reports the
  installed plugin version, and doubles as the "did the hooks actually fire"
  canary — without ever handling your API key in chat.
- **An advisory rules file** (`rules/langguard-governance.md`) explaining verdicts
  and `force_ask` prompts to the agent — context only, it grants and blocks nothing.
- **A session-local policy daemon**, spawned on demand by the hooks: it provisions a
  checksum-verified OPA binary (SHA-256 pins bundled in `opa/opa-checksums.json`),
  syncs your policy bundle from your LangGuard host, and evaluates on
  `127.0.0.1:52746` — the same daemon the Claude Code, Codex, and Cursor plugins
  share.

## Requirements

- **Google Antigravity 2.0+** (hooks shipped in 2.0); the **agy CLI v1.0.16+** for
  repo-subpath installs
- **Node.js 20+ on your PATH** (the hooks and daemon run under Node)
- Hands-on evidence for plugin hook execution is CLI-centric so far; **desktop-app /
  Agent Manager hook coverage is pending live verification** — coverage claims are
  scoped accordingly.

## Install

In your shell:

```
agy plugin install LangGuard-AI/langguard-plugins/langguard-arbiter-antigravity
```

Or **folder-drop**: copy the `langguard-arbiter-antigravity/` directory to
`~/.gemini/config/plugins/langguard-arbiter/` (auto-scanned; works for the desktop
app, including air-gapped machines). Restart your Antigravity session afterward and
verify with `agy plugin list`.

*Pending live verification:* whether the two install channels stage the plugin at
the same path (the hook command strings use plugin-root substitution and the hooks
self-derive their location, so a mismatch is an install-recipe fix, not a plugin
change).

## Configure

Antigravity plugins have no install-time prompts. Arbiter reads the standard
LangGuard client config at `~/.config/arbiter/config.yaml` — identical to the Codex
and Cursor plugins:

```yaml
host: https://app.langguard.ai   # your LangGuard URL (https required, except loopback)
apiKey: lgr_...                  # mint one at <host>/settings/agent-hooks
enforcementMode: cooperative     # or: strict
```

Environment variables override the file: `LANGGUARD_API_KEY` (key) and
`LANGGUARD_HOST` (host). The **Arbiter Hooks** settings page in LangGuard mints a
key and emits a ready-to-paste snippet that writes this file for you — run it in
your own terminal, and **never paste the key into the agent chat**.

After configuring, ask the agent to run the bundled `setup-arbiter` skill to verify
config, probe the local daemon, and get an enforcement-readiness report (it also
reports the installed plugin version).

**Also running the Claude Code, Codex, or Cursor plugin on this machine? Use the
same `lgr_` key** (or set `LANGGUARD_API_KEY` once, machine-wide). All four
harnesses share the one loopback daemon on `127.0.0.1:52746`, authenticated with
the key of whichever plugin started it — a key mismatch degrades enforcement for
whichever harness attached later (cooperative warns and fails open; strict blocks
with an actionable reason).

## How enforcement behaves

- On MCP calls the hook returns **allow / deny / force_ask** — the ASK verdict maps to
  Antigravity's `force_ask` prompt, which always asks and ignores cached
  Always-Allow grants, so it is resolved by a human in the session rather
  than collapsing to deny (the Codex limitation does not apply here).
- **Cooperative** (default): fails OPEN with a warning while the daemon is warming
  up, never started, or your key is missing/revoked — a fresh session is never
  locked out.
- **Strict** (`enforcementMode: strict`): fails CLOSED (deny) when the daemon is
  down, after a bounded first-contact grace for cold starts. A daemon that is alive
  but unresponsive blocks in **both** modes.
- The verdict always travels as an **explicit stdout decision, never an exit
  code** — so the shim's fail posture holds regardless of how the harness treats
  hook exit codes.
- **Native shell** gets a best-effort catastrophic-command deny that works even
  with the daemon completely down; the **built-in browser tool is not verified
  gated** in v1 (fast-follow).
- Antigravity's harness-level behavior when a hook crashes, times out, or fails to
  spawn is **undocumented (pending live verification)** — assume a killed hook lets
  the tool call proceed. A developer can also uninstall the plugin — so this is
  **cooperative + audited** enforcement, not a tamper-proof perimeter.

## Updating

Honesty first: **there is no marketplace, no review process, and no auto-update.**
Updating means re-running the `agy plugin install` command (or re-dropping the
folder) and restarting your session; whether `agy` upgrades strictly in place is
pending live verification. The `setup-arbiter` skill reports the installed plugin
version, so you can check what a machine is actually running. If you run several
harness plugins on one machine, update them together — a stale **Codex- or
shell-owned** sibling daemon fails an Antigravity ASK closed (deny, never
allow) instead of rendering `force_ask` (its whitelist predates `antigravity`,
so the stamp falls back to its own non-ask-capable harness). Claude- and
Cursor-owned siblings render `force_ask` even when stale.

## Enterprise / managed rollout

Antigravity currently has **no fleet lever**: no force-install, no Required mode,
no managed-hooks trust policy, and no managed `failClosed` analog — a user can
uninstall or disable the plugin. Ranked by what is actually available:

1. **MDM file distribution** — deploy the plugin folder to
   `~/.gemini/config/plugins/langguard-arbiter/` via Jamf/Intune/etc.; pair with
   `enforcementMode: strict` in the managed config file.
2. **Audit-first detection** — every enforced call lands in your LangGuard tenant
   attributed to the machine's key; machines that stop reporting stand out. Detect
   drift, then remediate.
3. **Antigravity's native permission engine as a backstop** — only after you have
   validated it on your build: it has documented reliability bugs, so do not rely
   on it as a primary control.

Sidecar-style distribution is deliberately unused: it sits behind a manual per-user
enable, and an enforcement daemon behind an opt-in silently never enforces.

---

## Support

- Docs: <https://langguard.ai/docs>
- Issues: <https://github.com/LangGuard-AI/langguard-plugins/issues>
- Email: <support@langguard.ai>
