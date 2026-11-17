#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { redactSecrets, withLock, gitInfo } = require('./session-logger');
const { home, changes, record, run } = require('./lib/codex-workflow');

run('session-logger', (data) => {
  if (typeof data.session_id !== 'string' || !data.session_id) return;
  const event = data.hook_event_name;
  const entries = [];
  if (event === 'SessionStart') entries.push(`Session started or resumed (${data.source || 'unknown'}).`);
  else if (event === 'SessionEnd') entries.push('Session ended.');
  else if (event === 'PostToolUse') {
    if (data.tool_name === 'Bash' && typeof data.tool_input?.command === 'string') {
      const value = Number(process.env.CC_SESSION_BASH_TRUNCATE);
      const limit = Number.isInteger(value) && value > 0 ? value : 200;
      const command = redactSecrets(data.tool_input.command.split('\n')[0]);
      entries.push(`command ${JSON.stringify(command.slice(0, limit))}${command.length > limit ? '…' : ''}`);
    } else {
      for (const c of changes(data)) entries.push(`${c.kind} ${JSON.stringify(c.path)}`);
    }
  }
  if (!entries.length) return;
  const dir = process.env.CC_SESSION_LOG_DIR || path.join(home(), 'session-notes');
  fs.mkdirSync(dir, { recursive: true });
  // Codex IDs share a time prefix. Hash the full ID, never its first eight characters.
  const key = createHash('sha256').update(data.session_id).digest('hex');
  const file = path.join(dir, `codex-${key}.md`);
  const ts = new Date().toISOString();
  withLock(file, () => {
    const header = fs.existsSync(file) ? '' : [
      '# Codex Session', '',
      `Session: ${JSON.stringify(data.session_id)}`,
      `Working directory: ${JSON.stringify(data.cwd)}`,
      `Git branch: ${JSON.stringify(gitInfo(data.cwd).branch)}`, '', '## Activity', '',
    ].join('\n');
    fs.appendFileSync(file, header + entries.map((entry) => `- ${ts} ${entry}\n`).join(''));
  }, { failOnTimeout: true });
  record('session-logger', { level: 'APPEND', event, session_id: data.session_id, file });
});
