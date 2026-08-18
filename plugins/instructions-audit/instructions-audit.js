#!/usr/bin/env node
/**
 * Instructions Audit - InstructionsLoaded Hook
 * Audits CLAUDE.md / .claude/rules/*.md content as it is loaded into context
 * and halts the session when the file carries hidden or hostile directives:
 * invisible Unicode smuggling (the TrapDoor campaign signature), directives
 * that read or exfiltrate secret material, remote content piped to a shell,
 * decode-and-execute constructs, and directives that make the agent rewrite
 * its own hook or settings configuration. Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict'
 *   critical - invisible Unicode smuggling (zero width, tag characters,
 *              invisible operators, variation-selector runs), bidi overrides,
 *              decode-and-execute
 *   high     - + secret read/exfil directives, curl|sh, hook/settings tampering
 *   strict   - + soft hyphens, invisible direction marks (legitimate in RTL
 *              prose), directives that write new instruction files
 * Env overrides: HOOK_AUDIT_LEVEL=critical|high|strict per registration.
 *
 * Event contract (docs at https://code.claude.com/docs/en/hooks, then
 * verified live): InstructionsLoaded has no decision control, its exit code
 * is ignored, and current Claude Code builds ignore even the universal
 * continue:false on this event, so nothing on the event itself can stop the
 * session. Detection and enforcement are therefore split:
 * - The InstructionsLoaded registration audits the file, records a
 *   per-session lockdown flag on a finding, and still emits
 *   { "continue": false, "stopReason": ..., "systemMessage": ... } for
 *   builds that honor the universal fields.
 * - The SAME script registered on UserPromptSubmit and PreToolUse (both can
 *   block, verified) then denies every prompt and tool call for that
 *   session, so the poisoned instructions are never acted on. The lock
 *   message names the flag file; delete it to clear a false positive, or
 *   fix the instruction file and start a fresh session.
 * systemMessage and stderr name each rule that fired and the line it fired
 * on, so a human can inspect the file. Set HOOK_AUDIT_WARN_ONLY to the
 * literal string "true" to surface the warning without locking.
 *
 * Precision notes (false positives on normal CLAUDE.md content are the
 * failure mode here):
 * - Code fences are NOT exempt: fenced text in an instruction file still
 *   reads as instructions to the agent, and exempting fences would hand
 *   attackers a trivial wrapper bypass. A literal `curl ... | sh` install
 *   one-liner in your CLAUDE.md will be flagged; rewrite it as prose.
 * - Lines whose action verb is negated ("Never read the .env file") are
 *   treated as defensive prose and skipped by the directive rules. That is
 *   a deliberate, bypassable tradeoff: the PreToolUse hooks in this repo
 *   still block the actual execution, this hook is the earlier tripwire.
 * - Emoji ZWJ sequences and joiners inside non-ASCII joining-script text
 *   (Arabic, Indic conjuncts) are exempt from the invisible-char rules; a
 *   UTF-8 BOM at offset 0 is exempt too.
 *
 * Setup (plugin, recommended):
 *   /plugin marketplace add karanb192/claude-code-hooks   # once per machine
 *   /plugin install instructions-audit@claude-code-hooks
 * The plugin registers all three arms automatically (InstructionsLoaded for
 * detection, UserPromptSubmit and PreToolUse for enforcement); restart
 * Claude Code after install.
 *
 * Classic setup (copy this script somewhere stable) still works, via
 * .claude/settings.json (all three registrations, same script):
 * {
 *   "hooks": {
 *     "InstructionsLoaded": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/instructions-audit.js" }]
 *     }],
 *     "UserPromptSubmit": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/instructions-audit.js" }]
 *     }],
 *     "PreToolUse": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/instructions-audit.js" }]
 *     }]
 *   }
 * }
 * On InstructionsLoaded, omit "matcher" to audit every load reason, or set
 * one to narrow it, e.g. "session_start|nested_traversal|path_glob_match".
 * The UserPromptSubmit and PreToolUse registrations are the enforcement arm;
 * without them the hook can only warn on current builds.
 */

const fs = require('fs');
const path = require('path');

const SAFETY_LEVEL = 'high';

