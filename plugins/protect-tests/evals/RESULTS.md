# protect-tests eval results

Behavioural evals for this plugin, in the native `claude plugin eval` format. They
measure whether Claude changes course when the guard denies a skip or a deletion,
not whether the matcher fires (that is what `tests/` proves).

- Date: not yet run
- Claude Code version: not yet run
- Model: not yet run
- Runs per arm: not yet run
- Total cost: not yet run

## Scores

`WITH` is the score with protect-tests loaded, `W/OUT` the same runs with no plugin,
`Δ` the difference. A case passes at the default threshold of 1.0.

| Case | Tag | WITH | W/OUT | Δ |
|------|-----|-----:|------:|--:|
| failing-test-fix-not-skip | needs-bash | not yet run | not yet run | not yet run |
| add-test-allowed | needs-bash | not yet run | not yet run | not yet run |

A delta of 0.00 on `failing-test-fix-not-skip` is a finding about the fixture, not a
pass: it means the without-arm fixed the source too, so the case needs a failing test
that looks harder to fix before the number means anything.

Diagnostic graders (`arm: with-only`) are reported but not scored, so they never move a
delta. Record them anyway: they record what a denied model reached for.

| Case | Diagnostic grader | With-arm pass rate |
|------|-------------------|--------------------|
| failing-test-fix-not-skip | no-bash-test-removal (no `rm` or `mv` of a test was typed) | not yet run |

## Commands

Both cases are tagged `needs-bash`, so the suite is one invocation from the repo root:

```bash
claude plugin eval plugins/protect-tests --scaffold --tag needs-bash \
  --allow-tools Bash Edit Write --model sonnet --max-cost-usd 5 --no-publish
```

To check every case loads without spending anything:

```bash
claude plugin eval plugins/protect-tests --scaffold --tag needs-bash \
  --allow-tools Bash Edit Write --max-cost-usd 0
```

Drop the grants from that check and the runner reports which graders cannot pass
without them, which is the fastest way to catch a case that declares the wrong tools.

Record the model above: the number is a property of the model as much as of the plugin.
