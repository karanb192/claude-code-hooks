#!/usr/bin/env node
/**
 * Context Hogs - PostToolUse + SessionEnd Hook (cost attribution)
 *
 * Attributes every tool result's byte/token weight to the file path(s) it pulled
 * into the context window, and aggregates a cross-session, repo-level leaderboard
 * of "your most expensive files": read count, cumulative tokens, estimated dollars,
 * plus repeat-offender flags (lockfiles, generated code, giant utils) and an
 * auto-generated CLAUDE.md ignore/summarize block for the top offenders.
 *
 * Events:
 *   PostToolUse (matcher: Read|Grep|Glob|Bash) - measures tool_response bytes,
 *     resolves the file path(s) the result belongs to, appends a ledger row.
 *   SessionEnd - aggregates the whole ledger and renders the leaderboard card
 *     (surfaced via systemMessage) + writes suggested-claude-md.txt for the repo.
 *
 * State lives under ~/.claude/context-hogs/<repo-key>/ledger.jsonl
 * Meaningful events also log to ~/.claude/hooks-logs/<date>.jsonl
 *
 * COST DATA CAVEAT (verified, GitHub issue #11008): hooks do NOT receive
 * token/cost numbers in their input. We estimate tokens from response bytes
 * (~4 bytes/token) and dollars from a configurable input-token rate. No fake
 * numbers are ever fabricated — everything is derived from measured bytes.
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "PostToolUse": [{
 *       "matcher": "Read|Grep|Glob|Bash",
 *       "hooks": [{ "type": "command", "command": "node /path/to/context-hogs.js" }]
 *     }],
 *     "SessionEnd": [{
 *       "hooks": [{ "type": "command", "command": "node /path/to/context-hogs.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const LOG_DIR = path.join(HOME, '.claude', 'hooks-logs');
const STATE_ROOT = path.join(HOME, '.claude', 'context-hogs');

// Estimation constants. Both are overridable via env for accuracy tuning.
const BYTES_PER_TOKEN = 4; // rough English/code average
const DOLLARS_PER_MTOK = Number(process.env.CONTEXT_HOGS_USD_PER_MTOK) || 3.0; // input $/1M tok
const TOP_N = Number(process.env.CONTEXT_HOGS_TOP_N) || 10;
const LEDGER_CAP = 50000; // hard cap on ledger rows read (latency discipline)

// Repeat-offender heuristics: filename/path patterns that are chronic context hogs.
const OFFENDER_PATTERNS = [
  { id: 'lockfile', label: 'lockfile', regex: /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|go\.sum)$/i },
  { id: 'generated', label: 'generated code', regex: /(\.generated\.|\.gen\.|_pb2\.py$|\.pb\.go$|(^|\/)generated\/|\.min\.(js|css)$)/i },
  { id: 'buildartifact', label: 'build artifact', regex: /(^|\/)(dist|build|out|coverage|\.next|node_modules)\//i },
  { id: 'snapshot', label: 'test snapshot', regex: /(\.snap$|__snapshots__\/)/i },
  { id: 'map', label: 'source map', regex: /\.map$/i },
  { id: 'data', label: 'data dump', regex: /\.(csv|tsv|ndjson|sqlite|db|log)$/i },
];

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'context-hogs', ...data }) + '\n');
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

function estimateTokens(bytes) {
  if (!bytes || bytes < 0) return 0;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

function estimateDollars(tokens, usdPerMTok = DOLLARS_PER_MTOK) {
  if (!tokens || tokens < 0) return 0;
  return (tokens / 1e6) * usdPerMTok;
}

/** A stable, filesystem-safe key for a repo/cwd so ledgers are per-project. */
function repoKey(cwd) {
  const base = (cwd && String(cwd)) || 'unknown';
  const name = path.basename(base) || 'root';
  // short hash of full path to avoid collisions between same-named dirs
  let h = 0;
  for (let i = 0; i < base.length; i++) { h = (h * 31 + base.charCodeAt(i)) >>> 0; }
  return `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}-${h.toString(16)}`;
}

