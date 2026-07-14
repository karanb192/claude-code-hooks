# claude-code-hooks

🪝 Ready-to-use hooks for Claude Code — safety, automation, notifications, and more.

[![GitHub stars](https://img.shields.io/github/stars/karanb192/claude-code-hooks?style=social)](https://github.com/karanb192/claude-code-hooks)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-262%20passing-brightgreen)](hook-scripts/tests)

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

---

## 📑 Table of Contents

- [Hooks](#-hooks)
- [Install as a plugin](#-install-as-a-plugin)
- [Quick Start](#-quick-start)
- [Safety Levels](#-safety-levels)
- [Testing](#-testing)
- [Contributing](#-contributing)

---

## 🪝 Hooks

### Pre-Tool-Use

Runs **before** Claude executes a tool. Can block or modify the operation.

| Hook                                                                              | Matcher                   | Description                                                      |
| --------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| [block-dangerous-commands](hook-scripts/pre-tool-use/block-dangerous-commands.js) | `Bash`                    | Blocks dangerous shell commands (rm -rf ~, fork bombs, curl\|sh) |
| [protect-secrets](hook-scripts/pre-tool-use/protect-secrets.js)                   | `Read\|Edit\|Write\|Bash` | Prevents reading/modifying/exfiltrating sensitive files          |
| [git-safety](hook-scripts/pre-tool-use/git-safety.js)                             | `Bash`                    | Branch-aware git guardrails + destructive gh CLI protection      |

### Post-Tool-Use

Runs **after** Claude executes a tool. Can react to results.

| Hook                                                     | Matcher       | Description                                                                   |
| -------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------- |
| [auto-stage](hook-scripts/post-tool-use/auto-stage.js)   | `Edit\|Write` | Automatically git stages files after Claude modifies them                     |
| [format-code](hook-scripts/post-tool-use/format-code.js) | `Write\|Edit` | Auto-formats Python (ruff) and JS/TS/HTML/JSON/MD/YAML (prettier) after edits |

> 🔌 **`context-hogs`** (per-file context-cost leaderboard) now ships as an installable **plugin** — see [Install as a plugin](#-install-as-a-plugin).

### Notification

Fires when Claude needs user attention.

| Hook                                                                | Matcher                          | Description                                |
| ------------------------------------------------------------------- | -------------------------------- | ------------------------------------------ |
| [notify-permission](hook-scripts/notification/notify-permission.js) | `permission_prompt\|idle_prompt` | Sends Slack alerts when Claude needs input |

### Session Lifecycle

Fires on session boundaries — capture outcomes and inject context across sessions.

| Hook                                                                  | Event(s)                        | Description                                                                              |
| --------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------- |
| [standup-autopilot](hook-scripts/session-end/standup-autopilot.js)    | `SessionEnd\|Stop\|SessionStart` | Writes your daily standup from what your agents actually did; re-injects open blockers |

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

> ⚡ The `context-hogs` PostToolUse hook is **async** — it records in the background and adds **zero latency** to a tool call. The SessionEnd summary and the `/context-hogs:leaderboard` command render the leaderboard.

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
| `protect-tests`    | PreToolUse       | Block test deletion/disabling                   |
| `context-snapshot` | PreCompact       | Preserve context before compaction              |
| `session-summary`  | Stop             | Generate summary on session end                 |
| `ntfy-notify`      | Notification     | Free mobile push via [ntfy.sh](https://ntfy.sh) |
| `discord-notify`   | Notification     | Discord webhook alerts                          |
| `cost-tracker`     | PostToolUse      | Track token usage and estimate costs            |
| `tts-alerts`       | Notification     | Voice notifications via say/espeak              |
| `rules-injector`   | UserPromptSubmit | Auto-inject CLAUDE.md rules                     |
| `rate-limiter`     | PreToolUse       | Limit tool calls per minute                     |
| `context-injector` | SessionStart     | Inject project context on session start         |

---

## 📄 License

MIT © [karanb192](https://github.com/karanb192)
