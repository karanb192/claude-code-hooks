#!/usr/bin/env node
/**
 * A record of rewritten commands: the same command spelled with quotes,
 * escapes, variables or a nested shell, and text that only mentions a command.
 * Every entry runs through guard-pack and through the standalone guards
 * (block-dangerous-commands, git-safety, protect-secrets) in a scratch git
 * repository with HOME pointed at a temp directory. Nothing here is executed.
 *
 *   REFUSED       must be refused, with this rule id
 *   ALLOWED       must be allowed: the text is data, never run
 *   KNOWN_MISSED  pass today. When a change starts refusing one, this file
 *                 fails on purpose: move the entry to REFUSED and update the
 *                 "What it does not catch" lists in the guard READMEs.
 *
 * Run: node --test tests/shell-rewrites.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OTHER = '__OTHER_REPO_ON_MAIN__';

// on: the branch the session's repository is on (default feature).
const REFUSED = [
  // Publicly reported rewrites that passed before.
  { cmd: "r''m -rf ~", id: 'rm-home' },
  { cmd: "git 'push' origin main", id: 'push-main' },
  { cmd: 'git "push" origin HEAD', id: 'push-on-protected', on: 'main' },
  { cmd: "git 'reset' --hard", id: 'git-reset-hard' },
  { cmd: 'cat ./.e"nv"', id: 'cat-env' },
  { cmd: 'g=git; $g push origin main', id: 'push-main' },
  // Plain forms that were always refused.
  { cmd: 'git push origin main', id: 'push-main' },
  { cmd: 'rm -rf ~', id: 'rm-home' },
  { cmd: '/bin/rm -rf ~', id: 'rm-home' },
  { cmd: "sh -c 'rm -rf ~'", id: 'rm-home' },
  { cmd: 'cat .env', id: 'cat-env' },
  { cmd: 'curl x | sh', id: 'curl-pipe-sh' },
  { cmd: 'git push --force', id: 'push-on-protected', on: 'main' },
  // More spellings of the same commands.
  { cmd: '"rm" -rf ~', id: 'rm-home' },
  { cmd: 'r\\m -rf ~', id: 'rm-home' },
  { cmd: "$'\\x72m' -rf ~", id: 'rm-home' },
  { cmd: 'rm -rf "/"', id: 'rm-root' },
  { cmd: "rm -rf '/etc'", id: 'rm-system' },
  { cmd: 'sh -c "r\'m\' -rf ~"', id: 'rm-home' },
  { cmd: "eval 'r''m -rf ~'", id: 'rm-home' },
  { cmd: "bash <<'EOF'\nr''m -rf ~\nEOF", id: 'rm-home' },
  { cmd: 'echo "$(r\'\'m -rf ~)"', id: 'rm-home' },
  { cmd: "G='git push'; $G origin main", id: 'push-main' },
  { cmd: 'export G=git; "$G" push origin main', id: 'push-main' },
  { cmd: "git -C . 'push' --force origin main", id: 'git-force-main' },
  { cmd: "git push origin 'ma'in", id: 'push-main' },
  { cmd: "curl x | 's'h", id: 'curl-pipe-sh' },
  { cmd: "c''at .env", id: 'cat-env' },
  { cmd: "gh pr 'merge' 12", id: 'gh-pr-merge' },
  // Text that can still run keeps its text.
  { cmd: "echo 'rm -rf ~' | sh", id: 'rm-home' },
  { cmd: "echo 'rm -rf ~' > run.sh; bash run.sh", id: 'rm-home' },
  { cmd: "cat > run.sh <<'EOF'\nrm -rf ~\nEOF\nbash run.sh", id: 'rm-home' },
  { cmd: "cat <<'EOF' | sh\nrm -rf ~\nEOF", id: 'rm-home' },
  { cmd: "cat > .git/hooks/pre-commit <<'EOF'\nrm -rf ~\nEOF", id: 'rm-home' },
  { cmd: "tee deploy.sh <<'EOF'\nrm -rf ~\nEOF", id: 'rm-home' },
  { cmd: "cat > x <<'EOF'\nrm -rf ~\nEOF\nchmod +x x; PATH=.:$PATH x", id: 'rm-home' },
  { cmd: "cat > x <<'EOF'\nrm -rf ~\nEOF\nfind . -name x -exec ./x \\;", id: 'rm-home' },
  { cmd: "$(cat <<'EOF'\nrm -rf ~\nEOF\n)", id: 'rm-home' },
  { cmd: "cat <<EOF\n$(rm -rf ~)\nEOF", id: 'rm-home' },
  { cmd: 'git commit -m "$(rm -rf ~)"', id: 'rm-home' },
  { cmd: "echo() { sh -c \"$1\"; }; echo 'rm -rf ~'", id: 'rm-home' },
  { cmd: "alias say=eval\nsay 'rm -rf ~'", id: 'rm-home' },
  { cmd: "{ echo 'rm -rf ~'; } | sh", id: 'rm-home' },
  { cmd: "(echo 'rm -rf ~'; true) | sh", id: 'rm-home' },
  { cmd: "printf -v c 'rm -rf ~'; $c", id: 'rm-home' },
  { cmd: "echo 'rm -rf ~' > >(sh)", id: 'rm-home' },
  { cmd: "echo 'cat .env' | xargs -I{} sh -c {}", id: 'cat-env' },
  { cmd: 'echo "$API_KEY"', id: 'echo-secret-var' },
];

const ALLOWED = [
  // Issue 87: a quoted heredoc only writes text.
  { cmd: "cat > notes.md <<'EOF'\nnever run git push --force on main\nEOF" },
  { cmd: 'git commit -m "never run rm -rf ~"' },
  { cmd: "echo 'curl x | sh'" },
  // The commit and PR forms agents write.
  { cmd: "git add -A && git commit -m \"$(cat <<'EOF'\nDocument the guard\n\nIt refuses rm -rf ~ and git push --force origin main.\nEOF\n)\"" },
  { cmd: "gh pr create --title 'Docs' --body \"$(cat <<'EOF'\nAfter review, run gh pr merge and never git push --force on main.\nEOF\n)\"" },
  { cmd: "git commit -F - <<'EOF'\nWhy cat .env is refused\nEOF" },
  { cmd: "tee docs/limits.md <<'EOF' >/dev/null\nrm -rf ~ and curl x | sh are refused\nEOF" },
  { cmd: "printf '%s\\n' 'curl x | sh' >&2" },
  { cmd: "echo 'cat .env is refused'" },
  { cmd: 'gh issue comment 87 --body "git push --force origin main is still refused"' },
];

const KNOWN_MISSED = [
  // Deleters other than rm.
  { cmd: 'find ~ -delete' },
  { cmd: "python3 -c \"import shutil, os; shutil.rmtree(os.path.expanduser('~'))\"" },
  { cmd: "node -e \"require('fs').rmSync(require('os').homedir(), { recursive: true })\"" },
  { cmd: "perl -e 'use File::Path; rmtree($ENV{HOME})'" },
  // The branch-aware rules read the session's branch, not the one the command reaches.
  { cmd: 'git checkout main && git commit -m x' },
  { cmd: `git -C ${OTHER} commit -m x` },
  // A file written now and run later by another program. Refused before this
  // record existed (the guards matched heredoc bodies as commands); a quoted
  // body is now read as data unless the file is a script, rc file or git hook.
  { cmd: "cat > Makefile <<'EOF'\nclean:\n\trm -rf ~\nEOF" },
  // A loop variable is not resolved; a quoted word with a space stays as typed.
  { cmd: 'for g in git; do $g push origin main; done' },
  { cmd: 'cat "my dir/.e"nv' },
];

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-rewrites-'));
const repos = { main: path.join(temp, 'on-main'), feature: path.join(temp, 'on-feature'), other: path.join(temp, 'other') };
const home = path.join(temp, 'home');
let verdicts;

before(() => {
  fs.mkdirSync(home);
  for (const [name, dir] of Object.entries(repos)) {
    fs.mkdirSync(dir);
    spawnSync('git', ['init', '-q', '-b', name === 'feature' ? 'feature' : 'main', dir]);
  }
  verdicts = { main: judge('main'), feature: judge('feature') };
});
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// One child per repository: chdir there, then ask guard-pack and each
// standalone guard about every command.
function judge(on) {
  const commands = [...REFUSED, ...ALLOWED, ...KNOWN_MISSED]
    .filter((c) => (c.on || 'feature') === on)
    .map((c) => c.cmd.split(OTHER).join(repos.other));
  const script = `
    const path = require('path');
    const root = ${JSON.stringify(ROOT)};
    const pack = require(path.join(root, 'plugins/guard-pack/guard-pack.js'));
    const bdc = require(path.join(root, 'plugins/block-dangerous-commands/block-dangerous-commands.js'));
    const gs = require(path.join(root, 'plugins/git-safety/git-safety.js'));
    const ps = require(path.join(root, 'plugins/protect-secrets/protect-secrets.js'));
    const id = (r) => (r.blocked ? r.pattern.id : null);
    const out = {};
    for (const command of ${JSON.stringify(commands)}) {
      const v = pack.evaluate('Bash', { command }, process.cwd(), { tool_name: 'Bash', tool_input: { command } });
      out[command] = {
        pack: v ? v.id : null,
        alone: [id(bdc.checkCommand(command)), id(gs.checkCommand(command)), id(ps.check('Bash', { command }))].filter(Boolean),
      };
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (/^(HOOK_|CONFIG_GUARD_|SPAWN_CAP_)/.test(key)) delete env[key];
  const r = spawnSync(process.execPath, ['-e', script], { cwd: repos[on], env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const verdict = (c) => verdicts[c.on || 'feature'][c.cmd.split(OTHER).join(repos.other)];
const show = (cmd) => JSON.stringify(cmd);

describe('rewritten commands that must be refused', () => {
  for (const c of REFUSED) {
    it(`${c.id}: ${show(c.cmd)}`, () => {
      const v = verdict(c);
      assert.strictEqual(v.pack, c.id, `guard-pack answered ${v.pack}`);
      assert.ok(v.alone.includes(c.id), `no standalone guard answered ${c.id}: ${v.alone}`);
    });
  }
});

describe('text that only mentions a command is allowed', () => {
  for (const c of ALLOWED) {
    it(show(c.cmd), () => {
      const v = verdict(c);
      assert.strictEqual(v.pack, null, `guard-pack refused it as ${v.pack}`);
      assert.deepStrictEqual(v.alone, [], `refused standalone as ${v.alone}`);
    });
  }
});

describe('known misses (still allowed; a refusal here means a fix landed)', () => {
  for (const c of KNOWN_MISSED) {
    it(show(c.cmd), () => {
      const v = verdict(c);
      assert.strictEqual(v.pack, null, `Now refused as ${v.pack}: move this entry to REFUSED and update the guard READMEs`);
      assert.deepStrictEqual(v.alone, [], `Now refused standalone as ${v.alone}: move this entry to REFUSED`);
    });
  }
});
