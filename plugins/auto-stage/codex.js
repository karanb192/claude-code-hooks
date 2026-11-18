#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { changes, record, run } = require('./lib/codex-workflow');

const gitArgs = ['-c', 'safe.bareRepository=explicit', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, '--literal-pathspecs'];
function git(dir, args) {
  return execFileSync('git', [...gitArgs, ...args], { cwd: dir, encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
}

function stage(file, root, filters) {
  // Deleting the last file can also remove its parent directory.
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  if (fs.existsSync(file) && fs.lstatSync(file).isDirectory()) throw new Error('Refusing to stage a directory');
  if (fs.realpathSync(git(dir, ['rev-parse', '--show-toplevel']).trim()) !== root) throw new Error('Refusing to stage a different repository');
  const filter = git(root, ['check-attr', '-z', 'filter', '--', file]).split('\0')[2];
  if (filter !== 'unspecified' && filter !== 'unset') throw new Error('Filtered files require manual staging');
  // Disable configured drivers too: attributes can change between inspection and add.
  git(root, [...filters, 'add', '--', file]);
}

run('auto-stage', (data) => {
  const files = new Set(changes(data).map((change) => path.resolve(data.cwd, change.path)));
  if (!files.size) return;
  const root = fs.realpathSync(git(data.cwd, ['rev-parse', '--show-toplevel']).trim());
  let keys;
  try {
    keys = git(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process)$']);
  } catch (error) {
    if (error.status !== 1) throw error;
    keys = '';
  }
  const filters = keys.split('\0').filter(Boolean).flatMap((key) => ['-c', `${key}=`]);
  for (const file of files) {
    try {
      stage(file, root, filters);
      record('auto-stage', { level: 'STAGED', file, session_id: data.session_id });
    } catch (error) {
      record('auto-stage', { level: 'ERROR', file, error: error.message, session_id: data.session_id });
    }
  }
});
