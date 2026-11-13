'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { processTreeRssBytes, claimBrowserBenchmarkLock } = require('./helpers/benchmark-resources');

describe('browser benchmark resource protection', () => {
  let temporary;
  beforeEach(() => { temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ide-resource-test-')); });
  afterEach(() => fs.rmSync(temporary, { recursive: true, force: true }));

  test('counts renderer and utility descendants, tolerating a child exiting during sampling', () => {
    function process(pid, kib, children) {
      const directory = path.join(temporary, String(pid));
      fs.mkdirSync(path.join(directory, 'task', String(pid)), { recursive: true });
      fs.writeFileSync(path.join(directory, 'status'), 'VmRSS:\t' + kib + ' kB\n');
      fs.writeFileSync(path.join(directory, 'task', String(pid), 'children'), children);
    }
    process(10, 100, '20 30 99');
    process(20, 200, '40');
    process(30, 300, '');
    process(40, 400, '');
    expect(processTreeRssBytes(10, temporary)).toBe(1000 * 1024);
  });

  test('rejects concurrent benchmarks and releases only its own lock', () => {
    const release = claimBrowserBenchmarkLock(temporary);
    expect(() => claimBrowserBenchmarkLock(temporary)).toThrow(/running/);
    release();
    const nextRelease = claimBrowserBenchmarkLock(temporary);
    nextRelease();
    expect(fs.readdirSync(temporary)).toEqual([]);
  });

  test('recovers a lock from a terminated owner', () => {
    const release = claimBrowserBenchmarkLock(temporary);
    const lock = path.join(temporary, fs.readdirSync(temporary)[0]);
    release();
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
    const recoveredRelease = claimBrowserBenchmarkLock(temporary);
    recoveredRelease();
    expect(fs.readdirSync(temporary)).toEqual([]);
  });
});
