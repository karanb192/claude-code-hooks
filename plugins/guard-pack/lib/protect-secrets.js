#!/usr/bin/env node
/**
 * Protect Secrets - PreToolUse Hook for Read|Edit|Write|Bash|Grep
 * Prevents reading, modifying, or exfiltrating sensitive files.
 * Logs to: ~/.claude/hooks-logs/
 *
 * SAFETY_LEVEL: 'critical' | 'high' | 'strict' (default: 'high')
 *   critical - SSH keys, AWS creds, .env files only
 *   high     - + secrets files, env dumps, exfiltration attempts
 *   strict   - + database configs, any config that might contain secrets
 * Override via HOOK_SAFETY_LEVEL instead of editing this file (plugin updates
 * overwrite installed files). Invalid values fall back to 'high'.
 *
 * Ask mode (opt-in, per level): set HOOK_ASK_CRITICAL / HOOK_ASK_HIGH /
 * HOOK_ASK_STRICT to the literal string "true" in the hook command to have
 * that level prompt the user ("ask") instead of blocking outright ("deny").
 * e.g. "command": "HOOK_ASK_STRICT=true node /path/to/protect-secrets.js"
 *
 * Setup (plugin, recommended):
 *   /plugin marketplace add karanb192/claude-code-hooks   # once per machine
 *   /plugin install protect-secrets@claude-code-hooks
 * The plugin registers this hook automatically; restart Claude Code after install.
 *
 * Classic setup (copy this script somewhere stable) still works, via
 * .claude/settings.json:
 * {
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "Read|Edit|Write|Bash|Grep",
 *       "hooks": [{ "type": "command", "command": "node /path/to/protect-secrets.js" }]
 *     }]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

// Tools this hook inspects. The plugin's hooks/hooks.json matcher must list
// exactly these: a tool that reaches check() but is missing from the matcher
// is never sent to the hook, so its handling here is dead code (#55). A repo
// test pins the two together.
const HANDLED_TOOLS = ['Read', 'Edit', 'Write', 'Bash', 'Grep'];

// Safety level: override via HOOK_SAFETY_LEVEL ('critical' | 'high' | 'strict').
// Anything else (or unset) falls back to the default so a typo can never
// silently disable the guard.
const DEFAULT_SAFETY_LEVEL = 'high';
const SAFETY_LEVEL = ['critical', 'high', 'strict'].includes(process.env.HOOK_SAFETY_LEVEL)
  ? process.env.HOOK_SAFETY_LEVEL
  : DEFAULT_SAFETY_LEVEL;

// Ask mode per level: if true, prompts the user instead of blocking outright.
// When ask=true, the hook returns decision "ask" so Claude Code shows the
// reason and lets the user decide. When ask=false (default), the hook denies.
// Env overrides: HOOK_ASK_CRITICAL, HOOK_ASK_HIGH, HOOK_ASK_STRICT
const envBool = (key, fallback) => key in process.env ? process.env[key] === 'true' : fallback;
const ASK = {
  critical: envBool('HOOK_ASK_CRITICAL', false),
  high:     envBool('HOOK_ASK_HIGH', false),
  strict:   envBool('HOOK_ASK_STRICT', false),
};

// Files explicitly safe to access (templates, examples)
const ALLOWLIST = [
  /\.env\.example$/i, /\.env\.sample$/i, /\.env\.template$/i,
  /\.env\.schema$/i, /\.env\.defaults$/i, /env\.example$/i, /example\.env$/i,
];

// Sensitive file patterns for Read, Edit, Write tools
const SENSITIVE_FILES = [
  // CRITICAL
  { level: 'critical', id: 'env-file',           regex: /(?:^|\/)\.env(?:\.[^/]*)?$/,                    reason: '.env file contains secrets' },
  { level: 'critical', id: 'envrc',              regex: /(?:^|\/)\.envrc$/,                              reason: '.envrc (direnv) contains secrets' },
  { level: 'critical', id: 'ssh-private-key',    regex: /(?:^|\/)\.ssh\/id_[^/]+$/,                      reason: 'SSH private key' },
  { level: 'critical', id: 'ssh-private-key-2',  regex: /(?:^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/,  reason: 'SSH private key' },
  { level: 'critical', id: 'ssh-authorized',     regex: /(?:^|\/)\.ssh\/authorized_keys$/,               reason: 'SSH authorized_keys' },
  { level: 'critical', id: 'aws-credentials',    regex: /(?:^|\/)\.aws\/credentials$/,                   reason: 'AWS credentials file' },
  { level: 'critical', id: 'aws-config',         regex: /(?:^|\/)\.aws\/config$/,                        reason: 'AWS config may contain secrets' },
  { level: 'critical', id: 'kube-config',        regex: /(?:^|\/)\.kube\/config$/,                       reason: 'Kubernetes config contains credentials' },
  { level: 'critical', id: 'pem-key',            regex: /\.pem$/i,                                       reason: 'PEM key file' },
  { level: 'critical', id: 'key-file',           regex: /\.key$/i,                                       reason: 'Key file' },
  { level: 'critical', id: 'p12-key',            regex: /\.(p12|pfx)$/i,                                 reason: 'PKCS12 key file' },

  // HIGH
  { level: 'high', id: 'credentials-json',       regex: /(?:^|\/)credentials\.json$/i,                   reason: 'Credentials file' },
  { level: 'high', id: 'secrets-file',           regex: /(?:^|\/)(secrets?|credentials?)\.(json|ya?ml|toml)$/i, reason: 'Secrets configuration file' },
  { level: 'high', id: 'service-account',        regex: /service[_-]?account.*\.json$/i,                 reason: 'GCP service account key' },
  { level: 'high', id: 'gcloud-creds',           regex: /(?:^|\/)\.config\/gcloud\/.*(credentials|tokens)/i, reason: 'GCloud credentials' },
  { level: 'high', id: 'azure-creds',            regex: /(?:^|\/)\.azure\/(credentials|accessTokens)/i,  reason: 'Azure credentials' },
  { level: 'high', id: 'docker-config',          regex: /(?:^|\/)\.docker\/config\.json$/,               reason: 'Docker config may contain registry auth' },
  { level: 'high', id: 'netrc',                  regex: /(?:^|\/)\.netrc$/,                              reason: '.netrc contains credentials' },
  { level: 'high', id: 'git-credentials',        regex: /(?:^|\/)\.git-credentials$/,                    reason: '.git-credentials stores plaintext tokens' },
  { level: 'high', id: 'npmrc',                  regex: /(?:^|\/)\.npmrc$/,                              reason: '.npmrc may contain auth tokens' },
  { level: 'high', id: 'pypirc',                 regex: /(?:^|\/)\.pypirc$/,                             reason: '.pypirc contains PyPI credentials' },
  { level: 'high', id: 'gem-creds',              regex: /(?:^|\/)\.gem\/credentials$/,                   reason: 'RubyGems credentials' },
  { level: 'high', id: 'vault-token',            regex: /(?:^|\/)(\.vault-token|vault-token)$/,          reason: 'Vault token file' },
  { level: 'high', id: 'keystore',               regex: /\.(keystore|jks)$/i,                            reason: 'Java keystore' },
  { level: 'high', id: 'htpasswd',               regex: /(?:^|\/)\.?htpasswd$/,                          reason: 'htpasswd contains hashed passwords' },
  { level: 'high', id: 'pgpass',                 regex: /(?:^|\/)\.pgpass$/,                             reason: 'PostgreSQL password file' },
  { level: 'high', id: 'my-cnf',                 regex: /(?:^|\/)\.my\.cnf$/,                            reason: 'MySQL config may contain password' },

  // STRICT
  { level: 'strict', id: 'database-config',      regex: /(?:^|\/)(?:config\/)?database\.(json|ya?ml)$/i, reason: 'Database config may contain passwords' },
  { level: 'strict', id: 'ssh-known-hosts',      regex: /(?:^|\/)\.ssh\/known_hosts$/,                   reason: 'SSH known_hosts reveals infrastructure' },
  { level: 'strict', id: 'gitconfig',            regex: /(?:^|\/)\.gitconfig$/,                          reason: '.gitconfig may contain credentials' },
  { level: 'strict', id: 'curlrc',               regex: /(?:^|\/)\.curlrc$/,                             reason: '.curlrc may contain auth' },
];

// Delegation sinks: file contents or secret env vars fed to an external model CLI or API host.
const SINK_CLI = '(?:gemini(?:-cli)?|codex|llm|sgpt|aichat|openai|mods|fabric)';
// A sink CLI behind env assignments, wrappers (sudo, npx, env, timeout, xargs ...), a path or an npm scope.
const SINK_PREFIX = '(?:^|[|;&(`"\'!\\n]|\\b(?:do|then|else)\\b)\\s*'
  + '(?:(?:sudo|npx|uvx|bunx|pnpm\\s+dlx|command|time|exec|nice|nohup|env|timeout|xargs)\\b[^;|&\\n]*?\\s+|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*'
  + '(?:[^\\s"\';|&]*\\/)?';
const SINK_END = '(?=[\\s<]|$)';
const SINK_CMD = SINK_PREFIX + SINK_CLI + SINK_END;
const sinkCmd = (cli) => SINK_PREFIX + cli + SINK_END;
// A segment with balanced quotes as opaque units: a name inside a quoted prompt is prose, not an operand.
const SEG_QA = '(?:[^;|&\\n"\']|"[^"\\n]*"|\'[^\'\\n]*\')*?';
// Commands whose stdout is the file they are given (ssh -i and kubectl --kubeconfig are not).
const CONTENT_CMD = '\\b(?:cat|tac|head|tail|bat|more|less|sops|gpg|age|base64|xxd|od|rev|sed|awk|grep|jq|yq|strings|openssl\\s+enc|python3?|node|ruby|perl)\\b';
const SINK_HOST = '(?:generativelanguage\\.googleapis\\.com|aiplatform\\.googleapis\\.com|api\\.openai\\.com|[\\w.-]+\\.openai\\.azure\\.com|api\\.anthropic\\.com|openrouter\\.ai|api\\.mistral\\.ai|api\\.groq\\.com|api\\.together\\.xyz|api\\.deepseek\\.com|api\\.x\\.ai|api\\.cohere\\.com|api\\.perplexity\\.ai|api\\.fireworks\\.ai|api\\.cerebras\\.ai|router\\.huggingface\\.co|bedrock-runtime(?:-fips)?\\.[\\w-]+\\.amazonaws\\.com|integrate\\.api\\.nvidia\\.com|api\\.deepinfra\\.com)';
// HTTP clients as a command word, never the https inside a URL.
const HTTP_CMD = '(?<![\\w:/.-])(?:curl|curlie|wget|https?|xh)(?=\\s)';
const HTTPIE_CMD = '(?<![\\w:/.-])(?:https?|xh)(?=\\s)';

// Secret file names come from the critical and high SENSITIVE_FILES entries; .env swaps in a template-excluding variant.
const FILE_DIR = '["\']?(?:[^\\s"\';|&<>()]*\\/)?';
const FILE_ANY = '["\']?[^\\s"\';|&<>()]*?';
const ENV_FILE_NAME = '\\.env(?!\\.(?:example|sample|template|schema|defaults)\\b)(?:\\.[^/\\s"\']*)?(?![\\w.])';
const PATH_ANCHOR = '(?:^|\\/)';
function fileNameSource(p) {
  if (p.id === 'env-file') return ENV_FILE_NAME;
  return p.regex.source
    .replace(/^\(\?:\^\|\\\/\)/, '')
    .replace(/\$$/, '')
    .replace(/\((?!\?)/g, '(?:')
    .replace(/\[\^\/\]/g, '[^/\\s"\']')
    .replace(/\.\*/g, '[^\\s"\']*');
}
const secretFiles = SENSITIVE_FILES.filter(p => p.level !== 'strict');
const anchoredNames = secretFiles.filter(p => p.regex.source.startsWith(PATH_ANCHOR)).map(fileNameSource);
const floatingNames = secretFiles.filter(p => !p.regex.source.startsWith(PATH_ANCHOR)).map(fileNameSource);
const SECRET_GLOB = '(?:\\.[A-Za-z]{0,3}[*?]|\\.(?:ssh|aws|kube|gnupg|azure|docker|config\\/gcloud)\\/[^\\s"\']*[*?])';
const SECRET_NAME = '(?:' + FILE_DIR + '(?:' + anchoredNames.join('|') + '|' + SECRET_GLOB + ')|' + FILE_ANY + '(?:' + floatingNames.join('|') + '))(?![A-Za-z0-9])';
const SECRET_FILE = '(?:^|[\\s"\'=<@(])\\s*' + SECRET_NAME;
const SECRET_WORD = '(?:SECRETS?|KEY|TOKEN|PASSWORD|PASSWD|PASSW|PASSPHRASE|PASS|CREDENTIALS?|API_KEY|APIKEY|PAT)';
// Whole name segments, so $AUTHOR and $TOKENS_USED stay clean; AUTH and PRIVATE only as the last segment.
const SECRET_TAIL = '(?:_(?:ID|FILE|PATH|VALUE|VAL|STR|STRING|B64|BASE64|JSON|PEM|DATA|CONTENT|TEXT|RAW|HEX|PROD|PRODUCTION|DEV|STAGING|TEST|OLD|NEW|[0-9]+))*';
const SECRET_VAR = '\\$\\{?!?(?:(?:[A-Z0-9]+_)*' + SECRET_WORD + SECRET_TAIL + '|(?:[A-Z0-9]+_)*(?:AUTH|PRIVATE))\\}?(?![A-Za-z0-9_])';
// Not a heredoc, herestring, process substitution or /dev/*.
const REDIRECT_IN = '(?<!<)<(?![<(])\\s*(?!\\/dev\\/)';
// -T as a whole flag: the patterns run case-insensitive, so a bare -T also matches --max-time.
const UPLOAD_FLAG = '(?:(?<![\\w-])-T(?![A-Za-z0-9-])\\s*|--(?:upload|post|body)-file[=\\s]+)';
const FILE_BODY = '(?:@|' + REDIRECT_IN + '|\\$\\(\\s*(?:cat|head|tail|<)\\s+|`\\s*(?:cat|head|tail)\\s+|' + UPLOAD_FLAG + ')';
const SUBST_FILE = '(?:\\$\\(\\s*(?:cat|head|tail|<)\\s+|`\\s*(?:cat|head|tail)\\s+)["\']?[^\\s"\';|&<>()-]';
const BODY_FLAG = '(?:-d|--data(?:-binary|-raw|-urlencode|-ascii)?|--json|-F|--form(?:-string)?)';
const API_BODY = '(?:' + BODY_FLAG + '\\s*=?\\s*["\']?(?:[\\w-]+=?)?(?:@|\\$\\(\\s*(?:cat|head|tail|<)\\s+|`\\s*cat\\s+)|' + REDIRECT_IN + '|' + UPLOAD_FLAG + ')';
const HTTPIE_FILE_ITEM = '\\s(?:[\\w-]+:?=?)?@';
const HTTPIE_FIELD = '\\s[\\w-]+:?=';
// Stops at the first $ inside double quotes; a var in a later -H header sits outside the token.
const BODY_TOKEN = '(?:"[^"$]*|\'[^\']*\'|[^\\s"\'$])*"?';
// Per CLI: gemini -i is --prompt-interactive and mods -f is --format, so neither is a file flag.
const CLI_FILE_FLAGS = {
  llm: '-a|--attachment|-f|--fragment|--sf|--system-fragment',
  aichat: '-f|--file',
  codex: '-i|--image',
  fabric: '-a|--attachment',
  openai: '--file',
};
const FLAG_ARG = '[\\s=]+["\']?[^\\s"\'-]';
const FILE_TOKEN = '["\']?[^\\s"\';|&<>()-]';
const AT_PATH = '(?<![\\w.])@(?=[\\w.~\\/])';
const SINK_FILE_FLAG = Object.entries(CLI_FILE_FLAGS)
  .map(([cli, flags]) => sinkCmd(cli) + SEG_QA + '\\s(?:' + flags + ')' + FLAG_ARG)
  .concat([sinkCmd('(?:gemini(?:-cli)?|openai)') + '[^;|&\\n]*' + AT_PATH])
  .join('|');
