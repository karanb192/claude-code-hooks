# The native token diet

Three presets built from settings Claude Code already ships. No hook, no plugin, nothing to maintain when the defaults move.

## Why not a Read-gate plugin

[Spotify's shunt](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt) blocks any whole-file Read over 350 lines and routes it to a cheaper worker. On current Claude Code the Read tool already does the part that matters:

- A whole-file read over the token limit returns the first page with a `PARTIAL view` notice and paging instructions, instead of the whole file ([tools reference](https://code.claude.com/docs/en/tools-reference#read-tool-behavior); shipped in 2.1.145 per the [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).
- `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` sets that per-read limit ([env vars](https://code.claude.com/docs/en/env-vars)). The docs describe it as a way to read larger files in full. The 2.1.270 binary shows it also lowers the cap: `function dPo(){let e=a.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;if(e!==void 0&&e>0)return e;return}` with the default `var uPo=25000`. Any positive integer is accepted, so a 4,000-token cap turns a 1,000-line file into a first page plus a notice. The default of 25,000 and the lowering behaviour are binary-verified, not documented.
- Bash output is capped inline at about 30,000 characters and saved to a file past that ([tools reference, output limits](https://code.claude.com/docs/en/tools-reference#output-limits)), and `Read` deny rules already apply to `cat`, `head`, `tail` and `sed` inside Bash ([permissions](https://code.claude.com/docs/en/permissions)).

Before you pick a preset, replay your own transcripts and see how many reads a 350-line gate would have caught. On the machine this was written on it was 6.4% of non-image reads and 0.015% of context tokens (see [measure first](#measure-first)).

## The knobs

| Knob | Where it lives | Default | What it does | Documented |
|---|---|---|---|---|
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | `env` block | 25,000 (binary) | Per-Read token cap; over it, Read returns a first page with a `PARTIAL view` notice | [env vars](https://code.claude.com/docs/en/env-vars); lowering below the default is binary-verified only (quote above) |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `env` block | unset (subagent inherits the main model) | Default model for subagents that are not assigned one another way; since 2.1.251 a definition's `model` or a per-spawn model wins over it | [env vars](https://code.claude.com/docs/en/env-vars), [sub-agents](https://code.claude.com/docs/en/sub-agents#run-every-subagent-on-one-model) |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | `env` block | unset | Set to `1` to put every subagent, teammate and workflow agent on `CLAUDE_CODE_SUBAGENT_MODEL`, ignoring definition and per-spawn overrides, built-in Explore and Plan included. Needs 2.1.257 | [env vars](https://code.claude.com/docs/en/env-vars), [sub-agents](https://code.claude.com/docs/en/sub-agents#run-every-subagent-on-one-model) |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | `env` block | 20 | How many subagents can run at once before the Agent tool refuses to spawn another. Positive whole number; cannot disable the cap. Needs 2.1.217 | [env vars](https://code.claude.com/docs/en/env-vars), [sub-agents](https://code.claude.com/docs/en/sub-agents#concurrent-subagent-limit) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `env` block | model context window | Tokens of context before auto-compact runs, `100000` to `1000000`, plain integer only, capped at the model's window. Capped at the model's window, so the lean and strict values (400K, 250K) change nothing on a 200K model; a value under 200K would | [env vars](https://code.claude.com/docs/en/env-vars), [model config](https://code.claude.com/docs/en/model-config#set-the-auto-compact-window) |
| `bashOutputMaxChars` | top-level settings key | unset (30,000 inline) | Characters of a successful command's output Claude receives inline; past it, a preview plus a file path. Clamped to `4000` to `128000`. Needs 2.1.261 | [settings reference](https://code.claude.com/docs/en/settings-reference#bashoutputmaxchars) |
| `~/.claude/agents/Explore.md` with `model: haiku` | user agents dir | built-in Explore inherits the main model, capped at Opus (since 2.1.198) | A user or project subagent named `Explore` overrides the built-in and keeps its own `model` field | [sub-agents, built-in subagents](https://code.claude.com/docs/en/sub-agents#built-in-subagents) |

One more that is not in the presets because it is about session setup, not reads: `ENABLE_CLAUDEAI_MCP_SERVERS=false` stops Claude Code from fetching claude.ai MCP servers, which trims tool definitions from every session ([env vars](https://code.claude.com/docs/en/env-vars)). Set it if you never use those connectors.

## Three presets

| Knob | light | lean | strict |
|---|---|---|---|
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | `12000` | `4000` | `2500` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | unset | `haiku` | `haiku` |
| `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | unset | unset | `1` |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | `10` | `5` | `3` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | unset | `400000` | `250000` |
| `bashOutputMaxChars` | `16000` | `8000` | `4000` |
| `~/.claude/agents/Explore.md` | not needed | `model: haiku` | `model: haiku` (ignored while FORCE is on, kept so the pin survives if you drop FORCE) |

What each one trades:

- **light**: trims only the biggest results. Reads over roughly 1,000 lines of code (chars/4, about 46 characters per line; your files will differ) come back as a first page; long build logs land in a file. Every model choice stays yours. Costs you an extra Read call on big files, nothing else.
- **lean**: the shunt-equivalent. A 4,000-token cap is about 350 lines of code by the same chars/4 rule, the line shunt drew. Subagents without their own model run on Haiku and Explore is pinned to Haiku through `Explore.md`; agents that declare a model keep it. Auto-compact at 400K on a 1M-context model compacts well before the window fills, trading a summary step for a smaller working set on every later turn. Costs you: more paging on medium files, and Haiku answers on exploration and unassigned subagents.
- **strict**: every subagent on Haiku, forced (the [doc](https://code.claude.com/docs/en/sub-agents#run-every-subagent-on-one-model) names two exceptions that stay on the main model: forks, and skills that run in a subagent with `model: inherit`), three subagents at a time, 4,000 characters of Bash output inline. Cheapest per turn. Costs you: harder problems handed to subagents get a weaker model, and Anthropic's Thariq Shihipar has said that "sometimes the larger models can be more token-efficient on a hard problem than the smaller models" ([interview notes, Simon Willison, 21 Jul 2026](https://simonwillison.net/2026/Jul/21/cat-and-thariq/)), so expect more retries. Use it for bulk mechanical work, not design work.

None of these change your main conversation's model. Lowering the read cap below 25,000 is binary-verified behaviour on 2.1.270; if a future release ignores low values, the cap silently returns to its default and nothing breaks.

### settings.json, light

`~/.claude/settings.json` (user scope) or `.claude/settings.json` (project scope); precedence is on the [settings page](https://code.claude.com/docs/en/settings).

```json
{
  "env": {
    "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": "12000",
    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "10"
  },
  "bashOutputMaxChars": 16000
}
```

### settings.json, lean

```json
{
  "env": {
    "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": "4000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku",
    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "5",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "400000"
  },
  "bashOutputMaxChars": 8000
}
```

### settings.json, strict

```json
{
  "env": {
    "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": "2500",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku",
    "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1",
    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "3",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "250000"
  },
  "bashOutputMaxChars": 4000
}
```

### `~/.claude/agents/Explore.md` (lean and strict)

```markdown
---
name: Explore
description: Fast, read-only codebase exploration on a low-cost model. Use for searching files, finding symbols, and answering "where is X" questions.
model: haiku
tools: Read, Grep, Glob, Bash
---

You explore codebases quickly and report back. Read only; never edit files.
Return file paths and short excerpts, not whole files.
```

If `~/.claude/agents/` did not exist before the session started, restart Claude Code once so it sees the new directory ([sub-agents](https://code.claude.com/docs/en/sub-agents)). Check any preset took effect with `/tasks` while a subagent runs: the row shows the model.

## What this replaces

Shunt's parts, the native knob that covers each, and what you give up.

| Shunt part | What it does | Native replacement | Pros | Cons |
|---|---|---|---|---|
| [`check-file-size`](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt) hook | Denies whole-file Reads over `SHUNT_MIN_LINES` (350) | `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` plus native `PARTIAL view` paging | No hook process per Read; the model still gets a first page instead of a refusal; works inside subagents the same way | Cap is in tokens not lines; lowering it is binary-verified, not documented; no line-numbered outline of the rest of the file |
| `check-bash-read` hook | Denies unpiped `cat`, `head`, `tail`, `less`, `more` on big files | `bashOutputMaxChars`, plus `Read` deny rules that already parse `cat`, `head`, `tail`, `sed` in Bash ([permissions](https://code.claude.com/docs/en/permissions)) | Output past the cap goes to a file with a preview, so nothing is lost; deny rules need no code | Byte cap, not a per-file line check; a `cat` under the cap still lands in full |
| `bulk-read` script and bulk-reader skill | Sends the file to a cheaper worker that returns a summary | `Explore.md` with `model: haiku`, or `CLAUDE_CODE_SUBAGENT_MODEL=haiku` | Runs inside Claude Code with your existing auth; context isolation is native; shows in `/tasks` and `/usage` | The worker's summary still costs context; Haiku is weaker on hard files; Anthropic moved Explore off Haiku in 2.1.198 on purpose |
| `code-write` script and code-writer skill | Sends boilerplate generation to a cheaper worker and writes to disk | No direct equivalent. Nearest: a custom subagent with `model: haiku` for boilerplate tasks | Same auth and isolation story as above | You have to ask for it; nothing routes writes automatically |
| chars/4 savings ledger in `run.sh` | Scores a bulk-read as corpus tokens minus the worker's reply tokens (82 to 94% in its table); scores a code-write as 100% saved because nothing returns to context | [`bench/read-replay`](../bench/read-replay) for the counterfactual, `/cost` and `/usage` for the bill | Measures what actually entered context, deduped by message id; prints shares, not dollars | Still a chars/4 estimate; the counterfactual is an upper bound |

## Measure first

Run the replay over your own transcripts before changing anything:

```bash
node bench/read-replay/replay.mjs
```

It prints a receipt: how many reads a 350-line gate would have caught and what share of your context tokens they were. Details and caveats in [bench/read-replay/README.md](../bench/read-replay/README.md).

Then verify the read cap on your build in one line:

```bash
CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS=4000 claude
```

Ask it to Read any file over 1,000 lines. Expected: the first page comes back with a `PARTIAL view` notice and offset/limit instructions. If the whole file comes back, your build ignores low values and the presets' read-cap row does nothing for you; the rest still applies.

Version numbers above come from the [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md); doc links were checked against 2.1.270.
