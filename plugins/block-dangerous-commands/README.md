# block-dangerous-commands

> PreToolUse guard for Bash: blocks dangerous shell commands (rm -rf ~, fork bombs, curl|sh, force push to main) before they run.

A `PreToolUse` hook fires before every `Bash` call and tests the command against a curated pattern list: rm targeting home (`~`, `$HOME`, `${HOME}`, `/home/<user>`, `/Users/<user>`) or everything in it (`~/*`), root or system directories, the cwd (`.`, or a glob of every name such as `*` or `?*`) or its parent (`..`), dd to disk devices (including macOS `/dev/disk*`), mkfs, fork bombs, curl/wget piped to any shell or run through `bash <(curl ...)` / `sh -c "$(curl ...)"`, force push to main/master (flag before or after the branch, or a `+main` refspec), `git reset --hard`, `git clean -f`, chmod 777 (also `0777`, `1777` and `a+rwx`), docker volume deletion (`docker volume rm|remove|prune`, also after global options such as `--context`, `docker compose down -v` and `docker system prune --volumes`), and more. On a match it denies the call and shows the pattern id and reason, so Claude knows exactly why. Three safety levels control how much is blocked, and per-level ask mode turns a hard deny into a prompt you approve or reject. Every block/ask is logged to `~/.claude/hooks-logs/<date>.jsonl`.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install block-dangerous-commands@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install block-dangerous-commands@claude-code-hooks`.)

## Codex CLI

```sh
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add block-dangerous-commands@claude-code-hooks
```

Open `/hooks` in Codex and approve this plugin. Re-approve after every update; Codex skips unapproved or changed hooks. Do not install it alongside [guard-pack](../guard-pack#codex-cli), which includes this guard.

This entry point checks `Bash` and native `apply_patch` calls. Patch files are checked individually; unreadable patches are blocked. Shell patches must use a plain command with a quoted heredoc; `apply_patch` anywhere else in a command, such as behind `timeout` or `eval`, is blocked. Literal searches and commit messages mentioning `apply_patch` pass. See [the shared adapter's limits](../guard-pack#codex-cli), including shell sessions and dynamically constructed commands.

Export configuration variables before launching Codex. An ask-mode match becomes a block because Codex hooks cannot ask. Logs stay in `~/.claude/hooks-logs/` with `host: "codex"`, including on Codex-only machines.

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PreToolUse (`Bash`) | sync (must finish before the command runs) | Tests the command against every pattern at or below the configured safety level; on a match returns `permissionDecision: "deny"` (or `"ask"` in ask mode) with the pattern id and reason, and logs the event. Safe commands pass through untouched. |

## Safety levels

| Level      | What's blocked                                              | Use case            |
|------------|-------------------------------------------------------------|---------------------|
| `critical` | Catastrophic only (rm -rf ~, fork bombs, dd to disk)        | Maximum flexibility |
| `high`     | + Risky (force push main, git reset --hard, curl\|sh)       | **Recommended, default** |
| `strict`   | + Cautionary (any force push, `+ref` refspecs included, sudo rm, docker system, image, container, network and builder prune) | Maximum safety      |

Set the level via `HOOK_SAFETY_LEVEL` (see below). Don't edit the installed script: plugin updates overwrite it.

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`. |
| `HOOK_ASK_CRITICAL` | unset (deny) | The literal string `true` makes `critical`-level matches prompt instead of deny. |
| `HOOK_ASK_HIGH` | unset (deny) | Same, for `high`-level matches. |
| `HOOK_ASK_STRICT` | unset (deny) | Same, for `strict`-level matches. |
| `HOOK_FAIL_OPEN` | unset (deny) | The literal string `true` lets the call through when the guard's own check throws, instead of denying it. See [When the guard fails](#when-the-guard-fails). |

Ask mode is strictly opt-in and per level: only the literal string `true` enables it (`"1"` does not), and enabling it for one level never softens another. A common setup: keep `critical` on deny, set `HOOK_ASK_STRICT=true` so cautionary patterns prompt instead of blocking.

Pair it with `protect-secrets` for coverage of secrets exposure (cat .env, printenv, ~/.ssh reads): that lives in a separate hook by design.

## How it reads a command

Before matching, the guard reads the command the way bash splits it, so the spelling does not change the verdict:

