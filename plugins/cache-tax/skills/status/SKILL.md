---
name: status
description: Show this session's prompt-cache state, the cold-comeback price, and the cache writes paid so far
disable-model-invocation: true
---

# Prompt-cache status

!`node "${CLAUDE_SKILL_DIR}/../../cache-tax.js" --render 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/cache-tax.js" --render`

The card above is this session's prompt-cache state from its own transcript: which
cache tier the main conversation is on, whether the cache is warm or has lapsed, how
many tokens the next message re-writes if it is cold and what that costs at list
price, and the session's cache writes, reads and full re-writes so far.

State what the next message will cost in one sentence. If the cache is cold and the
context is large, say whether /clear plus a short handoff note is the cheaper move.
Keep it short; do not re-run any commands.
