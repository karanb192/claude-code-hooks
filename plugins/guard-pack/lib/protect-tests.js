#!/usr/bin/env node
/**
 * Protect Tests - PreToolUse Hook for Bash|Edit|MultiEdit|Write
 * Blocks the "fake green" failure mode: an agent that makes a suite pass by
 * deleting, renaming-away, or disabling (skip/xfail/ignore) test cases instead
 * of fixing the code. Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict' (default: 'high')
 *   critical - deleting test files or whole test directories (rm / git rm)
 *   high     - + renaming a test file to a disabled name, + introducing a
 *              skip/xfail/ignore marker into an existing test (Edit/MultiEdit,
 *              a Write over an existing test file, or a shell in-place edit or
 *              redirect into one: sed -i, perl -pi, >, >>, tee)
 *   strict   - + writing a whole new test file that is already skipped (Write)
 * Override via the HOOK_SAFETY_LEVEL env var; invalid values fall back to
 * 'high'. Tune via env, not by editing this file: plugin updates overwrite it.
 *
 * It does NOT block writing new, real tests, refactor-renaming a test to another
 * test name, or editing test bodies: only removal and disabling.
 *
 * Setup (plugin, recommended):
 *   /plugin marketplace add karanb192/claude-code-hooks   # once per machine
 *   /plugin install protect-tests@claude-code-hooks
 *
 * The classic path still works too: copy this file somewhere stable and
 * register it in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Bash|Edit|MultiEdit|Write",
 *       "hooks": [{ "type": "command", "command": "node /path/to/protect-tests.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

// 'critical' | 'high' | 'strict'. Overridable via HOOK_SAFETY_LEVEL so an
// installed plugin can be tuned without editing this file; anything else
// falls back to the default.
const SAFETY_LEVEL = ['critical', 'high', 'strict'].includes(process.env.HOOK_SAFETY_LEVEL)
  ? process.env.HOOK_SAFETY_LEVEL
  : 'high';

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🚨', high: '⛔', strict: '⚠️' };
const LOG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.claude', 'hooks-logs');

// A path that looks like a test file (many languages / conventions).
const TEST_PATH = new RegExp(
  [
    '(^|/)(tests?|__tests__|spec|specs)/',        // inside a test directory
    '(^|/)test_[^/]+\\.py$',                        // pytest / unittest
    '_test\\.(py|go|rb|js|jsx|ts|tsx|mjs|cjs)$',    // *_test.*
    '\\.(test|spec)\\.(js|jsx|ts|tsx|mjs|cjs)$',    // *.test.* / *.spec.*
    '(^|/)[^/]+_spec\\.rb$',                        // rspec
    '(^|/)[^/]*Test\\.(java|kt|cs)$',               // JUnit / xUnit
    '(^|/)Test[^/]*\\.(java|kt|cs)$',
  ].join('|'),
  'i'
);

// The same, but as it would appear as a token inside a shell command.
// Case-insensitive: on a default macOS or Windows volume, Tests/ is tests/.
const TEST_TOKEN =
  /(test_[\w.-]+\.\w+|[\w.-]+_test\.\w+|[\w.-]+\.(test|spec)\.\w+|[\w.-]+_spec\.rb|(^|[\s'"/])(tests?|__tests__|specs?)\/)/i;

const DELETE_VERB = /(\brm\b|\bunlink\b|\bshred\b|\btrash\b|\bgit\s+rm\b)/;
const RENAME_VERB = /\bmv\b/;
const DISABLED_DEST = /(\.bak|\.old|\.orig|\.disabled|\.skip|\.ignore|\.tmp|~)(["'\s]|$)/i;

// Ways to drop a suite that carry no test/ slash or test file name: a bare
// directory operand (rm -rf tests, tests*, {tests,}), find or xargs feeding a
// delete, or a move to a temp or trash folder. Each is judged within one
// command; a pipe stays inside it, so find ... | xargs rm is one command.
const TEST_DIR_ARG = '(?:^|[\\s\'"/{,*?])(?:tests?|__tests__|specs?)(?=[\\s\'"/)*?},]|$)';
const DEL_CMD = '(?:(?:env|sudo|command|nice|nohup)\\s+(?:-\\S+\\s+)*)?(?:["\']?(?:[^\\s"\'|;&]*\\/)?(?:rm|unlink|shred|trash)["\']?(?![\\w.-])|\\bgit\\s+rm\\b)';
const BARE_DIR_DELETE = new RegExp('(?:\\b(?:rm|unlink|shred|trash)\\b|\\bgit\\s+rm\\b)[^|]*' + TEST_DIR_ARG, 'i');
const TEST_NAME_GLOB = new RegExp(TEST_DIR_ARG + '|test_|_test\\.|\\.(?:test|spec)\\.|_spec\\.rb', 'i');
const FIND_DELETE = new RegExp('\\bfind\\b.*(?:\\s-delete\\b|\\s-exec(?:dir)?\\s+' + DEL_CMD + ')');
// xargs flags that take a value (-n 1, -I {}, -P 4) consume the next word.
const XARGS_DELETE = new RegExp('\\|\\s*xargs\\b(?:\\s+(?:-[0prtxo]+|-[adEIJLnPRSsil]\\s*[^\\s|;&]+|--[\\w-]+(?:=\\S+)?))*\\s+' + DEL_CMD);
// The destination is mv's last operand; a temp path earlier is a source.
const DISCARD_DEST = /\s["']?(?:\/tmp|\/var\/tmp|\/private\/tmp|\/(?:private\/)?var\/folders|\/dev\/null|\$\{?TMPDIR(?::-[^}\s]*)?\}?|(?:~|\$\{?HOME\}?)\/\.Trash)(?:\/[^\s"']*)?["']?\s*$/;

// mv's operands end where a comment, redirect or pipe begins.
const MV_TAIL = /\s+(?:#|\d*[<>]|\|)[\s\S]*$/;

function dropsTestSuite(cmd) {
  return cmd.replace(/\\\r?\n/g, '').split(/[;&\n]+|\|\|/).some(seg =>
    BARE_DIR_DELETE.test(seg) ||
    ((FIND_DELETE.test(seg) || XARGS_DELETE.test(seg)) && TEST_NAME_GLOB.test(seg)) ||
    (RENAME_VERB.test(seg) && TEST_NAME_GLOB.test(seg) && DISCARD_DEST.test(seg.replace(MV_TAIL, ''))));
}

// Markers that turn an existing test off in place.
const SKIP_MARKERS = [
  /@pytest\.mark\.(skip|xfail)/,          // pytest
  /@unittest\.skip/,                       // unittest
  /\bpytest\.skip\s*\(/,
  /@Disabled\b/,                           // JUnit 5
  /@Ignore\b/,                             // JUnit 4 / TestNG
  /\b(it|test|describe|context)\.skip\s*\(/, // jest / mocha / vitest
  /\bx(it|describe|test|context)\s*\(/,      // xit / xdescribe ...
  /\bt\.Skip(Now)?\s*\(/,                   // Go
  /#\[ignore\]/,                           // Rust
  /\[Ignore\]/,                            // NUnit / MSTest
];

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...data }) + '\n');
  } catch {}
}

// Counts, not presence: a file that already has one it.skip( must still trip
// when a second one is added.
function addedMarker(oldStr, newStr) {
  const before = oldStr || '';
  const after = newStr || '';
  for (const m of SKIP_MARKERS) {
    const g = new RegExp(m.source, 'g');
    if ((after.match(g) || []).length > (before.match(g) || []).length) return true;
  }
  return false;
}

// Large files are left to the other checks rather than read on every call.
const MAX_READ_BYTES = 2 * 1024 * 1024;

function readExisting(filePath, cwd) {
  try {
    const abs = path.resolve(cwd || process.cwd(), filePath);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

// sed -i / perl -pi / ruby -pi edit files in place; their s/// replacement is
// what lands in the file, so only the replacement side is compared.
const IN_PLACE = /\b(sed\b[^|;&]*\s(-[a-zA-Z]*i|--in-place)|(perl|ruby)\b[^|;&]*\s-[a-zA-Z]*i)/;
// [^\\] keeps the two alternatives disjoint: when both took a backslash, a run
// of them with no closing delimiter backtracked exponentially.
const SUBST = /\bs([/|#,:@!])((?:\\.|(?!\1)[^\\])*)\1((?:\\.|(?!\1)[^\\])*)\1/g;
// > file, >> file, tee [-a] file; a quoted or escaped name keeps its spaces.
const REDIRECT = /(>>?|\btee(?:\s+-a)?)\s*(?:"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'|;&<>\\])+))/g;
// A replacement can finish a marker with the text around it: s/test/test.skip/
// turns `test(` into `test.skip(`, and s/(/.skip(/ turns `it(` into `it.skip(`.
const MARKER_CONTEXT = ['', 'it', 'test', 'describe', 'context'];

function substAddsMarker(pat, rep) {
  return MARKER_CONTEXT.some(pre => ['', '('].some(post => addedMarker(pre + pat + post, pre + rep + post)));
}

// Split complete top-level commands, retaining pipelines and grouped output.
// This is a bounded shell boundary scanner, not an evaluator. Heredoc contents
// stay together because their delimiter rules need a separate parser.
function shellCommands(cmd) {
  if (cmd.includes('<<')) return [cmd];
  const parts = [];
  const groups = [];
  let start = 0;
  let quote = '';
  let word = '';
  let wordActive = false;
  let plainWord = true;
  let commandStart = true;
  let afterPipe = false;
  const finishWord = () => {
    if (!wordActive) return;
    // These reserved words introduce a command rather than being its name.
    commandStart = commandStart && plainWord &&
      /^(?:if|then|elif|else|while|until|do|!|time|coproc)$/.test(word);
    word = '';
    wordActive = false;
    plainWord = true;
  };
  const tokenEnd = (ch) => !ch || /[\s;&|<>()]/.test(ch);
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && quote !== "'") {
      if (cmd[i + 1] === '\n') { i++; continue; }
      wordActive = true;
      plainWord = false;
      afterPipe = false;
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      wordActive = true;
      plainWord = false;
      afterPipe = false;
      continue;
    }
    if (ch === '#' && !wordActive) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    if (ch === '{' && !wordActive && commandStart && tokenEnd(cmd[i + 1])) {
      groups.push('{');
      commandStart = true;
      afterPipe = false;
      continue;
    }
    if (ch === '}' && !wordActive && commandStart && tokenEnd(cmd[i + 1]) &&
        groups[groups.length - 1] === '{') {
      groups.pop();
      commandStart = false;
      afterPipe = false;
      continue;
    }
    if (ch === '(') {
      finishWord();
      groups.push('(');
      commandStart = true;
      afterPipe = false;
      continue;
    }
    if (ch === ')' && groups[groups.length - 1] === '(') {
      finishWord();
      groups.pop();
      commandStart = false;
      afterPipe = false;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&' || ch === '\n') {
      finishWord();
      // Descriptor duplication and combined redirection are not separators.
      if (ch === '&' && (cmd[i - 1] === '>' || cmd[i - 1] === '<' || cmd[i + 1] === '>')) continue;
      if (ch === '\n' && afterPipe) continue;
      if (ch === '|' && cmd[i + 1] !== '|') {
        if (cmd[i + 1] === '&') i++;
        commandStart = true;
        afterPipe = true;
        continue;
      }
      if (!groups.length) parts.push(cmd.slice(start, i));
      if ((ch === '|' && cmd[i + 1] === '|') || (ch === '&' && cmd[i + 1] === '&')) i++;
      if (!groups.length) start = i + 1;
      commandStart = true;
      afterPipe = false;
      continue;
    }
    if (/\s/.test(ch)) { finishWord(); continue; }
    wordActive = true;
    word += ch;
    afterPipe = false;
  }
  parts.push(cmd.slice(start));
  return parts;
}

// Infer only small literal sed/perl substitutions or grep filters. Unsupported
// syntax uses the command-text heuristic; no submitted command is executed.
function simpleRedirectOutput(cmd, cwd) {
  if (cmd.length > 4096 || /[\r\n]/.test(cmd)) return null;
  const word = `(?:"[A-Za-z0-9_./ -]+"|'[A-Za-z0-9_./ -]+'|[A-Za-z0-9_./-]+)`;
  const match = cmd.match(new RegExp(`^\\s*(sed(?:\\s+-e)?|perl\\s+-pe|grep(?:\\s+-[vF]{1,2}){0,2})\\s+'([^'\\n]{1,520})'\\s+(${word})\\s*(?:>>?\\s*|\\|\\s*tee\\s+(?:-a\\s+)?)${word}\\s*$`));
  if (!match) return null;
  const [, producer, script, source] = match;
  const grep = producer.startsWith('grep');
  const perl = producer.startsWith('perl');
  const fixed = grep && producer.includes('F');
  const inverse = grep && producer.includes('v');
  const subst = !grep && script.match(/^s\/([^/]{1,256})\/([^/]{0,256})\/(g?)$/);
  if (!grep && !subst) return null;
  const [, pat, rep = '', flag = ''] = grep ? [null, script] : subst;
  if (pat.length > 256 || (grep && pat.startsWith('-')) || /[^A-Za-z0-9_ .(),:=\-]/.test(rep)) return null;
  // Only literals and fixed-width dots. BRE parentheses are literal; Perl
  // parentheses must be escaped. Never pass arbitrary regex into JavaScript.
  let regex = '';
  for (let i = 0; i < pat.length; i++) {
    let ch = pat[i];
    if (ch === '\\' && !fixed) {
      ch = pat[++i];
      if (ch !== '.' && !(perl && (ch === '(' || ch === ')'))) return null;
    } else if (ch === '.' && !fixed) { regex += '[^\\n]'; continue; }
    else if (!/[A-Za-z0-9_ .(),:=\-]/.test(ch) || (perl && /[()]/.test(ch))) return null;
    regex += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  const file = source.replace(/^(["'])(.*)\1$/, '$2');
  // Perl's diamond input uses magic open, which trims filename whitespace.
  // Do not infer from a different file than the producer would actually read.
  if (file.startsWith('-') || (perl && file !== file.trim())) return null;
  const input = readExisting(file, cwd);
  // Locale/byte semantics differ across these tools for Unicode and binary
  // files. Infer only ASCII text, with bounded matching work and output.
  if (input === null || /[^\x01-\x7f]/.test(input) || input.length * regex.length > 8 * 1024 * 1024) return null;
  const chunks = [];
  let size = 0;
  let matches = 0;
  if (grep) {
    const re = new RegExp(regex);
    for (const line of input.matchAll(/[^\n]*\n|[^\n]+$/g)) {
      if (++matches > 10000) return null;
      if (re.test(line[0]) === inverse) continue;
      const out = line[0].endsWith('\n') ? line[0] : line[0] + '\n';
      size += out.length;
      if (size > MAX_READ_BYTES) return null;
      chunks.push(out);
    }
  } else {
    let end = 0;
    let nextLine = 0;
    for (const m of input.matchAll(new RegExp(regex, 'g'))) {
      if (++matches > 10000) return null;
      if (!flag) {
        if (m.index < nextLine) continue;
        const newline = input.indexOf('\n', m.index);
        nextLine = newline < 0 ? input.length : newline + 1;
      }
      size += m.index - end + rep.length;
      if (size > MAX_READ_BYTES) return null;
      chunks.push(input.slice(end, m.index), rep);
      end = m.index + m[0].length;
    }
    if (size + input.length - end > MAX_READ_BYTES) return null;
    chunks.push(input.slice(end));
  }
  return chunks.join('');
}

function shellAddsMarker(cmd, cwd) {
  const unesc = (s) => s.replace(/\\(.)/g, '$1');
  for (const part of shellCommands(cmd)) {
    if (IN_PLACE.test(part) && (TEST_TOKEN.test(part) || TEST_NAME_GLOB.test(part))) {
      for (const [, , pat, rep] of part.matchAll(SUBST)) {
        if (substAddsMarker(unesc(pat), unesc(rep))) return true;
      }
    }
    const output = simpleRedirectOutput(part, cwd);
    for (const [, op, dq, sq, bare] of part.matchAll(REDIRECT)) {
      const target = dq ?? sq ?? unesc(bare);
      if (!TEST_PATH.test(target)) continue;
      const existing = op.startsWith('>>') || op.includes('-a') ? '' : readExisting(target, cwd);
      if (existing !== null && addedMarker(existing, output ?? unesc(part))) return true;
    }
  }
  return false;
}

// Returns { blocked, id, level, reason }: pure apart from reading the target
// test file for Write and shell redirects, so it is unit-testable. cwd
// resolves relative paths; it defaults to the process's working directory.
function checkTool(toolName, toolInput = {}, safetyLevel = SAFETY_LEVEL, cwd = undefined) {
  const threshold = LEVELS[safetyLevel] || 2;
  const allow = () => ({ blocked: false });
  const deny = (level, id, reason) =>
    LEVELS[level] <= threshold ? { blocked: true, id, level, reason } : allow();

  if (toolName === 'Bash') {
    const cmd = toolInput.command || '';
    if (dropsTestSuite(cmd)) return deny('critical', 'delete-test', 'deleting test file(s) or test directory');
    if (TEST_TOKEN.test(cmd)) {
      if (DELETE_VERB.test(cmd)) return deny('critical', 'delete-test', 'deleting test file(s) or test directory');
      if (RENAME_VERB.test(cmd) && DISABLED_DEST.test(cmd))
        return deny('high', 'rename-test', 'renaming a test file to a disabled name');
    }
    // Runs without the TEST_TOKEN gate: it finds its own test target per command,
    // which a glob (find -name '*.test.js' | xargs sed -i) never puts in TEST_TOKEN.
    if (shellAddsMarker(cmd, cwd))
      return deny('high', 'skip-test', 'adding a skip/xfail/ignore marker to a test file from the shell');
    return allow();
  }

  if (toolName === 'Edit') {
    if (TEST_PATH.test(toolInput.file_path || '') && addedMarker(toolInput.old_string, toolInput.new_string))
      return deny('high', 'skip-test', 'adding a skip/xfail/ignore marker to an existing test');
    return allow();
  }

  if (toolName === 'MultiEdit') {
    if (TEST_PATH.test(toolInput.file_path || '')) {
      for (const e of toolInput.edits || []) {
        if (addedMarker(e.old_string, e.new_string))
          return deny('high', 'skip-test', 'adding a skip/xfail/ignore marker to an existing test');
      }
    }
    return allow();
  }

  if (toolName === 'Write') {
    const file = toolInput.file_path || '';
    if (!TEST_PATH.test(file)) return allow();
    const existing = readExisting(file, cwd);
    if (existing !== null && addedMarker(existing, toolInput.content))
      return deny('high', 'skip-test', 'rewriting an existing test file with a new skip/xfail/ignore marker');
    if (addedMarker('', toolInput.content))
      return deny('strict', 'write-skipped-test', 'writing a test file that is already skipped/ignored');
    return allow();
  }

  return allow();
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const { tool_name, tool_input, session_id, cwd, permission_mode } = data;
    const result = checkTool(tool_name, tool_input || {}, SAFETY_LEVEL, cwd);

    if (result.blocked) {
      log({ level: 'BLOCKED', id: result.id, priority: result.level, tool: tool_name, session_id, cwd, permission_mode });
      return console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${EMOJIS[result.level]} [${result.id}] ${result.reason}. Fix the code, don't disable the test: or run this manually if the removal is intentional.`
        }
      }));
    }
    console.log('{}');
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { SKIP_MARKERS, TEST_PATH, LEVELS, SAFETY_LEVEL, checkTool };
}
