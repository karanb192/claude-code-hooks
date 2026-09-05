#!/usr/bin/env node
/**
 * cache-tax - the comeback price of a cold prompt cache, shown before you pay it.
 *
 * Claude Code's main conversation rides a 1-hour prompt cache. Come back at
 * minute 59 and the next message costs cents; come back at minute 61 and the
 * whole context is re-written at the cache-write rate, which on Fable 5.1 is
 * 80x a cache read ($20 vs $0.25 per million tokens). The harness knows all of
 * this and shows none of it at the moment you press Enter. This plugin does.
 *
 * Three pieces, one file:
 *   UserPromptSubmit  - the guard. If the cache has lapsed and the context is
 *                       big, warns with the dollar figure (default) or, with
 *                       CACHE_TAX_BLOCK=1, refuses the prompt once so you can
 *                       /clear and hand off instead. Resend to proceed.
 *   SessionStart      - on resume or fork, prints what the first message will
 *                       cost, using the estimate Claude Code already computed.
 *   --statusline      - a one-line segment for your status line: minutes until
 *                       cold, context size, and the cold-comeback price. Reads
 *                       the native prompt_cache object when present (2.1.251+),
 *                       falls back to the transcript otherwise.
 *
 * Plus /cache-tax:status (--render) for the full card on demand.
 *
 * Everything is derived from the session transcript's own usage blocks or from
 * fields Claude Code sends. Prices are list rates and can be overridden.
 * No network calls. Nothing leaves the machine.
 *
 * Setup as a plugin: /plugin install cache-tax@claude-code-hooks
 *
 * Status line wiring (plugins cannot ship one), in ~/.claude/settings.json:
 *   "statusLine": { "type": "command",
 *                   "command": "node ~/.claude/plugins/marketplaces/claude-code-hooks/plugins/cache-tax/cache-tax.js --statusline" }
 * or call it from your existing status line script and print its one line.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const LOG_DIR = path.join(HOME, '.claude', 'hooks-logs');
const STATE_DIR = path.join(HOME, '.claude', 'cache-tax');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

const TTL_SEC = { '5m': 300, '1h': 3600 };
const BIG_TOKENS = Number(process.env.CACHE_TAX_BIG) || 50000;
const BLOCK = /^(1|true|yes)$/i.test(String(process.env.CACHE_TAX_BLOCK || ''));
const TAIL_BYTES = 4 * 1024 * 1024;

// List prices, $ per million tokens: [cache read, 5m cache write, 1h cache write].
// Override any family with CACHE_TAX_PRICES='{"fable-5-1":[0.25,12.5,20]}'.
const DEFAULT_PRICES = {
  'fable-5-1': [0.25, 12.5, 20],
  'fable-5': [1.0, 12.5, 20],
  'opus-5': [0.5, 6.25, 10],
  'opus-4': [0.5, 6.25, 10],
  'sonnet': [0.3, 3.75, 6],
  'haiku': [0.1, 1.25, 2],
};
function prices() {
  let extra = {};
  try { extra = JSON.parse(process.env.CACHE_TAX_PRICES || '{}'); } catch (_) { extra = {}; }
  return Object.assign({}, DEFAULT_PRICES, extra);
}

// Longest key first so fable-5-1 wins over fable-5 and opus-5 over opus.
function family(model) {
  const m = String(model || '').toLowerCase();
  const keys = Object.keys(prices()).sort((a, b) => b.length - a.length);
  for (const k of keys) if (m.includes(k)) return k;
  return null;
}
function priceFor(model) {
  const f = family(model);
  return f ? { family: f, read: prices()[f][0], write5m: prices()[f][1], write1h: prices()[f][2] } : null;
}

// ---------- transcript ----------

function parseUsageLine(line) {
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null;
  let o;
  try { o = JSON.parse(line); } catch (_) { return null; }
  if (!o || o.type !== 'assistant') return null;
  const msg = o.message || {};
  const u = msg.usage;
  if (!u) return null;
  const ts = Date.parse(o.timestamp || '');
  if (!Number.isFinite(ts)) return null;
  const cc = u.cache_creation || {};
  const write = Number(u.cache_creation_input_tokens) || 0;
  const w5 = Number(cc.ephemeral_5m_input_tokens) || 0;
  const w1 = Number(cc.ephemeral_1h_input_tokens) || 0;
  const read = Number(u.cache_read_input_tokens) || 0;
  const input = Number(u.input_tokens) || 0;
  return {
    ts, model: msg.model || null, requestId: o.requestId || msg.id || null,
    write, w5: cc.ephemeral_5m_input_tokens == null && cc.ephemeral_1h_input_tokens == null ? 0 : w5, w1,
    read, input, ctx: write + read + input,
  };
}

/** Newest assistant usage block in a transcript. Reads only the tail. */
function readLastUsage(transcriptPath) {
  if (!transcriptPath) return null;
  const p = transcriptPath.replace(/^~(?=$|\/)/, HOME);
  let fd; let size;
  try { size = fs.statSync(p).size; fd = fs.openSync(p, 'r'); } catch (_) { return null; }
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const u = parseUsageLine(lines[i]);
      if (u) return u;
    }
  } finally { fs.closeSync(fd); }
  return null;
}

