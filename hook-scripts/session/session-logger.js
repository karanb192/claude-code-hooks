#!/usr/bin/env node
/**
 * Session Logger - SessionStart | PostToolUse | SessionEnd Hook
 * Writes a human-readable markdown log of every Claude Code session:
 * timestamps, cwd, git repo/branch, files touched, and bash commands run.
 * Logs to: ~/.claude/hooks-logs/ (hook diagnostics)
 * Session notes go to: $CC_SESSION_LOG_DIR (default: ~/.claude/sessions/)
 *
 * Why: Claude Code sessions are ephemeral. You finish a session, switch repos,
 * and two days later can't remember which session touched which file. This hook
 * gives you a durable, greppable (and Obsidian-friendly) record of every session.
 *
 * One script, three registrations in .claude/settings.json.
 *
 * PostToolUse uses "async": true so logging never blocks Claude — the hook
 * fires after every Edit/Write/Read/Bash, so keep it non-blocking. Because
 * async invocations can run concurrently (parallel tool calls), every write to
 * a note goes through a cross-process file lock (withLock) so concurrent
 * appends can't clobber each other. SessionStart is sync so the note file
 * exists before PostToolUse tries to append to it; SessionEnd is sync so
 * finalization completes before the session terminates.
 *
 * Secrets: bash commands are single-line-truncated AND run through a best-effort
 * redactor (redactSecrets) that masks common inline-secret shapes — sensitive
 * env assignments, --password/--token flags, Bearer tokens, and well-known key
 * prefixes (ghp_, xox…, sk-, AKIA…). This is best-effort, NOT a guarantee; an
 * unusual secret form can still slip through. Treat notes as sensitive and keep
 * synced folders (Obsidian/iCloud) private. File CONTENTS are never logged —
 * only paths for Edit/Write/Read.
 *
 * {
 *   "hooks": {
 *     "SessionStart": [{
 *       "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/session-logger.js" }]
 *     }],
 *     "PostToolUse":  [{
 *       "matcher": "Edit|Write|Bash|Read",
 *       "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/session-logger.js", "async": true }]
 *     }],
 *     "SessionEnd":   [{
 *       "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/session-logger.js" }]
 *     }]
 *   }
 * }
 *
 * Note: register against SessionEnd, NOT Stop. Stop fires at the end of every
 * Claude turn (many times per session); SessionEnd fires once when the session
 * actually ends. If the terminal is closed abruptly (SIGKILL), SessionEnd may
 * not fire — the note remains as-is with all activity up to the last tool call
 * preserved, just without a final ended: timestamp.
 *
 * Tip: point CC_SESSION_LOG_DIR at an Obsidian vault for cross-device sync.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────
// Where session notes are written. Customize this or set CC_SESSION_LOG_DIR.
// Tip: point this at an Obsidian vault or iCloud folder for cross-device sync.
// Examples:
//   iCloud:   path.join(process.env.HOME, 'Library/Mobile Documents/com~apple~CloudDocs/Claude-Code-Sessions')
//   Obsidian: path.join(process.env.HOME, 'Obsidian/MyVault/claude-sessions')
const SESSION_LOG_DIR = path.join(process.env.HOME, '.claude', 'sessions');

// Max characters logged per bash command (first line only, then truncated).
const BASH_TRUNCATE = 200;
// ─────────────────────────────────────────────────────────────────────────────

const LOG_DIR = path.join(process.env.HOME, '.claude', 'hooks-logs');
const SESSION_DIR = process.env.CC_SESSION_LOG_DIR || SESSION_LOG_DIR;

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'session-logger', ...data }) + '\n');
  } catch {}
}

function gitInfo(cwd) {
  const info = { repo: null, branch: null, remote: null };
  try {
    info.branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, stdio: 'pipe' }).toString().trim();
  } catch {}
  try {
    const remote = execSync('git config --get remote.origin.url', { cwd, stdio: 'pipe' }).toString().trim();
    info.remote = remote;
    // Extract "owner/repo" from common git URL formats
    const m = remote.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) info.repo = m[1];
  } catch {}
  return info;
}

function sessionFilePath(sessionId, startedAt, cwd) {
  const d = new Date(startedAt);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const shortId = (sessionId || 'unknown').slice(0, 8);
  return path.join(SESSION_DIR, `${yyyy}-${mm}-${dd}_${hh}${mi}_${shortId}.md`);
}

function findExistingFile(sessionId) {
  if (!fs.existsSync(SESSION_DIR)) return null;
  const shortId = (sessionId || 'unknown').slice(0, 8);
  const files = fs.readdirSync(SESSION_DIR).filter(f => f.endsWith(`_${shortId}.md`));
  if (files.length === 0) return null;
  // If multiple (shouldn't happen often), pick most recent
  files.sort();
  return path.join(SESSION_DIR, files[files.length - 1]);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Synchronous sleep — hooks are short-lived one-shot processes, so a blocking
// wait while spinning for the lock is fine (and simpler than going async).
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Cross-process advisory lock. PostToolUse runs with "async": true, so parallel
// tool calls can invoke this script concurrently; the note write is a
// read-modify-write and would otherwise lose entries (last writer wins). We
// serialize per-note via an exclusive lockfile. Best-effort: if we can't get
// the lock within the budget, we proceed unlocked rather than drop the write —
// a rare interleave beats silent data loss.
function withLock(filePath, fn, { retries = 60, delayMs = 15, staleMs = 10000 } = {}) {
  const lockPath = `${filePath}.lock`;
  for (let i = 0; i < retries; i++) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx'); // atomic create-exclusive
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Steal a stale lock left behind by a crashed/killed process.
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) fs.unlinkSync(lockPath);
      } catch {}
      sleepSync(delayMs);
      continue;
    }
    try {
      return fn();
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
  log({ level: 'LOCK_TIMEOUT', file: filePath });
  return fn(); // proceed unlocked rather than lose the entry
}

// Best-effort masking of the most common inline-secret shapes on a single
// command line. NOT a guarantee — see the header note. Conservative by design:
// we'd rather miss an exotic secret than mangle legitimate commands in the log.
function redactSecrets(cmd) {
  return cmd
    // Sensitive-looking env-style assignments: TOKEN=…, AWS_SECRET_ACCESS_KEY=…
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH)[A-Z0-9_]*)=(\S+)/gi, '$1=***')
    // Long-form flags with a value: --password foo, --token=foo, --api-key foo
    .replace(/(--(?:password|token|secret|api[-_]?key)[= ])\S+/gi, '$1***')
    // Authorization: Bearer <token>
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1***')
    // Well-known token prefixes (GitHub, Slack, OpenAI, AWS, Stripe)
    .replace(/\b(gh[pousr]_|xox[baprs]-|sk-|AKIA|ASIA|sk_live_|rk_live_)[A-Za-z0-9\-_]{6,}/g, '$1***');
}

function handleSessionStart(data) {
  const { session_id, cwd } = data;
  const started = new Date().toISOString();
  ensureDir(SESSION_DIR);

  const existing = findExistingFile(session_id);
  if (existing) {
    // Session resumed — append a resume marker, don't overwrite.
    fs.appendFileSync(existing, `\n## Resumed at ${started}\n`);
    log({ level: 'RESUME', session_id, file: existing });
    return;
  }

  const git = gitInfo(cwd || process.cwd());
  const cwdBase = path.basename(cwd || process.cwd());
  const filePath = sessionFilePath(session_id, started, cwd);

  const frontmatter = [
    '---',
    `session_id: ${session_id || 'unknown'}`,
    `cwd: ${cwd || process.cwd()}`,
    `git_repo: ${git.repo || 'n/a'}`,
    `git_branch: ${git.branch || 'n/a'}`,
    `started: ${started}`,
    'ended:',
    '---',
    '',
    `# Claude Code Session — ${cwdBase}`,
    '',
    `**Started:** ${started}`,
    `**Working dir:** \`${cwd || process.cwd()}\``,
    git.repo ? `**Repo:** ${git.repo} (${git.branch || 'detached'})` : null,
    '',
    '## Files Touched',
    '',
    '## Commands Run',
    '',
  ].filter(l => l !== null).join('\n');

  fs.writeFileSync(filePath, frontmatter);
  log({ level: 'START', session_id, file: filePath });
}

function handlePostToolUse(data) {
  const { session_id, tool_name, tool_input } = data;
  if (!['Edit', 'Write', 'Bash', 'Read'].includes(tool_name)) return;

  const filePath = findExistingFile(session_id);
  if (!filePath) {
    log({ level: 'SKIP', reason: 'no session file', session_id });
    return;
  }

  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  let entry = null;
  let section = null;

  if (tool_name === 'Edit' || tool_name === 'Write' || tool_name === 'Read') {
    const f = tool_input?.file_path;
    if (!f) return;
    const verb = tool_name === 'Read' ? 'read' : tool_name === 'Write' ? 'wrote' : 'edited';
    entry = `- \`${ts}\` ${verb} \`${f}\``;
    section = '## Files Touched';
  } else if (tool_name === 'Bash') {
    let cmd = tool_input?.command || '';
    cmd = redactSecrets(cmd.split('\n')[0]);
    if (cmd.length > BASH_TRUNCATE) cmd = cmd.slice(0, BASH_TRUNCATE) + '…';
    entry = `- \`${ts}\` \`${cmd}\``;
    section = '## Commands Run';
  }

  if (!entry || !section) return;
  appendUnderSection(filePath, section, entry);
  log({ level: 'APPEND', session_id, tool: tool_name });
}

function appendUnderSection(filePath, section, entry) {
  withLock(filePath, () => {
    const body = fs.readFileSync(filePath, 'utf8');
    const lines = body.split('\n');
    const sectionIdx = lines.findIndex(l => l.trim() === section);
    if (sectionIdx === -1) {
      // Section missing — append at end
      fs.appendFileSync(filePath, `\n${section}\n\n${entry}\n`);
      return;
    }
    // Find end of section (next ## heading or EOF)
    let insertAt = lines.length;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        insertAt = i;
        break;
      }
    }
    // Skip trailing blank lines in the section
    while (insertAt > sectionIdx + 1 && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, entry);
    fs.writeFileSync(filePath, lines.join('\n'));
  });
}

function handleSessionEnd(data) {
  const { session_id, cwd } = data;
  const filePath = findExistingFile(session_id);
  if (!filePath) {
    log({ level: 'SKIP', reason: 'no session file on end', session_id });
    return;
  }

  const ended = new Date().toISOString();

  // Capture final git status (short) outside the lock — no need to hold it
  // during a subprocess call.
  let gitStatus = '';
  try {
    gitStatus = execSync('git status --short', { cwd: cwd || process.cwd(), stdio: 'pipe' }).toString().trim();
  } catch {}

  withLock(filePath, () => {
    // Idempotent: skip if already finalized (defensive — protects against the
    // user accidentally registering against Stop, which fires every turn).
    // The frontmatter is seeded with a literal "ended:" line; once we fill it,
    // this regex no longer matches and we skip. The check + write are inside the
    // lock so a duplicate SessionEnd can't race past the guard.
    let body = fs.readFileSync(filePath, 'utf8');
    if (!/^ended:[ \t]*$/m.test(body)) {
      log({ level: 'SKIP', reason: 'already finalized', session_id });
      return;
    }

    // Update frontmatter `ended:` line
    body = body.replace(/^ended:[ \t]*$/m, `ended: ${ended}`);

    const footer = [
      '',
      '## Session End',
      '',
      `**Ended:** ${ended}`,
    ];
    if (gitStatus) {
      footer.push('', '**Final git status:**', '```', gitStatus, '```');
    }
    fs.writeFileSync(filePath, body + footer.join('\n') + '\n');
    log({ level: 'END', session_id, file: filePath });
  });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const data = JSON.parse(input);
    const event = data.hook_event_name;
    if (event === 'SessionStart') handleSessionStart(data);
    else if (event === 'PostToolUse') handlePostToolUse(data);
    else if (event === 'SessionEnd') handleSessionEnd(data);
    // Note: Stop is intentionally NOT handled. It fires every turn, not once
    // per session. Register against SessionEnd instead.
    console.log('{}');
  } catch (e) {
    log({ level: 'ERROR', error: e.message });
    console.log('{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    gitInfo,
    sessionFilePath,
    findExistingFile,
    appendUnderSection,
    redactSecrets,
    withLock,
    handleSessionStart,
    handlePostToolUse,
    handleSessionEnd,
  };
}
