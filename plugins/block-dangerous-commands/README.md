# block-dangerous-commands

> PreToolUse guard for Bash: blocks dangerous shell commands (rm -rf ~, fork bombs, curl|sh, force push to main) before they run.

A `PreToolUse` hook fires before every `Bash` call and tests the command against a curated pattern list: rm targeting home (`~`, `$HOME`, `${HOME}`, `/home/<user>`, `/Users/<user>`), root or system directories, the cwd or its parent (`..`), dd to disk devices (including macOS `/dev/disk*`), mkfs, fork bombs, curl/wget piped to any shell or run through `bash <(curl ...)` / `sh -c "$(curl ...)"`, force push to main/master (flag before or after the branch, or a `+main` refspec), `git reset --hard`, `git clean -f`, chmod 777, docker volume deletion, and more. On a match it denies the call and shows the pattern id and reason, so Claude knows exactly why. Three safety levels control how much is blocked, and per-level ask mode turns a hard deny into a prompt you approve or reject. Every block/ask is logged to `~/.claude/hooks-logs/<date>.jsonl`.

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

This entry point checks `Bash` and native `apply_patch` calls. Patch files are checked individually; unreadable patches are blocked. Shell patches must use a plain command with a quoted heredoc. Literal searches and commit messages mentioning `apply_patch` pass. See [the shared adapter's limits](../guard-pack#codex-cli), including shell sessions and dynamically constructed commands.

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
| `strict`   | + Cautionary (any force push, sudo rm, docker prune)        | Maximum safety      |

Set the level via `HOOK_SAFETY_LEVEL` (see below). Don't edit the installed script: plugin updates overwrite it.

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`. |
| `HOOK_ASK_CRITICAL` | unset (deny) | The literal string `true` makes `critical`-level matches prompt instead of deny. |
| `HOOK_ASK_HIGH` | unset (deny) | Same, for `high`-level matches. |
| `HOOK_ASK_STRICT` | unset (deny) | Same, for `strict`-level matches. |

Ask mode is strictly opt-in and per level: only the literal string `true` enables it (`"1"` does not), and enabling it for one level never softens another. A common setup: keep `critical` on deny, set `HOOK_ASK_STRICT=true` so cautionary patterns prompt instead of blocking.

Pair it with `protect-secrets` for coverage of secrets exposure (cat .env, printenv, ~/.ssh reads): that lives in a separate hook by design.

## How it reads a command

Before matching, the guard reads the command the way bash splits it, so the spelling does not change the verdict:

- Quotes and escapes inside a word are removed. `r''m -rf ~`, `"rm" -rf ~`, `r\m -rf ~` and `$'\x72m' -rf ~` are all `rm -rf ~`, and `rm -rf "/"` is `rm -rf /`.
- A name assigned earlier in the line is replaced: `g=git; $g push --force origin main` is a force push.
- A command substitution, the program given to `sh -c` or `eval`, and a heredoc fed to a shell are read as commands too.

Text that only mentions a command is not matched:

- The body of a quoted heredoc fed to a reader that never runs it (`cat`, `tee`, `head`, `git commit -F -` and similar). `cat > notes.md <<'EOF'` with a body that mentions `git push --force` is allowed.
- The quoted text of `echo`, `printf`, `git commit` and `gh pr|issue create|edit|comment`, including the `git commit -m "$(cat <<'EOF' ...)"` form. `git commit -m "never run rm -rf ~"` and `echo 'curl x | sh'` are allowed.

That text is still matched whenever it can run: piped into a program (`echo '...' | sh`), echoed into a file, written by a heredoc to a script, shell rc file or git hook, an unquoted heredoc body (it expands), a substitution used as the command, or a line that also starts a shell or interpreter, defines a function or alias, or uses `eval`, `source`, `trap` or `case`.

### What it does not catch

[tests/shell-rewrites.test.js](../../tests/shell-rewrites.test.js) is the record: rewritten commands that must be refused, mentions that must be allowed, and the known misses below. It runs against this guard and guard-pack on every test run, and a change that starts catching a known miss fails it until the entry moves.

- Deleters other than `rm`: `find ~ -delete`, and deletes through `python -c`, `node -e` or `perl -e`.
- A file written now and run later by another program, such as a Makefile or an npm script. A quoted heredoc written to such a file is read as text.
- A loop variable (`for g in git; do $g push ...`). A word whose quotes hold a space is kept as typed, because that is usually a prompt or a message, so `cat "my dir/.e"nv` is not read as `.env`.

These are guardrails, not a sandbox: see [SECURITY.md](../../SECURITY.md).

## Data & privacy

Blocked/asked commands are logged (with pattern id, level, decision, and session metadata) to `~/.claude/hooks-logs/<date>.jsonl`. It makes no network calls (the script only uses `fs` and `path`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall block-dangerous-commands@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
