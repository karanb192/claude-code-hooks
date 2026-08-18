# Hook latency results

- Machine: Apple M3 Pro (darwin arm64)
- Node: v26.5.0
- Date: 2026-08-18
- Samples: 1 warm-up (discarded) + N=20 per hook, fresh process per invocation

| Hook | Median (ms) | Min | Max | Mean |
|------|------------:|----:|----:|-----:|
| block-dangerous-commands.js | 37.5 | 34.1 | 48.5 | 38.4 |
| case-insensitive-guard.js | 35.5 | 33.7 | 38.0 | 35.7 |
| git-safety.js | 34.7 | 33.3 | 36.3 | 34.6 |
| protect-secrets.js | 35.0 | 33.6 | 74.4 | 38.7 |
| protect-tests.js | 35.6 | 32.8 | 42.4 | 35.7 |
| auto-stage.js | 68.1 | 63.8 | 76.0 | 68.1 |
| format-code.js | 113.6 | 111.1 | 125.4 | 114.8 |

Single-machine spot measurement. Numbers are dominated by Node interpreter
startup, not hook logic; treat them as an upper bound on per-call overhead,
not a cross-machine latency ladder.

Reproduce: `node bench/run.mjs --n=20 --write`
