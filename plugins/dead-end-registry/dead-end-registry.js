#!/usr/bin/env node
/**
 * Dead-End Registry - Approach-level negative-knowledge memory for Claude Code.
 *
 * Captures approaches that were TRIED and then REVERTED / ruled out (with reason,
 * date, and rough token cost of the detour) and stops you paying for the same
 * dead end twice. Four events, one script:
 *
 *   - Stop / SubagentStop : mine the transcript for abandoned approaches -> ~/.claude/dead-end-registry/<repo>.jsonl
 *   - PreCompact  : same mining, before context is compacted away
 *   - UserPromptSubmit : keyword-match the new prompt against the registry and
 *                        inject a "DEAD END - you already tried this" warning card
 *                        via additionalContext
 *   - PreToolUse (Edit|Write) : return permissionDecision 'ask' when the diff would
 *                        reintroduce a previously-reverted change (hunk similarity)
 *
 * Cost/token caveat (GitHub issue #11008): hooks do NOT receive token/cost numbers.
 * We estimate detour token cost by parsing usage on assistant messages in the
 * transcript JSONL (input.transcript_path). Degrades to a char-based estimate when
 * usage is absent, and omits the dollar figure when nothing can be estimated.
 *
 * The extraction is fully deterministic (revert-signal heuristics + tool-result
 * scanning). An OPTIONAL model pass can be layered on top by config, but is never
 * required and never contacted in tests.
 *
 * Scope + hygiene:
 *   - Registries are keyed per-project (hash of cwd) and live under
 *     ~/.claude/dead-end-registry/ — OUTSIDE the repo, so nothing here can be
 *     accidentally committed. A dead end mined in repo A never warns in repo B.
 *   - Entries expire after MAX_AGE_DAYS and the file is compacted at mine time,
 *     so the registry stays bounded and stale nags die off on their own.
 *   - Mined code snapshots are truncated (MAX_CODE_LINES/MAX_CODE_CHARS): they
 *     are verbatim transcript code and could contain secrets — keep them small,
 *     and never execute or shell out with any transcript content.
 *
 * Install as a plugin (recommended): /plugin install dead-end-registry@claude-code-hooks
 * — auto-wires all four events and adds the /dead-end-registry:dead-ends viewer.
 *
 * Or wire it up the classic way in .claude/settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/dead-end-registry.js" }]
 *     }],
 *     "SubagentStop": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/dead-end-registry.js" }]
 *     }],
 *     "PreCompact": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/dead-end-registry.js" }]
 *     }],
 *     "UserPromptSubmit": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/dead-end-registry.js" }]
 *     }],
 *     "PreToolUse": [{
 *       "matcher": "Edit|Write",
 *       "hooks": [{ "type": "command", "command": "node /path/to/dead-end-registry.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Constants / config
// ─────────────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || require('os').homedir();
const LOG_DIR = path.join(HOME, '.claude', 'hooks-logs');
const REGISTRY_DIR = path.join(HOME, '.claude', 'dead-end-registry');

// Approx blended $/token used only for a rough headline figure. Deliberately
// conservative; it is a "you paid roughly this much" signal, never billing truth.
const USD_PER_TOKEN = 0.000009; // ~$9 / 1M tokens (blended input+output ballpark)

// Latency / cost discipline: never read an unbounded transcript.
const MAX_TRANSCRIPT_BYTES = 6 * 1024 * 1024; // 6MB cap
const MAX_TRANSCRIPT_LINES = 6000;
const MAX_REGISTRY_ENTRIES = 500; // cap what we scan on prompt-submit
const MAX_CARD_ENTRIES = 3; // entries shown in an injected card
// Entries older than this are ignored on read and dropped at compaction time.
// The codebase moves on: a dead end from two months ago usually no longer
// applies (files rewritten, deps upgraded), and stale nags erode trust.
const MAX_AGE_DAYS = 60;
// Persisted code snapshots are truncated: enough lines for hunk matching to
// work, small enough that a mined 2MB Write (which might embed secrets or
// vendored blobs) never bloats the registry or every future prompt-submit read.
const MAX_CODE_LINES = 80;
const MAX_CODE_CHARS = 4000;

// Signals that a preceding approach was abandoned / reverted / ruled out.
// `weak: true` patterns describe a *symptom* rather than an explicit
// abandonment action. They are only trusted on assistant messages: a USER
// saying "the login page is broken" is a bug report, not a dead end, and
// mining it would poison the registry with false positives.
const REVERT_PATTERNS = [
  { id: 'reverted', regex: /\b(revert(?:ed|ing)?|rolled?\s+back|roll\s+back|backed\s+out)\b/i, reason: 'reverted' },
  { id: 'undo', regex: /\b(undo|undid|git\s+revert|git\s+reset\s+--hard|restore\s+the\s+old)\b/i, reason: 'undone' },
  { id: 'didnt-work', regex: /\b(didn['’]?t\s+work|does\s+not\s+work|doesn['’]?t\s+work|not\s+working|broke\s+(?:the|everything)|broken)\b/i, reason: "didn't work", weak: true },
  { id: 'abandon', regex: /\b(abandon(?:ed|ing)?|give\s+up|giving\s+up|gave\s+up|scrap(?:ped)?\s+that|drop\s+(?:this|that)\s+approach)\b/i, reason: 'abandoned' },
  { id: 'ruled-out', regex: /\b(ruled?\s+out|dead\s+end|won['’]?t\s+work|that\s+approach\s+(?:failed|is\s+wrong)|wrong\s+approach|bad\s+idea)\b/i, reason: 'ruled out' },
  // Defect nouns alone are NOT a signal ("this mutex avoids a race condition"
  // must not be mined). Require a causal verb: the change *caused* the defect.
  { id: 'race-cond', regex: /\b(?:caused|causing|introduced|introducing|created|hit|ran\s+into|led\s+to|resulted?\s+in|triggered)\b[^.!?\n]{0,120}?\b(?:race\s+condition|deadlock|infinite\s+loop|memory\s+leak|regression)\b/i, reason: 'caused a defect', weak: true },
];

// Nouns that usually name the *thing that was tried* — used to summarise the
// approach and to build the keyword fingerprint for later matching.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'but', 'we',
  'it', 'this', 'that', 'was', 'is', 'be', 'been', 'being', 'i', 'you', 'he',
  'she', 'they', 'them', 'as', 'at', 'by', 'with', 'from', 'so', 'if', 'then',
  'not', 'no', 'yes', 'do', 'did', 'does', 'have', 'has', 'had', 'will', 'would',
  'can', 'could', 'should', 'get', 'got', 'my', 'our', 'your', 'its', 'me', 'us',
  'up', 'out', 'now', 'just', 'back', 'try', 'tried', 'trying', 'approach',
  'thing', 'stuff', 'work', 'working', 'worked', 'again', 'because', 'after',
  // Conversational filler that carries no topical signal.
  'lets', 'sure', 'okay', 'onto', 'into', 'when', 'what', 'how', 'why',
  'where', 'which', 'there', 'here', 'some', 'more', 'very', 'much', 'want',
  'wants', 'need', 'needs', 'going', 'writing', 'making', 'really', 'actually',
  'also', 'like', 'well', 'about', 'please',
]);

// Keywords that appear in nearly every coding prompt. A prompt/entry overlap
// consisting ONLY of these ("fix the tests", "error in the build") must never
// fire a warning — that is the nag-until-uninstall failure mode. At least one
// overlapping keyword must be outside this set (a project-specific term like
// "websocket" or "worker_threads") before a card is injected.
const GENERIC_KEYWORDS = new Set([
  'fix', 'fixes', 'fixed', 'fixing', 'bug', 'bugs', 'error', 'errors',
  'issue', 'issues', 'problem', 'problems', 'fail', 'fails', 'failed',
  'failing', 'failure', 'failures', 'test', 'tests', 'testing', 'code',
  'file', 'files', 'folder', 'line', 'lines', 'function', 'functions',
  'method', 'methods', 'class', 'update', 'updates', 'updated', 'change',
  'changes', 'changed', 'changing', 'add', 'adds', 'added', 'adding',
  'remove', 'removes', 'removed', 'removing', 'refactor', 'refactoring',
  'implement', 'implementation', 'implementing', 'run', 'runs', 'running',
  'build', 'builds', 'building', 'check', 'checks', 'checking', 'write',
  'written', 'create', 'creates', 'created', 'creating', 'delete', 'deleted',
  'broken', 'breaking', 'breaks', 'help', 'still', 'make', 'makes',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Logging / paths
// ─────────────────────────────────────────────────────────────────────────────

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'dead-end-registry', ...data }) + '\n');
  } catch {}
}

/** Stable, filesystem-safe registry file name for a repo/cwd. */
function registryFileFor(cwd) {
  const key = cwd && String(cwd).trim() ? String(cwd).trim() : 'global';
  const slug = key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-40) || 'root';
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  return path.join(REGISTRY_DIR, `${slug}-${hash}.jsonl`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Text / fingerprint helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
    .split(/[^a-z0-9_./+#-]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/** Distinct significant keywords, most informative first, capped. */
function keywords(text, max = 12) {
  const seen = new Set();
  const out = [];
  for (const w of tokenize(text)) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** Jaccard overlap of two keyword arrays: 0..1. */
function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Normalise a code hunk for similarity comparison: strip diff +/- markers,
 * leading whitespace, and blank lines; lowercase. Returns a set of code lines.
 */
function hunkLines(code) {
  if (!code || typeof code !== 'string') return [];
  return code
    .split('\n')
    .map((l) => l.replace(/^[+\- ]/, '').trim())
    .filter((l) => l.length > 0 && l !== '```')
    .map((l) => l.toLowerCase());
}

// Lines that appear in virtually every file and must not count toward hunk
// similarity: lone brackets/punctuation, comment-only lines, and import /
// require boilerplate. Two unrelated edits routinely share ALL of these, and
// counting them is how a hunk matcher starts crying wolf on every file header.
// (Input is already lowercased + trimmed by hunkLines.)
const TRIVIAL_LINE = new RegExp(
  '^(?:' +
    '[{}()\\[\\];,.:`]+' + // pure punctuation: }, });, ], etc.
    '|//.*|/\\*.*|\\*+/?.*' + // comment-only lines (// … , /* … , * …)
    '|#(?:\\s|!).*' + // shell/python comment or shebang ("#header {" is kept)
    '|import\\s.*|from\\s.*' + // JS/Python import boilerplate
    '|export\\s*\\{.*' + // export { … } re-export lines
    '|(?:const|let|var)\\s+\\S+\\s*=\\s*require\\(.*' + // CJS require lines
    '|else\\s*\\{?|\\}?\\s*else\\s*\\{?|try\\s*\\{?|\\}?\\s*catch\\b.*|\\}?\\s*finally\\s*\\{?' +
    '|return;?|break;?|continue;?|end' + // bare control-flow lines
  ')$'
);

/**
 * Only the lines that could plausibly identify a specific change: at least 4
 * chars, contains a letter or digit, and not boilerplate per TRIVIAL_LINE.
 */
function substantiveLines(code) {
  return hunkLines(code).filter(
    (l) => l.length >= 4 && /[a-z0-9]/.test(l) && !TRIVIAL_LINE.test(l)
  );
}

/**
 * Line-level Jaccard similarity between two code blobs: 0..1.
 * Computed over SUBSTANTIVE lines only — shared braces, imports, and comments
 * are exactly the accidental overlap that produces false-positive 'ask's.
 */
function hunkSimilarity(a, b) {
  const la = substantiveLines(a);
  const lb = substantiveLines(b);
  if (la.length === 0 || lb.length === 0) return 0;
  const sa = new Set(la);
  const sb = new Set(lb);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transcript parsing (bounded)
// ─────────────────────────────────────────────────────────────────────────────

/** Read transcript JSONL, bounded, returning parsed message objects (best effort). */
function readTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return [];
  let raw;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return [];
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const len = Math.min(stat.size, MAX_TRANSCRIPT_BYTES);
      // Read the TAIL of large transcripts (most recent context is most relevant).
      const start = stat.size > MAX_TRANSCRIPT_BYTES ? stat.size - MAX_TRANSCRIPT_BYTES : 0;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      raw = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean);
  const slice = lines.slice(-MAX_TRANSCRIPT_LINES);
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* tolerate a torn first line from the tail read */
    }
  }
  return out;
}

/** Extract plain text from a transcript message (handles string + block array). */
function messageText(msg) {
  const m = msg && msg.message ? msg.message : msg;
  if (!m) return '';
  const content = m.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b.text === 'string') return b.text;
        return '';
      })
      .join('\n');
  }
  return '';
}

