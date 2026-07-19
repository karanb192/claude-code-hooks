# bounty-board

> Prices your repo's TODO/FIXME/HACK debt as aging XP bounties, injects the top 3 as opportunistic side quests, and verifies + pays out the bounties you genuinely clear.

On SessionStart it scans your git-tracked files, matches comment markers (TODO/FIXME/HACK/XXX/BUG), skipped tests, and lint suppressions, and prices each as a "wanted poster" bounty whose XP scales with git-blame age and severity — older debt pays more. It renders the board as a card and injects the top 3 as side quests via `additionalContext`. A PostToolUse hook re-checks touched files after each edit and pays out bounties whose markers verifiably disappear (rewording transfers the bounty instead of paying; a rename never pays). SessionEnd renders a payout card: XP earned, bounties cleared, and the remaining burn-down. Scanning is cost-bounded (400 files, 256KB/file, ~1.8s total) so it stays cheap on large repos.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install bounty-board@claude-code-hooks
```

Restart Claude Code — done. (Or from a shell: `claude plugin install bounty-board@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
| --- | --- | --- |
| SessionStart | sync | Scans tracked files, prices each TODO/FIXME/HACK/skip/lint-suppression as an aging bounty, renders the board, and injects the top 3 as side quests via `additionalContext`. Re-fires on resume/compact without resetting earnings. |
| PostToolUse (`Edit\|MultiEdit\|Write\|NotebookEdit\|Bash`) | sync | After a file is touched, re-checks that file's bounties and pays out any whose marker verifiably disappeared (verify-then-reward). Sync because it returns an `additionalContext` payout message. |
| SessionEnd | sync | Renders the payout card: XP earned this session, bounties cleared, and the remaining board burn-down. |

`/bounty-board:board` — renders the current bounty board on demand and calls out the fattest open bounties.

## Configuration

No configuration needed. State is stored under `~/.claude/bounty-board/` (one JSON ledger per repo); hook logs go to `~/.claude/hooks-logs/`.

## Data & privacy

For each bounty it records the marker text, file path, line, git-blame age, and XP in a local JSON ledger. Everything stays on your machine — the hook makes no network calls (Node built-ins only, zero dependencies).

## Uninstall

```
/plugin uninstall bounty-board@claude-code-hooks
```
