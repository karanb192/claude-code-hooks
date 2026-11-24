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
// /dev/null is the one input that is always empty; /dev/shm and /dev/fd hold real data.
const NOT_DEV_NULL = '(?![\'"]?\\/dev\\/null[\'"]?(?![^\\s;|&<>()]))';
// An input redirect written before the command: <file gemini.
const LEAD_REDIRECT = '(?:^|[;&|({\\n])\\s*(?<!<)<(?![<(])\\s*' + NOT_DEV_NULL + '[^\\s;|&<>()]+\\s+(?:[^\\s"\';|&]*\\/)?';
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
// The whole operand: a backup copy (.npmrc.bak) still counts, a different file (.npmrc.md) does not.
const SECRET_OPERAND = SECRET_FILE + '(?:\\.(?:bak|backup|old|orig|save|tmp)|~)?(?![^\\s"\'`;|&<>()])';
const SECRET_WORD = '(?:SECRETS?|KEY|TOKEN|PASSWORD|PASSWD|PASSW|PASSPHRASE|PASS|CREDENTIALS?|API_KEY|APIKEY|PAT)';
// Whole name segments, so $AUTHOR and $TOKENS_USED stay clean; AUTH and PRIVATE only as the last segment.
const SECRET_TAIL = '(?:_(?:ID|FILE|PATH|VALUE|VAL|STR|STRING|B64|BASE64|JSON|PEM|DATA|CONTENT|TEXT|RAW|HEX|PROD|PRODUCTION|DEV|STAGING|TEST|OLD|NEW|[0-9]+))*';
// PWD only after a prefix (MYSQL_PWD): a bare $PWD is the working directory.
const SECRET_VAR = '\\$\\{?!?(?:(?:[A-Z0-9]+_)*' + SECRET_WORD + SECRET_TAIL + '|(?:[A-Z0-9]+_)*(?:AUTH|PRIVATE)|(?:[A-Z0-9]+_)+PWD)\\}?(?![A-Za-z0-9_])';
// One grep's words: & only inside a redirection such as 2>&1 or &>, so && and a newline end it.
const GREP_ANY = '(?:[^|;&\\n]|(?<=[<>])&|&(?=>))';
// The same, stopping at a -- after which every word is an operand.
const GREP_ARGS = '(?:(?!\\s--(?:\\s|$))' + GREP_ANY + ')';
const GREP_TERM = '(?:password|secret|api.?key|token|credential)';
// Not a heredoc, herestring, process substitution or /dev/null.
const REDIRECT_IN = '(?<!<)<(?![<(])\\s*' + NOT_DEV_NULL;
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
// without a value (sort -s, xxd -C, od -a). cat, head, tail and the other readers the rule read before
// keep their earlier reading, so head -n 5 in a pipe still counts as reading a file.
const READER_VALUE_OPTS = {
  'cat|bat|more|less|rev|tac|head|tail': '', sort: 'kot', cut: 'bcdf', fold: 'w',
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
// substitution that can read it. A - that is the value of an output or header option (-o -, -c -,
// -w -, --stderr -) or sits inside a longer word ('X-Label: -') is not request input. The rules match
// case-insensitively, so -D - stays counted: its letter is also -d.
// HTTPie, xh and curlie send a piped stdin as the body by default.
const OUTPUT_OPT = '(?:-[A-Za-z]*[ohcw]|--(?:output|dump-header|header|cookie-jar|stderr|write-out|output-document))';
const STDIN_ARG = '(?:[@<]["\']?-["\']?(?=[\\s;|&)]|$)|(?<!(?:^|\\s)' + OUTPUT_OPT + ')[\\s=](?:"-"|\'-\'|-)(?=[\\s;|&)]|$)'
  + '|(?<![\\w-])-(?![A-Za-z]*[ohcw]["\']?-)[A-Za-z]+["\']?-["\']?(?=[\\s;|&)]|$)'
  + '|(?<![\\w-])-[A-Za-z]*T\\s*["\']?\\.["\']?(?=\\s|$)|--upload-file[=\\s]+["\']?\\.["\']?(?=\\s|$)|\\/dev\\/(?:stdin|fd\\/0)(?![\\w\\/])|\\/proc\\/self\\/fd\\/0(?![\\w\\/])|\\$\\(|`|<\\()';
// The readers the rule read before still count with any HTTP command after them.
const OLD_READER = '(?:\\b(?:cat|head|tail|bat|tac|more|less)\\b(?:\\s+-\\S+)*\\s+[^\\s|;&<>-]|\\bgit\\s+(?:diff|show)\\b)';
const PIPE_HTTP = '(?:(?<=\\|\\s*)(?:curl|wget)(?=\\s)(?=[^;|&\\n]*' + STDIN_ARG + ')|(?<!\\|\\s*)' + HTTP_CMD + '|(?<=\\|\\s*)' + HTTPIE_CMD + '|(?<=\\|\\s*)curlie(?=\\s))';
// Every branch of the two strict file rules names a sink CLI or a model API host. Testing for that name
// first spares a command without one the large rule regexes, which V8 compiles on their first real use.
const SINK_NAME = new RegExp(SINK_CLI, 'i');
const SINK_HOST_NAME = new RegExp(SINK_HOST, 'i');

// What precedes a secret variable fed to a reader by <<<. Escapes are read as pairs, so a \\$ never
// starts a variable. A ; | & < > or paren glued to the word ends the herestring, but the next command
// can still run or print the variable, so the scan goes on, except through a command that is only an
// assignment, such as ;label=$TOKEN, which prints nothing; (?=(...))\\k<asg> takes it whole.
const HS_QUOTED = '"(?:[^"\\\\\\n]|\\\\[\\s\\S])*"|\'[^\']*\'';
const HS_CHAR = '[^\\s\'"\\\\;|&<>()]|\\\\[\\s\\S]';
const HS_ASSIGN = '\\s*[A-Za-z_]\\w*=(?:' + HS_QUOTED + '|' + HS_CHAR + ')*(?=\\s*(?:[;|&\\n]|$))';
const HERESTRING_LEAD = '(?:' + HS_QUOTED + '|' + HS_CHAR
  + '|(?=(?<asg>[;|&]' + HS_ASSIGN + '))\\k<asg>'
  + '|[;|&](?!' + HS_ASSIGN + ')|[<>()])*?(?:"(?:[^"\\\\\\n]|\\\\[\\s\\S])*?)?';

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
  // The keyword anywhere in a letters-only name, or a whole-segment SECRET_VAR (S3_SECRET_KEY, DB_PASS, GH_PAT).
  { level: 'high', id: 'echo-secret-var',        regex: new RegExp('\\becho\\b[^;|&]*(?:\\$\\{?[A-Za-z_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASSW|CREDENTIAL|API_KEY|AUTH|PRIVATE)[A-Za-z_]*\\}?|' + SECRET_VAR + ')', 'i'), spaced: true, reason: 'Echoing secret variable' },
  { level: 'high', id: 'printf-secret-var',      regex: new RegExp('\\bprintf\\b[^;|&]*(?:\\$\\{?[A-Za-z_]*(?:SECRET|KEY|TOKEN|PASSWORD|PASSW|CREDENTIAL|API_KEY|AUTH|PRIVATE)[A-Za-z_]*\\}?|' + SECRET_VAR + ')', 'i'), spaced: true, reason: 'Printing secret variable' },
  { level: 'high', id: 'cat-secrets-file',       regex: /\b(cat|less|head|tail|more)\s+[^|;]*(credentials?|secrets?)\.(json|ya?ml|toml)/i, reason: 'Reading secrets file' },
  { level: 'high', id: 'cat-netrc',              regex: /\b(cat|less|head|tail|more)\s+[^|;]*\.netrc/i,                    reason: 'Reading .netrc credentials' },
  { level: 'high', id: 'source-env',             regex: /\bsource\s+[^|;]*\.env\b|(?:^|[;&|]\s*)\.\s+[^|;]*\.env\b|^\.\s+[^|;]*\.env\b/i, reason: 'Sourcing .env loads secrets' },
  { level: 'high', id: 'export-cat-env',         regex: /export\s+.*\$\(cat\s+[^)]*\.env/i,                                reason: 'Exporting secrets from .env' },
  { level: 'high', id: 'herestring-secret-var',  regex: new RegExp('\\b(?:cat|tac|tee|head|tail|nl|rev|base64|base32|xxd|od|hexdump|sed|awk|tr|cut|sort|uniq|fold|jq)\\b[^;|&\\n]*<<<\\s*' + HERESTRING_LEAD + SECRET_VAR, 'i'), reason: 'Printing secret variable' },

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
  // A relative environ read after cd or pushd into /proc is judged by procEnvironRead, which tracks the
  // directory per shell scope.
  { level: 'high', id: 'proc-environ',           regex: /\/proc\/+(?:[^/\s]+\/+)*environ\b/, also: procEnvironRead, reason: 'Reading process environment' },
  { level: 'high', id: 'xargs-cat-env',          regex: /xargs.*cat|\.env.*xargs/i,                                         reason: 'Reading .env via xargs' },
  { level: 'high', id: 'find-exec-cat-env',      regex: /find\b.*\.env.*-exec|find\b.*-exec.*(cat|less)/i,                 reason: 'Finding and reading .env files' },

  // STRICT
  // The recursive flag may come after the pattern or the path, or sit in a cluster (-rn, -iR).
  // It must belong to the same grep (no && or newline in between) and come before a -- that ends the options.
  // quoted: also read the copy where a quoted & or newline is blanked, so grep -r "a&token" still counts.
  // (?=(...))\1 takes the first flag or term and never retries a later one, which keeps the match linear.
  { level: 'strict', id: 'grep-password',        regex: new RegExp('\\bgrep\\b(?=(' + GREP_ARGS + '*?(?:-r|--recursive|\\s-[A-Za-z]*r)))\\1' + GREP_ANY + '*?' + GREP_TERM + '|\\bgrep\\b(?=(' + GREP_ARGS + '*?' + GREP_TERM + '))\\2' + GREP_ARGS + '*?\\s(?:-[A-Za-z]*r[A-Za-z]*|--(?:dereference-)?recursive)(?![\\w-])', 'i'), quoted: true, reason: 'Grep for secrets may expose them' },
  { level: 'strict', id: 'base64-secrets',       regex: new RegExp('\\bbase64\\b[^|;]*(?:\\.env|credentials|secrets|id_rsa|\\.pem|' + SECRET_OPERAND + ')', 'i'), also: base64ReadsSecret, reason: 'Base64 encoding secrets' },

  // STRICT - Delegation sinks (any file contents into an external model)
  { level: 'strict', id: 'model-cli-file-input',  regex: new RegExp(READER_CMD + '[^;&\\n]*' + SINK_CMD + '|' + SINK_CMD + SEG_QA + REDIRECT_IN + FILE_TOKEN + '|' + SINK_CMD + '[^;|&\\n]*' + SUBST_FILE + '|' + SINK_CMD + '[^;|&\\n]*(?:\\$\\(|`)\\s*' + READER_CMD + '|' + LEAD_REDIRECT + SINK_CLI + SINK_END + '|' + SINK_FILE_FLAG, 'i'), pre: SINK_NAME, reason: 'Piping file contents to an external model CLI' },
  { level: 'strict', id: 'model-api-file-body',   regex: new RegExp(HTTP_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')' + SEG_QA + API_BODY + FILE_TOKEN + '|' + HTTPIE_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')' + SEG_QA + HTTPIE_FILE_ITEM + '[\\w.~\\/]|' + OLD_READER + '[^;&\\n]*' + HTTP_CMD + '(?=[^;|&\\n]*' + SINK_HOST + ')|' + READER_CMD + '[^;&\\n]*' + PIPE_HTTP + '(?=[^;|&\\n]*' + SINK_HOST + ')', 'i'), pre: SINK_HOST_NAME, reason: 'Sending file contents to a model API endpoint' },
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

// The shared mask writes _ for a quoted ; | or &, which can join two words into a
// variable name the shell never expands: "$USER;KEY" is $USER, not $USER_KEY.
// A control character keeps the words apart without ending the segment.
function maskSeparatorsApart(text) {
  return maskQuotedSeparators(text.replace(/_/g, '\u0002')).replace(/_/g, '\u0001').replace(/\u0002/g, '_');
}

// The bash-split view writes a quoted ; | or & as _, so "$USER;TOKEN" reads as $USER_TOKEN although
// the shell expands only $USER. spaced: the print rules must also match the command with each quoted
// separator written as a space, which keeps the words apart.
function spaceQuotedSeparators(cmd) {
  let out = '';
  let q = '';
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && q !== "'" && i + 1 < cmd.length) { out += ch + cmd[++i]; continue; }
    if (q) { if (ch === q) q = ''; else if (/[;|&]/.test(ch)) { out += ' '; continue; } }
    else if (ch === '"' || ch === "'") q = ch;
    out += ch;
  }
  return out;
}
function spacedMatch(p, cmd) {
  const spaced = spaceQuotedSeparators(cmd);
  if (spaced === cmd) return true;
  return shellViews(spaced).some(v => p.regex.test(maskTemplates(v.text)) || p.regex.test(maskTemplates(maskSeparatorsApart(v.text))));
}

