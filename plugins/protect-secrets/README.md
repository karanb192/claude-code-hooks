# protect-secrets

> Secrets firewall: stops Claude from reading, modifying, or exfiltrating sensitive files (.env, SSH keys, cloud credentials) before the tool call runs.

A `PreToolUse` hook fires before every `Read`, `Edit`, `Write`, `Bash`, and `Grep` call. File tools and searches are checked against sensitive-path patterns (.env and .envrc, SSH private keys and authorized_keys, AWS/kube/gcloud/azure/docker credentials, .netrc/.npmrc/.pypirc, PEM/key/PKCS12 files, keystores, vault tokens); Bash commands are checked against secret-exposing patterns (cat/less/head on secrets, `printenv` and bare `env` dumps, `echo $SECRET_KEY`-style variable prints, sourcing .env, `/proc/*/environ`) and exfiltration patterns (curl/wget uploads, scp/rsync/nc of secrets, plus cp/mv/rm/truncate on them). Every file the file tools refuse is refused to the shell too, at the same level: a command that reads it (cat, sed, sort, nl, strings, xxd, base64, `dd if=` and the other text and byte readers), sources it, takes it through `<` or writes it through `>`, `>>` or tee, copies, moves, links, deletes or truncates it, or sends it with scp, rsync, or a curl or wget upload argument (`-T`, `-d @`, `--json @`, `--data-urlencode name@`, `-F name=@` or `name=<`, `--post-file`, `--body-file`) is denied. So are `cp`, `mv`, `rm`, scp and rsync of a whole `~/.ssh`, `~/.aws` or `~/.kube` directory, and a dotfile glob such as `.e*` that can match a secret. A match returns `permissionDecision: "deny"` (or `"ask"`, see below) with the pattern id and reason, so you always know exactly which rule fired. Template files like `.env.example`, `.env.sample`, and `.env.template` are explicitly allowlisted. In a Bash command the allowlist applies to each path on its own, so a template name elsewhere in the command (`cat .env # .env.example`) does not clear the real file. Path matching is separator-agnostic, so a Windows `C:\Users\me\project\.env` is treated exactly like `/home/me/project/.env`.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install protect-secrets@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install protect-secrets@claude-code-hooks`.)

## Codex CLI

```sh
codex plugin marketplace add karanb192/claude-code-hooks
codex plugin add protect-secrets@claude-code-hooks
```

Open `/hooks` in Codex and approve this plugin. Re-approve after every update; Codex skips unapproved or changed hooks. Do not install it alongside [guard-pack](../guard-pack#codex-cli), which includes this guard.

This entry point checks `Bash` and native `apply_patch` calls. Patch files are checked individually; unreadable patches are blocked. Shell patches must use a plain command with a quoted heredoc; `apply_patch` anywhere else in a command, such as behind `timeout` or `eval`, is blocked. Literal searches and commit messages mentioning `apply_patch` pass. See [the shared adapter's limits](../guard-pack#codex-cli), including shell sessions and dynamically constructed commands.

Export configuration variables before launching Codex. An ask-mode match becomes a block because Codex hooks cannot ask. Logs stay in `~/.claude/hooks-logs/` with `host: "codex"`, including on Codex-only machines.

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| PreToolUse (`Read\|Edit\|Write\|Bash\|Grep`) | sync (must decide before the tool runs) | Matches the file path (Read/Edit/Write), the search target (Grep) or the command (Bash) against tiered sensitive patterns; on a hit, denies or asks with the pattern id and reason. Everything else passes through untouched. |

## How it reads a Bash command

It shares its command reader with [block-dangerous-commands](../block-dangerous-commands#how-it-reads-a-command). Quotes and escapes do not change the verdict: `cat ./.e"nv"`, `c''at .env` and `cat .\env` are refused like `cat .env`, as is a read inside a substitution such as `echo "$(c'a't .env)"`. Quoted `echo`, `printf`, commit and heredoc text that only mentions a secret file is not matched, so `echo 'never cat .env'` is allowed. A double-quoted string that expands is not a message: `echo "$API_KEY"` is still refused.

A word whose quotes hold a space keeps its quotes for the patterns, but the file check reads each operand as bash passes it, so `cat "my dir/.e"nv` is refused as a read of `.env`.

## Search and Windows coverage

`Grep` checks `path`, `glob`, and the legacy `include` field, plus each filter joined to the search directory. For example, `path: C:\Users\me\.aws` with `glob: credentials` is blocked. Every candidate is checked at the configured safety level; an allowed template or an inactive rule cannot hide another sensitive target. When several targets match, the most severe rule wins.

The guard normalizes backslashes in file and search targets, including relative paths, UNC paths, and mixed separators. It does not resolve symlinks, expand globs, or change filename case rules. Bash command strings keep their existing checks because backslashes there can be shell escapes. `PowerShell` calls are outside this plugin's matcher.

**Broad searches can still expose secrets.** A directory-only search, a pattern-only search, or a glob such as `*` need not name a sensitive file. This hook does not enumerate the files a search will read or filter its output. Use the [native permissions and sandbox controls](#native-pairing) alongside it.

## Safety levels

Patterns are tiered; each level includes everything below it:

| Level | Blocks | Use case |
|-------|--------|----------|
| `critical` | SSH keys, AWS creds, .env files, PEM/key/PKCS12 files | Maximum flexibility |
| `high` (default) | + secrets/credentials files, env dumps, secret-variable echoes, exfiltration, copy/move/delete of secrets, secrets fed to an external model CLI or model API ([delegation sinks](#delegation-sinks)) | Recommended |
| `strict` | + database configs, known_hosts, .gitconfig, recursive greps for passwords, any file contents fed to an external model | Maximum safety |

## Configuration

All optional, set via environment variables (in the hook command, or exported where Claude Code runs):

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_SAFETY_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`, so a typo can never silently disable the guard. |
| `HOOK_ASK_CRITICAL` | unset (deny) | Literal string `true` makes `critical`-level matches prompt you instead of blocking. |
| `HOOK_ASK_HIGH` | unset (deny) | Same, for `high`-level matches. |
| `HOOK_ASK_STRICT` | unset (deny) | Same, for `strict`-level matches. |
| `HOOK_FAIL_OPEN` | unset (deny) | The literal string `true` lets the call through when the guard's own check throws, instead of denying it. See [When the guard fails](#when-the-guard-fails). |

