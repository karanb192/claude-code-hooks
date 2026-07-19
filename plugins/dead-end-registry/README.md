# dead-end-registry

> Remembers approaches you tried and reverted (with reason and estimated token cost) and warns before you retry them.

On `Stop`, `SubagentStop`, and `PreCompact` the hook mines the session transcript for approaches you TRIED and then REVERTED or ruled out, recording each with its reason, date, and an estimated token cost of the detour into a per-repo registry. On `UserPromptSubmit` it keyword-matches the new prompt against that registry and injects a "DEAD END — you already tried this" card via `additionalContext`. On `PreToolUse` (Edit|Write) it returns an `ask` decision when the pending diff would reintroduce a previously-reverted hunk. Extraction is deterministic (revert-signal heuristics plus tool-result scanning); an optional model pass is never required and never runs in tests.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install dead-end-registry@claude-code-hooks
```

Restart Claude Code — done. (Or from a shell: `claude plugin install dead-end-registry@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| UserPromptSubmit | sync | Matches the prompt against the registry; injects a "you already tried this" warning card when it hits a recorded dead end. |
| PreToolUse (Edit\|Write) | sync | Returns permission decision `ask` when the diff would reintroduce a previously-reverted hunk. |
| Stop | async (zero added latency) | Mines the transcript for abandoned approaches into the per-repo registry. |
| SubagentStop | async (zero added latency) | Same mining, at subagent stop. |
| PreCompact | async (zero added latency) | Same mining, before context is compacted away. |

`/dead-end-registry:dead-ends` — renders this repo's recorded dead ends, newest first, each with the date tried, why it was walked back, and the estimated token cost of the detour.

## Configuration

No environment variables. Behavior is governed by in-source constants with these defaults:

- `MAX_AGE_DAYS` = 60 — entries older than this are ignored on read and dropped at compaction.
- `MAX_CARD_ENTRIES` = 3 — entries shown in an injected card.
- `MAX_REGISTRY_ENTRIES` = 500 — entries scanned on prompt-submit.
- `MAX_CODE_LINES` = 80 / `MAX_CODE_CHARS` = 4000 — truncation caps on stored code snapshots.
- `USD_PER_TOKEN` = 0.000009 — rough blended rate for the headline cost figure.

State is stored per-project (keyed by a hash of the repo path) under `~/.claude/dead-end-registry/<repo>.jsonl`, outside the repo so nothing is accidentally committed.

## Data & privacy

Recorded: short summaries and truncated code snapshots of reverted approaches, plus reason, date, and an estimated token cost, all mined from your local transcripts. Everything stays on your machine — the hook makes no network calls.

## Uninstall

```
/plugin uninstall dead-end-registry@claude-code-hooks
```
