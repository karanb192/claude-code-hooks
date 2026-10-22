---
name: dead-end-card-steers
description: "The registry already holds a reverted attempt at this exact change. With the plugin loaded the UserPromptSubmit card lands in context, so Claude should surface the earlier attempt instead of silently redoing it."
tags: [read-only]
max_turns: 12
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep]
expected_outcome: "With the plugin, the final message names the earlier attempt. The injected card itself is not visible to any grader: hook additionalContext is not persisted in the run trace, so the card is verified by the hook simulation in the local checks, and the graders score only what Claude says. Two graders score that, both in both arms. prior-attempt-surfaced accepts any reference to a past attempt (already tried, previously attempted, was reverted, walked back). prior-attempt-named is the strict one, because the same reference has to sit within 200 characters of the approach itself, backoff or jitter, which is something only the injected card can tell Claude. Without the plugin Claude has no way to know and just writes the backoff code, so both should fail in that arm. A without-arm pass on the loose grader alone means the wording is still catching ordinary prose and needs tightening again."
---
client.js has a fetchWithRetry helper. Add exponential backoff with jitter to it and show me the new retry loop.
