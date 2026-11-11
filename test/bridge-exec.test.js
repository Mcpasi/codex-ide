'use strict';

const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { createFixture } = require('./helpers/fixture');

function createChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: jest.fn() };
  child.kill = jest.fn();
  return child;
}

function emitChunks(stream, text, size) {
  const bytes = Buffer.from(text, 'utf8');
  for (let offset = 0; offset < bytes.length; offset += size) {
    stream.emit('data', bytes.subarray(offset, offset + size));
  }
}

describe('CLI output across UTF-8 chunk boundaries', () => {
  let fixture;
  let bridge;
  let child;

  beforeEach(() => {
    fixture = createFixture();
    child = createChild();
    jest.spyOn(childProcess, 'spawn').mockReturnValue(child);
    jest.isolateModules(() => { bridge = require('../scripts/codex-bridge'); });
  });

  afterEach(() => fixture.dispose());

  test.each([1, 2, 3, 4, 7])('preserves a CLI reply in %s-byte chunks', async chunkSize => {
    const result = bridge.runCodexExec({ prompt: 'Hallo', workdir: fixture.home, codexBin: 'test-codex' });
    emitChunks(child.stdout, 'Grüße aus Köln 👋\n', chunkSize);
    child.emit('close', 0);

    await expect(result).resolves.toBe('Grüße aus Köln 👋');
    expect(child.stdin.end).toHaveBeenCalledWith('Hallo');
  });

  test.each([1, 2, 3, 4, 7])('preserves CLI diagnostics in %s-byte chunks', async chunkSize => {
    const result = bridge.runCodexExec({ prompt: 'Prüfen', workdir: fixture.home, codexBin: 'test-codex' });
    emitChunks(child.stdout, 'Grüße 👋', chunkSize);
    emitChunks(child.stderr, 'Prüfung fehlgeschlagen 💥', chunkSize);
    child.emit('close', 1);

    await expect(result).rejects.toThrow('Codex CLI beendet mit Code 1. Prüfung fehlgeschlagen 💥');
  });

  test.each(['stdout', 'stderr'])('preserves split Unicode in login-status %s', async stream => {
    const result = bridge.runCodexLoginStatus({ codexBin: 'test-codex' });
    emitChunks(child[stream], 'Logged in using Grüße 👋', 1);
    child.emit('close', 0);

    await expect(result).resolves.toMatchObject({ loggedIn: true, method: 'Grüße 👋', raw: 'Logged in using Grüße 👋' });
  });
});
