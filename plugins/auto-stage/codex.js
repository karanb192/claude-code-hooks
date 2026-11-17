#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { changes, record, run } = require('./lib/codex-workflow');

function stage(file) {
  // Deleting the last file can also remove its parent directory.
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  if (fs.existsSync(file) && fs.lstatSync(file).isDirectory()) throw new Error('Refusing to stage a directory');
  execFileSync('git', ['--literal-pathspecs', 'add', '--', file], { cwd: dir, stdio: 'pipe', timeout: 10000 });
}

run('auto-stage', (data) => {
  const files = new Set(changes(data).map((change) => path.resolve(data.cwd, change.path)));
  for (const file of files) {
    try {
      stage(file);
      record('auto-stage', { level: 'STAGED', file, session_id: data.session_id });
    } catch (error) {
      record('auto-stage', { level: 'ERROR', file, error: error.message, session_id: data.session_id });
    }
  }
});