// Env overrides: HOOK_AUDIT_LEVEL picks the threshold per registration,
// HOOK_AUDIT_WARN_ONLY=true reports findings without halting the session.
const envBool = (key, fallback) => key in process.env ? process.env[key] === 'true' : fallback;

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🚨', high: '⛔', strict: '⚠️' };
const LOG_DIR = path.join(process.env.HOME, '.claude', 'hooks-logs');

// Secret material that instruction text has no business directing an agent at.
// Kept consistent with protect-secrets.js's sensitive-file list. The .env
// lookahead keeps .env.example / .env.template prose out of scope.
const SECRET_TERM =
  '(?:\\.env\\b(?!\\.example|\\.sample|\\.template|\\.schema|\\.defaults)' +
  '|\\.envrc\\b|id_rsa\\b|id_ed25519\\b|id_ecdsa\\b|id_dsa\\b|\\.ssh\\b' +
  '|\\.aws\\/credentials\\b|\\.pem\\b|\\.key\\b|credentials?\\.json\\b' +
  '|secrets?\\.(?:json|ya?ml|toml)\\b|(?:api|access|auth|private)[ _-]?(?:key|token)s?\\b' +
  '|\\.netrc\\b|\\.npmrc\\b|\\.pypirc\\b)';

// Directive patterns, matched line by line against instruction text.
// A plain mention of ".env" in prose must never fire; a directive to read it
// and send it somewhere must.
const TEXT_PATTERNS = [
  // CRITICAL - obfuscated execution has no legitimate place in instructions
  { level: 'critical', id: 'base64-exec',
    regex: /(?:\bbase64\b[^\n]*?\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\beval\b[^\n]{0,80}?\b(?:base64|atob)\b|\b(?:base64|atob)\b[^\n]{0,80}?\beval\b|\becho\s+["']?[A-Za-z0-9+/]{40,}={0,2}["']?\s*\|\s*base64\b)/i,
    reason: 'decode-and-execute construct hides the real payload' },

  // HIGH - reading or exfiltrating secret material, remote code to shell
  { level: 'high', id: 'secret-read-directive',
    regex: new RegExp('\\b(?:read|cat|open|print|dump|display|show|output|echo|paste|include|retrieve|reveal|expose|extract)\\b[^\\n]{0,60}?' + SECRET_TERM, 'i'),
    reason: 'directive to read secret material into context' },
  { level: 'high', id: 'secret-exfil',
    regex: new RegExp('(?:\\b(?:send|post|upload|submit|transmit|exfiltrate|forward|mail|email|pipe|attach|leak|share)\\b[^\\n]{0,80}?' + SECRET_TERM +
      '|' + SECRET_TERM + '[^\\n]{0,60}?\\b(?:to|into|toward)\\s+(?:https?:\\/\\/\\S+|(?:the\\s+)?(?:webhook|pastebin|ngrok|remote\\s+server|external\\s+(?:server|endpoint|url))\\b))', 'i'),
    reason: 'directive to exfiltrate secret material' },
  { level: 'high', id: 'curl-pipe-shell',
    regex: /\b(?:curl|wget)\b[^\n]*?\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
    reason: 'instruction pipes remote content into a shell' },

  // HIGH - the agent being told to rewrite its own guardrails
  { level: 'high', id: 'settings-tamper',
    regex: /\b(?:edit|modify|update|write|change|append|add|overwrite|replace|patch|rewrite|merge)\b[^\n]{0,80}?\.claude\/settings(?:\.local)?\.json/i,
    reason: 'directive to rewrite Claude Code settings' },
  { level: 'high', id: 'hook-tamper',
    regex: /\b(?:disable|bypass|remove|delete|uninstall|deactivate|turn\s+off|comment\s+out|skip|ignore)\b[^\n]{0,60}?(?:(?:claude|security|safety|permission|protection|all)\s+hooks?\b|[\w-]*(?:protect|guard|safet|securit|audit)[\w-]*\s+hooks?\b|hooks?\.json\b|\.claude\/hooks\b|guard-?rails?\b|safety\s+checks?\b|permission\s+(?:checks?|prompts?)\b)/i,
    reason: 'directive to disable safety hooks or permission checks' },

  // STRICT - self-propagation: writing new instruction files
  { level: 'strict', id: 'instruction-file-write',
    regex: /\b(?:create|write|add|append|generate|save|drop|place|copy|prepend|insert)\b[^\n]{0,80}?(?:\.claude\/rules\/|\.cursorrules\b|\.windsurfrules\b|CLAUDE\.md\b|AGENTS\.md\b)/i,
    reason: 'directive to write new instruction files (self-propagation)' },
];

// Lines whose action verb is negated read as defensive prose, not directives:
// "Never commit your .env file" must pass. Bypassable by design; see header.
const NEGATION_CONTEXT = /\b(?:never|do\s+not|don'?t|must\s+not|should\s+not|shall\s+not|avoid|no\s+need\s+to|without|instead\s+of)[ ,]+(?:\w+[ ,-]+){0,4}?(?:read|cat|open|print|dump|display|show|output|echo|paste|include|retrieve|reveal|expose|extract|send|post|upload|submit|transmit|forward|mail|email|pipe|attach|leak|share|run|execute|curl|wget|commit|edit|modify|update|write|change|append|add|overwrite|replace|patch|rewrite|merge|disable|bypass|remove|delete|uninstall|deactivate|skip|ignore|create|generate|save|touch|access)(?:ing|e?s|e?d)?\b/i;

const CHAR_NAMES = {
  0x00AD: 'SOFT HYPHEN', 0x034F: 'COMBINING GRAPHEME JOINER', 0x061C: 'ARABIC LETTER MARK',
  0x180E: 'MONGOLIAN VOWEL SEPARATOR', 0x200B: 'ZERO WIDTH SPACE', 0x200C: 'ZERO WIDTH NON-JOINER',
  0x200D: 'ZERO WIDTH JOINER', 0x200E: 'LEFT-TO-RIGHT MARK', 0x200F: 'RIGHT-TO-LEFT MARK',
  0x2060: 'WORD JOINER', 0x2061: 'FUNCTION APPLICATION', 0x2062: 'INVISIBLE TIMES',
  0x2063: 'INVISIBLE SEPARATOR', 0x2064: 'INVISIBLE PLUS', 0xFEFF: 'ZERO WIDTH NO-BREAK SPACE',
  0x202A: 'LEFT-TO-RIGHT EMBEDDING', 0x202B: 'RIGHT-TO-LEFT EMBEDDING',
  0x202C: 'POP DIRECTIONAL FORMATTING', 0x202D: 'LEFT-TO-RIGHT OVERRIDE',
  0x202E: 'RIGHT-TO-LEFT OVERRIDE', 0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE', 0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
};

// Legitimate joiner contexts: emoji ZWJ sequences (pictographs, variation
// selector, skin tones) and joining-script text where both neighbors are
// letters and at least one is non-ASCII (Arabic, Indic conjuncts, ...).
const PICTOGRAPHIC = /[\p{Extended_Pictographic}\uFE0F\u{1F3FB}-\u{1F3FF}]/u;
const LETTER = /\p{L}/u;

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'instructions-audit', ...data }) + '\n');
  } catch {}
}

