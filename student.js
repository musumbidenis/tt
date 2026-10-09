/* Student check-in — works offline.
 * A student registers this phone once (class join link, while online), then scans the
 * trainer's lesson QR. Check-ins are kept on the phone and sent to the Google Sheet when
 * there is internet; the Sheet verifies each one and ties the phone to the student. */
'use strict';

const sdb = new PouchDB('rvnp_student', { auto_compaction: true });
const REASONS = {
  'wrong-class': 'Not your class',
  'device-other-student': 'This phone is registered to another student',
  'student-other-device': 'You are registered on another phone — see your trainer',
  'invalid-code': 'Code not valid (expired, or not from your trainer)',
  'unknown-student': 'Admission number not found — choose your name again',
};
const st = { deviceId: '', profile: null, join: null, roster: [], syncing: false };

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowISO = () => new Date().toISOString();
const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

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
  await updateLocal('profile', (d) => { for (const k of Object.keys(d)) if (k !== '_id' && k !== '_rev') delete d[k]; Object.assign(d, p || {}); });
}

function decodeB64(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(s + '='.repeat((4 - (s.length % 4)) % 4)))));
}
function parseLink(text) {
  const m = /#(l|j)=([A-Za-z0-9_-]+)/.exec(String(text || ''));
  if (!m) return null;
  try { return { kind: m[1], data: decodeB64(m[2]) }; } catch { return null; }
}

async function checkins() {
  const r = await sdb.allDocs({ include_docs: true, startkey: 'checkin:', endkey: 'checkin:￰' });
  return r.rows.map((x) => x.doc);
}

