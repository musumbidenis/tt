/* Student check-in - works offline.
 * First login (online, once): the student picks their class and name; the server ties this
 * device to that student. After that, scanning the trainer's lesson QR works with no internet:
 * the class is checked on the device, the check-in is stored, and it is sent to the server
 * whenever there is internet - even months later. */
'use strict';

const sdb = new PouchDB('rvnp_student', { auto_compaction: true });
const REASONS = {
  'wrong-class': 'Not your class',
  'device-other-student': 'This device is registered to another student',
  'student-other-device': 'You are registered on another phone or browser. Ask the HOD or MIS Officer to reset it',
  'invalid-code': 'Code not valid (expired, or not from your trainer)',
  'unknown-student': 'You are not on the class list any more - see your trainer',
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

/* ---------- "install the app" banner ----------
 * Students who open this in a browser tab are nudged to install it to the Home Screen, so it opens like an app and
 * works offline. The banner stays until the app is installed (opened in standalone mode). Android/Chrome give a real
 * install prompt (beforeinstallprompt); iPhones have no such event, so we show the Share -> Add to Home Screen steps. */
let deferredInstall = null;
const installedPwa = () => window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
const iOSphone = () => /iP(hone|od|ad)/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
function renderInstallBanner() {
  const el = document.getElementById('installBanner');
  if (!el) return;
  if (installedPwa()) { el.hidden = true; el.innerHTML = ''; return; }
  if (deferredInstall) {
    el.hidden = false;
    el.innerHTML = '<div class="ib-text"><b>Install The ARK</b><span>Add it to your phone so it opens like an app and works offline.</span></div><button type="button" class="btn small primary" id="installBtn">Install</button>';
  } else if (iOSphone()) {
    el.hidden = false;
    el.innerHTML = '<div class="ib-text"><b>Add The ARK to your Home Screen</b><span>Tap the Share button, then <q>Add to Home Screen</q>, and open it from there.</span></div>';
  } else {
    el.hidden = true;   // not installable here yet (no prompt), and not an iPhone: say nothing until the browser offers it
  }
}
// Registered at load because the browser can fire this before the app has finished starting.
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; renderInstallBanner(); });
window.addEventListener('appinstalled', () => { deferredInstall = null; renderInstallBanner(); });
function setupInstallBanner() {
  document.getElementById('installBanner')?.addEventListener('click', async (e) => {
    if (!e.target.closest('#installBtn') || !deferredInstall) return;
    const p = deferredInstall; deferredInstall = null;
    p.prompt();
    try { await p.userChoice; } catch { /* dismissed */ }
    renderInstallBanner();   // if they declined, beforeinstallprompt fires again later and the banner returns
  });
  renderInstallBanner();
}

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast'); t.textContent = msg; t.className = 'show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, kind === 'err' ? 6000 : 3000);
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
  rememberIdentity();
}
/** What the phone needs to keep sending while the app is closed (the worker cannot read the page's storage). */
async function rememberIdentity() {
  try {
    if (!st.profile?.admNo || !st.sheetsUrl || !st.deviceId) return;
    const c = await caches.open('rvnp-push');
    await c.put('./__push-identity', new Response(JSON.stringify({ serverUrl: st.sheetsUrl, deviceId: st.deviceId, admNo: st.profile.admNo }),
      { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* storage blocked: sending simply waits until the app is open */ }
}
/** Asks the browser to send what is waiting as soon as there is internet, even if the app is closed. Not on every browser. */
function queueOutbox() {
  try {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.ready.then((reg) => reg.sync?.register('ark-outbox')).catch(() => {});
  } catch { /* not supported here: the app sends when it is open */ }
}
/** Once in a while, even with the app closed (Chrome on an installed app only). */
async function registerPeriodic() {
  try {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg) || !navigator.permissions?.query) return;
    const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (perm.state === 'granted') await reg.periodicSync.register('ark-outbox', { minInterval: 12 * 3600 * 1000 });
  } catch { /* not supported here */ }
}
/* An old Google Apps Script address gives way once config.js points at the new database. */
const OLD_SERVER = /script\.google(usercontent)?\.com/;
const configUrl = () => window.ATTENDANCE_CONFIG?.serverUrl || window.ATTENDANCE_CONFIG?.sheetsUrl || '';
const outdated = (url) => OLD_SERVER.test(url || '') && configUrl() && !OLD_SERVER.test(configUrl());
/** A combined lesson ("ICT L6ICT-26J, ICT L6ICT-26M-CT") is for students of each class it names. */
function classParts(classCode) {
  const parts = String(classCode).split(/\s*[,/]\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [classCode];
  const prefix = (parts[0].match(/^([A-Z]+)\s/) || [])[1];
  return [classCode, ...parts.map((x) => (prefix && !/\s/.test(x) ? `${prefix} ${x}` : x))];
}
async function saveSheetsUrl(url) {
  if (!url || url === st.sheetsUrl || outdated(url)) return;
  st.sheetsUrl = url;
  await updateLocal('settings', (d) => { d.sheetsUrl = url; });
  ls.set('rvnp_sheets_url', url);
  rememberIdentity();
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
  if (!st.sheetsUrl) throw new Error('The app is not connected to the attendance server yet - open the student link from your trainer');
  const url = new URL(st.sheetsUrl);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), method === 'GET' ? { redirect: 'follow' }
    : { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  const out = await res.json();
  setMaintenance(!!(out && out.maintenance));
  // The server holds this phone at the Connect Google step (its permission was never given, or was taken back).
  if (out && out.needGoogle && st.profile && !st.needGoogle) { st.needGoogle = true; renderGate(); }
  return out;
}
/* The database has spent its daily read limit; nothing loads until it resets (00:00 UTC = 3.00 am EAT).
 * One calm, centered screen over everything, taken away as soon as the server answers again. */
function setMaintenance(on) {
  const have = document.getElementById('maintenance');
  if (!on) { have?.remove(); return; }
  if (have) return;
  const box = document.createElement('div');
  box.id = 'maintenance';
  box.setAttribute('role', 'alert');
  box.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;background:#0f172a;color:#f1f5f9;text-align:center';
  box.innerHTML = '<div style="max-width:30rem"><div style="font-size:2.5rem;margin-bottom:.5rem">🛠️</div>'
    + '<h1 style="font-size:1.4rem;margin:0 0 .6rem">System under maintenance</h1>'
    + '<p style="margin:0;line-height:1.5;opacity:.85">The system is back by about <strong>3.00 am (EAT)</strong>. Your saved work is safe — please check in again then.</p></div>';
  document.body.appendChild(box);
}

function showResult(kind, title, text, sub = '') {
  const box = $('#result');
  box.hidden = false;
  box.className = 'card result ' + kind;
  $('#resultIcon').innerHTML = `<svg aria-hidden="true"><use href="#i-${kind === 'ok' ? 'ok' : kind === 'saved' ? 'sync' : 'no'}"/></svg>`;
  $('#resultTitle').textContent = title;
  $('#resultText').textContent = text;
  $('#resultSub').textContent = sub;
  navigator.vibrate?.(kind === 'ok' ? 120 : kind === 'saved' ? 60 : [80, 60, 80]);
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/* ---------- first login: class and name dropdowns (online, once) ---------- */
async function openSetup(message = '') {
  $('#setupCard').hidden = false;
  const msg = $('#setupMsg');
  const form = $('#setupForm');
  if (!st.sheetsUrl) { msg.textContent = 'Open the student app link your trainer shared (it connects this app to your class lists).'; form.hidden = true; return; }
  if (!navigator.onLine) { msg.textContent = 'Connect to the internet once to set up this device. After that, scanning works offline.'; form.hidden = true; return; }
  form.hidden = false;
  msg.textContent = message;
  const sel = $('#setupClass');
  sel.innerHTML = '<option value="">Loading classes…</option>';
  try {
    const res = await api('GET', { action: 'classes' });
    if (!res.ok) throw new Error(res.error || 'Could not load classes');
    sel.innerHTML = '<option value="">Choose your class</option>'
      + res.classes.map((c) => `<option value="${esc(c.code)}">${esc(c.code)} - ${esc(c.name)}</option>`).join('');
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

/* ---------- the college Google account comes first ----------
 * When the MIS Officer requires it, a registered phone does nothing else (check-ins, attendance, POE, messages) until its
 * student has connected their college Google account: once, with internet. The server refuses the same requests
 * (needGoogle), so the step cannot be skipped. A lesson QR opened meanwhile waits and is checked in right after. */
const REQ_GOOGLE = 'rvnp_require_google';
st.requireGoogle = ls.get(REQ_GOOGLE) === '1';
st.needGoogle = false;
const googleOn = () => typeof Google !== 'undefined' && Google.on();
async function checkRequireGoogle() {
  if (!st.sheetsUrl || !navigator.onLine) return;
  try {
    const j = await api('GET', { action: 'ping' });
    if (j && typeof j.requireGoogle === 'boolean') { st.requireGoogle = j.requireGoogle; ls.set(REQ_GOOGLE, j.requireGoogle ? '1' : ''); }
  } catch { /* offline: the last answer stays */ }
}
function setGoogleServer() {
  if (!googleOn()) return;
  const call = (body) => api('POST', null, { ...body, deviceId: st.deviceId, admNo: st.profile?.admNo });
  Google.setServer('student', { connect: (code) => call({ action: 'googleConnect', code }), token: () => call({ action: 'googleToken' }), supported: () => Google.supports() });
}
const gated = () => !!st.profile && googleOn() && (st.needGoogle || (st.requireGoogle && !Google.connected('student')));
/** Shows the Connect Google step when it is needed; returns true while the phone is held at it. */
function renderGate() {
  const on = gated(), box = $('#googleGate'), setup = !$('#setupCard').hidden;
  document.body.classList.toggle('gated', on && !setup);
  if (!box) return on;
  box.hidden = !on || setup;
  if (!on) return false;
  if (navigator.onLine) Google.preload();
  const dom = window.ATTENDANCE_CONFIG?.googleDomain || '';
  box.innerHTML = `<div class="setup-intro"><img src="icons/rvnp-logo.png" alt="" width="64" height="64"><div>
      <h2>Connect your college Google account</h2>
      <p class="muted">Before you check in, see your attendance or send POE, connect your college Google account${dom ? ` (@${esc(dom)})` : ''}. You do this once.</p></div></div>
    ${navigator.onLine ? '<button type="button" class="btn primary big" data-gate-connect>Connect Google</button>' : '<p class="warn-text">Connect to the internet to continue. You need it only this once.</p>'}
    <p id="gateMsg" class="small err-text" role="alert"></p>
    <p class="small muted">${esc(st.profile.name)} - ${esc(st.profile.admNo)} <button type="button" class="linkish" data-gate-reset>Not you? Set up again</button></p>`;
  return true;
}
async function connectFromGate(btn) {
  btn.disabled = true; btn.textContent = 'Connecting…';
  $('#gateMsg').textContent = '';
  try {
    setGoogleServer();
    await Google.probe(st.sheetsUrl);
    await Google.connect('student');
    st.needGoogle = false;
    toast('Google connected', 'ok');
    renderGate();
    await render();
    sync(); syncAttendance({ force: true }); POE.render?.();
    const l = st.pendingLesson; st.pendingLesson = null;
    if (l) await handleLesson(l);
  } catch (e) {
    $('#gateMsg').textContent = e.message;
    btn.disabled = false; btn.textContent = 'Connect Google';
  }
}

async function register() {
  const classCode = $('#setupClass').value, admNo = $('#setupName').value;
  if (!classCode || !admNo) return;
  const label = $('#setupName').selectedOptions[0]?.textContent || admNo;
  if (!confirm(`Register this device to ${label}?\n\nThis device will only ever check in this student.`)) return;
  $('#setupSave').disabled = true;
  try {
    const res = await api('POST', null, { action: 'register', admNo, classCode, deviceId: st.deviceId });
    if (!res.ok) throw new Error(res.error || 'Registration failed');
    await saveProfile({ admNo: res.admNo, name: res.name, classCode: res.classCode, className: res.className, registeredAt: nowISO() });
    $('#setupCard').hidden = true;
    if (res.needGoogle) { st.needGoogle = true; st.requireGoogle = true; ls.set(REQ_GOOGLE, '1'); }
    if (renderGate()) { await render(); return; }   // a lesson waiting (if any) is checked in once Google is connected
    showResult('ok', 'Device registered', `${res.name} - ${res.classCode}`, 'You can now scan your trainer\'s lesson QR, even without internet.');
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
  if (renderGate()) { st.pendingLesson = l; return; }
  const p = st.profile;
  if (!p) {
    st.pendingLesson = l; // recorded automatically as soon as setup is done
    showResult('err', 'Set up this device first', 'Choose your class and name below. Your scan is kept and recorded right after.');
    await openSetup();
    return;
  }
  // A combined lesson (streams marked together) carries a code for each stream: use this student's own.
  const first = String(l.s).split(':')[2] || '';
  if (l.x && l.x[p.classCode] && p.classCode !== first) l = { ...l, s: String(l.s).replace(`:${first}:`, `:${p.classCode}:`), t: l.x[p.classCode], c: p.classCode };
  if (!classParts(l.c).includes(p.classCode)) {
    showResult('err', 'Not your class', `This code is for ${l.c}. You are registered in ${p.classCode}.`);
    return;
  }
  const id = 'checkin:' + l.s;
  try {
    const existing = await sdb.get(id);
    showResult('ok', 'Already recorded', `${l.un || ''} - ${l.p || ''}`, `Recorded ${fmtTime(existing.scannedAt)}`);
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
  queueOutbox();
  const what = `${doc.unitName} - ${doc.period}${doc.trainer ? ' - ' + doc.trainer : ''}`;
  if (navigator.onLine) showResult('ok', 'Attendance recorded', what, 'Sending…');
  else showResult('saved', 'Saved on this phone', what, 'It is sent automatically when you next have internet.');
  await render();
  sync();
}

async function handleScanned(text) {
  const l = parseLesson(text);
  if (!l) { toast('That is not a lesson QR', 'err'); return; }
  await handleLesson(l);
}

/* ---------- sending to the server ---------- */
/* ---------- my attendance: every lesson my trainers marked, kept on this device as my own copy ---------- */
async function syncAttendance({ force = false } = {}) {
  if (!st.profile || !st.sheetsUrl || !navigator.onLine) return;
  const have = await getLocal('myAttendance');
  if (!force && have.at && Date.now() - new Date(have.at).getTime() < 10 * 60e3) return;
  try {
    const res = await api('POST', null, { action: 'myAttendance', deviceId: st.deviceId, admNo: st.profile.admNo });
    if (!res.ok) return;
    await updateLocal('myAttendance', (d) => { d.lessons = res.lessons || []; d.at = nowISO(); d.admNo = st.profile.admNo; });
    await renderAttendance();
  } catch { /* offline or server busy: the copy on this device stays */ }
}
async function renderAttendance() {
  const card = $('#attendCard'); if (!card) return;
  const d = await getLocal('myAttendance');
  const lessons = st.profile && d.admNo && lowerEq(d.admNo, st.profile.admNo) ? d.lessons || [] : [];
  card.hidden = !lessons.length;
  $('#attendCount').textContent = lessons.length || '';
  if (!lessons.length) return;
  const lessonsOnly = lessons.filter((l) => l.kind === 'lesson');
  const count = (st) => lessonsOnly.filter((l) => l.status === st).reduce((n, l) => n + (l.slots || 1), 0);
  const held = lessonsOnly.reduce((n, l) => n + (l.slots || 1), 0), came = count('Present') + count('Late');
  $('#attendSum').textContent = `${held} lesson(s) marked: ${count('Present')} present, ${count('Late')} late, ${count('Absent')} absent, ${count('Excused')} excused`
    + (held ? ` - ${Math.round((came / Math.max(1, held - count('Excused'))) * 100)}% attended` : '') + (d.at ? ` - updated ${fmtTime(d.at)}` : '');
  // The table: searchable, filtered by unit and mark, sorted by tapping a heading.
  const unitSel = $('#attUnit'), units = [...new Set(lessons.map((l) => l.unitName))].sort();
  const keep = unitSel.value;
  unitSel.innerHTML = '<option value="">All units</option>' + units.map((u) => `<option${u === keep ? ' selected' : ''}>${esc(u)}</option>`).join('');
  try { if (!localStorage.getItem('tsort:attMine')) Tables.setSort('attMine', 'date', -1); } catch { /* private mode */ }   // newest first to start
  const q = $('#attSearch').value.trim().toLowerCase(), unit = unitSel.value, mark = $('#attStatus').value;
  const shown = Tables.sort('attMine', lessons.filter((l) => (!unit || l.unitName === unit) && (!mark || l.status === mark)
    && (!q || [l.unitName, l.unitCode, l.date, fmtDate(l.date), l.period].some((x) => String(x || '').toLowerCase().includes(q)))),
  { date: (l) => l.date + ' ' + l.period, unit: (l) => l.unitName, lesson: (l) => l.period, mark: (l) => l.status }, 'date');
  const page = Tables.slice('attMine', shown), first = shown.indexOf(page[0]);
  const PILL = { Present: 'synced', Late: 'pending', Absent: 'rejected', Excused: 'locked' };
  $('#attendList').innerHTML = !shown.length ? '<p class="muted small">Nothing matches.</p>'
    : `<div class="table-wrap"><table class="report-table stu-table"><thead><tr><th class="num">S/N</th>${Tables.th('attMine', 'date', 'Date')}${Tables.th('attMine', 'unit', 'Unit')}${Tables.th('attMine', 'mark', 'Mark')}</tr></thead>
      <tbody>${page.map((l, i) => `<tr><td class="num">${first + i + 1}</td><td>${esc(new Date(l.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }))}<span class="sub">${esc(String(l.period).replace(/ - .*$/, ''))}${l.kind !== 'lesson' ? ` (${l.kind === 'cat' ? 'CAT' : 'extra'})` : ''}</span></td>
        <td>${esc(l.unitName)}</td><td><span class="pill ${PILL[l.status] || 'locked'}">${esc(l.status || '–')}</span></td></tr>`).join('')}</tbody></table></div>${Tables.bar('attMine', shown)}`;
}

async function sync({ manual = false } = {}) {
  if (!st.profile || !st.sheetsUrl || st.syncing) return;
  if (!navigator.onLine) { if (manual) toast('No internet - your check-ins are safe on this device'); return; }
  const docs = (await checkins()).filter((d) => d.status === 'saved' || d.status === 'pending');
  if (!docs.length) { if (manual) toast('Nothing waiting to send', 'ok'); return; }
  st.syncing = true;
  $('#syncBtn').classList.add('syncing');
  try {
    // The sending itself is student-outbox.js, the same code the phone runs when the app is closed.
    const res = await Outbox.run({ db: sdb, serverUrl: st.sheetsUrl, deviceId: st.deviceId, admNo: st.profile.admNo, parts: ['checkins'], wait: true });
    if (res.error) throw new Error(res.error);
    // The MIS Officer may have moved this student to another stream: follow the official list.
    if (res.moved && st.profile && lowerEq(res.moved.admNo, st.profile.admNo) && res.moved.classCode !== st.profile.classCode) {
      await saveProfile({ ...st.profile, classCode: res.moved.classCode, className: res.moved.classCode });
    }
    if (manual) toast('Check-ins sent', 'ok');
  } catch (e) {
    if (manual) toast('Could not send: ' + e.message, 'err');
  } finally {
    st.syncing = false;
    $('#syncBtn').classList.remove('syncing');
    await mirrorUnsent();
    render();
  }
  // While a check-in waits for the trainer's device, ask again within seconds instead of a minute.
  const waiting = (await checkins()).some((d) => d.status === 'pending' || d.status === 'saved');
  if (waiting) queueOutbox();   // still unsent: the phone tries again later, even with the app closed
  clearTimeout(st.retryTimer);
  if (waiting && navigator.onLine && (st.retries = (st.retries || 0) + 1) <= 20) st.retryTimer = setTimeout(() => sync(), 8000);
  else if (!waiting) st.retries = 0;
}

/* ---------- camera ---------- */
let stream = null, scanning = false;
async function startScan() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('This browser cannot use the camera - use your camera app instead', 'err'); return; }
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
  renderGate();
  const p = st.profile;
  $('#who').textContent = p ? `${p.name} - ${p.classCode}` : 'Not set up';
  $('#profileCard').hidden = !p;
  $('#resetSetup').hidden = !p;
  $('#viewTabs').hidden = !p;
  if (!p) delete document.body.dataset.view;
  if (p) {
    $('#pName').textContent = p.name;
    $('#pMeta').textContent = p.admNo;
    // The student's own QR ID (their admission number): the trainer's Scan ID cards reads it.
    const qrBox = $('#pQr');
    if (qrBox && qrBox.dataset.adm !== p.admNo && window.qrcode) {
      const qr = qrcode(0, 'M'); qr.addData(p.admNo); qr.make();
      qrBox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      qrBox.dataset.adm = p.admNo;
    }
  }
  const STATUS_ORDER = { accepted: 0, pending: 1, saved: 2, rejected: 3 };
  const by = $('#histSort')?.value || 'new';
  const list = (await checkins()).sort(by === 'old' ? (a, b) => String(a.scannedAt).localeCompare(String(b.scannedAt))
    : by === 'unit' ? (a, b) => String(a.unitName || a.classCode).localeCompare(String(b.unitName || b.classCode)) || String(b.scannedAt).localeCompare(String(a.scannedAt))
      : by === 'status' ? (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || String(b.scannedAt).localeCompare(String(a.scannedAt))
        : (a, b) => String(b.scannedAt).localeCompare(String(a.scannedAt)));
  $('#historyCard').hidden = !list.length;
  $('#historyCount').textContent = list.length || '';
  await renderAttendance();
  $('#history').innerHTML = list.map((d) => {
    const label = d.status === 'accepted' ? ['synced', 'Confirmed']
      : d.status === 'pending' ? ['pending', 'Sent - waiting for trainer to sync']
      : d.status === 'rejected' ? ['rejected', REASONS[d.reason] || 'Not accepted']
      : ['pending', 'Saved on device'];
    return `<li><div><b>${esc(d.unitName || d.classCode)}</b><span class="muted small">${esc(fmtDate(d.date))} - ${esc(d.period)} - ${esc(fmtTime(d.scannedAt))}</span>
</div>
      <span class="pill ${label[0]}">${esc(label[1])}</span></li>`;
  }).join('');
  // Keep the "Attendance recorded" card in step with what happened to that scan.
  const last = st.lastScan && !$('#result').hidden && list.find((d) => d._id === st.lastScan);
  if (last) {
    const box = $('#result');
    if (box.classList.contains('saved') && (last.status === 'accepted' || last.status === 'pending')) {
      box.className = 'card result ok';
      $('#resultIcon').innerHTML = '<svg aria-hidden="true"><use href="#i-ok"/></svg>';
      $('#resultTitle').textContent = 'Attendance recorded';
    }
    $('#resultSub').textContent = last.status === 'accepted' ? 'Confirmed in your trainer\'s register.'
      : last.status === 'pending' ? 'Sent. It is confirmed once your trainer\'s device syncs.'
      : last.status === 'rejected' ? (REASONS[last.reason] || 'Not accepted')
      : navigator.onLine ? 'Sending…' : 'Saved on this phone. It is sent automatically when you next have internet.';
  }
  const unsent = list.filter((d) => d.status === 'saved');
  const el = $('#pendingCount'); el.textContent = unsent.length; el.classList.toggle('zero', unsent.length === 0);

  // Warn when check-ins have been waiting a long time, so they are sent before anything can happen to the device.
  const oldest = unsent.reduce((m, d) => (!m || d.scannedAt < m ? d.scannedAt : m), '');
  const days = oldest ? Math.floor((Date.now() - new Date(oldest).getTime()) / 864e5) : 0;
  const warn = $('#warning');
  if (days >= 3) {
    warn.hidden = false;
    warn.textContent = `${unsent.length} check-in(s) not sent for ${days} days. They are safe on this device - connect to the internet and tap Send.`;
  } else if (st.storage === 'not-protected' && list.length) {
    warn.hidden = false;
    warn.textContent = 'Add this app to your home screen (browser menu → Add to Home screen) so your device keeps your check-ins safely.';
  } else warn.hidden = true;

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
  // Opened from a notification about evidence (student.html#poe), not from a scanned QR.
  if (/^#poe$/i.test(h)) { st.openPoe = true; POE.showEvidence(); return; }
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
  // Device ID: kept in the database and in a second place, so it survives if one is lost.
  const dev = await updateLocal('device', (d) => { if (!d.deviceId) d.deviceId = ls.get('rvnp_device_id') || 'stu-' + uuid().replace(/-/g, '').slice(0, 12); });
  st.deviceId = dev.deviceId;
  ls.set('rvnp_device_id', st.deviceId);
  const prof = await getLocal('profile');
  if (prof.admNo) { const { _id, _rev, ...p } = prof; st.profile = p; }
  else {
    try { const copy = JSON.parse(ls.get('rvnp_profile') || 'null'); if (copy?.admNo) await saveProfile(copy); } catch { /* none */ }
  }
  const settings = await getLocal('settings');
  st.sheetsUrl = [settings.sheetsUrl, ls.get('rvnp_sheets_url'), configUrl()].find((u) => u && !outdated(u)) || '';
  rememberIdentity();
  const restored = await restoreUnsent();
  if (restored) toast(`Recovered ${restored} unsent check-in(s)`, 'ok');
  updateNet();

  setGoogleServer();
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-gate-connect]'); if (c) { connectFromGate(c); return; }
    if (e.target.closest('[data-gate-reset]')) { $('#googleGate').hidden = true; document.body.classList.remove('gated'); openSetup('Choose your class and name again. If this phone is registered to someone else, your trainer must reset it first.'); }
  });
  setupInstallBanner();
  $('#setupClass').addEventListener('change', loadNames);
  $('#setupName').addEventListener('change', () => { $('#setupSave').disabled = !$('#setupName').value; });
  $('#setupSave').addEventListener('click', register);
  $('#resetSetup').addEventListener('click', () => openSetup('Choose your class and name again. If this device is already registered to someone else, your trainer must reset it first.'));
  $('#scanBtn').addEventListener('click', startScan);
  $('#stopScan').addEventListener('click', stopScan);
  $('#scanDialog').addEventListener('close', stopScan);
  $('#syncBtn').addEventListener('click', () => sync({ manual: true }));
  window.addEventListener('hashchange', consumeHash);
  window.addEventListener('online', () => { updateNet(); if (!st.profile && !$('#setupCard').hidden) openSetup(); checkRequireGoogle().then(() => renderGate()); sync(); syncAttendance(); });
  window.addEventListener('offline', () => renderGate());
  $('#histSort').addEventListener('change', () => render());
  $('#attSearch').addEventListener('input', () => { Tables.reset('attMine'); renderAttendance(); });
  $('#attUnit').addEventListener('change', () => { Tables.reset('attMine'); renderAttendance(); });
  $('#attStatus').addEventListener('change', () => { Tables.reset('attMine'); renderAttendance(); });
  Tables.on('attMine', () => renderAttendance());
  window.syncAttendance = syncAttendance;
  window.addEventListener('offline', updateNet);
  // Automatic sending: on every scan, when the internet comes back, when the app is opened, and every minute.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
  setInterval(() => sync(), 60 * 1000);

  await protectStorage();
  await checkRequireGoogle();
  await consumeHash();
  if (!st.profile && $('#setupCard').hidden) await openSetup();
  await render();
  sync();
  syncAttendance();
  POE.init().then(() => { if (st.openPoe) POE.showEvidence(); }).catch((e) => console.error('Evidence', e));
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(() => registerPeriodic()).catch(() => {});
    // The phone sent something while the app was closed (or open in the background): show it.
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'outbox-done') { render(); POE.render?.(); } });
    const hadController = !!navigator.serviceWorker.controller;
    // A new version is ready: the app reloads to use it, but never in the middle of a scan, with the camera
    // open or while a page is being saved; it waits until the student is idle and the app is on screen.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      const reloadWhenIdle = () => {
        if (scanning || POE.busy?.() || document.visibilityState !== 'visible') { setTimeout(reloadWhenIdle, 15000); return; }
        location.reload();
      };
      reloadWhenIdle();
    });
  }
}

init().catch((e) => { console.error(e); toast('Start-up error: ' + e.message, 'err'); });

/* Errors this app runs into go to the MIS Officer's System health list (a few per page load, each one once). */
(() => {
  const seen = new Set();
  function report(message, detail, where) {
    const key = String(message).slice(0, 120);
    if (/Failed to fetch|NetworkError|Load failed|No connection|AbortError|took too long|ResizeObserver/i.test(key)) return;
    if (seen.has(key) || seen.size >= 5 || !navigator.onLine || !st.sheetsUrl) return;
    seen.add(key);
    try {
      fetch(st.sheetsUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, keepalive: true,
        body: JSON.stringify({ action: 'appError', app: 'student', where, message: key, detail: String(detail || '').slice(0, 1500), who: st.profile?.admNo || '' }) }).catch(() => {});
    } catch { /* never let reporting break the app */ }
  }
  window.addEventListener('error', (e) => report(e.message || 'Error', `${e.filename || ''}:${e.lineno || ''}
${e.error?.stack || ''}`, 'page'));
  window.addEventListener('unhandledrejection', (e) => report(e.reason?.message || String(e.reason), e.reason?.stack || '', 'promise'));
})();
