#!/usr/bin/env node
/**
 * Git Safety - PreToolUse Hook for Bash
 * Blocks destructive git and gh CLI operations. Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict'
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
 * Setup in .claude/settings.json:
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

const SAFETY_LEVEL = 'high';

const PROTECTED_BRANCHES = ['main', 'master'];

const PATTERNS = [
  // STRICT - force-push is normally handled by block-dangerous-commands.js.
  // Only enforced here at 'strict' so git-safety is self-sufficient standalone.
  { level: 'strict', id: 'force-push',              regex: /\bgit\s+push\b.*(?:--force(?!-with-lease)|-f)\b/, reason: 'Force-pushing is not allowed' },

  // HIGH - complementary coverage the sibling hook does not provide

  // Block pushing directly to a protected branch by name
  { level: 'high', id: 'push-main',                 regex: /\bgit\s+push\b.*\bmain\b/,                        reason: 'Pushing to main is not allowed' },
  { level: 'high', id: 'push-master',               regex: /\bgit\s+push\b.*\bmaster\b/,                      reason: 'Pushing to master is not allowed' },

  // Block deleting protected branches locally
  { level: 'high', id: 'branch-delete-protected',   regex: /\bgit\s+branch\s+.*(?:-[dD]|--delete)\s+(?:main|master)\b/, reason: 'Deleting a protected branch is not allowed' },

  // Block direct changes when on a protected branch
  { level: 'high', id: 'commit-on-protected',       regex: /\bgit\s+commit\b/,                                reason: 'Committing directly on {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'merge-on-protected',        regex: /\bgit\s+merge\b/,                                 reason: 'Merging into {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'rebase-on-protected',       regex: /\bgit\s+rebase\b/,                                reason: 'Rebasing {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'reset-on-protected',        regex: /\bgit\s+reset\b/,                                 reason: 'Resetting {branch} is not allowed', branchOnly: true },
  { level: 'high', id: 'push-on-protected',         regex: /\bgit\s+push\b/,                                  reason: 'Pushing from {branch} is not allowed', branchOnly: true },

  // Block destructive gh CLI operations
  { level: 'high', id: 'gh-pr-merge',               regex: /\bgh\s+pr\s+merge\b/,                             reason: 'Merging PRs via gh CLI is not allowed' },
  { level: 'high', id: 'gh-pr-close',               regex: /\bgh\s+pr\s+close\b/,                             reason: 'Closing PRs via gh CLI is not allowed' },
  { level: 'high', id: 'gh-issue-close',            regex: /\bgh\s+issue\s+close\b/,                          reason: 'Closing issues via gh CLI is not allowed' },
  { level: 'high', id: 'gh-release-delete',         regex: /\bgh\s+release\s+delete\b/,                       reason: 'Deleting releases via gh CLI is not allowed' },
  { level: 'high', id: 'gh-repo-delete',            regex: /\bgh\s+repo\s+delete\b/,                          reason: 'Deleting repos via gh CLI is not allowed' },
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

function getCurrentBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function checkCommand(cmd, branch = null, safetyLevel = SAFETY_LEVEL) {
  const threshold = LEVELS[safetyLevel] || LEVELS.high;
  for (const p of PATTERNS) {
    if (LEVELS[p.level] > threshold) continue;
    if (!p.regex.test(cmd)) continue;

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
