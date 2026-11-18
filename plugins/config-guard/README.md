# config-guard

> Blocks writes to the configuration files that register guardrails, including the hook scripts and the installed Claude Code and Codex plugins.

A `PreToolUse` hook fires before every `Bash`, `Edit`, `MultiEdit`, and `Write` call and denies any mutation of the files that wire your guardrails: settings files that register hooks and permissions, the hook scripts themselves, `hooks.json` manifests, the installed plugin code under `~/.claude/plugins/`, `.mcp.json` and `~/.claude.json`, plugin config, and the subagent spawn cap's ledger. Reads always pass (agents legitimately read settings); only writes, in-place edits, moves, copies onto, symlink swaps, and deletes are stopped, plus the `claude config set`, `claude mcp add`, and `claude plugin install` CLI forms that rewrite agent config without naming a settings path. Creating a protected file that does not exist yet also counts as mutation: that was the CVE-2026-25725 persistence vector, and the Aug 2026 CHAINDROP npm worm hid its payload in `.claude/settings.json` the same way. Edit/MultiEdit/Write paths are resolved through symlinks before checking, so a write through `ln -s ~/.claude /tmp/x` is still caught.

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
| `critical` | The enforcement chain: `.claude/settings.json`, `.claude/settings.local.json`, `managed-settings.json`, anything under `.claude/hooks/`, `hooks.json` manifests, installed Claude Code plugins under `~/.claude/plugins/` (the plugin cache, marketplace clones, `installed_plugins.json`, `known_marketplaces.json`) or under a custom `CLAUDE_CONFIG_DIR`, the spawn cap ledger under `~/.claude/subagent-spawn-cap/`, `.codex/config.toml`, `.codex/plugins/` and the corresponding paths under a custom `CODEX_HOME`. Deleting or moving the Claude config dir (`~/.claude`, `$HOME/.claude`, `$CLAUDE_CONFIG_DIR`) or the Codex home itself also counts. |
| `high` (default) | Plus the config supply chain: `.mcp.json`, `~/.claude.json` (where `claude mcp add` writes user and local MCP servers), `.claude-plugin/`, `.codex-plugin/`, Claude config/mcp/plugin write commands, and `codex plugin add\|remove`, `codex plugin marketplace add\|remove\|upgrade`, `codex mcp add\|remove`, `codex features enable\|disable`. List/get forms stay allowed. |
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

Ask mode is strictly per level and opt-in: everything defaults to deny.

## Installing and updating plugins

The guard sees only the agent's own tool calls. Installing, updating or removing a plugin yourself, through `/plugin` or `claude plugin ...` in your own terminal, is untouched. Reads of the installed plugin files (`Read`, `cat`, `grep`, `ls`, `diff`, running a hook script with `node`) always pass. When the agent itself should change something there, set `CONFIG_GUARD_ALLOW=true` for that session or use ask mode.

## Known limits

Deliberately not a full shell parser: a mutation verb and a protected path in the same Bash command block it even if the verb technically targets another argument. That includes copying a protected file out (`cp ~/.claude/plugins/.../x.js /tmp/`) and an unrelated delete chained after a listing (`ls ~/.claude && rm /tmp/x`).

Text in a heredoc is not read as a command when the whole command has one of two shapes: `cat` or `tee` writing a heredoc (`cat > report.md <<'EOF' ... EOF`), or a `git`/`gh` message passed as `"$(cat <<'EOF'`, the text, then `EOF` and `)"` on their own lines. A report or commit message that names a protected path next to a word such as `install` or `rm` therefore passes. Everything else on those lines is still checked, and the exemption drops when the delimiter is unquoted and the body has `$` or a backtick, or when anything else follows the heredoc. Mentions outside a heredoc, as in `echo` or `git commit -m "..."`, are still refused when the command also contains a mutation verb.

The bare Claude config dir is matched only in its home-anchored spellings. `cd ~ && rm -rf .claude` and a project's own `rm -rf .claude` are not caught. Running Claude Code with `--plugin-dir` loads plugin code from that folder, which is not protected.

Interpreter one-liners (`python -c "open(...).write(...)"`), `git checkout/restore` of a config path, `chmod`, and paths built from variables (`"$DIR/settings.json"`) are not caught. Shell command strings are matched as text, so a Bash redirect through a symlinked directory is not resolved. PreToolUse only sees the agent's own tool calls; out-of-band changes are covered by its sibling [config-watch](https://github.com/karanb192/claude-code-hooks) (ConfigChange event) in the root repo.

Starting a child agent with per-run config overrides, such as `codex exec -c features.hooks=false`, `codex --disable hooks exec`, or `claude --settings`, is not blocked by the CLI-write patterns. Keep the agent's sandbox and permission controls in place; this hook is not a boundary against arbitrary code execution.

The protected Codex set is listed above. Other files, including `.codex/rules/*.rules` and additional profile configuration files, are not included. Shell deletion forms such as `find ... -delete` are also outside the mutation patterns.

Shell paths must use conventional spellings. Home-directory deletion with a trailing `/` or `/*` is checked, but partial globs, brace expansion, repeated slashes and dot segments are not normalized: `~/.codex/plugin*`, `~/.codex/conf*.toml`, `~/.codex/{config.toml,x}`, `~/.codex/./plugins` and `~/.codex//config.toml` can pass. Native patch paths are normalized separately and do not have this shell-spelling limitation.

CLI-write checks recognize the documented Codex 0.169.0 global options and its `--yolo` alias. They do not parse quoted command/subcommand words or unknown future flags. Because they scan command text, literal searches, printed text and commit messages that contain `codex plugin add` or a similar write command can be refused, unless the text sits in one of the heredoc shapes above. The Claude CLI patterns have the same text-matching limits.

## Data & privacy

Logs decisions (pattern id, tool, truncated target, session id) to `~/.claude/hooks-logs/`. No network calls; everything stays on your local machine.

## Uninstall

```
/plugin uninstall config-guard@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
