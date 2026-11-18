'use strict';

const envBool = (key) => process.env[key] === 'true';

// A guard that throws denies the call rather than allowing it, unless the user
// set HOOK_FAIL_OPEN=true. Same text as the standalone guards' guardError.
const failOpen = () => envBool('HOOK_FAIL_OPEN');
const guardErrorReason = (name, e) => `[guard-error] ${name} could not check this call (${String(e && e.message).slice(0, 200)}), so it is blocked. Run it yourself if you meant it, or set HOOK_FAIL_OPEN=true to let calls through when a guard fails.`;

// Two emoji vocabularies exist across the guards; kept per guard so the
// pack's output is character-identical to the standalone hook's.
const STD_EMOJIS = { critical: '🚨', high: '⛔', strict: '⚠️' };
const LOCK_EMOJIS = { critical: '🔒', high: '🛡️', strict: '⚠️' };

// Each entry mirrors its guard's main(): same tool filter, same escape
// hatches, same reason template. run(mod, tool, input, cwd, event) returns
// null (pass) or { id, level, ask, reason, log? }; reason lacks only the
// emoji prefix, log adds fields to the audit line, event is the full payload.
// Keep the pack's dispatch and hooks.json registration in sync.

const GUARDS = [
  {
    // One string compare for other tools; the only guard that applies on a spawn.
    name: 'subagent-spawn-cap',
    emojis: { critical: '🚨', high: '⚠️', strict: '⚠️' },
    run(mod, tool, input, cwd, event) {
      if (!mod.isSpawnTool(tool)) return null;
      const spawnEvent = { ...(event || {}), tool_name: tool, tool_input: input };
      const r = event?.hook_host === 'codex' ? mod.evaluateCodexSpawn(spawnEvent) : mod.evaluateSpawn(spawnEvent);
      if (r.decision === 'allow') return null;
      return { id: 'spawn-cap', level: r.decision === 'deny' ? 'critical' : 'high', ask: r.decision === 'ask', reason: r.reason, log: r.logFields };
    },
  },
  {
    name: 'config-guard',
    emojis: LOCK_EMOJIS,
    skip: () => envBool('CONFIG_GUARD_ALLOW'),
    run(mod, tool, input, cwd) {
      const r = mod.checkTool(tool, input || {}, undefined, cwd);
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
      if (!mod.HANDLED_TOOLS.includes(tool)) return null;
      const r = mod.check(tool, input);
      if (!r.blocked) return null;
      const p = r.pattern;
      const action = { Read: 'read', Edit: 'modify', Write: 'write to', Bash: 'execute', Grep: 'search' }[tool];
      return { id: p.id, level: p.level, ask: mod.ASK[p.level] === true, reason: `[${p.id}] Cannot ${action}: ${p.reason}` };
    },
  },
  {
    name: 'protect-tests',
    emojis: STD_EMOJIS,
    run(mod, tool, input, cwd) {
      const r = mod.checkTool(tool, input || {}, undefined, cwd);
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

module.exports = { GUARDS, failOpen, guardErrorReason };
