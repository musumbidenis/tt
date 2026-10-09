/* Student check-in — works offline.
 * The student scans the trainer's lesson QR (no joining needed). The first time, they type
 * their admission number; their class comes from the Google Sheet. Each check-in is kept on
 * the phone, shown as a receipt QR for the trainer to scan (the trainer-side record), and
 * sent to the Sheet when there is internet. The Sheet ties this phone to the student on the
 * first submission and confirms the check-in when both records match. */
'use strict';

const sdb = new PouchDB('rvnp_student', { auto_compaction: true });
const RECEIPT_PREFIX = 'rvnp-receipt:';
const REASONS = {
  'wrong-class': 'Not your class',
  'device-other-student': 'This phone is registered to another student',
  'student-other-device': 'You are registered on another phone — see your trainer',
  'invalid-code': 'Code not valid (expired, or not from your trainer)',
  'unknown-student': 'Admission number not found',
};
const st = { deviceId: '', profile: null, pendingLesson: null, syncing: false };

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowISO = () => new Date().toISOString();
const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const b64url = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

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
function qrSvg(text, cell = 5) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}
function receiptText(d) {
  return RECEIPT_PREFIX + b64url({ v: 1, s: d.sessionId, a: d.admNo, d: d.deviceId, w: d.w, t: d.token, at: d.scannedAt });
}

async function checkins() {
  const r = await sdb.allDocs({ include_docs: true, startkey: 'checkin:', endkey: 'checkin:￰' });
  return r.rows.map((x) => x.doc);
}