function showResult(kind, title, text, sub = '') {
  const box = $('#result');
  box.hidden = false;
  box.className = 'card result ' + kind;
  $('#resultIcon').textContent = kind === 'ok' ? '✓' : kind === 'wait' ? '…' : '✕';
  $('#resultTitle').textContent = title;
  $('#resultText').textContent = text;
  $('#resultSub').textContent = sub;
  navigator.vibrate?.(kind === 'ok' ? 120 : [80, 60, 80]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- joining a class (once, online) ---------- */
async function handleJoin(j) {
  if (!j || !j.u || !j.c || !j.k) { showResult('err', 'This join link is incomplete', 'Ask your trainer for the class join QR again.'); return; }
  const p = st.profile;
  if (p?.locked) {
    if (p.classCode === j.c) {
      if (p.sheetsUrl !== j.u) await saveProfile({ ...p, sheetsUrl: j.u });
      showResult('ok', 'Already registered', `${p.name} — ${p.className}`);
    } else {
      showResult('err', 'This phone is already registered', `It belongs to ${p.name} in ${p.classCode}. Ask your trainer if this is wrong.`);
    }
    return;
  }
  st.join = j;
  await updateLocal('join', (d) => Object.assign(d, j));
  await openJoin();
}

async function openJoin(reason = '') {
  const j = st.join; if (!j) return;
  $('#joinCard').hidden = false;
  $('#joinClass').textContent = `${j.c} — ${j.cn || ''}`;
  st.roster = [];
  if (navigator.onLine) {
    try {
      const url = new URL(j.u);
      url.searchParams.set('action', 'classlist'); url.searchParams.set('class', j.c); url.searchParams.set('key', j.k);
      const res = await (await fetch(url.toString(), { redirect: 'follow' })).json();
      if (!res.ok) throw new Error(res.error || 'Could not load the class list');
      st.roster = res.trainees || [];
    } catch (e) { reason = e.message.includes('join code') ? e.message : 'Could not load the class list (' + e.message + ').'; }
  } else reason = reason || 'You are offline, so the class list can\'t load.';
  const manual = !st.roster.length;
  $('#joinPick').hidden = manual;
  $('#joinManual').hidden = !manual;
  $('#joinManualWhy').textContent = manual ? `${reason} Type your admission number — it is checked when you next have internet.` : '';
  renderJoinList();
  render();
}

function renderJoinList() {
  const q = $('#joinSearch').value.trim().toLowerCase();
  const list = st.roster.filter((t) => !q || t.name.toLowerCase().includes(q) || t.admNo.toLowerCase().includes(q));
  $('#joinList').innerHTML = list.map((t) => `<li><button type="button" data-adm="${esc(t.admNo)}" data-name="${esc(t.name)}">
    <b>${esc(t.name)}</b><span>${esc(t.admNo)}</span></button></li>`).join('') || '<li class="empty">No match</li>';
}

async function chooseIdentity(admNo, name, confirmed) {
  const j = st.join; if (!j) return;
  if (!admNo) { toast('Enter your admission number', 'err'); return; }
  if (!confirm(`Register this phone to ${name || admNo} (${admNo})?\n\nAfter your first check-in this can't be changed on this phone.`)) return;
  await saveProfile({ admNo, name: name || admNo, classCode: j.c, className: j.cn || j.c, sheetsUrl: j.u, joinKey: j.k, locked: false, confirmed: !!confirmed, registeredAt: nowISO() });
  st.join = null;
  await updateLocal('join', (d) => { for (const k of Object.keys(d)) if (k !== '_id' && k !== '_rev') delete d[k]; });
  $('#joinCard').hidden = true;
  showResult('ok', 'Phone registered', `${name || admNo} — ${j.cn || j.c}`, 'Now scan your trainer\'s lesson QR in class. Tip: add this page to your home screen.');
  render();
}

/* ---------- recording a check-in (offline) ---------- */
async function handleLesson(l) {
  if (!l || !l.s || !l.c || l.w === undefined || !l.t) { showResult('err', 'Not a lesson code', 'Scan the QR on your trainer\'s screen.'); return; }
  const p = st.profile;
  if (!p) { showResult('err', 'Register this phone first', 'Open your class join link from your trainer while online, then scan again.'); render(); return; }
  if (l.c !== p.classCode) { showResult('err', 'Not your class', `This code is for ${l.c}. You are registered in ${p.classCode}.`); return; }
  const id = 'checkin:' + l.s;
  try {
    const existing = await sdb.get(id);
    const identityProblem = existing.status === 'rejected' && ['unknown-student', 'wrong-class'].includes(existing.reason);
    if (!identityProblem || existing.admNo === p.admNo) {
      showResult('ok', 'Already recorded', `${l.un || ''} · ${l.p || ''}`, `Recorded ${fmtTime(existing.scannedAt)}`);
      return;
    }
    await sdb.remove(existing); // recorded under a wrong admission number — record again for the right one
  } catch (e) { if (e.status !== 404) throw e; }
  const doc = {
    _id: id, type: 'checkin', sessionId: l.s, classCode: l.c, unitName: l.un || '', period: l.p || '', trainer: l.n || '',
    date: String(l.s).split(':')[1] || '', w: l.w, token: l.t, admNo: p.admNo, deviceId: st.deviceId,
    scannedAt: nowISO(), status: 'saved', reason: '',
  };
  await sdb.put(doc);
  if (!p.locked) await saveProfile({ ...p, locked: true }); // first submission ties this phone to this student
  showResult('ok', 'Attendance recorded', `${doc.unitName} · ${doc.period}${doc.trainer ? ' · ' + doc.trainer : ''}`,
    navigator.onLine ? 'Sending to your trainer…' : 'Saved on this phone — it will be sent when you have internet.');
  await render();
  sync();
}

async function handleLink(text) {
  const link = parseLink(text);
  if (!link) return false;
  if (link.kind === 'j') await handleJoin(link.data);
  else await handleLesson(link.data);
  return true;
}

/* ---------- sending to the Sheet ---------- */
async function sync({ manual = false } = {}) {
  const p = st.profile;
  if (!p?.sheetsUrl || st.syncing) return;
  if (!navigator.onLine) { if (manual) toast('No internet — your check-ins are safe on this phone'); return; }
  const docs = (await checkins()).filter((d) => d.status === 'saved' || d.status === 'pending');
  if (!docs.length) { if (manual) toast('Nothing waiting to send', 'ok'); return; }
  st.syncing = true;
  $('#syncBtn').classList.add('syncing');
  try {
    const res = await (await fetch(p.sheetsUrl, {
      method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'checkin', checkins: docs.map((d) => ({ sessionId: d.sessionId, classCode: d.classCode, admNo: d.admNo, deviceId: d.deviceId, w: d.w, token: d.token, scannedAt: d.scannedAt })) }),
    })).json();
    if (!res.ok) throw new Error(res.error || 'The Sheet did not accept the check-ins');
    const byId = new Map((res.results || []).map((r) => [String(r.id).toLowerCase(), r]));
    let identityBad = false, confirmed = false;
    for (const d of docs) {
      const r = byId.get(`${d.sessionId}|${d.admNo}|${d.deviceId}`.toLowerCase());
      if (!r) continue;
      d.status = r.status; d.reason = r.reason || ''; d.checkedAt = nowISO();
      await sdb.put(d);
      if (r.reason === 'unknown-student' || r.reason === 'wrong-class') identityBad = true;
      if (r.status === 'accepted' || r.status === 'pending' || r.reason === 'invalid-code') confirmed = true;
    }
    if (identityBad && !confirmed && !(await checkins()).some((d) => d.status === 'accepted')) {
      const p0 = st.profile;
      st.join = { u: p0.sheetsUrl, c: p0.classCode, cn: p0.className, k: p0.joinKey };
      await saveProfile(null);
      await updateLocal('join', (d) => Object.assign(d, st.join));
      showResult('err', 'Admission number not found', 'Choose your name from the class list below.');
      openJoin();
    } else if (confirmed && !st.profile.confirmed) await saveProfile({ ...st.profile, confirmed: true });
    if (manual) toast('Check-ins sent', 'ok');
  } catch (e) {
    if (manual) toast('Could not send: ' + e.message, 'err');
  } finally {
    st.syncing = false;
    $('#syncBtn').classList.remove('syncing');
    render();
  }
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
    if (code && parseLink(code)) { stopScan(); await handleLink(code); return; }
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
  $('#who').textContent = p ? `${p.name} · ${p.classCode}` : 'Not registered';
  $('#noProfile').hidden = !!p || !!st.join;
  $('#profileCard').hidden = !p;
  if (p) {
    $('#pName').textContent = p.name;
    $('#pMeta').textContent = `${p.admNo} · ${p.className}`;
    const lock = $('#pLock');
    lock.textContent = p.locked ? 'Registered to this phone' : 'Not confirmed yet';
    lock.className = 'pill ' + (p.locked ? 'synced' : 'pending');
    $('#changeMe').hidden = !!p.locked;
  }
  const list = (await checkins()).sort((a, b) => String(b.scannedAt).localeCompare(String(a.scannedAt)));
  $('#historyCard').hidden = !list.length;
  $('#history').innerHTML = list.map((d) => {
    const label = d.status === 'accepted' ? ['synced', 'Confirmed']
      : d.status === 'pending' ? ['pending', 'Sent — waiting for trainer']
      : d.status === 'rejected' ? ['rejected', REASONS[d.reason] || 'Not accepted']
      : ['pending', 'Saved on phone'];
    return `<li><div><b>${esc(d.unitName || d.classCode)}</b><span class="muted small">${esc(fmtDate(d.date))} · ${esc(d.period)} · scanned ${esc(fmtTime(d.scannedAt))}</span></div>
      <span class="pill ${label[0]}">${esc(label[1])}</span></li>`;
  }).join('');
  const waiting = list.filter((d) => d.status === 'saved' || d.status === 'pending').length;
  const el = $('#pendingCount'); el.textContent = waiting; el.classList.toggle('zero', waiting === 0);
  $('#deviceInfo').textContent = `Phone ID ${st.deviceId}`;
}