function checkBashCommand(cmd, safetyLevel = SAFETY_LEVEL) {
  if (!cmd) return { blocked: false, pattern: null };
  cmd = cmd.replace(/\\\r?\n\s*/g, ' ');
  const threshold = LEVELS[safetyLevel] || 2;
  const read = shellViews(cmd);
  const texts = read.map(v => v.text);
  // Each view is read as is and with a ; | & or newline inside quotes blanked, so quoted text before a
  // secret variable does not end a match early. quoted: the rule also reads the shared masked copy.
  // also: a check in code.
  const views = texts.flatMap(t => [maskTemplates(t), maskTemplates(maskSeparatorsApart(t))]);
  const quoted = views.concat(read.map(v => maskTemplates(v.masked)));
  let rule = BASH_PATTERNS.find(p => LEVELS[p.level] <= threshold
    && ((p.quoted ? quoted : views).some(v => (!p.pre || p.pre.test(v)) && p.regex.test(v)) || (p.also && texts.some(t => p.also(t))))
    && (!p.spaced || spacedMatch(p, cmd)));
  // env-dump also reads each command in code, so a dump anywhere in the line counts.
  const dump = BASH_PATTERNS.find(p => p.id === 'env-dump');
  if (!rule && LEVELS[dump.level] <= threshold && texts.some(dumpsEnvironment)) rule = dump;
  const quotedGlobs = literalGlobs(texts[0]);
  let hit = null;
  texts.forEach((text, i) => { hit = stronger(hit, secretFileAccess(text, safetyLevel, i ? quotedGlobs : null)); });
  if (!rule) return hit ? { blocked: true, pattern: hit } : { blocked: false, pattern: null };
  // The rule keeps its id, but a more severe file in the same command sets the level, so an ask
  // configured for one level never softens the denial another level calls for.
  if (hit && LEVELS[hit.level] < LEVELS[rule.level]) return { blocked: true, pattern: { ...rule, level: hit.level, reason: `${rule.reason}; ${hit.reason}` } };
  return { blocked: true, pattern: rule };
}

