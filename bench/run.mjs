#!/usr/bin/env node
// Hook latency benchmark. Times each PreToolUse/PostToolUse hook in
// hook-scripts/ end-to-end: fresh Node process per invocation, realistic
// event JSON on stdin, verdict read from stdout. See bench/README.md.
//
// Usage: node bench/run.mjs [--n=20] [--write]

import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = Number((process.argv.find(a => a.startsWith('--n=')) || '--n=20').slice(4));
const WRITE = process.argv.includes('--write');

// Sandbox HOME so hook logs (~/.claude/hooks-logs) never touch the real home,
// plus a throwaway git repo so auto-stage exercises its real staging path.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-bench-'));
const repoDir = path.join(sandbox, 'repo');
fs.mkdirSync(repoDir);
execSync('git init -q && git config user.email bench@bench && git config user.name bench', { cwd: repoDir });
const stagedFile = path.join(repoDir, 'file.js');
fs.writeFileSync(stagedFile, 'console.log("bench");\n');

const base = { session_id: 'bench-session', cwd: repoDir, permission_mode: 'default' };

// One benign payload per hook, shaped like the hook's own test fixtures.
// Each must take the clean allow path (exit 0, no deny/ask in the verdict).
const HOOKS = [
  {
    script: 'hook-scripts/pre-tool-use/block-dangerous-commands.js',
    payload: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'git status && ls -la src/' } },
  },
  {
    script: 'hook-scripts/pre-tool-use/protect-secrets.js',
    payload: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read',
      tool_input: { file_path: path.join(repoDir, 'src', 'index.js') } },
  },
  {
    script: 'hook-scripts/post-tool-use/auto-stage.js',
    payload: { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write',
      tool_input: { file_path: stagedFile, content: 'console.log("bench");\n' } },
  },
];

function invoke(hook) {
  const t0 = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [path.join(ROOT, hook.script)], {
    input: JSON.stringify(hook.payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: sandbox },
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (res.status !== 0) throw new Error(`${hook.script} exited ${res.status}: ${res.stderr}`);
  const verdict = JSON.parse(res.stdout);
  const decision = verdict.hookSpecificOutput?.permissionDecision;
  if (decision) throw new Error(`${hook.script} returned "${decision}" for a benign payload`);
  return ms;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    min: s[0],
    max: s[s.length - 1],
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
}

const rows = [];
for (const hook of HOOKS) {
  invoke(hook); // warm-up, discarded
  const samples = [];
  for (let i = 0; i < N; i++) samples.push(invoke(hook));
  rows.push({ name: path.basename(hook.script), ...stats(samples) });
}
fs.rmSync(sandbox, { recursive: true, force: true });

const fmt = v => v.toFixed(1);
const table = [
  '| Hook | Median (ms) | Min | Max | Mean |',
  '|------|------------:|----:|----:|-----:|',
  ...rows.map(r => `| ${r.name} | ${fmt(r.median)} | ${fmt(r.min)} | ${fmt(r.max)} | ${fmt(r.mean)} |`),
].join('\n');

console.log(table);

if (WRITE) {
  const doc = `# Hook latency results

- Machine: ${os.cpus()[0].model} (${os.platform()} ${os.arch()})
- Node: ${process.version}
- Date: ${new Date().toISOString().slice(0, 10)}
- Samples: 1 warm-up (discarded) + N=${N} per hook, fresh process per invocation

${table}

Single-machine spot measurement. Numbers are dominated by Node interpreter
startup, not hook logic; treat them as an upper bound on per-call overhead,
not a cross-machine latency ladder.

Reproduce: \`node bench/run.mjs --n=${N} --write\`
`;
  fs.writeFileSync(path.join(ROOT, 'bench', 'RESULTS.md'), doc);
  console.log('\nWrote bench/RESULTS.md');
}
