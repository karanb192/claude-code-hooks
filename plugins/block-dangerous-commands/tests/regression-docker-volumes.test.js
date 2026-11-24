#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: docker volume deletion in other forms
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-docker-volumes.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// A HOOK_SAFETY_LEVEL leaking in from the runner's shell would change the default level.
delete process.env.HOOK_SAFETY_LEVEL;

const { PATTERNS, checkCommand } = require('../block-dangerous-commands.js');

function shouldBlock(cmd, expectedId, safetyLevel = undefined) {
  const result = checkCommand(cmd, safetyLevel);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${cmd}`);
  assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
}

function shouldAllow(cmd, safetyLevel = undefined) {
  const result = checkCommand(cmd, safetyLevel);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
}

describe('docker volume deletion in other forms', () => {
  it('blocks the remove alias', () => {
    shouldBlock('docker volume remove data', 'docker-vol-rm');
    shouldBlock('docker volume remove pgdata', 'docker-vol-rm');
  });
  it('blocks volume rm after global options', () => {
    shouldBlock('docker --context prod volume rm data', 'docker-vol-rm');
    shouldBlock('docker -H ssh://h volume rm data', 'docker-vol-rm');
  });
  it('blocks compose down with volumes and system prune --volumes', () => {
    for (const c of ['docker compose down -v', 'docker-compose down --volumes', 'docker compose -f dev.yml down -v', 'docker system prune --volumes -f'])
      shouldBlock(c, 'docker-vol-rm');
  });
  it('allows commands that keep volumes', () => {
    for (const c of ['docker compose down', 'docker compose up -d', 'docker volume ls', 'docker volume create v', 'docker -H ssh://h ps', 'docker system prune -f'])
      shouldAllow(c);
  });
  it('allows a compose service named down', () => {
    for (const c of ['docker compose run --rm down ls -v', 'docker compose restart down -v', 'docker compose -f dev.yml exec down ls -v'])
      shouldAllow(c);
  });
  it('still blocks down -v after compose options', () => {
    for (const c of ['docker compose --project-name p down -v', 'docker compose -p p down --volumes', 'docker compose --dry-run down -v'])
      shouldBlock(c, 'docker-vol-rm');
  });
  it('a long run of global options stays fast', () => {
    const { regex } = PATTERNS.find((p) => p.id === 'docker-vol-rm');
    for (const input of ['docker ' + '-H '.repeat(20000) + 'x', 'docker ' + '-c -c '.repeat(10000), 'docker compose ' + 'down '.repeat(20000) + 'x']) {
      const start = Date.now();
      regex.test(input);
      assert.ok(Date.now() - start < 200, `took ${Date.now() - start} ms on ${input.slice(0, 20)}`);
    }
  });
});

describe('compose down with volumes after docker global options', () => {
  it('blocks docker global options before compose', () => {
    for (const c of ['docker --context prod compose down -v', 'docker --context=prod compose down --volumes', 'docker -H ssh://h compose down -v', 'docker -c prod compose -p app down -v', 'docker --log-level debug compose down -v', 'sudo docker --context prod compose down -v'])
      shouldBlock(c, 'docker-vol-rm');
  });
  it('allows compose commands that keep volumes after docker global options', () => {
    for (const c of ['docker --context prod compose down', 'docker --context prod compose up -d', 'docker --context prod compose run --rm down ls -v', 'docker --context prod compose logs -f', 'docker --context prod ps'])
      shouldAllow(c);
  });
});

describe('docker global option values in every shell spelling', () => {
  it('blocks a quoted, attached or =value global option before compose down -v or volume rm', () => {
    for (const c of ['docker --config "/my dir" compose down -v', 'docker --config="/my dir" compose down --volumes', 'docker --config my\\ dir compose down -v', 'docker -Htcp://h compose down -v', 'docker --debug=true compose down -v', 'docker --debug=true volume rm data', 'docker -l=debug system prune --volumes', 'docker compose -f "my file.yml" down -v'])
      shouldBlock(c, 'docker-vol-rm');
  });
  it('still blocks a compose preview or help with volumes, as main does', () => {
    for (const c of ['docker --context prod compose --dry-run down -v', 'docker --context prod compose down --volumes --help']) shouldBlock(c, 'docker-vol-rm');
  });
  it('allows the same global options before commands that keep volumes', () => {
    for (const c of ['docker --config "/my dir" compose up -d', 'docker -Htcp://h ps', 'docker --debug=true compose run --rm down ls -v', 'docker --context prod compose down']) shouldAllow(c);
  });
});

describe('escaped quotes and short clusters that take a value', () => {
  it('blocks a value with an escaped quote and a cluster that ends in a value option', () => {
    for (const c of ['docker --config "/my \\"x dir" compose down -v', 'docker -Dc prod compose down -v', 'docker -Dc prod volume rm data', 'docker -DH tcp://h compose down -v', 'docker compose -df prod.yml down -v', 'docker compose -dp app down --volumes'])
      shouldBlock(c, 'docker-vol-rm');
  });
  it('allows the same options before commands that keep volumes, and an attached value', () => {
    for (const c of ['docker -Dc prod compose up -d', 'docker compose -df prod.yml up', 'docker --config "/my \\"x dir" compose down', 'docker compose -p"app" run --rm down ls -v']) shouldAllow(c);
  });
  it('still refuses down --volumes=false on purpose, as main does', () => shouldBlock('docker compose down --volumes=false', 'docker-vol-rm'));
});
