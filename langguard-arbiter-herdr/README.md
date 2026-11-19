# LangGuard Arbiter Coverage for Herdr

Shows whether each agent pane in your Herdr session is actually covered by LangGuard Arbiter.

**This plugin does not enforce policy. It cannot.** Herdr has no pre-action hook: every event it
exposes to a plugin is past tense, and plugin commands are fire-and-forget, so nothing a plugin
does can approve, deny, or delay a tool call. Enforcement lives where it can actually block, in
the Arbiter plugin for each agent. This plugin answers a different question, the one nobody could
answer before: **is that enforcement switched on right now, for this pane?**

## The problem

Herdr runs about twenty different agent CLIs. Arbiter covers four of them. Nothing in a terminal
tells you which kind of pane you are looking at.

Worse, a covered agent can be silently uncovered. The Arbiter daemon can be absent, still warming
up, dead, or wedged. A config file that says `enforcementMode: strict` proves nothing about
whether a daemon is answering. You can have Arbiter fully configured and entirely inactive, and
the only way to find out today is to check three separate places by hand.

## What it does

Each agent pane carries one metadata token:

| Token | Meaning |
|---|---|
| `ENFORCING` | This exact agent session routed a decision through a live Arbiter daemon. Proven, not inferred. |
| `UNPROVEN` | The daemon is healthy, but this session has not sent it anything yet. |
| `WARMING` | Arbiter is starting up. Judgement deferred. |
| `EXPOSED` | An agent is running and Arbiter cannot enforce. |
| `WEDGED` | Arbiter is up but unreachable, so it is blocking the agent rather than protecting it. |
| `UNCOVERED` | Arbiter has no plugin for this kind of agent. A healthy daemon does not help. |

`ENFORCING` is the only positive claim, and it is evidence-based. The plugin reads the agent's
session id from Herdr, asks the Arbiter daemon whether that session has any recorded decisions,
and only then says the pane is covered. Everything else is honest uncertainty.

When a pane cannot be protected, the plugin shows the exact install command for that agent, and
will run it for you if you say yes.

## Install

```
herdr plugin install LangGuard-AI/langguard-plugins/langguard-arbiter-herdr
```

Requires Herdr 0.7.5 or newer. macOS and Linux.

Restart your Herdr session, or run the rescan action, to start the supervisor.

## Seeing the badge

Herdr renders plugin tokens only where your own config asks for them. Add `$arbiter` to a sidebar
format string in `~/.config/herdr/config.toml`, for example:

```toml
[ui.sidebar]
pane_format = "{agent} {status} $arbiter"
```

Without that, the token is still recorded and every action below still works; it just is not
painted in the sidebar. This is a Herdr design decision: metadata reporters supply values, and
styling stays in local config.

## Actions

Herdr has no command palette, so bind what you want to use. Add to `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "langguard-arbiter-herdr.report"
description = "Arbiter coverage report"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "langguard-arbiter-herdr.remediate"
description = "Protect this agent"
```

| Action | Effect |
|---|---|
| `report` | Opens a popup listing every agent pane, its posture, the reason, and the install command for anything uncovered. |
| `remediate` | For the selected pane, shows the Arbiter install command and offers to run it. Defaults to no. |
| `rescan` | Forces an immediate re-check and confirms with a toast. |

You can also run them directly:

```
herdr plugin action invoke langguard-arbiter-herdr.report
```

## What it will never do

It never sends keys to a pane, answers an approval prompt, closes a pane, or releases an agent.
Auto-answering an approval would fabricate evidence that a human approved something. Closing a
pane would arrive after the dangerous call already ran, and would destroy your work on the
strength of a monitoring guess. The plugin writes exactly one thing: a single `arbiter` metadata
token on panes that contain an agent.

It never edits an agent's configuration files. The only way it changes anything is by running that
agent's own documented installer, after showing you the command and getting a yes.

It never reads or transmits your LangGuard API key. It talks to the Arbiter daemon over loopback
only, and Arbiter's own components own everything that leaves your machine.

## How the badge cannot go stale

Every token is written with a 7.5 second time-to-live and refreshed about every 2.5 seconds. If
the plugin crashes, is disabled, or is uninstalled, Herdr expires the token on its own. A stopped
plugin cannot leave a stale `ENFORCING` badge behind, because the expiry is Herdr's behaviour and
not the plugin's code.

## Requirements

- Herdr 0.7.5+
- Node 20+
- LangGuard Arbiter installed for at least one agent, for anything to report as covered

## Related

Arbiter plugins for individual agents live in the same repository:
`langguard-arbiter` (Claude Code), `langguard-arbiter-codex`, `langguard-arbiter-cursor`,
`langguard-arbiter-antigravity`.
