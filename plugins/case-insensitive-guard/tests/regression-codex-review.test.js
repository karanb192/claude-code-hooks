#!/usr/bin/env node
/**
 * Regression tests: xargs record boundaries, which find output is a matched
 * path, and brace lists too large to expand.
 *
 * Run: node --test plugins/case-insensitive-guard/tests/regression-codex-review.test.js
 * Or:  npm test
 *
 * A fake filesystem is injected, so these run the same on every platform.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { analyzeCommand, tokenize } = require('../case-insensitive-guard.js');

// Case-insensitive fake volume: listDir returns entries as stored, lookups fold case.
function makeFsx(dirs, dirPaths) {
  const fold = (p) => p.toLowerCase();
  const dirKey = Object.fromEntries(Object.keys(dirs).map(d => [fold(d), d]));
  const allPaths = new Set();
  for (const [d, entries] of Object.entries(dirs)) {
    allPaths.add(fold(d));
    for (const e of entries) allPaths.add(fold(path.join(d, e)));
  }
  const dirSet = new Set(dirPaths.map(fold));
  return {
    listDir: (d) => dirs[dirKey[fold(d)]] ?? null,
    pathExists: (p) => allPaths.has(fold(p)),
    isDirectory: (p) => dirSet.has(fold(p)),
  };
}

describe('xargs keeps the record boundaries of its input mode', () => {
  const fsx = makeFsx(
    { '/repo': ['Content', 'content Other'], '/repo/Content': [], '/repo/content Other': [] },
    ['/repo', '/repo/Content', '/repo/content Other'],
  );
  const at = (cmd) => analyzeCommand(cmd, '/repo', fsx);

  it('-I takes the whole line: `content Other` is an exact-case entry', () => {
    assert.strictEqual(at('echo content Other | xargs -I{} rm -r {}'), null);
  });
  it('-I on a line that is only the miscased name is still denied', () => {
    assert.strictEqual(at('echo content | xargs -I{} rm -r {}')?.typed, 'content');
  });
  it('the default mode splits on blanks, so `content` is its own argument', () => {
    assert.strictEqual(at('echo content Other | xargs rm -r')?.typed, 'content');
  });
  it('-L still splits on blanks', () => {
    assert.strictEqual(at('echo content Other | xargs -L1 rm -r')?.typed, 'content');
  });
  it('-0 reads one NUL record, trailing newline included', () => {
    assert.strictEqual(at('echo content Other | xargs -0 rm -r'), null);
    assert.strictEqual(at('echo -n content | xargs -0 rm -r')?.typed, 'content');
  });
  it('-d splits on the given character only', () => {
    assert.strictEqual(at('echo -n content Other | xargs -d , rm -r'), null);
    assert.strictEqual(at('echo -n content,Other | xargs -d , rm -r')?.typed, 'content');
  });
});

describe('find feeds a delete only with the matched paths', () => {
  const fsx = makeFsx(
    { '/repo': ['Content', 'Alpha'], '/repo/Content': ['f.txt'] },
    ['/repo', '/repo/Content'],
  );
  const at = (cmd) => analyzeCommand(cmd, '/repo', fsx);

  it('a fixed -printf string is not the search root', () => {
    assert.strictEqual(at('find content -maxdepth 0 -printf /repo/Alpha | xargs -0 rm'), null);
  });
  it('a fixed -fprint target writes nothing to the pipe', () => {
    assert.strictEqual(at('find content -fprint list.txt | xargs rm'), null);
  });
  it('-exec rm without {} does not delete the matched paths', () => {
    assert.strictEqual(at('find content -maxdepth 0 -exec rm /repo/Alpha \\;'), null);
  });
  it('outputs that are the matched paths are still denied', () => {
    for (const cmd of [
      'find content -type f | xargs rm',
      'find content -print0 | xargs -0 rm',
      "find content -printf '%p\\n' | xargs rm",
      'find content -exec echo {} \\; | xargs rm',
      'find content -exec rm {} \\;',
      'find content -exec /bin/rm -rf {} +',
      'find content -delete',
    ]) assert.strictEqual(at(cmd)?.actual, 'Content', JSON.stringify(cmd));
  });
});

describe('a brace list past the expansion limit is unresolvable, not truncated', () => {
  const fsx = makeFsx({ '/repo': ['Content'], '/repo/Content': [] }, ['/repo', '/repo/Content']);
  const at = (cmd) => analyzeCommand(cmd, '/repo', fsx);
  const alts = (n, last) => '{' + [...Array.from({ length: n - 1 }, (_, i) => `x${i}`), last].join(',') + '}';

  it('64 words expand in full, so the last one is checked', () => {
    assert.strictEqual(at(`rm -rf ${alts(64, 'content')}`)?.typed, 'content');
  });
  it('65 words become one unresolvable token instead of the first 64', () => {
    const toks = tokenize(`rm -rf ${alts(65, 'content')}`);
    assert.strictEqual(toks.length, 3);
    assert.strictEqual(toks[2].unresolvable, true);
    assert.strictEqual(at(`rm -rf ${alts(65, 'content')}`), null);
  });
  it('nested lists that multiply past the limit are unresolvable too', () => {
    assert.strictEqual(tokenize('rm {a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}x')[1].unresolvable, true);
  });
  it('operands after an overflowed word are still checked', () => {
    assert.strictEqual(at(`rm -rf ${alts(65, 'y')} content`)?.typed, 'content');
  });
});
