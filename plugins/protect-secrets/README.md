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

A wave of "token saver" plugins for Claude Code hands file reads to a cheaper worker model. Spotify's [shunt](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt) started it: a PreToolUse hook blocks `cat`/`head`/`tail` on large files and steers Claude to a script that wraps each file in XML tags and ships the whole corpus to a worker model from a Bash call ([their write-up](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90) runs Gemini 2.5 Flash as the worker). Neither the plugin nor the post mentions exclusions or redaction. Whatever the file holds goes verbatim to the worker. Copycats do the same with a one-liner: `cat src/*.ts | gemini -p "summarize"`.

That matters because a consumer-tier model API is not a private channel. Google's [Gemini API terms](https://ai.google.dev/gemini-api/terms) say for Unpaid Services that "Google uses the content you submit to the Services and any generated responses to provide, improve, and develop Google products and services and machine learning technologies" and that "human reviewers may read, annotate, and process your API input and output". A `.env` piped into a free-tier CLI can end up in a training set. Paid tiers carry different terms on the same page; check the one your key runs under.

protect-secrets already blocked uploads of secret files via curl, scp, and rsync. This section adds the model sinks.

### What is caught

| Level | Pattern id | Catches | Example |
|-------|-----------|---------|---------|
| `high` | `model-cli-secret-file` | A secrets file reaching a model CLI by `<` redirect, `$(cat ...)`, `$(< ...)`, a file flag, or a pipe | `gemini -p "review" < .env`, `aichat -f secrets.json "explain"`, `sops -d secrets.yaml \| llm` |
| `high` | `model-cli-secret-var` | A secret-named env var (`*SECRET*`, `*KEY*`, `*TOKEN*`, `*PASSWORD*`, ...) passed to a model CLI | `gemini -p "$GEMINI_API_KEY"` |
| `high` | `model-api-secret-body` | A request to a model API host whose body comes from a secrets file or contains a secret var | `curl https://api.openai.com/v1/chat/completions -d '{"c":"'"$OPENAI_API_KEY"'"}'` |
| `strict` | `model-cli-file-input` | Any file contents reaching a model CLI (pipe from `cat`/`head`/`tail`/`git diff`, `<`, `$(cat ...)`, a file flag) | `cat src/a.ts src/b.ts \| gemini -p "summarize"`, `llm -m gpt-4o < notes.md`, `codex exec "$(cat file.py)"` |
| `strict` | `model-api-file-body` | Any file body sent to a model API host (`-d @file`, `--data-binary @file`, `-d "$(cat file)"`, `< file`, httpie `@file`, wget `--post-file`) | `curl https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent -d @payload.json` |

Some sink commands hit an older pattern first, because patterns run in level order: `cat .env | gemini -p x` is denied as `cat-env`, `echo "$OPENAI_API_KEY" | llm` as `echo-secret-var`, `curl -F file=@.env https://api.openai.com/...` as `curl-upload-env`. The deny is the same; only the id differs.

Not caught, by design: `gemini --version`, `llm models`, `codex --help`, `curl https://api.openai.com/v1/models` (no body), a key in an `Authorization` header with an inline JSON body (that is how the API is normally called), heredocs and herestrings, `grep -r gemini src/`, `npm run codex-lint`, and local models such as `ollama run llama3 < file.txt`. Local sinks have no egress, so they are out of scope; add the CLI name to `SINK_CLI` in a fork if your threat model differs.

**Why strict is opt-in.** Many people pipe code to a second model on purpose, and that is their call to make. The default `high` level only fires when secret material is on the wire. Set `HOOK_SAFETY_LEVEL=strict` when the rule for your machine is "no file leaves for an external model without a prompt", and pair it with `HOOK_ASK_STRICT=true` so you get a yes/no instead of a wall.

### Sinks

