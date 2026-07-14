---
name: receipt
description: Preview the provenance receipt (prompts, est. spend, tests run, agent-authored lines) for the current session ledger
disable-model-invocation: true
---

# Provenance receipt

!`node "${CLAUDE_SKILL_DIR}/../../pr-provenance-stamp.js" --render 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/pr-provenance-stamp.js" --render`

The block above is the provenance receipt exactly as it would be stamped into a PR
body when you run `gh pr create` — built from the most recent session ledger the
`pr-provenance-stamp` hook has been recording (tool calls, test/typecheck commands
with real exit codes, and the agent-vs-human authored-line split). Prompt and spend
figures come from the transcript at PR-create time, so they may be absent in this
preview.

Briefly summarize the receipt for the user: how many tests ran and whether they are
green, and the agent-authored line count or percentage. Keep it to a sentence or two
and do not re-run any commands.