- Quotes and escapes inside a word are removed. `r''m -rf ~`, `"rm" -rf ~`, `r\m -rf ~` and `$'\x72m' -rf ~` are all `rm -rf ~`, and `rm -rf "/"` is `rm -rf /`.
- A name assigned earlier in the line is replaced: `g=git; $g push --force origin main` is a force push.
- A command substitution, the program given to `sh -c` or `eval`, and a heredoc fed to a shell are read as commands too.
- Flags count in any spelling git and sudo accept: inside a short-flag cluster (`git push -uf origin main`), as a long form or abbreviation (`git clean --force`, `git reset --har`), and with other options in between (`git clean -d -f`, `sudo -n rm`).

Text that only mentions a command, on a line where no command can run it, is not matched:

- The body of a quoted heredoc fed to a reader that never runs it (`cat`, `tee`, `head`, `git commit -F -` and similar). `cat > notes.md <<'EOF'` with a body that mentions `git push --force` is allowed.
- The quoted text of `echo`, `printf`, `git commit` and `gh pr|issue create|edit|comment`, including the `git commit -m "$(cat <<'EOF' ...)"` form. `git commit -m "never run rm -rf ~"` and `echo 'curl x | sh'` are allowed.

The exception holds only for a line in which no command can make the dropped text run. Every command must be one that runs nothing it is handed: the readers and message commands above, `cd`, `ls`, `mkdir`, `grep`, `test` and similar, the file commands `cp`, `mv`, `ln`, `rm`, `touch`, `chmod` and `tee`, and `git` or `gh` subcommands that run no program (`git add`, `commit`, `push`, `log`; `gh pr`, `gh issue`, `gh api`), with no `-c` and no assignment in front. One other command anywhere in the line (`make`, `awk`, `sort`, `npm test`, a shell, an interpreter, a wrapper, a path, a function or alias) and every word is matched as before. git runs hooks on commit, push, checkout and every ref or index update, from whatever directory `core.hooksPath` names, so a line that runs git or `gh pr` must not write, copy, move, link, delete or chmod any file: `cat > hook <<'EOF' ... cp hook .git/hooks/pre-commit; git commit` keeps its text. No line may write to a path a shell, git or the system runs (scripts, rc files, git hooks and config, `/etc`, cron, launchd), or write a file after `cd`. The text is also matched when it is piped into a program, echoed into a file, when an unquoted heredoc body expands, and when a substitution is used as the command.

What that costs: a notes file and a commit in one line (`cat > notes.md <<'EOF' ... git add notes.md && git commit`) is matched as before, so a body that mentions a dangerous command is refused. Write the file and commit in separate calls.

### What it does not catch

[tests/shell-rewrites.test.js](../../tests/shell-rewrites.test.js) is the record: rewritten commands that must be refused, mentions that must be allowed, and the known misses below. It runs against this guard and guard-pack on every test run, and a change that starts catching a known miss fails it until the entry moves.

- Deleters other than `rm`: `find ~ -delete`, and deletes through `python -c`, `node -e` or `perl -e`.
- A file written now and run or moved by a later call, such as a Makefile run by a later `make`, or a neutral file a later `mv` puts into `.git/hooks`. A quoted heredoc written to such a file on a line that runs nothing is read as text; the guard cannot connect it to the later call.
- A loop variable (`for g in git; do $g push ...`). A word whose quotes hold a space is kept as typed, because that is usually a prompt or a message, so `cat "my dir/.e"nv` is not read as `.env`.

These are guardrails, not a sandbox: see [SECURITY.md](../../SECURITY.md).

## When the guard fails

From 1.2.0, a guard that cannot finish its check refuses the call instead of allowing it. A check that throws is denied with a `[guard-error]` reason. A timeout (10 s) or a missing `node` is blocked by `"onFailure": "block"` on Claude Code v2.1.295 or later; older versions ignore that key and let the call run. On Codex a missing `node` is blocked by the command's `|| exit 2`, but a timeout still lets the call run, because Codex has no setting for it. Set `HOOK_FAIL_OPEN=true` to let the call through when the check throws; [When a guard fails](../../README.md#-when-a-guard-fails) covers the rest of the way back.

## Data & privacy

Blocked/asked commands are logged (with pattern id, level, decision, and session metadata) to `~/.claude/hooks-logs/<date>.jsonl`. It makes no network calls (the script only uses `fs` and `path`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall block-dangerous-commands@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
