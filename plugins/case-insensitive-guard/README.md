# case-insensitive-guard

> Stops `rm -rf content` silently destroying `Content` on case-insensitive filesystems (APFS default, exFAT, NTFS).

On a case-insensitive volume, `Content` and `content` are the same path, so a miscased delete lands on the real directory anyway (see [anthropics/claude-code#37875](https://github.com/anthropics/claude-code/issues/37875)). A `PreToolUse` hook on `Bash` resolves the real target of destructive commands (`rm`, `rmdir`, `mv`, `mkdir`, `touch`, `find -delete` and `find -exec rm/unlink`) and denies the ones that would hit a differently-cased entry of what was typed. Directory context is modeled properly: `cd`/`pushd`/`popd` chains, `&&`/`||`/`;`/`|`/`&` connectors gated by exit status, subshell scoping, heredoc stripping, quotes and escapes, and wrapper prefixes (`sudo`, `nohup`, `exec`, `env`, ...). No probe files: case-insensitivity is proven by the collision itself (the typed name is absent from `readdir()` yet the path still exists).

Idea credit: [@yurukusa](https://github.com/karanb192/claude-code-hooks/pull/8).

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install case-insensitive-guard@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install case-insensitive-guard@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PreToolUse (`Bash`) | sync (it must answer before the command runs) | Parses the command, resolves every destructive target against the real filesystem, and returns `permissionDecision: "deny"` (or `"ask"`, see below) with both names in the reason when a case-variant would be hit. Safe commands pass through untouched. |

What it deliberately does NOT flag: glob targets (shell glob matching is case-sensitive), `$VAR`/`$( )`/backtick targets (not statically resolvable, conservatively allowed), exact-case deletes (intentional), a case-only rename like `mv readme.md README.md` (the canonical fix), `mv -t DIR` (moves INTO a directory), plain `rm` of a case-variant directory (`rm` refuses directories, nothing is destroyed), and heredoc bodies (document text, not commands). On a case-sensitive volume it never fires: the miscased command fails harmlessly on its own.

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`. Prefer this over editing the script (plugin updates overwrite installed files). |
| `HOOK_ASK_CRITICAL` | unset (deny) | Literal string `true`: `critical`-level hits prompt for approval instead of denying. |
| `HOOK_ASK_HIGH` | unset (deny) | Literal string `true`: `high`-level hits prompt instead of denying. |
| `HOOK_ASK_STRICT` | unset (deny) | Literal string `true`: `strict`-level hits prompt instead of denying. |

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

## Data & privacy

Blocked/asked commands are logged to `~/.claude/hooks-logs/<date>.jsonl` (command, typed vs actual name, session id). It makes no network calls (the script only uses `fs`, `path`, and `os`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall case-insensitive-guard@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks): production-ready Claude Code hooks, each installable on its own as a plugin.
