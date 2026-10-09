/* Student check-in — works offline.
 * First login (online, once): the student picks their class and name; the Sheet ties this
 * phone to that student. After that, scanning the trainer's lesson QR works with no internet:
 * the class is checked on the phone, the check-in is stored, and it is sent to the Sheet
 * whenever there is internet — even months later. */
'use strict';

const sdb = new PouchDB('rvnp_student', { auto_compaction: true });
const REASONS = {
  'wrong-class': 'Not your class',
  'device-other-student': 'This phone is registered to another student',
  'student-other-device': 'You are registered on another phone — see your trainer',
  'invalid-code': 'Code not valid (expired, or not from your trainer)',
  'unknown-student': 'You are not on the class list any more — see your trainer',
};
const st = { deviceId: '', sheetsUrl: '', profile: null, pendingLesson: null, syncing: false, storage: 'unknown' };

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const lowerEq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowISO = () => new Date().toISOString();
const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage full or blocked */ } },
};

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3000);
}

async function getLocal(id) {
  try { return await sdb.get('_local/' + id); } catch (e) { if (e.status === 404) return { _id: '_local/' + id }; throw e; }
}
async function updateLocal(id, fn) {
  for (let i = 0; i < 6; i++) {
    const doc = await getLocal(id); fn(doc);
    try { const r = await sdb.put(doc); doc._rev = r.rev; return doc; } catch (e) { if (e.status !== 409) throw e; }
  }
  throw new Error('Could not save ' + id);
}
async function saveProfile(p) {
  st.profile = p;
  await updateLocal('profile', (d) => {
    for (const k of Object.keys(d)) if (k !== '_id' && k !== '_rev') delete d[k];
    Object.assign(d, p || {});
  });
  ls.set('rvnp_profile', JSON.stringify(p || null)); // second copy, used if the database is ever lost
}
async function saveSheetsUrl(url) {
  if (!url || url === st.sheetsUrl) return;
  st.sheetsUrl = url;
  await updateLocal('settings', (d) => { d.sheetsUrl = url; });
  ls.set('rvnp_sheets_url', url);
}

function decodeB64(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(s + '='.repeat((4 - (s.length % 4)) % 4)))));
}
function parseLesson(text) {
  const m = /#l=([A-Za-z0-9_-]+)/.exec(String(text || ''));
  if (!m) return null;
  try { return decodeB64(m[1]); } catch { return null; }
}

async function checkins() {
  const r = await sdb.allDocs({ include_docs: true, startkey: 'checkin:', endkey: 'checkin:￰' });
  return r.rows.map((x) => x.doc);
}

/* A second copy of unsent check-ins, restored automatically if the database is ever lost. */
async function mirrorUnsent() {
  const unsent = (await checkins()).filter((d) => d.status === 'saved' || d.status === 'pending')
    .map(({ _rev, ...d }) => d);
  ls.set('rvnp_unsent', JSON.stringify(unsent));
}
async function restoreUnsent() {
  let list = [];
  try { list = JSON.parse(ls.get('rvnp_unsent') || '[]'); } catch { list = []; }
  let restored = 0;
  for (const d of list) {
    try { await sdb.get(d._id); } catch (e) { if (e.status === 404) { await sdb.put(d); restored++; } }
  }
  return restored;
}

async function api(method, params, body) {
  if (!st.sheetsUrl) throw new Error('The app is not connected to the attendance Sheet yet — open the student link from your trainer');
  const url = new URL(st.sheetsUrl);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), method === 'GET' ? { redirect: 'follow' }
    : { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  return res.json();
}

