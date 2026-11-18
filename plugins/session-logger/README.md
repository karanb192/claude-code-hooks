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

## Codex CLI

Version 1.1.0 also supports Codex CLI 0.169.0. Install from a shell:

```sh
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add session-logger@claude-code-hooks
```

Open `/hooks` in Codex and approve all three hooks, including after updates. The Codex adapter records `SessionStart`, `PostToolUse` for `Bash|apply_patch`, and `SessionEnd`. It writes one chronological Markdown note per full thread ID under `$CODEX_HOME/session-notes` (default `~/.codex/session-notes`). `CC_SESSION_LOG_DIR` overrides that directory; `CC_SESSION_BASH_TRUNCATE` retains the same meaning as above. Diagnostics go to `$CODEX_HOME/hooks-logs`.

Notes contain the session ID, initial working directory and Git branch, lifecycle markers, successful native patch paths and first-line shell commands. Patch contents and tool output are not stored. Commands get the same best-effort redaction as the Claude adapter; notes remain sensitive. Reads appear as shell commands rather than a separate file-read inventory. A move records deletion of its source and the destination path.

Codex hooks run synchronously. Note writes use a per-file lock; lock exhaustion logs an error and skips the entry rather than writing without the lock. Resuming a thread appends to its existing note. A note can start at the first observed tool call if the start event was missed. Abrupt termination can omit the end marker. These notes do not contain Claude's `ended:` frontmatter or final Git-status section.

Shell-edited file paths, MCP calls, shell completion status and remote environments are outside this port's scope. A logged command is not a claim that it succeeded. The supported events come from [Codex 0.169.0's hook schema](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/hooks/src/schema.rs); see [live checks](../../bench/codex-live/RESULTS.md) for tested coverage. Remove with `codex plugin remove session-logger@claude-code-hooks`.

## Uninstall from Claude Code

```
/plugin uninstall session-logger@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks): production-ready Claude Code hooks, each installable on its own as a plugin.
