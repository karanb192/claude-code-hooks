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

## Codex CLI

Version 1.1.0 also supports Codex CLI 0.169.0. Install from a shell:

```sh
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add auto-stage@claude-code-hooks
```

Open `/hooks` in Codex and approve the plugin, including after updates. Its synchronous `PostToolUse` hook stages each path in a successful native `apply_patch` call. Added and updated files, deletions, and both sides of renames are included. Relative paths use the event's working directory. Git receives literal paths as arguments, never shell text or wildcard pathspecs. Ignored files are never force-added.

This stages the **whole file**, including any edits already present in it. Review `git diff --cached` before committing. Shell writes, shell-invoked patches, MCP tools and remote environments are outside this port's scope. Failed native patches do not emit the successful post-tool event; partially applied failures need manual review and staging.

When installed alongside `format-code`, hook execution order is not guaranteed. Run `git add` after reviewing the formatted result if you need the index to contain it. Neither plugin commits anything. Errors are logged and do not block Codex. Diagnostics go to `$CODEX_HOME/hooks-logs` (default `~/.codex/hooks-logs`). Remove with `codex plugin remove auto-stage@claude-code-hooks`.

The event contract is checked against [Codex 0.169.0's native patch handler](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/handlers/apply_patch.rs). [Live checks](../../bench/codex-live/RESULTS.md) record the tested host and limits.

## Uninstall from Claude Code

```
/plugin uninstall auto-stage@claude-code-hooks
```

---

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