// The more severe of two hits; the earlier one on a tie.
function stronger(a, b) {
  return !a || (b && LEVELS[b.level] < LEVELS[a.level]) ? b || a : a;
}

// The shell route to a file the file tools guard: each command's file
// operands, redirect targets and upload arguments are checked against
// SENSITIVE_FILES, so a shell command reaches no file that Read or Write refuses.
const FILE_ACCESS = {
  read:   { id: 'read-secret-file',   reason: 'Reading a secret file' },
  write:  { id: 'write-secret-file',  reason: 'Writing to a secret file' },
  source: { id: 'source-secret-file', reason: 'Loading a secret file into the shell' },
  copy:   { id: 'copy-secret-file',   reason: 'Copying, moving or deleting a secret file' },
  send:   { id: 'send-secret-file',   reason: 'Sending a secret file off the machine' },
};
// Commands that print or decode the files they are given.
const FILE_READERS = new Set(['cat', 'tac', 'nl', 'head', 'tail', 'less', 'more', 'most', 'bat', 'batcat', 'view',
  'sed', 'awk', 'gawk', 'mawk', 'nawk', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'jq', 'yq', 'gojq',
  'sort', 'uniq', 'cut', 'paste', 'fold', 'fmt', 'column', 'rev', 'pr', 'expand', 'unexpand', 'iconv',
  'strings', 'od', 'xxd', 'hexdump', 'hd', 'base64', 'base32', 'basenc', 'uuencode', 'dd', 'diff', 'sdiff', 'comm', 'join']);
