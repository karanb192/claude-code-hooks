# Hook latency bench

Measures what a user actually pays per tool call: the full lifecycle of one hook invocation. Each sample spawns a fresh Node process, writes a realistic benign event JSON to stdin (shaped like the hook's own test fixtures), and reads the verdict from stdout. Per hook: 1 discarded warm-up, then N timed samples (default 20).

## Run

```bash
node bench/run.mjs            # print markdown table
node bench/run.mjs --n=50     # more samples
node bench/run.mjs --write    # also update bench/RESULTS.md
```

No dependencies. HOME is pointed at a throwaway temp dir during the run, so hook logs never touch your real `~/.claude`. `auto-stage` gets a temp git repo so it exercises its real `git rev-parse` + `git add` path.

## Reading the results

- Median is the headline number; min/max show spread.
- Numbers are dominated by Node interpreter startup (~30 ms on an M3 Pro), not hook logic. They are an upper bound on per-call overhead on that machine, not a cross-machine latency ladder.
- `auto-stage` is slower because it spawns two git subprocesses per call. That is its real cost, not harness overhead.
- `format-code` is the most expensive: each call runs `uv run ruff check --fix` plus `uv run ruff format` on the touched file, two more subprocess spawns on top of Node startup. The harness verifies ruff really reformatted the sample file and aborts if it did not, so a machine without the formatters can never report a meaningless fast number.

## Scope

Covers the eleven PreToolUse/PostToolUse hook plugins in `plugins/`: block-dangerous-commands, case-insensitive-guard, git-safety, protect-secrets, protect-tests, config-guard, instructions-audit (its PreToolUse enforcement arm, measured with no lockdown flag set), guard-pack (all seven guards in one process, driven with a Bash payload so it exercises the six pattern guards; compare its row against the sum of those six individual rows), subagent-spawn-cap (an `Agent` payload with the caps raised far above the sample count, so every sample takes the real read-and-append path and none returns a verdict), auto-stage, format-code. The format-code payload writes a small unformatted Python file, so `uv` and `ruff` must be on PATH (CI installs them); without them the run aborts instead of reporting a no-op.

Excluded:

- `plugins/notify-permission`: a Notification hook, not on the tool-call path, and its real cost is a Slack webhook network call that a hermetic benchmark cannot represent honestly.
- `plugins/session-logger`: runs at session start and end, never per tool call.
- `utils/event-logger.py` and the remaining plugins: out of scope for this harness.

Committed numbers: [RESULTS.md](RESULTS.md).

## Read-gate replay

A second, unrelated measurement lives in [`read-replay/`](read-replay/): it replays your own Claude Code transcripts and reports how many Read calls a Spotify-shunt-style 350-line gate would have caught, and what share of your context tokens they were. Run `node bench/read-replay/replay.mjs`; presets built on the native knobs are in [docs/token-diet.md](../docs/token-diet.md).