function updateNet() {
  const on = navigator.onLine;
  const b = $('#netBadge'); b.textContent = on ? 'Online' : 'Offline'; b.className = 'badge ' + (on ? 'online' : 'offline');
}

async function consumeHash() {
  if (!location.hash) return;
  const h = location.hash;
  history.replaceState(null, '', location.pathname + location.search); // reloads must not record twice
  await handleLink(h);
}

async function init() {
  const dev = await updateLocal('device', (d) => { if (!d.deviceId) d.deviceId = 'stu-' + uuid().replace(/-/g, '').slice(0, 12); });
  st.deviceId = dev.deviceId;
  const prof = await getLocal('profile');
  if (prof.admNo) { const { _id, _rev, ...p } = prof; st.profile = p; }
  const j = await getLocal('join');
  if (j.c && !st.profile?.locked) { const { _id, _rev, ...jj } = j; st.join = jj; }
  updateNet();

  $('#joinSearch').addEventListener('input', renderJoinList);
  $('#joinList').addEventListener('click', (e) => { const b = e.target.closest('button[data-adm]'); if (b) chooseIdentity(b.dataset.adm, b.dataset.name, true); });
  $('#joinManualBtn').addEventListener('click', () => chooseIdentity($('#joinAdm').value.trim(), $('#joinName').value.trim(), false));
  $('#changeMe').addEventListener('click', async () => {
    const p = st.profile; if (!p || p.locked) return;
    st.join = { u: p.sheetsUrl, c: p.classCode, cn: p.className, k: p.joinKey };
    await saveProfile(null);
    await updateLocal('join', (d) => Object.assign(d, st.join));
    $('#result').hidden = true;
    openJoin();
  });
  $('#scanBtn').addEventListener('click', startScan);
  $('#stopScan').addEventListener('click', stopScan);
  $('#scanDialog').addEventListener('close', stopScan);
  $('#syncBtn').addEventListener('click', () => sync({ manual: true }));
  window.addEventListener('hashchange', consumeHash);
  window.addEventListener('online', () => { updateNet(); sync(); });
  window.addEventListener('offline', updateNet);
  setInterval(() => sync(), 2 * 60 * 1000);

  await consumeHash();
  if (st.join && $('#joinCard').hidden) await openJoin();
  await render();
  sync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

init().catch((e) => { console.error(e); toast('Start-up error: ' + e.message, 'err'); });