// The first operand is a pattern, script or filter unless a flag supplies one.
const PATTERN_FIRST = /^(?:grep|egrep|fgrep|zgrep|rg|ag|ack|sed|awk|gawk|mawk|nawk|jq|yq|gojq)$/;
const PATTERN_FLAG = /^(?:-[ef]|--(?:regexp|file|expression|from-file)\b)/;
// -e and -f read as getopt does: the value is the rest of the word, or the next word when the letter
// ends the word. -e's value is the pattern or script and names no file; -f's value is a file that is
// read. sed's -i takes only an attached suffix, so it ends the word.
const CLUSTER_VALUES = { grep: 'ef', egrep: 'ef', fgrep: 'ef', zgrep: 'ef', rg: 'ef', sed: 'ef' };
const PATTERN_LONG = /^--(?:regexp|expression)$/;
const FILE_LONG = /^--file$/;
const FILE_COPIERS = new Set(['cp', 'mv', 'rm', 'ln', 'unlink', 'install', 'truncate', 'shred']);
const FILE_SENDERS = new Set(['scp', 'rsync', 'sftp']);
// Options whose next word is a value (an identity file is used, not sent).
const OPTION_VALUE = { scp: /^-[iFoPclSJD]$/, sftp: /^-[iFoPclSJDBRs]$/, rsync: /^-[eT]$/, truncate: /^-[sr]$/ };
// Wrappers that run the command after them, with their options that take a value.
const WRAPPERS = {
  sudo: /^-[ugpCDhrRtTU]$/, doas: /^-[uC]$/, env: /^-[uCS]$/, nice: /^-n$/, ionice: /^-[cnpP]$/,
  stdbuf: /^-[ioe]$/, timeout: /^-[sk]$/, exec: /^-a$/, time: /^-[fo]$/, command: null, builtin: null, nohup: null,
};
const CURL_SHORT_VALUE = 'AbcCdDeEFHKmoPQrtTuUwxXyYz';
// --data-raw sends its value as typed: an @ there names no file.
const CURL_UPLOAD_LONG = /^--(?:data(?:-binary|-ascii|-urlencode)?|json|form|upload-file|url-query)$/;
const CURL_LITERAL_LONG = /^--data-raw$/;
const WGET_UPLOAD_LONG = /^--(?:post|body)-file$/;
const GLOB_SECRET = new RegExp('(?:^|\\/)' + SECRET_GLOB);
const SECRET_DIRS = [
  { level: 'critical', regex: /(?:^|\/)\.(?:ssh|aws|kube)\/?$/, reason: 'Directory of keys and credentials' },
  { level: 'high', regex: /(?:^|\/)\.(?:azure|docker|config\/gcloud)\/?$/, reason: 'Directory of credentials' },
];

