# nerf-receipts

> A personal flight recorder for Claude Code quality — records your own per-session failure rate, edit churn, and tokens/task by model version, and flags real shifts when a model changes.

nerf-receipts registers on six hook events. As you work, `PostToolUse` and `PostToolUseFailure` count every tool call, its failures, and same-file edit churn; `Stop` and `SubagentStop` count turn-end events — all async, so they add no latency. At `SessionEnd` it parses token usage from the session transcript, finalizes four per-session signals (tool-failure rate, edit churn, turn-end count, tokens-per-completed-task), and appends one record to a JSONL ledger. At `SessionStart` it renders a trend card — a sparkline per metric, keyed by model id and Claude Code version — and flags meaningful shifts (>=25% relative change in the mean) that coincide with a model change. The same card is available on demand via `/nerf-receipts:receipts`.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install nerf-receipts@claude-code-hooks
```

Restart Claude Code — done. (Or from a shell: `claude plugin install nerf-receipts@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
| ----- | ---- | ------------ |
| `PostToolUse` | async (zero added latency) | Counts every tool call; records failures and same-file edit churn |
| `PostToolUseFailure` | async (zero added latency) | Counts tool-call failures and edit churn |
| `Stop` | async (zero added latency) | Counts turn-end events |
| `SubagentStop` | async (zero added latency) | Counts subagent turn-end events |
| `SessionEnd` | sync | Parses transcript tokens, finalizes the session, appends the record to the ledger |
| `SessionStart` | sync | Renders the trend card and flags model-change shifts via `additionalContext` |

`/nerf-receipts:receipts` — renders the model-quality trend card on demand (failure rate, edit churn, tokens/task by model version, each with a sparkline).

## Configuration

No environment variables. Tuning constants live at the top of `nerf-receipts.js`:

- `MIN_SESSIONS_FOR_TREND` = 6 — sessions required before a trend or shift is reported
- `TREND_WINDOW` = 200 — most recent sessions the trend card considers
- `MAX_TRANSCRIPT_LINES` = 20000 and `MAX_TRANSCRIPT_BYTES` = 16 MiB — caps on transcript parsing

State is stored as a JSONL ledger under `~/.claude/nerf-receipts/` (per-session in-flight logs under `~/.claude/nerf-receipts/sessions/`); event logs go to `~/.claude/hooks-logs/<date>.jsonl`.

## Data & privacy

Only counts and edited file paths are recorded — tool inputs, commands, and transcript text are never persisted, so secrets in commands cannot land in the ledger. The script makes no network calls (it requires only `fs`, `path`, and `os`); everything stays on your local machine.

## Uninstall

```
/plugin uninstall nerf-receipts@claude-code-hooks
```
