---
name: scorecard
description: Show the CLAUDE.md compliance scorecard — which rules Claude actually follows vs ignores
disable-model-invocation: true
---

# CLAUDE.md compliance scorecard

!`node "${CLAUDE_SKILL_DIR}/../../dead-rules-audit.js" --render 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/dead-rules-audit.js" --render`

The card above is a worst-first audit of your CLAUDE.md rules, aggregated across
your recent sessions: how often each rule was relevant to an edit, how often it was
violated, its heuristic compliance %, and a `⚠ promote→hook` flag for rules Claude
chronically ignores. It is produced by the `dead-rules-audit` hook, which records
as you work.

Briefly call out the 1–3 worst offenders and, for any rule flagged
`promote→hook`, suggest making it deterministic — a PreToolUse/PostToolUse hook or
a lint rule — instead of relying on Claude to remember it. Keep it short; do not
re-run any commands.
