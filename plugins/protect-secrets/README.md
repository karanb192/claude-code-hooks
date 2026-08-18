# protect-secrets

> Secrets firewall: stops Claude from reading, modifying, or exfiltrating sensitive files (.env, SSH keys, cloud credentials) before the tool call runs.

A `PreToolUse` hook fires before every `Read`, `Edit`, `Write`, and `Bash` call. File tools are checked against sensitive-path patterns (.env and .envrc, SSH private keys and authorized_keys, AWS/kube/gcloud/azure/docker credentials, .netrc/.npmrc/.pypirc, PEM/key/PKCS12 files, keystores, vault tokens); Bash commands are checked against secret-exposing patterns (cat/less/head on secrets, `printenv` and bare `env` dumps, `echo $SECRET_KEY`-style variable prints, sourcing .env, `/proc/*/environ`) and exfiltration patterns (curl/wget uploads, scp/rsync/nc of secrets, plus cp/mv/rm/truncate on them). A match returns `permissionDecision: "deny"` (or `"ask"`, see below) with the pattern id and reason, so you always know exactly which rule fired. Template files like `.env.example`, `.env.sample`, and `.env.template` are explicitly allowlisted.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install protect-secrets@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install protect-secrets@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PreToolUse (`Read\|Edit\|Write\|Bash`) | sync (must decide before the tool runs) | Matches the file path (Read/Edit/Write) or command (Bash) against tiered sensitive patterns; on a hit, denies or asks with the pattern id and reason. Everything else passes through untouched. |

## Safety levels

Patterns are tiered; each level includes everything below it:

| Level | Blocks | Use case |
|-------|--------|----------|
| `critical` | SSH keys, AWS creds, .env files, PEM/key/PKCS12 files | Maximum flexibility |
| `high` (default) | + secrets/credentials files, env dumps, secret-variable echoes, exfiltration, copy/move/delete of secrets | Recommended |
| `strict` | + database configs, known_hosts, .gitconfig, recursive greps for passwords | Maximum safety |

## Configuration

All optional, set via environment variables (in the hook command, or exported where Claude Code runs):

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`, so a typo can never silently disable the guard. |
| `HOOK_ASK_CRITICAL` | unset (deny) | Literal string `true` makes `critical`-level matches prompt you instead of blocking. |
| `HOOK_ASK_HIGH` | unset (deny) | Same, for `high`-level matches. |
| `HOOK_ASK_STRICT` | unset (deny) | Same, for `strict`-level matches. |

Ask mode is strictly opt-in and per level: only the literal string `true` enables it, and enabling it for one level never softens another. A common setup: keep `critical` on deny, set `HOOK_ASK_STRICT=true` so cautionary patterns prompt instead of blocking.

## Data & privacy

Logs each deny/ask decision to `~/.claude/hooks-logs/<date>.jsonl`: pattern id, level, tool, target (file path or the command's first 100 chars), session id, and cwd. It makes no network calls (the script only uses `fs` and `path`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall protect-secrets@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks); pairs well with `block-dangerous-commands` for comprehensive safety.