Model CLIs matched in command position (start of line, after `|`, `;`, `&&`, `(` or a backtick, optionally behind `sudo`, `npx`, `uvx`, `bunx`, or a path): [gemini](https://github.com/google-gemini/gemini-cli), [codex](https://github.com/openai/codex), [llm](https://github.com/simonw/llm), [sgpt](https://github.com/TheR1D/shell_gpt), [aichat](https://github.com/sigoden/aichat), [openai](https://github.com/openai/openai-cli), [mods](https://github.com/charmbracelet/mods) (archived upstream, still installed widely), [fabric](https://github.com/danielmiessler/Fabric).

Model API hosts matched in a `curl`, `wget`, `http` (httpie), or `xh` command: `generativelanguage.googleapis.com`, `aiplatform.googleapis.com`, `api.openai.com`, `*.openai.azure.com`, `api.anthropic.com`, `openrouter.ai`, `api.mistral.ai`, `api.groq.com`, `api.together.xyz`, `api.deepseek.com`, `api.x.ai`, `api.cohere.com`, `api.perplexity.ai`.

### Allowing a specific flow

There is no per-pattern allowlist. Three levers:

1. **Ask instead of deny.** `HOOK_ASK_HIGH=true` turns every `high` match into a prompt that names the pattern id; approve the one flow you meant. Known false positive at `high`: `llm keys set openai --value "$OPENAI_API_KEY"` stores a key locally but matches `model-cli-secret-var`. Ask mode is the way through.
2. **Keep the secret off the command line.** Let the CLI read its key from the environment or its own config (`gemini`, `llm`, `sgpt`, `aichat` all do), and never pass a secrets file as input. The default level then never fires.
3. **Drop to `critical`** if you want none of the `high` tier. That also drops the curl/scp/rsync exfiltration patterns, so prefer lever 1.

### Native pairing

This hook sees the command string only. A script that opens files itself (shunt's `bulk-read`, a Python helper, `xargs`) is opaque to any PreToolUse Bash regex. Two native Claude Code controls close that gap from the other side:

- **`permissions.deny` on `Read`** stops both the Read tool and Bash reads of the same paths. Per the [permissions docs](https://code.claude.com/docs/en/permissions#read-and-edit): "Read and Edit deny rules apply to Claude's built-in file tools, to file commands Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, and `sed`, and to the targets of Bash redirections such as `> file` and `< file`." The `< file` half landed in [2.1.257](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md): "Fixed Bash `Read()`/`Edit()` deny rules not applying to `< file` redirects and reader commands like `tac` and `egrep`; a deny rule on any argument or redirect target now refuses the command". Option-value forms (`-f.env`, `@file`) followed in 2.1.259. Same docs, same limit as this hook: a subprocess that opens files itself is not covered.
- **Sandbox network allowlist** decides which hosts a Bash command may reach at all, enforced by the OS. Keys per the [sandboxing docs](https://code.claude.com/docs/en/sandboxing#network-isolation): `sandbox.network.allowedDomains`, `sandbox.network.deniedDomains`, and `sandbox.network.strictAllowlist` (deny instead of prompt; honored in user, managed, or `--settings` scope only, Claude Code 2.1.219 or later). A model API host that is not on the list is unreachable no matter what the command looks like.

`~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": [
      "Read(.env)",
      "Read(.env.*)",
      "Read(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Read(**/*.pem)",
      "Read(**/credentials.json)"
    ]
  },
  "sandbox": {
    "enabled": true,
    "network": {
      "allowedDomains": ["github.com", "registry.npmjs.org"],
      "strictAllowlist": true
    }
  }
}
```

Add your worker model's host to `allowedDomains` only if you have decided that files may go there; then this hook still keeps secrets out of that channel.

## Data & privacy

Logs each deny/ask decision to `~/.claude/hooks-logs/<date>.jsonl`: pattern id, level, tool, target (file path or the command's first 100 chars), session id, and cwd. It makes no network calls (the script only uses `fs` and `path`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall protect-secrets@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks); pairs well with `block-dangerous-commands` for comprehensive safety.
