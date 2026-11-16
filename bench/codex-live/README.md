# Codex live check

Runs guard-pack inside real Codex CLI sessions and checks the disk afterwards. It is the check that recorded payloads in `npm test` cannot make: whether Codex really runs the hook, and whether a block really stops the action.

```bash
node bench/codex-live/run.mjs          # print the results table
node bench/codex-live/run.mjs --keep   # keep the scratch repos for inspection
```

What it does:

1. Makes a throwaway `CODEX_HOME` with a copy of your Codex login, and installs guard-pack from this checkout with `codex plugin marketplace add` and `codex plugin add`.
2. Approves the hook the way `/hooks` does, by recording the two hashes that Codex's `hooks/list` reports.
3. Asks Codex to attempt each guarded action once in a throwaway git repo, then reads file modes, file contents and the session log.
4. Changes one file in the installed plugin and runs once more, to show that Codex skips a hook whose plugin changed after approval.

A second script, `patch-parity.cjs`, needs no model: it applies random patches with Codex's own patch engine (the `codex` binary run as `apply_patch`) and checks that guard-pack's reader named every file Codex changed and refused no patch Codex applied.

```bash
node bench/codex-live/patch-parity.cjs 1500
```

`run.mjs` costs a few model turns on your Codex account, needs `codex` on PATH and a login, and never reads or writes your own Codex config or `~/.claude`. The throwaway home is deleted at the end. Committed results: [RESULTS.md](RESULTS.md).
