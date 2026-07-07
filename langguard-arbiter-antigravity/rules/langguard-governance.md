# LangGuard Arbiter governance context

This workspace's agent activity is governed by LangGuard Arbiter. Every MCP tool call
is checked against the organization's LangGuard policies before it runs and receives a
deterministic verdict: **ALLOW** (proceeds normally), **DENY** (blocked, with the
policy reason), or **ESCALATE** (a human must approve this specific call). Decisions
are made by a local policy engine from server-synced policy bundles — no LLM is in the
enforcement loop — and an audit record lands in the organization's LangGuard tenant.

When you see an Antigravity approval prompt attributed to LangGuard Arbiter, that is an
ESCALATE verdict rendered as `force_ask`: policy requires a human to look at this exact
tool call, so the prompt appears even if the user previously chose Always-Allow for the
tool. Repeated prompts on escalate-tier tools are intentional, not a bug. If a call is
DENIED, relay the stated reason to the user rather than retrying variations of the same
call; the right fix is a policy or approval change in LangGuard, which the user's
administrator can make.

This rule file is advisory context only — it grants nothing and blocks nothing by
itself. Enforcement happens in the plugin's PreToolUse hook, and its coverage limits
are stated honestly in the LangGuard docs (native shell gets a best-effort
catastrophic-command backstop, not full policy gating; the built-in browser tool is not
verified gated in v1).