function unwrapCommand(words, k) {
  while (k < words.length && !words[k].dynamic && Object.hasOwn(WRAPPERS, base(words[k].value))) {
    const name = base(words[k].value);
    const takesValue = WRAPPERS[name];
    for (k++; k < words.length && /^-./.test(words[k].value); k++) {
      if (words[k].value === '--') { k++; break; }
      if (takesValue && takesValue.test(words[k].value)) k++;
    }
    if (name === 'env') while (k < words.length && /^[A-Za-z_]\w*=/.test(words[k].value)) k++;
    if (name === 'timeout') k++;
  }
  return k;
}

// A * or ? that the shell expands: outside quotes, escapes and substitutions.
function activeGlob(word, src) {
  for (let p = word.start; p < word.end; p++) {
    if (src[p] !== '*' && src[p] !== '?') continue;
    if (word.spans.some(s => p >= s.start && p < s.end)) continue;
    if (word.parts.some(x => typeof x !== 'string' && p >= x.from && p <= x.to)) continue;
    return true;
  }
  return false;
}

// Glob-shaped words of the typed command whose * or ? is quoted or escaped, by
// value and count. The bash-split view drops those quotes, so it must not
// expand them again; a program run by sh -c or eval adds words of its own.
function literalGlobs(text) {
  const out = new Map();
  const read = readShell(text);
  for (const f of read.frames) for (const cmd of f.cmds) for (const w of cmd.words) {
    if (!w.op && /[*?]/.test(w.value) && GLOB_SECRET.test(w.value) && !activeGlob(w, text)) out.set(w.value, (out.get(w.value) || 0) + 1);
  }
  return out;
}

function secretPath(value, word, ctx, dirs) {
  if (!value) return null;
  const { safetyLevel } = ctx;
  const file = checkFilePath(value, safetyLevel);
  if (file.blocked) return file.pattern;
  const threshold = LEVELS[safetyLevel] || 2;
  if (word && /[*?]/.test(value) && GLOB_SECRET.test(value) && activeGlob(word, ctx.src) && !ctx.literal.has(value)) {
    return { level: 'critical', reason: 'A glob that can match a secret file' };
  }
  if (dirs) return SECRET_DIRS.find(d => LEVELS[d.level] <= threshold && d.regex.test(value)) || null;
  return null;
}

// The file named by a curl or wget upload argument: -T file, -d @file,
// --data-urlencode name@file, -F name=@file or name=<file.
function uploadedFile(value, kind) {
  if (kind === 'T') return value;
  const at = /^(?:[^@<=]*=)?[@<]([^;]+)/.exec(value) || (kind === 'urlencode' && /^[^@=]*@([^;]+)/.exec(value));
  return at && at[1] !== '-' ? at[1] : null;
}

function uploadArgs(name, ops) {
  const out = [];
  for (let j = 0; j < ops.length; j++) {
    const v = ops[j].value;
    const long = /^(--[\w-]+)(?:=([\s\S]*))?$/.exec(v);
    if (long) {
      const upload = name === 'wget' ? WGET_UPLOAD_LONG.test(long[1]) : CURL_UPLOAD_LONG.test(long[1]);
      if (!upload) {
        if (name === 'curl' && CURL_LITERAL_LONG.test(long[1]) && long[2] === undefined) j++;
        continue;
      }
      const value = long[2] !== undefined ? long[2] : ops[++j]?.value;
      const kind = name === 'wget' || long[1] === '--upload-file' ? 'T' : long[1] === '--data-urlencode' ? 'urlencode' : 'body';
      out.push({ value, kind, word: ops[j] });
      continue;
    }
    if (name !== 'curl' || !/^-[A-Za-z]/.test(v)) continue;
    for (let c = 1; c < v.length; c++) {
      if (!CURL_SHORT_VALUE.includes(v[c])) continue;
      const value = c + 1 < v.length ? v.slice(c + 1) : ops[++j]?.value;
      if ('dFT'.includes(v[c])) out.push({ value, kind: v[c] === 'T' ? 'T' : 'body', word: ops[j] });
      break;
    }
  }
  return out.map(u => ({ value: u.value && uploadedFile(u.value, u.kind), word: u.kind === 'T' ? u.word : null }));
}