function codepointLabel(code) {
  const name = CHAR_NAMES[code] || (code >= 0xE0001 && code <= 0xE007F ? 'TAG CHARACTER' : 'UNKNOWN');
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')} ${name}`;
}

function charBefore(s, i) {
  if (i <= 0) return '';
  const code = s.charCodeAt(i - 1);
  if (code >= 0xDC00 && code <= 0xDFFF && i >= 2) return s.slice(i - 2, i);
  return s[i - 1];
}

function charAfter(s, i) {
  const cp = s.codePointAt(i);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function joinerExempt(content, i) {
  const prev = charBefore(content, i);
  const next = charAfter(content, i + 1);
  if ((prev && PICTOGRAPHIC.test(prev)) || (next && PICTOGRAPHIC.test(next))) return true;
  const nonAscii = (ch) => ch !== '' && ch.codePointAt(0) > 0x7f;
  if (prev && next && LETTER.test(prev) && LETTER.test(next) && (nonAscii(prev) || nonAscii(next))) return true;
  return false;
}

function invisibleCharRule(content, i, code) {
  if ((code >= 0x202A && code <= 0x202E) || (code >= 0x2066 && code <= 0x2069)) {
    return { level: 'critical', id: 'bidi-control', reason: 'bidirectional control character can reorder or mask instruction text' };
  }
  if (code >= 0xE0001 && code <= 0xE007F) {
    return { level: 'critical', id: 'tag-char', reason: 'Unicode tag characters encode a parallel invisible ASCII message' };
  }
  if (code === 0x200B || code === 0x2060 || (code >= 0x2061 && code <= 0x2064) ||
      code === 0x034F || code === 0x180E || (code === 0xFEFF && i !== 0)) {
    return { level: 'critical', id: 'zero-width-char', reason: 'zero width character can hide directives in instruction text' };
  }
  if ((code === 0x200C || code === 0x200D) && !joinerExempt(content, i)) {
    return { level: 'critical', id: 'zero-width-joiner', reason: 'zero width joiner outside emoji or joining-script text can hide characters inside words' };
  }
  if (code === 0x200E || code === 0x200F || code === 0x061C) {
    return { level: 'strict', id: 'bidi-mark', reason: 'invisible direction mark; legitimate in RTL prose, suspicious in ASCII instructions' };
  }
  if (code === 0x00AD) {
    return { level: 'strict', id: 'soft-hyphen', reason: 'soft hyphen is invisible in rendered text' };
  }
  return null;
}

// Variation selectors encode hidden data when chained (each selector can carry
// a byte); single selectors are legitimate emoji/CJK presentation, so only a
// run of 4 or more flags.
const isVariationSelector = (cp) => (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF);

function scanInvisibleChars(content, threshold, findings) {
  let line = 1;
  let col = 0;
  let vsRun = 0;
  let vsStart = null;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') { line++; col = 0; vsRun = 0; continue; }
    col++;
    if (content.charCodeAt(i) < 0xAD) { vsRun = 0; continue; } // fast path: ASCII
    const code = content.codePointAt(i); // astral-aware: tag chars are surrogate pairs
    if (isVariationSelector(code)) {
      if (vsRun === 0) vsStart = { line, column: col };
      vsRun++;
      if (vsRun === 4 && LEVELS.critical <= threshold) {
        findings.push({ level: 'critical', id: 'variation-selector-run', reason: 'a run of variation selectors can encode hidden data', ...vsStart, detail: 'variation selector sequence' });
      }
    } else {
      vsRun = 0;
      const rule = invisibleCharRule(content, i, code);
      if (rule && LEVELS[rule.level] <= threshold) {
        findings.push({ ...rule, line, column: col, detail: codepointLabel(code) });
      }
    }
    if (code > 0xFFFF) i++; // skip the low surrogate; the column counts code points
  }
}