// A reader with a file operand, so `ps aux | head | llm` is a filter, not a read.
const READER_CMD = '(?:\\b(?:cat|head|tail|bat|tac|more|less)\\b(?:\\s+-\\S+)*\\s+[^\\s|;&<>-]|\\bgit\\s+(?:diff|show)\\b)';

// Bash patterns that expose or exfiltrate secrets
const BASH_PATTERNS = [
  // CRITICAL
  { level: 'critical', id: 'grep-env',           regex: /\b(grep|rg|egrep|fgrep|ag|awk|gawk)\b(?:"[^"]*"|'[^']*'|[^|;&])*\.env\b/i, reason: 'Reading .env via text tools exposes secrets' },
  { level: 'critical', id: 'cat-env',            regex: /\b(cat|less|head|tail|more|bat|view)\s+[^|;]*\.env\b/i,           reason: 'Reading .env file exposes secrets' },
  { level: 'critical', id: 'cat-ssh-key',        regex: /\b(cat|less|head|tail|more|bat)\s+[^|;]*(id_rsa|id_ed25519|id_ecdsa|id_dsa|\.pem|\.key)\b/i, reason: 'Reading private key' },
  { level: 'critical', id: 'cat-aws-creds',      regex: /\b(cat|less|head|tail|more)\s+[^|;]*\.aws\/credentials/i,         reason: 'Reading AWS credentials' },

  // HIGH - Environment exposure
  { level: 'high', id: 'env-dump',               regex: /\bprintenv\b|(?:^|[;&|(]\s*)(?:env|set|export|declare\s+-x)\s*(?:$|[;&|)])/, reason: 'Environment dump may expose secrets' },
  { level: 'high', id: 'echo-secret-var',        regex: /\becho\b[^;|&]*\$\{?[A-Za-z_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASSW|CREDENTIAL|API_KEY|AUTH|PRIVATE)[A-Za-z_]*\}?/i, reason: 'Echoing secret variable' },
  { level: 'high', id: 'printf-secret-var',      regex: /\bprintf\b[^;|&]*\$\{?[A-Za-z_]*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|API_KEY|AUTH|PRIVATE)[A-Za-z_]*\}?/i, reason: 'Printing secret variable' },
  { level: 'high', id: 'cat-secrets-file',       regex: /\b(cat|less|head|tail|more)\s+[^|;]*(credentials?|secrets?)\.(json|ya?ml|toml)/i, reason: 'Reading secrets file' },
  { level: 'high', id: 'cat-netrc',              regex: /\b(cat|less|head|tail|more)\s+[^|;]*\.netrc/i,                    reason: 'Reading .netrc credentials' },
  { level: 'high', id: 'source-env',             regex: /\bsource\s+[^|;]*\.env\b|(?:^|[;&|]\s*)\.\s+[^|;]*\.env\b|^\.\s+[^|;]*\.env\b/i, reason: 'Sourcing .env loads secrets' },
  { level: 'high', id: 'export-cat-env',         regex: /export\s+.*\$\(cat\s+[^)]*\.env/i,                                reason: 'Exporting secrets from .env' },

  // HIGH - Exfiltration
  { level: 'high', id: 'curl-upload-env',        regex: /\bcurl\b[^;|&]*(-d\s*@|-F\s*[^=]+=@|--data[^=]*=@|--data[-a-z]*\s+@|(?<![\w-])-T(?![A-Za-z0-9-])\s*|--upload-file[=\s]+)[^;|&]*(\.env|credentials|secrets|id_rsa|\.pem|\.key)/i, reason: 'Uploading secrets via curl' },
  { level: 'high', id: 'curl-post-secrets',      regex: /\bcurl\b[^;|&]*-X\s*POST[^;|&]*[^;|&]*(\.env|credentials|secrets)/i, reason: 'POSTing secrets via curl' },
  { level: 'high', id: 'wget-post-secrets',      regex: /\bwget\b[^;|&]*--post-file[^;|&]*(\.env|credentials|secrets)/i,  reason: 'POSTing secrets via wget' },
  { level: 'high', id: 'scp-secrets',            regex: /\bscp\b[^;|&]*(\.env|credentials|secrets|id_rsa|\.pem|\.key)[^;|&]+:/i, reason: 'Copying secrets via scp' },
  { level: 'high', id: 'rsync-secrets',          regex: /\brsync\b[^;|&]*(\.env|credentials|secrets|id_rsa)[^;|&]+:/i,    reason: 'Syncing secrets via rsync' },
  { level: 'high', id: 'nc-secrets',             regex: /\bnc\b[^;|&]*<[^;|&]*(\.env|credentials|secrets|id_rsa)/i,       reason: 'Exfiltrating secrets via netcat' },

  // HIGH - Delegation sinks (secret material into an external model)
  { level: 'high', id: 'model-cli-secret-file',   regex: new RegExp(SINK_CMD + SEG_QA + '[\\s<@=(]\\s*' + SECRET_NAME + '|' + SINK_CMD + '[^;|&\\n]*(?:\\$\\(|`)[^`\\n]*?[\\s"\'=<@(]\\s*' + SECRET_NAME + '|' + CONTENT_CMD + '[^;|&\\n]*' + SECRET_FILE + '[^;&\\n]*' + SINK_CMD, 'i'), reason: 'Feeding a secrets file to an external model CLI' },
  { level: 'high', id: 'model-cli-secret-var',    regex: new RegExp(SINK_CMD + '[^;|&\\n]*' + SECRET_VAR, 'i'), reason: 'Passing a secret variable to an external model CLI' },
  { level: 'high', id: 'model-api-secret-body',   regex: new RegExp(HTTP_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')' + SEG_QA + '(?:' + API_BODY + SECRET_NAME + '|' + BODY_FLAG + '\\s*=?\\s*' + BODY_TOKEN + SECRET_VAR + ')|' + HTTPIE_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')' + SEG_QA + '(?:' + HTTPIE_FILE_ITEM + SECRET_NAME + '|' + HTTPIE_FIELD + BODY_TOKEN + SECRET_VAR + ')', 'i'), reason: 'Sending secrets to a model API endpoint' },

  // HIGH - Copy/move/delete secrets
  { level: 'high', id: 'cp-env',                 regex: /\bcp\b[^;|&]*\.env\b/i,                                           reason: 'Copying .env file' },
  { level: 'high', id: 'cp-ssh-key',             regex: /\bcp\b[^;|&]*(id_rsa|id_ed25519|\.pem|\.key)\b/i,                 reason: 'Copying private key' },
  { level: 'high', id: 'mv-env',                 regex: /\bmv\b[^;|&]*\.env\b/i,                                           reason: 'Moving .env file' },
  { level: 'high', id: 'rm-ssh-key',             regex: /\brm\b[^;|&]*(id_rsa|id_ed25519|id_ecdsa|authorized_keys)/i,     reason: 'Deleting SSH key' },
  { level: 'high', id: 'rm-env',                 regex: /\brm\b.*\.env\b/i,                                                 reason: 'Deleting .env file' },
  { level: 'high', id: 'rm-aws-creds',           regex: /\brm\b[^;|&]*\.aws\/credentials/i,                                reason: 'Deleting AWS credentials' },
  { level: 'high', id: 'truncate-secrets',       regex: /\btruncate\b.*\.(env|pem|key)\b|(?:^|[;&|]\s*)>\s*\.env\b/i,      reason: 'Truncating secrets file' },

  // HIGH - Process environ
  { level: 'high', id: 'proc-environ',           regex: /\/proc\/[^/]*\/environ/,                                          reason: 'Reading process environment' },
  { level: 'high', id: 'xargs-cat-env',          regex: /xargs.*cat|\.env.*xargs/i,                                         reason: 'Reading .env via xargs' },
  { level: 'high', id: 'find-exec-cat-env',      regex: /find\b.*\.env.*-exec|find\b.*-exec.*(cat|less)/i,                 reason: 'Finding and reading .env files' },

  // STRICT
  { level: 'strict', id: 'grep-password',        regex: /\bgrep\b[^|;]*(-r|--recursive)[^|;]*(password|secret|api.?key|token|credential)/i, reason: 'Grep for secrets may expose them' },
  { level: 'strict', id: 'base64-secrets',       regex: /\bbase64\b[^|;]*(\.env|credentials|secrets|id_rsa|\.pem)/i,       reason: 'Base64 encoding secrets' },

  // STRICT - Delegation sinks (any file contents into an external model)
  { level: 'strict', id: 'model-cli-file-input',  regex: new RegExp(READER_CMD + '[^;&\\n]*' + SINK_CMD + '|' + SINK_CMD + SEG_QA + REDIRECT_IN + FILE_TOKEN + '|' + SINK_CMD + '[^;|&\\n]*' + SUBST_FILE + '|' + SINK_FILE_FLAG, 'i'), reason: 'Piping file contents to an external model CLI' },
  { level: 'strict', id: 'model-api-file-body',   regex: new RegExp(HTTP_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')' + SEG_QA + API_BODY + FILE_TOKEN + '|' + HTTPIE_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')' + SEG_QA + HTTPIE_FILE_ITEM + '[\\w.~\\/]|' + READER_CMD + '[^;&\\n]*' + HTTP_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')', 'i'), reason: 'Sending file contents to a model API endpoint' },
];

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🔐', high: '🛡️', strict: '⚠️' };
const LOG_DIR = path.join(process.env.HOME, '.claude', 'hooks-logs');

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'protect-secrets', ...data }) + '\n');
  } catch {}
}

