---
name: setup-arbiter
description: Verify (and if needed walk the user through) LangGuard Arbiter setup on Google Antigravity — config check, daemon health probe, installed-version report, and enforcement-readiness report. Never asks for or accepts the API key in chat.
---

# Set up LangGuard Arbiter

You are helping the user finish setting up the LangGuard Arbiter plugin for Google
Antigravity. Arbiter enforces the user's LangGuard tenant policies on every MCP tool
call (ALLOW / DENY / ASK — ASK surfaces as Antigravity's `force_ask`
approval prompt, which always asks, even when an Always-Allow grant is cached).

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
   the daemon has not started yet — it starts automatically on the next Antigravity
   conversation turn once configuration is in place.
3. Read the installed plugin version from the `plugin.json` next to this skill
   (the plugin directory is `~/.gemini/config/plugins/langguard-arbiter/` for a manual
   folder-drop install, or under `~/.gemini/antigravity-cli/plugins/` for an
   `agy plugin install`). Report it — updates are a re-run of the install command;
   there is no marketplace auto-update.

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
   it spawns automatically at the start of the next conversation turn (the plugin's
   PreInvocation hook), and that this is expected.
3. Read `enforcementMode` from `~/.config/arbiter/config.yaml` (`strict` or, when absent,
   `cooperative`).
4. **The hooks-actually-fire canary:** if config is good but the daemon NEVER comes up
   across turns, the plugin's hooks are probably not running at all — the silent
   failure mode of a folder-drop into the wrong directory. Have the user confirm the
   plugin folder is at `~/.gemini/config/plugins/langguard-arbiter/` (with `plugin.json`
   at its root) or reinstall via `agy plugin install`, then restart Antigravity.
5. Report to the user:
   - Config: found / missing, key set (never the value)
   - Daemon: healthy / not yet running
   - Installed plugin version (from `plugin.json`) + how to update (re-run the install)
   - Enforcement mode: cooperative or strict
   - What they get: deterministic **ALLOW / DENY / FORCE-ASK** on every MCP tool call
     (ASK-tier tools trigger Antigravity's `force_ask` prompt — it always asks,
     ignoring cached Always-Allow grants), best-effort catastrophic-command deny on
     native shell (never full shell enforcement; the browser tool is not verified
     gated), and audit evidence in their LangGuard tenant.

This skill is a convenience only — the plugin works identically without ever running it.