// Strip the characters this hook hunts for out of quoted excerpts, so the
// report itself cannot smuggle or reorder text in the transcript.
function sanitizeExcerpt(line) {
  return line
    .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFE00-\uFE0F\uFEFF]|[\u{E0001}-\u{E007F}\u{E0100}-\u{E01EF}]/gu, '')
    .trim().slice(0, 96);
}

function scanDirectives(content, threshold, findings) {
  const lines = content.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (line.trim() === '' || NEGATION_CONTEXT.test(line)) continue;
    for (const p of TEXT_PATTERNS) {
      if (LEVELS[p.level] <= threshold && p.regex.test(line)) {
        findings.push({ level: p.level, id: p.id, reason: p.reason, line: n + 1, excerpt: sanitizeExcerpt(line) });
      }
    }
  }
}

// ─── session lockdown state ──────────────────────────────────────────────────
// The enforcement arm: a poisoned load writes a per-session flag; the
// UserPromptSubmit and PreToolUse registrations of this same script read it
// and deny everything for that session until a human clears it.

const STATE_DIR = path.join(process.env.HOME || '/tmp', '.claude', 'hooks-state', 'instructions-audit');

function flagPath(sessionId) {
  const safe = String(sessionId || 'unknown-session').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(STATE_DIR, `${safe}.json`);
}

