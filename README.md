# LangGuard Plugins

Official plugin marketplace for [LangGuard](https://langguard.ai) — AI
governance, policy enforcement, and agent compliance. Serves **Claude Code**
(via `.claude-plugin/marketplace.json`), **OpenAI Codex**
(via `.agents/plugins/marketplace.json`), and **Cursor** (via the
self-describing `langguard-arbiter-cursor/` plugin directory — Cursor
discovers a plugin by its `.cursor-plugin/plugin.json`, no repo-level index
file) from one repo.

This marketplace ships:

- **`langguard`** (Claude Code) — governance MCP tools, skills, and role-based
  context (below).
- **`langguard-arbiter`** (Claude Code) — in-harness policy *enforcement* on every
  MCP tool call ([see below](#langguard-arbiter--in-harness-policy-enforcement)).
- **`langguard-arbiter`** (OpenAI Codex) — the same enforcement plugin, built for
  Codex ([see below](#langguard-arbiter-on-openai-codex)).
- **`langguard-arbiter`** (Cursor) — the same enforcement plugin, built for
  Cursor with native Ask on ESCALATE ([see below](#langguard-arbiter-on-cursor)).

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
  **ALLOW / DENY / ESCALATE** against your active policies.
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

If you also run the Codex and/or Cursor plugin on the same machine, **use the same
`lgr_` key for all of them** (or set `LANGGUARD_API_KEY` once) — all three harnesses
share one loopback daemon, and a key mismatch degrades enforcement for whichever
harness attached later.

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

**Also running the Claude Code or Cursor plugin on this machine? Use the same key.**
All three plugins share one local daemon on `127.0.0.1:52746`, authenticated with the
`lgr_` key of whichever plugin started it — so reuse **one** key across harnesses (or
set `LANGGUARD_API_KEY` once, machine-wide) rather than minting a fresh key per
install. If the keys differ anyway, the hook retries once with the bearer the running
daemon published in `~/.config/arbiter/daemon.json`; a persistent mismatch is reported
as a **loopback key mismatch** — cooperative mode warns and fails open, strict mode
blocks with the same actionable reason.

## How enforcement behaves

- On `mcp__*` calls the hook returns **allow / deny**. **ESCALATE collapses to
  DENY** — Codex has no interactive approval ("ask") path from a hook; the deny
  reason tells the agent that escalation and approval happen in LangGuard.
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
memory as the Claude Code and Codex installs — plus the piece the other two cannot
offer: **ESCALATE surfaces as Cursor's native Ask approval prompt**.

## What you get

- **A `beforeMCPExecution` enforcement hook** on every MCP tool call — deterministic
  **ALLOW / DENY / ASK** against your active LangGuard policies, no LLM in the
  enforcement loop. ESCALATE-tier verdicts trigger Cursor's native Ask dialog so a
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
  `127.0.0.1:52746` — the same daemon the Claude Code and Codex plugins share.

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

**Also running the Claude Code or Codex plugin on this machine? Use the same
`lgr_` key** (or set `LANGGUARD_API_KEY` once, machine-wide). All three harnesses
share the one loopback daemon on `127.0.0.1:52746`, authenticated with the key of
whichever plugin started it — a key mismatch degrades enforcement for whichever
harness attached later (cooperative warns and fails open; strict blocks with an
actionable reason).

## How enforcement behaves

- On MCP calls the hook returns **allow / deny / ask** — ESCALATE maps to Cursor's
  native Ask prompt, so escalation is resolved by a human in the session rather
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

## Support

- Docs: <https://langguard.ai/docs>
- Issues: <https://github.com/LangGuard-AI/langguard-plugins/issues>
- Email: <support@langguard.ai>
