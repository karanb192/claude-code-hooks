# context-hogs

> Per-file context-cost leaderboard — attributes every tool result's tokens to the files it loaded, so you know which files cost you the most.

A `PostToolUse` hook fires after every `Read`, `Grep`, `Glob`, and `Bash` call, measures the tool result's bytes, resolves the file path(s) that result belongs to, and appends a ledger row. Tokens are estimated from bytes (~4 bytes/token) and dollars from a configurable input-token rate — hooks don't receive real token counts, so nothing is fabricated. At `SessionEnd`, or on demand via the skill, it aggregates the ledger into your repo's most token-expensive files (read count, cumulative tokens, estimated cost, plus repeat-offender flags for lockfiles, generated code, and giant utils) and renders that leaderboard.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install context-hogs@claude-code-hooks
```

Restart Claude Code — done. (Or from a shell: `claude plugin install context-hogs@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PostToolUse (`Read\|Grep\|Glob\|Bash`) | async (zero added latency) | Measures the tool result's bytes, resolves the file path(s) it belongs to, appends a ledger row. |
| SessionEnd | sync | Aggregates the whole ledger, renders the leaderboard card via `systemMessage`, and writes a suggested CLAUDE.md ignore block for the top offenders. |

`/context-hogs:leaderboard` — renders this repo's context-cost leaderboard on demand.

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONTEXT_HOGS_BYTES_PER_TOKEN` | `4` | Bytes-per-token ratio used to estimate tokens. |
| `CONTEXT_HOGS_USD_PER_MTOK` | `3.0` | Input $/1M tokens used to estimate cost. Set to your model's current input rate. |
| `CONTEXT_HOGS_TOP_N` | `10` | Number of files shown on the leaderboard. |
| `CONTEXT_HOGS_LEDGER_CAP` | `50000` | Max ledger rows kept; older rows are compacted at SessionEnd. |

State is stored under `~/.claude/context-hogs/<repo-key>/ledger.jsonl`.

## Data & privacy

Records file paths, read counts, and byte/token estimates per repo. It makes no network calls — the script only uses `fs`, `path`, and `os` — so everything stays on your local machine.

## Uninstall

```
/plugin uninstall context-hogs@claude-code-hooks
```
