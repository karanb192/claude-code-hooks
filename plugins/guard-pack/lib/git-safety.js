#!/usr/bin/env node
/**
 * Git Safety - PreToolUse Hook for Bash
 * Blocks destructive git and gh CLI operations. Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict' (default 'high')
 *   Override via the HOOK_SAFETY_LEVEL env var; invalid values fall back to the
 *   default. Prefer the env var over editing this file: plugin updates
 *   overwrite installed files.
 *   critical - no git-safety rules apply (defer entirely to block-dangerous-commands.js)
 *   high     - branch-aware guardrails (commit/merge/rebase/reset/push while on a
 *              protected branch), protected-branch deletion, direct pushes to
 *              main/master by name, and destructive gh CLI operations
 *   strict   - + force-push, so this hook is self-sufficient standalone
 *
 * Composition with block-dangerous-commands.js:
 *   That hook already blocks force-push (any, and to main/master) and
 *   `git reset --hard` on any branch. At the default 'high' level this hook adds
 *   only the complementary coverage above, so the two do not overlap. Raise this
 *   hook to 'strict' (or leave the sibling out) if you run git-safety on its own.
 *
 * Setup (plugin, recommended):
 *   /plugin marketplace add karanb192/claude-code-hooks
 *   /plugin install git-safety@claude-code-hooks
 *
 * Classic setup still works: copy the script somewhere stable and register it
 * in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/git-safety.js" }]
 *     }]
 *   }
 * }
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_SAFETY_LEVEL = 'high';
const SAFETY_LEVEL = ['critical', 'high', 'strict'].includes(process.env.HOOK_SAFETY_LEVEL)
  ? process.env.HOOK_SAFETY_LEVEL
  : DEFAULT_SAFETY_LEVEL;

const PROTECTED_BRANCHES = ['main', 'master'];

// git with global options before the subcommand (git -C repo push, git -c k=v push).
// Option values may be quoted, attached (-C/repo) or a separate word (--git-dir /repo).
// The alternatives never match the same text, so a long option run stays linear.
const GIT_VAL = '(?:"[^"]*"|\'[^\']*\'|[^\\s"\'][^\\s]*)';
const GIT_LONG_VAL = '(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)';
const GIT = '\\bgit(?:\\s+(?:-[Cc]\\s*' + GIT_VAL + '|--' + GIT_LONG_VAL + '(?:=|\\s+)' + GIT_VAL + '|--(?!' + GIT_LONG_VAL + '\\b)[\\w-]+(?:=\\S+)?|-(?![Cc])[A-Za-z]))*\\s+';

const PATTERNS = [
  // STRICT - force-push is normally handled by block-dangerous-commands.js.
  // Only enforced here at 'strict' so git-safety is self-sufficient standalone.
  { level: 'strict', id: 'force-push',              segment: true, regex: new RegExp(GIT + 'push\\b[^;&|\\n]*\\s["\']?(?:--force|-f)["\']?(?=\\s|$|[;&|"\'])'), reason: 'Force-pushing is not allowed' },

  // HIGH - complementary coverage the sibling hook does not provide

  // Block pushing directly to a protected branch by name
  // The branch as a whole ref (origin main, HEAD:main, +main, refs/heads/main), so my-main-feature is not main.
  { level: 'high', id: 'push-main',                 segment: true, regex: new RegExp(GIT + 'push\\b[^;&|\\n]*(?:[\\s:+"\']|refs\\/heads\\/)main(?=$|[\\s;&|:"\'])'),   reason: 'Pushing to main is not allowed' },
  { level: 'high', id: 'push-master',               segment: true, regex: new RegExp(GIT + 'push\\b[^;&|\\n]*(?:[\\s:+"\']|refs\\/heads\\/)master(?=$|[\\s;&|:"\'])'), reason: 'Pushing to master is not allowed' },

  // Block deleting protected branches locally
  { level: 'high', id: 'branch-delete-protected',   regex: new RegExp(GIT + 'branch\\s+.*(?:-[dD]|--delete)\\s+(?:main|master)\\b'), reason: 'Deleting a protected branch is not allowed' },

  // Block direct changes when on a protected branch
  { level: 'high', id: 'commit-on-protected',       regex: new RegExp(GIT + 'commit\\b'),                                reason: 'Committing directly on {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'merge-on-protected',        regex: new RegExp(GIT + 'merge\\b'),                                 reason: 'Merging into {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'rebase-on-protected',       regex: new RegExp(GIT + 'rebase\\b'),                                reason: 'Rebasing {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'reset-on-protected',        regex: new RegExp(GIT + 'reset\\b'),                                 reason: 'Resetting {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'push-on-protected',         regex: new RegExp(GIT + 'push\\b'),                                  reason: 'Pushing from {branch} is not allowed', branchOnly: true },

  // Block destructive gh CLI operations
  { level: 'high', id: 'gh-pr-merge',               regex: /\bgh\s+pr\s+merge\b/,                             reason: 'Merging PRs via gh CLI is not allowed' },
  { level: 'high', id: 'gh-pr-close',               regex: /\bgh\s+pr\s+close\b/,                             reason: 'Closing PRs via gh CLI is not allowed' },
  { level: 'high', id: 'gh-issue-close',            regex: /\bgh\s+issue\s+close\b/,                          reason: 'Closing issues via gh CLI is not allowed' },
  { level: 'high', id: 'gh-release-delete',         regex: /\bgh\s+release\s+delete\b/,                       reason: 'Deleting releases via gh CLI is not allowed' },
  { level: 'high', id: 'gh-repo-delete',            regex: /\bgh\s+repo\s+delete\b/,                          reason: 'Deleting repos via gh CLI is not allowed' },
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

function getCurrentBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

// Separators inside quotes are argument text, not command boundaries, and an
// unquoted # starts a comment, so segment-scoped patterns run on a copy with
// quoted and escaped separators blanked and comments dropped. A quote that
// opens right after = (--push-option="x;main") is an option value: its text is
// blanked too, so it cannot pose as a ref. A quoted whole word ("main") or
// a quoted refspec side (HEAD:"main") stays.
function maskQuotedSeparators(cmd) {
  let out = '';
  let q = '';
  let blank = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && q !== "'" && i + 1 < cmd.length) {
      const next = cmd[++i];
      out += blank || /[;&|]/.test(next) ? '__' : ch + next;
      continue;
    }
    if (q) {
      if (ch === q) { q = ''; blank = false; }
      else if (blank) { out += '_'; continue; }
      // A placeholder, not a space: "topic;main" is one ref word, not topic and main.
      else if (/[;&|]/.test(ch)) { out += '_'; continue; }
      else if (ch === '\n') { out += ' '; continue; }
    } else if (ch === '"' || ch === "'") {
      q = ch;
      blank = out[out.length - 1] === '=';
    } else if (ch === '#' && (i === 0 || /\s/.test(cmd[i - 1]))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function checkCommand(cmd, branch = null, safetyLevel = SAFETY_LEVEL) {
  const threshold = LEVELS[safetyLevel] || LEVELS.high;
  // bash removes a backslash-newline outright, joining the two lines.
  cmd = cmd.replace(/\\\r?\n/g, '');
  const masked = maskQuotedSeparators(cmd);
  for (const p of PATTERNS) {
    if (LEVELS[p.level] > threshold) continue;
    if (!p.regex.test(p.segment ? masked : cmd)) continue;

    if (p.branchOnly) {
      if (!branch) branch = getCurrentBranch();
      if (!PROTECTED_BRANCHES.includes(branch)) continue;
    }

    const reason = p.reason.replace('{branch}', branch || '');
    return { blocked: true, pattern: p, reason };
  }

  return { blocked: false };
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
      log({ level: 'BLOCKED', id: p.id, priority: p.level, cmd, session_id, cwd, permission_mode });
      return console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${EMOJIS[p.level]} [${p.id}] ${result.reason}`
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
  module.exports = { PATTERNS, PROTECTED_BRANCHES, LEVELS, SAFETY_LEVEL, checkCommand };
}
