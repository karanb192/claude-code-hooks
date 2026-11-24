# git-safety

> Branch-aware git guardrails plus destructive gh CLI protection: denies the operations that rewrite shared history or close things you didn't mean to close.

A `PreToolUse` hook fires before every `Bash` call and checks the command against a tiered pattern list. On a match it returns `permissionDecision: "deny"` with the pattern id and reason, so Claude sees exactly why the command was refused. Branch-aware rules (`git commit`, `merge`, `rebase`, `reset`, `push` while on a protected branch) resolve the branch at check time in the repository the command reaches (`git branch --show-current` for the session's repository, the `HEAD` file for any other); everything else matches on the command text alone. Protected branches are `main` and `master`.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install git-safety@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install git-safety@claude-code-hooks`.)

## Codex CLI

```sh
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add git-safety@claude-code-hooks
```

Open `/hooks` in Codex and approve this plugin. Re-approve after every update; Codex skips unapproved or changed hooks. Do not install it alongside [guard-pack](../guard-pack#codex-cli), which includes this guard.

This entry point checks `Bash` and native `apply_patch` calls. Patch files are checked individually; unreadable patches are blocked. Shell patches must use a plain command with a quoted heredoc; `apply_patch` anywhere else in a command, such as behind `timeout` or `eval`, is blocked. Literal searches and commit messages mentioning `apply_patch` pass. See [the shared adapter's limits](../guard-pack#codex-cli), including shell sessions and dynamically constructed commands.

Export configuration variables before launching Codex. An ask-mode match becomes a block because Codex hooks cannot ask. Logs stay in `~/.claude/hooks-logs/` with `host: "codex"`, including on Codex-only machines.

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PreToolUse (`Bash`) | sync | Checks the command against the active safety level's patterns; on a match, denies with the pattern id and reason, and appends a log row. Non-matching commands pass through untouched (`{}`). |

Blocked at the default `high` level:

- `git push` naming `main` or `master` as a ref (`origin main`, `HEAD:main`, `+main`, `refs/heads/main`, `heads/main`; any flags; also inside a subshell, as in `(cd repo && git push origin main)`, or right before a redirect). A branch that only contains the word, such as `my-main-feature`, is not blocked
- `git branch -d` / `-D` / `--delete` on `main` or `master`, with any other flags or branch names in the same call (`-d -f main`, `-Dq main`, `-D old main`)
- `git commit`, `git merge`, `git rebase`, `git reset`, `git push` while the current branch **is** `main` or `master`. That is the branch the call reaches: after `git checkout main` or `git switch main` earlier in the same command, and in another repository named by `cd`, `pushd`, `git -C`, `--git-dir` or `--work-tree`. A checkout that only restores files (`git checkout -- file`) keeps the branch, and a `cd` inside `{ }` or an `if` body stays in effect after it. From a session on `main`, a call joined by `&&` to an earlier switch to another branch (`git checkout -b`, `git switch -c`, or an existing local branch) is allowed when nothing else in the line can run git or move `HEAD`
- `gh pr merge`, `gh pr close`, `gh issue close`, `gh release delete`, `gh repo delete`, also with flags such as `-R owner/repo` between the two words

`strict` adds any force-push (`--force`, `-f` alone or clustered as in `-fu`, or a `+` refspec such as `origin +feature`; `--force-with-lease` stays allowed). `critical` applies no git-safety rules at all, deferring entirely to `block-dangerous-commands`.

**Composition with `block-dangerous-commands`:** that hook already blocks force-push (any, and to main/master) and `git reset --hard` on any branch, so at `high` the two don't overlap. Run git-safety at `strict` if you use it on its own.

## How it reads a command

It shares its command reader with [block-dangerous-commands](../block-dangerous-commands#how-it-reads-a-command), so quotes, escapes and variables do not change the verdict. `git 'push' origin main` and `g=git; $g push origin main` are refused, and so is `git "push" origin HEAD` while on main. Global options before the subcommand do not hide it either, including values with quotes or escapes inside the word: `git -c user.name="Ada Lovelace" commit`, `git -C my\ repo commit` and `git --attr-source HEAD commit` are read as commits. Quoted commit messages, PR bodies and heredoc text that only mention a command are not matched, so `git commit -m "run gh pr merge after review"` is allowed on a feature branch.

### What it does not catch

- A loop variable: `for g in git; do $g push origin main; done`.

[tests/shell-rewrites.test.js](../../tests/shell-rewrites.test.js) lists these with the rest of the record and fails when one starts being caught.

## Configuration

Optional, set via environment variable:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`. |
| `HOOK_FAIL_OPEN` | unset (deny) | The literal string `true` lets the call through when the guard's own check throws, instead of denying it. See [When the guard fails](#when-the-guard-fails). |

| Level | What's blocked |
|-------|----------------|
| `critical` | Nothing from this hook (defer entirely to `block-dangerous-commands`) |
| `high` | Branch-aware guardrails, protected-branch deletion, pushes to main/master by name, destructive gh CLI operations |
| `strict` | All of `high` plus any force-push, so the hook is self-sufficient standalone |

The `SAFETY_LEVEL` constant in the script still exists, but prefer the env var: plugin updates overwrite installed files, so edits don't survive. This hook always denies; it has no ask mode.

## When the guard fails

From 1.2.0, a guard that cannot finish its check refuses the call instead of allowing it. A check that throws is denied with a `[guard-error]` reason. A timeout (10 s) or a missing `node` is blocked by `"onFailure": "block"` on Claude Code v2.1.295 or later; older versions ignore that key and let the call run. On Codex a missing `node` is blocked by the command's `|| exit 2`, but a timeout still lets the call run, because Codex has no setting for it. Set `HOOK_FAIL_OPEN=true` to let the call through when the check throws; [When a guard fails](../../README.md#-when-a-guard-fails) covers the rest of the way back.

## Data & privacy

Blocked commands are logged (with timestamp, pattern id, session id, cwd, and permission mode) to `~/.claude/hooks-logs/<date>.jsonl`. The only command it runs is `git branch --show-current`, locally, in the session's repository. For another repository the command names it runs nothing: it reads that repository's `HEAD` and ref files. It makes no network calls.

## Uninstall

```
/plugin uninstall git-safety@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
