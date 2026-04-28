<!-- langguard-governance-compliance -->

## LangGuard Agent Compliance (MANDATORY)

This project is governed by LangGuard. The policies enforced by LangGuard are
NOT optional. You MUST comply with every active policy retrieved from the
LangGuard MCP server. Failure to check or respect these guardrails is a
violation of this project's governance requirements.

### CRITICAL: Guardrail Enforcement Rules

1. **You MUST call `get_rules` at the start of every session** before performing
   ANY work. This loads the active governance policies. Do not skip this step.
2. **You MUST NOT perform any action that violates an enforced policy.** If a
   policy has `mode: "enforce"` and your planned action would violate its
   constraints, you must refuse or modify your approach to comply.
3. **You MUST check violations after completing tasks.** Call `list_violations`
   filtered to the last 5 minutes after any operation that touches external
   systems, generates code, or produces output.
4. **If you discover a violation you caused, you must stop and report it.** Do
   not continue work that compounds a policy violation.
5. **Permissive policies are warnings, not permissions.** If a policy has
   `mode: "permissive"`, you should still attempt to comply but may proceed if
   full compliance is not feasible. Document why in your response.

### When to Query LangGuard

- **Session start (REQUIRED)**: Call `get_rules` to load active policy constraints
- **Before external tool calls**: Call `get_entity` to check if the tool is cataloged and approved
- **Before risky operations**: Check what policies apply to data access, code generation, or tool calls
- **After completing tasks**: Call `list_violations` filtered to the last 5 minutes
- **When asked about compliance**: Call `list_policies` + `list_violations` for a compliance overview
- **When debugging failures**: Call `get_trace` with the trace ID to inspect policy violations

### Behavioral Workflow

1. **ALWAYS** start sessions by calling `get_rules` — load constraints before doing anything
2. Read each rule's `severity` and `mode` — critical/enforce rules are non-negotiable
3. Before using unfamiliar tools, call `get_entity` to check approval status
4. After operations touching external systems, call `list_violations` (last 5 min window)
5. If a violation is found with severity `critical` or `high`, stop and inform the user
6. Use `search_traces` to find relevant past agent activity for context

### Scope

This agent has **read-only** access to LangGuard. You can query policies,
traces, entities, and violations, but you cannot modify them. If a policy needs
to be changed, inform the user and direct them to the LangGuard dashboard.

### Available Tools

| Tool | Description | Scope |
|------|-------------|-------|
| `get_rules` | Fetch active policies as compact guardrails | read |
| `list_policies` | List all policies with violation stats | read |
| `get_policy` | Get policy details by ID | read |
| `get_policy_summary` | Human-readable Rego policy summary | read |
| `list_violations` | List policy violations with filters | read |
| `get_violations_by_trace` | Violations for a specific trace | read |
| `list_entities` | Browse entity catalog | read |
| `get_entity` | Entity details by ID | read |
| `get_entity_stats` | Entity statistics by type | read |
| `list_traces` | List traces with filters | read |
| `get_trace` | Trace details with observations | read |
| `get_trace_stats` | Trace statistics | read |
| `get_dashboard_stats` | Dashboard overview metrics | read |
| `get_agent_summaries` | Per-agent activity summaries | read |
| `search_traces` | Full-text search on traces | read |
| `get_analytics` | Analytics views | read |
