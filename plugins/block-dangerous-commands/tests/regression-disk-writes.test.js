#!/usr/bin/env node
/**
 * Regression tests for block-dangerous-commands: dd and mkfs device names and mkfs options
 *
 * Run: node --test plugins/block-dangerous-commands/tests/regression-disk-writes.test.js
 * Or:  npm test
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// A HOOK_SAFETY_LEVEL leaking in from the runner's shell would change the default level.
delete process.env.HOOK_SAFETY_LEVEL;

const { checkCommand } = require('../block-dangerous-commands.js');

function shouldBlock(cmd, expectedId, safetyLevel = undefined) {
  const result = checkCommand(cmd, safetyLevel);
  assert.strictEqual(result.blocked, true, `Expected BLOCKED but was ALLOWED: ${cmd}`);
  assert.strictEqual(result.pattern.id, expectedId, `Expected pattern '${expectedId}' but got '${result.pattern.id}'`);
}

function shouldAllow(cmd, safetyLevel = undefined) {
  const result = checkCommand(cmd, safetyLevel);
  assert.strictEqual(result.blocked, false, `Expected ALLOWED but was BLOCKED by '${result.pattern?.id}': ${cmd}`);
}

describe('dd to more disk device names', () => {
  it('blocks an SD card and a by-id link', () => {
    shouldBlock('dd if=/dev/zero of=/dev/mmcblk0', 'dd-disk');
    shouldBlock('dd if=/dev/zero of=/dev/disk/by-id/ata-X', 'dd-disk');
  });
  it('allows dd from a disk into a file', () => {
    shouldAllow('dd if=/dev/sda of=disk.img');
    shouldAllow('dd if=/dev/zero of=img bs=1M');
  });
});

describe('mkfs with options before the device', () => {
  it('blocks -F, -t and -n before the device', () => {
    for (const c of ['mkfs.ext4 -F /dev/sda1', 'mkfs -t ext4 /dev/sda1', 'mkfs.vfat -n X /dev/disk2s1', 'mkfs.ext4 -F /dev/sda', 'mkfs -t ext4 /dev/sda'])
      shouldBlock(c, 'mkfs');
  });
  it('blocks a Xen disk', () => shouldBlock('mkfs.ext4 /dev/xvda1', 'mkfs'));
  it('allows mkfs on an image file', () => {
    shouldAllow('mkfs.ext4 disk.img');
    shouldAllow('mkfs.ext4 -F disk.img; ls /dev/sda');
  });
});

describe('mkfs dry runs', () => {
  it('allows the dry-run flag of the selected program', () => {
    for (const c of ['mkfs.ext4 -n /dev/sdb1', 'mkfs.xfs -N /dev/sdb1', 'mkfs -t xfs -N /dev/sdb', 'mkfs.ext4 -Fn /dev/sdb1']) shouldAllow(c);
  });
  it('still blocks -n where it takes a value, and a device right after mkfs', () => {
    for (const c of ['mkfs.fat -n LABEL /dev/sdb1', 'mkfs.xfs -n size=64k /dev/sdb1', 'mkfs.ext4 -N 1000 /dev/sdb1', 'mkfs.ext4 /dev/sdb1 -n', 'mkfs.ext4 -n /dev/sdb1; mkfs.ext4 /dev/sdc'])
      shouldBlock(c, 'mkfs');
  });
});

describe('mkfs with a redirect between its operands', () => {
  it('still sees the device after a redirect', () => {
    for (const c of ['mkfs.ext4 2>/dev/null /dev/sdb1', 'mkfs.ext4 -F >log /dev/sdb1', 'mkfs.ext4 </dev/null /dev/sdb1', 'mkfs -t ext4 2>&1 /dev/sdb'])
      shouldBlock(c, 'mkfs');
  });
  it('still allows a dry run with a redirect', () => shouldAllow('mkfs.ext4 -n 2>/dev/null /dev/sdb1'));
});
