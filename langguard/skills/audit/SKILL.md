---
name: audit
description: Shows recent trace activity and policy evaluation results from LangGuard. Use when investigating agent behavior, debugging issues, reviewing trace data, or generating audit trails.
---

# LangGuard Audit

Review recent agent trace activity and policy evaluation results.

## Workflow

1. **Check for MCP server**: If the `langguard` MCP server is connected, use MCP tools:
   - Call `get_agent_summaries` for per-agent activity overview
   - Call `list_traces` with `limit=20` for recent activity
   - Call `get_trace_stats` for aggregate statistics
   - Call `list_violations` with `limit=10` for recent policy triggers
   - If the user specifies a trace ID, call `get_trace` for details and `get_violations_by_trace`

2. **Fallback to API**: Locate API credentials from env vars or `.env`:
   ```bash
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/traces/agent-summaries" | jq '.data'
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/traces?limit=20" | jq '.data'
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/traces/stats" | jq '.data'
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/policies/violations?limit=10" | jq '.data'
   ```

3. **For specific trace investigation**:
   ```bash
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/traces/$TRACE_ID" | jq '.data'
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/policies/violations/by-trace/$TRACE_ID" | jq '.'
   ```

4. **Present audit summary** with these sections:
   - **Recent Activity**: Trace count, time range, top agents by activity
   - **Agent Summary**: Per-agent trace counts, success rates, avg latency, total cost
   - **Policy Evaluations**: Violations found, which policies triggered, severity distribution
   - **Trace Details**: If a specific trace was requested, show the full span tree with observations

5. Format as a structured audit report with timeline and agent activity sections.
