# dead-end-registry eval results

Behavioural scores for the `UserPromptSubmit` leg, with the plugin loaded and without it. They
measure whether the injected card changes what Claude does, the one part no unit test can
reach. Every run is a real model call, so this file is filled in by hand after a run, never by
CI.

- Date: not yet run
- Claude Code version: not yet run
- Model: not yet run
- Runs per arm: not yet run
- Total cost: not yet run

## Scores

`WITH` is the case score with the plugin loaded, `W/OUT` the same case with no plugin, and
`Delta` is what the plugin contributed. A case passes at the default threshold of 1.0. Record
the model above: the number is a property of the model as much as of the plugin.

| Case | Tag | WITH | W/OUT | Delta |
|------|-----|-----:|------:|------:|
| dead-end-card-steers | read-only | not yet run | not yet run | not yet run |
| unrelated-prompt-no-card | read-only | not yet run | not yet run | not yet run |

`dead-end-card-steers` is scored by two graders. `prior-attempt-surfaced` accepts any reference
to an earlier attempt; `prior-attempt-named` also requires that reference to sit next to the
approach itself, which nothing but the card can supply. Record both, since a without-arm pass on
the first alone is the loose-regex false positive the pair exists to separate out.

## Diagnostics

Graders marked `arm: with-only` are reported but not scored, so they never move a delta.
Record them anyway: they are the reason the suite exists.

| Case | Diagnostic grader | With-arm pass rate |
|------|-------------------|--------------------|
| dead-end-card-steers | card-injected (the card header reached the transcript) | not yet run |

## Commands

Both cases are read-only, so one invocation covers the suite. Run it from the repo root:

```bash
claude plugin eval plugins/dead-end-registry --scaffold --tag read-only --model sonnet --max-cost-usd 3 --no-publish
```

`--scaffold` is what lets each case's `fixture.sh` seed the workspace and the one registry
entry the card matches on. Without it the workspace is empty and every case scores noise.
