# guard-pack

> All seven guard hooks in one Node process. Installing them individually costs seven Node startups per matching tool call; the pack pays one. Measured ([bench/RESULTS.md](../../bench/RESULTS.md)): 38 ms median for the pack vs 199 ms for the six pattern guards separately on the same machine, before the spawn cap joined.

One PreToolUse registration on `Bash|Read|Edit|MultiEdit|Write|Agent|Task` evaluates, in order: [subagent-spawn-cap](../subagent-spawn-cap), [config-guard](../config-guard), [block-dangerous-commands](../block-dangerous-commands), [protect-secrets](../protect-secrets), [protect-tests](../protect-tests), [git-safety](../git-safety), [case-insensitive-guard](../case-insensitive-guard). The spawn cap goes first because its filter is a single tool-name compare and, on an `Agent` call, it is the only guard that applies; after it, cheap string checks run before the guards that touch the filesystem or spawn git. The first blocking verdict wins and is emitted in that guard's own format (same emoji, same `[id]`, same reason text) with a `(via guard-pack)` suffix. A guard that throws is logged and skipped, so one broken guard can never switch off the other six.

The guard scripts in `lib/` are byte-identical copies of the individual plugin scripts, pinned by a test, so the pack can never drift from the standalone guards.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks
/plugin install guard-pack@claude-code-hooks
```

Restart Claude Code, done.

**Do not install the pack alongside the individual guard plugins** (or a manual `settings.json` registration of any of the seven): every duplicated guard runs twice on each matching tool call, with double latency, double denials, and for the spawn cap a double-counted budget. Pick one or the other.

## Configuration

The pack adds no configuration of its own; the guards' env vars pass straight through because the modules read them directly:

- `HOOK_SAFETY_LEVEL` = `critical` | `high` | `strict`: applies to the six pattern guards uniformly (each falls back to its own default on an invalid value). Want different levels per guard? Install the individual guard plugins instead. `subagent-spawn-cap` does not read it; see its own knobs below.
- `HOOK_ASK_CRITICAL` / `HOOK_ASK_HIGH` / `HOOK_ASK_STRICT` = `true`: ask instead of deny, for the guards that support ask mode (config-guard, block-dangerous-commands, protect-secrets, case-insensitive-guard). protect-tests and git-safety always deny.
- `CONFIG_GUARD_ALLOW` = `true`: skips config-guard for an intentional, human-approved config edit. The other six guards still run.
- `SPAWN_CAP_ASK` (default 20) / `SPAWN_CAP_DENY` (default 60): the subagent spawn numbers at which the pack asks, then denies, per session. `SPAWN_CAP_ALLOW` = `true` lets one spawn through; it is still counted. Details in the [subagent-spawn-cap README](../subagent-spawn-cap).

## What gets recorded

One line per verdict in `~/.claude/hooks-logs/` (guard name, rule id, decision, tool). The spawn cap also keeps its per-session ledger under `~/.claude/subagent-spawn-cap/`. The pack makes no network calls; everything stays on your machine.
