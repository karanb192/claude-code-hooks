const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkTool } = require('../protect-tests.js');

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'protect-tests-shell-'));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
fs.writeFileSync(path.join(cwd, 'math.test.js'), "test('a', () => {});\n");
const emit = `printf '%s\\n' "test.skip('a', () => {});"`;
const check = (command, expected) => assert.equal(
  checkTool('Bash', { command }, 'high', cwd).blocked, expected, command);

describe('Bash output: preserve shell boundaries', () => {
  it('keeps continued pipelines, comments, blank lines, and |& with their sink', () => {
    for (const command of [
      `${emit} |\n tee math.test.js`,
      `${emit} |&\n tee math.test.js`,
      `${emit} | # comment\n\n # second comment\n tee math.test.js`,
      `${emit} | \\\n tee math.test.js`,
      `{ ${emit}; } | # continued\n tee -a math.test.js`,
    ]) check(command, true);
  });

  it('keeps nested groups and literal brace arguments inside a group', () => {
    for (const command of [
      `{ ${emit}; } > math.test.js`,
      `(${emit}\n) > math.test.js`,
      `{ (${emit}); } |\n tee math.test.js`,
      `{ printf '%s' } >/dev/null; ${emit}; } > math.test.js`,
      `{ printf '%s' }suffix >/dev/null; ${emit}; } > math.test.js`,
      `{ echo { >/dev/null; ${emit}; } > math.test.js`,
      `{ echo hi; # } is only comment text\n ${emit}; } > math.test.js`,
    ]) check(command, true);
  });

  it('does not treat literal opening braces as compound commands', () => {
    for (const word of ['{', 'unmatched{', '{a,b}', '\\{', "'{'"]) {
      check(`printf '%s\\n' ${word} 'test.skip(' > notes.txt; echo hi > math.test.js`, false);
    }
  });

  it('separates unrelated commands after complete groups and pipelines', () => {
    for (const command of [
      `{ ${emit}; } > notes.txt; echo hi > math.test.js`,
      `(${emit}) > notes.txt; echo hi > math.test.js`,
      `${emit} |\n tee notes.txt\necho hi > math.test.js`,
      `printf '%s\\n' "literal ( { |" > notes.txt; echo hi > math.test.js`,
      `echo x 2>&1 | tee notes.txt; echo hi > math.test.js`,
      `echo x &> notes.txt; echo hi > math.test.js`,
    ]) check(command, false);
  });
});

describe('Bash output: literal text is never a search expression', () => {
  it('does not strip sed-looking heredoc or printf content', () => {
    check("cat > math.test.js <<'EOF'\n// s/\ntest.skip('a', () => {});\n//x/\nEOF", true);
    check(`printf '%s\\n' '// s/' "test.skip('a', () => {});" '//x/' > math.test.js`, true);
    check(`printf '%s' "sed 's/test.skip(/test(/g' source.js" > math.test.js`, true);
  });

  it('does not strip grep-looking heredoc or printf content', () => {
    check("cat > math.test.js <<'EOF'\n// grep\ntest.skip('a', () => {});\nEOF", true);
    check(`printf '%s\\n' '// grep' "test.skip('a', () => {});" > math.test.js`, true);
    check(`printf '%s' "grep -v 'test.skip(' source.js" > math.test.js`, true);
  });
});