function commandFileAccess(cmd, ctx) {
  const found = (kind, file) => file && { id: FILE_ACCESS[kind].id, level: file.level, reason: `${FILE_ACCESS[kind].reason} (${file.reason})` };
  // Every operand is checked and the most severe file wins, so operand order never lowers the level.
  let best = null;
  const take = (kind, file) => { best = stronger(best, found(kind, file)); };
  for (const w of cmd.words) {
    if (!w.target || w.target === '<&') continue;
    const kind = w.target === '<' ? 'read' : WRITE_REDIRECT.has(w.target) ? 'write' : null;
    if (kind) take(kind, secretPath(w.value, w, ctx));
  }
  const words = argv(cmd);
  const k = unwrapCommand(words, commandIndex(words));
  if (!words[k] || words[k].dynamic) return best;
  const name = base(words[k].value);
  const ops = words.slice(k + 1);
  if (name === 'curl' || name === 'wget') {
    for (const u of uploadArgs(name, ops)) take('send', secretPath(u.value, u.word, ctx));
    return best;
  }
  if (name === 'source' || name === '.') {
    if (ops[0]) take('source', secretPath(ops[0].value, ops[0], ctx));
    return best;
  }
  const kind = FILE_READERS.has(name) ? 'read' : name === 'tee' ? 'write' : FILE_COPIERS.has(name) ? 'copy' : FILE_SENDERS.has(name) ? 'send' : null;
  if (!kind) return best;
  let skipPattern = PATTERN_FIRST.test(name) && !ops.some(o => PATTERN_FLAG.test(o.value));
  const cluster = Object.hasOwn(CLUSTER_VALUES, name) ? CLUSTER_VALUES[name] : null;
  let options = true;
  for (let j = 0; j < ops.length; j++) {
    const v = ops[j].value;
    if (options && v === '--') { options = false; continue; }
    if (options && /^-./.test(v)) {
      const long = /^(--[\w-]+)(?:=([\s\S]*))?$/.exec(v);
      if (cluster && long && (PATTERN_LONG.test(long[1]) || FILE_LONG.test(long[1]))) {
        const value = long[2] !== undefined ? long[2] : ops[++j]?.value;
        skipPattern = false;
        if (FILE_LONG.test(long[1])) take(kind, secretPath(value, long[2] !== undefined ? null : ops[j], ctx));
      } else if (cluster && !long) {
        for (let c = 1; c < v.length; c++) {
          if (name === 'sed' && v[c] === 'i') break;
          if (!cluster.includes(v[c])) continue;
          const attached = c + 1 < v.length;
          const value = attached ? v.slice(c + 1) : ops[++j]?.value;
          if (v[c] === 'e' || v[c] === 'f') skipPattern = false;
          if (v[c] === 'f') take(kind, secretPath(value, attached ? null : ops[j], ctx));
          break;
        }
      } else if (OPTION_VALUE[name] && OPTION_VALUE[name].test(v)) j++;
      else if (kind === 'read' && v.includes('=')) take(kind, secretPath(v.slice(v.indexOf('=') + 1), null, ctx));
      continue;
    }
    if (skipPattern) { skipPattern = false; continue; }
    const value = name === 'dd' ? v.replace(/^(?:if|of)=/, '') : v;
    take(kind, secretPath(value, ops[j], ctx, kind === 'copy' || kind === 'send'));
  }
  return best;
}

// literal: the typed command's quoted glob words; a view that has no more
// words of that value than the typed command has quoted ones does not expand them.
function secretFileAccess(text, safetyLevel, literal) {
  const read = readShell(text);
  const skip = new Set();
  if (literal && literal.size) {
    const seen = new Map();
    for (const f of read.frames) for (const cmd of f.cmds) for (const w of cmd.words) {
      if (literal.has(w.value)) seen.set(w.value, (seen.get(w.value) || 0) + 1);
    }
    for (const [value, count] of literal) if ((seen.get(value) || 0) <= count) skip.add(value);
  }
  const ctx = { safetyLevel, src: text, literal: skip };
  let best = null;
  for (const frame of read.frames) {
    for (const cmd of frame.cmds) best = stronger(best, commandFileAccess(cmd, ctx));
  }
  return best;
}

