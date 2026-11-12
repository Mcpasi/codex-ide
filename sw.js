// Service Worker fuer die eigenstaendige IDE-App-Shell. Gateway-Routen werden
// nie gecacht, damit Modell-, Datei- und Auth-Status immer aktuell bleiben.
const CACHE_NAME = 'codex-ide-v50';
const UPDATE_RELOAD_URL = './__codex_ide_update_reload__';
const URLS_TO_CACHE = [
  './',
  'index.html',
  'manifest.json',
  'skills/internetSkill.js',
  'skills/internet/manifest.json',
  'skills/extendedFileSkill.js',
  'skills/extended-files/manifest.json',
  'skills/codexIdeTutorSkill.js',
  'skills/codex-ide-tutor/manifest.json',
  'skillSystem.js?v=50',
  'agentResponse.js?v=50',
  'backendProfile.js?v=50',
  'Safetyfilter.js?v=50',
  'localModel.js?v=50',
  'translations/de.js?v=50',
  'translations/en.js?v=50',
  'translations/fr.js?v=50',
  'codex_ide/codex-ide.css?v=50',
  'codex_ide/settings.js?v=50',
  'codex_ide/syntax-highlighter.js?v=50',
  'codex_ide/editor-diff.js?v=50',
  'codex_ide/codex-ide.js?v=50',
  'codex_ide_icon_192.png',
  'codex_ide_icon_512.png',
  'codex-ide.svg'
];

function cacheFreshShell() {
  const requests = URLS_TO_CACHE.map(url => new Request(url, { cache: 'reload' }));
  return caches.open(CACHE_NAME).then(cache =>
    cache.addAll(requests).then(() => cache)
  );
}

function isGatewayApiPath(pathname) {
  return pathname === '/health' ||
    pathname === '/gateway/status' ||
    pathname === '/codex/status' ||
    pathname.startsWith('/codex/') ||
    pathname.startsWith('/antigravity/') ||
    pathname === '/v1/models' ||
    pathname === '/v1/chat/completions' ||
    pathname.startsWith('/v1/') ||
    pathname.startsWith('/codex-ide/');
}

self.addEventListener('install', event => {
  event.waitUntil(
    self.registration.active
      ? Promise.resolve()
      : cacheFreshShell()
        .then(() => self.skipWaiting())
  );
});

self.addEventListener('message', event => {
  if (!event.data || event.data.type !== 'DOWNLOAD_UPDATE') return;

  event.waitUntil(
    cacheFreshShell()
      .then(cache => event.data.reloadHandledByClient === true
        ? cache.delete(UPDATE_RELOAD_URL)
        : cache.put(UPDATE_RELOAD_URL, new Response('reload')))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  let reloadLegacyClients = false;
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.match(UPDATE_RELOAD_URL).then(marker => {
        reloadLegacyClients = !!marker;
        return marker ? cache.delete(UPDATE_RELOAD_URL) : false;
      }))
      .then(() => caches.keys())
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
      .then(() => reloadLegacyClients
        ? self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => Promise.all(
            clients.map(client => typeof client.navigate === 'function'
              ? client.navigate(client.url)
              : Promise.resolve())
          ))
        : undefined)
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    event.respondWith(fetch(event.request).catch(() => Response.error()));
    return;
  }

  if (isGatewayApiPath(requestUrl.pathname)) {
    event.respondWith(fetch(event.request).catch(() => Response.error()));
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request).then(response => response || caches.match('index.html'))
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => response || fetch(event.request).then(networkResponse => {
        const copy = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        return networkResponse;
      }).catch(() => Response.error()))
  );
});
