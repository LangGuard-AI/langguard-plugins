# LangGuard Plugins for Claude Code

Official Claude Code marketplace for [LangGuard](https://langguard.ai) — AI
governance, policy enforcement, and agent compliance.

This marketplace ships two plugins:

- **`langguard`** — governance MCP tools, skills, and role-based context (below).
- **`langguard-arbiter`** — in-harness policy *enforcement* on every MCP tool call
  ([see below](#langguard-arbiter--in-harness-policy-enforcement)).

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
  **ALLOW / BLOCK / ESCALATE** against your active policies.
- **Screen / evidence / verify hooks** (SessionStart, PostToolUse, Stop) for advisory
  context and a best-effort audit trail.
- **A background `monitor`** hosting a **session-local policy daemon**: it provisions a
  checksum-verified OPA binary, syncs your policy bundle from your LangGuard host, and
  evaluates locally on `127.0.0.1` — so enforcement doesn't round-trip to SaaS on the
  confident fast path.

## Requirements

- **Claude Code v2.1.105+** (background `monitor` support)
- **Node.js on your PATH** (the monitor and hooks run under Node)

## Install

```
/plugin marketplace add LangGuard-AI/langguard-plugins
/plugin install langguard-arbiter@langguard-plugins
```

You will be prompted for two values at install time:

| Field | Description |
|---|---|
| `host` | Your LangGuard URL (default `https://app.langguard.ai`; `https://` required unless loopback) |
| `api_token` | An `lgr_` API key from `<host>/settings/api-keys` (stored in OS keychain) |

## How enforcement behaves

- On `mcp__*` calls the hook returns **allow / deny / ask**. It **fails OPEN with a
  warning** while the daemon is warming or never started (cold start, OPA download, or
  no Node) so a fresh session is never locked out; it **fails CLOSED** only when the
  daemon was alive and becomes unreachable.
- Enforcement is **cooperative + audited**, not a tamper-proof perimeter — a developer
  can uninstall the plugin. For hard, locked-down enforcement, deploy via Claude Code
  **managed settings** (force-install + lock).
- Local evaluation is low-latency on the confident fast path and falls back to a remote
  check otherwise.

## Enterprise / managed rollout

IT can force-install and pin the host fleet-wide via Claude Code `managed-settings.json`
(`enabledPlugins` + `strictKnownMarketplaces` + `allowManagedHooksOnly`) — no per-user
`/plugin install`. See the LangGuard enterprise deployment guide.

## Support

- Docs: <https://langguard.ai/docs>
- Issues: <https://github.com/LangGuard-AI/langguard-plugins/issues>
- Email: <support@langguard.ai>
