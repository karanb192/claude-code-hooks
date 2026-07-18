#!/usr/bin/env node
/**
 * Block Dangerous Commands - PreToolUse Hook for Bash
 * Blocks dangerous patterns before execution. Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict'
 *   critical - Only catastrophic: rm -rf ~, dd to disk, fork bombs
 *   high     - + risky: force push main, secrets exposure, git reset --hard
 *   strict   - + cautionary: any force push, sudo rm, docker prune
 *
 * Ask mode (opt-in, per level): set HOOK_ASK_CRITICAL / HOOK_ASK_HIGH /
 * HOOK_ASK_STRICT to the literal string "true" in the hook command to have
 * that level prompt the user ("ask") instead of blocking outright ("deny").
 * e.g. "command": "HOOK_ASK_STRICT=true node /path/to/block-dangerous-commands.js"
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/block-dangerous-commands.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const SAFETY_LEVEL = 'high';

// Ask mode per level: if true, prompts the user instead of blocking outright.
// When ask=true, the hook returns decision "ask" so Claude Code shows the
// reason and lets the user decide. When ask=false (default), the hook denies.
// Env overrides: HOOK_ASK_CRITICAL, HOOK_ASK_HIGH, HOOK_ASK_STRICT
const envBool = (key, fallback) => key in process.env ? process.env[key] === 'true' : fallback;
const ASK = {
  critical: envBool('HOOK_ASK_CRITICAL', false),
  high:     envBool('HOOK_ASK_HIGH', false),
  strict:   envBool('HOOK_ASK_STRICT', false),
};

const PATTERNS = [
  // CRITICAL - Catastrophic, unrecoverable
  { level: 'critical', id: 'rm-home',          regex: /\brm\s+(-.+\s+)*["']?~\/?["']?(\s|$|[;&|])/,                        reason: 'rm targeting home directory' },
  { level: 'critical', id: 'rm-home-var',      regex: /\brm\s+(-.+\s+)*["']?\$HOME["']?(\s|$|[;&|])/,                      reason: 'rm targeting $HOME' },
  { level: 'critical', id: 'rm-home-trailing', regex: /\brm\s+.+\s+["']?(~\/?|\$HOME)["']?(\s*$|[;&|])/,                   reason: 'rm with trailing ~/ or $HOME' },
  { level: 'critical', id: 'rm-root',          regex: /\brm\s+(-.+\s+)*\/(\*|\s|$|[;&|])/,                                 reason: 'rm targeting root filesystem' },
  { level: 'critical', id: 'rm-system',        regex: /\brm\s+(-.+\s+)*\/(etc|usr|var|bin|sbin|lib|boot|dev|proc|sys)(\/|\s|$)/, reason: 'rm targeting system directory' },
  { level: 'critical', id: 'rm-cwd',           regex: /\brm\s+(-.+\s+)*(\.\/?|\*|\.\/\*)(\s|$|[;&|])/,                     reason: 'rm deleting current directory contents' },
  { level: 'critical', id: 'dd-disk',          regex: /\bdd\b.+of=\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z]|xvd[a-z])/,         reason: 'dd writing to disk device' },
  { level: 'critical', id: 'mkfs',             regex: /\bmkfs(\.\w+)?\s+\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z])/,            reason: 'mkfs formatting disk' },
  { level: 'critical', id: 'fork-bomb',        regex: /:\(\)\s*\{.*:\s*\|\s*:.*&/,                                         reason: 'fork bomb detected' },

  // HIGH - Significant risk, data loss, security
  { level: 'high', id: 'curl-pipe-sh',   regex: /\b(curl|wget)\b.+\|\s*(ba)?sh\b/,                                        reason: 'piping URL to shell (RCE risk)' },
  { level: 'high', id: 'git-force-main', regex: /\bgit\s+push\b(?!.+--force-with-lease).+(--force|-f)\b.+\b(main|master)\b/, reason: 'force push to main/master' },
  { level: 'high', id: 'git-reset-hard', regex: /\bgit\s+reset\s+--hard/,                                                 reason: 'git reset --hard loses uncommitted work' },
  { level: 'high', id: 'git-clean-f',    regex: /\bgit\s+clean\s+(-\w*f|-f)/,                                             reason: 'git clean -f deletes untracked files' },
  { level: 'high', id: 'chmod-777',      regex: /\bchmod\b.+\b777\b/,                                                     reason: 'chmod 777 is a security risk' },
  { level: 'high', id: 'docker-vol-rm',  regex: /\bdocker\s+volume\s+(rm|prune)/,                                         reason: 'docker volume deletion loses data' },

  // STRICT - Cautionary, context-dependent
  { level: 'strict', id: 'git-force-any',    regex: /\bgit\s+push\b(?!.+--force-with-lease).+(--force|-f)\b/,              reason: 'force push (use --force-with-lease)' },
  { level: 'strict', id: 'git-checkout-dot', regex: /\bgit\s+checkout\s+\./,                                               reason: 'git checkout . discards changes' },
  { level: 'strict', id: 'sudo-rm',          regex: /\bsudo\s+rm\b/,                                                       reason: 'sudo rm has elevated privileges' },
  { level: 'strict', id: 'docker-prune',     regex: /\bdocker\s+(system|image)\s+prune/,                                   reason: 'docker prune removes images' },
  { level: 'strict', id: 'crontab-r',        regex: /\bcrontab\s+-r/,                                                      reason: 'removes all cron jobs' },
];

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🚨', high: '⛔', strict: '⚠️' };
const LOG_DIR = path.join(process.env.HOME, '.claude', 'hooks-logs');

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n');
  } catch {}
}

function checkCommand(cmd, safetyLevel = SAFETY_LEVEL) {
  const threshold = LEVELS[safetyLevel] || 2;
  for (const p of PATTERNS) {
    if (LEVELS[p.level] <= threshold && p.regex.test(cmd)) {
      return { blocked: true, pattern: p };
    }
  }
  return { blocked: false, pattern: null };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const { tool_name, tool_input, session_id, cwd, permission_mode } = data;
    if (tool_name !== 'Bash') return console.log('{}');

    const cmd = tool_input?.command || '';
    const result = checkCommand(cmd);

    if (result.blocked) {
      const p = result.pattern;
      const shouldAsk = ASK[p.level] === true;
      const decision = shouldAsk ? 'ask' : 'deny';
      log({ level: shouldAsk ? 'ASK' : 'BLOCKED', id: p.id, priority: p.level, decision, cmd, session_id, cwd, permission_mode });
      return console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: `${EMOJIS[p.level]} [${p.id}] ${p.reason}`
        }
      }));
    }
    console.log('{}');
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { PATTERNS, LEVELS, SAFETY_LEVEL, ASK, checkCommand };
}
