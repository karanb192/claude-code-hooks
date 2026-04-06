#!/usr/bin/env node
/**
 * Branch Protection - PreToolUse Hook for Bash
 * Blocks destructive git operations on main/master branches.
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/branch-protection.js" }]
 *     }]
 *   }
 * }
 */

const PATTERNS = [
    { id: 'push-main',         regex: /\bgit\s+push\b.*\bmain\b/,                     reason: 'Pushing to main is not allowed' },
    { id: 'push-master',       regex: /\bgit\s+push\b.*\bmaster\b/,                   reason: 'Pushing to master is not allowed' },
    { id: 'force-push',        regex: /\bgit\s+push\b.*(?:--force|-f)\b/,             reason: 'Force-pushing is not allowed' },
    { id: 'gh-pr-merge',       regex: /\bgh\s+pr\s+merge\b/,                          reason: 'Merging PRs via gh CLI is not allowed' },
];

async function main() {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;

    try {
        const data = JSON.parse(input);
        if (data.tool_name !== 'Bash') return console.log('{}');

        const cmd = data.tool_input?.command || '';

        for (const p of PATTERNS) {
            if (p.regex.test(cmd)) {
                return console.log(JSON.stringify({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        permissionDecision: 'deny',
                        permissionDecisionReason: `⛔ [${p.id}] ${p.reason}`
                    }
                }));
            }
        }

        console.log('{}');
    } catch (e) {
        console.log('{}');
    }
}

main();
