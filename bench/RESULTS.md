# Hook latency results

- Machine: Apple M3 Pro (darwin arm64)
- Node: v26.5.0
- Date: 2026-08-17
- Samples: 1 warm-up (discarded) + N=20 per hook, fresh process per invocation

| Hook | Median (ms) | Min | Max | Mean |
|------|------------:|----:|----:|-----:|
| block-dangerous-commands.js | 34.8 | 32.7 | 40.3 | 35.4 |
| protect-secrets.js | 34.7 | 32.0 | 53.1 | 36.9 |
| auto-stage.js | 59.6 | 57.3 | 65.0 | 60.1 |

Single-machine spot measurement. Numbers are dominated by Node interpreter
startup, not hook logic; treat them as an upper bound on per-call overhead,
not a cross-machine latency ladder.

Reproduce: `node bench/run.mjs --n=20 --write`
