#!/usr/bin/env node
/**
 * Session Logger - SessionStart | PostToolUse | Stop Hook
 * Writes a human-readable markdown log of every Claude Code session:
 * timestamps, cwd, git repo/branch, files touched, and bash commands run.
 * Logs to: ~/.claude/hooks-logs/ (hook diagnostics)
 * Session notes go to: $CC_SESSION_LOG_DIR (default: ~/.claude/sessions/)
 *
 * Why: Claude Code sessions are ephemeral. You finish a session, switch repos,
 * and two days later can't remember which session touched which file. This hook
 * gives you a durable, greppable (and Obsidian-friendly) record of every session.
 *
 * One script, three registrations in .claude/settings.json:
 * {
 *   "hooks": {
 *     "SessionStart": [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/session-logger.js" }] }],
 *     "PostToolUse":  [{ "matcher": "Edit|Write|Bash|Read",
 *                         "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/session-logger.js" }] }],
 *     "Stop":         [{ "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/session-logger.js" }] }]
 *   }
 * }
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
    git.repo ? `**Repo:** ${git.repo} (${git.branch || 'detached'})` : '',
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
    cmd = cmd.split('\n')[0];
    if (cmd.length > BASH_TRUNCATE) cmd = cmd.slice(0, BASH_TRUNCATE) + '…';
    entry = `- \`${ts}\` \`${cmd}\``;
    section = '## Commands Run';
  }

  if (!entry || !section) return;
  appendUnderSection(filePath, section, entry);
  log({ level: 'APPEND', session_id, tool: tool_name });
}

function appendUnderSection(filePath, section, entry) {
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
}

function handleStop(data) {
  const { session_id, cwd } = data;
  const filePath = findExistingFile(session_id);
  if (!filePath) {
    log({ level: 'SKIP', reason: 'no session file on stop', session_id });
    return;
  }
  const ended = new Date().toISOString();

  // Update frontmatter `ended:` line
  let body = fs.readFileSync(filePath, 'utf8');
  body = body.replace(/^ended:\s*$/m, `ended: ${ended}`);

  // Try to capture final git status (short)
  let gitStatus = '';
  try {
    gitStatus = execSync('git status --short', { cwd: cwd || process.cwd(), stdio: 'pipe' }).toString().trim();
  } catch {}

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
  log({ level: 'STOP', session_id, file: filePath });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const data = JSON.parse(input);
    const event = data.hook_event_name;
    if (event === 'SessionStart') handleSessionStart(data);
    else if (event === 'PostToolUse') handlePostToolUse(data);
    else if (event === 'Stop' || event === 'SessionEnd') handleStop(data);
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
    handleSessionStart,
    handlePostToolUse,
    handleStop,
  };
}
