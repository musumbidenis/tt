/* Service worker: keeps the whole app available with no network.
 * Bump CACHE when you change any file so devices pick up the new version. */
const CACHE = 'rvnp-attendance-v3.4.0';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './student.html',
  './student.js',
  './config.js',
  './manifest-student.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pouchdb.min.js',
  './vendor/jsQR.js',
  './vendor/qrcode.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first for the app's own files (fast and offline), refreshed in the background.
// Requests to Google Apps Script or CouchDB are never cached — they go straight to the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req)
      .then((res) => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; })
      .catch(() => null);
    if (cached) { event.waitUntil(network); return cached; }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') {
      const page = url.pathname.endsWith('student.html') ? './student.html' : './index.html';
      return (await cache.match(page)) || Response.error();
    }
    return Response.error();
  })());
});
