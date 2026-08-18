#!/usr/bin/env node
/**
 * Config Watch - ConfigChange Hook
 * Detects configuration changes that land mid-session from OUTSIDE the
 * agent's own tool calls: an installer script, an npm postinstall payload
 * (the CHAINDROP worm hid in .claude/settings.json exactly this way), or
 * any other process rewriting settings while Claude Code is running.
 * Pairs with config-guard.js (PreToolUse), which blocks the agent's own
 * writes; this hook covers the out-of-band path.
 * Logs to: ~/.claude/hooks-logs/
 *
 * What the docs guarantee (and what they do not): the hooks reference
 * documents that ConfigChange CAN block - exit code 2 stops the change from
 * taking effect, except for policy_settings - but it does not document the
 * event's input payload schema. This hook therefore reads the payload
 * defensively (source / config_source / matcher, file_path / path when
 * present) and logs the raw payload so you can inspect what your Claude
 * Code version actually sends (utils/event-logger.py helps too).
 *
 * Modes:
 *   warn (default)          - emits a systemMessage so the change is visible
 *                             in the session instead of sliding by silently
 *   CONFIG_WATCH_BLOCK=true - exits 2 to stop the change from taking effect;
 *                             policy_settings cannot be blocked by hooks, so
 *                             those still warn
 *
 * Note: ConfigChange also fires for changes YOU make (e.g. /config, editing
 * settings in your editor), so block mode is opt-in for hardened setups;
 * the default keeps legitimate workflows friction-free while making every
 * mid-session config change loudly visible.
 *
 * Install as a plugin (recommended): /plugin install config-watch@claude-code-hooks
 *
 * Or wire it up the classic way in .claude/settings.json:
 * {
 *   "hooks": {
 *     "ConfigChange": [{
 *       "matcher": "user_settings|project_settings|local_settings|policy_settings|skills",
 *       "hooks": [{ "type": "command", "command": "node /path/to/config-watch.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const envBool = (key, fallback) => key in process.env ? process.env[key] === 'true' : fallback;
const BLOCK_MODE = envBool('CONFIG_WATCH_BLOCK', false);

const LOG_DIR = path.join(process.env.HOME || '/tmp', '.claude', 'hooks-logs');

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'config-watch', ...data }) + '\n');
  } catch {}
}

// Pure decision function - unit-testable.
// Returns { action: 'pass' | 'warn' | 'block', source, message }.
function evaluate(data, blockMode = BLOCK_MODE) {
  if (!data || data.hook_event_name !== 'ConfigChange') return { action: 'pass' };

  // Payload schema is undocumented; accept the plausible field names.
  const source = data.source || data.config_source || data.matcher || 'unknown source';
  const file = data.file_path || data.path || data.settings_path || '';
  const where = file ? ` (${file})` : '';
  const message =
    `Configuration changed mid-session: ${source}${where}. ` +
    'If you did not make this change yourself, inspect the file before continuing: ' +
    'malware has used out-of-band settings.json writes to install persistent hooks.';

  if (blockMode && source !== 'policy_settings') {
    return { action: 'block', source, message };
  }
  return { action: 'warn', source, message };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const result = evaluate(data);

    // Keep a raw copy of the payload: the schema is undocumented, so the log
    // doubles as discovery of what this Claude Code version sends.
    log({ level: result.action.toUpperCase(), source: result.source, payload: data });

    if (result.action === 'block') {
      process.stderr.write(`🔭 config-watch: ${result.message}\n`);
      process.exit(2);
    }
    if (result.action === 'warn') {
      return console.log(JSON.stringify({ systemMessage: `🔭 config-watch: ${result.message}` }));
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
  module.exports = { evaluate };
}
