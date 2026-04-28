---
name: rules
description: Fetches and displays current active governance rules from LangGuard. Use when you need to understand what policies are active, before performing operations that might violate policies, or when the user asks about current rules/constraints/guardrails.
---

# LangGuard Rules

Fetch and display the current active policy rules from the LangGuard instance.

## Workflow

1. **Check for MCP server**: If the `langguard` MCP server is connected, use MCP tools directly:
   - Call `get_rules` to fetch all active policies as compact guardrails
   - Display the rules grouped by severity (critical first)

2. **Fallback to API**: If MCP is not available, locate API credentials:
   - Check environment variables: `LANGGUARD_API_KEY`, `LANGGUARD_API_URL`
   - Check `.env` file for these values
   - If neither found, ask the user

3. **Fetch rules via API**:
   ```bash
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/policies" | jq '.data'
   ```

4. **Fetch policy stats**:
   ```bash
   curl -s -H "Authorization: Bearer $LANGGUARD_API_KEY" "$LANGGUARD_API_URL/api/policies/stats" | jq '.data'
   ```

5. **Display results** as a markdown table:
   | Name | Category | Severity | Mode | Violations (24h) |
   Group by category. Highlight enforced critical/high policies.

6. **Summary block**: Total active, by category, OPA health status, recent violation count.
