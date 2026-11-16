# guard-pack

> All seven guard hooks in one Node process. Installing them individually costs seven Node startups per matching tool call; the pack pays one. Measured ([bench/RESULTS.md](../../bench/RESULTS.md)): 38 ms median for the pack vs 199 ms for the six pattern guards separately on the same machine, before the spawn cap joined.

One PreToolUse registration on `Bash|Read|Edit|MultiEdit|Write|Agent|Task|Grep` evaluates, in order: [subagent-spawn-cap](../subagent-spawn-cap), [config-guard](../config-guard), [block-dangerous-commands](../block-dangerous-commands), [protect-secrets](../protect-secrets), [protect-tests](../protect-tests), [git-safety](../git-safety), [case-insensitive-guard](../case-insensitive-guard). The spawn cap goes first because its filter is one cached module load and a single tool-name compare and, on an `Agent` call, it is the only guard that applies; after it, cheap string checks run before the guards that touch the filesystem or spawn git. The first deny wins. An ask does not stop the pack: the remaining guards still run, and a later deny replaces the ask, the same deny-over-ask precedence Claude Code applies when the standalone hooks run side by side. The winning verdict is emitted in that guard's own format (same emoji, same `[id]`, same reason text) with a `(via guard-pack)` suffix. A guard that throws is logged and skipped, so one broken guard can never switch off the other six.

The guard scripts in `lib/` are byte-identical copies of the individual plugin scripts, pinned by a test, so the pack can never drift from the standalone guards.

`Grep` reaches protect-secrets through the same checks as the standalone plugin, including Windows paths and directory/filter combinations. Its [search limitations](../protect-secrets#search-and-windows-coverage) also apply here; broad searches can still expose secrets.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks
/plugin install guard-pack@claude-code-hooks
```

Restart Claude Code, done.

**Do not install the pack alongside the individual guard plugins** (or a manual `settings.json` registration of any of the seven): every duplicated guard runs twice on each matching tool call, with double latency, double denials, and for the spawn cap a double-counted budget. Pick one or the other.

## Codex CLI

From 1.3.0 the pack also runs in Codex CLI.

```
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add guard-pack@claude-code-hooks
```

Then open `/hooks` in Codex and approve guard-pack. Codex skips a hook nobody has approved, and it skips the pack again after every update until you approve the new version.

What changes under Codex:

- **Edits are checked through the patch.** Codex makes every file edit through one `apply_patch` tool. The pack reads the patch and checks each file as Claude Code's `Write` (new file), `Edit` (changed file) or a shell `rm` / `mv` (deleted or moved file), so the same rules apply. A patch it cannot read is blocked with `[unreadable-patch]` instead of being let through. A patch run from the shell (`apply_patch <<'EOF'`) is checked the same way.
- **Ask becomes a block.** Codex hooks cannot ask, so a guard set to ask (`HOOK_ASK_*`) blocks, and its reason says why.
- **Six guards, not seven.** The subagent spawn cap is not registered on Codex yet.
- **Reads are shell commands.** Codex has no Read or Grep tool, so protect-secrets sees a read only when the command names the file.
- **Codex's own config is only partly covered.** config-guard blocks writes to any `hooks.json`, `.codex/hooks.json` included, but not to `~/.codex/config.toml`.

The answer to Codex is exit code 2 with the reason on stderr, which Codex treats as a block. As on Claude Code, a crash in the pack lets the tool run. Log lines from Codex carry `"host":"codex"`. Checked live on Codex CLI 0.169.0 through a marketplace install: [bench/codex-live/RESULTS.md](../../bench/codex-live/RESULTS.md).

## Configuration

The pack adds no configuration of its own; the guards' env vars pass straight through because the modules read them directly:

- `HOOK_SAFETY_LEVEL` = `critical` | `high` | `strict`: applies to the six pattern guards uniformly (each falls back to its own default on an invalid value). Want different levels per guard? Install the individual guard plugins instead. `subagent-spawn-cap` does not read it; see its own knobs below.
- `HOOK_ASK_CRITICAL` / `HOOK_ASK_HIGH` / `HOOK_ASK_STRICT` = `true`: ask instead of deny, for the guards that support ask mode (config-guard, block-dangerous-commands, protect-secrets, case-insensitive-guard). protect-tests and git-safety always deny.
- `CONFIG_GUARD_ALLOW` = `true`: skips config-guard for an intentional, human-approved config edit. The other six guards still run.
- `SPAWN_CAP_ASK` (default 20) / `SPAWN_CAP_ASK_STEP` (default 10) / `SPAWN_CAP_DENY` (default 60): per session, the pack asks at spawn 20 and every 10 after that (30, 40, 50) and denies at 60. `SPAWN_CAP_ALLOW` = `true` lets spawns through for as long as it is set; each is still counted and logged `ALLOW_OVERRIDE`. Unattended (`-p` or `dontAsk`) runs cannot answer an ask, so there the ask threshold is the hard stop: set `SPAWN_CAP_ASK` equal to `SPAWN_CAP_DENY` for those. Details in the [subagent-spawn-cap README](../subagent-spawn-cap).

## What gets recorded

One line per verdict in `~/.claude/hooks-logs/` (guard name, rule id, decision, tool; for the spawn cap also the count and thresholds). The spawn cap writes its own `ALLOW_OVERRIDE` and clamp `WARN` lines on the pack path too, and keeps its per-session ledger under `~/.claude/subagent-spawn-cap/`. The pack makes no network calls; everything stays on your machine.
