---
name: dead-end-card-steers
description: The registry already holds a reverted attempt at this exact change. With the plugin loaded the UserPromptSubmit card lands in context, so Claude should surface the earlier attempt instead of silently redoing it.
tags: [read-only]
max_turns: 12
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep]
expected_outcome: With the plugin, the card shows up in the trace and the final message names the earlier attempt (already tried, dead end, reverted) or asks the user to confirm before redoing it. Without the plugin, Claude has no way to know and just writes the backoff code.
---
client.js has a fetchWithRetry helper. Add exponential backoff with jitter to it and show me the new retry loop.