function showResult(kind, title, text, sub = '') {
  const box = $('#result');
  box.hidden = false;
  box.className = 'card result ' + kind;
  $('#resultIcon').innerHTML = `<svg aria-hidden="true"><use href="#i-${kind === 'ok' ? 'ok' : 'no'}"/></svg>`;
  $('#resultTitle').textContent = title;
  $('#resultText').textContent = text;
  $('#resultSub').textContent = sub;
  navigator.vibrate?.(kind === 'ok' ? 120 : [80, 60, 80]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- first login: class and name dropdowns (online, once) ---------- */
async function openSetup(message = '') {
  $('#setupCard').hidden = false;
  const msg = $('#setupMsg');
  const form = $('#setupForm');
  if (!st.sheetsUrl) { msg.textContent = 'Open the student app link your trainer shared (it connects this app to your class lists).'; form.hidden = true; return; }
  if (!navigator.onLine) { msg.textContent = 'Connect to the internet once to set up this phone. After that, scanning works offline.'; form.hidden = true; return; }
  form.hidden = false;
  msg.textContent = message;
  const sel = $('#setupClass');
  sel.innerHTML = '<option value="">Loading classes…</option>';
  try {
    const res = await api('GET', { action: 'classes' });
    if (!res.ok) throw new Error(res.error || 'Could not load classes');
    sel.innerHTML = '<option value="">Choose your class</option>'
      + res.classes.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} — ${esc(c.name)}</option>`).join('');
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load classes</option>';
    msg.textContent = e.message;
  }
  $('#setupName').innerHTML = '<option value="">Choose your class first</option>';
  $('#setupName').disabled = true;
  $('#setupSave').disabled = true;
}

async function loadNames() {
  const cls = $('#setupClass').value;
  const sel = $('#setupName');
  $('#setupSave').disabled = true;
  if (!cls) { sel.innerHTML = '<option value="">Choose your class first</option>'; sel.disabled = true; return; }
  sel.innerHTML = '<option value="">Loading names…</option>'; sel.disabled = true;
  try {
    const res = await api('GET', { action: 'classlist', class: cls });
    if (!res.ok) throw new Error(res.error || 'Could not load names');
    sel.innerHTML = '<option value="">Choose your name</option>'
      + res.trainees.map((t) => `<option value="${esc(t.admNo)}">${esc(t.name)} (${esc(t.admNo)})</option>`).join('');
    sel.disabled = false;
  } catch (e) {
    sel.innerHTML = '<option value="">Could not load names</option>';
    $('#setupMsg').textContent = e.message;
  }
}

async function register() {
  const classCode = $('#setupClass').value, admNo = $('#setupName').value;
  if (!classCode || !admNo) return;
  const label = $('#setupName').selectedOptions[0]?.textContent || admNo;
  if (!confirm(`Register this phone to ${label}?\n\nThis phone will only ever check in this student.`)) return;
  $('#setupSave').disabled = true;
  try {
    const res = await api('POST', null, { action: 'register', admNo, classCode, deviceId: st.deviceId });
    if (!res.ok) throw new Error(res.error || 'Registration failed');
    await saveProfile({ admNo: res.admNo, name: res.name, classCode: res.classCode, className: res.className, registeredAt: nowISO() });
    $('#setupCard').hidden = true;
    showResult('ok', 'Phone registered', `${res.name} — ${res.classCode}`, 'You can now scan your trainer\'s lesson QR, even without internet.');
    const l = st.pendingLesson;
    st.pendingLesson = null;
    if (l) await handleLesson(l);
    await render();
  } catch (e) {
    $('#setupMsg').textContent = e.message;
    $('#setupSave').disabled = false;
  }
}

/* ---------- recording a check-in (offline) ---------- */
async function handleLesson(l) {
  if (!l || !l.s || !l.c || l.w === undefined || !l.t) { showResult('err', 'Not a lesson code', 'Scan the QR on your trainer\'s screen.'); return; }
  if (l.u) await saveSheetsUrl(l.u);
  const p = st.profile;
  if (!p) {
    st.pendingLesson = l; // recorded automatically as soon as setup is done
    showResult('err', 'Set up this phone first', 'Choose your class and name below. Your scan is kept and recorded right after.');
    await openSetup();
    return;
  }
  if (l.c !== p.classCode) {
    showResult('err', 'Not your class', `This code is for ${l.c}. You are registered in ${p.classCode}.`);
    return;
  }
  const id = 'checkin:' + l.s;
  try {
    const existing = await sdb.get(id);
    showResult('ok', 'Already recorded', `${l.un || ''} · ${l.p || ''}`, `Recorded ${fmtTime(existing.scannedAt)}`);
    return;
  } catch (e) { if (e.status !== 404) throw e; }
  const doc = {
    _id: id, type: 'checkin', sessionId: l.s, classCode: l.c, unitName: l.un || '', period: l.p || '', trainer: l.n || '',
    date: String(l.s).split(':')[1] || '', w: l.w, token: l.t, admNo: p.admNo, deviceId: st.deviceId,
    scannedAt: nowISO(), status: 'saved', reason: '',
  };
  await sdb.put(doc);
  st.retries = 0;
  st.lastScan = id;
  await mirrorUnsent();
  showResult('ok', 'Attendance recorded', `${doc.unitName} · ${doc.period}${doc.trainer ? ' · ' + doc.trainer : ''}`,
    navigator.onLine ? 'Sending…' : 'Saved safely on this phone — it is sent automatically when you next have internet.');
  await render();
  sync();
}

async function handleScanned(text) {
  const l = parseLesson(text);
  if (!l) { toast('That is not a lesson QR', 'err'); return; }
  await handleLesson(l);
}

/* ---------- sending to the Sheet ---------- */
async function sync({ manual = false } = {}) {
  if (!st.profile || !st.sheetsUrl || st.syncing) return;
  if (!navigator.onLine) { if (manual) toast('No internet — your check-ins are safe on this phone'); return; }
  const docs = (await checkins()).filter((d) => d.status === 'saved' || d.status === 'pending');
  if (!docs.length) { if (manual) toast('Nothing waiting to send', 'ok'); return; }
  st.syncing = true;
  $('#syncBtn').classList.add('syncing');
  try {
    for (let i = 0; i < docs.length; i += 100) {
      const part = docs.slice(i, i + 100);
      const res = await api('POST', null, { action: 'checkin', checkins: part.map((d) => ({ sessionId: d.sessionId, classCode: d.classCode, admNo: d.admNo, deviceId: d.deviceId, w: d.w, token: d.token, scannedAt: d.scannedAt })) });
      if (!res.ok) throw new Error(res.error || 'The Sheet did not accept the check-ins');
      const byId = new Map((res.results || []).map((r) => [String(r.id).toLowerCase(), r]));
      for (const d of part) {
        const r = byId.get(`${d.sessionId}|${d.admNo}|${d.deviceId}`.toLowerCase());
        if (!r) continue;
        Object.assign(d, { status: r.status, reason: r.reason || '', checkedAt: nowISO() });
        await sdb.put(d);
        // The MIS Officer may have moved this student to another stream: follow the official list.
        if (r.classCode && st.profile && lowerEq(r.admNo || d.admNo, st.profile.admNo) && r.classCode !== st.profile.classCode) {
          await saveProfile({ ...st.profile, classCode: r.classCode, className: r.classCode });
        }
      }
    }
    await updateLocal('settings', (d) => { d.lastSync = nowISO(); });
    if (manual) toast('Check-ins sent', 'ok');
  } catch (e) {
    if (manual) toast('Could not send: ' + e.message, 'err');
  } finally {
    st.syncing = false;
    $('#syncBtn').classList.remove('syncing');
    await mirrorUnsent();
    render();
  }
  // While a check-in waits for the trainer's phone, ask again within seconds instead of a minute.
  const waiting = (await checkins()).some((d) => d.status === 'pending' || d.status === 'saved');
  clearTimeout(st.retryTimer);
  if (waiting && navigator.onLine && (st.retries = (st.retries || 0) + 1) <= 20) st.retryTimer = setTimeout(() => sync(), 8000);
  else if (!waiting) st.retries = 0;
}

/* ---------- camera ---------- */
let stream = null, scanning = false;
async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('This browser cannot use the camera — use your camera app instead', 'err'); return; }
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
  catch (e) { toast('Camera not available: ' + e.message, 'err'); return; }
  const video = $('#scanVideo');
  video.srcObject = stream;
  $('#scanDialog').showModal();
  await video.play().catch(() => {});
  scanning = true;
  let detector = null;
  try { if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = async () => {
    if (!scanning) return;
    let code = null;
    try {
      if (video.readyState >= 2) {
        if (detector) code = (await detector.detect(video))[0]?.rawValue || null;
        else if (window.jsQR) {
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
        }
      }
    } catch { /* keep trying */ }
    if (code && parseLesson(code)) { stopScan(); await handleScanned(code); return; }
    setTimeout(tick, detector ? 120 : 200);
  };
  tick();
}
function stopScan() {
  scanning = false;
  stream?.getTracks().forEach((t) => t.stop()); stream = null;
  if ($('#scanDialog').open) $('#scanDialog').close();
}

/* ---------- screen ---------- */
async function render() {
  const p = st.profile;
  $('#who').textContent = p ? `${p.name} · ${p.classCode}` : 'Not set up';
  $('#profileCard').hidden = !p;
  $('#resetSetup').hidden = !p;
  if (p) {
    $('#pName').textContent = p.name;
    $('#pMeta').textContent = `${p.admNo} · ${p.className || p.classCode}`;
  }
  const list = (await checkins()).sort((a, b) => String(b.scannedAt).localeCompare(String(a.scannedAt)));
  $('#historyCard').hidden = !list.length;
  $('#history').innerHTML = list.map((d) => {
    const label = d.status === 'accepted' ? ['synced', 'Confirmed']
      : d.status === 'pending' ? ['pending', 'Sent — waiting for trainer to sync']
      : d.status === 'rejected' ? ['rejected', REASONS[d.reason] || 'Not accepted']
      : ['pending', 'Saved on phone'];
    return `<li><div><b>${esc(d.unitName || d.classCode)}</b><span class="muted small">${esc(fmtDate(d.date))} · ${esc(d.period)} · ${esc(fmtTime(d.scannedAt))}</span>
</div>
      <span class="pill ${label[0]}">${esc(label[1])}</span></li>`;
  }).join('');
  // Keep the "Attendance recorded" card in step with what happened to that scan.
  const last = st.lastScan && !$('#result').hidden && list.find((d) => d._id === st.lastScan);
  if (last) {
    $('#resultSub').textContent = last.status === 'accepted' ? 'Confirmed in your trainer\'s register.'
      : last.status === 'pending' ? 'Sent. It is confirmed once your trainer\'s phone syncs.'
      : last.status === 'rejected' ? (REASONS[last.reason] || 'Not accepted')
      : navigator.onLine ? 'Sending…' : 'Saved safely on this phone. It is sent automatically when you next have internet.';
  }
  const unsent = list.filter((d) => d.status === 'saved');
  const el = $('#pendingCount'); el.textContent = unsent.length; el.classList.toggle('zero', unsent.length === 0);

  // Warn when check-ins have been waiting a long time, so they are sent before anything can happen to the phone.
  const oldest = unsent.reduce((m, d) => (!m || d.scannedAt < m ? d.scannedAt : m), '');
  const days = oldest ? Math.floor((Date.now() - new Date(oldest).getTime()) / 864e5) : 0;
  const warn = $('#warning');
  if (days >= 3) {
    warn.hidden = false;
    warn.textContent = `${unsent.length} check-in(s) not sent for ${days} days. They are safe on this phone — connect to the internet and tap Send.`;
  } else if (st.storage === 'not-protected' && list.length) {
    warn.hidden = false;
    warn.textContent = 'Add this app to your home screen (browser menu → Add to Home screen) so your phone keeps your check-ins safely.';
  } else warn.hidden = true;

  $('#deviceInfo').textContent = `Phone ID ${st.deviceId}` + (st.storage === 'protected' ? ' · storage protected ✓' : '');
}

function updateNet() {
  const on = navigator.onLine;
  const b = $('#netBadge'); b.textContent = on ? 'Online' : 'Offline'; b.className = 'badge ' + (on ? 'online' : 'offline');
}

async function consumeHash() {
  const h = location.hash;
  if (!h) return;
  history.replaceState(null, '', location.pathname + location.search); // a reload must not record twice
  const u = /#u=([^&]+)/.exec(h);
  if (u) { await saveSheetsUrl(decodeURIComponent(u[1])); if (!st.profile) await openSetup(); return; }
  await handleScanned(h);
}

async function protectStorage() {
  if (!navigator.storage?.persist) { st.storage = 'unknown'; return; }
  try {
    let ok = await navigator.storage.persisted();
    if (!ok) ok = await navigator.storage.persist();
    st.storage = ok ? 'protected' : 'not-protected';
  } catch { st.storage = 'unknown'; }
}

async function init() {
  // Phone ID: kept in the database and in a second place, so it survives if one is lost.
  const dev = await updateLocal('device', (d) => { if (!d.deviceId) d.deviceId = ls.get('rvnp_device_id') || 'stu-' + uuid().replace(/-/g, '').slice(0, 12); });
  st.deviceId = dev.deviceId;
  ls.set('rvnp_device_id', st.deviceId);
  const prof = await getLocal('profile');
  if (prof.admNo) { const { _id, _rev, ...p } = prof; st.profile = p; }
  else {
    try { const copy = JSON.parse(ls.get('rvnp_profile') || 'null'); if (copy?.admNo) await saveProfile(copy); } catch { /* none */ }
  }
  const settings = await getLocal('settings');
  st.sheetsUrl = settings.sheetsUrl || ls.get('rvnp_sheets_url') || window.ATTENDANCE_CONFIG?.sheetsUrl || '';
  const restored = await restoreUnsent();
  if (restored) toast(`Recovered ${restored} unsent check-in(s)`, 'ok');
  updateNet();

  $('#setupClass').addEventListener('change', loadNames);
  $('#setupName').addEventListener('change', () => { $('#setupSave').disabled = !$('#setupName').value; });
  $('#setupSave').addEventListener('click', register);
  $('#resetSetup').addEventListener('click', () => openSetup('Choose your class and name again. If this phone is already registered to someone else, your trainer must reset it first.'));
  $('#scanBtn').addEventListener('click', startScan);
  $('#stopScan').addEventListener('click', stopScan);
  $('#scanDialog').addEventListener('close', stopScan);
  $('#syncBtn').addEventListener('click', () => sync({ manual: true }));
  window.addEventListener('hashchange', consumeHash);
  window.addEventListener('online', () => { updateNet(); if (!st.profile && !$('#setupCard').hidden) openSetup(); sync(); });
  window.addEventListener('offline', updateNet);
  // Automatic sending: on every scan, when the internet comes back, when the app is opened, and every minute.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  setInterval(() => sync(), 60 * 1000);

  await protectStorage();
  await consumeHash();
  if (!st.profile && $('#setupCard').hidden) await openSetup();
  await render();
  sync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !scanning) location.reload(); });
  }
}

init().catch((e) => { console.error(e); toast('Start-up error: ' + e.message, 'err'); });