// Tool-provided paths carry the host separator, so on Windows `file_path` is
// `C:\\Users\\me\\project\\.env`. Every pattern above anchors its path boundary
// on `/`, so a backslash path matched none of them and walked straight past
// the guard (#55). Match on a separator-normalized copy: the hook only ever
// reads the path, never opens it, so the rewrite is local to matching.
function toPosixPath(filePath) {
  return typeof filePath === 'string' ? filePath.replace(/\\/g, '/') : filePath;
}

function isAllowlisted(filePath) {
  const target = toPosixPath(filePath);
  return target && ALLOWLIST.some(p => p.test(target));
}

function checkFilePath(filePath, safetyLevel = SAFETY_LEVEL) {
  const target = toPosixPath(filePath);
  if (!target || isAllowlisted(target)) return { blocked: false, pattern: null };
  const threshold = LEVELS[safetyLevel] || 2;
  for (const p of SENSITIVE_FILES) {
    if (LEVELS[p.level] <= threshold && p.regex.test(target)) {
      return { blocked: true, pattern: p };
    }
  }
  return { blocked: false, pattern: null };
}

function checkBashCommand(cmd, safetyLevel = SAFETY_LEVEL) {
  if (!cmd) return { blocked: false, pattern: null };
  cmd = cmd.replace(/\\\r?\n\s*/g, ' ');
  for (const allow of ALLOWLIST) {
    if (allow.test(cmd)) return { blocked: false, pattern: null };
  }
  const threshold = LEVELS[safetyLevel] || 2;
  for (const p of BASH_PATTERNS) {
    if (LEVELS[p.level] <= threshold && p.regex.test(cmd)) {
      return { blocked: true, pattern: p };
    }
  }
  return { blocked: false, pattern: null };
}

