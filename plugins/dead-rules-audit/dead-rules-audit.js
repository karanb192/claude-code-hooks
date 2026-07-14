#!/usr/bin/env node
/**
 * Dead Rules Audit - CLAUDE.md compliance flight-recorder (observability)
 *
 * Parses CLAUDE.md into numbered atomic rules at SessionStart, then on every
 * Edit/Write passively tallies — per rule — how often it was RELEVANT to the
 * change and whether it was FOLLOWED or VIOLATED. Tallies persist in a local
 * JSONL ledger under ~/.claude/dead-rules-audit/. At SessionEnd (and on manual
 * invocation) it renders a worst-first compliance scorecard: rule text, times
 * relevant, times violated, compliance %, plus a "promote to hook?" suggestion
 * for chronically-ignored rules. Zero deps, zero network, fully deterministic.
 *
 * Registers on THREE events (branch on hook_event_name):
 *   - SessionStart : parse CLAUDE.md, snapshot which rules loaded this session
 *   - PostToolUse (Edit|Write) : score the diff against each rule, update ledger
 *   - SessionEnd   : render the compliance scorecard via `systemMessage`
 * The SessionEnd scorecard is surfaced to you through `systemMessage` (a
 * universal hook-output field the docs show to the user across all events) and
 * is ALSO persisted to ~/.claude/hooks-logs/<date>.jsonl (SCORECARD entries) so
 * it stays durable and re-viewable. You can re-render on demand any time with
 * the --render flag (`node dead-rules-audit.js --render`, e.g. as a weekly
 * maintenance/cron command) or by piping an explicit
 * `{"hook_event_name":"Manual"}` payload. On malformed, empty, or unrecognized
 * stdin the hook prints `{}` and exits 0 — a hook must never turn garbage input
 * into output.
 *
 * COST CAVEAT (verified, issue #11008): hooks do NOT receive token/cost data.
 * The "relevant vs violated" judgement here is a deterministic keyword/pattern
 * heuristic — no model call, no network. An optional Haiku prompt-hook can be
 * layered on top for fuzzier judgement (documented below) but is NOT required
 * and tests never touch the network.
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "SessionStart": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/dead-rules-audit.js" }]
 *     }],
 *     "PostToolUse": [{
 *       "matcher": "Edit|Write",
 *       "hooks": [{ "type": "command", "command": "node /path/to/dead-rules-audit.js" }]
 *     }],
 *     "SessionEnd": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/dead-rules-audit.js" }]
 *     }]
 *   }
 * }
 *
 * Or install as a plugin (no settings.json edit needed):
 *   /plugin install dead-rules-audit@claude-code-hooks
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function home() {
  return process.env.HOME || os.homedir();
}

const LOG_DIR = () => path.join(home(), '.claude', 'hooks-logs');
const STATE_DIR = () => path.join(home(), '.claude', 'dead-rules-audit');

// A rule is flagged "promote to hook?" when it is violated at least this often
// AND its violation rate crosses PROMOTE_RATE.
const PROMOTE_MIN_VIOLATIONS = 3;
const PROMOTE_RATE = 0.5;
// Cost/latency guard: never read a CLAUDE.md bigger than this many bytes,
// never keep more than this many rules.
const MAX_CLAUDE_MD_BYTES = 256 * 1024;
const MAX_RULES = 200;
// Session parse caches left behind by crashed sessions (SessionEnd never fired)
// are pruned after this many milliseconds.
const SESSION_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function log(data) {
  try {
    const dir = LOG_DIR();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'dead-rules-audit', ...data }) + '\n');
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule parsing — turn a CLAUDE.md into numbered, atomic, scorable rules.
// ─────────────────────────────────────────────────────────────────────────────

// Directive-y lines that read as an actual instruction, not prose/headings.
const DIRECTIVE_RE = /\b(always|never|do not|don'?t|must|should|prefer|avoid|use|don'?t use|ensure|require[sd]?|no |only |use only|make sure|keep|write|run)\b/i;

// Strip markdown scaffolding but KEEP inline `code` backticks — they carry the
// highest-signal tokens for relevance matching (see ruleKeywords).
function stripMarkdown(line) {
  return line
    .replace(/^[-*+]\s+/, '')          // bullet
    .replace(/^\d+[.)]\s+/, '')        // ordered list "1. "
    .replace(/^#{1,6}\s+/, '')         // heading marker
    .replace(/^>\s+/, '')              // blockquote
    .replace(/[*_]/g, '')              // inline emphasis (leave ` for ruleKeywords)
    .trim();
}

// Human-facing rule text: strip the leftover backticks for display.
function displayText(cleaned) {
  return cleaned.replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

// Build a compact set of keyword tokens used for relevance matching.
function ruleKeywords(text) {
  const STOP = new Set([
    'always', 'never', 'do', 'not', 'dont', 'must', 'should', 'prefer', 'avoid',
    'use', 'ensure', 'require', 'requires', 'required', 'only', 'no', 'make',
    'sure', 'keep', 'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or',
    'with', 'this', 'that', 'when', 'all', 'any', 'is', 'are', 'be', 'you', 'your',
    'we', 'it', 'if', 'as', 'at', 'by', 'from', 'into', 'run', 'write', 'code',
  ]);
  const words = new Set();
  const codey = new Set();
  // Preserve `code`/`file.ext` tokens — they are the strongest relevance signal.
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const inner = m[1].toLowerCase().trim();
    // A backticked token that looks like a file extension (.ts, .min.js) is kept
    // whole so path-suffix matching works in isRelevant/judge.
    const extMatch = inner.match(/(\.[a-z0-9]+(?:\.[a-z0-9]+)*)$/);
    if (extMatch && inner.startsWith('.')) codey.add(inner);
    for (const tok of inner.split(/[\s(){}.,;:]+/)) {
      const t = tok.trim();
      if (t.length > 1) codey.add(t);
    }
  }
  for (const raw of text.toLowerCase().split(/[^a-z0-9_.$/-]+/)) {
    const w = raw.trim();
    if (w.length < 3) continue;
    if (STOP.has(w)) continue;
    words.add(w);
  }
  return { words: [...words], codey: [...codey] };
}

// Detect whether a rule is a hard prohibition (never/do not/avoid) — those are
// the ones we can meaningfully flag as VIOLATED from a diff heuristic.
function isProhibition(text) {
  return /\b(never|do not|don'?t|avoid|no longer|must not|cannot)\b/i.test(text);
}

function parseRules(mdText) {
  const rules = [];
  if (!mdText || typeof mdText !== 'string') return rules;
  const lines = mdText.split(/\r?\n/);
  let inFence = false;
  let n = 0;
  for (const rawLine of lines) {
    const fence = /^\s*(?:```|~~~)/.test(rawLine);
    if (fence) { inFence = !inFence; continue; }
    if (inFence) continue;
    // A line is a candidate rule only if it is structurally instruction-shaped:
    // a list item (bullet/numbered) or blockquote. Free-flowing prose sentences
    // that merely mention "never"/"use" mid-sentence are NOT rules.
    const isListItem = /^\s*(?:[-*+]|\d+[.)])\s+/.test(rawLine) || /^\s*>\s+/.test(rawLine);
    const cleaned = stripMarkdown(rawLine);      // still has `backticks`
    const display = displayText(cleaned);        // human-readable, no ticks
    if (display.length < 6) continue;
    if (!DIRECTIVE_RE.test(display)) continue;
    // Non-list lines qualify only if the imperative leads the sentence AND the
    // line is short/checklist-y — otherwise it is almost certainly prose.
    const startsImperative = /^(always|never|do not|don'?t|must|should|prefer|avoid|use|ensure|require|no |only |keep|make sure|write|run)\b/i.test(display);
    if (!isListItem && !startsImperative) continue;
    // Skip long prose sentences even if they lead with a directive-ish word.
    if (!isListItem && display.split(/\s+/).length > 18) continue;
    n += 1;
    if (n > MAX_RULES) break;
    rules.push({
      id: n,
      text: display.length > 240 ? display.slice(0, 237) + '...' : display,
      prohibition: isProhibition(display),
      keywords: ruleKeywords(cleaned),          // parse tokens from ticked text
    });
  }
  return rules;
}

// Find the nearest CLAUDE.md walking up from cwd, then fall back to ~/.claude.
function findClaudeMd(cwd) {
  const candidates = [];
  let dir = cwd && fs.existsSync(cwd) ? path.resolve(cwd) : null;
  let guard = 0;
  while (dir && guard < 40) {
    candidates.push(path.join(dir, 'CLAUDE.md'));
    candidates.push(path.join(dir, '.claude', 'CLAUDE.md'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    guard += 1;
  }
  candidates.push(path.join(home(), '.claude', 'CLAUDE.md'));
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile() && st.size > 0 && st.size <= MAX_CLAUDE_MD_BYTES) return c;
    } catch {}
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring — deterministic heuristic judgement of a single Edit/Write diff.
// ─────────────────────────────────────────────────────────────────────────────

// Pull the text that Claude is trying to introduce from a tool_input payload.
function extractAddedText(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const parts = [];
  if (typeof toolInput.content === 'string') parts.push(toolInput.content);       // Write
  if (typeof toolInput.new_string === 'string') parts.push(toolInput.new_string); // Edit
  if (Array.isArray(toolInput.edits)) {                                            // MultiEdit-ish
    for (const e of toolInput.edits) {
      if (e && typeof e.new_string === 'string') parts.push(e.new_string);
    }
  }
  return parts.join('\n');
}

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  return typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
}

// A rule is RELEVANT to a change when its distinctive keywords / code tokens
// appear in either the target file path or the introduced text. Matching is
// whole-word (containsToken) so `any` does not fire on `company` and `log`
// does not fire on `blog.ts`.
function isRelevant(rule, filePath, addedText) {
  const hayFile = (filePath || '').toLowerCase();
  const hayText = (addedText || '').toLowerCase();
  const kw = rule.keywords || { words: [], codey: [] };
  // Code tokens are the highest-signal relevance match.
  for (const c of kw.codey) {
    if (c.startsWith('.') && hayFile.endsWith(c)) return true; // extension rule
    if (containsToken(hayText, c) || containsToken(hayFile, c)) return true;
  }
  let hits = 0;
  for (const w of kw.words) {
    if (containsToken(hayText, w) || containsToken(hayFile, w)) hits += 1;
    if (hits >= 2) return true; // two distinct keyword hits => relevant
  }
  return false;
}

// Strip source comments so a prohibited token that is only *mentioned* in a
// comment ("// replaced console.log with logger") does not read as a violation.
// Deliberately conservative: handles the common //, #, and /* */ comment forms
// that cover JS/TS/Py/sh/CSS. Non-comment code is preserved verbatim.
function stripComments(text) {
  if (!text) return '';
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // /* block */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')  // // line (skip :// in URLs)
    .replace(/(^|\s)#[^\n]*/g, '$1')       // # line (shell/py/yaml)
    .replace(/<!--[\s\S]*?-->/g, ' ');     // <!-- html -->
}

// Match a token as a *whole word* rather than a substring, so the prohibition
// `log` does not fire on `logger` and `any` does not fire on `company`. Token
// boundaries respect code punctuation (a dot counts as a boundary so that
// `console.log` still matches both `console` and `log`).
function containsToken(hay, token) {
  if (!hay || !token) return false;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A "word char" for our purposes excludes '.' so member accesses split.
  const re = new RegExp(`(^|[^a-z0-9_$])${esc}(?![a-z0-9_$])`, 'i');
  return re.test(hay);
}

// For a RELEVANT prohibition rule, decide FOLLOWED vs VIOLATED by checking
// whether the prohibited token was actually introduced as live code (comments
// are stripped first, matching is whole-word).
//
// Only prohibitions that name a concrete code token (backticked `identifier` or
// `.ext`) are judgeable. Everything else is UN-JUDGEABLE and counted as
// relevant-only (judged=false, never violated):
//   - non-prohibitions ("Always run tests", "Prefer X over Y") — a diff can't
//     prove they were followed or broken;
//   - word-only prohibitions ("Never leave debugging statements") — their
//     violation tokens would be the same generic words that made them relevant,
//     so "relevant" would collapse into "violated" and manufacture false
//     violations. They still surface as "seen" (advisory) on the scorecard.
//
// NOTE: this remains a HEURISTIC upper bound on violations — it counts a
// prohibited token appearing in newly-added live code, which usually but not
// always means the rule was broken. The scorecard labels the figure accordingly.
function judge(rule, filePath, addedText) {
  const relevant = isRelevant(rule, filePath, addedText);
  if (!relevant) return { relevant: false, violated: false };
  const kw = rule.keywords || { words: [], codey: [] };
  if (!rule.prohibition || !kw.codey.length) {
    return { relevant: true, violated: false, judged: false };
  }
  const codeText = stripComments(addedText || '');
  const hayFile = (filePath || '').toLowerCase();
  // Violated if a prohibited code token / extension shows up in live code.
  for (const c of kw.codey) {
    if (c.startsWith('.') && hayFile.endsWith(c)) return { relevant: true, violated: true, judged: true };
    if (containsToken(codeText, c)) return { relevant: true, violated: true, judged: true };
  }
  return { relevant: true, violated: false, judged: true };
}

// Ledger entries are keyed by a stable hash of the rule TEXT, not the rule's
// positional id: ids renumber whenever CLAUDE.md is edited, and the ledger is
// shared across projects — keying by id would merge unrelated rules' tallies.
function ruleKey(rule) {
  return crypto.createHash('sha1').update(String(rule.text)).digest('hex').slice(0, 12);
}

// Apply one diff to a ledger object (in place) and return the touched rule ids.
function scoreDiff(ledger, rules, filePath, addedText) {
  const touched = [];
  for (const rule of rules) {
    const verdict = judge(rule, filePath, addedText);
    if (!verdict.relevant) continue;
    const key = ruleKey(rule);
    const entry = ledger.rules[key] || (ledger.rules[key] = {
      id: rule.id, text: rule.text, prohibition: rule.prohibition,
      relevant: 0, violated: 0, judged: 0,
    });
    entry.id = rule.id; // display id from the latest parse
    entry.relevant += 1;
    if (verdict.judged) entry.judged += 1;
    if (verdict.violated) entry.violated += 1;
    touched.push({ id: rule.id, violated: !!verdict.violated });
  }
  ledger.diffs = (ledger.diffs || 0) + 1;
  return touched;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger persistence — one JSONL row per event, plus a rolled-up state file.
// ─────────────────────────────────────────────────────────────────────────────

function ledgerPath() {
  return path.join(STATE_DIR(), 'ledger.json');
}

function emptyLedger() {
  return { rules: {}, diffs: 0, sessions: 0, updated: null };
}

function loadLedger() {
  try {
    const raw = fs.readFileSync(ledgerPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.rules) return parsed;
  } catch {}
  return emptyLedger();
}

// Write-temp-then-rename so a concurrent reader never sees a torn file. This
// does not serialize concurrent sessions (a simultaneous read-modify-write can
// still lose one increment) but it guarantees the ledger stays parseable, and a
// lost tally is self-healing noise in a heuristic counter.
function saveLedger(ledger) {
  const dir = STATE_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ledger.updated = new Date().toISOString();
  const target = ledgerPath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  fs.renameSync(tmp, target);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scorecard rendering — the screenshot-able artifact.
// ─────────────────────────────────────────────────────────────────────────────

function compliancePct(entry) {
  // Compliance is measured over JUDGED (prohibition) observations. When nothing
  // could be judged, compliance is unknown (null) — reported as "n/a".
  if (!entry.judged) return null;
  return Math.round(((entry.judged - entry.violated) / entry.judged) * 100);
}

function shouldPromote(entry) {
  return entry.violated >= PROMOTE_MIN_VIOLATIONS &&
    entry.judged > 0 &&
    (entry.violated / entry.judged) >= PROMOTE_RATE;
}

// Sort worst-first: highest violation count, then lowest compliance %.
function rankRules(ledger) {
  const rows = Object.values(ledger.rules || {});
  return rows.sort((a, b) => {
    if (b.violated !== a.violated) return b.violated - a.violated;
    const pa = compliancePct(a); const pb = compliancePct(b);
    const na = pa === null ? 101 : pa; const nb = pb === null ? 101 : pb;
    if (na !== nb) return na - nb;
    return b.relevant - a.relevant;
  });
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function renderScorecard(ledger) {
  const rows = rankRules(ledger);
  const lines = [];
  lines.push('┌─ CLAUDE.md Dead-Rules Audit ' + '─'.repeat(40));
  const totalViol = rows.reduce((s, r) => s + r.violated, 0);
  const totalJudged = rows.reduce((s, r) => s + r.judged, 0);
  const overall = totalJudged ? Math.round(((totalJudged - totalViol) / totalJudged) * 100) : null;
  lines.push(`│ ${rows.length} rules tracked · ${ledger.diffs || 0} diffs observed · ${ledger.sessions || 0} sessions`);
  lines.push(`│ overall compliance on judgeable rules: ${overall === null ? 'n/a' : overall + '%'} (heuristic est.)`);
  lines.push('├' + '─'.repeat(68));
  if (rows.length === 0) {
    lines.push('│ No rules have been exercised yet — edit some files and check back.');
    lines.push('└' + '─'.repeat(68));
    return lines.join('\n');
  }
  lines.push(`│ ${pad('#', 3)} ${pad('rule', 34)} ${pad('rel', 4)} ${pad('viol', 5)} ${pad('comp', 5)} flag`);
  lines.push('├' + '─'.repeat(68));
  for (const r of rows.slice(0, 20)) {
    const pct = compliancePct(r);
    const flag = shouldPromote(r) ? '⚠ promote→hook' : (r.judged === 0 ? '· advisory' : '');
    lines.push(`│ ${pad(r.id, 3)} ${pad(r.text, 34)} ${pad(r.relevant, 4)} ${pad(r.violated, 5)} ${pad(pct === null ? 'n/a' : pct + '%', 5)} ${flag}`);
  }
  const promote = rows.filter(shouldPromote);
  if (promote.length) {
    lines.push('├' + '─'.repeat(68));
    lines.push('│ Suggested promotions (Claude ignores these — make them deterministic):');
    for (const r of promote) {
      lines.push(`│   #${r.id} "${r.text}" — violated ${r.violated}/${r.judged}`);
    }
  }
  lines.push('└' + '─'.repeat(68));
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Session state — remember which rules loaded for THIS session so we can re-use
// the parse across many PostToolUse calls without re-reading CLAUDE.md.
// ─────────────────────────────────────────────────────────────────────────────

function sessionStatePath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
  return path.join(STATE_DIR(), `session-${safe}.json`);
}

function loadSessionState(sessionId) {
  try {
    const raw = fs.readFileSync(sessionStatePath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.rules)) return parsed;
  } catch {}
  return null;
}

function saveSessionRules(sessionId, rules, source) {
  const dir = STATE_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let mtimeMs = null;
  let size = null;
  if (source) {
    try {
      const st = fs.statSync(source);
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch {}
  }
  fs.writeFileSync(
    sessionStatePath(sessionId),
    JSON.stringify({ source, mtimeMs, size, ts: new Date().toISOString(), rules })
  );
}

// Remove parse caches abandoned by crashed sessions (SessionEnd never fired),
// so ~/.claude/dead-rules-audit does not grow without bound.
function pruneStaleSessionState() {
  try {
    const dir = STATE_DIR();
    const cutoff = Date.now() - SESSION_STATE_TTL_MS;
    for (const f of fs.readdirSync(dir)) {
      if (!/^session-.*\.json$/.test(f)) continue;
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch {}
    }
  } catch {}
}

// Rebuild the session's rule set lazily if SessionStart never ran (e.g. hook
// only registered on PostToolUse), and re-parse when CLAUDE.md changed on disk
// mid-session (mtime/size drift) so the session never scores against stale
// rules. Cheap and cost-bounded: one stat per PostToolUse.
function ensureSessionRules(sessionId, cwd) {
  const state = loadSessionState(sessionId);
  if (state) {
    if (!state.source) return state.rules; // no CLAUDE.md at parse time
    try {
      const st = fs.statSync(state.source);
      if (st.mtimeMs === state.mtimeMs && st.size === state.size) return state.rules;
    } catch {
      // Source vanished — fall through and re-resolve from scratch.
    }
  }
  const mdPath = findClaudeMd(cwd);
  if (!mdPath) { saveSessionRules(sessionId, [], null); return []; }
  let text = '';
  try { text = fs.readFileSync(mdPath, 'utf-8'); } catch { return []; }
  const rules = parseRules(text);
  saveSessionRules(sessionId, rules, mdPath);
  return rules;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleSessionStart(data) {
  pruneStaleSessionState();
  const mdPath = findClaudeMd(data.cwd);
  if (!mdPath) {
    saveSessionRules(data.session_id, [], null);
    log({ level: 'SESSION_START', rules: 0, reason: 'no CLAUDE.md found', session_id: data.session_id });
    return {};
  }
  let text = '';
  try { text = fs.readFileSync(mdPath, 'utf-8'); } catch { return {}; }
  const rules = parseRules(text);
  saveSessionRules(data.session_id, rules, mdPath);
  log({ level: 'SESSION_START', source: mdPath, rules: rules.length, session_id: data.session_id });
  return {};
}

function handlePostToolUse(data) {
  const tool = data.tool_name;
  if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return {};
  const rules = ensureSessionRules(data.session_id, data.cwd);
  if (!rules.length) return {};
  const filePath = extractFilePath(data.tool_input);
  const addedText = extractAddedText(data.tool_input);
  if (!addedText && !filePath) return {};
  const ledger = loadLedger();
  const touched = scoreDiff(ledger, rules, filePath, addedText);
  saveLedger(ledger);
  const violations = touched.filter(t => t.violated);
  if (touched.length) {
    log({
      level: 'SCORED', file: filePath, session_id: data.session_id,
      relevant_rules: touched.map(t => t.id), violated_rules: violations.map(t => t.id),
    });
  }
  return {};
}

function handleSessionEnd(data) {
  const ledger = loadLedger();
  ledger.sessions = (ledger.sessions || 0) + 1;
  saveLedger(ledger);
  const card = renderScorecard(ledger);
  const promote = rankRules(ledger).filter(shouldPromote);
  // Surface the scorecard to the user via systemMessage (a universal hook-output
  // field the docs display across all events) AND persist the full card to the
  // JSONL log so it stays durable and re-renderable via
  // `node dead-rules-audit.js --render`. Then clean up this session's parse cache.
  log({
    level: 'SCORECARD', session_id: data.session_id, tracked: Object.keys(ledger.rules).length,
    promote: promote.map(r => r.id), card,
  });
  try { fs.unlinkSync(sessionStatePath(data.session_id)); } catch {}
  return { systemMessage: '\n' + card + '\n' };
}

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

// On-demand scorecard for manual invocation — `node dead-rules-audit.js --render`
// prints the same worst-first card the SessionEnd hook renders, straight to
// stdout (plain text, never a hook JSON envelope), without reading stdin. This is
// the ONLY no-stdin render path and it powers the /dead-rules-audit:scorecard
// skill. It degrades to a friendly message on empty state and NEVER throws.
function renderCli() {
  try {
    process.stdout.write('\n' + renderScorecard(loadLedger()) + '\n');
  } catch (e) {
    process.stdout.write(
      '\ndead-rules-audit: could not render scorecard (' + (e && e.message) + ')\n'
    );
  }
}

async function main() {
  let input = '';
  try {
    input = await readStdin();
  } catch {
    process.stdout.write('{}');
    return;
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch {
    // Empty or malformed stdin is NOT a render request — a hook must never turn
    // garbage input into a scorecard. Emit a no-op and exit cleanly.
    process.stdout.write('{}');
    return;
  }

  try {
    const event = data && data.hook_event_name;
    let out = {};
    if (event === 'SessionStart') out = handleSessionStart(data);
    else if (event === 'PostToolUse') out = handlePostToolUse(data);
    else if (event === 'SessionEnd') out = handleSessionEnd(data);
    else if (event === 'Manual') {
      // Explicit, well-formed manual payload — the documented scripted way to
      // fetch the card as hook-shaped JSON.
      out = { systemMessage: '\n' + renderScorecard(loadLedger()) + '\n' };
    }
    // Any other/missing event name is a deliberate no-op ({}).
    process.stdout.write(JSON.stringify(out || {}));
  } catch (e) {
    log({ level: 'ERROR', error: e && e.message });
    process.stdout.write('{}');
  }
}

if (require.main === module) {
  if (process.argv.includes('--render')) {
    renderCli();
  } else {
    main();
  }
} else {
  module.exports = {
    parseRules, stripMarkdown, displayText, ruleKeywords, isProhibition, isRelevant, judge,
    stripComments, containsToken,
    scoreDiff, ruleKey, extractAddedText, extractFilePath, findClaudeMd,
    emptyLedger, compliancePct, shouldPromote, rankRules, renderScorecard,
    PROMOTE_MIN_VIOLATIONS, PROMOTE_RATE,
    handleSessionStart, handlePostToolUse, handleSessionEnd,
    renderCli,
  };
}
