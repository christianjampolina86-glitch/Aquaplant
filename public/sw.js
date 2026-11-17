/**
 * AQUAPLANT service worker.
 *
 * Purpose: make the installed app open fast and show a friendly screen when the
 * phone is briefly offline.
 *
 * Rules that keep the data honest:
 *  - API calls (/api/...) are NEVER cached, so telemetry, login and SMS actions
 *    always go to the server.
 *  - Pages use network-first, so a new deployment is picked up immediately.
 *  - Only static files (icons, built CSS/JS) are cached for offline loading.
 */
const CACHE_NAME = 'aquaplant-shell-v5';
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live data and anything that changes state must always hit the network.
  if (url.pathname.startsWith('/api/')) return;

  // Firmware downloads must never come from an old cache.
  if (url.pathname.startsWith('/firmware/')) return;

  // The service worker file itself is managed by the browser.
  if (url.pathname === '/sw.js') return;

  // Pages: try the network first, fall back to the last cached page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/'))
        )
    );
    return;
  }

  // Static assets: serve from cache instantly, refresh quietly in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
