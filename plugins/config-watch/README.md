# config-watch

> Tripwire for out-of-band config changes: makes every mid-session settings/skills change loudly visible, or blocks it outright.

A `ConfigChange` hook fires whenever a configuration file changes while a session runs: an installer script, an npm postinstall payload (the CHAINDROP worm hid in `.claude/settings.json` exactly this way), or any other process rewriting settings behind Claude Code's back. By default it emits a `systemMessage` naming the changed source (and file path when the payload includes one) so the change is visible in the session instead of sliding by silently. Opt into block mode and it exits 2 to stop the change from taking effect; `policy_settings` cannot be blocked by hooks per the docs, so those still warn.

Pairs with [config-guard](https://github.com/karanb192/claude-code-hooks): config-guard (PreToolUse) blocks the agent's own writes to its guardrail config; config-watch covers the out-of-band path.

One caveat, straight from the docs: the hooks reference guarantees ConfigChange can block via exit 2 but does not document the event's payload schema. The hook therefore parses defensively (accepts `source` / `config_source` / `matcher` and `file_path` / `path`) and logs the raw payload so you can inspect what your Claude Code version actually sends.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install config-watch@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install config-watch@claude-code-hooks`.)

## What it does

| Event | Matcher | What happens |
|-------|---------|--------------|
| ConfigChange | `user_settings\|project_settings\|local_settings\|policy_settings\|skills` | Warn mode (default): emits a `systemMessage` naming the changed source, exit 0. Block mode: exits 2 with the reason on stderr, stopping the change from taking effect; `policy_settings` still warns. Either way, the raw payload is logged. |

Note: ConfigChange also fires for changes YOU make (e.g. `/config`, editing settings in your editor), so block mode is opt-in for hardened setups; the default keeps legitimate workflows friction-free.

## Configuration

Optional, set via environment variable:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONFIG_WATCH_BLOCK` | `false` | Set to the literal string `true` to block config changes (exit 2) instead of warning. Any other value keeps warn mode. `policy_settings` cannot be blocked and always warns. |

## Data & privacy

Logs each event (including the raw payload, since the schema is undocumented) to `~/.claude/hooks-logs/<date>.jsonl`. It makes no network calls (the script only uses `fs` and `path`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall config-watch@claude-code-hooks
```
