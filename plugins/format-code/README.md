# format-code

> Auto-formats Python (ruff) and JS/TS/HTML/JSON/MD/YAML (prettier) the moment Claude edits them.

A `PostToolUse` hook fires after every `Write` and `Edit` call, resolves the file path (relative paths resolve against the session cwd), picks a formatter by extension, and formats the file in place: `uv run ruff check --fix` then `uv run ruff format` for `.py`, `npx --yes prettier --write` for `.js`, `.ts`, `.json`, `.md`, `.yaml`, `.yml`, and `.html`. File paths are passed as argv, never through a shell, so filenames with shell metacharacters cannot inject commands. Unsupported extensions and missing files are skipped silently, a formatter failure never blocks the session, and every outcome (FORMATTED / SKIP / ERROR) is logged.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install format-code@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install format-code@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PostToolUse (`Write\|Edit`) | sync | Formats the touched file in place with ruff (Python) or prettier (JS/TS/JSON/MD/YAML/HTML), then returns `{}` so the session continues either way. |

Formatters run from your PATH: Python formatting needs `uv` (which runs `ruff`), the rest needs `npx` (Node); `npx --yes` fetches prettier on first use if it is not already installed. If a formatter is missing, the hook logs the error and moves on without blocking.

## Configuration

No configuration needed, and no environment variables to set. Logs go to `~/.claude/hooks-logs/<date>.jsonl` (the log directory is derived from `$HOME`).

## Data & privacy

Rewrites the edited file in place and records file paths, formatter outcomes, and session ids in the local log. The hook itself makes no network calls; the one indirect exception is `npx --yes prettier`, which downloads prettier from the npm registry the first time if it is not installed locally.

## Uninstall

```
/plugin uninstall format-code@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks), a collection of production-ready Claude Code hooks, each installable on its own as a plugin.
