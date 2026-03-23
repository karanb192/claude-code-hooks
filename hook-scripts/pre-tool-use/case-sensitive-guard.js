#!/usr/bin/env node
/**
 * Case-Insensitive Filesystem Guard - PreToolUse Hook for Bash
 * Detects case-insensitive filesystems (exFAT, NTFS, HFS+ case-insensitive)
 * and blocks rm/mkdir that would collide due to case folding.
 *
 * Real incident: GitHub #37875 — Claude created "Content" dir on exFAT drive
 * where "content" already existed. Both resolved to the same path. Claude then
 * ran rm -rf on "content", destroying all user data.
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/case-sensitive-guard.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const command = data?.tool_input?.command;
    if (!command) process.exit(0);

    // Only check mkdir and rm commands
    const mkdirMatch = command.match(/^\s*mkdir\s+(?:-p\s+)?(\S+)/);
    const rmMatch = command.match(/^\s*rm\s+(?:-[rf]+\s+)*(\S+)/);

    const target = mkdirMatch?.[1] || rmMatch?.[1];
    if (!target) process.exit(0);

    const parentDir = path.dirname(target);
    const baseName = path.basename(target);

    if (!fs.existsSync(parentDir)) process.exit(0);

    // Test if filesystem is case-insensitive
    const testFile = path.join(parentDir, `.cc_case_test_${process.pid}`);
    const testUpper = path.join(parentDir, `.CC_CASE_TEST_${process.pid}`);

    try {
      fs.writeFileSync(testFile, '');
      const isCaseInsensitive = fs.existsSync(testUpper);
      fs.unlinkSync(testFile);

      if (!isCaseInsensitive) process.exit(0);
    } catch {
      process.exit(0); // Can't test, assume safe
    }

    // Case-insensitive FS detected — check for collisions
    const entries = fs.readdirSync(parentDir);
    const baseNameLower = baseName.toLowerCase();

    for (const entry of entries) {
      if (entry.toLowerCase() === baseNameLower && entry !== baseName) {
        const isRm = rmMatch !== null;
        if (isRm) {
          process.stderr.write(
            `BLOCKED: Case-insensitive filesystem collision detected.\n` +
            `\nCommand: ${command}\n` +
            `\nTarget: ${target}\n` +
            `Collides with: ${path.join(parentDir, entry)}\n` +
            `\nThis filesystem is case-insensitive (exFAT, NTFS, HFS+).\n` +
            `'${baseName}' and '${entry}' resolve to the SAME path.\n` +
            `rm would destroy the data you think you're keeping.\n`
          );
          process.exit(2);
        } else {
          process.stderr.write(
            `WARNING: Case-insensitive filesystem — directory already exists.\n` +
            `\nCommand: ${command}\n` +
            `Existing: ${path.join(parentDir, entry)}\n` +
            `\nOn this filesystem, '${baseName}' and '${entry}' are the same path.\n`
          );
          process.exit(2);
        }
      }
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
});
