---
name: dead-ends
description: List this repo's recorded dead ends — approaches already tried and abandoned, with reasons and cost
disable-model-invocation: true
---

# Dead ends

!`node "${CLAUDE_SKILL_DIR}/../../dead-end-registry.js" --render 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/dead-end-registry.js" --render`

The list above is this repository's recorded dead ends — approaches that were tried
and then reverted or ruled out, newest first, each with the date it was tried, why it
was walked back, and the estimated token cost of the detour. It is produced by the
`dead-end-registry` hook, which mines your transcripts as you work.

Briefly summarize the 1–3 most relevant entries and, if any bear on what the user is
currently doing, gently flag that they have been down this road before. If the list is
empty, just say so. Keep it short; do not re-run any commands.
