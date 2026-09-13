# subagent-spawn-cap

> A total-spawns-per-session budget for subagents: asks at 20, denies at 60, counted across nested fan-outs. The cap Claude Code shipped in 2.1.212 and removed in 2.1.224, back as a hook you control.

A `PreToolUse` hook on the `Agent` tool (and its older name `Task`). Every spawn in a session appends one line to a per-session ledger; the line count is the budget spent. When the next spawn would be number `SPAWN_CAP_ASK` (default 20) the hook returns `permissionDecision: "ask"`, so you see the count and decide. When it would be number `SPAWN_CAP_DENY` (default 60) it returns `"deny"`. Hooks also fire inside subagents and carry the same `session_id` ([hooks reference](https://code.claude.com/docs/en/hooks#common-input-fields)), so a subagent that spawns its own subagents draws from the same budget.

## Why

Claude Code had a native per-session spawn cap for twelve releases. From the [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md):

- 2.1.212: "Added a per-session cap on subagent spawns (default 200, override with `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`) to stop runaway delegation loops; `/clear` resets the budget"
- 2.1.217: "Added a cap on concurrently-running subagents (default 20, override with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) so one message can't fan out unbounded background agents"
- 2.1.224: "Removed the 200-subagent-per-session spawn cap; long-running sessions no longer refuse new agents (concurrency and depth limits still apply)"

What is left natively bounds the rate (20 at a time) and the nesting depth, not the total. A delegation loop that spawns 20, waits, and spawns 20 more stays inside both limits forever. That is the shape of the runaway reports in the Claude Code tracker: [#92349](https://github.com/anthropics/claude-code/issues/92349) (a settings audit turned into 325 agents), [#91942](https://github.com/anthropics/claude-code/issues/91942) (160 subagents exhausted a 5-hour session limit), [#69206](https://github.com/anthropics/claude-code/issues/69206) (218 spawned where about 10 were intended), [#69578](https://github.com/anthropics/claude-code/issues/69578) (a recursive subagent loop, about 800k tokens). This hook puts a session budget back, under the user's control, with an ask stage before the hard stop.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install subagent-spawn-cap@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install subagent-spawn-cap@claude-code-hooks`.)

Already running [guard-pack](../guard-pack)? It includes this guard; do not install both.

## What it does

| Event | Matcher | What happens |
|-------|---------|--------------|
| PreToolUse | `Agent\|Task` | Counts the session's ledger lines, adds one for this call. Below `SPAWN_CAP_ASK`: appends and returns `{}`. At or above `SPAWN_CAP_ASK`: appends and returns `"ask"` with the count, both thresholds, and the escape hatch. At or above `SPAWN_CAP_DENY`: returns `"deny"` without appending. |

What the agent sees at spawn 20 with the defaults:

```
⚠️ [spawn-cap] Subagent spawn #20 in this session reached the ask threshold (SPAWN_CAP_ASK=20; hard cap SPAWN_CAP_DENY=60). Approve to continue, raise SPAWN_CAP_ASK to stop being asked, or set SPAWN_CAP_ALLOW=true for this one call.
```

Any other tool returns `{}` before touching the filesystem.

## Configuration

All optional, set via environment variables (the `env` block in `settings.json` applies them to every session):

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPAWN_CAP_ASK` | `20` | Spawn number that starts prompting. Positive integer; anything else falls back to the default. |
| `SPAWN_CAP_DENY` | `60` | Spawn number that denies outright. Positive integer; anything else falls back to the default. If set below `SPAWN_CAP_ASK` it is raised to match (the hard cap can never sit below the ask threshold). Set it equal to `SPAWN_CAP_ASK` to skip the ask stage. |
| `SPAWN_CAP_ALLOW` | unset | Escape hatch: the literal string `true` lets this one call through past either threshold. The spawn is still recorded, so the count stays truthful and the next call is judged normally. |

`HOOK_SAFETY_LEVEL` is deliberately not read. The repo's `critical` / `high` / `strict` levels select pattern sets for the other guards; mapping them to numbers here would silently change your budget whenever you tune the level for a different guard, and two explicit integers are clearer than a hidden level-to-number table.

## State

One append-only JSONL file per session under `~/.claude/subagent-spawn-cap/<session_id>.jsonl`, one line per allowed or asked spawn:

```
{"ts":"2026-09-13T17:10:01.462Z","n":1,"decision":"allow","subagent_type":"general-purpose","description":"x"}
```

Lines from inside a subagent also carry `agent_id` and `agent_type`. Denied calls are not written. Append-only on purpose: parallel tool calls in one assistant turn fire parallel hook processes, and a read-modify-write counter would lose increments where `O_APPEND` writes do not. Ledgers untouched for 7 days are pruned, at most once a day, and a failed prune is never fatal.

## Known limits

- Only spawns that go through the `Agent` tool are seen. A Workflow script or any other path that starts agents without a tool call is invisible to `PreToolUse`.
- Counts key on `session_id`, so a resumed session continues its count (that is the budget working as intended; `rm ~/.claude/subagent-spawn-cap/<id>.jsonl` resets it).
- Parallel calls in the same turn each read the count before any of them appends, so one batch can overshoot a threshold by up to the native concurrency limit. The next call is judged on the full count.
- A user can raise or bypass the caps. That is the point of env tunables; the model cannot, since hooks run outside it and [config-guard](../config-guard) stops it editing `settings.json`.
- Append atomicity relies on `O_APPEND` semantics, which hold on macOS and Linux for lines this short. On Windows, concurrent appends from separate processes are not guaranteed atomic.

## Data & privacy

Logs ask and deny verdicts (count, thresholds, session id, agent id and type when present) to `~/.claude/hooks-logs/`. The ledger stores the `description` of each spawn, truncated to 80 characters, and the `subagent_type`; never the prompt. No network calls; everything stays on your machine.

## Uninstall

```
/plugin uninstall subagent-spawn-cap@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
