#!/usr/bin/env node
/**
 * Format Code - PostToolUse Hook for Write|Edit
 * Auto-formats files after Claude Code modifies them.
 * Supports Python (ruff) and Markdown/YAML/JSON (prettier).
 * Logs to: ~/.claude/hooks-logs/
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

const PRETTIER_EXTS = new Set(['.js', '.ts', '.json', '.md', '.yaml', '.yml', '.html']);

const FORMATTERS = {
  '.py': (fp) => [
    ['uv', 'run', 'ruff', 'check', '--fix', '--exit-zero', '--quiet', fp],
    ['uv', 'run', 'ruff', 'format', '--quiet', fp],
  ],
};

for (const ext of PRETTIER_EXTS) {
  FORMATTERS[ext] = (fp) => [['npx', '--yes', 'prettier', '--write', fp]];
}

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
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);

  if (!fs.existsSync(absPath)) {
    log({ level: 'SKIP', reason: 'file not found', file: absPath, session_id: sessionId });
    return { success: false, error: 'file not found' };
  }

  const ext = path.extname(absPath).toLowerCase();
  const getCommands = FORMATTERS[ext];
  if (!getCommands) {
    log({ level: 'SKIP', reason: 'unsupported file type', file: absPath, session_id: sessionId });
    return { success: false, error: 'unsupported file type' };
  }

  const formatterName = PRETTIER_EXTS.has(ext) ? 'prettier' : 'ruff';
  const dir = path.dirname(absPath);

  for (const args of getCommands(absPath)) {
    try {
      const result = spawnSync(args[0], args.slice(1), { cwd: dir, stdio: 'pipe' });
      if (result.status !== 0) {
        const msg = result.stderr?.toString().trim() || `Process exited with code ${result.status}`;
        log({ level: 'ERROR', formatter: formatterName, file: absPath, error: msg, session_id: sessionId });
        return { success: false, error: msg, formatter: formatterName };
      }
    } catch (e) {
      log({ level: 'ERROR', formatter: formatterName, file: absPath, error: e.message, session_id: sessionId });
      return { success: false, error: e.message, formatter: formatterName };
    }
  }

  log({ level: 'FORMATTED', formatter: formatterName, file: absPath, session_id: sessionId });
  return { success: true, formatter: formatterName };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    return console.log('{}');
  }

  const { tool_name, tool_input, session_id, cwd } = data;

  if (!['Write', 'Edit'].includes(tool_name) || !tool_input?.file_path) {
    return console.log('{}');
  }

  formatFile(tool_input.file_path, cwd || process.cwd(), session_id);
  console.log('{}');
}

if (require.main === module) {
  main();
} else {
  module.exports = { getFormatter, formatFile, log, FORMATTERS };
}
