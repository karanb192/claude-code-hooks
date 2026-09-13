# subagent-spawn-cap

> A total-spawns-per-session budget for subagents: asks from spawn 20, again every 10, denies at 60, counted across nested fan-outs. The cap Claude Code shipped in 2.1.212 and removed in 2.1.224, back as a hook you control.

A `PreToolUse` hook on the `Agent` tool (and its older name `Task`). Every spawn in a session appends one line to a per-session ledger; the line count is the budget spent. Spawn number `SPAWN_CAP_ASK` (default 20) returns `permissionDecision: "ask"`, so you see the count and decide; once approved, the next spawns pass silently until the next check every `SPAWN_CAP_ASK_STEP` spawns (default 10). Spawn number `SPAWN_CAP_DENY` (default 60) returns `"deny"`. With the defaults you are asked at 20, 30, 40 and 50, and the session stops at 60.

Hooks also fire inside subagents, where the input carries `agent_id` and `agent_type` ([common input fields](https://code.claude.com/docs/en/hooks#common-input-fields)). Those events arrive with the parent's `session_id` (observed in local subagent transcripts, whose `sessionId` equals the parent's; the hooks reference does not state it), so a subagent that spawns its own subagents draws from the same budget.

## Why

Claude Code had a native per-session spawn cap from 2.1.212 to 2.1.223. From the [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md):

- 2.1.212: "Added a per-session cap on subagent spawns (default 200, override with `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`) to stop runaway delegation loops; `/clear` resets the budget"
- 2.1.217: "Added a cap on concurrently-running subagents (default 20, override with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`) so one message can't fan out unbounded background agents"
- 2.1.224: "Removed the 200-subagent-per-session spawn cap; long-running sessions no longer refuse new agents (concurrency and depth limits still apply)"

What is left natively bounds the rate (20 at a time) and the nesting depth, not the total. A delegation loop that spawns 20, waits, and spawns 20 more stays inside both limits forever. That is the shape of the runaway reports in the Claude Code tracker: [#92349](https://github.com/anthropics/claude-code/issues/92349) (a settings audit turned into 325 agents), [#91942](https://github.com/anthropics/claude-code/issues/91942) (160 subagents exhausted a 5-hour session limit), [#69206](https://github.com/anthropics/claude-code/issues/69206) (218 spawned where about 10 were intended), [#69578](https://github.com/anthropics/claude-code/issues/69578) (a recursive subagent loop, about 800k tokens). This hook puts a session budget back, under the user's control, with checkpoints before the hard stop.

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
| PreToolUse | `Agent\|Task` | Counts the session's ledger lines, adds one for this call. At `SPAWN_CAP_ASK` and every `SPAWN_CAP_ASK_STEP` after it: appends and returns `"ask"`. At or above `SPAWN_CAP_DENY`: returns `"deny"` without appending. Anything else: appends and returns `{}`. |

Per the [hooks reference](https://code.claude.com/docs/en/hooks#pretooluse-decision-control), an `ask` reason is shown to you, not to Claude, and a `deny` reason is shown to Claude. The two texts are written for those two readers.

What you see in the permission prompt at spawn 20 with the defaults:

```
⚠️ [spawn-cap] Subagent spawn #20 in this session (ask threshold SPAWN_CAP_ASK=20, next check at #30, hard cap SPAWN_CAP_DENY=60). Approve to continue; the next 9 spawns then pass without asking. Deny to stop the fan-out. Reset this session's count by deleting ~/.claude/subagent-spawn-cap/<session_id>.jsonl; change the cadence via SPAWN_CAP_ASK / SPAWN_CAP_ASK_STEP in the settings.json env block (restart needed).
```

What Claude sees at spawn 60:

```
🚨 [spawn-cap] Subagent spawn #60 in this session hit the hard cap (SPAWN_CAP_DENY=60). Do not retry: finish with the results you already have and tell the user the session's spawn budget is spent. The user can reset it by deleting ~/.claude/subagent-spawn-cap/<session_id>.jsonl, or raise SPAWN_CAP_DENY in the settings.json env block and restart.
```

Any other tool returns `{}` before touching the filesystem.

## Configuration

All optional, set via environment variables. Hook processes inherit the environment Claude Code was launched with, so set these in the `env` block of `settings.json` and restart; a shell `export` mid-session does not reach a running Claude Code.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPAWN_CAP_ASK` | `20` | First spawn number that prompts. Positive integer; anything else falls back to the default. |
| `SPAWN_CAP_ASK_STEP` | `10` | Prompt again every this many spawns after `SPAWN_CAP_ASK`, until the cap. `1` prompts on every spawn from the threshold on. Positive integer; anything else falls back to the default. |
| `SPAWN_CAP_DENY` | `60` | Spawn number that denies outright. Positive integer; anything else falls back to the default. If set below `SPAWN_CAP_ASK` it is raised to match (the hard cap can never sit below the ask threshold). Set it equal to `SPAWN_CAP_ASK` to skip the ask stage entirely. |
| `SPAWN_CAP_ALLOW` | unset | Escape hatch: the literal string `true` lets spawns through past both thresholds for as long as it is set. Each one is still recorded in the ledger and logged as `ALLOW_OVERRIDE`, so the count stays truthful. |

`HOOK_SAFETY_LEVEL` is deliberately not read. The repo's `critical` / `high` / `strict` levels select pattern sets for the other guards; mapping them to numbers here would silently change your budget whenever you tune the level for a different guard, and explicit integers are clearer than a hidden level-to-number table.

## Unattended runs

In a `claude -p` run with no permission host, and in `dontAsk` mode, anything that would prompt is denied and Claude is told nobody can approve it ([headless reference](https://code.claude.com/docs/en/headless)). So for an unattended session the ask threshold is the effective hard stop: with the defaults it ends at spawn 20, not 60. Two consequences to plan for:

- Set `SPAWN_CAP_ASK` equal to `SPAWN_CAP_DENY` for CI and other unattended runs, so the budget is one clear number and the deny reason (the one Claude can act on) is what it gets.
- Each denied-ask attempt still appended a ledger line (see State), so a model that keeps retrying climbs to `SPAWN_CAP_DENY` on its own and then gets the deny text.

## State

One append-only JSONL file per session under `~/.claude/subagent-spawn-cap/<session_id>.jsonl`, one line per allowed or asked spawn:

```
{"ts":"2026-09-13T17:10:01.462Z","n":1,"decision":"allow","subagent_type":"general-purpose","description":"x"}
```

Lines from inside a subagent also carry `agent_id` and `agent_type`; bypassed spawns carry `"decision":"bypass"`. Denied calls are not written. An asked call is written before you answer, because `PreToolUse` cannot see the answer: a declined ask still consumed one budget unit, and the next attempt is judged as spawn N+1. Append-only on purpose: parallel tool calls in one assistant turn fire parallel hook processes, and a read-modify-write counter would lose increments where `O_APPEND` writes do not. Ledgers untouched for 7 days are pruned, at most once a day, and a failed prune is never fatal.

To reset a session's budget mid-session, delete its ledger file; the next spawn starts at 1.

## Known limits

- Only spawns that go through the `Agent` tool are seen. A Workflow script or any other path that starts agents without a tool call is invisible to `PreToolUse`.
- Counts key on `session_id`, so a resumed session continues its count (that is the budget working as intended; deleting the ledger resets it).
- Parallel calls in the same turn each read the count before any of them appends, so one batch can overshoot a threshold by up to the native concurrency limit. The next call is judged on the full count.
- A user can raise or bypass the caps. That is the point of env tunables; the model cannot reach them, since hook processes inherit Claude Code's environment, not the Bash tool's, and [config-guard](../config-guard) stops it editing the `env` block in `settings.json`.
- The ledger is a plain file. An agent with Bash could delete `~/.claude/subagent-spawn-cap/` and reset its own count; nothing in this repo protects that directory yet.
- Append atomicity relies on `O_APPEND` semantics, which hold on macOS and Linux for lines this short. On Windows, concurrent appends from separate processes are not guaranteed atomic.
- Session ids are sanitised to `[A-Za-z0-9._-]` for the file name, so two ids that differ only in other characters would share a ledger. Real ids are UUIDs, so this does not arise in practice.

## Data & privacy

Logs ask and deny verdicts (count, thresholds, session id, agent id and type when present), `ALLOW_OVERRIDE` bypasses, and configuration warnings to `~/.claude/hooks-logs/`. The ledger stores the `description` of each spawn, truncated to 80 characters, and the `subagent_type`; never the prompt. No network calls; everything stays on your machine.

## Uninstall

```
/plugin uninstall subagent-spawn-cap@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