function check(toolName, toolInput, safetyLevel = SAFETY_LEVEL) {
  if (toolName === 'Grep') {
    const candidates = [toolInput.path, toolInput.glob, toolInput.include].filter(Boolean);
    const target = candidates.find(c => SENSITIVE_FILES.some(s => s.regex.test(toPosixPath(c)))) || candidates[0] || '';
    toolInput = { file_path: target };
    toolName = 'Read';
  }
  if (['Read', 'Edit', 'Write'].includes(toolName)) {
    return checkFilePath(toolInput?.file_path, safetyLevel);
  }
  if (toolName === 'Bash') {
    return checkBashCommand(toolInput?.command, safetyLevel);
  }
  return { blocked: false, pattern: null };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  try {
    const data = JSON.parse(input);
    const { tool_name, tool_input, session_id, cwd, permission_mode } = data;

    if (!HANDLED_TOOLS.includes(tool_name)) {
      return console.log('{}');
    }

    const result = check(tool_name, tool_input);

    if (result.blocked) {
      const p = result.pattern;
      const shouldAsk = ASK[p.level] === true;
      const decision = shouldAsk ? 'ask' : 'deny';
      const target = tool_input?.file_path || tool_input?.command?.slice(0, 100);
      log({ level: shouldAsk ? 'ASK' : 'BLOCKED', id: p.id, priority: p.level, decision, tool: tool_name, target, session_id, cwd, permission_mode });

      const action = { Read: 'read', Edit: 'modify', Write: 'write to', Bash: 'execute', Grep: 'search' }[tool_name];
      return console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: decision,
          permissionDecisionReason: `${EMOJIS[p.level]} [${p.id}] Cannot ${action}: ${p.reason}`
        }
      }));
    }
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
    SENSITIVE_FILES, BASH_PATTERNS, ALLOWLIST, LEVELS, SAFETY_LEVEL, ASK,
    HANDLED_TOOLS,
    check, checkFilePath, checkBashCommand, isAllowlisted, toPosixPath,
  };
}
