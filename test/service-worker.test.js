'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const origin = 'http://localhost:8787';

function createWorker(active = false) {
  const handlers = new Map();
  const cache = {
    addAll: jest.fn().mockResolvedValue(undefined),
    put: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(true),
    match: jest.fn().mockResolvedValue(undefined)
  };
  const caches = {
    open: jest.fn().mockResolvedValue(cache), keys: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(true), match: jest.fn().mockResolvedValue(undefined)
  };
  const self = {
    location: { origin }, registration: { active },
    addEventListener: (type, handler) => handlers.set(type, handler),
    skipWaiting: jest.fn().mockResolvedValue(undefined),
    clients: { claim: jest.fn().mockResolvedValue(undefined), matchAll: jest.fn().mockResolvedValue([]) }
  };
  const fetch = jest.fn().mockImplementation(async () => new Response('network response'));
  const context = vm.createContext({
    self, caches, fetch, URL, Response,
    Request: class BrowserRequest extends Request {
      constructor(url, options) { super(new URL(url, origin), options); }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'sw.js'), 'utf8'), context, { filename: path.join(projectRoot, 'sw.js') });

  function dispatch(type, extra = {}) {
    const event = { waitUntil: jest.fn(), respondWith: jest.fn(), ...extra };
    handlers.get(type)(event);
    return { event, done: event.waitUntil.mock.calls[0]?.[0], response: event.respondWith.mock.calls[0]?.[0] };
  }

  return {
    cache, caches, self, fetch, dispatch,
    request(route, options = {}) {
      return dispatch('fetch', { request: { url: new URL(route, origin).href, method: 'GET', mode: 'cors', ...options } });
    }
  };
}

describe('PWA assets and service worker behavior', () => {
  test('passes the project PWA validator against real manifests and icon files', () => {
    const result = spawnSync(process.execPath, ['scripts/validate-pwa.js'], { cwd: projectRoot, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PWA validation passed.');
  });

  test('caches only existing shell assets and activates on the first installation', async () => {
    const worker = createWorker();
    await worker.dispatch('install').done;
    const requests = worker.cache.addAll.mock.calls[0][0];
    expect(requests.length).toBeGreaterThan(10);
    for (const request of requests) {
      const pathname = new URL(request.url).pathname;
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      expect({ file, exists: fs.existsSync(path.join(projectRoot, file)) }).toEqual({ file, exists: true });
      expect(request.cache).toBe('reload');
    }
    expect(worker.self.skipWaiting).toHaveBeenCalledTimes(1);
  });

  test('waits for an explicit update when an active worker already exists', async () => {
    const worker = createWorker(true);
    await worker.dispatch('install').done;
    expect(worker.cache.addAll).not.toHaveBeenCalled();
    expect(worker.self.skipWaiting).not.toHaveBeenCalled();
  });

  test.each([true, false])('downloads a requested update with client-handled reload=%s', async handledByClient => {
    const worker = createWorker(true);
    await worker.dispatch('message', { data: { type: 'DOWNLOAD_UPDATE', reloadHandledByClient: handledByClient } }).done;
    expect(worker.cache.addAll).toHaveBeenCalledTimes(1);
    expect(worker.self.skipWaiting).toHaveBeenCalledTimes(1);
    if (handledByClient) expect(worker.cache.delete).toHaveBeenCalledWith('./__codex_ide_update_reload__');
    else expect(worker.cache.put).toHaveBeenCalledWith('./__codex_ide_update_reload__', expect.any(Response));
  });

  test('deletes old shell caches and claims clients without forcing a reload', async () => {
    const worker = createWorker();
    await worker.dispatch('install').done;
    const current = worker.caches.open.mock.calls[0][0];
    worker.caches.keys.mockResolvedValue([current, 'codex-ide-old']);
    await worker.dispatch('activate').done;
    expect(worker.caches.delete.mock.calls).toEqual([['codex-ide-old']]);
    expect(worker.self.clients.claim).toHaveBeenCalledTimes(1);
    expect(worker.self.clients.matchAll).not.toHaveBeenCalled();
  });

  test.each(['/health', '/gateway/status', '/codex/status', '/codex/usage', '/v1/models', '/v1/chat/completions', '/codex-ide/ide-files', '/codex-ide/preview/page.html'])
    ('always fetches a fresh gateway response for %s', async route => {
      const worker = createWorker();
      const result = await worker.request(route).response;
      expect(await result.text()).toBe('network response');
      expect(worker.fetch).toHaveBeenCalledTimes(1);
      expect(worker.caches.match).not.toHaveBeenCalled();
      expect(worker.cache.put).not.toHaveBeenCalled();
    });

  test('does not substitute cached API data when the gateway is offline', async () => {
    const worker = createWorker();
    worker.fetch.mockRejectedValue(new Error('offline'));
    const result = await worker.request('/codex-ide/workspace').response;
    expect(result.type).toBe('error');
    expect(worker.caches.match).not.toHaveBeenCalled();
  });

  test('serves a cached static asset without a network request', async () => {
    const worker = createWorker();
    const cached = new Response('cached css');
    worker.caches.match.mockResolvedValue(cached);
    expect(await worker.request('/codex_ide/codex-ide.css').response).toBe(cached);
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  test('uses the cached shell when an offline navigation has no exact cached response', async () => {
    const worker = createWorker();
    const shell = new Response('<title>Offline IDE</title>');
    worker.fetch.mockRejectedValue(new Error('offline'));
    worker.caches.match.mockImplementation(async key => key === 'index.html' ? shell : undefined);
    expect(await worker.request('/project', { mode: 'navigate' }).response).toBe(shell);
  });

  test('does not intercept writes or cache cross-origin responses', async () => {
    const worker = createWorker();
    expect(worker.request('/v1/chat/completions', { method: 'POST' }).event.respondWith).not.toHaveBeenCalled();
    await worker.request('https://external.example.test/asset.js').response;
    expect(worker.fetch).toHaveBeenCalledTimes(1);
    expect(worker.caches.match).not.toHaveBeenCalled();
    expect(worker.cache.put).not.toHaveBeenCalled();
  });
});
