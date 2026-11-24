#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: a protected path spelled with . or .. components or repeated /
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-path-spellings.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// A HOOK_SAFETY_LEVEL leaking in from the runner's shell would change the default level.
delete process.env.HOOK_SAFETY_LEVEL;

const { checkCommand } = require('../block-dangerous-commands.js');

function shouldBlock(cmd, expectedId) {
  for (const level of ['high', 'strict']) {
    const result = checkCommand(cmd, level);
    assert.strictEqual(result.blocked, true, `Expected BLOCKED at ${level} but was ALLOWED: ${cmd}`);
    assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
  }
}

function shouldAllow(cmd) {
  for (const level of ['high', 'strict']) {
    const result = checkCommand(cmd, level);
    assert.strictEqual(result.blocked, false, `Expected ALLOWED at ${level} but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
  }
}

describe('the root spelled with . or repeated /', () => {
  it('blocks rm of everything in the root', () => {
    for (const c of ['rm -rf /./*', 'rm -rf //*']) shouldBlock(c, 'rm-root');
  });
});

describe('a system directory spelled with ., .. or repeated /', () => {
  it('blocks rm of a system directory or a path inside it', () => {
    for (const c of ['rm -rf /./etc/nginx', 'rm -rf //etc/nginx', 'rm -rf ///etc/nginx', 'rm -rf /tmp/../etc/nginx', 'rm -rf /./bin', 'rm -rf //bin', 'rm -rf /./var', 'rm -rf /../../etc', 'rm -rf "/./etc"', 'rm -rf /"."/etc', 'sudo rm -rf /./usr/lib', 'rm -rf /etc/../usr'])
      shouldBlock(c, 'rm-system');
  });
});

describe('a home directory spelled with ., .. or repeated /', () => {
  it('blocks rm of home directories by absolute path', () => {
    for (const c of ['rm -rf /./home', 'rm -rf //home/x', 'rm -rf /./Users/x']) shouldBlock(c, 'rm-home-abs');
  });
  it('blocks rm of ~ and $HOME by another spelling', () => {
    for (const c of ['rm -rf ~/./', 'rm -rf ~//', 'rm -rf ~/x/..']) shouldBlock(c, 'rm-home');
    shouldBlock('rm -rf $HOME/./', 'rm-home-var');
  });
});

describe('a disk device spelled with . or repeated /', () => {
  it('blocks dd and mkfs writing to the device', () => {
    for (const c of ['dd if=/dev/zero of=/./dev/sda', 'dd if=/dev/zero of=//dev/sda']) shouldBlock(c, 'dd-disk');
    shouldBlock('mkfs.ext4 /./dev/sda1', 'mkfs');
  });
});

describe('ordinary paths with . or repeated /', () => {
  it('allows paths that do not reach a protected directory or device', () => {
    for (const c of ['rm -rf /tmp/./x', 'rm -rf //tmp/build', 'rm -rf ./build//out', 'rm -rf /home/dev/proj/./build', 'dd if=/dev/zero of=/tmp/./img', 'mkfs.ext4 /tmp/./disk.img', 'ls //etc', 'cat /./etc/hosts'])
      shouldAllow(c);
  });
  it('still refuses rm of / spelled /. or /./ on purpose, as rm of /', () => {
    for (const c of ['rm -rf /.', 'rm -rf /./']) shouldBlock(c, 'rm-root');
  });
});
