# block-dangerous-commands

> PreToolUse guard for Bash: blocks dangerous shell commands (rm -rf ~, fork bombs, curl|sh, force push to main) before they run.

A `PreToolUse` hook fires before every `Bash` call and tests the command against a curated pattern list: rm targeting home/root/system directories or the cwd, dd to disk devices, mkfs, fork bombs, curl/wget piped to shell, force push to main/master, `git reset --hard`, `git clean -f`, chmod 777, docker volume deletion, and more. On a match it denies the call and shows the pattern id and reason, so Claude knows exactly why. Three safety levels control how much is blocked, and per-level ask mode turns a hard deny into a prompt you approve or reject. Every block/ask is logged to `~/.claude/hooks-logs/<date>.jsonl`.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install block-dangerous-commands@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install block-dangerous-commands@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PreToolUse (`Bash`) | sync (must finish before the command runs) | Tests the command against every pattern at or below the configured safety level; on a match returns `permissionDecision: "deny"` (or `"ask"` in ask mode) with the pattern id and reason, and logs the event. Safe commands pass through untouched. |

## Safety levels

| Level      | What's blocked                                              | Use case            |
|------------|-------------------------------------------------------------|---------------------|
| `critical` | Catastrophic only (rm -rf ~, fork bombs, dd to disk)        | Maximum flexibility |
| `high`     | + Risky (force push main, git reset --hard, curl\|sh)       | **Recommended, default** |
| `strict`   | + Cautionary (any force push, sudo rm, docker prune)        | Maximum safety      |

Set the level via `HOOK_SAFETY_LEVEL` (see below). Don't edit the installed script: plugin updates overwrite it.

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`. |
| `HOOK_ASK_CRITICAL` | unset (deny) | The literal string `true` makes `critical`-level matches prompt instead of deny. |
| `HOOK_ASK_HIGH` | unset (deny) | Same, for `high`-level matches. |
| `HOOK_ASK_STRICT` | unset (deny) | Same, for `strict`-level matches. |

Ask mode is strictly opt-in and per level: only the literal string `true` enables it (`"1"` does not), and enabling it for one level never softens another. A common setup: keep `critical` on deny, set `HOOK_ASK_STRICT=true` so cautionary patterns prompt instead of blocking.

Pair it with `protect-secrets` for coverage of secrets exposure (cat .env, printenv, ~/.ssh reads): that lives in a separate hook by design.

## Data & privacy

Blocked/asked commands are logged (with pattern id, level, decision, and session metadata) to `~/.claude/hooks-logs/<date>.jsonl`. It makes no network calls (the script only uses `fs` and `path`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall block-dangerous-commands@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
