# guard-pack

> All seven guard hooks in one Node process. Installing them individually costs seven Node startups per matching tool call; the pack pays one. Measured ([bench/RESULTS.md](../../bench/RESULTS.md)): 38 ms median for the pack vs 199 ms for the six pattern guards separately on the same machine, before the spawn cap joined.

One PreToolUse registration on `Bash|Read|Edit|MultiEdit|Write|Agent|Task|Grep` evaluates, in order: [subagent-spawn-cap](../subagent-spawn-cap), [config-guard](../config-guard), [block-dangerous-commands](../block-dangerous-commands), [protect-secrets](../protect-secrets), [protect-tests](../protect-tests), [git-safety](../git-safety), [case-insensitive-guard](../case-insensitive-guard). The spawn cap goes first because its filter is one cached module load and a single tool-name compare and, on an `Agent` call, it is the only guard that applies; after it, cheap string checks run before the guards that touch the filesystem or spawn git. The first deny wins. An ask does not stop the pack: the remaining guards still run, and a later deny replaces the ask, the same deny-over-ask precedence Claude Code applies when the standalone hooks run side by side. The winning verdict is emitted in that guard's own format (same emoji, same `[id]`, same reason text) with a `(via guard-pack)` suffix. A guard that throws is logged and skipped, so one broken guard can never switch off the other six.

The guard scripts in `lib/` are byte-identical copies of the individual plugin scripts, pinned by a test, so the pack can never drift from the standalone guards.