/** Whole-transcript totals for the card: writes, reads, dollars, full misses. */
function scanTranscript(transcriptPath) {
  const p = (transcriptPath || '').replace(/^~(?=$|\/)/, HOME);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
  const seen = new Set();
  const t = { requests: 0, write: 0, read: 0, writeUsd: 0, readUsd: 0, fullMisses: 0, fullMissUsd: 0, model: null };
  let prevCtx = 0;
  for (const line of text.split('\n')) {
    const u = parseUsageLine(line);
    if (!u) continue;
    if (u.requestId && seen.has(u.requestId)) continue;
    if (u.requestId) seen.add(u.requestId);
    const pr = priceFor(u.model);
    t.requests++; t.write += u.write; t.read += u.read; t.model = u.model || t.model;
    let wUsd = 0;
    if (pr) {
      wUsd = (u.w5 * pr.write5m + (u.write - u.w5) * pr.write1h) / 1e6;
      t.writeUsd += wUsd; t.readUsd += u.read * pr.read / 1e6;
    }
    const full = prevCtx > 20000 && u.read < 0.5 * prevCtx && u.write > 0.5 * prevCtx;
    if (full) { t.fullMisses++; t.fullMissUsd += wUsd; }
    prevCtx = u.ctx;
  }
  return t;
}

/** Transcript for the current session when no payload names it (the skill path). */
function guessTranscript(cwd) {
  const slug = String(cwd || process.cwd()).replace(/[\\/.:]/g, '-');
  const dir = path.join(PROJECTS_DIR, slug);
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f);
      const m = fs.statSync(fp).mtimeMs;
      if (!best || m > best.m) best = { fp, m };
    }
  } catch (_) { return null; }
  return best ? best.fp : null;
}

// ---------- state and money ----------

function tierOf(u) {
  if (!u) return null;
  if (u.w1 > 0) return '1h';
  if (u.w5 > 0) return '5m';
  return null;
}

/** Cache state now, from the newest usage block. */
function stateFrom(u, nowMs) {
  if (!u) return null;
  const ttl = tierOf(u) || (process.env.CACHE_TAX_TTL === '5m' ? '5m' : '1h');
  const ageSec = Math.max(0, (nowMs - u.ts) / 1000);
  const leftSec = TTL_SEC[ttl] - ageSec;
  const pr = priceFor(u.model);
  const writeRate = pr ? (ttl === '5m' ? pr.write5m : pr.write1h) : null;
  return {
    ttl, ageSec, leftSec, lapsed: leftSec <= 0, ctx: u.ctx, model: u.model, family: pr ? pr.family : null,
    rewriteUsd: writeRate == null ? null : u.ctx * writeRate / 1e6,
    warmUsd: pr ? u.ctx * pr.read / 1e6 : null,
    writeRate,
  };
}

function fmtUsd(x) { return x == null ? 'n/a' : '$' + (x >= 100 ? x.toFixed(0) : x.toFixed(2)); }
function fmtTok(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n); }
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  return h > 0 ? h + 'h' + String(m).padStart(2, '0') + 'm' : m + 'm';
}

// ---------- the three pieces ----------

