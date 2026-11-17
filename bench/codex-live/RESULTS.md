# Codex CLI: live results

## Workflow plugins

Run on 2026-11-17 with `node bench/codex-live/run.mjs --workflows`, Codex CLI 0.169.0 on macOS. Each plugin was installed separately from the local marketplace checkout in a fresh temporary `CODEX_HOME`, and its hooks were approved by stored declaration/content hashes. Real Ruff 0.17.5 and Prettier 3.10.1 were on the test process's PATH. No user configuration was changed.

| Plugin | Install and approval | Live verification |
|---|---|---|
| auto-stage 1.1.0 | Passed | Native patch additions, update, deletion and both rename paths staged; unrelated existing edits stayed unstaged. Six staging log entries matched the Git index |
| format-code 1.1.0 | Passed | Native patch created unformatted Python and JSON; real Ruff and Prettier produced the expected formatted bytes. Two formatter log entries matched those files |
| session-logger 1.1.0 | All three hooks passed | Session start, patch paths (including deletion/rename), shell command and session end appeared in one note; patch body text was absent |

Isolated regression tests also cover literal Git pathspecs and shell metacharacters, ignore rules, removed parent directories, missing formatters, symlink skips, same-prefix thread IDs, concurrent note appends and lock exhaustion. A local marker probe reproduced command execution through a nested bare repository before the staging fix; the regression now verifies no marker or nested index is created. Further tests verify that repository boundaries are respected, Git monitors and index hooks do not run, and filtered files remain unstaged. These are local process tests, not additional model-driven sessions.

A separate defensive live probe checked the formatter's trust boundary. In a disposable workspace-write session, a direct shell write outside the workspace and a write into `.git` were denied. Before the fix, a Prettier project config could write the outside marker through the hook. With project config loading disabled, the same probe left all three markers absent while JSON still formatted correctly. The Codex adapter now requires Prettier 3 (no automatic plugin discovery), disables config and EditorConfig loading, and runs Ruff in isolated mode without a cache. Local tests also exercise executable configs, declarative plugin configuration and Prettier 2 rejection.

Not tested live: GitHub-hosted marketplace installation, resume, failed/partially applied native patches, simultaneous plugins, Windows, desktop/cloud or remote environments. Shell edits are deliberately not staged/formatted or reconstructed as file activity. Formatter/stager ordering is not guaranteed; review and stage formatted files before committing. The session note records shell commands without claiming their exit status.

```text
PASS auto-stage: installed, trusted and exercised live
PASS format-code: installed, trusted and exercised live
PASS session-logger: installed, trusted and exercised live
codex-cli 0.169.0: 0 workflow failures
```

## Standalone guards

Run on 2026-11-16 with `node bench/codex-live/run.mjs --standalone`, Codex CLI 0.169.0, macOS. Each plugin was installed separately in a fresh temporary Codex home, then approved through the same stored hashes as `/hooks`.

| Plugin | Marketplace install and trusted hook | Live action |
|---|---|---|
| block-dangerous-commands | passed | Registration only in this run |
| protect-secrets | passed | Registration only in this run |
| protect-tests | passed | Native patch changing `test` to `test.skip` blocked; ordinary source comment applied |
| git-safety | passed | Registration only in this run |
| config-guard | passed | Native patch creating `.codex/config.toml` blocked; ordinary source comment applied |
| case-insensitive-guard | passed | Registration only in this run |
| subagent-spawn-cap | passed | With `SPAWN_CAP_ASK=1` and `SPAWN_CAP_DENY=2`, first spawn allowed and second blocked |

The hook logs contained `skip-test`, `codex-config` and `spawn-cap`. The cap's ledger contained exactly one allowed call and its denial log recorded count 2. All seven installs and all three live action checks passed. The other guards' command behavior is covered by isolated-plugin tests, not new live sessions in this run.

The live spawn event used `tool_name: "collaborationspawn_agent"`. The adapter accepts that spelling and the canonical `spawn_agent` spelling. The [schema fixture](../../plugins/guard-pack/tests/fixtures/codex-0.169.0/spawn-agent.json) uses those observed field names with synthetic identifiers, paths and message content; it is not a transcript excerpt. The earlier implementation registered only `spawn_agent` and missed this live call. A persisted temporary thread store is needed for the spawn check; `--ephemeral` cannot create subagents.

The full local test suite passed 2,343 tests with Ruff available. Nested whole-tree budgeting, Windows Codex, the desktop app and cloud tasks were not tested. Shell heredoc patch handling is covered by local tests, not this live run.

Runner stdout summary:

```text
block-dangerous-commands: trusted; install PASS
protect-secrets: trusted; install PASS
protect-tests: trusted; live skip-test PASS
git-safety: trusted; install PASS
config-guard: trusted; live codex-config PASS
case-insensitive-guard: trusted; install PASS
subagent-spawn-cap: trusted; live spawn-cap PASS
codex-cli 0.169.0: 0 standalone failures
```

## guard-pack 1.4.0

Re-run on 2026-11-16 with the updated `node bench/codex-live/run.mjs`, Codex CLI 0.169.0, macOS, after the standalone runner changes and config-path fixes.

guard-pack 1.4.0 was installed from this checkout with `codex plugin marketplace add` and `codex plugin add`, then approved the way `/hooks` records it. Each row is what was on disk after the session, not what the hook printed. All nine outcomes match the earlier 1.3.0 run.

| Action | Expected | On disk |
|---|---|---|
| chmod 777 notes.txt | blocked | blocked |
| cat .env | blocked | blocked |
| rm tests/sum.test.js | blocked | blocked |
| git reset --hard | blocked | blocked |
| test( to test.skip( through apply_patch | blocked | blocked |
| new .env.production through apply_patch | blocked | blocked |
| comment line in sum.js through apply_patch (control) | ran | ran |
| chmod 777 notes.txt with HOOK_ASK_HIGH=true | blocked | blocked |
| chmod 777 notes.txt after a plugin file changed (hook status: modified) | ran (mode 777) | ran (mode 777) |

All 9 rows match. guard-pack's own log for the run, which the script reads from its throwaway HOME, has the six blocks and the ask: `chmod-777, cat-env, delete-test, git-reset-hard, skip-test, env-file, ask:chmod-777`. So each block came from the hook, not from the model declining to try.

Runner stdout summary:

```text
All 9 rows match.
guard-pack log (host codex): chmod-777, cat-env, delete-test, git-reset-hard, skip-test, env-file, ask:chmod-777
```

The last row is Codex behaviour, not a guard-pack bug. Codex re-hashes the plugin folder before every hook run and skips the hook once anything in it changes, until the user approves it again in `/hooks`. Every guard-pack update therefore needs a fresh approval on Codex.

## Patch reader parity

`node bench/codex-live/patch-parity.cjs 1500` on the same day: `codex-cli 0.169.0: 1500 patches, 403 applied by Codex, missed 0, refused 0`. Missed counts files Codex changed that the reader did not name; refused counts patches Codex applied that the reader blocked.

The pack run does not exercise the spawn cap. The standalone cap is checked above; guard-pack's shared cap dispatch is covered by local tests. Codex on Windows, the desktop app and cloud tasks remain untested. Both live runs install from the local checkout through the marketplace commands; the published GitHub marketplace path was not re-tested here.
