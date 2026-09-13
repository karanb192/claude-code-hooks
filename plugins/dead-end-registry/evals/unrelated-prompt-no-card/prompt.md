---
name: unrelated-prompt-no-card
description: Control. The same registry entry is seeded, but the prompt shares no keywords with it, so the keyword gates must keep the card out in both arms.
tags: [read-only]
max_turns: 12
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep]
expected_outcome: No card in either arm. Claude reads config.js and answers from it, and the trace never contains the card header.
---
config.js reads its settings from environment variables. List every variable it reads and the default each one falls back to.
