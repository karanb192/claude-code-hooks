---
name: receipts
description: Show your personal model-quality trend card (failure rate, edit churn, tokens/task by model version)
disable-model-invocation: true
---

# Nerf receipts — your model-quality trend card

!`node "${CLAUDE_SKILL_DIR}/../../nerf-receipts.js" --render 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/nerf-receipts.js" --render`

The card above is your own per-session flight recorder, aggregated across your recent
Claude Code sessions and keyed by model id and Claude Code version — failure rate, edit
churn, and tokens per task, each with a sparkline. It is recorded quietly in the background
by the `nerf-receipts` hooks as you work.

Briefly interpret it for the user: call out the headline averages, and if a ⚠ shift line is
present, restate which metric moved, by how much, and across which model change — that is the
receipt that a quality shift is real, not a vibe. If the card says data is still accumulating,
tell them to keep working and check back after a few more sessions. Keep it short and do not
re-run any commands.
