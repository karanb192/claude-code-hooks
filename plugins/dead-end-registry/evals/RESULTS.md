# dead-end-registry eval results

Behavioural scores for the `UserPromptSubmit` leg, with the plugin loaded and without it.
Every run is a real model call, so this file is filled in by hand after a run, never by CI.

- Date: not yet run
- Claude Code version: not yet run
- Model: not yet run
- Runs per arm: not yet run
- Total cost: not yet run

| Case | Tag | WITH | W/OUT | Δ |
|------|-----|-----:|------:|--:|
| dead-end-card-steers | read-only | not yet run | not yet run | not yet run |
| unrelated-prompt-no-card | read-only | not yet run | not yet run | not yet run |

Both cases are read-only, so one invocation covers the suite. Run it from the repo root:

```bash
claude plugin eval plugins/dead-end-registry --scaffold --tag read-only --model sonnet --max-cost-usd 3 --no-publish
```

Record the model with the scores: the number is a property of the model as much as of the plugin.
