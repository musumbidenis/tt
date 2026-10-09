/* Service worker: keeps the whole app available with no network.
 * Bump CACHE when you change any file so devices pick up the new version. */
const CACHE = 'rvnp-attendance-v4.2.0';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './admin.js',
  './report.js',
  './xlsx.js',
  './imports.js',
  './templates/class-register.xlsx',
  './vendor/jszip.min.js',
  './manifest.webmanifest',
  './student.html',
  './student.js',
  './config.js',
  './manifest-student.webmanifest',
  './icons/icon.svg',
  './icons/rvnp-logo.png',
  './fonts/lexend.woff2',
  './fonts/source-sans-3.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './vendor/pouchdb.min.js',
  './vendor/jsQR.js',
  './vendor/qrcode.js',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version is never mixed with files from the old one.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache first for the app's own files (fast and offline), refreshed in the background.
// Requests to Google Apps Script are never cached — they go straight to the network.
// The PDF reader (vendor/pdfjs, MIS Officer only) is cached the first time it is used.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The app's files come from this version's cache only, so all of them always match.
  // A new version arrives as a new service worker (bump CACHE), never file by file.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      // Files used only sometimes (the PDF reader for the MIS Officer) are kept after their first use.
      if (res.ok && res.type === 'basic' && url.pathname.includes('/vendor/')) cache.put(req, res.clone());
      return res;
    } catch {
      if (req.mode === 'navigate') {
        const page = url.pathname.endsWith('student.html') ? './student.html' : './index.html';
        return (await cache.match(page)) || Response.error();
      }
      return Response.error();
    }
  })());
});
