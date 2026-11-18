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

## Codex CLI

Version 1.1.0 also supports Codex CLI 0.169.0. Install from a shell:

```sh
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add format-code@claude-code-hooks
```

Open `/hooks` in Codex and approve the plugin, including after updates. Install `ruff` and **Prettier 3** yourself and put those trusted installations on the hook process's `PATH`. The Codex adapter calls those executables directly. It never runs `uv` or `npx` and never downloads a formatter. It does not select the project's pinned version, so review differences against the formatter your project normally uses.

After a successful native `apply_patch`, it formats added and updated files and rename destinations. It skips deleted paths, symlinks, missing files and unsupported extensions. Python runs only `ruff format --isolated --no-cache --quiet`, with no lint autofixes or import removal. JS/TS/HTML/JSON/MD/YAML runs `prettier --no-config --no-editorconfig --write`. Prettier versions outside major 3 are skipped. Each subprocess has a ten-second timeout and runs from the installed plugin's directory. The hook has a thirty-second budget, so large patches may not finish every file.

**Configured files are left unchanged.** Before launching a formatter, the adapter looks from the file's directory up through the nearest repository root (a `.git` directory or file). Without a repository boundary, it continues to the filesystem root. Prettier is skipped for `.prettierrc*`, `prettier.config.*`, `.editorconfig`, `.prettierignore`, or a `prettier` key in `package.json`. Ruff is skipped for `ruff.toml`, `.ruff.toml`, or any `pyproject.toml`. The last rule is deliberately conservative: even a project file without Ruff settings opts Python out, so the hook does not need a partial TOML parser. Package metadata is read only as JSON; executable configuration is never loaded. Unreadable or invalid package metadata leaves the target unchanged and logs an error. A skip logs the file, the settings path and the reason. Run the project's formatter as an ordinary sandboxed tool command instead.

**Hooks run outside Codex's agent sandbox.** Only files without the settings above use default formatting. The adapter never loads project configuration or plugins. Executable Prettier configs can run arbitrary code; [Prettier's `--no-config` option](https://prettier.io/docs/cli#--no-config) disables them, and [Prettier 3 removed automatic plugin discovery](https://prettier.io/blog/2023/07/05/3.0.0#plugin-search-feature-has-been-removed-14759-by-fisker). Do not put workspace-owned formatter wrappers on the hook process's `PATH`.

Formatting rewrites the whole file, including pre-existing edits. Shell writes, shell-invoked patches, MCP tools and remote environments are outside this port's scope. Missing formatters and formatting failures are logged without blocking Codex. Diagnostics go to `$CODEX_HOME/hooks-logs` (default `~/.codex/hooks-logs`).

If `auto-stage` is also installed, hook execution order is not guaranteed. Review and stage the formatted result before committing. Remove with `codex plugin remove format-code@claude-code-hooks`. See the [native patch event contract](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/core/src/tools/handlers/apply_patch.rs) and [live checks](../../bench/codex-live/RESULTS.md).

## Uninstall from Claude Code

```
/plugin uninstall format-code@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks), a collection of production-ready Claude Code hooks, each installable on its own as a plugin.