The pack also guards its own install. Through config-guard, the agent cannot edit, overwrite, move or delete the installed plugin files under `~/.claude/plugins/` (or a custom `CLAUDE_CONFIG_DIR`), write `~/.claude.json`, or reset the spawn cap by deleting its ledger. Reads pass, and installing, updating or removing plugins yourself through `/plugin` is untouched. Details and limits: [config-guard](../config-guard#known-limits).

`Grep` reaches protect-secrets through the same checks as the standalone plugin, including Windows paths and directory/filter combinations. Its [search limitations](../protect-secrets#search-and-windows-coverage) also apply here; broad searches can still expose secrets.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks
/plugin install guard-pack@claude-code-hooks
```

Restart Claude Code, done.

**Do not install the pack alongside the individual guard plugins** (or a manual `settings.json` registration of any of the seven): every duplicated guard runs twice on each matching tool call, with double latency, double denials, and for the spawn cap a double-counted budget. Pick one or the other.

## Codex CLI

From 1.3.0 the pack also runs in Codex CLI. Version 1.4.0 adds the spawn cap and Codex configuration protection; each of the seven guards also has its own Codex entry point.

In 1.7.0, block-dangerous-commands, git-safety and protect-secrets share a shell reader. It recognizes common quoting, escaping and variable assignments. It skips literal text in supported message and heredoc forms. See [how it reads a command and its limits](../block-dangerous-commands#how-it-reads-a-command).

```
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add guard-pack@claude-code-hooks
```

Then open `/hooks` in Codex and approve guard-pack. Codex skips a hook nobody has approved, and it skips the pack again after every update until you approve the new version.

What changes under Codex:

- **Edits are checked through the patch.** The pack reads Codex's native `apply_patch` input and checks each file as Claude Code's `Write` (new file), `Edit` (changed file) or a shell `rm` / `mv` (deleted or moved file). A patch it cannot read is blocked with `[unreadable-patch]`. A moved file also gets a destination Write check using its added lines; this conservative approximation can reject a move onto an existing test file.
- **Shell patches accept only literal quoted heredocs.** Use plain `apply_patch <<'EOF'` or `applypatch <<'EOF'`, with the full patch and closing delimiter on separate lines. Multiple such commands on separate lines are supported. Detected patch calls using other forms, including wrappers, expansions, pipes and file redirection, are blocked. Detection recognises common command positions, quoting and wrappers; it is not a shell interpreter and cannot resolve aliases or dynamically constructed command names. Prefer the native patch tool.
- **Ask becomes a block.** Codex hooks cannot ask, so a guard set to ask (`HOOK_ASK_*`) blocks, and its reason says why.
- **Seven guards, with a per-thread spawn budget.** `spawn_agent` is counted without an ask tier: `SPAWN_CAP_DENY=60` permits the first 59 calls and denies the 60th. Resuming a thread keeps its count; nested threads have separate budgets. Parallel calls can overshoot the threshold. See [the cap's Codex policy](../subagent-spawn-cap#codex-cli).
- **Reads are shell commands.** Codex has no Read or Grep tool, so protect-secrets sees a read only when the command names the file.
- **Typing into an open shell is not checked.** Codex does not send hooks the input it types into a shell session it already started, so a command entered that way runs unchecked.
- **Codex configuration is protected.** config-guard checks `.codex/config.toml`, installed plugins under `.codex/plugins/`, and a custom `CODEX_HOME`. The installed Claude Code plugins under `~/.claude/plugins/` are protected from a Codex agent too. It also checks `.codex-plugin/` manifests at `high` and `AGENTS.md` / `AGENTS.override.md` at `strict`. Native patches resolve paths against the event's working directory and follow symlinks. Shell checks remain text-based, with [known limits](../config-guard#known-limits).

The answer to Codex is exit code 2 with the reason on stderr, which Codex treats as a block. A guard that throws blocks the call there too (see [When the pack fails](#when-the-pack-fails)). Log lines from Codex carry `"host":"codex"` in `~/.claude/hooks-logs/`, creating that directory even on a Codex-only setup. Checked live on Codex CLI 0.169.0 through a marketplace install, and the patch reader against Codex's own patch engine: [bench/codex-live/RESULTS.md](../../bench/codex-live/RESULTS.md).

## Configuration

The pack adds no configuration of its own; the guards' env vars pass straight through because the modules read them directly. Export them before launching Codex. The ask cadence below applies to Claude Code; Codex uses the deny-only policy above:

- `HOOK_SAFETY_LEVEL` = `critical` | `high` | `strict`: applies to the six pattern guards uniformly (each falls back to its own default on an invalid value). Want different levels per guard? Install the individual guard plugins instead. `subagent-spawn-cap` does not read it; see its own knobs below.
- `HOOK_ASK_CRITICAL` / `HOOK_ASK_HIGH` / `HOOK_ASK_STRICT` = `true`: ask instead of deny, for the guards that support ask mode (config-guard, block-dangerous-commands, protect-secrets, case-insensitive-guard). protect-tests and git-safety always deny.
- `CONFIG_GUARD_ALLOW` = `true`: skips config-guard for an intentional, human-approved config edit. The other six guards still run.
- `HOOK_FAIL_OPEN` = `true`: a guard whose check throws is skipped, as before 1.5.0, instead of denying the call. See [When the pack fails](#when-the-pack-fails).
- `SPAWN_CAP_ASK` (default 20) / `SPAWN_CAP_ASK_STEP` (default 10) / `SPAWN_CAP_DENY` (default 60): per session, the pack asks at spawn 20 and every 10 after that (30, 40, 50) and denies at 60. `SPAWN_CAP_ALLOW` = `true` lets spawns through for as long as it is set; each is still counted and logged `ALLOW_OVERRIDE`. Unattended (`-p` or `dontAsk`) runs cannot answer an ask, so there the ask threshold is the hard stop: set `SPAWN_CAP_ASK` equal to `SPAWN_CAP_DENY` for those. Details in the [subagent-spawn-cap README](../subagent-spawn-cap).

## When the pack fails

From 1.5.0, a pack that cannot finish its checks refuses the call instead of allowing it:

- **A guard throws.** The other guards still run, so a real deny keeps its own reason. If none denies, the call is denied with a `[guard-error]` reason naming the broken guard and its error.
- **The pack runs past its 10 s timeout, or cannot start** (`node` missing from PATH). Claude Code v2.1.295 or later blocks the call because the hook sets `"onFailure": "block"`; older versions ignore that key and let the call run. On Codex the command ends in `|| exit 2`, so a missing `node` blocks, but a timeout still lets the call run: Codex has no setting for it.

`HOOK_FAIL_OPEN=true` restores the old behaviour for a throwing guard. [When a guard fails](../../README.md#-when-a-guard-fails) covers the timeout and missing-`node` cases.

## What gets recorded

One line per verdict in `~/.claude/hooks-logs/` (guard name, rule id, decision, tool; for the spawn cap also the count and thresholds). The spawn cap writes its own `ALLOW_OVERRIDE` and clamp `WARN` lines on the pack path too, and keeps its per-session ledger under `~/.claude/subagent-spawn-cap/`. The pack makes no network calls; everything stays on your machine.
