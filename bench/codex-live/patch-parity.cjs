#!/usr/bin/env node
// Differential check of guard-pack's patch reader against Codex's own.
//
// Codex ships its patch engine inside the codex binary and runs it when the
// binary is invoked as apply_patch. This script applies random patches (valid
// ones plus odd whitespace and stray lines) with that engine in a temp folder
// and compares the files it actually changed with what lib/host.js read:
//   missed  = Codex changed a file the reader did not name (a guard bypass)
//   refused = the reader refused a patch Codex applied (a false block)
// Both must be 0. No model calls; needs codex on PATH.
//
//   node bench/codex-live/patch-parity.cjs [count]

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const host = require('../../plugins/guard-pack/lib/host.js');

const n = Number(process.argv[2] || 1000);
const codex = fs.realpathSync(execFileSync('which', ['codex'], { encoding: 'utf8' }).trim());
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-parity-bin-'));
const applyPatch = path.join(bin, 'apply_patch');
fs.symlinkSync(codex, applyPatch);

const WS = ['', ' ', '  ', '\t', '\u0085', ' ', ' ', '﻿', '\r'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const noise = () => {
  const w = pick(WS);
  return pick([`${w}*** Add File: x.txt`, '+line', `${w}*** Update File: base.txt`, '@@', '-old', '+new', ' keep', `${w}*** End Patch`,
    `${w}*** Move to: moved.txt`, `${w}*** End of File`, '', `${w}*** Environment ID: local`, 'junk']);
};
const hunks = [
  (i) => [`${pick(WS)}*** Add File: f${i % 5}.txt${pick(WS)}`, '+a', ...(Math.random() < 0.5 ? ['+b'] : [])],
  () => [`${pick(WS)}*** Add File: .env.production`, '+K=1'],
  () => [`${pick(WS)}*** Delete File: del.txt${pick(WS)}`],
  () => [`${pick(WS)}*** Update File: base.txt${pick(WS)}`, ...(Math.random() < 0.3 ? ['*** Move to: moved.txt'] : []), pick(['@@', '@@ ctx', '']),
    ...(Math.random() < 0.5 ? [' keep'] : []), '-old', '+new', ...(Math.random() < 0.3 ? ['*** End of File'] : [])],
];

let applied = 0;
const missed = [];
const refused = [];
try {
  for (let i = 0; i < n; i++) {
    const body = [];
    for (let k = 0; k < 1 + Math.floor(Math.random() * 3); k++) body.push(...pick(hunks)(i));
    for (let k = 0; k < Math.floor(Math.random() * 2); k++) body.splice(Math.floor(Math.random() * (body.length + 1)), 0, noise());
    const patch = [pick(['*** Begin Patch', ' *** Begin Patch', '*** Begin Patch ']), ...body,
      pick(['*** End Patch', ' *** End Patch', '*** End Patch\n', '\u0085*** End Patch'])].join('\n');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-parity-'));
    fs.writeFileSync(path.join(dir, 'base.txt'), 'old\nkeep\nctx\n');
    fs.writeFileSync(path.join(dir, 'del.txt'), 'd\n');
    const snap = () => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    const before = snap();
    const r = spawnSync(applyPatch, [patch], { cwd: dir, encoding: 'utf8' });
    const after = snap();
    fs.rmSync(dir, { recursive: true, force: true });
    const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]);
    if (r.status === 0) applied++;

    const parsed = host.parsePatch(patch);
    if (!parsed.ok) { if (r.status === 0) refused.push(patch); continue; }
    const named = new Set(parsed.ops.flatMap((o) => [o.path, o.moveTo].filter(Boolean)));
    const unseen = touched.filter((f) => !named.has(f));
    if (unseen.length) missed.push({ patch, unseen });
  }
} finally {
  fs.rmSync(bin, { recursive: true, force: true });
}

console.log(`${execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim()}: ${n} patches, ${applied} applied by Codex, missed ${missed.length}, refused ${refused.length}`);
for (const m of missed.slice(0, 5)) console.log('MISSED', JSON.stringify(m));
for (const p of refused.slice(0, 5)) console.log('REFUSED', JSON.stringify(p));
process.exitCode = missed.length || refused.length ? 1 : 0;