function messageRole(msg) {
  const m = msg && msg.message ? msg.message : msg;
  return (m && m.role) || msg.type || '';
}

/**
 * Pull every Edit/Write tool_use code payload out of a transcript message.
 * Real Claude Code JSONL puts these in assistant content blocks:
 *   { type: 'tool_use', name: 'Edit'|'Write', input: { new_string | content } }
 * Returns [{ tool, code }] for the ones that carry a non-trivial code payload.
 * This is the snapshot source used to detect a later reintroduced hunk.
 */
function toolUseCode(msg) {
  const m = msg && msg.message ? msg.message : msg;
  if (!m) return [];
  const content = m.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (!b || b.type !== 'tool_use') continue;
    const name = b.name;
    if (name !== 'Edit' && name !== 'Write') continue;
    const input = b.input || {};
    const code = name === 'Write'
      ? String(input.content || '')
      : String(input.new_string || '');
    if (code && code.trim()) out.push({ tool: name, code });
  }
  return out;
}

/** Sum output+input tokens across all assistant messages (best effort). */
function estimateTokens(messages) {
  let tokens = 0;
  let chars = 0;
  for (const msg of messages) {
    const m = msg && msg.message ? msg.message : msg;
    const usage = m && m.usage;
    if (usage && typeof usage === 'object') {
      const it = Number(usage.input_tokens) || 0;
      const ot = Number(usage.output_tokens) || 0;
      const cr = Number(usage.cache_read_input_tokens) || 0;
      const cc = Number(usage.cache_creation_input_tokens) || 0;
      tokens += it + ot + cr + cc;
    }
    chars += messageText(msg).length;
  }
  // Fallback estimate (~4 chars/token) if no usage was present at all.
  if (tokens === 0 && chars > 0) tokens = Math.round(chars / 4);
  return tokens;
}

