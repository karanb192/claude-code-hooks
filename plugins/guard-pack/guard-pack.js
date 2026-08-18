#!/usr/bin/env node
/**
 * Guard Pack - PreToolUse Hook for Bash|Read|Edit|MultiEdit|Write
 * All six guard hooks in ONE Node process. Installing the guards
 * individually costs six Node startups per matching tool call (about 35 ms
 * each, see bench/RESULTS.md); this pack pays one.
 *
 * Evaluation order (cheap string checks first, filesystem and subprocess
 * work last): config-guard, block-dangerous-commands, protect-secrets,
 * protect-tests, git-safety, case-insensitive-guard. The first blocking
 * verdict wins and is emitted in that guard's own output format, suffixed
 * "(via guard-pack)". A guard that throws is logged and skipped so one
 * broken guard can never switch off the other five (fail-open per guard,
 * same convention as the standalone hooks).
 *
 * The guard scripts in lib/ are byte-identical copies of the individual
 * plugin scripts; a repo test pins them, so they cannot drift. All the
 * guards' env vars pass straight through, since the modules read them
 * directly: HOOK_SAFETY_LEVEL (applies to every guard in the pack
 * uniformly), HOOK_ASK_CRITICAL / HOOK_ASK_HIGH / HOOK_ASK_STRICT, and
 * CONFIG_GUARD_ALLOW. Want different safety levels per guard? Install the
 * individual guard plugins instead of the pack.
 *
 * Do NOT install this pack alongside the individual guard plugins (or a
 * manual registration of any of the six): every duplicated guard runs
 * twice on each matching tool call. Logs to: ~/.claude/hooks-logs/
 *
 * Setup (plugin, recommended):
 *   /plugin marketplace add karanb192/claude-code-hooks
 *   /plugin install guard-pack@claude-code-hooks
 * The plugin's hooks/hooks.json registers this script automatically.
 */

const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, 'lib');
const LOG_DIR = path.join(process.env.HOME || '/tmp', '.claude', 'hooks-logs');

const envBool = (key) => process.env[key] === 'true';

// Two emoji vocabularies exist across the guards; kept per guard so the
// pack's output is character-identical to the standalone hook's.
const STD_EMOJIS = { critical: '🚨', high: '⛔', strict: '⚠️' };
const LOCK_EMOJIS = { critical: '🔒', high: '🛡️', strict: '⚠️' };

// Each entry mirrors its guard's main(): same tool filter, same escape
// hatches, same reason template. run() returns null (pass) or
// { id, level, ask, reason } with reason lacking only the emoji prefix.
const GUARDS = [
  {
    name: 'config-guard',
    emojis: LOCK_EMOJIS,
    skip: () => envBool('CONFIG_GUARD_ALLOW'),
    run(mod, tool, input) {
      const r = mod.checkTool(tool, input || {});
      if (!r.blocked) return null;
      return {
        id: r.id, level: r.level, ask: mod.ASK[r.level] === true,
        reason: `[${r.id}] ${r.reason}. Guardrail config is protected; if this change is intentional and human-approved, set CONFIG_GUARD_ALLOW=true for this call or edit the file yourself.`,
      };
    },
  },
  {
    name: 'block-dangerous-commands',
    emojis: STD_EMOJIS,
    run(mod, tool, input) {
      if (tool !== 'Bash') return null;
      const r = mod.checkCommand(input?.command || '');
      if (!r.blocked) return null;
      const p = r.pattern;
      return { id: p.id, level: p.level, ask: mod.ASK[p.level] === true, reason: `[${p.id}] ${p.reason}` };
    },
  },
  {
    name: 'protect-secrets',
    emojis: STD_EMOJIS,
    run(mod, tool, input) {
      if (!['Read', 'Edit', 'Write', 'Bash'].includes(tool)) return null;
      const r = mod.check(tool, input);
      if (!r.blocked) return null;
      const p = r.pattern;
      const action = { Read: 'read', Edit: 'modify', Write: 'write to', Bash: 'execute' }[tool];
      return { id: p.id, level: p.level, ask: mod.ASK[p.level] === true, reason: `[${p.id}] Cannot ${action}: ${p.reason}` };
    },
  },
  {
    name: 'protect-tests',
    emojis: STD_EMOJIS,
    run(mod, tool, input) {
      const r = mod.checkTool(tool, input || {});
      if (!r.blocked) return null;
      return {
        id: r.id, level: r.level, ask: false,
        reason: `[${r.id}] ${r.reason}. Fix the code, don't disable the test: or run this manually if the removal is intentional.`,
      };
    },
  },
  {
    name: 'git-safety',
    emojis: STD_EMOJIS,
    run(mod, tool, input) {
      if (tool !== 'Bash') return null;
      const r = mod.checkCommand(input?.command || '');
      if (!r.blocked) return null;
      return { id: r.pattern.id, level: r.pattern.level, ask: false, reason: `[${r.pattern.id}] ${r.reason}` };
    },
  },
  {
    name: 'case-insensitive-guard',
    emojis: STD_EMOJIS,
    run(mod, tool, input, cwd) {
      if (tool !== 'Bash' || !input?.command) return null;
      const r = mod.checkCommand(input.command, cwd);
      if (!r.blocked) return null;
      const hit = r.hit;
      return {
        id: 'case-collision', level: hit.level, ask: mod.ASK[hit.level] === true,
        reason: `[case-collision] ${hit.cmd} targets '${hit.typed}' but this case-insensitive directory contains '${hit.actual}': same path on disk, so the differently-cased entry would be hit`,
      };
    },
  },
];

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'guard-pack', ...data }) + '\n');
  } catch {}
}

// Evaluate all guards for one event; returns null or the winning verdict
// with its guard attached. Exported for tests.
function evaluate(toolName, toolInput, cwd) {
  for (const g of GUARDS) {
    try {
      if (g.skip && g.skip()) continue;
      const mod = require(path.join(LIB, `${g.name}.js`));
      const verdict = g.run(mod, toolName, toolInput, cwd);
      if (verdict) return { guard: g.name, emojis: g.emojis, ...verdict };
    } catch (e) {
      log({ level: 'ERROR', guard: g.name, error: e.message });
    }
  }
  return null;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const { tool_name, tool_input, session_id, cwd, permission_mode } = data;
    if (!['Bash', 'Read', 'Edit', 'MultiEdit', 'Write'].includes(tool_name)) return console.log('{}');

    const v = evaluate(tool_name, tool_input, cwd);
    if (!v) return console.log('{}');

    const decision = v.ask ? 'ask' : 'deny';
    log({ level: v.ask ? 'ASK' : 'BLOCKED', guard: v.guard, id: v.id, priority: v.level, decision, tool: tool_name, session_id, cwd, permission_mode });
    return console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: `${v.emojis[v.level]} ${v.reason} (via guard-pack)`,
      },
    }));
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { GUARDS, evaluate };
}