function showResult(kind, title, text, sub = '', receiptDoc = null) {
  const box = $('#result');
  box.hidden = false;
  box.className = 'card result ' + kind;
  $('#resultIcon').textContent = kind === 'ok' ? '✓' : '✕';
  $('#resultTitle').textContent = title;
  $('#resultText').textContent = text;
  $('#resultSub').textContent = sub;
  $('#receiptBox').hidden = !receiptDoc;
  if (receiptDoc) {
    const txt = receiptText(receiptDoc);
    $('#receiptCode').innerHTML = qrSvg(txt, 5);
    $('#receiptCode').dataset.receipt = txt;
    $('#receiptWho').textContent = `${st.profile?.name || receiptDoc.admNo} · phone ${st.deviceId}`;
  }
  navigator.vibrate?.(kind === 'ok' ? 120 : [80, 60, 80]);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------- identity (once) ---------- */
function askIdentity(why = '') {
  $('#idCard').hidden = false;
  $('#idWhy').textContent = why;
  $('#idAdm').value = '';
  $('#idAdm').focus();
  render();
}

async function saveIdentity() {
  const adm = $('#idAdm').value.trim().toUpperCase();
  if (!adm) { toast('Type your admission number', 'err'); return; }
  if (!confirm(`Register this phone to ${adm}?\n\nAfter it is confirmed, this phone can only check in ${adm}.`)) return;
  const old = st.profile;
  await saveProfile({ admNo: adm, sheetsUrl: old?.sheetsUrl || st.pendingLesson?.u || '', confirmed: false, registeredAt: nowISO() });
  // Check-ins saved under a wrong admission number are re-sent under the new one.
  for (const d of await checkins()) {
    if (d.status === 'rejected' && (d.reason === 'unknown-student' || d.reason === 'wrong-class') || (d.status === 'saved' && d.admNo !== adm)) {
      Object.assign(d, { admNo: adm, status: 'saved', reason: '' });
      await sdb.put(d);
    }
  }
  $('#idCard').hidden = true;
  const l = st.pendingLesson;
  st.pendingLesson = null;
  if (l) await handleLesson(l);
  else { await render(); sync(); }
}

/* ---------- recording a check-in (offline) ---------- */
async function handleLesson(l) {
  if (!l || !l.s || !l.c || l.w === undefined || !l.t) { showResult('err', 'Not a lesson code', 'Scan the QR on your trainer\'s screen.'); return; }
  const p = st.profile;
  if (!p) {
    st.pendingLesson = l;
    showResult('ok', `${l.un || 'Lesson'} · ${l.p || ''}`, 'One more step: type your admission number below.');
    askIdentity();
    return;
  }
  if (p.classCode && l.c !== p.classCode) {
    showResult('err', 'Not your class', `This code is for ${l.c}. You are in ${p.classCode}.`);
    return;
  }
  if (l.u && p.sheetsUrl !== l.u) await saveProfile({ ...p, sheetsUrl: l.u });
  const id = 'checkin:' + l.s;
  try {
    const existing = await sdb.get(id);
    showResult('ok', 'Already recorded', `${l.un || ''} · ${l.p || ''}`, `Recorded ${fmtTime(existing.scannedAt)}`, existing);
    return;
  } catch (e) { if (e.status !== 404) throw e; }
  const doc = {
    _id: id, type: 'checkin', sessionId: l.s, classCode: l.c, unitName: l.un || '', period: l.p || '', trainer: l.n || '',
    date: String(l.s).split(':')[1] || '', w: l.w, token: l.t, admNo: st.profile.admNo, deviceId: st.deviceId,
    scannedAt: nowISO(), status: 'saved', reason: '', verification: '',
  };
  await sdb.put(doc);
  showResult('ok', 'Attendance recorded', `${doc.unitName} · ${doc.period}${doc.trainer ? ' · ' + doc.trainer : ''}`,
    navigator.onLine ? 'Sending…' : 'Saved on this phone — sent when you have internet.', doc);
  await render();
  sync();
}

async function handleScanned(text) {
  const l = parseLesson(text);
  if (!l) { toast('That is not a lesson QR', 'err'); return false; }
  await handleLesson(l);
  return true;
}

/* ---------- sending to the Sheet ---------- */
async function sync({ manual = false } = {}) {
  const p = st.profile;
  if (!p?.sheetsUrl || st.syncing) return;
  if (!navigator.onLine) { if (manual) toast('No internet — your check-ins are safe on this phone'); return; }
  const recent = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  // Also re-check recent confirmed ones until the trainer's receipt is matched too.
  const docs = (await checkins()).filter((d) => d.status === 'saved' || d.status === 'pending'
    || (d.status === 'accepted' && d.verification !== 'Both' && d.date >= recent));
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
    let known = null, bound = false, unknown = false, otherClass = null;
    for (const d of docs) {
      const r = byId.get(`${d.sessionId}|${d.admNo}|${d.deviceId}`.toLowerCase());
      if (!r) continue;
      Object.assign(d, { status: r.status, reason: r.reason || '', verification: r.verification || '', checkedAt: nowISO() });
      await sdb.put(d);
      if (r.name) known = { name: r.name, classCode: r.classCode };
      if (r.status === 'accepted' || r.status === 'pending' || r.reason === 'invalid-code') bound = true;
      if (r.reason === 'unknown-student') unknown = true;
      if (r.reason === 'wrong-class') otherClass = d.classCode;
    }
    const prof = st.profile;
    if (known) await saveProfile({ ...prof, name: known.name, classCode: known.classCode, confirmed: prof.confirmed || bound });
    else if (bound && !prof.confirmed) await saveProfile({ ...prof, confirmed: true });
    if (!st.profile.confirmed) {
      if (unknown) {
        showResult('err', 'Admission number not found', `${prof.admNo} is not on the class lists.`);
        askIdentity('That admission number was not found. Type it again.');
      } else if (otherClass && known) {
        showResult('err', 'Not your class', `${prof.admNo} (${known.name}) is in ${known.classCode}, but the lesson was for ${otherClass}.`, 'If that is not you, tap "Change admission number".');
      }
    }
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
  $('#who').textContent = p ? `${p.name || p.admNo}${p.classCode ? ' · ' + p.classCode : ''}` : 'Scan your trainer\'s QR to start';
  const list = (await checkins()).sort((a, b) => String(b.scannedAt).localeCompare(String(a.scannedAt)));
  $('#startCard').hidden = !!p || !$('#idCard').hidden || !$('#result').hidden;
  $('#profileCard').hidden = !p;
  if (p) {
    $('#pName').textContent = p.name || p.admNo;
    $('#pMeta').textContent = [p.admNo, p.classCode].filter(Boolean).join(' · ') + (p.name ? '' : ' · name appears after your first sync');
    const lock = $('#pLock');
    lock.textContent = p.confirmed ? 'Registered to this phone' : 'Waiting for confirmation';
    lock.className = 'pill ' + (p.confirmed ? 'synced' : 'pending');
    let change = $('#changeAdm');
    if (!p.confirmed) {
      if (!change) {
        change = document.createElement('button');
        change.id = 'changeAdm'; change.type = 'button'; change.className = 'btn ghost small';
        change.textContent = 'Change admission number';
        change.addEventListener('click', () => askIdentity());
        $('#profileCard').appendChild(change);
      }
    } else change?.remove();
  }
  $('#historyCard').hidden = !list.length;
  $('#history').innerHTML = list.map((d) => {
    const label = d.status === 'accepted' ? ['synced', d.verification === 'Both' ? 'Confirmed by you and your trainer' : 'Confirmed']
      : d.status === 'pending' ? ['pending', 'Sent — waiting for trainer']
      : d.status === 'rejected' ? ['rejected', REASONS[d.reason] || 'Not accepted']
      : ['pending', 'Saved on phone'];
    return `<li><div><b>${esc(d.unitName || d.classCode)}</b><span class="muted small">${esc(fmtDate(d.date))} · ${esc(d.period)} · ${esc(fmtTime(d.scannedAt))}</span>
      <button type="button" class="linkish" data-receipt="${esc(d._id)}">Show receipt</button></div>
      <span class="pill ${label[0]}">${esc(label[1])}</span></li>`;
  }).join('');
  const waiting = list.filter((d) => d.status === 'saved' || d.status === 'pending').length;
  const el = $('#pendingCount'); el.textContent = waiting; el.classList.toggle('zero', waiting === 0);
  $('#deviceInfo').textContent = `Phone ID ${st.deviceId}`;
}

async function showReceipt(id) {
  const d = await sdb.get(id);
  $('#receiptDialogSub').textContent = `${d.unitName} · ${d.period} · ${st.profile?.name || d.admNo}`;
  const txt = receiptText(d);
  $('#receiptDialogCode').innerHTML = qrSvg(txt, 6);
  $('#receiptDialogCode').dataset.receipt = txt;
  $('#receiptDialog').showModal();
}

function updateNet() {
  const on = navigator.onLine;
  const b = $('#netBadge'); b.textContent = on ? 'Online' : 'Offline'; b.className = 'badge ' + (on ? 'online' : 'offline');
}

async function consumeHash() {
  if (!location.hash) return;
  const h = location.hash;
  history.replaceState(null, '', location.pathname + location.search); // a reload must not record twice
  await handleScanned(h);
}

async function init() {
  const dev = await updateLocal('device', (d) => { if (!d.deviceId) d.deviceId = 'stu-' + uuid().replace(/-/g, '').slice(0, 12); });
  st.deviceId = dev.deviceId;
  const prof = await getLocal('profile');
  if (prof.admNo) { const { _id, _rev, ...p } = prof; st.profile = p; }
  updateNet();

  $('#idSave').addEventListener('click', saveIdentity);
  $('#idAdm').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveIdentity(); });
  $('#scanBtn').addEventListener('click', startScan);
  $('#stopScan').addEventListener('click', stopScan);
  $('#scanDialog').addEventListener('close', stopScan);
  $('#closeReceipt').addEventListener('click', () => $('#receiptDialog').close());
  $('#history').addEventListener('click', (e) => { const b = e.target.closest('[data-receipt]'); if (b) showReceipt(b.dataset.receipt); });
  $('#syncBtn').addEventListener('click', () => sync({ manual: true }));
  window.addEventListener('hashchange', consumeHash);
  window.addEventListener('online', () => { updateNet(); sync(); });
  window.addEventListener('offline', updateNet);
  setInterval(() => sync(), 2 * 60 * 1000);

  await consumeHash();
  await render();
  sync();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

init().catch((e) => { console.error(e); toast('Start-up error: ' + e.message, 'err'); });