function usdFor(tokens) {
  if (!tokens || tokens <= 0) return null;
  const usd = tokens * USD_PER_TOKEN;
  return Math.round(usd * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction: mine abandoned approaches from a transcript (pure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan messages for revert/abandon signals. For each hit, summarise the approach
 * from nearby context and build a keyword fingerprint.
 * Returns an array of dead-end candidates (deduped by fingerprint).
 */
// How far back from a revert signal we look for the code that was tried.
const CODE_LOOKBACK = 10;

/**
 * Find the code snapshot for a dead end: the most recent Edit/Write tool_use
 * BEFORE the revert signal whose code best overlaps the dead-end keywords.
 * This is the actual code that was written and then reverted, so a later
 * reintroduction can be matched by hunk similarity. Returns '' if none found.
 */
function findRevertedCode(messages, revertIdx, kws) {
  const kwset = new Set(kws);
  let best = null;
  const from = Math.max(0, revertIdx - CODE_LOOKBACK);
  for (let j = revertIdx; j >= from; j--) {
    for (const { code } of toolUseCode(messages[j])) {
      const codeKw = keywords(code, 24);
      if (codeKw.length === 0) continue;
      let overlap = 0;
      for (const w of codeKw) if (kwset.has(w)) overlap++;
      // Prefer the nearest, keyword-overlapping snapshot; fall back to the
      // nearest snapshot at all (recency wins) so we still capture code even
      // when the prose keywords and identifiers diverge.
      const score = overlap * 1000 + (revertIdx - j) * -1;
      if (!best || score > best.score) best = { code, score, overlap };
    }
  }
  return best ? best.code : '';
}

/** Truncate a mined code snapshot (registry-size + secret-exposure bound). */
function truncateCode(code) {
  if (!code) return '';
  let lines = code.split('\n');
  if (lines.length > MAX_CODE_LINES) lines = lines.slice(0, MAX_CODE_LINES);
  let out = lines.join('\n');
  if (out.length > MAX_CODE_CHARS) out = out.slice(0, MAX_CODE_CHARS);
  return out;
}

function extractDeadEnds(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const candidates = [];
  const seen = new Set();

  for (let i = 0; i < messages.length; i++) {
    const text = messageText(messages[i]);
    if (!text || text.length < 8) continue;
    const role = messageRole(messages[i]);

    for (const pat of REVERT_PATTERNS) {
      // Weak (symptom-only) signals are only trusted on assistant messages —
      // a user reporting "X is broken" is a bug report, not an abandoned approach.
      if (pat.weak && !/assistant/i.test(role)) continue;
      const match = pat.regex.exec(text);
      if (!match) continue;

      // Context window: this message + the two before it usually name the approach.
      const ctxParts = [];
      for (let j = Math.max(0, i - 2); j <= i; j++) ctxParts.push(messageText(messages[j]));
      const context = ctxParts.join(' ').replace(/\s+/g, ' ').trim();

      // Require 3 distinct topical keywords: with fewer, later prompt matching
      // cannot clear its own minimum-overlap bar, so the entry is pure noise.
      const kws = keywords(context, 12);
      if (kws.length < 3) continue; // too vague to be actionable

      const fp = kws.slice(0, 6).sort().join('|');
      if (seen.has(fp)) continue;
      seen.add(fp);

      // Capture the code that was tried and reverted, so the PreToolUse
      // enforcement leg has a real hunk to match a future reintroduction against.
      const code = truncateCode(findRevertedCode(messages, i, kws));

      // Token estimate for the DETOUR only (the lookback window around the
      // revert), not the whole session — attributing an entire session's spend
      // to one dead end would overstate the cost and erode the card's credibility.
      const detourTokens = estimateTokens(messages.slice(Math.max(0, i - CODE_LOOKBACK), i + 1));

      candidates.push({
        summary: summarise(context, match.index, text),
        reason: pat.reason,
        signal: pat.id,
        keywords: kws,
        fingerprint: fp,
        code: code || undefined,
        tokens: detourTokens,
        role,
      });
      break; // one dead-end per message
    }
  }
  return candidates;
}

/** Build a short human summary of what was tried, centered on the revert signal. */
function summarise(context, _idx, signalText) {
  const clean = (signalText || context).replace(/\s+/g, ' ').trim();
  // Prefer a sentence that contains a revert cue; else fall back to first ~140 chars.
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let best = sentences.find((s) => REVERT_PATTERNS.some((p) => p.regex.test(s))) || sentences[0] || clean;
  best = best.trim();
  if (best.length > 160) best = best.slice(0, 157).trimEnd() + '…';
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Registry I/O
// ─────────────────────────────────────────────────────────────────────────────

/** Entry age gate — undated (legacy/hand-written) entries are kept. */
function isFresh(entry, now = Date.now()) {
  const stamp = entry && (entry.ts || entry.date);
  if (!stamp) return true;
  const ms = Date.parse(stamp);
  if (Number.isNaN(ms)) return true;
  return now - ms <= MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

function readRegistry(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    // Staleness gate: never warn from entries older than MAX_AGE_DAYS —
    // the code they describe has usually been rewritten since.
    return out.filter((e) => isFresh(e)).slice(-MAX_REGISTRY_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Bound registry file growth. The append path is O(1); when the file exceeds
 * the scan cap we rewrite it with only the fresh, most recent entries. Called
 * from the mining path only (Stop/PreCompact) so prompt-submit stays read-only
 * and fast.
 */
function compactRegistry(file) {
  try {
    if (!fs.existsSync(file)) return;
    const rawLines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
    if (rawLines.length <= MAX_REGISTRY_ENTRIES) return;
    const parsed = [];
    for (const line of rawLines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {}
    }
    const keep = parsed.filter((e) => isFresh(e)).slice(-MAX_REGISTRY_ENTRIES);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
    fs.renameSync(tmp, file);
  } catch {}
}

function appendRegistry(file, entry) {
  try {
    if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge newly-mined dead ends into the registry file, skipping fingerprints that
 * already exist. Returns the entries actually added.
 */
function persistDeadEnds(file, candidates, meta) {
  const existing = readRegistry(file);
  const known = new Set(existing.map((e) => e.fingerprint));
  const added = [];
  const totalTokens = meta.tokens || 0;
  // Fallback share when a candidate carries no windowed estimate (rough, honest).
  const perTokens = candidates.length > 0 ? Math.round(totalTokens / candidates.length) : 0;

  for (const c of candidates) {
    if (known.has(c.fingerprint)) continue;
    // Prefer the per-detour windowed estimate mined with the candidate.
    const entryTokens = Number.isFinite(c.tokens) && c.tokens > 0 ? c.tokens : perTokens;
    const entry = {
      id: crypto.randomBytes(6).toString('hex'),
      date: new Date().toISOString().slice(0, 10),
      ts: new Date().toISOString(),
      summary: c.summary,
      reason: c.reason,
      signal: c.signal,
      keywords: c.keywords,
      fingerprint: c.fingerprint,
      // Code snapshot of the reverted change (when one was captured at mine
      // time). Enables the PreToolUse hunk-similarity enforcement leg.
      code: c.code || undefined,
      // Always an ESTIMATE (hooks receive no billing data — see header note).
      tokens: entryTokens,
      usd: usdFor(entryTokens),
      session_id: meta.session_id || null,
      source_event: meta.event || null,
    };
    if (appendRegistry(file, entry)) {
      added.push(entry);
      known.add(c.fingerprint);
    }
  }
  return added;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching new prompts against the registry (pure)
// ─────────────────────────────────────────────────────────────────────────────

// Jaccard alone is jumpy on small keyword sets (a 2-keyword prompt against a
// 3-keyword entry scores 0.67 on two shared words). Three stacked gates keep
// the card out of everyday prompts:
//   1. jaccard >= PROMPT_MATCH_THRESHOLD  (overall topical overlap)
//   2. >= MIN_PROMPT_OVERLAP shared keywords  (small-set jitter guard)
//   3. >= 1 shared NON-generic keyword  ("fix the tests" can never match)
const PROMPT_MATCH_THRESHOLD = 0.34;
const MIN_PROMPT_OVERLAP = 3;

/** Return registry entries whose keyword fingerprint overlaps the prompt. */
function matchPrompt(promptText, registry, threshold = PROMPT_MATCH_THRESHOLD) {
  const pk = keywords(promptText, 16);
  if (pk.length === 0) return [];
  const pset = new Set(pk);
  const scored = [];
  for (const entry of registry) {
    const ek = Array.isArray(entry.keywords) ? entry.keywords : [];
    const eset = new Set(ek);
    if (eset.size === 0) continue;
    let inter = 0;
    let distinctive = false;
    for (const w of eset) {
      if (!pset.has(w)) continue;
      inter++;
      if (!GENERIC_KEYWORDS.has(w)) distinctive = true;
    }
    if (inter < MIN_PROMPT_OVERLAP || !distinctive) continue;
    const union = pset.size + eset.size - inter;
    const score = union === 0 ? 0 : inter / union;
    if (score >= threshold) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching a diff/edit against the registry (pure)
// ─────────────────────────────────────────────────────────────────────────────

const HUNK_MATCH_THRESHOLD = 0.6;
// Minimum SUBSTANTIVE code lines (see substantiveLines: no braces / imports /
// comments) on BOTH sides — and shared between them — before a hunk match can
// fire. A 1-2 line reverted snippet is too generic and would produce
// false-positive "ask" prompts — the exact failure mode the spec flags
// ("false positives would kill it"). Require a substantive hunk before we
// interrupt the user.
const MIN_HUNK_LINES = 3;

/** Pull the code payload out of an Edit/Write tool_input. */
function editCode(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (toolName === 'Write') return String(toolInput.content || '');
  if (toolName === 'Edit') return String(toolInput.new_string || '');
  return String(toolInput.content || toolInput.new_string || '');
}

/**
 * Does this edit reintroduce a previously-reverted code hunk?
 * Registry entries only carry a code snapshot when one was captured at mine time.
 */
function matchEdit(code, registry, threshold = HUNK_MATCH_THRESHOLD) {
  if (!code) return null;
  const editLines = substantiveLines(code);
  // Tiny edits are too generic to match confidently — skip to avoid false positives.
  if (editLines.length < MIN_HUNK_LINES) return null;
  const editSet = new Set(editLines);
  let best = null;
  for (const entry of registry) {
    if (!entry.code) continue;
    // Both sides must carry a substantive hunk.
    const entryLines = substantiveLines(entry.code);
    if (entryLines.length < MIN_HUNK_LINES) continue;
    const entrySet = new Set(entryLines);
    let inter = 0;
    for (const l of entrySet) if (editSet.has(l)) inter++;
    // Ratio alone is not enough: also require MIN_HUNK_LINES literally shared
    // substantive lines, so a couple of coincidental matches can never fire.
    if (inter < MIN_HUNK_LINES) continue;
    const union = editSet.size + entrySet.size - inter;
    const sim = union === 0 ? 0 : inter / union;
    if (sim >= threshold && (!best || sim > best.score)) best = { entry, score: sim };
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering (the screenshot-able card)
// ─────────────────────────────────────────────────────────────────────────────

function money(entry) {
  return entry && entry.usd != null ? `~$${entry.usd.toFixed(2)}` : null;
}

/** A single "DEAD END" warning line for a matched entry. */
function deadEndLine(entry, score) {
  const cost = money(entry);
  // entry.reason is the mined outcome label ('reverted', 'abandoned', …) —
  // don't hard-code "reverted" for approaches that were merely abandoned.
  const bits = [`tried on ${entry.date}`, `outcome: ${entry.reason}`];
  if (cost) bits.push(`paid ${cost} in tokens (est.)`);
  const pct = score != null ? ` [${Math.round(score * 100)}% match]` : '';
  return `⚠️  DEAD END${pct}: ${entry.summary}\n    → ${bits.join(' · ')}`;
}

/** additionalContext card injected on UserPromptSubmit. */
function renderPromptCard(matches) {
  const top = matches.slice(0, MAX_CARD_ENTRIES);
  const totalUsd = top.reduce((s, m) => s + (m.entry.usd || 0), 0);
  const lines = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║  🪦  DEAD-END REGISTRY — you have been here before             ║',
    '╚══════════════════════════════════════════════════════════════╝',
  ];
  for (const m of top) lines.push(deadEndLine(m.entry, m.score));
  if (totalUsd > 0) {
    lines.push('');
    lines.push(`💸  These dead ends already cost an estimated ~$${totalUsd.toFixed(2)} in tokens the first time. Do NOT silently retry the same approach — confirm with the user, or explain why it will be different this time.`);
  } else {
    lines.push('');
    lines.push('Do NOT silently retry the same approach — confirm with the user, or explain why it will be different this time.');
  }
  return lines.join('\n');
}

/**
 * permissionDecisionReason for a blocked Edit/Write. Must carry enough context
 * (what was tried, when, why it was walked back, what it cost) for the user to
 * confidently dismiss OR confirm without digging through old transcripts.
 */
function renderEditReason(entry, score) {
  const cost = money(entry);
  const paid = cost ? ` You have now paid for this dead end twice (an estimated ${cost} in tokens the first time).` : '';
  const what = entry.summary ? ` What was tried: "${entry.summary}".` : '';
  return `🪦 DEAD END — this change closely matches (${Math.round(score * 100)}%) code you already tried on ${entry.date} and walked back (${entry.reason}).${what}${paid} Reintroduce it only if you know why it will be different this time.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────

function handleMine(data) {
  const file = registryFileFor(data.cwd);
  const messages = readTranscript(data.transcript_path);
  if (messages.length === 0) {
    log({ level: 'MINE_SKIP', reason: 'empty transcript', event: data.hook_event_name, session_id: data.session_id });
    return {};
  }
  const candidates = extractDeadEnds(messages);
  if (candidates.length === 0) {
    log({ level: 'MINE_NONE', event: data.hook_event_name, session_id: data.session_id });
    return {};
  }
  const tokens = estimateTokens(messages);
  const added = persistDeadEnds(file, candidates, {
    tokens,
    session_id: data.session_id,
    event: data.hook_event_name,
  });
  // Bound file growth here (mining path), keeping prompt-submit read-only.
  compactRegistry(file);
  log({
    level: 'MINED',
    event: data.hook_event_name,
    found: candidates.length,
    added: added.length,
    tokens,
    session_id: data.session_id,
  });
  return {};
}

function handlePrompt(data) {
  const file = registryFileFor(data.cwd);
  const registry = readRegistry(file);
  if (registry.length === 0) return {};
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';
  if (!prompt.trim()) return {};

  const matches = matchPrompt(prompt, registry);
  if (matches.length === 0) return {};

  log({
    level: 'PROMPT_MATCH',
    matches: matches.length,
    top: matches[0].entry.fingerprint,
    score: Math.round(matches[0].score * 100) / 100,
    session_id: data.session_id,
  });

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: renderPromptCard(matches),
    },
  };
}

function handleEdit(data) {
  const toolName = data.tool_name;
  if (toolName !== 'Edit' && toolName !== 'Write') return {};
  const file = registryFileFor(data.cwd);
  const registry = readRegistry(file);
  if (registry.length === 0) return {};

  const code = editCode(toolName, data.tool_input);
  const match = matchEdit(code, registry);
  if (!match) return {};

  log({
    level: 'EDIT_ASK',
    tool: toolName,
    score: Math.round(match.score * 100) / 100,
    fingerprint: match.entry.fingerprint,
    session_id: data.session_id,
  });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: renderEditReason(match.entry, match.score),
    },
  };
}

function route(data) {
  const event = data.hook_event_name;
  if (event === 'Stop' || event === 'PreCompact' || event === 'SubagentStop') return handleMine(data);
  if (event === 'UserPromptSubmit') return handlePrompt(data);
  if (event === 'PreToolUse') return handleEdit(data);
  // Unknown event: no-op.
  return {};
}

// ─────────────────────────────────────────────────────────────────────────────
// On-demand render (the /dead-end-registry:dead-ends plugin command)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render this repo's recorded dead ends as a human-readable card, newest first.
 * Pure: takes already-read registry entries, returns a string (never throws).
 * Reuses the same money()/date/reason fields the injected cards use.
 */
function renderRegistry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return (
      'No dead ends recorded yet for this repo.\n' +
      'Keep using Claude Code here — the Stop/PreCompact hooks mine tried-and-reverted ' +
      'approaches as you go — then run /dead-end-registry:dead-ends again.'
    );
  }
  // Newest first. Undated/legacy entries sort last (timestamp 0).
  const sorted = entries.slice().sort((a, b) => {
    const ta = Date.parse((a && (a.ts || a.date)) || '') || 0;
    const tb = Date.parse((b && (b.ts || b.date)) || '') || 0;
    return tb - ta;
  });
  const lines = [
    '╔══════════════════════════════════════════════════════════════╗',
    '║  🪦  DEAD-END REGISTRY — approaches already tried & walked back ║',
    '╚══════════════════════════════════════════════════════════════╝',
    `${sorted.length} recorded dead end${sorted.length === 1 ? '' : 's'} for this repo (newest first):`,
    '',
  ];
  let totalUsd = 0;
  sorted.forEach((e, i) => {
    const cost = money(e);
    const bits = [`tried ${e.date || 'unknown date'}`, `walked back: ${e.reason || 'ruled out'}`];
    if (cost) {
      bits.push(`paid ${cost} in tokens (est.)`);
      totalUsd += e.usd || 0;
    }
    lines.push(`${i + 1}. ${e.summary || '(no summary recorded)'}`);
    lines.push(`    → ${bits.join(' · ')}`);
  });
  if (totalUsd > 0) {
    lines.push('');
    lines.push(`💸  Estimated total already paid for these dead ends the first time: ~$${totalUsd.toFixed(2)} in tokens.`);
  }
  return lines.join('\n');
}

/**
 * CLI entry for `node dead-end-registry.js --render`. Prints the current repo's
 * registry straight to stdout (plain text, NOT a hook JSON envelope). Honors the
 * per-cwd registry file and degrades to a friendly empty-state; never throws.
 */
function renderCli() {
  try {
    const cwd = process.cwd();
    const file = registryFileFor(cwd);
    const entries = readRegistry(file);
    process.stdout.write(renderRegistry(entries) + '\n');
  } catch (e) {
    process.stdout.write('dead-end-registry: could not render registry (' + (e && e.message) + ')\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  let input = '';
  try {
    for await (const chunk of process.stdin) input += chunk;
  } catch {
    return console.log('{}');
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    log({ level: 'ERROR', error: 'bad json' });
    return console.log('{}');
  }

  try {
    const out = route(data) || {};
    console.log(JSON.stringify(out));
  } catch (e) {
    log({ level: 'ERROR', error: e && e.message });
    console.log('{}');
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
    // pure functions for unit testing
    tokenize,
    keywords,
    jaccard,
    hunkLines,
    substantiveLines,
    hunkSimilarity,
    toolUseCode,
    findRevertedCode,
    extractDeadEnds,
    summarise,
    matchPrompt,
    matchEdit,
    editCode,
    estimateTokens,
    usdFor,
    messageText,
    messageRole,
    renderPromptCard,
    renderEditReason,
    deadEndLine,
    renderRegistry,
    renderCli,
    registryFileFor,
    readRegistry,
    appendRegistry,
    persistDeadEnds,
    compactRegistry,
    isFresh,
    truncateCode,
    route,
    REVERT_PATTERNS,
    PROMPT_MATCH_THRESHOLD,
    MIN_PROMPT_OVERLAP,
    HUNK_MATCH_THRESHOLD,
    MIN_HUNK_LINES,
    MAX_AGE_DAYS,
    MAX_REGISTRY_ENTRIES,
    MAX_CODE_LINES,
    MAX_CODE_CHARS,
    USD_PER_TOKEN,
  };
}
