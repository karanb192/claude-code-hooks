---
name: board
description: Show the wanted-poster bounty board — this repo's TODO/FIXME/HACK debt priced as aging XP bounties
disable-model-invocation: true
---

# Bounty board

!`node "${CLAUDE_SKILL_DIR}/../../bounty-board.js" --render 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/bounty-board.js" --render`

The card above is this repository's open bounties — each TODO/FIXME/HACK/skip/lint-suppression
priced as a wanted-poster bounty whose XP scales with its git-blame age (older debt = fatter
bounty). It is produced by the `bounty-board` hook, which scans the repo on demand.

Briefly call out the 1–3 fattest bounties and, for each, name the file:line and what it would take
to genuinely clear it (resolve the debt, not just delete the marker). Keep it short; do not re-run
any commands.
