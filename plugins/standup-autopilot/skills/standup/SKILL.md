---
name: standup
description: Render today's standup card from what your agents actually did across repos
disable-model-invocation: true
---

# Standup card

!`node "${CLAUDE_SKILL_DIR}/../../standup-autopilot.js" --render 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/standup-autopilot.js" --render`

The card above is your standup for the most recent day with recorded sessions —
one line per repo (what got done, tests run, PRs, diffstat) plus any unresolved
blockers. It is produced by the `standup-autopilot` hook, which snapshots each
session's outcome (task, git state, tests, PRs, blockers) to a local per-day
ledger as you work.

Briefly restate it as a ready-to-paste standup: a short "Yesterday" line per
repo and a "Blocked on" list (or note there are no blockers). Keep it tight; do
not re-run any commands.
