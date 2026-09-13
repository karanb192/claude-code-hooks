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

## Data & privacy

Logs each deny/ask decision to `~/.claude/hooks-logs/<date>.jsonl`: pattern id, level, tool, target (file path or the command's first 100 chars), session id, and cwd. It makes no network calls (the script only uses `fs` and `path`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall protect-secrets@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks); pairs well with `block-dangerous-commands` for comprehensive safety.