/** Normalize a path relative to cwd for readable, groupable leaderboard rows. */
function normalizePath(p, cwd) {
  if (!p) return null;
  let s = String(p).trim();
  if (!s) return null;
  // strip surrounding quotes
  s = s.replace(/^['"]|['"]$/g, '');
  if (cwd && path.isAbsolute(s)) {
    const rel = path.relative(cwd, s);
    // only relativize if it stays inside the repo (no leading ..)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return s;
}

/**
 * Measure the byte size of a tool_response. Responses come in several shapes:
 *  - Read: { type:'text', file:{ numLines, ... } } or a plain string
 *  - Grep/Glob/Bash: string, or { stdout, stderr }, or { content:[{type,text}] }
 */
function responseBytes(toolResponse) {
  if (toolResponse == null) return 0;
  if (typeof toolResponse === 'string') return Buffer.byteLength(toolResponse, 'utf8');
  let total = 0;
  const tr = toolResponse;
  if (typeof tr.stdout === 'string') total += Buffer.byteLength(tr.stdout, 'utf8');
  if (typeof tr.stderr === 'string') total += Buffer.byteLength(tr.stderr, 'utf8');
  if (typeof tr.content === 'string') total += Buffer.byteLength(tr.content, 'utf8');
  if (Array.isArray(tr.content)) {
    for (const c of tr.content) {
      if (c && typeof c.text === 'string') total += Buffer.byteLength(c.text, 'utf8');
    }
  }
  if (typeof tr.text === 'string') total += Buffer.byteLength(tr.text, 'utf8');
  if (total === 0) {
    // last resort: serialize whatever we got (bounded)
    try { total = Buffer.byteLength(JSON.stringify(tr).slice(0, 2_000_000), 'utf8'); } catch {}
  }
  return total;
}

/**
 * Resolve which file path(s) a tool result should be attributed to.
 * Returns an array of normalized paths (usually length 1; [] if not attributable).
 *
 * ATTRIBUTION IS HEURISTIC / BEST-EFFORT for Grep and Bash:
 *   - Read: exact — the file_path is authoritative.
 *   - Grep: attributes to the search target (path/glob); a Grep with no path
 *     attribute (repo-wide search) attributes nothing.
 *   - Glob: attributes to the scanned directory (defaults to '.').
 *   - Bash: scans read-ish commands (cat/head/tail/grep/rg/jq/...) for
 *     file-shaped tokens, so e.g. `grep foo file.txt` attributes to file.txt.
 *     Complex pipelines, redirects, or unusual commands may under- or
 *     mis-attribute. This is intentional: better a mostly-right leaderboard
 *     than none, and Read (the dominant context source) is always exact.
 */
function attributePaths(toolName, toolInput, cwd) {
  const ti = toolInput || {};
  const out = [];
  const push = (p) => { const n = normalizePath(p, cwd); if (n) out.push(n); };

  switch (toolName) {
    case 'Read':
      push(ti.file_path || ti.filePath || ti.path);
      break;
    case 'Grep':
      // Grep pulls matching lines from a path/glob; attribute to that target.
      push(ti.path || ti.glob || ti.pattern_path);
      break;
    case 'Glob':
      // Glob itself lists names; attribute the directory it scanned.
      push(ti.path || '.');
      break;
    case 'Bash': {
      // Best-effort: pull file-ish args out of common read commands.
      const cmd = String(ti.command || '');
      const m = cmd.match(/\b(?:cat|head|tail|less|bat|wc|grep|rg|jq|xxd|hexdump)\b[^|;&<>]*/g);
      if (m) {
        for (const seg of m) {
          const toks = seg.split(/\s+/).slice(1);
          for (const t of toks) {
            if (t.startsWith('-')) continue;
            if (/[*?]/.test(t)) continue; // skip globs/patterns
            if (/^[A-Za-z0-9_./~-]+$/.test(t) && /[./]/.test(t)) push(t);
          }
        }
      }
      break;
    }
    default:
      break;
  }
  // de-dup within a single event
  return [...new Set(out)];
}

/** Classify a path against the repeat-offender heuristics. Returns label|null. */
function offenderLabel(p) {
  for (const o of OFFENDER_PATTERNS) {
    if (o.regex.test(p)) return o.label;
  }
  return null;
}

/**
 * Aggregate ledger rows into a sorted leaderboard.
 * rows: [{ path, bytes, tokens, tool }]
 * Returns { rows: [...sorted], totals }
 */
function aggregate(rows, opts = {}) {
  const usd = opts.usdPerMTok != null ? opts.usdPerMTok : DOLLARS_PER_MTOK;
  const topN = opts.topN != null ? opts.topN : TOP_N;
  const byPath = new Map();
  let totalTokens = 0;
  let totalBytes = 0;
  for (const r of rows) {
    if (!r || !r.path) continue;
    const bytes = Number(r.bytes) || 0;
    const tokens = Number(r.tokens) || estimateTokens(bytes);
    totalTokens += tokens;
    totalBytes += bytes;
    let e = byPath.get(r.path);
    if (!e) { e = { path: r.path, reads: 0, bytes: 0, tokens: 0, tools: {} }; byPath.set(r.path, e); }
    e.reads += 1;
    e.bytes += bytes;
    e.tokens += tokens;
    if (r.tool) e.tools[r.tool] = (e.tools[r.tool] || 0) + 1;
  }
  const list = [...byPath.values()].map((e) => ({
    ...e,
    dollars: estimateDollars(e.tokens, usd),
    offender: offenderLabel(e.path),
  }));
  list.sort((a, b) => b.tokens - a.tokens || b.reads - a.reads);
  return {
    rows: list.slice(0, topN),
    allRows: list,
    totals: {
      files: byPath.size,
      reads: rows.length,
      tokens: totalTokens,
      bytes: totalBytes,
      dollars: estimateDollars(totalTokens, usd),
    },
  };
}

function fmtInt(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtTokens(t) {
  if (t >= 1e6) return (t / 1e6).toFixed(1) + 'M';
  if (t >= 1e3) return (t / 1e3).toFixed(1) + 'K';
  return String(Math.round(t));
}

function fmtDollars(d) {
  if (d >= 1) return '$' + d.toFixed(2);
  if (d >= 0.01) return '$' + d.toFixed(2);
  return '$' + d.toFixed(4);
}

function truncatePath(p, max = 42) {
  if (p.length <= max) return p;
  return '…' + p.slice(-(max - 1));
}

/** Render the shareable leaderboard card as plain text. */
function renderCard(agg, meta = {}) {
  const lines = [];
  lines.push('🐷 Context Hogs — most expensive files' + (meta.repo ? ` · ${meta.repo}` : ''));
  const t = agg.totals;
  lines.push(`   ${fmtInt(t.files)} files · ${fmtInt(t.reads)} reads · ~${fmtTokens(t.tokens)} tokens · ~${fmtDollars(t.dollars)} est`);
  lines.push('');
  if (agg.rows.length === 0) {
    lines.push('   (no attributable reads recorded yet)');
    return lines.join('\n');
  }
  const rank = (i) => String(i + 1).padStart(2, ' ');
  agg.rows.forEach((r, i) => {
    const flag = r.offender ? `  ⚑ ${r.offender}` : '';
    lines.push(`   ${rank(i)}. ${truncatePath(r.path)}`);
    lines.push(`       read ${fmtInt(r.reads)}× · ~${fmtTokens(r.tokens)} tok · ~${fmtDollars(r.dollars)}${flag}`);
  });
  return lines.join('\n');
}

/** Build a suggested CLAUDE.md ignore/summarize block for the worst offenders. */
function suggestClaudeMdBlock(agg) {
  const flagged = agg.allRows.filter((r) => r.offender);
  const bulk = agg.rows.filter((r) => !r.offender).slice(0, 3);
  const picks = [...flagged, ...bulk];
  if (picks.length === 0) return '';
  const seen = new Set();
  const lines = [];
  lines.push('<!-- context-hogs: paste into CLAUDE.md to stop burning tokens on these -->');
  lines.push('## Context budget');
  lines.push('Do NOT read these files in full unless explicitly required — they are large and rarely relevant:');
  for (const r of picks) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    const why = r.offender ? r.offender : `${fmtDollars(r.dollars)} est over ${fmtInt(r.reads)} reads`;
    lines.push(`- \`${r.path}\` (${why})`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger IO
// ─────────────────────────────────────────────────────────────────────────────

function stateDir(cwd) {
  return path.join(STATE_ROOT, repoKey(cwd));
}

function appendLedger(cwd, row) {
  const dir = stateDir(cwd);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify(row) + '\n');
}

function readLedger(cwd) {
  const file = path.join(stateDir(cwd), 'ledger.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const rows = [];
  const lines = raw.split('\n');
  // read only the most recent LEDGER_CAP rows to bound latency
  const start = Math.max(0, lines.length - LEDGER_CAP);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────

function handlePostToolUse(data) {
  const { tool_name, tool_input, tool_response, cwd, session_id } = data;
  const paths = attributePaths(tool_name, tool_input, cwd);
  if (paths.length === 0) return {}; // nothing attributable → no-op

  const bytes = responseBytes(tool_response);
  if (bytes <= 0) return {}; // empty result → don't pollute the ledger

  const tokens = estimateTokens(bytes);
  // split the weight across the paths it touched
  const perPathBytes = Math.round(bytes / paths.length);
  const perPathTokens = Math.round(tokens / paths.length);
  for (const p of paths) {
    appendLedger(cwd, {
      ts: new Date().toISOString(),
      path: p,
      tool: tool_name,
      bytes: perPathBytes,
      tokens: perPathTokens,
      session_id: session_id || null,
    });
  }
  log({ level: 'ATTRIBUTED', tool: tool_name, paths, bytes, tokens, session_id });
  return {};
}

function handleSessionEnd(data) {
  const { cwd, session_id } = data;
  const rows = readLedger(cwd);
  if (rows.length === 0) return {};

  const agg = aggregate(rows);
  const meta = { repo: path.basename(cwd || '') || undefined };
  const card = renderCard(agg, meta);

  // Persist the suggested CLAUDE.md block for this repo.
  try {
    const block = suggestClaudeMdBlock(agg);
    if (block) fs.writeFileSync(path.join(stateDir(cwd), 'suggested-claude-md.txt'), block + '\n');
  } catch {}

  log({
    level: 'LEADERBOARD',
    session_id,
    files: agg.totals.files,
    tokens: agg.totals.tokens,
    dollars: Number(agg.totals.dollars.toFixed(4)),
    top: agg.rows.slice(0, 3).map((r) => ({ path: r.path, reads: r.reads, tokens: r.tokens })),
  });

  // NOTE: at SessionEnd, additionalContext is NOT honored by Claude Code
  // (it only surfaces for SessionStart/UserPromptSubmit). The sibling
  // `systemMessage` field is what actually renders the card, so we emit only
  // that here and deliberately omit a no-op additionalContext branch.
  return {
    systemMessage: card,
    hookSpecificOutput: {
      hookEventName: 'SessionEnd',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    return console.log('{}');
  }

  try {
    const event = data.hook_event_name;
    let out = {};
    if (event === 'SessionEnd') {
      out = handleSessionEnd(data);
    } else if (event === 'PostToolUse' || (!event && data.tool_response !== undefined)) {
      // branch on tool for PostToolUse; ignore tools we don't attribute
      if (['Read', 'Grep', 'Glob', 'Bash'].includes(data.tool_name)) {
        out = handlePostToolUse(data);
      }
    }
    console.log(JSON.stringify(out || {}));
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    estimateTokens,
    estimateDollars,
    repoKey,
    normalizePath,
    responseBytes,
    attributePaths,
    offenderLabel,
    aggregate,
    renderCard,
    suggestClaudeMdBlock,
    fmtTokens,
    fmtDollars,
    OFFENDER_PATTERNS,
    handlePostToolUse,
    handleSessionEnd,
    stateDir,
    readLedger,
  };
}
