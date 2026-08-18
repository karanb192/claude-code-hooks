# guard-pack

> All six guard hooks in one Node process. Installing them individually costs six Node startups per matching tool call; the pack pays one. Measured ([bench/RESULTS.md](../../bench/RESULTS.md)): 38 ms median for the pack vs 199 ms for the six guards separately on the same machine.

One PreToolUse registration on `Bash|Read|Edit|MultiEdit|Write` evaluates, in order: [config-guard](../config-guard), [block-dangerous-commands](../block-dangerous-commands), [protect-secrets](../protect-secrets), [protect-tests](../protect-tests), [git-safety](../git-safety), [case-insensitive-guard](../case-insensitive-guard). Cheap string checks run first; the guards that touch the filesystem or spawn git run last. The first blocking verdict wins and is emitted in that guard's own format (same emoji, same `[id]`, same reason text) with a `(via guard-pack)` suffix. A guard that throws is logged and skipped, so one broken guard can never switch off the other five.

The guard scripts in `lib/` are byte-identical copies of the individual plugin scripts, pinned by a test, so the pack can never drift from the standalone guards.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks
/plugin install guard-pack@claude-code-hooks
```

Restart Claude Code, done.

**Do not install the pack alongside the individual guard plugins** (or a manual `settings.json` registration of any of the six): every duplicated guard runs twice on each matching tool call, with double latency and double denials. Pick one or the other.

## Configuration

The pack adds no configuration of its own; the guards' env vars pass straight through because the modules read them directly:

- `HOOK_SAFETY_LEVEL` = `critical` | `high` | `strict`: applies to every guard in the pack uniformly (each falls back to its own default on an invalid value). Want different levels per guard? Install the individual guard plugins instead.
- `HOOK_ASK_CRITICAL` / `HOOK_ASK_HIGH` / `HOOK_ASK_STRICT` = `true`: ask instead of deny, for the guards that support ask mode (config-guard, block-dangerous-commands, protect-secrets, case-insensitive-guard). protect-tests and git-safety always deny.
- `CONFIG_GUARD_ALLOW` = `true`: skips config-guard for an intentional, human-approved config edit. The other five guards still run.

## What gets recorded

One line per verdict in `~/.claude/hooks-logs/` (guard name, rule id, decision, tool). The pack makes no network calls; everything stays on your machine.
