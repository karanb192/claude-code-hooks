# subagent-spawn-cap

> A total-spawns-per-session budget for subagents: asks from spawn 20, again every 10, denies at 60, counted across nested fan-outs. The cap Claude Code shipped in 2.1.212 and removed in 2.1.224, back as a hook you control.

A `PreToolUse` hook on the `Agent` tool (older name `Task`). Every spawn in a session appends one line to a per-session ledger; the line count is the budget spent. Spawn `SPAWN_CAP_ASK` (default 20) prompts you, then every `SPAWN_CAP_ASK_STEP` spawns (default 10) prompts again, and spawn `SPAWN_CAP_DENY` (default 60) is denied. Hooks also fire inside subagents ([`agent_id` / `agent_type`](https://code.claude.com/docs/en/hooks#common-input-fields)) with the parent's `session_id` (observed in local subagent transcripts; the docs do not state it), so nested fan-outs share the budget.

**Why:** Claude Code had this cap natively from 2.1.212 ("Added a per-session cap on subagent spawns (default 200, override with `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`)") to 2.1.224 ("Removed the 200-subagent-per-session spawn cap; long-running sessions no longer refuse new agents (concurrency and depth limits still apply)"), per the [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md). The remaining native caps bound the rate (20 concurrent) and depth, not the total, which is the shape of [#92349](https://github.com/anthropics/claude-code/issues/92349) (325 agents for a settings audit), [#91942](https://github.com/anthropics/claude-code/issues/91942) (160 subagents, session limit exhausted), [#69206](https://github.com/anthropics/claude-code/issues/69206) (218 spawned, about 10 intended) and [#69578](https://github.com/anthropics/claude-code/issues/69578) (recursive loop, about 800k tokens).

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install subagent-spawn-cap@claude-code-hooks
```

Restart Claude Code, done. Already running [guard-pack](../guard-pack)? It includes this guard; do not install both.

## What it does

| Event | Matcher | What happens |
|-------|---------|--------------|
| PreToolUse | `Agent\|Task` | Counts the session's ledger lines plus this call. At `SPAWN_CAP_ASK` and every `SPAWN_CAP_ASK_STEP` after it: appends, returns `"ask"`. At or above `SPAWN_CAP_DENY`: returns `"deny"`, no append. Otherwise: appends, returns `{}`. Other tools: `{}` with no filesystem work. |

Per the [hooks reference](https://code.claude.com/docs/en/hooks#pretooluse-decision-control) an `ask` reason is shown to you and a `deny` reason to Claude, so the two texts have different readers. What you see in the permission prompt at spawn 20:

```
⚠️ [spawn-cap] Subagent spawn #20 in this session (ask threshold SPAWN_CAP_ASK=20, next check at #30, hard cap SPAWN_CAP_DENY=60). Approve to continue; the next 9 spawns then pass without asking. Deny to stop the fan-out. Reset this session's count by deleting ~/.claude/subagent-spawn-cap/<session_id>.jsonl; change the cadence via SPAWN_CAP_ASK / SPAWN_CAP_ASK_STEP in the settings.json env block (restart needed).
```

What Claude sees at spawn 60:

```
🚨 [spawn-cap] Subagent spawn #60 in this session hit the hard cap (SPAWN_CAP_DENY=60). Do not retry: finish with the results you already have and tell the user the session's spawn budget is spent. The user can reset it by deleting ~/.claude/subagent-spawn-cap/<session_id>.jsonl, or raise SPAWN_CAP_DENY in the settings.json env block and restart.
```

## Configuration

Hook processes inherit the environment Claude Code was launched with: set these in the `env` block of `settings.json` and restart. Invalid values fall back to the default.

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPAWN_CAP_ASK` | `20` | First spawn number that prompts. Positive integer. |
| `SPAWN_CAP_ASK_STEP` | `10` | Prompt again every this many spawns after `SPAWN_CAP_ASK`; `1` prompts on every spawn. Positive integer. |
| `SPAWN_CAP_DENY` | `60` | Spawn number denied outright. Clamped up to `SPAWN_CAP_ASK` if set lower; equal to it skips the ask stage. |
| `SPAWN_CAP_ALLOW` | unset | The literal string `true` lets spawns through past both thresholds while set; each is still recorded and logged `ALLOW_OVERRIDE`. |

`HOOK_SAFETY_LEVEL` is not read: the repo's levels pick pattern sets, a budget is a number, and a hidden level-to-number table would move your budget whenever you tune the level for another guard.

**Unattended runs.** In `claude -p` with no permission host and in `dontAsk` mode, anything that would prompt is denied ([headless reference](https://code.claude.com/docs/en/headless)), so the ask threshold is the effective hard stop: with the defaults an unattended session ends at spawn 20, not 60. Set `SPAWN_CAP_ASK` equal to `SPAWN_CAP_DENY` for CI so Claude gets the deny text it can act on.

## State

One append-only JSONL per session at `~/.claude/subagent-spawn-cap/<session_id>.jsonl`, one line per allowed or asked spawn (`ts`, `n`, `decision`, `subagent_type`, `description` truncated to 80 chars, plus `agent_id` / `agent_type` inside subagents). Append-only because parallel tool calls in one turn fire parallel hook processes; `O_APPEND` writes survive that, a read-modify-write counter does not. Denied calls are not written. An asked call is written before you answer, so a declined ask still consumed one budget unit. Ledgers untouched for 7 days are pruned, at most once a day. Delete a session's file to reset its budget.

## Known limits

- Only spawns through the `Agent` tool are seen; a Workflow script or other non-tool path is invisible to `PreToolUse`.
- Counts key on `session_id`, so a resumed session continues its count.
- Parallel calls in one turn each read the count before any appends; a batch can overshoot a threshold by up to the native concurrency limit, and the next call is judged on the full count.
- The ledger is a plain file; an agent with Bash could delete it. [config-guard](../config-guard) does not cover that directory yet.
- Session ids are sanitised to `[A-Za-z0-9._-]` for the file name; ids differing only in other characters share a ledger. Real ids are UUIDs.
- `O_APPEND` atomicity holds on macOS and Linux for lines this short; Windows makes no cross-process guarantee.

## Data & privacy

Verdicts (count, thresholds, session id, agent id and type), `ALLOW_OVERRIDE` bypasses and config warnings go to `~/.claude/hooks-logs/`. The ledger never stores the prompt. No network calls.

## Uninstall

```
/plugin uninstall subagent-spawn-cap@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
