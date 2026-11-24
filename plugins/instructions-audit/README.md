# instructions-audit

> Prompt-injection tripwire for instruction files: audits CLAUDE.md and `.claude/rules/*.md` (the files read at session start and those that load later), and locks the session when a file carries hidden or hostile directives.

The hook scans instruction files for invisible Unicode smuggling (zero width characters, tag characters, invisible operators, variation-selector runs; the TrapDoor supply-chain signature), bidi overrides, decode-and-execute constructs, directives to read or exfiltrate secret material, `curl|sh`, and directives that make the agent rewrite its own hook or settings configuration. Each finding names the rule and the line (and column, for invisible characters) so a human can inspect the file; quoted excerpts are sanitized so the report itself cannot smuggle text into the transcript.

`InstructionsLoaded` has no decision control on current Claude Code builds (verified live: exit code ignored, even the universal `continue: false` ignored), so detection and enforcement are split. A finding writes a per-session lockdown flag (and still emits `continue: false` for builds that honor it); the same script registered on `UserPromptSubmit` and `PreToolUse` then blocks every prompt and denies every tool call for that session, so the poisoned instructions are never acted on. This is the win of the plugin: one install wires all three arms instead of three manual `settings.json` registrations.

Claude Code fires `InstructionsLoaded` for the files it reads at session start before a plugin's hooks are registered, so as a plugin the hook never sees those loads. The first `UserPromptSubmit` or `PreToolUse` of each session therefore audits the start-up files itself and locks before the model acts: the managed-policy `CLAUDE.md`, `~/.claude/CLAUDE.md` and `~/.claude/rules/`, and in the working directory and every parent `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `AGENTS.md` and `.claude/rules/`, plus their `@` imports up to five hops. This runs once per session, whether the hook is installed as a plugin or through `settings.json`; files that load later (a nested `CLAUDE.md`, a path-matched rule) are audited by `InstructionsLoaded` as they load.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install instructions-audit@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install instructions-audit@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| InstructionsLoaded (no matcher: every load reason is audited) | sync | Audits files that load during the session (as a plugin, the session-start loads fire before the hook registers; see below). Audits the loaded content (falls back to reading `file_path` when the payload has no inline content). On a finding: logs, reports via `systemMessage` and stderr, writes the per-session lock flag, and emits `continue: false` + `stopReason` for builds that honor them. Clean files return `{}`. |
| UserPromptSubmit | sync (must decide before the prompt) | On the first prompt or tool call of a session, audits the start-up instruction files and locks on a finding. If the session is locked, blocks the prompt (`decision: "block"`) with a notice naming the poisoned file, the first rule that fired, and the flag file to delete. Unlocked sessions pass untouched. |
| PreToolUse (no matcher: every tool call is checked) | sync (must decide before the tool runs) | Same start-up audit (for a session that begins with a tool call) and the same lock check; a locked session gets `permissionDecision: "deny"` on every tool call. Unlocked sessions pass untouched. |

The start-up scan is bounded: at most 200 files, 2 MB per file and 16 MB in all, `@` imports up to five hops, `.claude/rules/` six directories deep. A start-up set past those limits blocks the prompt or tool call with a `[guard-error]` notice instead of passing unaudited; `HOOK_FAIL_OPEN=true` lets calls through when the audit cannot run.

The report lists up to 12 findings and counts the rest. The lock notice tells you how to recover: fix or quarantine the file and start a fresh session, or delete the named flag file if the findings are false positives.

## Safety levels

Rules are tiered; each level includes everything below it:

| Level | Flags | Use case |
|-------|-------|----------|
| `critical` | Invisible Unicode smuggling (zero width chars, tag characters, invisible operators, variation-selector runs), bidi overrides, decode-and-execute | Maximum flexibility |
| `high` (default) | + secret read/exfil directives, curl\|sh, hook/settings tampering | Recommended |
| `strict` | + soft hyphens, invisible direction marks (legitimate in RTL prose), directives that write new instruction files | Maximum safety |

## Configuration

All optional, set via environment variables (in the hook command, or exported where Claude Code runs):

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOOK_AUDIT_LEVEL` | `high` | Safety level: `critical`, `high`, or `strict`. Invalid values fall back to `high`, so a typo can never silently disable the audit. |
| `HOOK_AUDIT_WARN_ONLY` | unset (lock) | Literal string `true` surfaces the findings report without locking the session. |
| `HOOK_FAIL_OPEN` | unset (block) | Literal string `true` lets prompts and tool calls through when the start-up files cannot be audited (past the limits above). |

## Precision notes

False positives on normal CLAUDE.md content are the failure mode here, so the tradeoffs are deliberate:

- Code fences are NOT exempt: fenced text in an instruction file still reads as instructions to the agent, and exempting fences would hand attackers a trivial wrapper bypass. A literal `curl ... | sh` install one-liner in your CLAUDE.md will be flagged; rewrite it as prose.
- Lines whose action verb is negated ("Never read the .env file") are treated as defensive prose and skipped by the directive rules. Bypassable by design: the PreToolUse guards in this repo still block the actual execution, this hook is the earlier tripwire.
- Emoji ZWJ sequences and joiners inside non-ASCII joining-script text (Arabic, Indic conjuncts) are exempt from the invisible-char rules; a UTF-8 BOM at offset 0 is exempt too. Single variation selectors are legitimate emoji/CJK presentation; only a run of 4 or more flags.

## Data & privacy

Logs each halt/warn to `~/.claude/hooks-logs/<date>.jsonl`: file path, load reason, session id, cwd, and the rule ids and lines that fired. Session lock flags live under `~/.claude/hooks-state/instructions-audit/<session>.json`, next to a `<session>.audited` marker that records the start-up audit ran; both are swept after 7 days. It makes no network calls (the script only uses `fs` and `path`), so everything stays on your local machine.

## Uninstall

```
/plugin uninstall instructions-audit@claude-code-hooks
```

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks); pairs well with `protect-secrets` and `config-guard`, which block the operations this hook can only flag in prose.
