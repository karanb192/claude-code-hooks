#!/usr/bin/env node
/**
 * Notification Hook - Sends Slack alerts when Claude needs user input.
 * Logs to: ~/.claude/hooks-logs/YYYY-MM-DD.jsonl
 *
 * Setup in .claude/settings.json:
 * {
 *   "hooks": {
 *     "Notification": [{
 *       "matcher": "permission_prompt|idle_prompt|elicitation_dialog",
 *       "hooks": [{ "type": "command", "command": "node /path/to/notify-permission.js" }]
 *     }]
 *   }
 * }
 *
 * Environment: CCH_SLA_WEBHOOK (Slack webhook URL)
 */

const fs = require('fs');
const path = require('path');

// Channel webhooks (Discord/Telegram coming soon)
const SLACK_WEBHOOK = process.env.CCH_SLA_WEBHOOK || '';

const LOG_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'hooks-logs');

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'notify-permission', ...data }) + '\n');
  } catch {}
}

function getNotificationType(data) {
  if (data.notification_type) return data.notification_type;
  const msg = (data.message || '').toLowerCase();
  if (msg.includes('permission') || msg.includes('approve')) return 'permission_prompt';
  if (msg.includes('idle') || msg.includes('waiting')) return 'idle_prompt';
  if (msg.includes('elicitation') || msg.includes('mcp')) return 'elicitation_dialog';
  return 'notification';
}

function getProjectName(cwd) {
  return cwd ? path.basename(cwd) : 'unknown';
}

function getShortSessionId(sessionId) {
  return sessionId ? sessionId.slice(0, 6) : '????';
}

function getEmoji(type) {
  return { permission_prompt: '🔐', idle_prompt: '💤', elicitation_dialog: '🔧' }[type] || '🔔';
}

function getTitle(type, message) {
  const msg = (message || '').toLowerCase();

  if (type === 'elicitation_dialog' || msg.includes('select') || msg.includes('choose') || msg.includes('which')) {
    return 'Claude needs your choice';
  }
  if (type === 'permission_prompt') {
    if (msg.includes('bash') || msg.includes('command')) return 'Claude needs permission (Bash)';
    if (msg.includes('write') || msg.includes('create file')) return 'Claude needs permission (Write)';
    if (msg.includes('edit') || msg.includes('modify')) return 'Claude needs permission (Edit)';
    if (msg.includes('read')) return 'Claude needs permission (Read)';
    return 'Claude needs your attention';
  }
  if (type === 'idle_prompt') return 'Claude is waiting for you';
  return 'Claude notification';
}

function formatMessage(message) {
  if (!message) return '_No details provided_';
  return message.length > 200 ? message.slice(0, 200) + '...' : message;
}

async function sendSlack(data, type) {
  if (!SLACK_WEBHOOK) return { channel: 'slack', sent: false, reason: 'no webhook' };

  const payload = {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${getEmoji(type)} ${getTitle(type, data.message)}`, emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Project:*\n\`${getProjectName(data.cwd)}\`` },
          { type: 'mrkdwn', text: `*Session:*\n\`${getShortSessionId(data.session_id)}\`` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Details:*\n${formatMessage(data.message)}` },
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `📁 \`${data.cwd || 'unknown'}\`` },
          { type: 'mrkdwn', text: `🕐 ${new Date().toLocaleTimeString()}` },
        ],
      },
    ],
  };

  try {
    const res = await fetch(SLACK_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.ok ? { channel: 'slack', sent: true } : { channel: 'slack', sent: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { channel: 'slack', sent: false, error: e.message };
  }
}

async function sendAll(data, type) {
  return Promise.all([sendSlack(data, type)]);
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    if (data.hook_event_name !== 'Notification') return console.log('{}');

    log({ level: 'INPUT', notification_type: data.notification_type, message: data.message, session_id: data.session_id });

    const type = getNotificationType(data);
    const results = await sendAll(data, type);

    const sent = results.filter(r => r.sent).map(r => r.channel);
    const failed = results.filter(r => !r.sent && r.error);

    log({ level: sent.length ? 'SENT' : 'NONE', type, sent, failed, session_id: data.session_id });
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
    SLACK_WEBHOOK,
    getNotificationType,
    getProjectName,
    getShortSessionId,
    getEmoji,
    getTitle,
    formatMessage,
    sendSlack,
    sendAll,
  };
}
