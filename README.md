# LangGuard Plugins

Official plugin marketplace for [LangGuard](https://langguard.ai) — AI
governance, policy enforcement, and agent compliance. Serves **Claude Code**
(via `.claude-plugin/marketplace.json`) and **OpenAI Codex**
(via `.agents/plugins/marketplace.json`) from one repo.

This marketplace ships:

- **`langguard`** (Claude Code) — governance MCP tools, skills, and role-based
  context (below).
- **`langguard-arbiter`** (Claude Code) — in-harness policy *enforcement* on every
  MCP tool call ([see below](#langguard-arbiter--in-harness-policy-enforcement)).
- **`langguard-arbiter`** (OpenAI Codex) — the same enforcement plugin, built for
  Codex ([see below](#langguard-arbiter-on-openai-codex)).

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

If you also run the Codex plugin on the same machine, **use the same `lgr_` key for
both** (or set `LANGGUARD_API_KEY` once) — the two harnesses share one loopback daemon,
and a key mismatch degrades enforcement for whichever harness attached second.

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

**Also running the Claude Code plugin on this machine? Use the same key.** Both
plugins share one local daemon on `127.0.0.1:52746`, authenticated with the `lgr_`
key of whichever plugin started it — so reuse **one** key across harnesses (or set
`LANGGUARD_API_KEY` once, machine-wide) rather than minting a fresh key per install.
If the keys differ anyway, the hook retries once with the bearer the running daemon
published in `~/.config/arbiter/daemon.json`; a persistent mismatch is reported as a
**loopback key mismatch** — cooperative mode warns and fails open, strict mode
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

## Support

- Docs: <https://langguard.ai/docs>
- Issues: <https://github.com/LangGuard-AI/langguard-plugins/issues>
- Email: <support@langguard.ai>
