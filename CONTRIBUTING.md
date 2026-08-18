# Contributing

Thanks for your interest in contributing to claude-code-hooks!

Every hook in this repo ships as an installable **plugin**: a self-contained bundle
under `plugins/<name>/` that the user gets with one `/plugin install` command (hooks +
tests + a README, optionally a skill; no manual `settings.json` editing). New hooks
land the same way. The sections below walk the whole shape.

---

## Adding a plugin

A plugin is a self-contained directory the marketplace installs on its own. Copy the
shape of an existing one ([`plugins/context-hogs/`](plugins/context-hogs) is the
clearest reference for a card-rendering plugin, [`plugins/block-dangerous-commands/`](plugins/block-dangerous-commands)
for a plain guard) and swap the `<name>`.

### Layout

```
plugins/<name>/
├── <name>.js                       # the hook script: lives at the plugin root
├── README.md                       # what it does, config, env vars
├── .claude-plugin/
│   └── plugin.json                 # metadata ONLY (see below)
├── hooks/
│   └── hooks.json                  # event → command wiring
├── skills/                         # OPTIONAL: only if the plugin has an on-demand card
│   └── <skill>/
│       └── SKILL.md                # the /<name>:<skill> command
└── tests/
    └── <name>.test.js              # hermetic tests
```

Guard-style plugins (deny/ask before a tool runs) ship no skill and no commands: the
hook is the whole product. Observability plugins that accumulate state usually ship a
skill that renders their card on demand.

### Follow the script pattern

A shebang, a header comment with the `/plugin install` line (plus the classic
copy-and-`settings.json` path as the alternative), and the `require.main` guard so the
file is both an executable hook and a testable module:

```javascript
#!/usr/bin/env node
/**
 * Hook Name - Event Hook for Matcher. Logs to: ~/.claude/hooks-logs/
 * Setup: /plugin install <name>@claude-code-hooks
 * Classic: copy to ~/.claude/hooks/ and register in .claude/settings.json
 */
// Implementation

if (require.main === module) main();
else module.exports = { /* exported functions for testing */ };
```

Tunables belong in **env vars**, not constants the user must edit: installed plugin
files are overwritten on update, so a hardcoded knob is a knob nobody can turn. The
guard plugins read `HOOK_SAFETY_LEVEL` (validated against `critical`/`high`/`strict`,
falling back to the default on anything else); follow that pattern, validate the
value, and keep a sane default.

### `plugin.json` is metadata-only

It carries **only** these keys: `name`, `description`, `version`, `author`
(`{ name, url }`), `homepage`, `license`, `keywords`. Nothing else.

> ⚠️ **Do NOT** add `hooks`, `skills`, or `commands` keys here. Hooks are
> auto-discovered from `hooks/hooks.json` and skills from `skills/`. Declaring them
> in `plugin.json` double-registers them and breaks loading with
> **"Duplicate hooks file detected"**.

### `hooks/hooks.json` conventions

Wire each event to the script by its plugin-root path: always
`node "${CLAUDE_PLUGIN_ROOT}/<name>.js"`. Example (`context-hogs`):

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Read|Grep|Glob|Bash", "hooks": [
        { "type": "command", "async": true, "command": "node \"${CLAUDE_PLUGIN_ROOT}/<name>.js\"" }] }],
    "SessionEnd": [
      { "hooks": [
        { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/<name>.js\"" }] }]
  }
}
```

**The `async` rule**: `"async": true` is for **pure recorder events only** (they
append to a ledger and their stdout is ignored, so they add ~zero latency). Any event
whose output Claude Code actually consumes **MUST stay synchronous**:

- injects `additionalContext`: `dead-end-registry` `UserPromptSubmit`,
  `standup-autopilot` `SessionStart`
- returns a `permissionDecision`: every guard plugin's `PreToolUse`,
  `dead-end-registry` `PreToolUse`
- rewrites `updatedInput`: `pr-provenance-stamp` `PreToolUse`
- renders a `systemMessage` card: `context-hogs` `SessionEnd`
- blocks via exit code 2: `config-watch` `ConfigChange`

Mark one of those `async` and its output is dropped: the feature silently no-ops (a
guard that denies asynchronously denies nothing).

### The skill (card-rendering plugins only)

A plugin with an on-demand card ships one skill that renders it. `skills/<skill>/SKILL.md`:

```markdown
---
name: <skill>
description: One line describing what the card shows
disable-model-invocation: true
---

# Title

!`node "${CLAUDE_SKILL_DIR}/../../<name>.js" --render 2>/dev/null || node "${CLAUDE_PLUGIN_ROOT}/<name>.js" --render`

