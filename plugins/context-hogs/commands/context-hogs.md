---
description: Show this repo's context-cost leaderboard — the files that pulled the most tokens into context
disable-model-invocation: true
---

# Context-cost leaderboard

!`node "${CLAUDE_SKILL_DIR}/../context-hogs.js" --render`

The table above is this repository's most token-expensive files, aggregated across
your recent sessions (read count, cumulative tokens, estimated cost). It is produced
by the `context-hogs` hook, which records as you work.

Briefly call out the top 1–3 offenders and suggest one concrete fix each — for
example: split an oversized file, exclude a generated/vendored path, or add the
suggested CLAUDE.md / `permissions.deny` block for a file Claude keeps re-reading.
Keep it short; do not re-run any commands.
