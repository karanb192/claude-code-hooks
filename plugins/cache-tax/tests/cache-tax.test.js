#!/usr/bin/env node
/**
 * Tests for cache-tax.js
 *
 * Run: node --test plugins/cache-tax/tests/cache-tax.test.js
 * Or:  npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'cache-tax.js');
const mod = require(SCRIPT);
const { family, priceFor, parseUsageLine, readLastUsage, scanTranscript, tierOf, stateFrom, statusLine, guard, resume, renderCard, fmtDur } = mod;

const HOUR = 3600 * 1000;

function usageLine({ ts, model = 'claude-fable-5-1', write = 0, read = 0, input = 2, tier = '1h', id }) {
  const cc = tier === '5m' ? { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 }
    : { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write };
  return JSON.stringify({
    type: 'assistant', timestamp: new Date(ts).toISOString(), requestId: id || 'req_' + ts,
    message: { model, id: 'msg_' + ts, usage: { input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: 10, cache_creation: cc } },
  });
}

function writeTranscript(dir, lines) {
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, lines.map(l => (typeof l === 'string' ? l : usageLine(l))).join('\n') + '\n');
  return p;
}

function run(payload, env = {}, args = []) {
  const r = spawnSync('node', [SCRIPT, ...args], { input: JSON.stringify(payload), env: Object.assign({}, process.env, env), encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-tax-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('pricing', () => {
  it('maps model ids to the longest matching family', () => {
    assert.strictEqual(family('claude-fable-5-1'), 'fable-5-1');
    assert.strictEqual(family('claude-fable-5'), 'fable-5');
    assert.strictEqual(family('claude-opus-5'), 'opus-5');
    assert.strictEqual(family('claude-opus-4-8'), 'opus-4');
    assert.strictEqual(family('claude-sonnet-5'), 'sonnet');
    assert.strictEqual(family('something-else'), null);
  });
  it('prices the 1h write at 80x the read on Fable 5.1', () => {
    const p = priceFor('claude-fable-5-1');
    assert.strictEqual(p.write1h / p.read, 80);
    assert.strictEqual(p.write5m, 12.5);
  });
});

describe('transcript parsing', () => {
  it('parses an assistant usage line and computes context', () => {
    const u = parseUsageLine(usageLine({ ts: 1000, write: 100, read: 900, input: 5 }));
    assert.strictEqual(u.ctx, 1005);
    assert.strictEqual(u.w1, 100);
    assert.strictEqual(tierOf(u), '1h');
  });
  it('ignores non-assistant lines and junk', () => {
    assert.strictEqual(parseUsageLine('{"type":"user","message":{"usage":{}}}'), null);
    assert.strictEqual(parseUsageLine('not json "assistant" "usage"'), null);
  });
  it('readLastUsage returns the newest block', () => {
    const p = writeTranscript(tmp, [{ ts: 1000, write: 10, read: 0 }, { ts: 2000, write: 5, read: 50 }]);
    const u = readLastUsage(p);
    assert.strictEqual(u.ts, 2000);
    assert.strictEqual(u.ctx, 57);
  });
  it('scanTranscript counts full misses and dedupes streamed chunks', () => {
    const p = writeTranscript(tmp, [
      { ts: 1000, write: 100000, read: 0, id: 'a' },
      { ts: 2000, write: 500, read: 100000, id: 'b' },
      { ts: 2000, write: 500, read: 100000, id: 'b' },           // duplicate chunk
      { ts: 3000 + 2 * HOUR, write: 100500, read: 0, id: 'c' }, // full re-write
    ]);
    const t = scanTranscript(p);
    assert.strictEqual(t.requests, 3);
    assert.strictEqual(t.fullMisses, 1);
    assert.ok(t.fullMissUsd > 2, 'full miss priced at the 1h write rate');
  });
});

describe('state', () => {
  it('is warm inside the TTL and lapsed after it', () => {
    const now = Date.now();
    const warm = stateFrom(parseUsageLine(usageLine({ ts: now - 10 * 60000, write: 1000, read: 200000 })), now);
    assert.strictEqual(warm.lapsed, false);
    assert.ok(warm.leftSec > 49 * 60 && warm.leftSec <= 50 * 60);
    const cold = stateFrom(parseUsageLine(usageLine({ ts: now - 2 * HOUR, write: 1000, read: 200000 })), now);
    assert.strictEqual(cold.lapsed, true);
    assert.ok(Math.abs(cold.rewriteUsd - 201002 * 20 / 1e6) < 1e-6);
  });
  it('uses the 5m TTL when the last write was on the 5m tier', () => {
    const now = Date.now();
    const st = stateFrom(parseUsageLine(usageLine({ ts: now - 6 * 60000, write: 1000, read: 90000, tier: '5m' })), now);
    assert.strictEqual(st.ttl, '5m');
    assert.strictEqual(st.lapsed, true);
    assert.ok(Math.abs(st.rewriteUsd - 91002 * 12.5 / 1e6) < 1e-6);
  });
  it('formats durations', () => {
    assert.strictEqual(fmtDur(59 * 60), '59m');
    assert.strictEqual(fmtDur(29 * 3600), '1d 5h');
    assert.strictEqual(fmtDur(3600 + 60), '1h01m');
  });
});

describe('status line', () => {
  it('prefers the native prompt_cache object', () => {
    const now = Date.now();
    const line = statusLine({ model: { id: 'claude-fable-5-1' }, prompt_cache: { warm: true, ttl: '1h', expires_at: now / 1000 + 1800, recache_tokens_if_cold: 400000, last_miss_cause: { causes: ['ttl_expired_1h'] } } }, now);
    assert.match(line, /^cache 30m left · 400k · cold costs \$8\.00 · last miss ttl_expired_1h$/);
  });
  it('reports a cold cache from the native object', () => {
    const now = Date.now();
    const line = statusLine({ model: { id: 'claude-opus-5' }, prompt_cache: { warm: false, ttl: '1h', expires_at: now / 1000 - 5, recache_tokens_if_cold: 100000 } }, now);
    assert.match(line, /^cache COLD · next msg re-writes 100k = \$1\.00$/);
  });
  it('falls back to the transcript', () => {
    const now = Date.now();
    const p = writeTranscript(tmp, [{ ts: now - 2 * HOUR, write: 1000, read: 299000 }]);
    const line = statusLine({ transcript_path: p }, now);
    assert.match(line, /^cache LAPSED 2h00m ago · next msg re-writes 300k = \$6\.00$/);
  });
  it('falls back to the transcript when the native object is incomplete (right after compaction)', () => {
    const now = Date.now();
    const p = writeTranscript(tmp, [{ ts: now - 60000, write: 1000, read: 99000 }]);
    const line = statusLine({ transcript_path: p, model: { id: 'claude-fable-5-1' }, prompt_cache: { warm: true, ttl: '1h', expires_at: now / 1000 + 3540, recache_tokens_if_cold: null } }, now);
    assert.match(line, /^cache 59m left · 100k · cold costs \$2\.00$/);
  });
  it('prints a placeholder when nothing is known', () => {
    assert.strictEqual(statusLine({ transcript_path: path.join(tmp, 'missing.jsonl') }, Date.now()), 'cache ?');
  });
});

describe('guard (UserPromptSubmit)', () => {
  it('stays silent while warm', () => {
    const now = Date.now();
    const p = writeTranscript(tmp, [{ ts: now - 60000, write: 1000, read: 299000 }]);
    assert.deepStrictEqual(guard({ transcript_path: p, session_id: 's1' }, now), { exit: 0 });
  });
  it('ignores slash commands even when cold', () => {
    const now = Date.now();
    const p = writeTranscript(tmp, [{ ts: now - 3 * HOUR, write: 1000, read: 299000 }]);
    assert.deepStrictEqual(guard({ transcript_path: p, session_id: 's1', prompt: '/clear' }, now), { exit: 0 });
    assert.notStrictEqual(guard({ transcript_path: p, session_id: 's1', prompt: 'hi' }, now).exit, undefined);
  });
  it('stays silent when the context is small', () => {
    const now = Date.now();
    const p = writeTranscript(tmp, [{ ts: now - 3 * HOUR, write: 1000, read: 2000 }]);
    assert.deepStrictEqual(guard({ transcript_path: p, session_id: 's1' }, now), { exit: 0 });
  });
  it('warns with the dollar figure when lapsed (integration, exit 0)', () => {
    const p = writeTranscript(tmp, [{ ts: Date.now() - 3 * HOUR, write: 1000, read: 299000 }]);
    const r = run({ hook_event_name: 'UserPromptSubmit', transcript_path: p, session_id: 's-warn' }, { CACHE_TAX_BLOCK: '' });
    assert.strictEqual(r.code, 0);
    const o = JSON.parse(r.out);
    assert.match(o.systemMessage, /lapsed 3h00m ago/);
    assert.match(o.systemMessage, /300,002 tokens at \$20\/MTok = \$6\.00/);
  });
  it('blocks once, then lets the resend through (integration, exit 2 then 0)', () => {
    const p = writeTranscript(tmp, [{ ts: Date.now() - 3 * HOUR, write: 1000, read: 299000 }]);
    const home = fs.mkdtempSync(path.join(tmp, 'home-'));
    const env = { CACHE_TAX_BLOCK: '1', HOME: home };
    const first = run({ hook_event_name: 'UserPromptSubmit', transcript_path: p, session_id: 's-block' }, env);
    assert.strictEqual(first.code, 2);
    assert.match(first.err, /Resend the same message to proceed/);
    const second = run({ hook_event_name: 'UserPromptSubmit', transcript_path: p, session_id: 's-block' }, env);
    assert.strictEqual(second.code, 0);
    assert.strictEqual(second.out, '');
  });
});

describe('resume (SessionStart)', () => {
  it('uses the native estimate on a cold resume', () => {
    const r = resume({ source: 'resume', prompt_cache_likely_expired: true, seconds_since_last_response: 5400, context_tokens: 182340, estimated_cache_write_usd: 1.1396 }, Date.now());
    assert.strictEqual(r.exit, 0);
    const o = JSON.parse(r.stdout);
    assert.match(o.systemMessage, /resuming after 1h30m/);
    assert.match(o.systemMessage, /182,340 tokens, about \$1\.14/);
  });
  it('is silent on startup and on a warm resume', () => {
    assert.deepStrictEqual(resume({ source: 'startup' }, Date.now()), { exit: 0 });
    assert.deepStrictEqual(resume({ source: 'resume', prompt_cache_likely_expired: false }, Date.now()), { exit: 0 });
  });
  it('falls back to the transcript on older Claude Code', () => {
    const p = writeTranscript(tmp, [{ ts: Date.now() - 3 * HOUR, write: 1000, read: 299000 }]);
    const r = resume({ source: 'resume', transcript_path: p }, Date.now());
    assert.match(JSON.parse(r.stdout).systemMessage, /The first message re-writes 300,002 tokens/);
  });
});

describe('card (--render)', () => {
  it('renders state, cost and session totals', () => {
    const now = Date.now();
    const p = writeTranscript(tmp, [{ ts: now - 3 * HOUR, write: 100000, read: 0, id: 'a' }, { ts: now - 2 * HOUR, write: 500, read: 100000, id: 'b' }]);
    const card = renderCard(p, now);
    assert.match(card, /cache-tax · claude-fable-5-1 · 1h tier/);
    assert.match(card, /COLD, lapsed 2h00m ago/);
    assert.match(card, /cold cost   \$2\.01/);
    assert.match(card, /session     2 requests/);
    const r = run({}, {}, ['--render', '--transcript', p]);
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /cache-tax ·/);
  });
});

describe('dispatch', () => {
  it('ignores unrelated hook events and empty input', () => {
    assert.strictEqual(run({ hook_event_name: 'PreToolUse' }).code, 0);
    const r = spawnSync('node', [SCRIPT], { input: '', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
  });
  it('treats a status line payload without a flag as a status line', () => {
    const r = run({ model: { id: 'claude-fable-5-1' }, context_window: {}, prompt_cache: { warm: true, ttl: '1h', expires_at: Date.now() / 1000 + 600, recache_tokens_if_cold: 50000 } });
    assert.match(r.out, /^cache 10m left · 50k · cold costs \$1\.00$/);
  });
});
