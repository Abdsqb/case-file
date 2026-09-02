// Bumped for the Halftone Dossier overhaul. Without this, an installed user is
// served the old shell and the stale favicon from cache forever.
const CACHE = 'case-file-v4';
const SHELL = ['/', '/index.html', '/manifest.json', '/favicon.svg', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // task data must always be live — never serve it from cache
  if (url.pathname.startsWith('/api/')) return;

  // network first, falling back to cache so the shell still opens offline
  event.respondWith(
    fetch(request)
      .then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('/index.html')))
  );
});
