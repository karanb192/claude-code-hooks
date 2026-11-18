# config-guard

> Blocks writes to the configuration files that register guardrails, including the hook scripts and installed Codex plugins.

A `PreToolUse` hook fires before every `Bash`, `Edit`, `MultiEdit`, and `Write` call and denies any mutation of the files that wire your guardrails: settings files that register hooks and permissions, the hook scripts themselves, `hooks.json` manifests, `.mcp.json`, and plugin config. Reads always pass (agents legitimately read settings); only writes, in-place edits, moves, copies onto, symlink swaps, and deletes are stopped, plus the `claude config set`, `claude mcp add`, and `claude plugin install` CLI forms that rewrite agent config without naming a settings path. Creating a protected file that does not exist yet also counts as mutation: that was the CVE-2026-25725 persistence vector, and the Aug 2026 CHAINDROP npm worm hid its payload in `.claude/settings.json` the same way. Edit/MultiEdit/Write paths are resolved through symlinks before checking, so a write through `ln -s ~/.claude /tmp/x` is still caught.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install config-guard@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install config-guard@claude-code-hooks`.)

## Codex CLI

```sh
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add config-guard@claude-code-hooks
```

Open `/hooks` in Codex and approve this plugin. Re-approve after every update; Codex skips unapproved or changed hooks. Do not install it alongside [guard-pack](../guard-pack#codex-cli), which includes this guard.

This entry point checks `Bash` and native `apply_patch` calls. Patch files are checked individually; unreadable patches are blocked. Shell patches must use a plain command with a quoted heredoc. Literal searches and commit messages mentioning `apply_patch` pass. See [the shared adapter's limits](../guard-pack#codex-cli), including shell sessions and dynamically constructed commands.

Export configuration variables before launching Codex. An ask-mode match becomes a block because Codex hooks cannot ask. Logs stay in `~/.claude/hooks-logs/` with `host: "codex"`, including on Codex-only machines.

## What it does

| Event | Matcher | What happens |
|-------|---------|--------------|
| PreToolUse | `Bash\|Edit\|MultiEdit\|Write` | Checks the target path (Edit/MultiEdit/Write) or command string (Bash) against the protected set for the active safety level; returns `permissionDecision: "deny"` (or `"ask"` in ask mode) with the pattern id and reason, `{}` otherwise. |

Three safety levels, each including the previous. Native file paths are normalized and resolved; shell paths use text matching with the limits below.

| Level | Protects |
|-------|----------|
| `critical` | The enforcement chain: `.claude/settings.json`, `.claude/settings.local.json`, `managed-settings.json`, anything under `.claude/hooks/`, `hooks.json` manifests, `.codex/config.toml`, `.codex/plugins/` and the corresponding paths under a custom `CODEX_HOME`. Deleting the Codex home itself also counts. |
| `high` (default) | Plus the config supply chain: `.mcp.json`, `.claude-plugin/`, `.codex-plugin/`, Claude config/mcp/plugin write commands, and `codex plugin add\|remove`, `codex plugin marketplace add\|remove\|upgrade`, `codex mcp add\|remove`, `codex features enable\|disable`. List/get forms stay allowed. |
| `strict` | Plus instruction files that steer the agent: `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `.claude/rules/`, `.claude/agents/`, `.claude/commands/`. |

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`. Env-only on purpose: plugin updates overwrite installed files, so never edit the script. |
| `CONFIG_GUARD_ALLOW` | unset | Escape hatch for an intentional, human-approved config change: the literal string `true` lets the call through (anything else still denies). Export it for one shell call, or prefix a single hook command with it in settings.json. |
| `HOOK_ASK_CRITICAL` | unset | `true` prompts the user instead of denying for `critical`-level matches. |
| `HOOK_ASK_HIGH` | unset | `true` prompts instead of denying for `high`-level matches. |
| `HOOK_ASK_STRICT` | unset | `true` prompts instead of denying for `strict`-level matches. |
| `HOOK_FAIL_OPEN` | unset (deny) | The literal string `true` lets the call through when the guard's own check throws, instead of denying it. See [When the guard fails](#when-the-guard-fails). |

Ask mode is strictly per level and opt-in: everything defaults to deny.

## Known limits

Deliberately not a full shell parser: a mutation verb and a protected path in the same Bash command block it even if the verb technically targets another argument. Interpreter one-liners (`python -c "open(...).write(...)"`), `git checkout/restore` of a config path, `chmod`, and paths built from variables (`"$DIR/settings.json"`) are not caught. Shell command strings are matched as text, so a Bash redirect through a symlinked directory is not resolved. PreToolUse only sees the agent's own tool calls; out-of-band changes are covered by its sibling [config-watch](https://github.com/karanb192/claude-code-hooks) (ConfigChange event) in the root repo.

Starting a child agent with per-run config overrides, such as `codex exec -c features.hooks=false`, `codex --disable hooks exec`, or `claude --settings`, is not blocked by the CLI-write patterns. Keep the agent's sandbox and permission controls in place; this hook is not a boundary against arbitrary code execution.

The protected Codex set is listed above. Other files, including `.codex/rules/*.rules` and additional profile configuration files, are not included. Shell deletion forms such as `find ... -delete` are also outside the mutation patterns.

Shell paths must use conventional spellings. Home-directory deletion with a trailing `/` or `/*` is checked, but partial globs, brace expansion, repeated slashes and dot segments are not normalized: `~/.codex/plugin*`, `~/.codex/conf*.toml`, `~/.codex/{config.toml,x}`, `~/.codex/./plugins` and `~/.codex//config.toml` can pass. Native patch paths are normalized separately and do not have this shell-spelling limitation.

CLI-write checks recognize the documented Codex 0.169.0 global options and its `--yolo` alias. They do not parse quoted command/subcommand words or unknown future flags. Because they scan command text, literal searches, printed text and commit messages that contain `codex plugin add` or a similar write command can be refused. The Claude CLI patterns have the same text-matching limits.

## When the guard fails

From 1.2.0, a guard that cannot finish its check refuses the call instead of allowing it. A check that throws is denied with a `[guard-error]` reason. A timeout (10 s) or a missing `node` is blocked by `"onFailure": "block"` on Claude Code v2.1.295 or later; older versions ignore that key and let the call run. On Codex a missing `node` is blocked by the command's `|| exit 2`, but a timeout still lets the call run, because Codex has no setting for it. Set `HOOK_FAIL_OPEN=true` to let the call through when the check throws; [When a guard fails](../../README.md#-when-a-guard-fails) covers the rest of the way back.

## Data & privacy

Logs decisions (pattern id, tool, truncated target, session id) to `~/.claude/hooks-logs/`. No network calls; everything stays on your local machine.

## Uninstall

```
/plugin uninstall config-guard@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
