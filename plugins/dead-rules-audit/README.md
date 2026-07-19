# dead-rules-audit

> A CLAUDE.md compliance scorecard that tallies which rules Claude actually follows vs ignores as you edit, and flags chronically-ignored rules to promote into a deterministic hook.

At SessionStart it finds the nearest CLAUDE.md and parses it into numbered atomic rules, snapshotting which loaded this session. On every Edit/MultiEdit/Write a PostToolUse hook scores the change against each rule and tallies — per rule — how often it was relevant and whether it was followed or violated, appending to a local JSONL ledger. The judgement is a deterministic keyword/pattern heuristic: no model call, no network. At SessionEnd it renders a worst-first compliance scorecard (rule text, times relevant, times violated, compliance %, and a `⚠ promote→hook` flag for chronically-ignored rules) and persists it. You can also re-render on demand.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install dead-rules-audit@claude-code-hooks
```

Restart Claude Code — done. (Or from a shell: `claude plugin install dead-rules-audit@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| SessionStart | sync | Parse CLAUDE.md into numbered atomic rules; snapshot which rules loaded this session. |
| PostToolUse (`Edit\|MultiEdit\|Write`) | async (zero added latency) | Score the change against each rule; update per-rule relevant/followed/violated tallies in the ledger. |
| SessionEnd | sync | Render the worst-first compliance scorecard and persist it. |

`/dead-rules-audit:scorecard` — renders the worst-first compliance scorecard on demand, highlighting the worst offenders and any `promote→hook` rules.

## Configuration

No configuration needed. There are no environment variables or settings. Tuning thresholds are hard-coded constants at the top of `dead-rules-audit.js`: the `promote→hook` flag fires at `PROMOTE_MIN_VIOLATIONS = 3` violations and `PROMOTE_RATE = 0.5` violation rate, with `MAX_CLAUDE_MD_BYTES = 256 * 1024` and `MAX_RULES = 200` guards. Tally state is stored in `~/.claude/dead-rules-audit/` (scorecard entries are also logged to `~/.claude/hooks-logs/<date>.jsonl`).

## Data & privacy

It records your CLAUDE.md rule text and per-rule relevant/followed/violated tallies. Everything stays on the local machine — the source requires only `fs`, `path`, `os`, and `crypto`, makes zero network calls, and is fully deterministic.

## Uninstall

```
/plugin uninstall dead-rules-audit@claude-code-hooks
```
