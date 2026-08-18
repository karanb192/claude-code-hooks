# Hook latency results

- Machine: Apple M3 Pro (darwin arm64)
- Node: v26.5.0
- Date: 2026-08-18
- Samples: 1 warm-up (discarded) + N=20 per hook, fresh process per invocation

| Hook | Median (ms) | Min | Max | Mean |
|------|------------:|----:|----:|-----:|
| block-dangerous-commands.js | 33.0 | 31.6 | 36.8 | 33.7 |
| case-insensitive-guard.js | 33.2 | 32.5 | 34.6 | 33.3 |
| git-safety.js | 33.6 | 31.6 | 35.6 | 33.5 |
| protect-secrets.js | 32.9 | 31.1 | 35.0 | 33.0 |
| protect-tests.js | 32.8 | 30.5 | 34.1 | 32.8 |
| config-guard.js | 33.1 | 31.7 | 36.5 | 33.4 |
| instructions-audit.js | 34.1 | 31.9 | 41.3 | 35.0 |
| guard-pack.js | 38.0 | 35.7 | 69.1 | 39.9 |
| auto-stage.js | 61.8 | 59.5 | 69.8 | 62.8 |
| format-code.js | 112.5 | 108.5 | 116.5 | 112.7 |

Single-machine spot measurement. Numbers are dominated by Node interpreter
startup, not hook logic; treat them as an upper bound on per-call overhead,
not a cross-machine latency ladder.

Reproduce: `node bench/run.mjs --n=20 --write`
