# config-guard

> Who guards the guards: blocks the agent from tampering with its own guardrail configuration, so no other hook can be switched off from inside a session.

A `PreToolUse` hook fires before every `Bash`, `Edit`, `MultiEdit`, and `Write` call and denies any mutation of the files that wire your guardrails: settings files that register hooks and permissions, the hook scripts themselves, `hooks.json` manifests, `.mcp.json`, and plugin config. Reads always pass (agents legitimately read settings); only writes, in-place edits, moves, copies onto, symlink swaps, and deletes are stopped, plus the `claude config set`, `claude mcp add`, and `claude plugin install` CLI forms that rewrite agent config without naming a settings path. Creating a protected file that does not exist yet also counts as mutation: that was the CVE-2026-25725 persistence vector, and the Aug 2026 CHAINDROP npm worm hid its payload in `.claude/settings.json` the same way. Edit/MultiEdit/Write paths are resolved through symlinks before checking, so a write through `ln -s ~/.claude /tmp/x` is still caught.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install config-guard@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install config-guard@claude-code-hooks`.)

## What it does

| Event | Matcher | What happens |
|-------|---------|--------------|
| PreToolUse | `Bash\|Edit\|MultiEdit\|Write` | Checks the target path (Edit/MultiEdit/Write) or command string (Bash) against the protected set for the active safety level; returns `permissionDecision: "deny"` (or `"ask"` in ask mode) with the pattern id and reason, `{}` otherwise. |

Three safety levels, each including the previous:

| Level | Protects |
|-------|----------|
| `critical` | The enforcement chain: `.claude/settings.json`, `.claude/settings.local.json`, `managed-settings.json`, anything under `.claude/hooks/`, `hooks.json` manifests. |
| `high` (default) | Plus the config supply chain: `.mcp.json`, `.claude-plugin/`, and `claude config set\|add\|remove`, `claude mcp add\|add-json\|add-from-claude-desktop\|remove`, `claude plugin install\|uninstall\|enable\|disable\|update\|marketplace` (list/get forms stay allowed). |
| `strict` | Plus instruction files that steer the agent: `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`, `.claude/agents/`, `.claude/commands/`. |

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`. Env-only on purpose: plugin updates overwrite installed files, so never edit the script. |
| `CONFIG_GUARD_ALLOW` | unset | Escape hatch for an intentional, human-approved config change: the literal string `true` lets the call through (anything else still denies). Export it for one shell call, or prefix a single hook command with it in settings.json. |
| `HOOK_ASK_CRITICAL` | unset | `true` prompts the user instead of denying for `critical`-level matches. |
| `HOOK_ASK_HIGH` | unset | `true` prompts instead of denying for `high`-level matches. |
| `HOOK_ASK_STRICT` | unset | `true` prompts instead of denying for `strict`-level matches. |

Ask mode is strictly per level and opt-in: everything defaults to deny.

## Known limits

Deliberately not a full shell parser: a mutation verb and a protected path in the same Bash command block it even if the verb technically targets another argument. Interpreter one-liners (`python -c "open(...).write(...)"`), `git checkout/restore` of a config path, `chmod`, and paths built from variables (`"$DIR/settings.json"`) are not caught. Shell command strings are matched as text, so a Bash redirect through a symlinked directory is not resolved. PreToolUse only sees the agent's own tool calls; out-of-band changes are covered by its sibling [config-watch](https://github.com/karanb192/claude-code-hooks) (ConfigChange event) in the root repo.

## Data & privacy

Logs decisions (pattern id, tool, truncated target, session id) to `~/.claude/hooks-logs/`. No network calls; everything stays on your local machine.

## Uninstall

```
/plugin uninstall config-guard@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
