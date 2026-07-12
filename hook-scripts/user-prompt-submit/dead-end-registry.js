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
 * Setup in .claude/settings.json:
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

// Signals that a preceding approach was abandoned / reverted / ruled out.
const REVERT_PATTERNS = [
  { id: 'reverted', regex: /\b(revert(?:ed|ing)?|rolled?\s+back|roll\s+back|backed\s+out)\b/i, reason: 'reverted' },
  { id: 'undo', regex: /\b(undo|undid|git\s+revert|git\s+reset\s+--hard|restore\s+the\s+old)\b/i, reason: 'undone' },
  { id: 'didnt-work', regex: /\b(didn['’]?t\s+work|does\s+not\s+work|doesn['’]?t\s+work|not\s+working|broke\s+(?:the|everything)|broken)\b/i, reason: "didn't work" },
  { id: 'abandon', regex: /\b(abandon(?:ed|ing)?|give\s+up|giving\s+up|gave\s+up|scrap(?:ped)?\s+that|drop\s+(?:this|that)\s+approach)\b/i, reason: 'abandoned' },
  { id: 'ruled-out', regex: /\b(ruled?\s+out|dead\s+end|won['’]?t\s+work|that\s+approach\s+(?:failed|is\s+wrong)|wrong\s+approach|bad\s+idea)\b/i, reason: 'ruled out' },
  { id: 'race-cond', regex: /\b(race\s+condition|deadlock|infinite\s+loop|memory\s+leak|caused\s+a\s+regression)\b/i, reason: 'caused a defect' },
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

/** Line-level Jaccard similarity between two code blobs: 0..1. */
function hunkSimilarity(a, b) {
  const la = hunkLines(a);
  const lb = hunkLines(b);
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

function extractDeadEnds(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const candidates = [];
  const seen = new Set();

  for (let i = 0; i < messages.length; i++) {
    const text = messageText(messages[i]);
    if (!text || text.length < 8) continue;

    for (const pat of REVERT_PATTERNS) {
      const match = pat.regex.exec(text);
      if (!match) continue;

      // Context window: this message + the two before it usually name the approach.
      const ctxParts = [];
      for (let j = Math.max(0, i - 2); j <= i; j++) ctxParts.push(messageText(messages[j]));
      const context = ctxParts.join(' ').replace(/\s+/g, ' ').trim();

      const kws = keywords(context, 12);
      if (kws.length < 2) continue; // too vague to be actionable

      const fp = kws.slice(0, 6).sort().join('|');
      if (seen.has(fp)) continue;
      seen.add(fp);

      // Capture the code that was tried and reverted, so the PreToolUse
      // enforcement leg has a real hunk to match a future reintroduction against.
      const code = findRevertedCode(messages, i, kws);

      candidates.push({
        summary: summarise(context, match.index, text),
        reason: pat.reason,
        signal: pat.id,
        keywords: kws,
        fingerprint: fp,
        code: code || undefined,
        role: messageRole(messages[i]),
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
    return out.slice(-MAX_REGISTRY_ENTRIES);
  } catch {
    return [];
  }
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
  // Attribute a share of the detour cost per new dead end (rough, honest).
  const perTokens = candidates.length > 0 ? Math.round(totalTokens / candidates.length) : 0;

  for (const c of candidates) {
    if (known.has(c.fingerprint)) continue;
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
      tokens: perTokens,
      usd: usdFor(perTokens),
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

const PROMPT_MATCH_THRESHOLD = 0.34;

/** Return registry entries whose keyword fingerprint overlaps the prompt. */
function matchPrompt(promptText, registry, threshold = PROMPT_MATCH_THRESHOLD) {
  const pk = keywords(promptText, 16);
  if (pk.length === 0) return [];
  const scored = [];
  for (const entry of registry) {
    const ek = Array.isArray(entry.keywords) ? entry.keywords : [];
    const score = jaccard(pk, ek);
    if (score >= threshold) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching a diff/edit against the registry (pure)
// ─────────────────────────────────────────────────────────────────────────────

const HUNK_MATCH_THRESHOLD = 0.6;
// Minimum meaningful code lines on BOTH sides before a hunk match can fire.
// A 1-2 line reverted snippet is too generic and would produce false-positive
// "ask" prompts — the exact failure mode the spec flags ("false positives would
// kill it"). Require a substantive hunk before we interrupt the user.
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
  const editLines = hunkLines(code);
  // Tiny edits are too generic to match confidently — skip to avoid false positives.
  if (editLines.length < MIN_HUNK_LINES) return null;
  let best = null;
  for (const entry of registry) {
    if (!entry.code) continue;
    // Both sides must carry a substantive hunk.
    if (hunkLines(entry.code).length < MIN_HUNK_LINES) continue;
    const sim = hunkSimilarity(code, entry.code);
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
  const bits = [`tried on ${entry.date}`, `reverted (${entry.reason})`];
  if (cost) bits.push(`paid ${cost} in tokens`);
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
    lines.push(`💸  Re-exploring these dead ends already cost ~$${totalUsd.toFixed(2)}. Do NOT silently retry the same approach — confirm with the user, or explain why it will be different this time.`);
  } else {
    lines.push('');
    lines.push('Do NOT silently retry the same approach — confirm with the user, or explain why it will be different this time.');
  }
  return lines.join('\n');
}

/** permissionDecisionReason for a blocked Edit/Write. */
function renderEditReason(entry, score) {
  const cost = money(entry);
  const paid = cost ? ` You have now paid for this dead end twice (${cost} in tokens the first time).` : '';
  return `🪦 DEAD END — this change closely matches (${Math.round(score * 100)}%) something you already tried on ${entry.date} and reverted (${entry.reason}).${paid} Reintroduce it only if you know why it will be different this time.`;
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
  main();
} else {
  module.exports = {
    // pure functions for unit testing
    tokenize,
    keywords,
    jaccard,
    hunkLines,
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
    registryFileFor,
    readRegistry,
    appendRegistry,
    persistDeadEnds,
    route,
    REVERT_PATTERNS,
    PROMPT_MATCH_THRESHOLD,
    HUNK_MATCH_THRESHOLD,
    MIN_HUNK_LINES,
    USD_PER_TOKEN,
  };
}
