const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkTool } = require('../protect-tests.js');

test('literal grep and Perl redirects compare produced content, not search expressions', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-producers-'));
  const check = command => checkTool('Bash', { command }, 'high', cwd).blocked;
  try {
    const target = path.join(cwd, 'fixed.test.js');
    const source = path.join(cwd, 'source.test.js');
    fs.writeFileSync(target, "test('original', () => {});\n");
    const cases = [
      ["grep 'test.skip('", "test.skip('a');\ntest('b');\n", true],
      ["grep -F 'test.skip('", "testXskip('a');\ntest.skip('b');\n", true],
      ["grep -v 'test.skip('", "test.skip('a');\ntest('b');\n", false],
      ["grep -vF 'test.skip('", "test.skip('a');\ntest('b');\n", false],
      ["grep -F -v 'test.skip('", "testXskip('a');\ntest.skip('b');\nit.skip('c');\n", true],
      ["grep -v 'test.skip('", "test.skip('a');\nit.skip('other');", true],
      ["perl -pe 's/test\\.skip\\(/test(/'", "test.skip('a');\ntest.skip('b');\n", false],
      ["perl -pe 's/test\\.skip\\(/test(/'", "test.skip('a');test.skip('b');\n", true],
      ["perl -pe 's/test\\.skip\\(/test(/g'", "test.skip('a');test.skip('b');\n", false],
      ["perl -pe 's/test\\.skip\\(/test(/g'", "test.skip('a');\nit.skip('other');\n", true],
    ];
    for (const [producer, input, expected] of cases) {
      fs.writeFileSync(source, input);
      const command = producer + ' source.test.js > fixed.test.js';
      assert.equal(check(command), expected, command);
      assert.equal(fs.readFileSync(source, 'utf8'), input);
      assert.equal(fs.readFileSync(target, 'utf8'), "test('original', () => {});\n");
    }
    for (const input of ["test.skip('a'); // 😀\n", "test.skip('a');\0\n"]) {
      fs.writeFileSync(source, input);
      for (const producer of ["sed 's/test.skip(/test(/g'", "grep -v 'test.skip('", "perl -pe 's/test\\.skip\\(/test(/'"]) {
        assert.equal(check(producer + ' source.test.js > fixed.test.js'), true, producer);
      }
    }
    fs.writeFileSync(source, "test.skip('a');\n");
    for (const [producer, expected] of [["grep -E -v 'test.skip('", true], ["grep -v 'test.*skip('", false]])
      assert.equal(check(producer + ' source.test.js > fixed.test.js'), expected, producer);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('Perl magic-open filename whitespace never changes which source is analyzed', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-perl-path-'));
  try {
    fs.writeFileSync(path.join(cwd, 'input.js'), "it.skip('other', () => {});\n");
    fs.writeFileSync(path.join(cwd, 'fixed.test.js'), "test('a', () => {});\n");
    for (const file of ['input.js ', ' input.js']) {
      fs.writeFileSync(path.join(cwd, file), "test('a', () => {});\n");
      const command = `perl -pe 's/test\\.skip\\(/test(/' '${file}' > fixed.test.js`;
      assert.equal(checkTool('Bash', { command }, 'high', cwd).blocked, true, command);
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('literal sed redirect computes output without running or changing source', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-sed-'));
  const input = "test.skip('old', () => {});\n";
  const target = "test('existing', () => {});\n";
  const blocked = command => checkTool('Bash', { command }, 'high', cwd).blocked;
  try {
    fs.writeFileSync(path.join(cwd, 'one-skip.test.js'), input);
    fs.writeFileSync(path.join(cwd, 'one skip.test.js'), input);
    fs.writeFileSync(path.join(cwd, 'math.test.js'), target);
    for (const command of [
      "sed 's/test.skip(/test(/g' one-skip.test.js > math.test.js",
      "sed -e 's/test\\.skip(/test(/g' 'one skip.test.js' > math.test.js",
      `sed 's/test.skip(/test(/g' "one skip.test.js" | tee math.test.js`,
      "sed 's/test.skip(/test(/g' one-skip.test.js >> math.test.js",
    ]) assert.equal(blocked(command), false, command);
    for (const command of [
      `printf '%s' "sed 's/test.skip(/test(/g' one-skip.test.js" > math.test.js`,
      "cat > math.test.js <<'EOF'\nsed 's/test.skip(/test(/g' one-skip.test.js\nEOF",
      "sed 's/test(/test.skip(/g' math.test.js | tee math.test.js",
      "sed 's/test.skip(/test(/g' $(echo one-skip.test.js) > math.test.js",
      "sed 's/test.skip(/test(/g' $SOURCE > math.test.js",
      "sed 's/test.skip(/test(/g' *.test.js > math.test.js",
      "sed -n 's/test.skip(/test(/g' one-skip.test.js > math.test.js",
      "sed 's/test.skip(/test(/g' -e 's/test(/test.skip(/g' one-skip.test.js > math.test.js",
      "sed 's/.*test.skip(/test(/g' one-skip.test.js > math.test.js",
    ]) assert.equal(blocked(command), true, command);
    fs.writeFileSync(path.join(cwd, 'one-skip.test.js'), input + "it.skip('other', () => {});\n");
    assert.equal(blocked("sed 's/test.skip(/test(/g' one-skip.test.js > math.test.js"), true);
    assert.equal(fs.readFileSync(path.join(cwd, 'one-skip.test.js'), 'utf8'), input + "it.skip('other', () => {});\n");
    assert.equal(fs.readFileSync(path.join(cwd, 'math.test.js'), 'utf8'), target);
    fs.writeFileSync(path.join(cwd, 'one-skip.test.js'), input + input);
    assert.equal(blocked("sed 's/test.skip(/test(/' one-skip.test.js > math.test.js"), false);
    fs.writeFileSync(path.join(cwd, 'one-skip.test.js'), input.trim() + input);
    assert.equal(blocked("sed 's/test.skip(/test(/' one-skip.test.js > math.test.js"), true);
    assert.equal(blocked("sed 's/test.skip(/test(/g' one-skip.test.js > math.test.js"), false);
    // Inference limits must fall back to the conservative command-text check.
    fs.writeFileSync(path.join(cwd, 'one-skip.test.js'), "test.skip(\n".repeat(10001));
    assert.equal(blocked("sed 's/test.skip(/test(/g' one-skip.test.js > math.test.js"), true);
    fs.writeFileSync(path.join(cwd, 'one-skip.test.js'), ' '.repeat(1024 * 1024) + input);
    assert.equal(blocked("sed 's/test.skip(/test(/g' one-skip.test.js > math.test.js"), true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
