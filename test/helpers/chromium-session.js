'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { chromium } = require('./chromium-path');
const { availableMemoryBytes, processTreeRssBytes, claimBrowserBenchmarkLock } = require('./benchmark-resources');

// Real time and real requestAnimationFrame, with CDP over inherited pipes. No
// browser package, debugging port, network service or virtual clock is needed.
async function openChromiumSession(html, { timeoutMs = 90000, width = 1600, height = 900, exposeGc = false } = {}) {
  if (!chromium) throw new Error('Install Chromium or set CODEX_IDE_TEST_BROWSER.');
  const resources = { maxRssBytes: 384 * 1024 * 1024, minAvailableBytes: 768 * 1024 * 1024,
    peakRssBytes: 0, minimumAvailableBytes: availableMemoryBytes(), timeoutMs };
  if (resources.minimumAvailableBytes < resources.minAvailableBytes) throw new Error('Not enough free memory for a browser benchmark (need 768 MiB available).');
  const releaseLock = claimBrowserBenchmarkLock();
  let temporary, fixture, child;
  try {
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-ide-soak-'));
    fixture = path.join(temporary, 'editor.html');
    fs.writeFileSync(fixture, html);
    child = spawn(chromium, [
      '--headless', '--no-sandbox', '--no-zygote', '--disable-extensions', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking',
      '--renderer-process-limit=1', '--js-flags=--max-old-space-size=96' + (exposeGc ? ' --expose-gc' : ''),
      '--no-first-run', '--no-default-browser-check', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--enable-precise-memory-info', '--remote-debugging-pipe', `--window-size=${width},${height}`,
      `--user-data-dir=${path.join(temporary, 'profile')}`, 'about:blank'
    ], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  } catch (error) {
    try { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
    finally { releaseLock(); }
    throw error;
  }
  if (child.pid) {
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (_) {}
  }
  let sequence = 0, buffer = '', stderr = '', closed = false, failure = null;
  const pending = new Map();
  function terminate(signal = 'SIGTERM') {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  function rejectPending(error) {
    failure = failure || error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  child.on('error', rejectPending);
  child.on('exit', code => rejectPending(new Error(`Chromium exited (${code}): ${stderr}`)));
  child.stdio[3].on('error', rejectPending);
  child.stdio[4].on('error', rejectPending);
  child.stdio[4].setEncoding('utf8');
  child.stdio[4].on('data', data => {
    buffer += data.toString();
    if (buffer.length > 8 * 1024 * 1024) { abort(new Error('Browser benchmark exceeded its protocol buffer budget.')); return; }
    let end;
    while ((end = buffer.indexOf('\0')) !== -1) {
      let message;
      try { message = JSON.parse(buffer.slice(0, end)); }
      catch (error) { abort(error); return; }
      buffer = buffer.slice(end + 1);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  });
  function send(method, params = {}, sessionId, timeoutMs = 30000) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out: ${stderr}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
  function abort(error) { error.resources = { ...resources }; rejectPending(error); terminate(); }
  const watchdog = setInterval(() => {
    try {
      resources.minimumAvailableBytes = Math.min(resources.minimumAvailableBytes, availableMemoryBytes());
      if (process.platform === 'linux') resources.peakRssBytes = Math.max(resources.peakRssBytes, processTreeRssBytes(child.pid));
      if (resources.peakRssBytes > resources.maxRssBytes) abort(new Error('Browser benchmark exceeded its 384 MiB process-tree RSS budget.'));
      else if (resources.minimumAvailableBytes < resources.minAvailableBytes) abort(new Error('Browser benchmark stopped to keep 768 MiB system memory available.'));
    } catch (error) { abort(error); }
  }, 500);
  const deadline = setTimeout(() => abort(new Error('Browser benchmark exceeded its wall-clock limit.')), timeoutMs);
  const exitHandler = () => terminate('SIGKILL');
  const interrupt = () => { close().finally(() => process.exit(130)); };
  const stop = () => { close().finally(() => process.exit(143)); };
  process.once('exit', exitHandler);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', stop);
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(watchdog); clearTimeout(deadline);
    process.removeListener('exit', exitHandler);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', stop);
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      terminate();
      const killTimer = setTimeout(() => terminate('SIGKILL'), 1000);
      await exited;
      clearTimeout(killTimer);
    }
    // Include renderer/utility processes even if the browser exited first.
    terminate('SIGKILL');
    rejectPending(new Error('Chromium session closed.'));
    try { fs.rmSync(temporary, { recursive: true, force: true }); }
    finally { releaseLock(); }
  }
  try {
    const { targetInfos } = await send('Target.getTargets');
    const page = targetInfos.find(target => target.type === 'page');
    const { targetId } = page || await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url: pathToFileURL(fixture).href }, sessionId);
    async function evaluate(expression, timeoutMs = 30000) {
      const response = await send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true
      }, sessionId, timeoutMs);
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      return response.result.value;
    }
    // Navigation and script evaluation are asynchronous, even for local files.
    await evaluate('new Promise(resolve => { if (document.readyState === "complete") resolve(); else window.addEventListener("load", resolve, { once: true }); })');
    return { evaluate, close, resources, command: (method, params) => send(method, params, sessionId) };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { openChromiumSession, chromium };
