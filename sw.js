const LEADFLOW_CACHE = 'leadflow-app-shell-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/hero-fallback.js',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon-16.png',
  '/favicon-32.png',
  '/favicon-180.png',
  '/icon-192.png',
  '/icon-512.png',
  '/vendor/supabase-js.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(LEADFLOW_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((key) => {
        if (key !== LEADFLOW_CACHE) return caches.delete(key);
        return Promise.resolve(false);
      })))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isDynamicData = url.pathname.startsWith('/api/') || url.hostname.includes('supabase.co');
  if (isDynamicData) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(LEADFLOW_CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/index.html')))
  );
});
