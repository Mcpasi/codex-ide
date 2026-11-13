'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

function availableMemoryBytes() {
  if (process.platform !== 'linux') return os.freemem();
  const memory = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);
  if (!memory) throw new Error('Cannot monitor available system memory.');
  return Number(memory[1]) * 1024;
}

function processTreeRssBytes(pid, procRoot = '/proc') {
  const visited = new Set();
  function visit(current) {
    if (visited.has(current)) return 0;
    visited.add(current);
    try {
      const status = fs.readFileSync(path.join(procRoot, String(current), 'status'), 'utf8');
      const rss = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
      const children = fs.readFileSync(path.join(procRoot, String(current), 'task', String(current), 'children'), 'utf8').trim();
      return (rss ? Number(rss[1]) * 1024 : 0) + (children ? children.split(/\s+/).reduce((sum, child) => sum + visit(child), 0) : 0);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return 0;
      throw error;
    }
  }
  return visit(pid);
}

function claimBrowserBenchmarkLock(directory = os.tmpdir()) {
  const lock = path.join(directory, 'codex-ide-browser-benchmark-' + (process.getuid ? process.getuid() : os.userInfo().username) + '.lock');
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  function create() { fs.writeFileSync(lock, owner, { flag: 'wx', mode: 0o600 }); }
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = fs.readFileSync(lock, 'utf8');
    let pid;
    try { pid = JSON.parse(previous).pid; } catch (_) {}
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid benchmark lock: ' + lock);
    try { process.kill(pid, 0); }
    catch (probeError) {
      if (probeError.code !== 'ESRCH') throw new Error('Another browser benchmark owns ' + lock);
      if (fs.readFileSync(lock, 'utf8') !== previous) throw new Error('Another browser benchmark acquired ' + lock);
      fs.unlinkSync(lock);
      create();
      pid = null;
    }
    if (pid) throw new Error('Another browser benchmark is running (PID ' + pid + '). Run benchmarks serially.');
  }
  return () => {
    try { if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

module.exports = { availableMemoryBytes, processTreeRssBytes, claimBrowserBenchmarkLock };