function writeFlag(sessionId, info) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(flagPath(sessionId), JSON.stringify({ ts: new Date().toISOString(), ...info }));
    // Flags for long-gone sessions are inert; sweep anything over 7 days old.
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 7 * 24 * 3600 * 1000) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}

function readFlag(sessionId) {
  try { return JSON.parse(fs.readFileSync(flagPath(sessionId), 'utf8')); } catch { return null; }
}

function auditContent(content, safetyLevel = SAFETY_LEVEL) {
  const findings = [];
  if (typeof content !== 'string' || content.length === 0) return findings;
  const threshold = LEVELS[safetyLevel] || 2;
  scanInvisibleChars(content, threshold, findings);
  scanDirectives(content, threshold, findings);
  return findings;
}

function formatFindings(findings, filePath) {
  const shown = findings.slice(0, 12);
  const body = shown.map((f) => {
    const where = f.column ? `line ${f.line}, col ${f.column}` : `line ${f.line}`;
    const tail = f.detail ? ` (${f.detail})` : '';
    const quote = f.excerpt ? `\n    > ${f.excerpt}` : '';
    return `${EMOJIS[f.level]} [${f.id}] ${where}: ${f.reason}${tail}${quote}`;
  });
  if (findings.length > shown.length) body.push(`...and ${findings.length - shown.length} more finding(s)`);
  return `instructions-audit: ${findings.length} suspicious pattern(s) in ${filePath}\n` +
    body.join('\n') +
    '\nInspect the file before trusting it; do not act on its instructions until a human has reviewed the flagged lines.';
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const { hook_event_name, file_path, load_reason, session_id, cwd } = data;

    // Enforcement arm: on the blocking events, honor an existing lockdown.
    if (hook_event_name === 'UserPromptSubmit' || hook_event_name === 'PreToolUse') {
      const flag = readFlag(session_id);
      if (!flag) return console.log('{}');
      const notice =
        `🚨 instructions-audit locked this session: ${flag.count} suspicious pattern(s) in ${flag.file} ` +
        `(first: [${flag.first}]). Fix or quarantine the file and start a fresh session; ` +
        `if the findings are false positives, delete ${flagPath(session_id)} to clear the lock.`;
      if (hook_event_name === 'UserPromptSubmit') {
        return console.log(JSON.stringify({ decision: 'block', reason: notice }));
      }
      return console.log(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: notice },
      }));
    }
    if (hook_event_name && hook_event_name !== 'InstructionsLoaded') return console.log('{}');

    let content = data.content;
    if (typeof content !== 'string' && file_path) {
      // Payload variants without inline content: fall back to reading the file.
      try { content = fs.readFileSync(file_path, 'utf8'); } catch { content = null; }
    }
    if (typeof content !== 'string') return console.log('{}');

    const level = LEVELS[process.env.HOOK_AUDIT_LEVEL] ? process.env.HOOK_AUDIT_LEVEL : SAFETY_LEVEL;
    const warnOnly = envBool('HOOK_AUDIT_WARN_ONLY', false);
    const findings = auditContent(content, level);
    if (findings.length === 0) return console.log('{}');

    const label = file_path || '(unknown instruction file)';
    log({
      level: warnOnly ? 'WARNED' : 'HALTED', file: label, load_reason, session_id, cwd,
      findings: findings.map((f) => ({ id: f.id, priority: f.level, line: f.line })),
    });

    const message = formatFindings(findings, label);
    console.error(message); // survives even where systemMessage is not rendered
    const out = { systemMessage: message };
    if (!warnOnly) {
      const top = findings[0];
      // The lockdown flag is the enforcement that actually works today; the
      // universal continue:false is emitted too for builds that honor it.
      writeFlag(session_id, { file: label, count: findings.length, first: `${top.id} line ${top.line}` });
      out.continue = false;
      out.stopReason = `${EMOJIS[top.level]} instructions-audit locked the session: ${findings.length} suspicious pattern(s) in ${label} (first: [${top.id}] line ${top.line})`;
    }
    console.log(JSON.stringify(out));
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    TEXT_PATTERNS, LEVELS, SAFETY_LEVEL, NEGATION_CONTEXT,
    auditContent, formatFindings, sanitizeExcerpt, codepointLabel, flagPath,
  };
}
