#!/usr/bin/env node
/**
 * Block Dangerous Commands - PreToolUse Hook for Bash
 * Blocks dangerous patterns before execution. Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict' (default: 'high')
 *   critical - Only catastrophic: rm -rf ~, dd to disk, fork bombs
 *   high     - + risky: force push main, secrets exposure, git reset --hard
 *   strict   - + cautionary: any force push, sudo rm, docker prune
 * Override via HOOK_SAFETY_LEVEL in the hook command; invalid values fall
 * back to the default (don't edit this file: plugin updates overwrite it).
 *
 * Ask mode (opt-in, per level): set HOOK_ASK_CRITICAL / HOOK_ASK_HIGH /
 * HOOK_ASK_STRICT to the literal string "true" in the hook command to have
 * that level prompt the user ("ask") instead of blocking outright ("deny").
 * e.g. "command": "HOOK_ASK_STRICT=true node /path/to/block-dangerous-commands.js"
 *
 * Install as a plugin (recommended):
 *   /plugin install block-dangerous-commands@claude-code-hooks
 * This auto-wires the PreToolUse hook on Bash; configure via the env vars above.
 *
 * Or wire it up the classic way (copy the script, then in .claude/settings.json):
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

// Safety level, env-overridable via HOOK_SAFETY_LEVEL. Invalid or unset values
// fall back to the default.
const DEFAULT_SAFETY_LEVEL = 'high';
const SAFETY_LEVEL = ['critical', 'high', 'strict'].includes(process.env.HOOK_SAFETY_LEVEL)
  ? process.env.HOOK_SAFETY_LEVEL
  : DEFAULT_SAFETY_LEVEL;

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
  { level: 'critical', id: 'rm-home-var',      regex: /\brm\s+(-.+\s+)*["']?\$(HOME|\{HOME\})\/?["']?(\s|$|[;&|])/,          reason: 'rm targeting $HOME' },
  { level: 'critical', id: 'rm-home-trailing', regex: /\brm\s+.+\s+["']?(~\/?|\$(HOME|\{HOME\})\/?)["']?(\s*$|[;&|])/,    reason: 'rm with trailing ~/ or $HOME' },
  { level: 'critical', id: 'rm-home-abs',      regex: /\brm\s+(-.+\s+)*["']?\/(home|Users)(\/[^\/\s"';&|]+)?\/?["']?(\s|$|[;&|])/, reason: 'rm targeting a home directory by absolute path' },
  { level: 'critical', id: 'rm-root',          regex: /\brm\s+(-.+\s+)*\/(\*|\s|$|[;&|])/,                                 reason: 'rm targeting root filesystem' },
  { level: 'critical', id: 'rm-system',        regex: /\brm\s+(-.+\s+)*\/(etc|usr|var|bin|sbin|lib|boot|dev|proc|sys)(\/|\s|$)/, reason: 'rm targeting system directory' },
  { level: 'critical', id: 'rm-cwd',           regex: /\brm\s+(-.+\s+)*(\.\/?|\*|\.\/\*)(\s|$|[;&|])/,                     reason: 'rm deleting current directory contents' },
  { level: 'critical', id: 'rm-parent',        regex: /\brm\s+(-.+\s+)*["']?\.\.\/?(\*)?["']?(\s|$|[;&|])/,                   reason: 'rm deleting the parent directory' },
  { level: 'critical', id: 'dd-disk',          regex: /\bdd\b.+of=\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z]|xvd[a-z]|r?disk\d)/,         reason: 'dd writing to disk device' },
  { level: 'critical', id: 'mkfs',             regex: /\bmkfs(\.\w+)?\s+\/dev\/(sd[a-z]|nvme|hd[a-z]|vd[a-z]|r?disk\d)/,    reason: 'mkfs formatting disk' },
  { level: 'critical', id: 'fork-bomb',        regex: /:\(\)\s*\{.*:\s*\|\s*:.*&/,                                         reason: 'fork bomb detected' },

  // HIGH - Significant risk, data loss, security
  { level: 'high', id: 'curl-pipe-sh',   regex: /\b(curl|wget)\b.+\|\s*(sudo\s+(-\S+\s+)*)?(\S*\/)?(ba|z|da|k)?sh\b/,         reason: 'piping URL to shell (RCE risk)' },
  { level: 'high', id: 'curl-subst-sh',  regex: /(\b(ba|z|da|k)?sh|\bsource|(^|[;&|(]\s*)\.)\s+<\(\s*(curl|wget)\b|\b(ba|z|da|k)?sh\s+-c\s+["']?\$\(\s*(curl|wget)\b/, reason: 'running a downloaded script through process or command substitution (RCE risk)' },
  // Flag and branch in either order, within one command segment; +main is a force refspec.
  { level: 'high', id: 'git-force-main', segment: true, regex: /\bgit\s+push\b(?![^;&|\n]*--force-with-lease)(?=[^;&|\n]*\s(--force|-f)(?=\s|$|[;&|"']))(?=[^;&|\n]*(?:[\s:"']|refs\/heads\/)(main|master)(?=$|[\s;&|"']))|\bgit\s+push\b[^;&|\n]*\s["']?\+([^\s:]*:)?(refs\/heads\/)?(main|master)(?=$|[\s;&|"'])/, reason: 'force push to main/master' },
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
const LOG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.claude', 'hooks-logs');

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n');
  } catch {}
}

// Separators inside quotes are argument text, not command boundaries, so
// segment-scoped patterns run on a copy with those separators blanked.
function maskQuotedSeparators(cmd) {
  let out = '';
  let q = '';
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && q !== "'" && i + 1 < cmd.length) { out += ch + cmd[++i]; continue; }
    if (q) {
      if (ch === q) q = '';
      else if (/[;&|\n]/.test(ch)) { out += ' '; continue; }
    } else if (ch === '"' || ch === "'") q = ch;
    out += ch;
  }
  return out;
}

function checkCommand(cmd, safetyLevel = SAFETY_LEVEL) {
  const threshold = LEVELS[safetyLevel] || 2;
  const masked = maskQuotedSeparators(cmd);
  for (const p of PATTERNS) {
    if (LEVELS[p.level] <= threshold && p.regex.test(p.segment ? masked : cmd)) {
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
