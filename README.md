# LangGuard Plugins for Claude Code

Official Claude Code marketplace for [LangGuard](https://langguard.ai) — AI
governance, policy enforcement, and agent compliance.

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

## Support

- Docs: <https://langguard.ai/docs>
- Issues: <https://github.com/LangGuard-AI/langguard-plugins/issues>
- Email: <support@langguard.ai>
