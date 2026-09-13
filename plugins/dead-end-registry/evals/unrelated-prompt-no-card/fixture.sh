#!/usr/bin/env bash
# Control fixture: same seeded dead-end entry as dead-end-card-steers, plus a
# workspace file the prompt can be answered from. The prompt shares no keywords
# with the entry, so the hook must stay silent.
set -e

MARKER="cch-eval-unrelated-prompt-no-card"
REGISTRY_DIR="${HOME}/.claude/dead-end-registry"
SUMMARY="switched fetchWithRetry in client.js to exponential backoff with jitter"
KEYWORDS='["switched","fetchwithretry","client.js","exponential","backoff","jitter"]'
FINGERPRINT="backoff|client.js|exponential|fetchwithretry|jitter|switched"
TOKENS=18400
USD=0.17

sha1_head8() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 1 | cut -c1-8
  else
    printf '%s' "$1" | sha1sum | cut -c1-8
  fi
}

# Mirrors registryFileFor() in dead-end-registry.js: every run of
# non-alphanumeric characters collapses to "-", the slug is trimmed, cut to its
# last 40 characters, and suffixed with the first 8 hex of sha1(cwd).
registry_file_for() {
  slug=$(printf '%s' "$1" | sed -e 's/[^a-zA-Z0-9][^a-zA-Z0-9]*/-/g' -e 's/^-*//' -e 's/-*$//')
  slug=$(printf '%s' "$slug" | tail -c 40)
  if [ -z "$slug" ]; then slug="root"; fi
  printf '%s/%s-%s.jsonl' "$REGISTRY_DIR" "$slug" "$(sha1_head8 "$1")"
}

mkdir -p "$REGISTRY_DIR"

cat > config.js <<'JS'
function parseConfig(env = process.env) {
  return {
    port: Number(env.PORT || 8080),
    logLevel: env.LOG_LEVEL || 'info',
    cacheDir: env.CACHE_DIR || './.cache',
    timeoutMs: Number(env.TIMEOUT_MS || 5000),
  };
}

module.exports = { parseConfig };
JS

ENTRY=$(printf '{"id":"%s","date":"%s","ts":"%s","summary":"%s","reason":"reverted","signal":"reverted","keywords":%s,"fingerprint":"%s","tokens":%s,"usd":%s}' \
  "$MARKER" "$(date -u +%Y-%m-%d)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SUMMARY" "$KEYWORDS" "$FINGERPRINT" "$TOKENS" "$USD")

# The runner realpaths its temp root before it hands the cwd to the hook, so the
# physical path is the only key that can match. The redirect overwrites, so a
# second run in the same directory leaves one entry, not two.
file=$(registry_file_for "$(pwd -P)")
printf '%s\n' "$ENTRY" > "$file"
