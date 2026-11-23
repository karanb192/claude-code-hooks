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
const os = require('os');

// A handled tool missing from hooks.json never reaches this guard.
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
// One lazy run after the first wrapper already spans any later wrappers and
// assignments; repeating it made `| sudo -n sudo -n ...` exponential.
const SINK_PREFIX = '(?:^|[|;&(`"\'!\\n]|\\b(?:do|then|else)\\b)\\s*'
  + '(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*'
  + '(?:(?:sudo|npx|uvx|bunx|pnpm\\s+dlx|command|time|exec|nice|nohup|env|timeout|xargs)\\b[^;|&\\n]*?\\s+)?'
  + '(?:[^\\s"\';|&]*\\/)?';
const SINK_END = '(?=[\\s<]|$)';
// An input redirect written before the command: <file gemini.
const LEAD_REDIRECT = '(?:^|[;&|({\\n])\\s*(?<!<)<(?![<(])\\s*(?!\\/dev\\/)[^\\s;|&<>()]+\\s+(?:[^\\s"\';|&]*\\/)?';
const SINK_CMD = SINK_PREFIX + SINK_CLI + SINK_END;
const sinkCmd = (cli) => SINK_PREFIX + cli + SINK_END;
// A segment with balanced quotes as opaque units: a name inside a quoted prompt is prose, not an operand.
const SEG_QA = '(?:[^;|&\\n"\']|"[^"]*"|\'[^\']*\')*?';
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
const UPLOAD_FLAG = '(?:(?<![\\w-])-[A-Za-z]*T(?![A-Za-z0-9-])\\s*|--(?:upload|post|body)-file[=\\s]+)';
const FILE_BODY = '(?:@|' + REDIRECT_IN + '|\\$\\(\\s*(?:cat|head|tail|<)\\s+|`\\s*(?:cat|head|tail)\\s+|' + UPLOAD_FLAG + ')';
const SUBST_FILE = '(?:\\$\\(\\s*(?:(?:cat|head|tail)\\s+|<\\s*)|`\\s*(?:cat|head|tail)\\s+)["\']?[^\\s"\';|&<>()-]';
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
// sed, awk, jq and grep take a script or pattern first, so they need a second operand.
const OPERAND = '(?:\'[^\']*\'|"[^"]*"|[^\\s|;&<>\'"-])';
// Short options whose value is the next word (sort -k 3, cut -d , -f 1), so the value is not read as a
// file. The patterns match case-insensitively, so a letter is left out when its other case is a flag
// without a value (sort -s, xxd -C, od -a).
const READER_VALUE_OPTS = {
  'cat|bat|more|less|rev': '', tac: 's', head: 'cn', tail: 'cn', sort: 'kot', cut: 'bcdf', fold: 'w',
  uniq: 'fsw', nl: 'bdfhilnsvw', paste: 'd', column: 'cos', strings: 'ent', xxd: 'glos', od: 'jnt',
  hexdump: 'ens', base64: 'bw',
};
const LONG_VALUE_OPT = '--(?:key|lines|bytes|delimiter|fields|characters|field-separator|width|output|separator)';
// A value is never another reader's name, so one reader's options cannot run on through the next.
const OPT_VALUE = '(?!(?:' + Object.keys(READER_VALUE_OPTS).join('|') + ')(?:\\s|$))(?:\'[^\']*\'|"[^"]*"|[^\\s|;&<>\'"][^\\s|;&<>]*)';
const readerOptions = (letters) => '(?:\\s+(?:'
  + (letters ? '-[A-Za-z]*[' + letters + ']\\s+' + OPT_VALUE + '|' : '')
  + LONG_VALUE_OPT + '\\s+' + OPT_VALUE
  + '|-(?!-(?:key|lines|bytes|delimiter|fields|characters|field-separator|width|output|separator)(?:\\s|$))'
  + (letters ? '(?![A-Za-z]*[' + letters + '](?:\\s|$))' : '') + '\\S+))*';
const READER_CMD = '(?:' + Object.entries(READER_VALUE_OPTS)
  .map(([cmds, letters]) => '\\b(?:' + cmds + ')\\b' + readerOptions(letters) + '\\s+' + OPERAND).join('|')
  + '|\\b(?:sed|awk|gawk|jq|yq|grep|rg)\\b(?:\\s+-\\S+)*\\s+' + OPERAND + '\\S*(?:\\s+-\\S+)*\\s+' + OPERAND
  + '|\\bdd\\b[^;|&\\n]*\\bif=|\\bgit\\s+(?:diff|show|blame|cat-file(?!\\s+-[est](?:\\s|$))|log\\b[^;|&\\n]*\\s(?:-p|--patch)\\b))';
