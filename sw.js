const CACHE_NAME = 'cad-map-overlay-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './css/style.css',
  './js/main.js',
  './js/mapView.js',
  './js/cadView.js',
  './js/dxfParser.js',
  './js/coordTransform.js',
  './js/sampleCad.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Do NOT intercept external map tile servers (let browser fetch tiles directly in parallel)
  if (
    url.hostname.includes('vworld.kr') ||
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('openstreetmap.org')
  ) {
    return;
  }

  // Stale-While-Revalidate for same-origin app files & CDN scripts:
  // Serve immediately from cache if available, update cache in background
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
