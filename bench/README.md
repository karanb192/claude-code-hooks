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

## Scope

Covers the PreToolUse/PostToolUse hooks in `hook-scripts/`. Excluded:

- `notification/notify-permission.js`: a Notification hook, not on the tool-call path, and its real cost is a Slack webhook network call that a hermetic benchmark cannot represent honestly.
- `utils/event-logger.py` and the hooks under `plugins/`: out of scope for this harness.

Committed numbers: [RESULTS.md](RESULTS.md).
