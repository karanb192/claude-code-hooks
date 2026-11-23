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
    '(^|/)[^/]+\\.tests?/',                         // .NET test project (MyApp.Tests/)
    '(^|/)test_[^/]+\\.py$',                        // pytest / unittest
    '_test\\.(py|go|rb|rs|js|jsx|ts|tsx|mjs|cjs|mts|cts)$', // *_test.*
    '\\.(test|spec)\\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$',  // *.test.* / *.spec.*
    '(^|/)[^/]+_spec\\.rb$',                        // rspec
    '(^|/)[^/]*Tests?\\.(java|kt|cs)$',             // JUnit / xUnit / NUnit
    '(^|/)Test[^/]*\\.(java|kt|cs)$',
  ].join('|'),
  'i'
);

// The same, but as it would appear as a token inside a shell command. A glob
// stands where the name would be (rm *.test.js, rm test_*.py).
// Case-insensitive: on a default macOS or Windows volume, Tests/ is tests/.
const TEST_TOKEN =
  /(test_[\w.*?[\]-]+\.\w+|[\w.*?[\]-]+_test\.\w+|[\w.*?[\]-]+\.(test|spec)\.\w+|[\w.*?[\]-]+_spec\.rb|(^|[\s'"/])(tests?|__tests__|specs?)\/)/i;
// JUnit / NUnit class names and .NET test projects. Case-sensitive, so
// Latest.java or contests.cs is not a test.
const CLASS_TEST_TOKEN = /(?:^|[\s'"/=*])(?:[\w*?-]*Tests?|Test[\w*?-]*)\.(?:java|kt|cs)(?![\w.])|[\w-]+\.Tests?(?=[\s'"/;&|)]|$)/;
const testToken = (cmd) => TEST_TOKEN.test(cmd) || CLASS_TEST_TOKEN.test(cmd);
// A literal test file name anywhere in the command keeps the long-standing
// whole-command pairing with a delete or rename verb. A glob or class name
// counts only in the same command as the verb, so `ls *.test.js && rm x.log`
// is not a delete of tests, unless a loop, xargs or a substitution can feed
// the glob's matches to the verb.
const FEEDS_ITEMS = /\bfor\s+\w+\s+in\b|\b(?:while|until)\s|\bxargs\b|\$\(|`/;
const LITERAL_TEST_TOKEN =
  /(test_[\w.-]+\.\w+|[\w.-]+_test\.\w+|[\w.-]+\.(test|spec)\.\w+|[\w.-]+_spec\.rb|(^|[\s'"/])(tests?|__tests__|specs?)\/)/i;
// Judged per shell word: a word with a glob character is not a literal name,
// even when part of it reads like one (*.unit.test.js).
const literalTestWord = (cmd) => (cmd.match(/"[^"]*"|'[^']*'|[^\s;&|()<>]+/g) || [])
  .some(w => !/[*?[\]{}]/.test(w) && LITERAL_TEST_TOKEN.test(w.replace(/^(["'])(.*)\1$/, '$2')));
const pairedWith = (cmd, verb) =>
  ((literalTestWord(cmd) || (FEEDS_ITEMS.test(cmd) && testToken(cmd))) && verb(cmd)) ||
  shellCommands(cmd).some(part => testToken(part) && verb(part));

// Rust keeps unit tests inline in src/, and a test class can sit outside any
// test folder: a file whose own text defines tests is a test file too.
const TEST_DEFINITION = {
  rs: /#\[(?:\w+::)*test\b|#\[cfg\(test\)\]/,
  java: /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/,
  kt: /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/,
  cs: /\[(?:Test|TestCase|TestMethod|TestFixture|TestClass|Fact|Theory)\b/,
  py: /^\s*(?:async\s+)?def\s+test\w*\s*\(|^\s*class\s+Test\w*/m,
};

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
const testNameGlob = (seg) => TEST_NAME_GLOB.test(seg) || CLASS_TEST_TOKEN.test(seg);
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
    ((FIND_DELETE.test(seg) || XARGS_DELETE.test(seg)) && testNameGlob(seg)) ||
    (RENAME_VERB.test(seg) && testNameGlob(seg) && DISCARD_DEST.test(seg.replace(MV_TAIL, ''))));
}

// mv and git mv read as words: -t names the target first, a brace list
// such as a.test.js{,.bak} expands, and the call ends at ; | & ) or a
// newline whatever follows the name. Only a command in command position
// counts (after a separator, a group opener or a wrapper), so a mention
// such as `echo mv a b` is text.
const MOVE = /(?:^|[;&|(\n{])\s*(?:(?:sudo|doas|env|command|nohup|nice|time|exec)\s+(?:-\S+\s+)*)*(git\s+mv|mv)\s+([^;&|\n)]*)/g;
const TEST_NAME = /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.\w+|[^/]+\.(?:test|spec)\.\w+|[^/]+_spec\.rb)$|(?:^|\/)(?:[^/]*Tests?|Test[^/]*)\.(?:java|kt|cs)$/;
const TEST_DIR_NAME = /(?:^|\/)(?:tests?|__tests__|specs?)$/i;
const DISABLED_NAME = /(?:\.(?:bak|backup|old|orig|disabled|off|skip|skipped|ignore|ignored|tmp)|~)$/i;
const TEMP_DEST = /^(?:\/tmp|\/var\/tmp|\/private\/(?:var\/)?tmp|\/(?:private\/)?var\/folders|\/dev\/null|\$\{?TMPDIR(?::-[^}]*)?\}?|(?:~|\$\{?HOME\}?)\/\.Trash)(?:\/|$)|^\$MKTEMP\b/;

function moveWords(args) {
  const words = [];
  for (const [, dq, sq, bare] of args.matchAll(/"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g)) {
    const word = dq ?? sq ?? bare.replace(/\\(.)/g, '$1');
    const brace = bare && word.match(/^(.*)\{([^{}]*,[^{}]*)\}(.*)$/);
    if (brace) for (const alt of brace[2].split(',')) words.push(brace[1] + alt + brace[3]);
    else words.push(word);
  }
  return words;
}

const isDirectory = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// A test moved to a temp or trash folder is a delete; one renamed to a
// disabled suffix, or from a test name to a name no runner collects, or a
// test folder renamed to a non-test name, is a rename-away.
// Returns the most severe verdict across every mv in the command, so a
// rename found first cannot hide a later move to a temp folder.
function moveVerdict(cmd, cwd) {
  let verdict = null;
  const text = cmd.replace(/\\\r?\n/g, '').replace(/\$\(\s*mktemp\b[^)]*\)|`\s*mktemp\b[^`]*`/g, '$MKTEMP');
  for (const [, verb, args] of text.matchAll(MOVE)) {
    const words = moveWords(args.replace(MV_TAIL, ''));
    // git mv -n is a dry run; plain mv -n only refuses to overwrite.
    const end = words.indexOf('--');
    const options = end < 0 ? words : words.slice(0, end);
    if (verb !== 'mv' && options.some(w => w === '--dry-run' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(w))) continue;
    const operands = [];
    let target = null;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w === '--') { operands.push(...words.slice(i + 1)); break; }
      if (w.startsWith('--target-directory=')) target = w.slice(19);
      else if (w === '--target-directory' || /^-[a-zA-Z]*t$/.test(w)) target = words[++i];
      else if (!w.startsWith('-') || w === '-') operands.push(w);
    }
    const flagged = target !== null;
    if (!flagged) target = operands.pop();
    if (!target || !operands.length) continue;
    const intoDir = flagged || operands.length > 1 || /\/$/.test(target) || isDirectory(path.resolve(cwd || process.cwd(), target));
    for (const raw of operands) {
      const src = raw.replace(/\/+$/, '');
      const file = TEST_NAME.test(src);
      const folder = TEST_DIR_NAME.test(src);
      if (!file && !folder && !TEST_PATH.test(src)) continue;
      if (TEMP_DEST.test(target)) return 'delete-test';
      const final = intoDir ? `${target.replace(/\/+$/, '')}/${path.basename(src)}` : target;
      if (DISABLED_NAME.test(final) ||
          (file && !TEST_NAME.test(final) && !/(?:^|\/)__tests__\//.test(final)) ||
          (folder && !TEST_DIR_NAME.test(final.replace(/\/+$/, '')))) verdict = 'rename-test';
    }
  }
  return verdict;
}

// Markers that turn an existing test off in place.
const SKIP_MARKERS = [
  /\bpytest\s*\.\s*mark\s*\.\s*(?:skip|skipif|xfail)(?!\w)/, // pytest decorator or pytestmark
  /@mark\s*\.\s*(?:skip|skipif|xfail)(?!\w)/,                 // from pytest import mark
  /\bpytest\s*\.\s*(?:skip|xfail)\s*\(/,
  /@unittest\s*\.\s*(?:skip\w*|expectedFailure)\b/,     // unittest
  /\.\s*skipTest\s*\(|\braise\s+(?:unittest\.)?SkipTest\b/,
  /@Disabled\w*/,                                          // JUnit 5, including @DisabledIf...
  /@Ignore\b/,                                             // JUnit 4
  /@Test\s*\([^)]*\benabled\s*=\s*false\b/,              // TestNG
  /\b(?:it|test|describe|context|suite|specify)(?:\s*\.\s*(?:concurrent|sequential|each|only|fails|failing))*\s*\.\s*(?:skip|skipIf|todo)\b/, // jest / mocha / vitest
  /\bthis\s*\.\s*skip\s*\(/,                              // mocha, inside a test
  /\bx(?:it|describe|test|context|specify)\b\s*[('"`]/,     // xit( / RSpec xit 'name'
  /^[ \t]*(?:skip|pending)(?:[ \t]+|[ \t]*\([ \t]*)['"]/m,    // RSpec skip 'reason' / pending('reason')
  /\b[tb]\s*\.\s*Skip(?:f|Now)?\s*\(/,                      // Go
  /#\[\s*ignore\b/,                                          // Rust, bare or with a reason
  /[[,]\s*Ignore\s*[\](]/,                                  // NUnit / MSTest, bare or with a reason
  /\[\s*(?:Fact|Theory)\s*\([^)\]]*\bSkip\s*=/,              // xUnit
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
    const g = new RegExp(m.source, m.flags + 'g');
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
const IN_PLACE = /\b(sed\b[^|;&]*\s(-[a-zA-Z]*i|--in-place)|(perl|ruby)\b[^|;&]*\s-[a-zA-Z0-9]*i|g?awk\b[^|;&]*\s-i\s*inplace\b)/;
// A stream editor whose output can be redirected or moved over a test file.
const STREAM_EDITOR = /(?:^|[\s;&|(])(?:sed|gsed|perl|ruby|g?awk)\s/;
// [^\\] keeps the two alternatives disjoint: when both took a backslash, a run
// of them with no closing delimiter backtracked exponentially.
const SUBST = /\bs([/|#,:@!])((?:\\.|(?!\1)[^\\])*)\1((?:\\.|(?!\1)[^\\])*)\1/g;
// > file, >> file, >| file; a quoted or escaped name keeps its spaces.
const REDIRECT = /(>>?\|?)\s*(?:"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'|;&<>\\])+))/g;
// tee writes every file operand; -a / --append keeps what is there.
const TEE = /\btee((?:\s+-[-\w]*)*)((?:\s+(?:"[^"]*"|'[^']*'|(?:\\.|[^\s"'|;&<>\\])+))+)/g;
const SHELL_WORD = /"([^"]*)"|'([^']*)'|((?:\\.|[^\s"'|;&<>\\])+)/g;
// A replacement can finish a marker with the text around it: s/test/test.skip/
// turns `test(` into `test.skip(`, and s/(/.skip(/ turns `it(` into `it.skip(`.
const MARKER_CONTEXT = ['', 'it', 'test', 'describe', 'context'];

function substAddsMarker(pat, rep) {
  return MARKER_CONTEXT.some(pre => ['', '('].some(post => addedMarker(pre + pat + post, pre + rep + post)));
}

// The (pattern, replacement) pairs a sed, perl, ruby or awk script writes:
// s commands with any delimiter (and perl's s{}{}), sed a / i / c text
// commands, perl print, and ruby or awk sub / gsub. Inserted text has an
// empty pattern.
const S_ANY = /(?:^|[^\w$@%])s([^\w\s\\{(\[<])((?:\\.|(?!\1)[^\\])*)\1((?:\\.|(?!\1)[^\\])*)\1/g;
const S_BRACES = /(?:^|[^\w$@%])s\{((?:\\.|[^\\{}])*)\}\s*\{((?:\\.|[^\\{}])*)\}/g;
const SED_TEXT = /(?:^|[\s;{'"])(?:\d+|\$|\/(?:\\.|[^\/\\\n])*\/)\s*[aic]\\?[ \t]*([^'"\n;]+)/g;
const PRINT_TEXT = /\bprint\s+(?:STDOUT\s+)?(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
const SUB_CALL = /\bg?sub!?\s*\(\s*\/((?:\\.|[^\/\\])*)\/\s*,\s*(["'])((?:\\.|(?!\2)[^\\])*)\2/g;
const BACKREF = /\\[0-9]|\$[0-9&]|\$\{[0-9]+\}|(?<!\\)&/g;

function scriptPairs(script) {
  const unesc = (t) => t.replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
  const pairs = [];
  for (const [, , pat, rep] of script.matchAll(S_ANY)) pairs.push([pat, rep]);
  for (const [, pat, rep] of script.matchAll(S_BRACES)) pairs.push([pat, rep]);
  for (const [, pat, , rep] of script.matchAll(SUB_CALL)) pairs.push([pat, rep]);
  for (const [, text] of script.matchAll(SED_TEXT)) pairs.push(['', text]);
  for (const [, , text] of script.matchAll(PRINT_TEXT)) pairs.push(['', text]);
  return pairs.map(([pat, rep]) => [unesc(pat), rep, unesc]);
}

// A backreference carries matched text into the replacement (s/^it/x&/ makes
// xit), so each one is tried as the pattern's own literal text and as each
// test-function name.
function scriptAddsMarker(script) {
  return scriptPairs(script).some(([pat, rep, unesc]) => {
    const literal = pat.replace(/[\^$()|?*+\[\]]/g, '');
    // Bounded so a long script cannot multiply into megabytes of candidates.
    const fills = [...new Set([literal, ...literal.split(/[^\w.]+/), ...MARKER_CONTEXT])].filter(f => f.length <= 64);
    const hasRef = BACKREF.test(rep);
    BACKREF.lastIndex = 0;
    const reps = !hasRef ? [rep] : rep.length > 1024 ? [rep.replace(BACKREF, '')] : fills.map(f => rep.replace(BACKREF, () => f));
    return reps.some(r => substAddsMarker(pat, unesc(r)));
  });
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

// A cd or pushd earlier in the command moves where later operands land:
// after `cd tests`, `rm -r unit` deletes tests. Each top-level command is
// paired with the directory it runs in; a ( ) group keeps its cd inside.
const CD = /^\s*(cd|pushd)\s+(?:--\s+)?("[^"]*"|'[^']*'|[^\s;&|()]+)\s*$/;
const POPD = /^\s*popd\s*$/;

function commandsWithDir(cmd, cwd) {
  const out = [];
  const base = path.resolve(cwd || process.cwd());
  const walk = (text, dir, stack) => {
    for (const part of shellCommands(text)) {
      const group = part.match(/^\s*\(([\s\S]*)\)\s*$/);
      if (group) { walk(group[1], dir, [...stack]); continue; }
      if (POPD.test(part)) { dir = stack.length ? stack.pop() : dir; continue; }
      const cd = part.match(CD);
      if (cd) {
        const arg = cd[2].replace(/^(["'])(.*)\1$/, '$2');
        if (cd[1] === 'pushd') stack.push(dir);
        dir = /[$`~*?]/.test(arg) ? base : path.resolve(dir, arg);
        continue;
      }
      out.push({ part, dir, moved: dir !== base });
    }
  };
  walk(cmd, base, []);
  return out;
}

// Operands of a command, resolved against the directory it runs in: the
// words after its name (and after git's subcommand, past wrappers such as
// sudo), without options. For an in-place editor the script is not an
// operand: the word after -e / -f, or else its first operand.
const WRAPPER = /^(?:sudo|doas|env|command|nohup|nice|time|exec)$/;

function operandPaths(part, dir, editor = false) {
  const words = [...part.matchAll(/(?:^|\s)(?:"([^"]*)"|'([^']*)'|([^\s"';&|<>()]+))/g)].map(([, dq, sq, bare]) => dq ?? sq ?? bare);
  let i = 0;
  while (i < words.length && WRAPPER.test(words[i])) { i++; while (i < words.length && words[i].startsWith('-')) i++; }
  if (words[i] === 'git') i++;
  i++;
  const operands = [];
  let scriptNext = false;
  let scriptGiven = false;
  for (const w of words.slice(i)) {
    if (editor && /^(?:-e|-f|--expression|--file)$/.test(w)) { scriptNext = true; scriptGiven = true; continue; }
    if (editor && /^--(?:expression|file)=/.test(w)) { scriptGiven = true; continue; }
    if (scriptNext) { scriptNext = false; continue; }
    if (!w || w.startsWith('-')) continue;
    operands.push(w);
  }
  if (editor && !scriptGiven) operands.shift();
  return operands.map(w => ({ word: w, abs: path.resolve(dir, w).replace(/\\/g, '/') }));
}

// Build and cache output that lives next to tests and is safe to clear.
const GENERATED = /(?:^|\/)(?:__pycache__|\.pytest_cache|node_modules|coverage|\.cache|tmp|temp|dist|build|out)(?:\/|$)|\.(?:pyc|pyo|log|tmp)$/;

function deletesInTestDir(cmd, cwd) {
  return commandsWithDir(cmd, cwd).some(({ part, dir, moved }) => {
    if (!moved || !DELETE_VERB.test(part)) return false;
    return operandPaths(part, dir).some(({ word, abs }) => TEST_PATH.test(abs) && !GENERATED.test(word));
  });
}

// Infer only small literal sed/perl substitutions or grep filters. Unsupported
// syntax uses the command-text heuristic; no submitted command is executed.
function simpleRedirectResult(cmd, cwd) {
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
  return { input, output: chunks.join('') };
}

function simpleRedirectOutput(cmd, cwd) {
  const result = simpleRedirectResult(cmd, cwd);
  return result && result.output;
}

// Files a command writes: redirect targets and every tee operand.
function writeTargets(part) {
  const unesc = (s) => s.replace(/\\(.)/g, '$1');
  const targets = [];
  for (const [, op, dq, sq, bare] of part.matchAll(REDIRECT)) targets.push({ file: dq ?? sq ?? unesc(bare), append: op.startsWith('>>') });
  for (const [, opts, files] of part.matchAll(TEE)) {
    const append = /(?:^|\s)(?:-\w*a\w*|--append)\b/.test(opts);
    for (const [, dq, sq, bare] of files.matchAll(SHELL_WORD)) {
      const file = dq ?? sq ?? unesc(bare);
      if (file === '--' || file.startsWith('-')) continue;
      targets.push({ file, append });
    }
  }
  return targets;
}

// mv or cp onto a test file: the last operand, unless -t names the target.
function copiesOntoTest(part) {
  const m = part.match(/(?:^|[\s;&|(])(?:git\s+)?(?:mv|cp)\s+(.*)$/);
  if (!m) return false;
  const words = [...m[1].replace(MV_TAIL, '').matchAll(SHELL_WORD)].map(([, dq, sq, bare]) => dq ?? sq ?? bare);
  const t = words.findIndex(w => w === '-t' || w.startsWith('--target-directory'));
  const dest = t >= 0 ? words[t + 1] : words[words.length - 1];
  return typeof dest === 'string' && TEST_PATH.test(dest);
}

function shellAddsMarker(cmd, cwd) {
  // sed and perl write \n in a replacement as a newline.
  const unesc = (s) => s.replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
  const parts = shellCommands(cmd);
  for (const { part: raw, dir, moved } of commandsWithDir(cmd, cwd)) {
    // $PWD is the directory the command runs in, after any cd.
    const part = raw.replace(/\$\{?PWD\}?(?=\/)/g, () => dir.replace(/\\/g, '/'));
    if (IN_PLACE.test(part) && (testToken(part) || testNameGlob(part) ||
        (moved && operandPaths(part, dir, true).some(({ abs }) => TEST_PATH.test(abs))))) {
      for (const [, , pat, rep] of part.matchAll(SUBST)) {
        if (substAddsMarker(unesc(pat), unesc(rep))) return true;
      }
      if (scriptAddsMarker(part)) return true;
    }
    const output = simpleRedirectOutput(part, dir);
    for (const { file, append } of writeTargets(part)) {
      if (!isTestFile(file, dir, output ?? unesc(part)) && !TEST_PATH.test(path.resolve(dir, file).replace(/\\/g, '/'))) continue;
      const existing = append ? '' : readExisting(file, dir);
      if (existing !== null && addedMarker(existing, output ?? unesc(part))) return true;
    }
  }
  // A script that adds a marker, with its own output put over a test file:
  // redirected or tee'd straight in, or written to a file that a later
  // command moves, copies or cats onto a test. A redirect into a test whose
  // output the exact check above computed is not second-guessed, and output
  // that computation shows is clean is not tracked. A file a later command
  // overwrites stops carrying the marker.
  const outputs = new Set();
  for (const part of parts) {
    const targets = writeTargets(part);
    if (STREAM_EDITOR.test(part) && scriptAddsMarker(part)) {
      const exact = simpleRedirectResult(part, cwd);
      if (exact && !addedMarker(exact.input, exact.output)) { for (const t of targets) outputs.delete(t.file); continue; }
      if (!exact && targets.some(t => TEST_PATH.test(t.file))) return true;
      for (const t of targets) outputs.add(t.file);
      continue;
    }
    if (outputs.size) {
      const words = [...part.matchAll(SHELL_WORD)].map(([, dq, sq, bare]) => dq ?? sq ?? unesc(bare));
      if (words.some(w => outputs.has(w)) && (copiesOntoTest(part) || targets.some(t => TEST_PATH.test(t.file)))) return true;
    }
    for (const t of targets) outputs.delete(t.file);
  }
  return false;
}

// The file is read only when its path does not already say test and the
// change itself has no test definition in it.
function isTestFile(filePath, cwd, ...texts) {
  if (TEST_PATH.test(filePath)) return true;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const definition = Object.hasOwn(TEST_DEFINITION, ext) ? TEST_DEFINITION[ext] : null;
  if (!definition) return false;
  if (texts.some(t => typeof t === 'string' && definition.test(t))) return true;
  const existing = readExisting(filePath, cwd);
  return existing !== null && definition.test(existing);
}

// An edit can complete a marker with text outside the replaced span: turning
// `('adds'` into `.skip('adds'` right after `it` writes `it.skip(`. So the
// file is judged as it will be after the edits. When it cannot be read, the
// strings are tried with every start of a test-function name in front.
const EDIT_CONTEXT = ['', ...new Set(['it', 'test', 'describe', 'context', 'specify', 'suite']
  .flatMap(w => [...w].map((_, i) => w.slice(0, i + 1))))];

// Replay stops (returns null) when an edit does not apply, hits an
// ambiguous spot, or would outgrow the read limit; the string checks then
// decide.
function applyEdits(content, edits) {
  for (const e of edits) {
    const from = e && e.old_string;
    if (typeof from !== 'string' || !from || !content.includes(from)) return null;
    const to = typeof e.new_string === 'string' ? e.new_string : '';
    const count = content.split(from).length - 1;
    // Which occurrence a single replacement hits is unknown when there are
    // several (a Codex patch hunk can repeat elsewhere in the file).
    if (!e.replace_all && count > 1) return null;
    if (content.length + count * (to.length - from.length) > MAX_READ_BYTES) return null;
    content = e.replace_all ? content.split(from).join(to) : content.replace(from, () => to);
  }
  return content;
}

// The final file decides when it can be computed, so a marker added and
// removed again within one MultiEdit is not a skip.
function editAddsMarker(edits, filePath, cwd) {
  const before = readExisting(filePath, cwd);
  const after = before === null ? null : applyEdits(before, edits);
  if (after !== null) return addedMarker(before, after);
  if (edits.some(e => addedMarker(e && e.old_string, e && e.new_string))) return true;
  return edits.some(e => EDIT_CONTEXT.some(pre =>
    addedMarker(pre + ((e && e.old_string) || ''), pre + ((e && e.new_string) || ''))));
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
    if (dropsTestSuite(cmd) || deletesInTestDir(cmd, cwd)) return deny('critical', 'delete-test', 'deleting test file(s) or test directory');
    const moved = moveVerdict(cmd, cwd);
    if (moved === 'delete-test') return deny('critical', 'delete-test', 'deleting test file(s) or test directory');
    // At the critical level a rename is allowed, but the delete checks below must still run.
    if (moved === 'rename-test' && LEVELS.high <= threshold) return deny('high', 'rename-test', 'renaming a test file to a disabled name');
    if (pairedWith(cmd, c => DELETE_VERB.test(c))) return deny('critical', 'delete-test', 'deleting test file(s) or test directory');
    if (pairedWith(cmd, c => RENAME_VERB.test(c) && DISABLED_DEST.test(c)))
      return deny('high', 'rename-test', 'renaming a test file to a disabled name');
    // Runs without the TEST_TOKEN gate: it finds its own test target per command,
    // which a glob (find -name '*.test.js' | xargs sed -i) never puts in TEST_TOKEN.
    if (shellAddsMarker(cmd, cwd))
      return deny('high', 'skip-test', 'adding a skip/xfail/ignore marker to a test file from the shell');
    return allow();
  }

  if (toolName === 'Edit') {
    const file = toolInput.file_path || '';
    if (isTestFile(file, cwd, toolInput.old_string, toolInput.new_string) && editAddsMarker([toolInput], file, cwd))
      return deny('high', 'skip-test', 'adding a skip/xfail/ignore marker to an existing test');
    return allow();
  }

  if (toolName === 'MultiEdit') {
    const file = toolInput.file_path || '';
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : [];
    if (isTestFile(file, cwd, ...edits.flatMap(e => [e && e.old_string, e && e.new_string])) && editAddsMarker(edits, file, cwd))
      return deny('high', 'skip-test', 'adding a skip/xfail/ignore marker to an existing test');
    return allow();
  }

  if (toolName === 'Write') {
    const file = toolInput.file_path || '';
    if (!addedMarker('', toolInput.content) || !isTestFile(file, cwd, toolInput.content)) return allow();
    const existing = readExisting(file, cwd);
    if (existing !== null && addedMarker(existing, toolInput.content))
      return deny('high', 'skip-test', 'rewriting an existing test file with a new skip/xfail/ignore marker');
    if (addedMarker('', toolInput.content))
      return deny('strict', 'write-skipped-test', 'writing a test file that is already skipped/ignored');
    return allow();
  }

  return allow();
}

// A check that throws must not read as an allow, so the call is denied.
// HOOK_FAIL_OPEN=true restores the old allow-on-error behaviour.
function guardError(e) {
  if (process.env.HOOK_FAIL_OPEN === 'true') return '{}';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `🚨 [guard-error] protect-tests could not check this call (${String(e && e.message).slice(0, 200)}), so it is blocked. Run it yourself if you meant it, or set HOOK_FAIL_OPEN=true to let calls through when a guard fails.`,
    },
  });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
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
    console.log(data !== null && typeof data === 'object' ? guardError(e) : '{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { SKIP_MARKERS, TEST_PATH, LEVELS, SAFETY_LEVEL, checkTool };
}
