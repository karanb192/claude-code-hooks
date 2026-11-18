#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { changes, record, run } = require('./lib/codex-workflow');

const prettier = new Set(['.js', '.ts', '.json', '.md', '.yaml', '.yml', '.html']);

function projectSettings(file, python) {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const names = fs.readdirSync(dir);
    const config = names.find((name) => python
      ? ['ruff.toml', '.ruff.toml', 'pyproject.toml'].includes(name)
      : /^(?:\.prettierrc(?:\..+)?|prettier\.config\..+|\.editorconfig|\.prettierignore)$/.test(name));
    if (config) return path.join(dir, config);
    if (!python && names.includes('package.json')) {
      const candidate = path.join(dir, 'package.json');
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.size > 1024 * 1024) return candidate;
      const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (pkg && Object.hasOwn(pkg, 'prettier')) return candidate;
    }
    if (names.includes('.git') || path.dirname(dir) === dir) return null;
  }
}

run('format-code', (data) => {
  const files = new Set(changes(data).filter((c) => c.kind !== 'delete').map((c) => path.resolve(data.cwd, c.path)));
  let prettierVersion;
  for (const file of files) {
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      const ext = path.extname(file).toLowerCase();
      if (ext !== '.py' && !prettier.has(ext)) continue;
      const config = projectSettings(file, ext === '.py');
      if (config) {
        record('format-code', { level: 'SKIP', file, reason: 'Project formatter settings require a sandboxed formatter command', config, session_id: data.session_id });
        continue;
      }
      if (prettier.has(ext)) {
        if (!prettierVersion) prettierVersion = spawnSync('prettier', ['--version'], { cwd: __dirname, encoding: 'utf8', timeout: 10000 });
        if (prettierVersion.status !== 0 || !/^3\.\d+\.\d+$/.test(prettierVersion.stdout.trim())) throw new Error('Codex formatting requires Prettier 3 on PATH');
      }
      // Hooks run outside the agent sandbox. Never load workspace config or plugins.
      const commands = ext === '.py'
        ? [['ruff', 'format', '--isolated', '--no-cache', '--quiet', file]]
        : prettier.has(ext) ? [['prettier', '--no-config', '--no-editorconfig', '--write', file]] : [];
      for (const [command, ...args] of commands) {
        const result = spawnSync(command, args, { cwd: __dirname, encoding: 'utf8', timeout: 10000 });
        if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} exited ${result.status}`);
      }
      if (commands.length) record('format-code', { level: 'FORMATTED', file, session_id: data.session_id });
    } catch (error) {
      record('format-code', { level: 'ERROR', file, error: error.message, session_id: data.session_id });
    }
  }
});