/** One line for a status line. Native prompt_cache first, transcript second. */
function statusLine(payload, nowMs) {
  const pc = payload && payload.prompt_cache;
  const modelId = payload && payload.model && (payload.model.id || payload.model.display_name);
  if (pc && typeof pc === 'object' && (pc.expires_at != null || pc.recache_tokens_if_cold != null)) {
    const pr = priceFor(modelId);
    const ttl = pc.ttl || '1h';
    const tokens = Number(pc.recache_tokens_if_cold) || 0;
    const rate = pr ? (ttl === '5m' ? pr.write5m : pr.write1h) : null;
    const cold = rate == null ? null : tokens * rate / 1e6;
    const leftSec = pc.expires_at != null ? Number(pc.expires_at) - nowMs / 1000 : null;
    const warm = pc.warm !== false && leftSec != null && leftSec > 0;
    const cause = pc.last_miss_cause && Array.isArray(pc.last_miss_cause.causes) && pc.last_miss_cause.causes.length
      ? ' · last miss ' + pc.last_miss_cause.causes[0] : '';
    if (warm) return `cache ${fmtDur(leftSec)} left · ${fmtTok(tokens)} · cold costs ${fmtUsd(cold)}${cause}`;
    return `cache COLD · next msg re-writes ${fmtTok(tokens)} = ${fmtUsd(cold)}${cause}`;
  }
  const u = readLastUsage(payload && payload.transcript_path);
  const st = stateFrom(u, nowMs);
  if (!st) return 'cache ?';
  if (!st.lapsed) return `cache ${fmtDur(st.leftSec)} left · ${fmtTok(st.ctx)} · cold costs ${fmtUsd(st.rewriteUsd)}`;
  return `cache LAPSED ${fmtDur(st.ageSec)} ago · next msg re-writes ${fmtTok(st.ctx)} = ${fmtUsd(st.rewriteUsd)}`;
}

function guardMessage(st) {
  const rate = st.writeRate == null ? 'the cache-write rate' : '$' + st.writeRate + '/MTok';
  const warm = st.warmUsd == null ? '' : ` (a warm turn would have cost ${fmtUsd(st.warmUsd)})`;
  return `cache-tax: the ${st.ttl} prompt cache lapsed ${fmtDur(st.ageSec)} ago. This message re-writes ` +
    `${st.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(st.rewriteUsd)}${warm}. ` +
    `If most of that context is stale, /clear and start from a handoff note instead.`;
}

/** UserPromptSubmit. Returns {exit, stdout, stderr}. */
function guard(payload, nowMs) {
  const u = readLastUsage(payload && payload.transcript_path);
  const st = stateFrom(u, nowMs);
  if (!st || !st.lapsed || st.ctx < BIG_TOKENS) return { exit: 0 };
  const msg = guardMessage(st);
  const sid = (payload && payload.session_id) || 'unknown';
  if (BLOCK) {
    const ackPath = path.join(STATE_DIR, sid + '.json');
    let ack = null;
    try { ack = JSON.parse(fs.readFileSync(ackPath, 'utf8')); } catch (_) { ack = null; }
    if (ack && ack.ts === u.ts) {
      // Already refused once for this exact state; the resend goes through.
      return { exit: 0, event: 'cache-tax.guard.ack', st };
    }
    try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(ackPath, JSON.stringify({ ts: u.ts })); } catch (_) { /* best effort */ }
    return { exit: 2, stderr: msg + ' Resend the same message to proceed.', event: 'cache-tax.guard.block', st };
  }
  return { exit: 0, stdout: JSON.stringify({ systemMessage: msg }), event: 'cache-tax.guard.warn', st };
}

