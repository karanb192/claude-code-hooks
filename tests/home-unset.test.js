/**
 * Every guard and recorder must start when HOME is unset (a native Windows
 * shell may only set USERPROFILE). A throw at import exits 1, which Claude
 * Code treats as a non-blocking error, so the tool call would run unchecked.
 * USERPROFILE points at a temp dir: with both unset, the fallback is
 * os.homedir(), which would write logs into the real home.
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGINS = path.resolve(__dirname, '..', 'plugins');
const SCRIPTS = fs.readdirSync(PLUGINS)
  .map(name => path.join(PLUGINS, name, `${name}.js`))
  .filter(file => fs.existsSync(file));

function run(script, payload, env) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
    env,
  });
}

describe('HOME unset', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cch-nohome-'));
  after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const env = { ...process.env, USERPROFILE: scratch };
  delete env.HOME;

  for (const script of SCRIPTS) {
    it(`${path.basename(script)} loads without HOME`, () => {
      const out = run(script, { tool_name: 'Read', tool_input: { file_path: 'README.md' }, cwd: scratch }, env);
      assert.doesNotMatch(out.stderr, /ERR_INVALID_ARG_TYPE/, out.stderr);
      assert.notStrictEqual(out.status, 1, out.stderr);
    });
  }

  it('block-dangerous-commands still denies without HOME', () => {
    const script = path.join(PLUGINS, 'block-dangerous-commands', 'block-dangerous-commands.js');
    const out = run(script, { tool_name: 'Bash', tool_input: { command: 'rm -rf ~' }, cwd: scratch }, env);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });

  it('git-safety still denies without HOME', () => {
    const script = path.join(PLUGINS, 'git-safety', 'git-safety.js');
    const out = run(script, { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: scratch }, env);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});
