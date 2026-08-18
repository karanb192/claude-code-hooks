# session-logger

> Durable markdown log of every Claude Code session: cwd, git repo/branch, files touched, and bash commands run (secret-redacted).

Claude Code sessions are ephemeral: you finish one, switch repos, and two days later can't remember which session touched which file. This hook writes a human-readable, greppable (and Obsidian-friendly) note per session. `SessionStart` seeds the note with YAML frontmatter (session id, cwd, git repo/branch, started timestamp); an async `PostToolUse` hook appends every `Edit`/`Write`/`Read`/`Bash` under "Files Touched" / "Commands Run"; `SessionEnd` fills the `ended:` timestamp and captures the final `git status`. Because async invocations can run concurrently (parallel tool calls), every note write goes through a cross-process file lock so appends can't clobber each other.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install session-logger@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install session-logger@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| SessionStart | sync | Creates the session note (frontmatter + skeleton sections) so PostToolUse has something to append to. On resume, appends a `## Resumed at` marker instead of overwriting. |
| PostToolUse (`Edit\|Write\|Bash\|Read`) | async (zero added latency) | Appends the file path (edited/wrote/read) or the bash command (first line only, truncated, secret-redacted) under the right section, serialized via a file lock. |
| SessionEnd | sync | Fills the frontmatter `ended:` timestamp and appends a `## Session End` section with the final `git status --short`. Idempotent: a duplicate SessionEnd is a no-op. |

It registers against `SessionEnd`, not `Stop`: `Stop` fires at the end of every turn, `SessionEnd` once per session. If the terminal is killed abruptly, the note keeps all activity up to the last tool call, just without a final `ended:` timestamp.

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CC_SESSION_LOG_DIR` | `~/.claude/sessions` | Where session notes are written. Point it at an Obsidian vault or iCloud folder for cross-device sync. |
| `CC_SESSION_BASH_TRUNCATE` | `200` | Max characters logged per bash command (first line only, then truncated). Must be a positive integer; anything else falls back to `200`. |

Hook diagnostics (start/append/end/error events) go to `~/.claude/hooks-logs/<YYYY-MM-DD>.jsonl`.

## Data & privacy

Records timestamps, cwd, git repo/branch, file paths, and first-line bash commands. File CONTENTS are never logged, only paths. Bash commands run through a best-effort redactor that masks common inline-secret shapes (sensitive env assignments, `--password`/`--token` flags, Bearer tokens, well-known key prefixes like `ghp_`, `xox`, `sk-`, `AKIA`). Best-effort, NOT a guarantee: treat notes as sensitive and keep synced folders (Obsidian/iCloud) private. The script makes no network calls; everything stays on your machine.

## Uninstall

```
/plugin uninstall session-logger@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks): production-ready Claude Code hooks, each installable on its own as a plugin.
