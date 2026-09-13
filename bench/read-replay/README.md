# Read-gate replay

Answers one question from your own Claude Code transcripts: **if a [Spotify shunt](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt) style Read gate had been installed, how much would it have caught?** Shunt's `check-file-size` hook blocks any whole-file Read over 350 lines (`SHUNT_MIN_LINES`) and routes it to a cheaper worker. The replay walks every transcript under `~/.claude/projects`, pairs each `Read` call with its result, applies the same rule, and reports the share of your reads and of your context tokens that rule would have touched.

Nothing leaves your machine. The script reads JSONL files and prints a table.

## Run

```bash
node bench/read-replay/replay.mjs                 # markdown receipt, last 30 days
node bench/read-replay/replay.mjs --days=90       # wider window (by file mtime)
node bench/read-replay/replay.mjs --min-lines=500 # a stricter gate than shunt's 350
node bench/read-replay/replay.mjs --json          # raw object, for your own charts
node bench/read-replay/replay.mjs --projects=/path/to/projects   # another transcript root
```

No dependencies, Node 18 or newer. A 1 GB month of transcripts replays in about 3 seconds. The script exits non-zero if the projects dir does not exist.

## What it walks

- `<project>/<session>.jsonl`: every main transcript.
- `<project>/<session>/subagents/*.jsonl`: every subagent transcript. Do not skip these; on a research-heavy machine most of the big reads happen inside subagents.
- Files are included when their mtime falls inside `--days`.

## How to read each row

| Row | Meaning |
|---|---|
| Transcripts scanned | Files, megabytes and wall time. Also lists the Claude Code versions that wrote them, read from each line's `version` field. |
| Read calls paired with a result | Every `Read` tool_use that has a matching tool_result in the same transcript. |
| Image reads (excluded) | Results with `toolUseResult.type = "image"` (or a base64 payload). A line-count gate has nothing to say about a PNG, so they leave the denominator. |
| Targeted reads (never gated) | Reads that passed `offset` or `limit`. Shunt lets these through, so they count as "already paged by the model". Percent is of non-image reads. |
| Reads that would qualify | Whole-file reads where the file's `totalLines` (falling back to `numLines`, then to newline count) exceeds `--min-lines`, or the returned text exceeds 100,000 characters. Percent is of non-image reads. |
| One-shot tokens gated (est.) | The estimated tokens of those qualifying results, counted once, as a share of all context tokens in the window. |
| Carried to the next compact (upper bound, est.) | The same bytes multiplied by the number of later assistant turns before the next `compact_boundary`, on the assumption that every later turn re-sends them. Also as a share of context tokens. |
| Unpiped Bash reads | `cat`, `head`, `tail`, `less`, `more`, `sed -n`, `bat` commands with no pipe or redirect: the calls shunt's `check-bash-read` hook targets. Informational. |

Context tokens are `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` summed over assistant messages, deduped by message id (one API response can be logged as several lines). Messages whose model starts with `<` (synthetic, no API call) are skipped.

## Caveats

- **Tokens are estimated.** Claude Code does not log a token count per tool result, so the replay uses `ceil(chars / 4)`. Real tokenization differs by content; treat every token figure as an estimate.
- **The counterfactual is an upper bound.** It assumes a gated read costs zero afterwards. In practice the worker that replaces the read returns a summary that also lands in context, and shunt's own README puts the worker round trip at 10 to 30 seconds. The carried row is a second ceiling on top of that: it assumes nothing clears old tool output before compaction.
- **Native Read already caps a call.** The Read tool reads up to 2,000 lines per call by default (its own tool description says so) and, since Claude Code 2.1.145, a whole-file read over the token limit returns the first page with a `PARTIAL view` notice instead of the whole file ([tools reference](https://code.claude.com/docs/en/tools-reference#read-tool-behavior), [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)). The 25,000-token default is a string in the 2.1.270 binary (`var uPo=25000`), not a documented number. `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` lowers it; see [docs/token-diet.md](../../docs/token-diet.md).
- **Numbers are machine and workload specific.** A research-heavy machine with many subagents and image reads looks nothing like a single-repo coding machine. Run it, paste your own receipt, and read the percentages, not anyone else's.
- The 30-day window is whatever transcripts Claude Code has kept; its own cleanup setting can shorten it.

## Writeup

The writeup this script was built for: https://karanbansal.in/blog/spotify-shunt-replay/

## Test

```bash
node --test tests/read-replay.test.js
```

Hermetic: builds a synthetic project dir in a temp HOME with a main and a subagent transcript of known shape and asserts every count.