Ask mode is strictly opt-in and per level: only the literal string `true` enables it, and enabling it for one level never softens another. A common setup: keep `critical` on deny, set `HOOK_ASK_STRICT=true` so cautionary patterns prompt instead of blocking.

## Delegation sinks

Token-saver plugins such as Spotify's [shunt](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt) route file contents to a worker model from a Bash call with no redaction ([write-up](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90)). On Google's unpaid tier the [Gemini API terms](https://ai.google.dev/gemini-api/terms) let that content be used to "provide, improve, and develop Google products and services" and be read by human reviewers. These patterns keep secrets, and at `strict` any file, away from such a sink.

| Level | Pattern id | Catches | Example |
|-------|-----------|---------|---------|
| `high` | `model-cli-secret-file` | A secret file (the `critical` and `high` names above) reaching a model CLI via `<`, `$(...)`, a file flag, or a pipe from a reader | `gemini -p "review" < .env` |
| `high` | `model-cli-secret-var` | A secret-named variable (`$OPENAI_API_KEY`, `$GH_PAT`; `$AUTHOR` and `$KEYWORDS` are prose) passed to a model CLI | `gemini -p "$GEMINI_API_KEY"` |
| `high` | `model-api-secret-body` | A request to a model API host with a secret file or secret var in its body (`-d @`, `-F x=@`, `-T`, `< file`, httpie `x=@`) | `curl https://api.openai.com/v1/chat/completions -d "prompt=$OPENAI_API_KEY"` |
| `strict` | `model-cli-file-input` | Any file contents reaching a model CLI (reader pipe, `<`, `$(cat ...)`, per-CLI file flags, gemini `@path`) | `cat src/*.ts \| gemini -p "summarize"` |
| `strict` | `model-api-file-body` | Any file body sent to a model API host | `curl https://api.openai.com/v1/chat/completions -d @body.json` |

Strict is opt-in: many people pipe code to a second model on purpose, so the default only fires when secret material is on the wire. An older pattern wins when it matches first (`cat .env | gemini` is `cat-env`). Not caught by design: `gemini --version`, `curl https://api.openai.com/v1/models`, a key in an `Authorization` header with an inline body, heredocs and herestrings, prose that names a secret file inside a quoted prompt, a secret used by an earlier command in the pipeline, local models such as `ollama`. Out of reach for a regex on the command string: variable indirection (`K=$KEY; gemini "$K"`), credential emitters (`$(gh auth token)`), scripts that open the connection themselves, file names outside the list above.

Sinks: [gemini](https://github.com/google-gemini/gemini-cli), [codex](https://github.com/openai/codex), [llm](https://github.com/simonw/llm), [sgpt](https://github.com/TheR1D/shell_gpt), [aichat](https://github.com/sigoden/aichat), [openai](https://github.com/openai/openai-cli), [mods](https://github.com/charmbracelet/mods) (archived upstream), [fabric](https://github.com/danielmiessler/Fabric); matched behind env assignments, `sudo`, `npx`, `uvx`, `bunx`, `pnpm dlx`, `env`, `timeout`, `nice`, `nohup`, `exec`, `command`, `time`, `xargs`, a path or an npm scope. API hosts in `curl`, `curlie`, `wget`, `http`, `https`, `xh`: `generativelanguage.googleapis.com`, `aiplatform.googleapis.com`, `api.openai.com`, `*.openai.azure.com`, `api.anthropic.com`, `openrouter.ai`, `api.mistral.ai`, `api.groq.com`, `api.together.xyz`, `api.deepseek.com`, `api.x.ai`, `api.cohere.com`, `api.perplexity.ai`, `api.fireworks.ai`, `api.cerebras.ai`, `router.huggingface.co`, `bedrock-runtime.<region>.amazonaws.com`, `integrate.api.nvidia.com`, `api.deepinfra.com`.

To allow one flow, set `HOOK_ASK_HIGH=true` (or `HOOK_ASK_STRICT=true`): the match becomes a prompt that names the pattern id. Known false positives: `llm keys set openai --value "$OPENAI_API_KEY"` at high; `codex -i image.png` and `fabric -a image.png` at strict.

### Native pairing

This hook sees the command string only, so a script that opens files itself is opaque to it. Two native controls close that gap: `Read` deny rules in `permissions.deny` also apply to Bash `cat`, reader commands and `< file` redirects (the redirect half since [2.1.257](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), see the [permissions docs](https://code.claude.com/docs/en/permissions#read-and-edit)), and the sandbox network allowlist (`sandbox.network.allowedDomains` with `strictAllowlist`, see the [sandboxing docs](https://code.claude.com/docs/en/sandboxing#network-isolation)) makes an unlisted model host unreachable whatever the command looks like.

```json
{
  "permissions": { "deny": ["Read(.env)", "Read(.env.*)", "Read(~/.ssh/**)", "Read(~/.aws/**)", "Read(**/*.pem)"] },
  "sandbox": { "enabled": true, "network": { "allowedDomains": ["github.com", "registry.npmjs.org"], "strictAllowlist": true } }
}
```

## When the guard fails

From 1.3.0, a guard that cannot finish its check refuses the call instead of allowing it. A check that throws is denied with a `[guard-error]` reason. A timeout (10 s) or a missing `node` is blocked by `"onFailure": "block"` on Claude Code v2.1.295 or later; older versions ignore that key and let the call run. On Codex a missing `node` is blocked by the command's `|| exit 2`, but a timeout still lets the call run, because Codex has no setting for it. Set `HOOK_FAIL_OPEN=true` to let the call through when the check throws; [When a guard fails](../../README.md#-when-a-guard-fails) covers the rest of the way back.

## Data & privacy

Logs each deny/ask decision to `~/.claude/hooks-logs/<date>.jsonl`: pattern id, level, tool, target (file path or the command's first 100 chars), session id, and cwd. Grep decisions record the rule and tool, without a target field. The home directory comes from `HOME`, then `USERPROFILE`, then the operating system. It makes no network calls, so everything stays on your local machine.

## Uninstall

```
/plugin uninstall protect-secrets@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks); pairs well with `block-dangerous-commands` for comprehensive safety.
