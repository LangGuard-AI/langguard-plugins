---
name: compliance
description: Runs a compliance check against LangGuard — lists recent violations, policy stats, and entity approval status. Use when auditing compliance, reviewing security posture, or generating compliance reports.
---

# LangGuard Compliance Check

Run a comprehensive compliance check against the LangGuard instance.

## Workflow

1. **Check for MCP server**: If the `langguard` MCP server is connected, use MCP tools:
   - Call `list_policies` to get all policies with stats
   - Call `list_violations` with `status=open` and `limit=20`
   - Call `get_entity_stats` for catalog overview
   - Call `get_dashboard_stats` for trace metrics

2. **Fallback to API**: Locate API credentials from env vars or `.env`:
   ```bash
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/policies/stats" | jq '.data'
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/policies/violations?status=open&limit=20" | jq '.data'
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/entities/stats" | jq '.data'
   ```

3. **Compile compliance report** with these sections:
   - **Violations Summary**: Open violations grouped by severity (critical, high, medium, low)
   - **Policy Coverage**: Active vs disabled policies, enforced vs permissive
   - **Entity Catalog**: Total entities by type, unapproved entities count
   - **Trace Health**: Total traces, error rate, recent activity
   - **Recommendations**: Actionable items (acknowledge violations, review unapproved entities, enable disabled policies)

4. Present as a structured compliance report with severity-coded sections.
