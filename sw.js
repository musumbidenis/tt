/* Service worker: keeps the whole app available with no network.
 * Bump CACHE when you change any file so devices pick up the new version. */
const CACHE = 'rvnp-attendance-v4.57.0';
/* What this worker needs in order to answer a notification: the server address, this phone's ID and
 * the student's admission number. The student app writes it here when notifications are switched on,
 * because a service worker woken by a notification cannot read the app's own database. */
const PUSH_CACHE = 'rvnp-push';
const PUSH_KEY = './__push-identity';
/* Sending what is waiting (check-ins and evidence) while the app is closed. Scripts can only be imported while the
 * worker starts, so they load now; nothing runs unless the student app has stored an identity (the staff app never does). */
try { importScripts('./vendor/pouchdb.min.js', './student-outbox.js'); } catch (e) { /* sending only happens when the app is open */ }
// The same for a trainer's unsent registers and marks (staff-outbox.js does nothing without a staff sign-in on this device).
try { self.window = self.window || self; importScripts('./config.js', './staff-outbox.js'); } catch (e) { /* sending only happens when the app is open */ }
const KEEP = [CACHE, PUSH_CACHE, 'rvnp-poe-files'];   // POE files a trainer has opened, kept across updates
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './admin.js',
  './poe-staff.js',
  './poe-trainer.js',
  './verify.js',
  './notices.js',
  './candidates.js',
  './htmlpdf.js',
  './bulk.js',
  './health.js',
  './student-msgs.js',
  './alerts.js',
  './marks.js',
  './templates/marksheet.xlsx',
  './report.js',
  './xlsx.js',
  './tables.js',
  './imports.js',
  './templates/class-register.xlsx',
  './vendor/jszip.min.js',
  './manifest.webmanifest',
  './student.html',
  './student.js',
  './scanner.js',
  './poe-student.js',
  './student-outbox.js',
  './staff-outbox.js',
  './config.js',
  './google.js',
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
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
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
        const page = /\/student(\.html)?$/.test(url.pathname) ? './student.html' : './index.html';
        return (await cache.match(page)) || Response.error();
      }
      return Response.error();
    }
  })());
});

/* ---------------- notifications for students ----------------
 * A push carries no message at all (a "tickle"), so nothing private is ever sent and the server has
 * nothing to encrypt. It only wakes this worker, which asks the server what is new and shows it. */
async function pushIdentity() {
  try {
    const res = await (await caches.open(PUSH_CACHE)).match(PUSH_KEY);
    return res ? await res.json() : null;
  } catch { return null; }
}

/** Plain wording for what came back from the server. Messages (from a trainer or the office) and evidence decisions. */
function noticeText(list) {
  const msgs = list.filter((n) => n.kind === 'message');
  if (msgs.length && msgs.length === list.length) {
    return msgs.length === 1 ? { title: msgs[0].title, body: `${msgs[0].from}: ${msgs[0].body}`.slice(0, 180), url: './student.html#msgs' }
      : { title: `${msgs.length} new messages`, body: msgs.map((m) => m.title).join(' - ').slice(0, 180), url: './student.html#msgs' };
  }
  if (msgs.length) list = list.filter((n) => n.kind !== 'message');
  if (list.length > 1) {
    const yes = list.filter((n) => n.status === 'approved').length, no = list.length - yes;
    return { title: `${list.length} updates on your evidence`,
      body: [yes ? `${yes} approved` : '', no ? `${no} sent back to fix` : ''].filter(Boolean).join(' - ') };
  }
  const n = list[0], what = `${n.unitName} — ${n.item}`;
  if (n.status === 'approved') return { title: 'Your evidence was approved', body: `${what} is approved.${n.decidedName ? ' Checked by ' + n.decidedName + '.' : ''}` };
  return { title: 'Your evidence was sent back', body: n.comment ? `${what}: “${n.comment}”` : `${what} needs a fix — open the app to see why.` };
}

async function showNotices() {
  const id = await pushIdentity();
  let list = null;
  if (id && id.serverUrl && id.admNo && id.deviceId) {
    try {
      const res = await fetch(id.serverUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'notices', deviceId: id.deviceId, admNo: id.admNo }) });
      const out = await res.json();
      if (out && out.ok) list = out.notices || [];
    } catch { /* no network at this moment: a short message is shown instead */ }
  }
  // If the app is open, let it refresh its Evidence list without the student doing anything.
  for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'evidence-changed' });
  if (list && !list.length) return;   // nothing the student has not already seen in the app
  const t = list && list.length ? noticeText(list) : { title: 'Your evidence was looked at', body: 'Open the app to see what your trainer said.' };
  await self.registration.showNotification(t.title, {
    body: t.body, tag: 'rvnp-evidence', renotify: true, lang: 'en',
    icon: './icons/icon-192.png', badge: './icons/icon-192.png',
    data: { url: t.url || './student.html#poe' },
  });
}

/** Sends whatever is waiting, if this is a student phone that has been set up. Safe to run at any time. */
async function runOutbox() {
  try {
    if (typeof Outbox === 'undefined' || typeof PouchDB === 'undefined') return;
    const id = await pushIdentity();
    if (!id || !id.serverUrl || !id.admNo || !id.deviceId) return;
    const db = new PouchDB('rvnp_student', { auto_compaction: true });
    const res = await Outbox.run({ db, serverUrl: id.serverUrl, deviceId: id.deviceId, admNo: id.admNo });
    if (res && (res.checkins || res.evidence)) {
      for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'outbox-done' });
    }
    return !!(res && ((res.failed && !res.needGoogle) || res.offline));
  } catch { /* the app sends it when it is next opened */ }
  return false;
}
// When something could not go yet, the sync event fails on purpose: the browser then tries again later by itself (a few times).
self.addEventListener('sync', (event) => { if (event.tag === 'ark-outbox') event.waitUntil(runOutbox().then((again) => { if (again) throw new Error('retry'); })); });
self.addEventListener('periodicsync', (event) => { if (event.tag === 'ark-outbox') event.waitUntil(runOutbox()); });

/* A trainer's registers and marks: sent when the internet comes back, and now and then, even with the app closed. */
const STAFF_TAG = 'ark-staff-outbox';
const staffOutbox = () => (typeof StaffOutbox === 'undefined' || typeof PouchDB === 'undefined' ? Promise.resolve()
  : StaffOutbox.run({ db: new PouchDB('rvnp_attendance', { auto_compaction: true }) }));
self.addEventListener('sync', (event) => { if (event.tag === STAFF_TAG) event.waitUntil(staffOutbox()); });   // a failure makes the browser try again later
self.addEventListener('periodicsync', (event) => { if (event.tag === STAFF_TAG) event.waitUntil(staffOutbox().catch(() => {})); });
self.addEventListener('push', (event) => { event.waitUntil(Promise.all([showNotices(), runOutbox()])); });

// Tapping the notification opens the student app on Evidence (or brings the open one to the front).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './student.html#poe', self.location.href).href;
  event.waitUntil((async () => {
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) {
      if (c.url.includes('student.html')) { c.postMessage({ type: 'show-evidence' }); await c.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
