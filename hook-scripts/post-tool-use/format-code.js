#!/usr/bin/env node
/**
 * Format Code - PostToolUse Hook for Write|Edit
 * Auto-formats files after Claude Code modifies them.
 * Supports Python (ruff) and Markdown/YAML/JSON (prettier).
 * Logs to: ~/.claude/hooks-logs/
 *
 * Benefits:
 *   - No manual formatting needed after Claude edits files
 *   - Consistent code style across AI-generated changes
 *   - Supports Python and common config/documentation formats
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "Write|Edit",
 *       "hooks": [{ "type": "command", "command": "node /path/to/format-code.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOG_DIR = path.join(process.env.HOME, '.claude', 'hooks-logs');

const FORMATTERS = {
  '.py': {
    name: 'ruff',
    commands: (fp) => [
      ['uv', 'run', 'ruff', 'check', '--fix', '--exit-zero', '--quiet', fp],
      ['uv', 'run', 'ruff', 'format', '--quiet', fp],
    ],
  },
  '.md':    { name: 'prettier', commands: (fp) => [['npx', '--yes', 'prettier', '--write', fp]] },
  '.yaml':  { name: 'prettier', commands: (fp) => [['npx', '--yes', 'prettier', '--write', fp]] },
  '.yml':   { name: 'prettier', commands: (fp) => [['npx', '--yes', 'prettier', '--write', fp]] },
  '.json':  { name: 'prettier', commands: (fp) => [['npx', '--yes', 'prettier', '--write', fp]] },
};

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'format-code', ...data }) + '\n');
  } catch {}
}

function getFormatter(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return FORMATTERS[ext] || null;
}

function formatFile(filePath, cwd, sessionId) {
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd || process.cwd(), filePath);

  if (!fs.existsSync(absPath)) {
    log({ level: 'SKIP', reason: 'file not found', file: absPath, session_id: sessionId });
    return { success: false, error: 'file not found' };
  }

  const formatter = getFormatter(absPath);
  if (!formatter) {
    log({ level: 'SKIP', reason: 'unsupported file type', file: absPath, session_id: sessionId });
    return { success: false, error: 'unsupported file type' };
  }

  const dir = path.dirname(absPath);

  for (const args of formatter.commands(absPath)) {
    try {
      const result = spawnSync(args[0], args.slice(1), { cwd: dir, stdio: 'pipe' });
      if (result.status !== 0) {
        const msg = result.stderr?.toString()?.trim() || `Process exited with code ${result.status}`;
        log({ level: 'ERROR', formatter: formatter.name, file: absPath, error: msg, session_id: sessionId });
        return { success: false, error: msg, formatter: formatter.name };
      }
    } catch (e) {
      const msg = e.message;
      log({ level: 'ERROR', formatter: formatter.name, file: absPath, error: msg, session_id: sessionId });
      return { success: false, error: msg, formatter: formatter.name };
    }
  }

  log({ level: 'FORMATTED', formatter: formatter.name, file: absPath, session_id: sessionId });
  return { success: true, formatter: formatter.name };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const { tool_name, tool_input, session_id, cwd } = data;

    if (!['Write', 'Edit'].includes(tool_name)) {
      return console.log('{}');
    }

    const workDir = cwd || process.cwd();

    if (!tool_input?.file_path) {
      log({ level: 'SKIP', reason: 'no file_path', tool: tool_name, session_id });
      return console.log('{}');
    }

    const files = [tool_input.file_path];

    for (const file of files) {
      formatFile(file, workDir, session_id);
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
  module.exports = { getFormatter, formatFile, log, FORMATTERS };
}
