# standup-autopilot

> Writes your daily standup from what your agents actually did across your repos — tasks, tests, PRs, and blockers pulled from session transcripts, not commits or tickets.

On every `Stop` and `SessionEnd`, it parses the session transcript and snapshots the outcome — task summary, git branch and diffstat, test commands with exit codes, opened PRs, and unresolved blockers — to a per-day JSONL ledger. Both events run the same idempotent upsert keyed by `session_id`, so whichever fires last wins. On `SessionStart` (startup), it re-injects the previous ledger day's open blockers into the agent via `additionalContext` and prints a standup-ready card to stderr on the first session of the day. Credential-shaped strings (`ghp_`/`sk-`/`xox` tokens, AWS keys, JWTs, `key=value` secrets) are redacted before anything is written to disk.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install standup-autopilot@claude-code-hooks
```

Restart Claude Code — done. (Or from a shell: `claude plugin install standup-autopilot@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
| --- | --- | --- |
| `SessionStart` (matcher: `startup`) | sync | Re-injects the previous ledger day's unresolved blockers via `additionalContext`; on the first session of the day, prints a standup card to stderr. |
| `Stop` | async (zero added latency) | Snapshots the session's outcome (task, branch + diffstat, tests + exit codes, PRs, blockers) to the day's ledger. |
| `SessionEnd` | sync | Runs the same idempotent upsert as `Stop`, capturing the session's final state. |

`/standup-autopilot:standup` — renders today's standup card: one line per repo (what got done, tests run, PRs, diffstat) plus any unresolved blockers, restated as a ready-to-paste update.

## Configuration

No configuration needed. State lives in `~/.claude/standup/<YYYY-MM-DD>.jsonl` (append-only per-day ledgers, deduped on read by `session_id`); hook run logs go to `~/.claude/hooks-logs/<YYYY-MM-DD>.jsonl`.

## Data & privacy

Recorded: task summaries, git branch/diffstat, test commands and exit codes, PR references, and blocker snippets — all derived from your local session transcripts, with credential-shaped strings redacted before write. Everything stays on your machine; the plugin makes no network calls, ever.

## Uninstall

```
/plugin uninstall standup-autopilot@claude-code-hooks
```
