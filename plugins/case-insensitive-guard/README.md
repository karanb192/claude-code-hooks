# case-insensitive-guard

> Stops `rm -rf content` silently destroying `Content` on case-insensitive filesystems (APFS default, exFAT, NTFS).

On a case-insensitive volume, `Content` and `content` are the same path, so a miscased delete lands on the real directory anyway (see [anthropics/claude-code#37875](https://github.com/anthropics/claude-code/issues/37875)). A `PreToolUse` hook on `Bash` resolves the real target of destructive commands (`rm`, `rmdir`, `mv`, `mkdir`, `touch`, `find -delete`, `find -exec rm/unlink/rmdir`, and `xargs rm` fed by `echo`, or by `find` printing the matched paths; xargs records split as its `-I`, `-0` or `-d` mode does) and denies the ones that would hit a differently-cased entry of what was typed. Every component of the path counts, so `rm -rf content/sub` is caught when the folder is `Content`. Directory context is modeled properly: `cd`/`pushd`/`popd` chains, `&&`/`||`/`;`/`|`/`&` connectors gated by exit status, subshell scoping, heredoc stripping, `#` comments, line continuations, brace lists, redirects, quotes and escapes, and wrapper prefixes with their options (`sudo -u root`, `env -u NAME`, `doas`, `nohup`, `nice -n 5`, `timeout 30`, `stdbuf`, `ionice`, `xargs`, ...). `env -C DIR` and `sudo -D DIR` move the command's working directory. No probe files: case-insensitivity is proven by the collision itself (the typed name is absent from `readdir()` yet the path still exists).

Idea credit: [@yurukusa](https://github.com/karanb192/claude-code-hooks/pull/8).

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install case-insensitive-guard@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install case-insensitive-guard@claude-code-hooks`.)

## Codex CLI

```sh
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add case-insensitive-guard@claude-code-hooks
```

Open `/hooks` in Codex and approve this plugin. Re-approve after every update; Codex skips unapproved or changed hooks. Do not install it alongside [guard-pack](../guard-pack#codex-cli), which includes this guard.

This entry point checks `Bash` and native `apply_patch` calls. Patch files are checked individually; unreadable patches are blocked. Shell patches must use a plain command with a quoted heredoc; `apply_patch` anywhere else in a command, such as behind `timeout` or `eval`, is blocked. Literal searches and commit messages mentioning `apply_patch` pass. See [the shared adapter's limits](../guard-pack#codex-cli), including shell sessions and dynamically constructed commands.

Export configuration variables before launching Codex. An ask-mode match becomes a block because Codex hooks cannot ask. Logs stay in `~/.claude/hooks-logs/` with `host: "codex"`, including on Codex-only machines.

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PreToolUse (`Bash`) | sync (it must answer before the command runs) | Parses the command, resolves every destructive target against the real filesystem, and returns `permissionDecision: "deny"` (or `"ask"`, see below) with both names in the reason when a case-variant would be hit. Safe commands pass through untouched. |

What it deliberately does NOT flag: glob targets (shell glob matching is case-sensitive), `$VAR`/`$( )`/backtick targets (not statically resolvable, conservatively allowed; literal targets beside them are still checked), `xargs` input from anything but a literal `echo` or `find`, a brace list that would expand past 64 words (treated like `$VAR`; other targets on the line are still checked), `find -exec rm` that is not handed `{}`, path components of the session's own working directory or home directory (the cwd can be spelled in another case than the disk, and that is not the agent's typo), exact-case deletes (intentional), a case-only rename like `mv readme.md README.md` (the canonical fix), `mv -t DIR` (moves INTO a directory), plain `rm` of a case-variant directory (`rm` refuses directories, nothing is destroyed), and heredoc bodies (document text, not commands). On a case-sensitive volume it never fires: the miscased command fails harmlessly on its own.

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`. Prefer this over editing the script (plugin updates overwrite installed files). |
| `HOOK_ASK_CRITICAL` | unset (deny) | Literal string `true`: `critical`-level hits prompt for approval instead of denying. |
| `HOOK_ASK_HIGH` | unset (deny) | Literal string `true`: `high`-level hits prompt instead of denying. |
| `HOOK_ASK_STRICT` | unset (deny) | Literal string `true`: `strict`-level hits prompt instead of denying. |
| `HOOK_FAIL_OPEN` | unset (deny) | The literal string `true` lets the call through when the guard's own check throws, instead of denying it. See [When the guard fails](#when-the-guard-fails). |

Safety levels are cumulative:

| Level | Blocks |
|-------|--------|
| `critical` | Recursive `rm -r/-rf` (and `find -delete`) onto a case-variant |
| `high` | + non-recursive deletes that really remove something: `rm` of a case-variant FILE, `rm -d`/`rmdir` of a case-variant dir, `mv` overwriting a case-variant FILE |
| `strict` | + `mkdir`/`touch` onto an existing case-variant (usually a no-op, but often a sign the agent has the wrong name in mind) |

Set them inline in your hook command, or export them in your shell profile:

```json
{
  "type": "command",
  "command": "HOOK_SAFETY_LEVEL=strict HOOK_ASK_STRICT=true node \"${CLAUDE_PLUGIN_ROOT}/case-insensitive-guard.js\""
}
```

## When the guard fails

From 1.2.0, a guard that cannot finish its check refuses the call instead of allowing it. A check that throws is denied with a `[guard-error]` reason. A timeout (10 s) or a missing `node` is blocked by `"onFailure": "block"` on Claude Code v2.1.295 or later; older versions ignore that key and let the call run. On Codex a missing `node` is blocked by the command's `|| exit 2`, but a timeout still lets the call run, because Codex has no setting for it. Set `HOOK_FAIL_OPEN=true` to let the call through when the check throws; [When a guard fails](../../README.md#-when-a-guard-fails) covers the rest of the way back.

## Data & privacy

Blocked/asked commands are logged to `~/.claude/hooks-logs/<date>.jsonl` (command, typed vs actual name, session id). It makes no network calls (the script only uses `fs`, `path`, and `os`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall case-insensitive-guard@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks): production-ready Claude Code hooks, each installable on its own as a plugin.
