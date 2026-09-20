// Service worker: caches the app shell (HTML/CSS/JS) so the UI itself loads
// even with no connection. It deliberately does NOT cache /api/* responses —
// that's handled at the app layer (see public/js/api.js + idb.js) so there's
// a single source of truth for "last known data" instead of two caches
// disagreeing with each other.
//
// IMPORTANT: this uses a NETWORK-FIRST strategy for the shell files, not
// cache-first. A cache-first strategy would silently keep serving an old,
// possibly-buggy copy of app.js/api.js forever after an update — the browser
// would never even ask the server for the new version. Network-first means
// every load gets the latest code whenever you're online, and only falls
// back to the cached copy if the network request actually fails.
//
// Bump CACHE_NAME whenever this file changes, so any browser that already
// installed an older version of this worker immediately discards its old
// cache instead of continuing to serve stale files from it.
const CACHE_NAME = 'shekhar-shell-v2';
const SHELL_FILES = [
  '/',
  '/css/styles.css',
  '/js/idb.js',
  '/js/offline.js',
  '/js/api.js',
  '/js/app.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never intercept API calls — let api.js handle those (and their offline fallback).
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request)) // offline — fall back to last cached copy
  );
});
