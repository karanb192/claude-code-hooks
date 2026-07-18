# claude-code-hooks

🪝 Ready-to-use hooks for Claude Code — plus a 7-plugin installable marketplace: safety, automation, notifications, and more.

[![GitHub stars](https://img.shields.io/github/stars/karanb192/claude-code-hooks?style=social)](https://github.com/karanb192/claude-code-hooks)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-1165%20passing-brightgreen)](https://github.com/karanb192/claude-code-hooks/actions)

**🌐 [Live site & catalog](https://karanb192.github.io/claude-code-hooks/)**

### 🎬 Quick Demo

<table>
  <tr>
    <th align="center">Protecting Secrets</th>
    <th align="center">Blocking Dangerous Commands</th>
  </tr>
  <tr>
    <td valign="bottom" align="center"><img src="assets/block-secrets.png" alt="Hook blocking .env read" width="400"></td>
    <td valign="bottom" align="center"><img src="assets/block-dangerous-commands.png" alt="Hook blocking dangerous commands" width="400"></td>
  </tr>
</table>

A growing collection of tested, documented hooks you can copy, paste, and customize.

> 🔌 **New:** these hooks also install as one-command Claude Code plugins. Run `/plugin marketplace add karanb192/claude-code-hooks`, then `/plugin install <name>@claude-code-hooks` — see [Install as a plugin](#-install-as-a-plugin) for the 7-plugin catalog.

---

## 📑 Table of Contents

- [Hooks](#-hooks)
- [Install as a plugin](#-install-as-a-plugin)
- [Quick Start](#-quick-start)
- [Safety Levels](#-safety-levels)
- [Testing](#-testing)
- [Configuration Reference](#-configuration-reference)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🪝 Hooks

### Session Lifecycle

Runs at session boundaries — inject context at **SessionStart** and capture outcomes at **Stop / SessionEnd**.

> 🔌 **`bounty-board`** (repo TODO/FIXME/HACK debt priced as aging XP bounties) now ships as an installable **plugin** — see [Install as a plugin](#-install-as-a-plugin).

> 🔌 **`nerf-receipts`** (personal model-quality flight recorder) and **`standup-autopilot`** (writes your daily standup from what your agents actually did; re-injects open blockers) now ship as installable **plugins** — see [Install as a plugin](#-install-as-a-plugin).

### User-Prompt-Submit

Runs when the user submits a prompt, before Claude processes it. Can inject context or block the prompt.

> 🔌 **`dead-end-registry`** (remembers approaches you tried and reverted, then warns before you retry them) now ships as an installable **plugin** — see [Install as a plugin](#-install-as-a-plugin).

### Pre-Tool-Use

Runs **before** Claude executes a tool. Can block or modify the operation.

| Hook                                                                              | Matcher                   | Description                                                      |
| --------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| [block-dangerous-commands](hook-scripts/pre-tool-use/block-dangerous-commands.js) | `Bash`                    | Blocks dangerous shell commands (rm -rf ~, fork bombs, curl\|sh) |
| [protect-secrets](hook-scripts/pre-tool-use/protect-secrets.js)                   | `Read\|Edit\|Write\|Bash` | Prevents reading/modifying/exfiltrating sensitive files          |
| [git-safety](hook-scripts/pre-tool-use/git-safety.js)                             | `Bash`                    | Branch-aware git guardrails + destructive gh CLI protection      |
| [protect-tests](hook-scripts/pre-tool-use/protect-tests.js)                       | `Bash\|Edit\|MultiEdit\|Write` | Stops "fake green": blocks deleting, renaming-away, or skip/xfail-disabling tests |

### Post-Tool-Use

Runs **after** Claude executes a tool. Can react to results.

| Hook                                                     | Matcher       | Description                                                                   |
| -------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------- |
| [auto-stage](hook-scripts/post-tool-use/auto-stage.js)   | `Edit\|Write` | Automatically git stages files after Claude modifies them                     |
| [format-code](hook-scripts/post-tool-use/format-code.js) | `Write\|Edit` | Auto-formats Python (ruff) and JS/TS/HTML/JSON/MD/YAML (prettier) after edits |

> 🔌 **`context-hogs`** (per-file context-cost leaderboard) and **`pr-provenance-stamp`** (PR-body provenance receipt) now ship as installable **plugins** — see [Install as a plugin](#-install-as-a-plugin).

> 🔌 **`dead-rules-audit`** (CLAUDE.md compliance scorecard) now ships as an installable **plugin** — see [Install as a plugin](#-install-as-a-plugin).

### Notification

Fires when Claude needs user attention.

| Hook                                                                | Matcher                          | Description                                |
| ------------------------------------------------------------------- | -------------------------------- | ------------------------------------------ |
| [notify-permission](hook-scripts/notification/notify-permission.js) | `permission_prompt\|idle_prompt` | Sends Slack alerts when Claude needs input |

### Session

Runs on session lifecycle events — start, end, and tool usage during the session.

| Hook | Matcher | Description |
|------|---------|-------------|
| [session-logger](hook-scripts/session/session-logger.js) | `SessionStart` + `PostToolUse` + `SessionEnd` | Writes a durable markdown log of every session (cwd, git repo, files touched, bash commands). `PostToolUse` registers with `"async": true` so logging never blocks Claude; concurrent writes are serialized with a file lock. Bash commands get best-effort secret redaction. Drop-in for Obsidian vaults via `CC_SESSION_LOG_DIR`. |

### Utils

Tools to help you build and debug hooks.

| Tool                                               | Language | Description                                        |
| -------------------------------------------------- | -------- | -------------------------------------------------- |
| [event-logger](hook-scripts/utils/event-logger.py) | Python   | Logs all hook events to inspect payload structures |

> 💡 **Building a new hook?** Use `event-logger.py` to discover what data Claude Code provides for each event before writing your own hooks.

---

## 🔌 Install as a plugin

This repo is also a **Claude Code plugin marketplace**, so you can install a single hook — no copying scripts, no editing `settings.json` by hand.

**1. Add the marketplace (once):**

```
/plugin marketplace add karanb192/claude-code-hooks
```

**2. Install just the hook you want:**

```
/plugin install context-hogs@claude-code-hooks
```

**3. Restart Claude Code** — the hook is active.

| Plugin                               | What it does                                                                                                                              | Command                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| [context-hogs](plugins/context-hogs) | Per-file context-cost leaderboard — attributes each tool result's tokens to the files it loaded, so you see which files cost you the most | `/context-hogs:leaderboard` renders the board on demand |
| [nerf-receipts](plugins/nerf-receipts) | Personal flight recorder — records your own failure rate, edit churn & tokens/task by model version, and flags real shifts when a model changes | `/nerf-receipts:receipts` renders the trend card on demand |
| [dead-rules-audit](plugins/dead-rules-audit) | CLAUDE.md compliance scorecard — tallies which rules Claude follows vs ignores as you edit (SessionStart + PostToolUse + SessionEnd), and flags chronically-ignored rules to promote into a deterministic hook | `/dead-rules-audit:scorecard` renders the scorecard on demand |
| [pr-provenance-stamp](plugins/pr-provenance-stamp) | Stamps a provenance receipt (prompts, est. spend, tests run, agent-authored lines) into your PR body when Claude runs `gh pr create` | `/pr-provenance-stamp:provenance` renders the receipt on demand |
| [standup-autopilot](plugins/standup-autopilot) | Writes your daily standup from what your agents actually did across repos — captures tasks, tests, PRs, and blockers from session transcripts and re-injects yesterday's open blockers next session | `/standup-autopilot:standup` renders today's card on demand |
| [dead-end-registry](plugins/dead-end-registry) | Remembers approaches you tried and reverted (reason + estimated token cost) and warns before you retry them — a prompt-submit card plus an ask-before-edit guard | `/dead-end-registry:dead-ends` renders the registry on demand |
| [bounty-board](plugins/bounty-board) | Prices your repo's TODO/FIXME/HACK/skip debt as aging XP bounties, injects the top 3 as opportunistic side quests, and verifies + pays out bounties you genuinely clear | `/bounty-board:board` renders the board on demand |

> ⚡ The PostToolUse recorders in these plugins run **async** — they record in the background and add **~zero latency** to a tool call. Each plugin renders on demand via its own command (e.g. `/context-hogs:leaderboard`) and at SessionEnd.

The hooks listed above under [🪝 Hooks](#-hooks) install the classic way (copy the script + add to `settings.json`); more are being packaged as plugins.

---

## 🚀 Quick Start

**1. Copy the hook script:**

```bash
mkdir -p ~/.claude/hooks
cp hook-scripts/pre-tool-use/block-dangerous-commands.js ~/.claude/hooks/
```

**2. Add to `.claude/settings.json`:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/hooks/block-dangerous-commands.js"
          }
        ]
      }
    ]
  }
}
```

**3. Restart Claude Code** — the hook is now active.

> 💡 **Tip:** Use multiple hooks together. Combine `block-dangerous-commands` + `protect-secrets` for comprehensive safety.

---

## 🛡️ Safety Levels

Security hooks support configurable safety levels:

| Level      | What's Blocked                                                | Use Case            |
| ---------- | ------------------------------------------------------------- | ------------------- |
| `critical` | Catastrophic only (rm -rf ~, fork bombs, dd to disk)          | Maximum flexibility |
| `high`     | + Risky (force push main, secrets exposure, git reset --hard) | **Recommended**     |
| `strict`   | + Cautionary (any force push, sudo rm, docker prune)          | Maximum safety      |

**To change:** Edit the `SAFETY_LEVEL` constant at the top of each hook.

```javascript
const SAFETY_LEVEL = "strict"; // or 'critical', 'high'
```

### 🙋 Ask mode (prompt instead of block)

`block-dangerous-commands` and `protect-secrets` can **ask** instead of denying outright. When ask mode is on for a level, matching operations return `permissionDecision: "ask"` — Claude Code shows the reason and lets you approve or reject, instead of hard-blocking.

Enable per level via environment variables (the literal string `true`; anything else means deny):

| Variable            | Affects                                        |
| ------------------- | ---------------------------------------------- |
| `HOOK_ASK_CRITICAL` | `critical`-level patterns (rm -rf ~, .env, …)  |
| `HOOK_ASK_HIGH`     | `high`-level patterns (git reset --hard, …)    |
| `HOOK_ASK_STRICT`   | `strict`-level patterns (any force push, …)    |

Set them inline in your hook command in `settings.json`:

```json
{
  "type": "command",
  "command": "HOOK_ASK_STRICT=true node ~/.claude/hooks/block-dangerous-commands.js"
}
```

Everything defaults to **deny** — ask mode is strictly opt-in. A common setup: keep `critical` on deny, set `HOOK_ASK_STRICT=true` so cautionary patterns prompt instead of blocking.

---

## 🧪 Testing

All hooks include comprehensive tests:

```bash
# Run all tests
npm test

# Run specific hook tests
node --test hook-scripts/tests/pre-tool-use/block-dangerous-commands.test.js
```

**Test coverage:**

- ✅ Unit tests for core functions
- ✅ Integration tests for stdin/stdout flow
- ✅ Config validation tests

---

## 📖 Configuration Reference

See the [official Claude Code hooks documentation](https://docs.anthropic.com/en/docs/claude-code/hooks) for:

- All hook events and their lifecycles
- Input/output JSON formats
- Matcher patterns
- Environment variables

---

## 🤝 Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

**Ideas for new hooks:**

| Hook               | Event            | Description                                     |
| ------------------ | ---------------- | ----------------------------------------------- |
| `context-snapshot` | PreCompact       | Preserve context before compaction              |
| `ntfy-notify`      | Notification     | Free mobile push via [ntfy.sh](https://ntfy.sh) |
| `discord-notify`   | Notification     | Discord webhook alerts                          |
| `tts-alerts`       | Notification     | Voice notifications via say/espeak              |
| `rules-injector`   | UserPromptSubmit | Auto-inject CLAUDE.md rules                     |
| `rate-limiter`     | PreToolUse       | Limit tool calls per minute                     |
| `context-injector` | SessionStart     | Inject project context on session start         |

---

## 👤 Author

Built by [Karan Bansal](https://karanbansal.in), Head of AI at ArmorCode. These hooks are the basis of my OWASP GenAI Summit talk, [Hardening AI Coding Agents with Hooks](https://karanbansal.in/talks/) (slides and recording there).

I write about Claude Code, MCP, and production agentic AI at [karanbansal.in/blog](https://karanbansal.in/blog/).

---

## 📄 License

MIT © [karanb192](https://github.com/karanb192)
