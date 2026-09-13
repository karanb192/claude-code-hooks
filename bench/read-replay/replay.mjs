#!/usr/bin/env node
// Read-gate replay. Walks your own Claude Code transcripts and answers one
// question: if a Spotify-shunt-style Read gate had been installed, how many
// Read calls would it have caught, and what share of your context tokens were
// they? Nothing is sent anywhere; the script only reads ~/.claude/projects.
// See bench/read-replay/README.md for how to read the numbers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE = `Usage: node bench/read-replay/replay.mjs [options]

  --days=<n>         window in days, by transcript mtime (default 30)
  --projects=<dir>   transcript root (default ~/.claude/projects)
  --min-lines=<n>    gate threshold in lines, shunt's SHUNT_MIN_LINES (default 350)
  --json             print the raw object instead of the markdown receipt
  --help, -h         show this help

Prints a receipt of how many Read calls a whole-file gate over --min-lines
would have caught in your own transcripts, and what share of your context
tokens they were. Token counts are estimated as ceil(chars / 4).`;

// A whole-file read also qualifies when the returned text is huge even if the
// line count is small (minified bundles, long single lines). Same rule as the
// original forecast script.
const BIG_RESULT_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Strict argv parsing: a typo like --dyas=5 or a space-separated --days 30
// must not silently fall back to the defaults.
function parseArgs(argv) {
  const opts = { days: '30', projects: path.join(os.homedir(), '.claude', 'projects'), 'min-lines': '350', json: false };
  const valueFlags = new Set(['days', 'projects', 'min-lines']);
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) fail(`unexpected argument: ${arg}\n\n${USAGE}`);
    const [, name, value] = m;
    if (name === 'json' && value === undefined) { opts.json = true; continue; }
    if (!valueFlags.has(name)) fail(`unknown option: ${arg}\n\n${USAGE}`);
    if (value === undefined) fail(`${arg} needs a value, e.g. ${arg}=<value>\n\n${USAGE}`);
    opts[name] = value;
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const isPositiveInt = (s) => /^\d+$/.test(s) && Number(s) > 0;
if (!isPositiveInt(opts.days)) fail('invalid --days: expected a positive whole number, e.g. --days=30');
if (!isPositiveInt(opts['min-lines'])) fail('invalid --min-lines: expected a positive whole number, e.g. --min-lines=350');
const DAYS = Number(opts.days);
const MIN_LINES = Number(opts['min-lines']);
const PROJECTS = opts.projects;
const JSON_OUT = opts.json;

// ---------------------------------------------------------------------------
// Transcript discovery
// ---------------------------------------------------------------------------

// Every fs call here tolerates a missing, unreadable or wrongly typed entry:
// one locked project dir must not abort the whole run.
function readdirSafe(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Layout under ~/.claude/projects:
//   <project-slug>/<session>.jsonl                  main transcript
//   <project-slug>/<session>/subagents/<agent>.jsonl subagent transcripts
// Subagents matter: on a research-heavy machine most of the big reads live there.
function discoverTranscripts(root, cutoffMs) {
  const files = [];
  const pushIfRecent = (fp) => {
    const st = statSafe(fp);
    if (st && st.isFile() && st.mtimeMs > cutoffMs) files.push(fp);
  };
  for (const project of readdirSafe(root)) {
    const projectDir = path.join(root, project);
    const st = statSafe(projectDir);
    if (!st || !st.isDirectory()) continue;
    for (const entry of readdirSafe(projectDir)) {
      if (entry.endsWith('.jsonl')) pushIfRecent(path.join(projectDir, entry));
      const subagentDir = path.join(projectDir, entry, 'subagents');
      const subSt = statSafe(subagentDir);
      if (!subSt || !subSt.isDirectory()) continue;
      for (const sub of readdirSafe(subagentDir)) {
        if (sub.endsWith('.jsonl')) pushIfRecent(path.join(subagentDir, sub));
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Token estimate. Claude Code does not log token counts per tool result, so
// the replay uses the common chars/4 approximation. It is an estimate.
const estimateTokens = (text) => Math.ceil(text.length / 4);

// A tool_result's content is either a string or an array of content blocks.
function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((part) => (part && part.type === 'text' ? part.text : '')).join('');
  }
  return '';
}

// Bash commands that read a whole file into context without piping or
// redirecting. Shunt's check-bash-read hook targets exactly these.
const BASH_READ = /^\s*(cat|head|tail|less|more|sed -n|bat)\b/;
const PIPED_OR_REDIRECTED = /[|>]/;

function lineBucket(lines) {
  if (lines < 100) return '<100';
  if (lines < 350) return '100-349';
  if (lines < 1000) return '350-999';
  if (lines < 2000) return '1000-1999';
  return '>=2000';
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function newTotals() {
  return {
    contextTokens: 0,
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reads: 0,
    imageReads: 0,
    pdfReads: 0,
    errorReads: 0,
    targetedReads: 0,
    smallFullReads: 0,
    qualifyingReads: 0,
    qualifyingOneShotTokens: 0,
    qualifyingCarriedTokens: 0,
    bashReads: 0,
    bashReadTokens: 0,
    atMentionFiles: 0,
    atMentionTokens: 0,
    histogram: {},
    versions: new Set(),
  };
}

// Replays one transcript into `t`. Each transcript is self-contained: tool_use
// and its tool_result live in the same file, and a message id is unique to it.
function replayTranscript(text, t) {
  const seenMessageIds = new Set();
  const toolUseById = {}; // tool_use id -> { read: input } | { bash: command }

  // Qualifying reads not yet flushed. Each later assistant turn re-sends the
  // gated bytes (as cache reads at best), so carried tokens = bytes x turns
  // until a compact boundary drops the old tool output.
  let pending = [];
  const flushCarried = () => {
    for (const p of pending) t.qualifyingCarriedTokens += p.tokens * p.turns;
    pending = [];
  };

  for (const line of text.replace(/^﻿/, '').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue; // a bare `null` or number parses fine; skip it

    if (typeof o.version === 'string') t.versions.add(o.version);

    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      flushCarried();
      continue;
    }

    // Files pulled in with @-mention arrive as attachments, not Read calls.
    // Counted separately; they never enter the Read denominator.
    if (o.type === 'attachment' && o.attachment && o.attachment.type === 'file') {
      t.atMentionFiles++;
      const content = o.attachment.content && o.attachment.content.file && o.attachment.content.file.content;
      if (typeof content === 'string') t.atMentionTokens += estimateTokens(content);
      continue;
    }

    if (o.type === 'assistant' && o.message) {
      const m = o.message;
      // One API response can be logged as several assistant lines (one per
      // content block) that share a message id and usage: count usage once.
      // A line with usage but no id cannot be a duplicate of anything, so it
      // counts. Models starting with "<" are synthetic local messages with no
      // API call.
      const synthetic = String(m.model || '').startsWith('<');
      const duplicate = m.id != null && seenMessageIds.has(m.id);
      if (m.usage && !synthetic && !duplicate) {
        if (m.id != null) seenMessageIds.add(m.id);
        const u = m.usage;
        const input = u.input_tokens || 0;
        const cacheW = u.cache_creation_input_tokens || 0;
        const cacheR = u.cache_read_input_tokens || 0;
        t.inputTokens += input;
        t.cacheCreationTokens += cacheW;
        t.cacheReadTokens += cacheR;
        t.contextTokens += input + cacheW + cacheR;
        t.outputTokens += u.output_tokens || 0;
        for (const p of pending) p.turns++;
      }
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b || b.type !== 'tool_use') continue;
          if (b.name === 'Read') toolUseById[b.id] = { read: b.input || {} };
          if (b.name === 'Bash') toolUseById[b.id] = { bash: String((b.input && b.input.command) || '') };
        }
      }
      continue;
    }

    if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (!b || b.type !== 'tool_result') continue;
        const meta = toolUseById[b.tool_use_id];
        if (!meta) continue;
        const txt = resultText(b);
        const tokens = estimateTokens(txt);

        // Deliberate divergence from forecast.js, which tested `if (meta.bash)`
        // and so let a Bash call with an empty command fall through and be
        // counted as a Read. Any Bash call is a Bash call.
        if (meta.bash !== undefined) {
          if (BASH_READ.test(meta.bash) && !PIPED_OR_REDIRECTED.test(meta.bash)) {
            t.bashReads++;
            t.bashReadTokens += tokens;
          }
          continue;
        }

        // A Read call paired with its result.
        t.reads++;
        const r = o.toolUseResult || {};
        if (b.is_error) {
          t.errorReads++; // missing file, permission denied, blocked by a hook: nothing entered context
          continue;
        }
        if (r.type === 'image' || (r.file && r.file.base64)) {
          t.imageReads++; // a gate on line counts has nothing to say about images
          continue;
        }
        if (r.type === 'pdf') {
          t.pdfReads++; // same for PDFs
          continue;
        }
        const input = meta.read;
        if (input.offset != null || input.limit != null) {
          t.targetedReads++; // already paged by the model: shunt lets these through
          continue;
        }
        const file = r.file || {};
        // Fallback when the result carries no line metadata: count the lines
        // of the returned text itself.
        const linesReturned = file.numLines || (txt ? txt.split('\n').length : 0);
        const bucket = lineBucket(linesReturned);
        t.histogram[bucket] = (t.histogram[bucket] || 0) + 1;

        const fileLines = file.totalLines || linesReturned;
        if (fileLines > MIN_LINES || txt.length > BIG_RESULT_CHARS) {
          t.qualifyingReads++;
          t.qualifyingOneShotTokens += tokens;
          pending.push({ tokens, turns: 0 });
        } else {
          t.smallFullReads++;
        }
      }
    }
  }
  flushCarried();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const projectsStat = statSafe(PROJECTS);
if (!projectsStat || !projectsStat.isDirectory()) {
  fail(`projects dir not found: ${PROJECTS}\nPass --projects=<dir> or run Claude Code once so ~/.claude/projects exists.`);
}

const started = Date.now();
const cutoff = started - DAYS * 86_400_000;
const files = discoverTranscripts(PROJECTS, cutoff);
const totals = newTotals();
let bytes = 0;

for (const fp of files) {
  let text;
  try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
  bytes += text.length;
  replayTranscript(text, totals);
}

const seconds = (Date.now() - started) / 1000;
// The gate can only ever act on text reads that were not already paged, so
// images, PDFs and errored reads leave the denominator.
const textReads = Math.max(1, totals.reads - totals.imageReads - totals.pdfReads - totals.errorReads);
const ctx = Math.max(1, totals.contextTokens);
const pct = (num, den, digits) => Number(((100 * num) / den).toFixed(digits));

const versions = [...totals.versions].sort(compareVersions);
const result = {
  window: { days: DAYS, minLines: MIN_LINES, projectsDir: PROJECTS },
  scan: { files: files.length, megabytes: Math.round(bytes / 1e6), seconds: Number(seconds.toFixed(3)), versions },
  tokens: {
    context: totals.contextTokens,
    input: totals.inputTokens,
    cacheCreation: totals.cacheCreationTokens,
    cacheRead: totals.cacheReadTokens,
    output: totals.outputTokens,
    estimate: 'ceil(chars / 4) of the tool result text; context = input + cache_creation + cache_read',
  },
  reads: {
    total: totals.reads,
    images: totals.imageReads,
    pdfs: totals.pdfReads,
    errors: totals.errorReads,
    targeted: totals.targetedReads,
    smallFull: totals.smallFullReads,
    qualifying: totals.qualifyingReads,
    pctQualifyingOfText: pct(totals.qualifyingReads, textReads, 1),
    pctTargetedOfText: pct(totals.targetedReads, textReads, 1),
    histogram: totals.histogram,
  },
  wouldGate: {
    oneShotTokens: totals.qualifyingOneShotTokens,
    pctOneShotOfContext: pct(totals.qualifyingOneShotTokens, ctx, 3),
    carriedTokens: totals.qualifyingCarriedTokens,
    pctCarriedOfContext: pct(totals.qualifyingCarriedTokens, ctx, 2),
  },
  bashReads: { calls: totals.bashReads, tokens: totals.bashReadTokens },
  atMentions: { files: totals.atMentionFiles, tokens: totals.atMentionTokens },
};

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(receipt(result));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function n(v) { return v.toLocaleString('en-US'); }
function short(v) {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(v);
}

function receipt(r) {
  const v = r.scan.versions;
  const versionCell = v.length === 0 ? 'none recorded' : v.length === 1 ? v[0] : `${v.length} (${v[0]} to ${v[v.length - 1]})`;
  const rows = [
    ['Transcripts scanned', `${n(r.scan.files)} files, ${n(r.scan.megabytes)} MB, ${r.scan.seconds.toFixed(1)} s`],
    ['Claude Code versions seen', versionCell],
    ['Read calls paired with a result', n(r.reads.total)],
    ['Image and PDF reads (excluded)', `${n(r.reads.images + r.reads.pdfs)} (${n(r.reads.images)} images, ${n(r.reads.pdfs)} PDFs)`],
    ['Errored reads (excluded)', n(r.reads.errors)],
    ['Targeted reads, offset or limit set (never gated)', `${n(r.reads.targeted)} (${r.reads.pctTargetedOfText}% of text reads)`],
    [`Reads that would qualify (> ${n(r.window.minLines)} lines or > ${n(BIG_RESULT_CHARS)} chars)`, `${n(r.reads.qualifying)} (${r.reads.pctQualifyingOfText}% of text reads)`],
    ['One-shot tokens gated (est.)', `${n(r.wouldGate.oneShotTokens)} = ${r.wouldGate.pctOneShotOfContext}% of ${short(r.tokens.context)} context tokens`],
    ['Carried to the next compact (upper bound, est.)', `${n(r.wouldGate.carriedTokens)} = ${r.wouldGate.pctCarriedOfContext}% of context tokens`],
    ['Unpiped Bash reads (cat, head, tail, sed -n)', `${n(r.bashReads.calls)} calls, ${n(r.bashReads.tokens)} tokens (est.)`],
    ['@-mentioned files (attachments, not Read calls, not gated)', `${n(r.atMentions.files)} files, ${n(r.atMentions.tokens)} tokens (est.)`],
  ];
  return [
    `## Read-gate replay receipt (last ${r.window.days} days)`,
    '',
    '| Measure | Value |',
    '|---|---|',
    ...rows.map(([k, val]) => `| ${k} | ${val} |`),
    '',
    'Tokens are estimated as ceil(chars / 4) of the tool result text. Context tokens = input + cache_creation + cache_read summed over assistant messages, deduped by message id. Carried tokens assume every gated result is re-sent on each later turn until the next compact, so treat that row as a ceiling.',
  ].join('\n');
}
