'use strict';

const fs = require('fs');
const path = require('path');
const update = require('../scripts/codex-ide-update');
const { createFixture } = require('./helpers/fixture');

describe('update version handling', () => {
  test.each([
    ['1.2.9', '1.3.0', -1], ['2.0.0', '1.99.99', 1], ['1.2.9', '1.2.9', 0],
    ['1.0.0-alpha', '1.0.0', -1], ['1.0.0-alpha.2', '1.0.0-alpha.10', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0-2', '1.0.0-beta', -1],
    ['v1.2.3+build.1', '1.2.3+build.2', 0]
  ])('compares %s with %s', (left, right, expected) => {
    expect(update.compareVersions(left, right)).toBe(expected);
  });

  test.each(['latest', '1.2', '01.2.3', '1.2.3.4', '', null])('rejects invalid versions: %s', value => {
    expect(update.parseSemver(value)).toBeNull();
    expect(() => update.compareVersions(value, '1.0.0')).toThrow();
  });

  test.each(['"1.3.0"', '1.3.0', '["1.2.9","1.3.0"]'])('reads the latest npm version from %s', async output => {
    const execFileImpl = jest.fn((_bin, _args, _options, callback) => callback(null, output, ''));
    await expect(update.getLatestVersion('codex-ide', { execFileImpl })).resolves.toBe('1.3.0');
    expect(execFileImpl.mock.calls[0][1]).toEqual(['view', 'codex-ide', 'dist-tags.latest', '--json']);
  });

  test('surfaces npm failures and malformed versions', async () => {
    await expect(update.getLatestVersion('codex-ide', {
      execFileImpl: (_bin, _args, _options, callback) => callback(new Error('failed'), '', 'registry unavailable')
    })).rejects.toThrow('registry unavailable');
    await expect(update.getLatestVersion('codex-ide', {
      execFileImpl: (_bin, _args, _options, callback) => callback(null, '{"version":"1.3.0"}', '')
    })).rejects.toThrow(/gueltige/);
  });
});

describe('workspace backup and self update', () => {
  let fixture;
  let logger;
  beforeEach(() => {
    fixture = createFixture();
    logger = { log: jest.fn(), error: jest.fn() };
    fixture.write('package.json', JSON.stringify({ name: 'codex-ide', version: '1.2.9' }), fixture.root);
    fixture.write('.gitkeep', '');
    fixture.write('src/app.js', 'console.log("Grüße 👋");\n');
    fixture.write('data.bin', Buffer.from([0, 255, 1, 128]));
    fs.mkdirSync(path.join(fixture.home, 'empty'));
  });
  afterEach(() => fixture.dispose());

  test('backs up and restores contents, permissions and empty directories exactly', () => {
    fs.chmodSync(path.join(fixture.home, 'src/app.js'), 0o640);
    const before = update.workspaceRecords(fixture.home);
    const backup = update.backupWorkspace(fixture.root, fixture.root);
    fixture.write('src/app.js', 'corrupted');
    fixture.write('unwanted.txt', 'new file from installer');
    expect(update.restoreWorkspace(fixture.root, backup)).toBe(fixture.home);
    expect(update.workspaceRecords(fixture.home)).toEqual(before);
  });

  test('preserves relative symlinks without rewriting their targets', () => {
    fs.symlinkSync('src/app.js', path.join(fixture.home, 'entry.js'));
    const before = update.workspaceDigest(fixture.home);
    const backup = update.backupWorkspace(fixture.root, fixture.root);
    expect(fs.readlinkSync(path.join(backup.backupPath, 'entry.js'))).toBe('src/app.js');
    update.restoreWorkspace(fixture.root, backup);
    expect(fs.readlinkSync(path.join(fixture.home, 'entry.js'))).toBe('src/app.js');
    expect(update.workspaceDigest(fixture.home)).toBe(before);
  });

  test('refuses a tampered backup before replacing the current workspace', () => {
    const backup = update.backupWorkspace(fixture.root, fixture.root);
    fixture.write('src/app.js', 'tampered', backup.backupPath);
    const current = update.workspaceDigest(fixture.home);
    expect(() => update.restoreWorkspace(fixture.root, backup)).toThrow(/veraendert/);
    expect(update.workspaceDigest(fixture.home)).toBe(current);
  });

  test('only permits the fixed model-home path', () => {
    expect(() => update.assertWorkspaceTarget(fixture.root, fixture.home)).not.toThrow();
    expect(() => update.assertWorkspaceTarget(fixture.root, path.join(fixture.root, 'other'))).toThrow();
  });

  test('completes an update after verifying the installed version and workspace', async () => {
    const before = update.workspaceDigest(fixture.home);
    const installRunner = jest.fn(async () => {
      fs.rmSync(fixture.home, { recursive: true, force: true });
      fixture.write('package.json', JSON.stringify({ name: 'codex-ide', version: '1.3.0' }), fixture.root);
      return 0;
    });
    await expect(update.performSelfUpdate('1.3.0', {
      packageRoot: fixture.root, globalPackageRoot: fixture.root, installRunner, logger
    })).resolves.toEqual({ updated: true, version: '1.3.0' });
    expect(installRunner).toHaveBeenCalledWith('codex-ide@1.3.0', expect.objectContaining({ cwd: fixture.root }));
    expect(update.workspaceDigest(fixture.home)).toBe(before);
  });

  test.each(['exit code', 'exception'])('restores user data after an installer failure: %s', async failure => {
    const before = update.workspaceDigest(fixture.home);
    const installRunner = async () => {
      fs.rmSync(fixture.home, { recursive: true, force: true });
      if (failure === 'exception') throw new Error('installer crashed');
      return 1;
    };
    await expect(update.performSelfUpdate('1.3.0', {
      packageRoot: fixture.root, globalPackageRoot: fixture.root, installRunner, logger
    })).rejects.toThrow(/wiederhergestellt/);
    expect(update.workspaceDigest(fixture.home)).toBe(before);
  });

  test('refuses to self-update a local checkout', async () => {
    const installRunner = jest.fn();
    await expect(update.performSelfUpdate('1.3.0', {
      packageRoot: fixture.root, globalPackageRoot: path.join(fixture.root, 'global'), installRunner, logger
    })).rejects.toThrow(/globale npm-Installation/);
    expect(installRunner).not.toHaveBeenCalled();
  });

  test('detects an installer that reports success without installing the requested version', async () => {
    await expect(update.performSelfUpdate('1.3.0', {
      packageRoot: fixture.root, globalPackageRoot: fixture.root, installRunner: async () => 0, logger
    })).rejects.toThrow(/Version 1.2.9 statt 1.3.0/);
  });

  test('honors a declined update without invoking the installer', async () => {
    const installRunner = jest.fn();
    await expect(update.runUpdateCommand({}, {
      packageRoot: fixture.root, globalPackageRoot: fixture.root, latestVersion: '1.3.0',
      confirmUpdate: async () => false, installRunner, logger
    })).resolves.toBe(0);
    expect(installRunner).not.toHaveBeenCalled();
  });

  test('skips startup checks when disabled or running non-interactively', async () => {
    await expect(update.offerUpdateBeforeStart({ noUpdateCheck: true })).resolves.toEqual({ checked: false });
    await expect(update.offerUpdateBeforeStart({}, {
      packageRoot: fixture.root, stdin: { isTTY: false }, stdout: { isTTY: false }
    })).resolves.toEqual({ checked: false });
  });
});
