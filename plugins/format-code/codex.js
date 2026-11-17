#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { changes, record, run } = require('./lib/codex-workflow');

const prettier = new Set(['.js', '.ts', '.json', '.md', '.yaml', '.yml', '.html']);

run('format-code', (data) => {
  const files = new Set(changes(data).filter((c) => c.kind !== 'delete').map((c) => path.resolve(data.cwd, c.path)));
  for (const file of files) {
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      const ext = path.extname(file).toLowerCase();
      const commands = ext === '.py'
        ? [['ruff', 'check', '--fix', '--exit-zero', '--quiet', file], ['ruff', 'format', '--quiet', file]]
        : prettier.has(ext) ? [['prettier', '--write', file]] : [];
      for (const [command, ...args] of commands) {
        const result = spawnSync(command, args, { cwd: path.dirname(file), encoding: 'utf8', timeout: 10000 });
        if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} exited ${result.status}`);
      }
      if (commands.length) record('format-code', { level: 'FORMATTED', file, session_id: data.session_id });
    } catch (error) {
      record('format-code', { level: 'ERROR', file, error: error.message, session_id: data.session_id });
    }
  }
});