// base64 given a file the file tools refuse, judged on the whole name as they judge it, so a name the
// pattern's word list does not spell out (.azure/accessTokens.json) still counts. A backup suffix
// (.bak, .backup, .old, .orig, .save, .tmp, ~) is the same file.
const BACKUP_SUFFIX = /(?:\.(?:bak|backup|old|orig|save|tmp)|~)$/i;
function base64ReadsSecret(text) {
  const named = (v) => {
    const parts = [v, ...v.split(/[=@<(]/).slice(1)];
    if (/^-[A-Za-z]./.test(v)) parts.push(v.slice(2));
    return parts.some(p => p && (checkFilePath(p, 'high').blocked || checkFilePath(p.replace(BACKUP_SUFFIX, ''), 'high').blocked));
  };
  if (!/base64/.test(text)) return false;
  for (const f of readShell(text).frames) {
    for (const cmd of f.cmds) {
      const at = cmd.words.findIndex(w => !w.op && !w.target && base(w.value) === 'base64');
      if (at < 0) continue;
      if (cmd.words.slice(at + 1).some(w => !w.op && named(w.value))) return true;
      if (cmd.words.some(w => w.target && named(w.value))) return true;
    }
  }
  return false;
}

// Reading /proc/<pid>/environ by a relative name after cd or pushd into /proc. The directory is
// tracked per shell scope: a cd inside ( ... ) does not change the parent's directory. echo, printf
// and test only name the file. A cd to an unknown place ($DIR) keeps the last known directory.
const PROC_NAMES_ONLY = new Set(['echo', 'printf', 'test', '[', '[[']);
// A directory is kept as its first component and its depth, which is all that decides whether a
// relative name lands under /proc; this keeps long chains of cd linear.
function resolveDir(dir, to) {
  let { head, len } = to.startsWith('/') || !dir ? { head: null, len: 0 } : dir;
  for (const part of to.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (len > 0) len--; if (len === 0) head = null; }
    else { if (len === 0) head = part; len++; }
  }
  return { head, len };
}
const inProc = (dir) => !!dir && dir.head === 'proc';
function procEnvironRead(text) {
  if (!/environ/.test(text)) return false;
  const read = readShell(text);
  let state = { dir: null, prev: null, stack: [] };
  const saved = [];
  const names = (w) => !w.dynamic && /(?:^|\/)environ$/.test(w.value) && !w.value.startsWith('/');
  // A word of code (python3 -c, node -e) or an expanding heredoc body that names environ may open it.
  const mentions = (t) => /(?<![\w.\/-])(?:[^\s\/'"`]+\/+)*environ(?![\w.-])/.test(t);
  const hits = (st, w) => names(w) && inProc(st.dir) && inProc(resolveDir(st.dir, w.value));
  const visit = (cmd, st) => {
    for (const w of cmd.words) for (const f of w.frames || []) for (const c of f.cmds) if (visit(c, { ...st, stack: [...st.stack] })) return true;
    if (cmd.words.some(w => w.target === '<' && hits(st, w))) return true;
    const words = argv(cmd);
    let k = commandIndex(words);
    for (const w of words.slice(0, k < 0 ? words.length : k)) {
      const m = /^[A-Za-z_]\w*\+?=([\s\S]*)$/.exec(w.value);
      if (m && !w.dynamic && hits(st, { value: m[1], dynamic: false })) return true;
    }
    while (k >= 0 && words[k] && !words[k].dynamic && /^(?:builtin|command)$/.test(words[k].value) && words[k + 1] && !/^-/.test(words[k + 1].value)) k++;
    // A command word that is not plain text may be any reader.
    if (k < 0 || !words[k] || words[k].dynamic) return words.some(w => hits(st, w));
    const name = base(words[k].value);
    const ops = words.slice(k + 1).filter(w => !/^-./.test(w.value));
    if (name === 'cd' || name === 'pushd') {
      const to = ops[0];
      const from = st.dir;
      if (name === 'pushd') st.stack.push(from);
      if (!to) { if (name === 'cd') st.dir = null; else st.dir = st.stack.length > 1 ? st.stack.splice(-2, 1)[0] : st.dir; }
      else if (to.dynamic) { /* unknown target: keep the last known directory */ }
      // cd - returns to a directory this line may not show; keep the current one when it is unknown.
      else if (to.value === '-') st.dir = st.prev !== null ? st.prev : st.dir;
      else if (to.value.startsWith('~')) st.dir = null;
      else if (to.value.startsWith('/')) { const d = resolveDir(null, to.value); st.dir = inProc(d) ? d : null; }
      else if (st.dir !== null) { const d = resolveDir(st.dir, to.value); st.dir = inProc(d) ? d : null; }
      st.prev = from;
      return false;
    }
    if (name === 'popd') { st.prev = st.dir; st.dir = st.stack.length ? st.stack.pop() : null; return false; }
    if (PROC_NAMES_ONLY.has(name)) return false;
    if (inProc(st.dir) && words.slice(k + 1).some(w => mentions(w.value))) return true;
    if (inProc(st.dir) && read.heredocs.some(h => h.cmd === cmd && !h.quoted && /[$`]/.test(text.slice(h.bodyStart, h.bodyEnd)) && mentions(text.slice(h.bodyStart, h.bodyEnd)))) return true;
    return words.slice(k + 1).some(w => hits(st, w) || hits(st, { value: w.value.replace(/^[^=]*=/, ''), dynamic: w.dynamic }));
  };
  for (const cmd of read.top.cmds) {
    for (const w of cmd.words) if (w.op === '(') saved.push({ ...state, stack: [...state.stack] });
    if (visit(cmd, state)) return true;
    for (const w of cmd.words) if (w.op === ')' && saved.length) state = saved.pop();
  }
  return false;
}

// A command that prints the whole environment, wherever it sits in the line:
// after a newline, a keyword or a brace, behind a wrapper or a path, with its
// output redirected or inside a substitution.
const DECLARATIONS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);
// Wrappers that run the command after them, with the options whose value is the next word.
const DUMP_WRAPPERS = {
  sudo: /^(?:-[ugpCDhrRtTU]|--(?:user|group|other-user|prompt|close-from|chdir|role|type|host))$/,
  doas: /^-[uC]$/, nice: /^(?:-n|--adjustment)$/, ionice: /^(?:-[cnpP]|--(?:class|classdata|pid|pgid|uid))$/,
  stdbuf: /^(?:-[ioe]|--(?:input|output|error))$/, timeout: /^(?:-[sk]|--(?:signal|kill-after))$/,
  exec: /^-a$/, time: /^(?:-[fo]|--(?:format|output))$/, command: null, builtin: null, nohup: null,
};
// env options that take a value; -S runs the command in its value, so it is no dump.
const ENV_VALUE_OPT = /^(?:-[uC]|--(?:unset|chdir))$/;

function commandDumpsEnvironment(cmd) {
  const words = argv(cmd);
  let k = 0;
  while (k < words.length && !words[k].spans.length
    && ((KEYWORDS.has(words[k].value) && !DECLARATIONS.has(words[k].value)) || /^[A-Za-z_]\w*\+?=/.test(words[k].lead || ''))) k++;
  // The time keyword's -p only changes the timing format.
  if (k > 0 && words[k - 1].value === 'time') while (words[k] && words[k].value === '-p') k++;
  for (;;) {
    while (k < words.length && !words[k].dynamic && Object.hasOwn(DUMP_WRAPPERS, base(words[k].value))) {
      const wrapper = base(words[k].value);
      const takesValue = DUMP_WRAPPERS[wrapper];
      for (k++; k < words.length && /^-./.test(words[k].value); k++) {
        if (words[k].value === '--') { k++; break; }
        // command -v and -V look the name up without running it.
        if (wrapper === 'command' && /^-[A-Za-z]*[vV]/.test(words[k].value)) return false;
        if (takesValue && takesValue.test(words[k].value)) k++;
      }
      if (wrapper === 'timeout') k++;
    }
    const w = words[k];
    if (!w || w.dynamic) return false;
    const name = base(w.value);
    const ops = words.slice(k + 1).map(o => o.value);
    if (name === 'env') {
      let j = 0;
      for (; j < ops.length && /^-/.test(ops[j]); j++) {
        if (/^(?:-S|--split-string)/.test(ops[j])) return false;
        // An emptied environment, help or version text prints none of the caller's variables.
        if (/^(?:-[0v]*i[0iv]*|-|--ignore-environment|--help|--version)$/.test(ops[j])) return false;
        if (ENV_VALUE_OPT.test(ops[j])) j++;
      }
      while (j < ops.length && /^[A-Za-z_]\w*=/.test(ops[j])) j++;
      if (j >= ops.length) return true;
      // env runs the next word as a command, which may itself print the environment.
      k += 1 + j;
      continue;
    }
    if (name === 'export') return ops.every(o => o === '-p');
    if (name === 'declare' || name === 'typeset') return ops.every(o => /^[-+][a-eg-zA-EG-Z]+$/.test(o));
    if (name === 'set') return ops.length === 0;
    return false;
  }
}

function dumpsEnvironment(text) {
  return readShell(text).frames.some(f => f.cmds.some(commandDumpsEnvironment));
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
