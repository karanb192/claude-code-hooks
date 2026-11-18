const fs = require('fs');
const path = require('path');
const host = require('./host');
const { GUARDS, failOpen, guardErrorReason } = require('./dispatch');

async function run(name, mod) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let reason = '';
  let record;
  let data;
  try {
    data = JSON.parse(input);
    const guard = GUARDS.find((g) => g.name === name);
    if (!guard) throw new Error('Unknown guard');
    if (guard.skip?.()) return;
    for (const call of host.codexCalls(data)) {
      if (call.unreadable) { reason = host.UNREADABLE_REASON; record = { id: 'unreadable-patch' }; break; }
      const hit = guard.run(mod, call.tool, call.input, data.cwd, { ...data, hook_host: 'codex', tool_name: call.tool, tool_input: call.input });
      if (!hit) continue;
      reason = `${guard.emojis[hit.level]} ${hit.reason}${hit.ask ? host.ASK_ON_CODEX : ''}`;
      record = { id: hit.id, checked: call.tool, ...hit.log };
      if (!hit.ask) break;
    }
    if (reason) record = { ...record, session_id: data.session_id, tool: data.tool_name, decision: 'deny' };
  } catch (error) {
    record = { level: 'ERROR', error: error.message };
    if (data !== null && typeof data === 'object' && !failOpen()) reason = `🚨 ${guardErrorReason(name, error)}`;
  }
  if (record) {
    try {
      const dir = path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.claude', 'hooks-logs');
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString();
      fs.appendFileSync(path.join(dir, `${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, hook: name, host: 'codex', level: 'BLOCKED', ...record }) + '\n');
    } catch {}
  }
  const answer = host.codexAnswer(reason);
  if (answer.stderr) process.stderr.write(answer.stderr);
  process.exitCode = answer.exitCode;
}

module.exports = { run };
