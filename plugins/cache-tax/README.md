# cache-tax

> The comeback price of a cold prompt cache, shown before you pay it.

Claude Code's main conversation rides a 1-hour prompt cache. Come back at minute 59 and the next message costs cents. Come back at minute 61 and the whole context is re-written at the cache-write rate, which on Fable 5.1 is 80x a cache read ($20 against $0.25 per million tokens). A 500k-token session re-cached cold is $10 at list price, and the message that triggers it is usually "good morning". Claude Code computes all of this and shows none of it at the moment you press Enter. This plugin does.

## Install

```
/plugin marketplace add karanb192/claude-code-hooks   # once per machine
/plugin install cache-tax@claude-code-hooks
```

Restart Claude Code, done. (Or from a shell: `claude plugin install cache-tax@claude-code-hooks`.)

## What it does

| Event | Runs | What happens |
|-------|------|--------------|
| UserPromptSubmit | sync, ~30 ms | Reads the newest usage block from the session transcript. If the cache has lapsed and the context is over `CACHE_TAX_BIG` tokens, shows the re-write cost as a warning. With `CACHE_TAX_BLOCK=1` it refuses the prompt once instead (exit 2); resend the same message to proceed, or `/clear` and start from a handoff note. |
| SessionStart (`resume\|fork`) | sync | On a cold resume, prints the idle gap, the tokens the first message re-writes, and the dollar estimate Claude Code already computed (`estimated_cache_write_usd`, v2.1.251+). Falls back to the transcript on older versions. |

`/cache-tax:status` renders the full card on demand: tier, warm or cold, context size, cold-comeback price, and this session's cache writes, reads and full re-writes so far.

### The warning, verbatim

```
cache-tax: the 1h prompt cache lapsed 3h00m ago. This message re-writes 300,002 tokens at $20/MTok = $6.00
(a warm turn would have cost $0.08). If most of that context is stale, /clear and start from a handoff note instead.
```

## Status line segment

Plugins cannot ship a status line, so wire this one yourself. The same script prints one line when called with `--statusline`, and it prefers the native `prompt_cache` object Claude Code sends to status lines since v2.1.251 (`expires_at`, `recache_tokens_if_cold`, `ttl`, `last_miss_cause`), which also means Claude Code re-runs it the moment the cache goes cold.

```json
"statusLine": {
  "type": "command",
  "command": "node ~/.claude/plugins/marketplaces/claude-code-hooks/plugins/cache-tax/cache-tax.js --statusline"
}
```

Output while warm, then after the cache lapses:

```
cache 47m left · 218k · cold costs $4.37 · last miss ttl_expired_1h
cache COLD · next msg re-writes 218k = $4.37 · last miss ttl_expired_1h
```

Already have a status line script? Pipe the same stdin into `cache-tax.js --statusline` and print its line as one more row.

## Configuration

All optional, set via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CACHE_TAX_BIG` | `50000` | Context size in tokens below which the guard stays quiet. |
| `CACHE_TAX_BLOCK` | unset | `1` makes the guard refuse a cold prompt once (exit 2) instead of warning. The resend goes through. |
| `CACHE_TAX_TTL` | auto | Force `5m` or `1h` when the transcript has no cache-write tier to infer from. |
| `CACHE_TAX_PRICES` | list rates | JSON overriding per-family prices as `[cache read, 5m write, 1h write]` in $/MTok, e.g. `{"fable-5-1":[0.25,12.5,20]}`. |

Built-in list rates (September 2026): Fable 5.1 `[0.25, 12.5, 20]`, Fable 5 `[1, 12.5, 20]`, Opus 5 and 4.x `[0.5, 6.25, 10]`, Sonnet `[0.3, 3.75, 6]`, Haiku `[0.1, 1.25, 2]`. Unknown models get token counts and no dollar figure. If you are on a subscription the dollars are what the same traffic would cost at API list price, which is the only public yardstick; how a cache write weighs against your plan limits is not documented.

## How it decides

The tier comes from the newest assistant usage block in the transcript: `cache_creation.ephemeral_1h_input_tokens` means the 1h tier, `ephemeral_5m_input_tokens` the 5m tier. Age is wall-clock time since that block's timestamp. Lapsed means age past the tier's TTL. The re-write cost is the block's full context (input plus cache read plus cache write) at the tier's write rate. A "full miss" on the card is a request whose cache read covered under half of the previous request's context while its write covered over half of it.

Hooks receive no token counts, so nothing here comes from the hook input except the resume fields Claude Code added in v2.1.251. Everything else is read from `transcript_path`, the file Claude Code is already writing.

## Data & privacy

Reads the session transcript's usage blocks and timestamps, never message text. Writes a one-line JSON entry to `~/.claude/hooks-logs/<date>.jsonl` when it warns or blocks, and a tiny acknowledgement file under `~/.claude/cache-tax/` in block mode. No network calls (the script only uses `fs`, `path`, and `os`).

## Uninstall

```
/plugin uninstall cache-tax@claude-code-hooks
```