/** SessionStart on resume or fork. */
function resume(payload, nowMs) {
  const src = payload && payload.source;
  if (src !== 'resume' && src !== 'fork') return { exit: 0 };
  if (payload.prompt_cache_likely_expired === true) {
    const usd = payload.estimated_cache_write_usd;
    const tok = Number(payload.context_tokens) || 0;
    const gap = Number(payload.seconds_since_last_response) || 0;
    const msg = `cache-tax: resuming after ${fmtDur(gap)}, the prompt cache is cold. The first message re-writes ` +
      `${tok.toLocaleString('en-US')} tokens${usd != null ? ', about ' + fmtUsd(Number(usd)) : ''}. ` +
      `If you only need the conclusions, /clear and paste a summary instead.`;
    return { exit: 0, stdout: JSON.stringify({ systemMessage: msg }), event: 'cache-tax.resume.cold' };
  }
  if (payload.prompt_cache_likely_expired === false) return { exit: 0 };
  // Older Claude Code without the resume fields: derive from the transcript.
  const st = stateFrom(readLastUsage(payload.transcript_path), nowMs);
  if (!st || !st.lapsed || st.ctx < BIG_TOKENS) return { exit: 0 };
  return { exit: 0, stdout: JSON.stringify({ systemMessage: guardMessage(st).replace('This message', 'The first message') }), event: 'cache-tax.resume.cold' };
}

/** /cache-tax:status card. */
function renderCard(transcriptPath, nowMs) {
  const u = readLastUsage(transcriptPath);
  const st = stateFrom(u, nowMs);
  if (!st) return 'cache-tax: no assistant usage found in the transcript yet.';
  const t = scanTranscript(transcriptPath) || {};
  const lines = [];
  lines.push(`cache-tax · ${st.model || 'unknown model'} · ${st.ttl} tier`);
  lines.push(st.lapsed
    ? `state       COLD, lapsed ${fmtDur(st.ageSec)} ago`
    : `state       warm, ${fmtDur(st.leftSec)} left`);
  lines.push(`context     ${st.ctx.toLocaleString('en-US')} tokens`);
  lines.push(`cold cost   ${fmtUsd(st.rewriteUsd)} to re-write it (warm turn ${fmtUsd(st.warmUsd)})`);
  if (t.requests) {
    lines.push(`session     ${t.requests} requests · writes ${fmtTok(t.write)} tok ${fmtUsd(t.writeUsd)} · reads ${fmtTok(t.read)} tok ${fmtUsd(t.readUsd)}`);
    lines.push(`full misses ${t.fullMisses} (${fmtUsd(t.fullMissUsd)}), each one a re-write of the whole prefix`);
  }
  lines.push(st.lapsed
    ? 'advice      the next message pays the cold cost. /clear plus a handoff note is cheaper if most context is stale.'
    : 'advice      a message before the timer runs out refreshes the cache at the read rate.');
  return lines.join('\n');
}

// ---------- io ----------

function log(event, extra) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(LOG_DIR, day + '.jsonl'), JSON.stringify(Object.assign({ ts: new Date().toISOString(), event }, extra || {})) + '\n');
  } catch (_) { /* logging is best effort */ }
}

function readStdin() {
  try { if (process.stdin.isTTY) return {}; } catch (_) { /* fall through */ }
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

function main() {
  const argv = process.argv.slice(2);
  const nowMs = Date.now();
  if (argv.includes('--render')) {
    const payload = readStdin();
    const tp = (payload && payload.transcript_path) || guessTranscript(process.cwd());
    process.stdout.write(renderCard(tp, nowMs) + '\n');
    return 0;
  }
  const payload = readStdin();
  if (argv.includes('--statusline') || (!payload.hook_event_name && (payload.prompt_cache || payload.context_window))) {
    process.stdout.write(statusLine(payload, nowMs) + '\n');
    return 0;
  }
  let r = { exit: 0 };
  if (payload.hook_event_name === 'UserPromptSubmit') r = guard(payload, nowMs);
  else if (payload.hook_event_name === 'SessionStart') r = resume(payload, nowMs);
  if (r.event) log(r.event, { session_id: payload.session_id, ctx: r.st && r.st.ctx, usd: r.st && r.st.rewriteUsd });
  if (r.stdout) process.stdout.write(r.stdout + '\n');
  if (r.stderr) process.stderr.write(r.stderr + '\n');
  return r.exit;
}

if (require.main === module) {
  process.exitCode = main();
} else {
  module.exports = {
    family, priceFor, parseUsageLine, readLastUsage, scanTranscript, guessTranscript,
    tierOf, stateFrom, statusLine, guard, guardMessage, resume, renderCard,
    fmtUsd, fmtTok, fmtDur, BIG_TOKENS, TTL_SEC,
  };
}