Prose telling Claude how to summarize the rendered card. Keep it short; do not re-run
any commands.
```

- Frontmatter `name` **must match the folder name**; `disable-model-invocation: true`
  keeps it an explicit slash command, not something the model fires on its own.
- The `!`…`` line shells out to your script's `--render` mode: `${CLAUDE_SKILL_DIR}/../../`
  (two levels up to the plugin root) primary, `${CLAUDE_PLUGIN_ROOT}` fallback.
- It is invoked as **`/<name>:<skill>`**, e.g. `/context-hogs:leaderboard`.

### The hook-script contract

`<name>.js` is the hook (and, for card plugins, its own render CLI). It must:

- Read the event JSON from **stdin**, `JSON.parse` it, and branch on
  `data.hook_event_name`.
- **Never crash the agent loop**: on any error (bad JSON included) print `{}` and
  `exit 0`. Wrap `main()` in try/catch.
- Keep the `require.main === module` guard and `module.exports` your **pure
  functions** so tests can import them without spawning.
- Card plugins: implement a **`--render`** branch (`process.argv.includes('--render')`)
  that prints the card to stdout; this is what the skill calls.
- Log meaningful events to **`~/.claude/hooks-logs/<date>.jsonl`**; keep durable
  per-plugin state under **`~/.claude/<name>/`**.

### Tests

Put them in **`plugins/<name>/tests/<name>.test.js`** and keep them **hermetic**:
spawn the script with a fresh temp `HOME` (`fs.mkdtempSync(...)` + `HOME`/`USERPROFILE`
in `env`), and strip any env vars your hook reads (`HOOK_SAFETY_LEVEL`, `HOOK_ASK_*`,
your own vars) from the spawned environment, so a run never touches the real home dir
or flips on ambient shell state. Resolve paths via `__dirname` so the suite passes
from any cwd.

The `npm test` glob (`plugins/**/tests/*.test.js`) picks the file up automatically,
**as long as it sits exactly one level under `plugins/<name>/tests/`**. The meta guard
[`tests/test-discovery.test.js`](tests/test-discovery.test.js)
fails the suite if any `*.test.js` lands at a depth the glob can't reach, so coverage
loss surfaces instead of hiding behind a green run.

### Register the plugin

A plugin isn't discoverable until it's listed. Add it in all of:

1. **`.claude-plugin/marketplace.json`**: a new entry in `plugins[]` with `name`,
   `source` (`"./plugins/<name>"`), `description`, `category`, and `tags`.
2. **README.md**: a row in the table under the matching event section of
   [🪝 Hooks](README.md), and a row in the plugin table under
   [🔌 Install as a plugin](README.md) (third column: the `/<name>:<skill>` command,
   or the key config note for plugins without one).
3. **`site/index.html`**: add a card in the marketplace section and keep the
   plugin/tool **counts** in the surrounding copy accurate.

### Validate before you PR

Run these from the repo root (`<name>` = your plugin):

```bash
# 1. Everything parses (JS + the three JSON files)
node --check plugins/<name>/<name>.js
node -e "['plugins/<name>/.claude-plugin/plugin.json','plugins/<name>/hooks/hooks.json','.claude-plugin/marketplace.json'].forEach(f=>JSON.parse(require('fs').readFileSync(f)))"

# 2. The marketplace agrees the plugin is well-formed
claude plugin validate ./plugins/<name>

# 3. Garbage stdin must degrade to `{}` and exit 0 (never crash the loop)
echo 'not json {{{' | node plugins/<name>/<name>.js   # → {}

# 4. Full suite green
env -u CCH_SLA_WEBHOOK npm test
```

---

## Code Style

- Keep it concise: no over-engineering
- Use Node.js built-in modules where possible
- Log to `~/.claude/hooks-logs/` using JSONL format
- Handle errors gracefully: always output `{}` on failure
- Export core functions for testability
- Tunables are env vars with validated values and sane defaults, never
  edit-this-constant knobs

## Testing

```bash
env -u CCH_SLA_WEBHOOK npm test              # whole suite (must be green before merging)
node --test plugins/<name>/tests/<name>.test.js   # a single plugin's file
```

## Versioning

Plugin versions are independent of the repo `package.json` version and independent of each other. Bump a plugin's `version` in its `.claude-plugin/plugin.json` whenever that plugin's shipped files change: the install cache is keyed by version, so a bump is what forces installed copies to refresh. Versions only ever move forward: never reset or downgrade one for cosmetic consistency (a re-published old version can collide with a stale cached copy of that same version on users' machines). Describe the bump in the PR so it is intentional rather than drift.

## Pull Request Process

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-plugin`)
3. Add your work + tests: the `plugins/<name>/` bundle + tests + all three
   registration touchpoints, plus a `version` bump if you touch an existing plugin
4. Run `env -u CCH_SLA_WEBHOOK npm test` to ensure all tests pass
5. Submit a PR with a clear description (call out any plugin `version` bump)

## Hook & plugin ideas

Looking for inspiration? These aren't covered yet:

- [ ] Notify Discord/Telegram on permission prompts
- [ ] Protected-branch guarding beyond `git-safety`: it already denies git ops on
      the hardcoded `main`/`master`, so the open work is a *configurable* branch list or
      catching *non-git* writes (editor Edit/Write, `>` redirects) on a protected branch
- [ ] Log all commands to an external service
- [ ] Rate limit tool calls

## Questions?

Open an issue if you have questions or want to discuss an idea before implementing.
