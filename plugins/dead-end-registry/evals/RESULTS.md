# dead-end-registry eval results

Run on 2026-09-14 with Claude Code 2.1.270, agent model `sonnet`, 3 runs per arm, ablation with-without. Total cost USD 1.06, wall time 96 s across 1 invocation(s). Scores are the mean run score per arm; delta is with minus without. A grader marked diagnostic is reported but not scored.

| Case | Tag | With | Without | Delta | Pass (with) | Notes |
|---|---|---|---|---|---|---|
| dead-end-card-steers | read-only | 1.00 | 0.00 | 1.00 | 1.00 |  |
| unrelated-prompt-no-card | read-only | 1.00 | 1.00 | 0.00 | 1.00 |  |

## Grader pass counts

| Case | Grader | Kind | With | Without |
|---|---|---|---|---|
| dead-end-card-steers | prior-attempt-named | scored | 3/3 | 0/3 |
| dead-end-card-steers | prior-attempt-surfaced | scored | 3/3 | 0/3 |
| unrelated-prompt-no-card | no-card-injected | scored | 3/3 | 3/3 |
| unrelated-prompt-no-card | variables-listed | scored | 3/3 | 3/3 |

## How this was produced

The commands are in the plugin README under Evals. The JSON these tables come from is the `--json` output of each invocation; raw run output lands under `evals/results/`, which is gitignored.

## Reading

With the plugin, every run opened by naming the earlier reverted attempt and asked before reapplying it. Without the plugin, no run mentioned a prior attempt; Claude went straight to writing the backoff loop. The control case shows the card stays silent on an unrelated prompt in both arms. The injected card is not visible in the run trace, so the graders score Claude's reply only; the hook simulation in the case's local checks is what proves the card was injected.