// curl and wget read a pipe only through a - or /dev/stdin argument (-d @-, -T -, -K -, -i -) or a
// substitution that can read it. HTTPie, xh and curlie send a piped stdin as the body by default.
const STDIN_ARG = '(?:[\\s=@<]["\']?-["\']?(?=[\\s;|&)]|$)|(?<![\\w-])-[A-Za-z]+["\']?-["\']?(?=[\\s;|&)]|$)|(?<![\\w-])-[A-Za-z]*T\\s*["\']?\\.["\']?(?=\\s|$)|--upload-file[=\\s]+["\']?\\.["\']?(?=\\s|$)|\\/dev\\/(?:stdin|fd\\/0)(?![\\w\\/])|\\/proc\\/self\\/fd\\/0(?![\\w\\/])|\\$\\(|`|<\\()';
const PIPE_HTTP = '(?:(?<=\\|\\s*)(?:curl|wget)(?=\\s)(?=[^;|&\\n]*' + STDIN_ARG + ')|(?<!\\|\\s*)' + HTTP_CMD + '|(?<=\\|\\s*)' + HTTPIE_CMD + '|(?<=\\|\\s*)curlie(?=\\s))';

// Bash patterns that expose or exfiltrate secrets
const BASH_PATTERNS = [
  // CRITICAL
  // A word is a run of pieces (quoted span, escape, plain char). Each kind starts with a
  // different character, so a non-match stays linear, and `-F'='` or `".env"` still match.
  { level: 'critical', id: 'grep-env',           regex: /\b(grep|rg|egrep|fgrep|ag|awk|gawk)\b(?:\s+(?:'[^']*'|"(?:[^"\\]|\\[\s\S])*"|\\[\s\S]|[^\s|;&"'\\])+)*\s+(?:'[^']*'|"(?:[^"\\]|\\[\s\S])*"|\\[\s\S]|[^\s|;&"'\\])*?(?:'[^']*|"[^"]*)?\.env\b/i, reason: 'Reading .env via text tools exposes secrets' },
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
  { level: 'strict', id: 'model-cli-file-input',  regex: new RegExp(READER_CMD + '[^;&\\n]*' + SINK_CMD + '|' + SINK_CMD + SEG_QA + REDIRECT_IN + FILE_TOKEN + '|' + SINK_CMD + '[^;|&\\n]*' + SUBST_FILE + '|' + SINK_CMD + '[^;|&\\n]*(?:\\$\\(|`)\\s*' + READER_CMD + '|' + LEAD_REDIRECT + SINK_CLI + SINK_END + '|' + SINK_FILE_FLAG, 'i'), reason: 'Piping file contents to an external model CLI' },
  { level: 'strict', id: 'model-api-file-body',   regex: new RegExp(HTTP_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')' + SEG_QA + API_BODY + FILE_TOKEN + '|' + HTTPIE_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')' + SEG_QA + HTTPIE_FILE_ITEM + '[\\w.~\\/]|' + READER_CMD + '[^;&\\n]*' + PIPE_HTTP + '(?=[^;|&\\n]*' + SINK_HOST + ')', 'i'), reason: 'Sending file contents to a model API endpoint' },
];

const LEVELS = { critical: 1, high: 2, strict: 3 };
const EMOJIS = { critical: '🔐', high: '🛡️', strict: '⚠️' };
const LOG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.claude', 'hooks-logs');

function log(data) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), hook: 'protect-secrets', ...data }) + '\n');
  } catch {}
}

// >>> shell-reading: kept identical in block-dangerous-commands, git-safety and
// protect-secrets; tests/shell-reading.test.js pins the three copies.

