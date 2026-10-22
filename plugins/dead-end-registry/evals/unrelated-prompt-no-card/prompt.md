---
name: unrelated-prompt-no-card
description: "Control. The same registry entry is seeded, but the prompt shares no keywords with it, so the keyword gates must keep the card out in both arms."
tags: [read-only]
max_turns: 12
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep]
expected_outcome: "No card in either arm, and both arms score 1.0. no-card-injected proves the card stayed out, and variables-listed proves the run actually did the work, since LOG_LEVEL and CACHE_DIR exist only in the seeded config.js. Without that second grader a run that produced nothing at all would score 1.0 on the not_contains alone."
---
config.js reads its settings from environment variables. List every variable it reads and the default each one falls back to.
