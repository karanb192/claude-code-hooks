# auto-stage

> Automatically git stages files after Claude modifies them, so `git status` always shows exactly what Claude touched.

A `PostToolUse` hook fires after every `Edit` and `Write` call, resolves the modified file's path (relative paths are resolved against the session's cwd), checks that it lives inside a git repo, and runs `git add` on it. Review becomes trivial: the staged set IS Claude's change set, and nothing needs manual staging before you commit. The hook stays synchronous on purpose: staging must complete before any later `git commit` in the same turn sees the index.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install auto-stage@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install auto-stage@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PostToolUse (`Edit\|Write`) | sync | Resolves the file path, skips files outside a git repo, runs `git add -- <file>` in the file's directory, logs the outcome. |

Every outcome (`STAGED`, `SKIP`, `ERROR`) is appended to `~/.claude/hooks-logs/<date>.jsonl`. The hook always exits 0 and prints `{}`; it never blocks the tool call, even on malformed input.

## Configuration

None. The hook has no tunables, no safety levels, and no ask mode. The only environment variable it reads is `HOME`, to place its log under `~/.claude/hooks-logs/`.

## Safety notes

- **.gitignore is your guard.** Ignored files (`.env`, keys, etc.) fail `git add` and the failure is logged; nothing is ever force-added.
- **Shell-free staging.** The path is passed as an argv element via `execFileSync`, so quotes, `$()`, and backticks in a filename cannot break out, and `--` stops a leading dash from being read as a git option.
- **No network calls.** The script only uses `fs`, `path`, and `child_process` (for git), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall auto-stage@claude-code-hooks
```

---

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