// Separators inside quotes are argument text, not command boundaries, and an
// unquoted # starts a comment, so segment-scoped patterns run on a copy with
// quoted and escaped separators blanked and comments dropped. A quote that
// opens right after = (--push-option="x;main") is an option value: its text is
// blanked too, so it cannot pose as a ref. A quoted whole word ("main") or
// a quoted refspec side (HEAD:"main") stays.
function maskQuotedSeparators(cmd) {
  let out = '';
  let q = '';
  let blank = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && q !== "'" && i + 1 < cmd.length) {
      const next = cmd[++i];
      out += blank || /[;&|]/.test(next) ? '__' : ch + next;
      continue;
    }
    if (q) {
      if (ch === q) { q = ''; blank = false; }
      else if (blank) { out += '_'; continue; }
      // A placeholder, not a space: "topic;main" is one ref word, not topic and main.
      else if (/[;&|]/.test(ch)) { out += '_'; continue; }
      else if (ch === '\n') { out += ' '; continue; }
    } else if (ch === '"' || ch === "'") {
      q = ch;
      blank = out[out.length - 1] === '=';
    } else if (ch === '#' && (i === 0 || /\s/.test(cmd[i - 1]))) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
      continue;
    }
    out += ch;
  }
  return out;
}

const SHELL_NAME = /^(?:ba|z|da|k)?sh$/;
// Readers that never run what arrives on stdin (not sort: --compress-program runs one).
const DATA_READERS = new Set(['cat', 'tee', 'head', 'tail', 'wc', 'uniq', 'tr', 'cut', 'nl', 'fold']);
const KEYWORDS = new Set(['!', '{', '}', '(', ')', 'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'select', 'time', 'export', 'local', 'declare', 'typeset', 'readonly']);
const OPENERS = new Set(['{', 'if', 'for', 'while', 'until', 'select', 'case']);
const CLOSERS = new Set(['}', 'fi', 'done', 'esac']);
// The mention exceptions hold only for a line in which no command can make the
// dropped text run. Every command must be one of these, which run nothing they
// are handed: the readers above, the commands below, and the git and gh calls
// below. git runs hooks (commit, push, ref and index updates all can, from any
// directory core.hooksPath names), so a line with git or gh pr must not write,
// copy, move, link, delete or chmod any file, since that file could be a hook.
// No line may write to a path a shell, git or the system runs, or write after
// cd or pushd, which hides the real path from that check.
const INERT = new Set(['cd', 'pushd', 'popd', 'pwd', 'ls', 'mkdir', 'true', 'false', ':', 'test', '[', 'sleep', 'date', 'grep', 'echo', 'printf']);
const WRITERS = new Set(['tee', 'cp', 'mv', 'ln', 'rm', 'touch', 'chmod']);
const GIT_INERT = /^(?:add|status|diff|log|show|commit|branch|switch|checkout|restore|stash|rm|mv|tag|push|fetch|pull)$/;
const GIT_INERT_GLOBALS = new Set(['-C', '-P', '--no-pager']);
const GIT_RUNS = /^--?(?:upload-pack|receive-pack|exec|ext-diff|textconv)\b/;
const WRITE_REDIRECT = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
const SAFE_TARGET = /^(?:\/dev\/(?:null|stdout|stderr)|[12]|-)$/;
// Paths a shell, git or the system runs.
const SCRIPT_FILE = /(?:^|\/)(?:\.git\/(?:hooks\/[^/]+|config)|\.?(?:husky|githooks)\/[^/]+|\.gitconfig|\.(?:bash|zsh|ksh|csh|tcsh)rc|\.(?:bash_)?profile|\.bash_login|\.z(?:profile|shenv|login))$|^\/etc\/|cron|Launch(?:Agents|Daemons)\/|systemd\/|\.(?:sh|bash|zsh|ksh|command)$/;
const REDIRECT = /^\d*(?:<<<|<<-|<<|&>>|&>|>>|>\||>&|<&|<>|<|>)/;
const ANSI = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
const MAX_DEPTH = 6;

// Reads a command line the way bash splits it: words with their quotes
// removed, operators, redirects, heredoc bodies, and each command
// substitution as a nested frame. It never runs anything. sure is false when
// the text is not plain enough to read with certainty (an open quote, an
// unmatched paren, a function definition, nesting past MAX_DEPTH).
function readShell(src) {
  const frames = [];
  const heredocs = [];
  let pending = [];
  let sure = true;
  let i = 0;
  const n = src.length;

  const readBodies = () => {
    for (const h of pending) {
      h.bodyStart = i;
      h.bodyEnd = -1;
      while (i < n) {
        const eol = src.indexOf('\n', i);
        const next = eol === -1 ? n : eol + 1;
        let line = src.slice(i, eol === -1 ? n : eol);
        if (h.dash) line = line.replace(/^\t+/, '');
        if (line === h.delim) { h.bodyEnd = i; i = next; break; }
        i = next;
      }
      if (h.bodyEnd < 0) { h.bodyEnd = n; sure = false; }
    }
    pending = [];
  };

  // The raw text of a balanced ${...} or $((...)).
  const balanced = (open, close) => {
    const start = i;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return src.slice(start, ++i);
      i++;
    }
    sure = false;
    return src.slice(start);
  };

  function readWord(depth, cmd, tick) {
    const w = { start: i, value: '', lead: '', parts: [], spans: [], dynamic: false, frames: [] };
    const push = (s) => {
      if (typeof w.parts[w.parts.length - 1] === 'string') w.parts[w.parts.length - 1] += s;
      else w.parts.push(s);
    };
    const text = (s, quoted) => {
      if (!quoted && !w.spans.length && !w.dynamic) w.lead += s;
      if (quoted && /\s/.test(s)) w.prose = true;
      w.value += s;
      push(quoted ? s.replace(/[\s;&|<>()'"`\\#$]/g, '_') : s);
    };
    const raw = (s) => { w.value += s; push(s); w.dynamic = true; };
    const nested = (close, kind, open) => {
      w.dynamic = true;
      if (depth >= MAX_DEPTH) { sure = false; raw(open + src.slice(i)); i = n; return; }
      const from = i;
      const f = parseFrame(kind, close, depth + 1, { cmd, word: w });
      w.value += open + src.slice(from, Math.max(from, i - 1)) + close;
      w.parts.push({ frame: f, open, close, from, to: Math.max(from, i - 1) });
      w.frames.push(f);
    };
    const dollar = (quoted) => {
      const c = src[i + 1];
      if (c === '(' && src[i + 2] === '(') { i++; raw('$' + balanced('(', ')')); return; }
      if (c === '(') { i += 2; nested(')', 'subst', '$('); return; }
      if (c === '{') { i++; raw('$' + balanced('{', '}')); return; }
      const m = /^\$(?:[A-Za-z_]\w*|[0-9@*#?$!-])/.exec(src.slice(i, i + 64));
      if (m) { i += m[0].length; raw(m[0]); return; }
      i++;
      text('$', quoted);
    };
    while (i < n) {
      const c = src[i];
      if ((c === '<' || c === '>') && src[i + 1] === '(' && !w.parts.length) { i += 2; nested(')', 'proc', c + '('); continue; }
      if (/[ \t\r\n;&|<>()]/.test(c) || (tick && c === '`')) break;
      if (c === '\\') {
        if (src[i + 1] === '\n') { i += 2; continue; }
        if (i + 1 < n) { const e = src[i + 1]; w.spans.push({ start: i, end: i + 2, kind: 'esc' }); i += 2; text(e, !/[\w.\/~:@%+,=-]/.test(e)); continue; }
        i++;
        continue;
      }
      if (c === "'") {
        const e = src.indexOf("'", i + 1);
        const end = e < 0 ? n : e;
        if (e < 0) sure = false;
        w.spans.push({ start: i + 1, end, kind: 'sq' });
        text(src.slice(i + 1, end), true);
        i = end + 1;
        continue;
      }
      if (c === '$' && src[i + 1] === "'") {
        let j = i + 2;
        let s = '';
        while (j < n && src[j] !== "'") {
          if (src[j] === '\\' && j + 1 < n) {
            const e = src[j + 1];
            const num = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/.exec(src.slice(j + 1, j + 10));
            if (num) {
              const code = num[4] !== undefined ? parseInt(num[4], 8) : parseInt(num[1] || num[2] || num[3], 16);
              if (code <= 0x10ffff) s += String.fromCodePoint(code);
              j += 1 + num[0].length;
            } else if (e === 'c' && j + 2 < n) { s += String.fromCharCode(src.charCodeAt(j + 2) & 31); j += 3; }
            else { s += ANSI[e] || e; j += 2; }
            continue;
          }
          s += src[j++];
        }
        if (j >= n) sure = false;
        w.spans.push({ start: i + 2, end: j, kind: 'ansi' });
        text(s, true);
        i = j + 1;
        continue;
      }
      if (c === '"' || (c === '$' && src[i + 1] === '"')) {
        i += c === '$' ? 2 : 1;
        const span = { start: i, end: n, kind: 'dq', exp: false };
        w.spans.push(span);
        while (i < n && src[i] !== '"') {
          const d = src[i];
          if (d === '\\' && i + 1 < n && '$`"\\\n'.includes(src[i + 1])) {
            if (src[i + 1] !== '\n') text(src[i + 1], true);
            i += 2;
            continue;
          }
          if (d === '$' && /[({A-Za-z_0-9@*#?$!-]/.test(src[i + 1] || '')) { span.exp = true; dollar(true); continue; }
          if (d === '`') { span.exp = true; i++; nested('`', 'subst', '`'); continue; }
          text(d, true);
          i++;
        }
        if (i >= n) sure = false;
        span.end = i++;
        continue;
      }
      if (c === '$') { dollar(false); continue; }
      if (c === '`') { i++; nested('`', 'subst', '`'); continue; }
      text(c, false);
      i++;
    }
    w.end = i;
    return w;
  }

  function parseFrame(kind, close, depth, parent) {
    const frame = { kind, parent, cmds: [] };
    frames.push(frame);
    let cmd = null;
    let group = 0;
    let head = true;
    const start = () => cmd || (cmd = { words: [], op: '', group, frame, index: frame.cmds.length });
    const end = (op) => {
      head = true;
      if (cmd) { cmd.op = op; frame.cmds.push(cmd); cmd = null; } else if (op && op !== '\n') sure = false;
    };
    const op = (t) => start().words.push({ op: t, value: t, lead: t, parts: [t], spans: [], frames: [] });
    while (i < n) {
      const c = src[i];
      if (close && c === close && (close === '`' || group === 0)) { i++; end(''); return frame; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === '\n') { i++; end('\n'); if (pending.length) readBodies(); continue; }
      if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === ';') { const t = /^;(?:;&|;|&)?/.exec(src.slice(i, i + 3))[0]; i += t.length; end(t); continue; }
      if (c === '|') { const t = /^\|[|&]?/.exec(src.slice(i, i + 2))[0]; i += t.length; end(t); continue; }
      if (c === '&' && src[i + 1] !== '>') { const t = src[i + 1] === '&' ? '&&' : '&'; i += t.length; end(t); continue; }
      if (c === '(') {
        if (!head) sure = false;
        group++;
        i++;
        op('(');
        start().group = group;
        continue;
      }
      if (c === ')') { i++; if (group > 0) group--; else sure = false; op(')'); continue; }
      const redirect = src[i + 1] === '(' ? null : REDIRECT.exec(src.slice(i, i + 8));
      if (redirect && (c !== '&' || src[i + 1] === '>')) {
        i += redirect[0].length;
        const cur = start();
        const t = redirect[0].replace(/^\d+/, '');
        op(t);
        while (src[i] === ' ' || src[i] === '\t') i++;
        if (i >= n || /[;&|<>()\n]/.test(src[i])) continue;
        const target = readWord(depth, cur, close === '`');
        target.target = t;
        cur.words.push(target);
        if (t === '<<' || t === '<<-') {
          const h = { cmd: cur, frame, dash: t === '<<-', delim: target.value, quoted: target.spans.length > 0 };
          heredocs.push(h);
          pending.push(h);
        }
        continue;
      }
      const cur = start();
      const w = readWord(depth, cur, close === '`');
      if (w.start === w.end) {
        sure = false;
        i = n;
        break;
      }
      cur.words.push(w);
      if (head && !w.spans.length && !w.dynamic) {
        if (OPENERS.has(w.value)) cur.group = ++group;
        else if (CLOSERS.has(w.value) && group > 0) group--;
      }
      head = head && !w.spans.length && KEYWORDS.has(w.value);
    }
    if (close) sure = false;
    end('');
    return frame;
  }

  const top = parseFrame('top', '', 0, null);
  if (pending.length) sure = false;
  return { top, frames, heredocs, sure };
}

const base = (s) => s.slice(s.lastIndexOf('/') + 1);
const argv = (cmd) => cmd.words.filter(w => !w.op && !w.target);

// The command word: past keywords, grouping and assignments.
function commandIndex(words) {
  let k = 0;
  while (k < words.length && ((!words[k].spans.length && KEYWORDS.has(words[k].value)) || /^[A-Za-z_]\w*\+?=/.test(words[k].lead || ''))) k++;
  return k;
}

// Index of the first argument whose quoted text is a message, or -1.
function textArgsFrom(cmd) {
  const words = argv(cmd);
  const k = commandIndex(words);
  const w = words[k];
  if (!w || w.dynamic) return -1;
  if (w.value === 'echo') return k + 1;
  if (w.value === 'printf') return words.some(x => /^-v/.test(x.value)) ? -1 : k + 1;
  if (w.value === 'gh') return /^(?:pr|issue)$/.test(words[k + 1]?.value) && /^(?:create|edit|comment)$/.test(words[k + 2]?.value) ? k + 3 : -1;
  if (w.value !== 'git') return -1;
  let j = k + 1;
  while (j < words.length && words[j].value.startsWith('-')) j += GIT_VALUE_OPTS.has(words[j].value) ? 2 : 1;
  return words[j]?.value === 'commit' ? j + 1 : -1;
}

function readsAsData(cmd) {
  const words = argv(cmd);
  const w = words[commandIndex(words)];
  return !!w && !w.dynamic && (DATA_READERS.has(w.value) || textArgsFrom(cmd) >= 0);
}

// Every later stage of this command's pipeline only reads data.
function pipesToData(cmd) {
  const cmds = cmd.frame.cmds;
  for (let k = cmd.index; cmds[k] && (cmds[k].op === '|' || cmds[k].op === '|&'); k++) {
    if (!cmds[k + 1] || cmds[k + 1].group || !readsAsData(cmds[k + 1])) return false;
  }
  return true;
}

// Output of this frame ends up as data: the top level, or a substitution that
// is an argument of a message command whose own output is data.
function frameIsData(frame) {
  for (let f = frame; f.parent; f = f.parent.cmd.frame) {
    const { cmd, word } = f.parent;
    const words = argv(cmd);
    if (f.kind !== 'subst' || cmd.group || textArgsFrom(cmd) < 0 || words.indexOf(word) <= commandIndex(words) || !pipesToData(cmd)) return false;
  }
  return true;
}

const scriptPath = (v) => SCRIPT_FILE.test(v.replace(/\/(?:\.\/)+/g, '/').replace(/\/{2,}/g, '/'));

// { runs, writes, git } for one command; runs is true unless it is one of the
// commands above.
function effects(cmd) {
  const words = argv(cmd);
  const k = commandIndex(words);
  const writes = cmd.words.some(w => w.target && WRITE_REDIRECT.has(w.target) && !SAFE_TARGET.test(w.value));
  const ran = { runs: true, writes, git: false };
  if (words.slice(0, k).some(w => /^[A-Za-z_]\w*\+?=/.test(w.lead))) return ran;
  const w = words[k];
  if (!w) return { runs: false, writes, git: false };
  if (w.dynamic || w.spans.length) return ran;
  if (INERT.has(w.value) || DATA_READERS.has(w.value)) return { runs: false, writes: writes || w.value === 'tee', git: false };
  if (WRITERS.has(w.value)) return { runs: false, writes: true, git: false };
  if (w.value === 'gh') return /^(?:pr|issue|api)$/.test(words[k + 1]?.value || '') ? { runs: false, writes, git: words[k + 1].value === 'pr' } : ran;
  if (w.value !== 'git') return ran;
  let j = k + 1;
  while (j < words.length && words[j].value.startsWith('-')) {
    if (!GIT_INERT_GLOBALS.has(words[j].value)) return ran;
    j += words[j].value === '-C' ? 2 : 1;
  }
  if (!GIT_INERT.test(words[j]?.value || '') || words.slice(j + 1).some(x => GIT_RUNS.test(x.value))) return ran;
  return { runs: false, writes, git: true };
}

function lineIsPlain(read) {
  if (!read.sure) return false;
  let writes = false;
  let git = false;
  let moves = false;
  for (const f of read.frames) {
    if (f.kind === 'proc') return false;
    for (const cmd of f.cmds) {
      const e = effects(cmd);
      if (e.runs || (e.writes && cmd.words.some(w => scriptPath(w.value)))) return false;
      const words = argv(cmd);
      moves = moves || /^(?:cd|pushd|popd)$/.test(words[commandIndex(words)]?.value || '');
      writes = writes || e.writes;
      git = git || e.git;
    }
  }
  return !(writes && (git || moves));
}

// The command with text that only mentions commands taken out: the body of a
// heredoc fed to a reader that never runs it, and the quoted text of echo,
// printf, git commit and gh pr/issue create|edit|comment, on a line where no
// command can make them run (see INERT). A pipe into a program, echo into a
// file and a substitution used as the command keep their text too.
function dropMentions(cmd, read = readShell(cmd)) {
  if (!lineIsPlain(read)) return cmd;
  const cuts = [];
  for (const h of read.heredocs) {
    if (!h.quoted && /[$`\\]/.test(cmd.slice(h.bodyStart, h.bodyEnd))) continue;
    if (h.cmd.group || !readsAsData(h.cmd) || !pipesToData(h.cmd) || !frameIsData(h.frame)) continue;
    cuts.push([h.bodyStart, h.bodyEnd]);
  }
  for (const f of read.frames) {
    if (!frameIsData(f)) continue;
    for (const c of f.cmds) {
      const from = textArgsFrom(c);
      if (from < 0 || c.group || !pipesToData(c) || c.words.some(w => w.frames.length)) continue;
      const words = argv(c);
      const name = words[commandIndex(words)].value;
      if ((name === 'echo' || name === 'printf') && (c.op === '|' || c.op === '|&' || c.words.some(w => w.target && !SAFE_TARGET.test(w.value)))) continue;
      for (const w of words.slice(from)) {
        for (const s of w.spans) if (s.kind !== 'esc' && !s.exp) cuts.push([s.start, s.end]);
      }
    }
  }
  if (!cuts.length) return cmd;
  cuts.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [s, e] of cuts) if (s >= at) { out += cmd.slice(at, s); at = e; }
  return out + cmd.slice(at);
}

// The words as bash will see them: quotes removed ("push", r''m, .e"nv",
// $'\x72m'), $name replaced by a value assigned earlier in the line, each
// substitution (in a word or an unquoted heredoc body) on a line of its own
// with $() left in its place, and the program given to sh -c, eval or a heredoc fed to a shell read
// the same way. A word whose quotes hold
// a space is prose (a prompt, a message) and stays as typed, so the patterns
// treat it as they always have.
function renderShell(src, depth = 0) {
  const read = readShell(src);
  const vars = new Map();
  const programs = [];
  const sub = (s) => s.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, name) => (vars.has(name) ? vars.get(name) : m));
  const word = (w) => {
    if (!w.prose) return w.parts.map(p => (typeof p === 'string' ? sub(p) : p.open + p.close)).join('');
    let out = '';
    let at = w.start;
    for (const p of w.parts) if (p.frame) { out += src.slice(at, p.from); at = p.to; }
    return out + src.slice(at, w.end);
  };
  function frame(f) {
    let out = '';
    for (const cmd of f.cmds) {
      const words = argv(cmd);
      const k = commandIndex(words);
      for (const w of words.slice(0, k)) {
        const m = /^([A-Za-z_]\w*)\+?=([\s\S]*)$/.exec(w.value);
        if (m) vars.set(m[1], sub(m[2]));
      }
      out += cmd.words.map(word).join(' ') + (cmd.op && cmd.op !== '\n' ? ' ' + cmd.op + ' ' : '\n');
      if (depth >= 2) continue;
      for (let j = 0; j < words.length; j++) {
        if (!SHELL_NAME.test(base(words[j].value))) continue;
        let m = j + 1;
        while (m < words.length && /^[-+][A-Za-z]+$/.test(words[m].value) && !words[m].value.includes('c')) m++;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(words[m]?.value || '') && words[m + 1]) programs.push(words[m + 1].value);
      }
      if (words[k]?.value === 'eval') programs.push(words.slice(k + 1).map(w => w.value).join(' '));
    }
    return out;
  }
  let out = '';
  for (const f of read.frames) out += frame(f);
  for (const h of read.heredocs) {
    const words = argv(h.cmd);
    const body = src.slice(h.bodyStart, h.bodyEnd);
    if (depth >= 2) continue;
    if (SHELL_NAME.test(base(words[commandIndex(words)]?.value || ''))) programs.push(body);
    // An unquoted body expands like a double-quoted string, so its $(...) runs.
    else if (!h.quoted && /[$`]/.test(body)) programs.push('"' + body.replace(/"/g, '\\"') + '"');
  }
  for (const p of programs) out += renderShell(p, depth + 1);
  return out;
}

// What the patterns read: the command with mentions dropped, plus, when it has
// quotes, escapes or expansions, the same command as bash will split it. Each
// view carries a masked copy for segment-scoped patterns.
function shellViews(cmd) {
  if (!/['"\\$`]|<</.test(cmd)) return [{ text: cmd, masked: maskQuotedSeparators(cmd) }];
  const text = dropMentions(cmd);
  const views = [{ text, masked: maskQuotedSeparators(text) }];
  if (/['"\\$`]/.test(text)) {
    const words = renderShell(text);
    if (words.trim() !== text.trim()) views.push({ text: words, masked: maskQuotedSeparators(words) });
  }
  return views;
}
// <<< shell-reading

// Normalize tool paths only; backslashes in Bash commands can be shell escapes.
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
  const threshold = LEVELS[safetyLevel] || 2;
  const views = shellViews(cmd).map(v => maskTemplates(v.text));
  for (const p of BASH_PATTERNS) {
    if (LEVELS[p.level] <= threshold && views.some(v => p.regex.test(v))) {
      return { blocked: true, pattern: p };
    }
  }
  return { blocked: false, pattern: null };
}

// Mask each allowlisted file name on its own; matching the allowlist against
// the whole string let `cat .env # .env.example` through. The directory is
// kept, so $SECRET_KEY/.env.example is still seen, except that a plain
// segment's `.env` (my.env/) is defused; a $ in the name is not a template.
function maskTemplates(cmd) {
  return cmd.replace(/[^\s"'`=@<>;|&()]+/g, token => {
    // An scp remote with no slash (host:.env.example) keeps its colon in the directory part.
    const dir = token.slice(0, Math.max(token.lastIndexOf('/'), token.lastIndexOf(':')) + 1);
    if (token.slice(dir.length).includes('$') || !isAllowlisted(token)) return token;
    // Only `.env` in a plain segment is defused; hosts (api.openai.com/), scp
    // remotes (host:) and variables stay visible to the other rules.
    return dir.split('/').map(seg => seg.includes('$') ? seg : seg.replace(/\.env/gi, '_env')).join('/') + 'allowlisted-template';
  });
}

function check(toolName, toolInput, safetyLevel = SAFETY_LEVEL) {
  if (toolName === 'Grep') {
    const searchPath = typeof toolInput?.path === 'string' ? toPosixPath(toolInput.path) : '';
    const filters = [toolInput?.glob, toolInput?.include]
      .filter(value => typeof value === 'string' && value.length > 0)
      .map(toPosixPath);
    // A directory and filter can form a sensitive path, such as .aws + credentials.
    const candidates = [searchPath, ...filters, ...filters.map(filter => searchPath.replace(/\/+$/, '') + '/' + filter)];
    const matches = candidates.map(candidate => checkFilePath(candidate, safetyLevel))
      .filter(result => result.blocked);
    matches.sort((a, b) => LEVELS[a.pattern.level] - LEVELS[b.pattern.level]);
    return matches[0] || { blocked: false, pattern: null };
  }
  if (['Read', 'Edit', 'Write'].includes(toolName)) {
    return checkFilePath(toolInput?.file_path, safetyLevel);
  }
  if (toolName === 'Bash') {
    return checkBashCommand(toolInput?.command, safetyLevel);
  }
  return { blocked: false, pattern: null };
}

// A check that throws must not read as an allow, so the call is denied.
// HOOK_FAIL_OPEN=true restores the old allow-on-error behaviour.
function guardError(e) {
  if (process.env.HOOK_FAIL_OPEN === 'true') return '{}';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `🚨 [guard-error] protect-secrets could not check this call (${String(e && e.message).slice(0, 200)}), so it is blocked. Run it yourself if you meant it, or set HOOK_FAIL_OPEN=true to let calls through when a guard fails.`,
    },
  });
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try {
    data = JSON.parse(input);
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
    console.log(data !== null && typeof data === 'object' ? guardError(e) : '{}');
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    SENSITIVE_FILES, BASH_PATTERNS, ALLOWLIST, LEVELS, SAFETY_LEVEL, ASK,
    HANDLED_TOOLS,
    check, checkFilePath, checkBashCommand, isAllowlisted, toPosixPath, shellViews,
  };
}
