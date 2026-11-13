'use strict';

const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

jest.mock('child_process', () => ({ spawn: jest.fn(), spawnSync: jest.fn() }));
jest.mock('./helpers/chromium-path', () => ({ chromium: '/fake/chromium' }));
jest.mock('./helpers/benchmark-resources', () => ({
  availableMemoryBytes: jest.fn(), processTreeRssBytes: jest.fn(), claimBrowserBenchmarkLock: jest.fn()
}));

const { spawn, spawnSync } = require('child_process');
const resources = require('./helpers/benchmark-resources');
const { openChromiumSession } = require('./helpers/chromium-session');

describe('bounded Chromium benchmark lifecycle without launching a browser', () => {
  let child, kill, release;
  beforeEach(() => {
    jest.useFakeTimers();
    release = jest.fn();
    resources.claimBrowserBenchmarkLock.mockReturnValue(release);
    resources.availableMemoryBytes.mockReturnValue(2 * 1024 ** 3);
    resources.processTreeRssBytes.mockReturnValue(100 * 1024 ** 2);
    spawn.mockImplementation(() => {
      child = Object.assign(new EventEmitter(), { pid: 2147483647, exitCode: null, signalCode: null, stderr: new PassThrough() });
      child.stdio = [null, null, child.stderr, new Writable({
        write(chunk, _encoding, done) {
          const request = JSON.parse(chunk.toString().slice(0, -1));
          if (request.params.expression !== 'stall') {
            const result = request.method === 'Target.getTargets' ? { targetInfos: [{ targetId: 'page', type: 'page' }] }
              : request.method === 'Target.attachToTarget' ? { sessionId: 'session' }
              : request.method === 'Runtime.evaluate' ? { result: { value: null } } : {};
            Promise.resolve().then(() => child.stdio[4].write(JSON.stringify({ id: request.id, result }) + '\0'));
          }
          done();
        }
      }), new PassThrough()];
      return child;
    });
    kill = jest.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      child.signalCode = signal;
      Promise.resolve().then(() => child.emit('exit', null, signal));
      return true;
    });
    spawnSync.mockImplementation(() => {
      child.signalCode = 'SIGKILL';
      Promise.resolve().then(() => child.emit('exit', null, 'SIGKILL'));
      return { status: 0 };
    });
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

  test('refuses to start when system memory is already low', async () => {
    resources.availableMemoryBytes.mockReturnValue(512 * 1024 ** 2);
    await expect(openChromiumSession('<html></html>')).rejects.toThrow(/768 MiB/);
    expect(spawn).not.toHaveBeenCalled();
  });

  test.each([...(process.platform === 'linux' ? ['browser RSS'] : []), 'available memory', 'deadline'])('kills the complete process group and releases resources after exceeding %s', async reason => {
    const browser = await openChromiumSession('<html></html>', { timeoutMs: reason === 'deadline' ? 100 : 90000 });
    const result = browser.evaluate('stall').catch(error => error);
    if (reason === 'browser RSS') resources.processTreeRssBytes.mockReturnValue(385 * 1024 ** 2);
    if (reason === 'available memory') resources.availableMemoryBytes.mockReturnValue(512 * 1024 ** 2);
    await jest.advanceTimersByTimeAsync(500);
    expect((await result).message).toMatch(/384 MiB|768 MiB|wall-clock/);
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    await browser.close();
    if (process.platform !== 'win32') expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    else expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', String(child.pid), '/T', '/F'], expect.any(Object));
    expect(release).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('closes a healthy session once and removes its signal handlers and timers', async () => {
    const before = ['SIGINT', 'SIGTERM', 'exit'].map(signal => process.listenerCount(signal));
    const browser = await openChromiumSession('<html></html>');
    await browser.close();
    await browser.close();
    expect(release).toHaveBeenCalledTimes(1);
    expect(['SIGINT', 'SIGTERM', 'exit'].map(signal => process.listenerCount(signal))).toEqual(before);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('releases the exclusive lock when process creation fails', async () => {
    spawn.mockImplementationOnce(() => { throw new Error('Process limit reached'); });
    await expect(openChromiumSession('<html></html>')).rejects.toThrow('Process limit reached');
    expect(release).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
