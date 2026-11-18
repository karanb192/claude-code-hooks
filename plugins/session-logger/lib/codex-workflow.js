const fs = require('fs');
const path = require('path');
const os = require('os');
const { parsePatch } = require('./host');

const home = () => process.env.CODEX_HOME || path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.codex');

function changes(data) {
  if (data.hook_event_name !== 'PostToolUse' || data.tool_name !== 'apply_patch') return [];
  const patch = parsePatch(data.tool_input?.command ?? data.tool_input?.input);
  if (!patch.ok) return [];
  return patch.ops.flatMap((op) => op.moveTo
    ? [{ kind: 'delete', path: op.path }, { kind: 'move', path: op.moveTo }]
    : [{ kind: op.kind, path: op.path }]);
}

function record(hook, data) {
  try {
    const dir = path.join(home(), 'hooks-logs');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(dir, `${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, hook, host: 'codex', ...data }) + '\n');
  } catch {}
}

async function run(name, handle) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const data = JSON.parse(input);
    if (!data || typeof data.cwd !== 'string' || !path.isAbsolute(data.cwd)) return;
    await handle(data);
  } catch (error) {
    record(name, { level: 'ERROR', error: error.message });
  }
}

module.exports = { home, changes, record, run };
