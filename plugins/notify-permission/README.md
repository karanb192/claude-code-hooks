# notify-permission

> Sends Slack alerts when Claude needs your input, so you stop babysitting the terminal.

A `Notification` hook fires on `permission_prompt`, `idle_prompt`, and `elicitation_dialog`, classifies the notification (from `notification_type` when the payload carries it, otherwise from keywords in the message), and posts a Slack Block Kit card to your webhook: an emoji plus a specific title (which tool needs permission: Bash, Write, Edit, or Read; Claude waiting; or a choice to make), the project name, a short session id, the message truncated to 200 chars, the full cwd, and a timestamp. Kick off a long task, walk away, and Slack pings you the moment Claude is blocked on you.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install notify-permission@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install notify-permission@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| Notification (`permission_prompt\|idle_prompt\|elicitation_dialog`) | sync | Classifies the notification, posts a Slack card to `CCH_SLA_WEBHOOK`, logs the outcome. |

Every input, send, and failure is appended to `~/.claude/hooks-logs/<date>.jsonl`. The hook always exits 0 and prints `{}`; it never blocks your session, even on malformed input or a dead webhook.

## Configuration

One environment variable:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CCH_SLA_WEBHOOK` | unset | Slack Incoming Webhook URL the alert card is posted to. Unset means the hook sends nothing and logs a `NONE` entry (nothing sent, no error). |

No safety levels, no ask mode; this is a notifier, not a guard. Discord and Telegram channels are planned but not wired up yet: today the hook sends to Slack only.

## Data & privacy

The only network call is the POST to the webhook you configure, and only when `CCH_SLA_WEBHOOK` is set. The card carries the notification message (truncated to 200 chars), the project directory path, and a 6-char session id prefix; everything else stays in the local log.

## Uninstall

```
/plugin uninstall notify-permission@claude-code-hooks
```

---

Part of [claude-code-hooks](https://github.com/karanb192/claude-code-hooks).
