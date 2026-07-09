---
description: Verify (and if needed walk the user through) LangGuard Arbiter setup — config check, daemon health probe, and enforcement-readiness report. Never asks for or accepts the API key in chat.
---

# Set up LangGuard Arbiter

You are helping the user finish setting up the LangGuard Arbiter plugin for Cursor.
Arbiter enforces the user's LangGuard tenant policies on every MCP tool call
(ALLOW / DENY / ASK — ASK surfaces as Cursor's native Ask prompt).

**HARD RULE — the API key never touches this chat.** Do NOT ask the user for their
LangGuard API key, do NOT accept one if they paste it, and do NOT write a key into any
file yourself. If the user pastes a key into the chat, tell them to treat that key as
compromised, revoke it on the LangGuard settings page, and mint a fresh one. The key
travels clipboard → their terminal only — never through model context.

Follow these steps:

## Step 1 — Check the current state

1. Check whether `~/.config/arbiter/config.yaml` exists and contains an `apiKey` entry
   (do not print the key value; just report whether one is set and whether it still
   looks like a placeholder such as `lgr_PASTE_YOUR_KEY_HERE`).
2. Probe the local policy daemon: `GET http://127.0.0.1:52746/health`
   (e.g. `curl -s -m 2 http://127.0.0.1:52746/health`). A connection failure just means
   the daemon has not started yet — it starts automatically on the next Cursor session
   once configuration is in place.

If the config exists with a real-looking `apiKey` AND the health probe answers, skip to
Step 3.

## Step 2 — Point the user at the settings page (user acts in their own terminal)

If unconfigured, tell the user to:

1. Open their LangGuard tenant in a browser and go to **`/settings/agent-hooks`**
   (the "Agent Hooks" settings page).
2. Mint an API key there and copy the ready-made setup command the page shows.
3. Run that copied command **themselves in a terminal** (it writes
   `~/.config/arbiter/config.yaml`). Remind them: **never paste this key into the
   chat** — clipboard → terminal only.
4. Come back here and confirm when done.

Wait for the user to confirm before continuing. Do not offer to run the setup command
for them and do not reconstruct it in chat.

## Step 3 — Verify and report readiness

After the user confirms:

1. Re-check `~/.config/arbiter/config.yaml` (an `apiKey` is present; still do not print it).
2. Re-probe `GET http://127.0.0.1:52746/health`. If the daemon is not up yet, note that
   it spawns automatically at the start of the next Cursor session (or on the next MCP
   call), and that this is expected.
3. Read `enforcementMode` from `~/.config/arbiter/config.yaml` (`strict` or, when absent,
   `cooperative`).
4. Report to the user:
   - Config: found / missing, key set (never the value)
   - Daemon: healthy / not yet running
   - Enforcement mode: cooperative or strict
   - What they get: deterministic **ALLOW / DENY / ASK** on every MCP tool call
     (ASK-tier tools trigger Cursor's native Ask approval prompt), best-effort
     catastrophic-command deny on native shell, and audit evidence in their
     LangGuard tenant.

This command is a convenience only — the plugin works identically without ever running it.
