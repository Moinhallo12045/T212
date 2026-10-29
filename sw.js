const CACHE_NAME = 't212-radar-v12';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './favicon.ico',
  './apple-touch-icon.png',
  './icon-32.png',
  './icon-64.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './icon-maskable-192.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API- und Drittanbieter-Requests niemals im Service Worker cachen
  if (url.origin !== self.location.origin || event.request.method !== 'GET') {
    return;
  }

  // Network-first mit cache: 'no-cache' verhindert veraltete Ghost-Caches auf iOS/iPadOS
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' })
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
