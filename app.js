/* RVNP Attendance Register — offline-first.
 * Storage: PouchDB (IndexedDB) on the device.
 * Sync:    straight to Google Sheets through an Apps Script web app: registers are
 *          pushed whenever the phone is online, class lists are pulled from the Sheet.
 */
'use strict';

const APP_VERSION = '3.5.0';
const db = new PouchDB('rvnp_attendance', { auto_compaction: true });

const STATUSES = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };
// Live updates: during a live QR lesson the app asks the Sheet a tiny "anything new?" every few seconds;
// otherwise it checks once a minute while open. Both only run while online and on screen.
const LIVE_FAST_MS = window.__liveFastMs || 4000;
const LIVE_SLOW_MS = window.__liveSlowMs || 60000;
const PERIODS = [
  { code: 'L1', label: 'Lesson 1' }, { code: 'L2', label: 'Lesson 2' },
  { code: 'L3', label: 'Lesson 3' }, { code: 'L4', label: 'Lesson 4' },
  { code: 'L5', label: 'Lesson 5' }, { code: 'L6', label: 'Lesson 6' },
  { code: 'EV', label: 'Evening' },
];
const DEFAULT_SETTINGS = {
  trainerName: '', trainerId: '', lockHours: 48, defaultStatus: 'P', threshold: 75,
  sheetsUrl: '', sheetsToken: '',
};

const state = {
  settings: { ...DEFAULT_SETTINGS },
  deviceId: '',
  classes: [], units: [], trainees: [],
  current: null,          // session document open in the Mark tab
  dirty: false,           // unsaved changes in the open register
  editSeq: 0,             // bumps on every edit, so a save never swallows a newer edit
  editReasonGiven: false, // reason already captured for a locked register
  syncing: false,
  activeTab: 'mark',
};

/* ---------------- small helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowISO = () => new Date().toISOString();
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const periodLabel = (code) => (PERIODS.find((p) => p.code === code) || { label: code }).label;
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); };
const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const trainerLabel = () => state.settings.trainerName || 'Unknown trainer';
const clone = (o) => JSON.parse(JSON.stringify(o));

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3000);
}

/* ---------------- local (non-replicating) docs ---------------- */
async function getLocal(id, fallback = {}) {
  try { return await db.get('_local/' + id); }
  catch (e) { if (e.status === 404) return { _id: '_local/' + id, ...clone(fallback) }; throw e; }
}
async function updateLocal(id, fn, fallback = {}) {
  for (let i = 0; i < 6; i++) {
    const doc = await getLocal(id, fallback);
    fn(doc);
    try { const r = await db.put(doc); doc._rev = r.rev; return doc; }
    catch (e) { if (e.status !== 409) throw e; }
  }
  throw new Error('Could not update ' + id);
}

async function loadSettings() {
  const d = await getLocal('settings');
  const { _id, _rev, ...rest } = d;
  state.settings = { ...DEFAULT_SETTINGS, ...rest };
}
async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  await updateLocal('settings', (d) => Object.assign(d, state.settings));
  renderTrainerLabel();
}
async function loadDevice() {
  // Kept in the database and in a second place, so the phone ID survives if one is lost.
  let mirror = null;
  try { mirror = localStorage.getItem('rvnp_trainer_device'); } catch { /* blocked */ }
  const d = await updateLocal('device', (doc) => { if (!doc.deviceId) doc.deviceId = mirror || 'dev-' + uuid().slice(0, 8); });
  state.deviceId = d.deviceId;
  try { localStorage.setItem('rvnp_trainer_device', d.deviceId); } catch { /* blocked */ }
}

async function protectStorage() {
  state.storage = 'unknown';
  if (!navigator.storage?.persist) return;
  try {
    let ok = await navigator.storage.persisted();
    if (!ok) ok = await navigator.storage.persist();
    state.storage = ok ? 'protected' : 'not-protected';
  } catch { /* unknown */ }
}

/* ---------------- roster ---------------- */
async function byPrefix(prefix, extra = {}) {
  const r = await db.allDocs({ include_docs: true, startkey: prefix, endkey: prefix + '￰', ...extra });
  return r.rows.map((x) => x.doc);
}

async function loadRoster() {
  state.classes = (await byPrefix('class:')).sort((a, b) => a.code.localeCompare(b.code));
  state.units = (await byPrefix('unit:')).sort((a, b) => a.code.localeCompare(b.code));
  state.trainees = (await byPrefix('trainee:')).sort((a, b) => a.name.localeCompare(b.name));
  renderClassSelects();
  $('#emptyRoster').hidden = state.classes.length > 0;
  $('#rosterInfo').textContent = state.classes.length
    ? `On this device: ${state.classes.length} classes, ${state.units.length} units, ${state.trainees.filter((t) => t.active !== false).length} active trainees.`
    : 'No roster on this device yet.';
}

const isInactive = (v) => /^(no|n|false|0|inactive|left|discontinued)$/i.test(String(v ?? '').trim());
const pick = (obj, keys) => { for (const k of keys) if (obj[k] != null && String(obj[k]).trim() !== '') return String(obj[k]).trim(); return ''; };

function normaliseRoster(input) {
  const classes = new Map();
  for (const c of input.classes || []) {
    const code = pick(c, ['code', 'classcode', 'ClassCode']);
    if (code) classes.set(code, { _id: 'class:' + code, type: 'class', code, name: pick(c, ['name', 'classname', 'ClassName']) || code });
  }
  const trainees = [];
  for (const t of input.trainees || []) {
    const admNo = pick(t, ['admNo', 'admno', 'AdmNo', 'admissionno', 'admissionnumber', 'regno', 'registrationno']);
    const classCode = pick(t, ['classCode', 'classcode', 'ClassCode', 'class']);
    if (!admNo || !classCode) continue;
    if (!classes.has(classCode)) {
      classes.set(classCode, { _id: 'class:' + classCode, type: 'class', code: classCode, name: pick(t, ['className', 'classname', 'ClassName']) || classCode });
    }
    trainees.push({
      _id: 'trainee:' + admNo, type: 'trainee', admNo,
      name: pick(t, ['name', 'Name', 'fullname', 'traineename']) || admNo,
      classCode,
      active: !(t.active === false || isInactive(t.active ?? t.Active)),
    });
  }
  const units = [];
  for (const u of input.units || []) {
    const classCode = pick(u, ['classCode', 'classcode', 'ClassCode']);
    const code = pick(u, ['code', 'unitcode', 'UnitCode']);
    if (!classCode || !code) continue;
    units.push({ _id: `unit:${classCode}:${code}`, type: 'unit', classCode, code, name: pick(u, ['name', 'unitname', 'UnitName']) || code });
  }
  return { classes: [...classes.values()], units, trainees };
}

/* Replace the given kinds of roster docs on this device with `incoming`. */
async function replaceRoster(incoming, kinds) {
  const norm = normaliseRoster(incoming);
  const lists = { class: norm.classes, unit: norm.units, trainee: norm.trainees };
  const docs = [];
  for (const kind of kinds) {
    const existing = await byPrefix(kind + ':');
    const byId = new Map(existing.map((d) => [d._id, d]));
    const seen = new Set();
    for (const doc of lists[kind]) {
      seen.add(doc._id);
      const old = byId.get(doc._id);
      if (old) {
        const { _rev, ...oldBody } = old;
        if (JSON.stringify(oldBody) === JSON.stringify(doc)) continue;
        doc._rev = _rev;
      }
      docs.push(doc);
    }
    for (const old of existing) if (!seen.has(old._id)) docs.push({ _id: old._id, _rev: old._rev, _deleted: true });
  }
  // Classes referenced by units/trainees must exist even when only units are imported.
  if (!kinds.includes('class')) {
    const have = new Set((await byPrefix('class:')).map((c) => c.code));
    for (const c of norm.classes) if (!have.has(c.code)) docs.push(c);
    for (const u of norm.units) if (!have.has(u.classCode) && !norm.classes.find((c) => c.code === u.classCode)) {
      have.add(u.classCode);
      docs.push({ _id: 'class:' + u.classCode, type: 'class', code: u.classCode, name: u.classCode });
    }
  }
  if (docs.length) {
    const res = await db.bulkDocs(docs);
    const failed = res.filter((r) => r.error);
    if (failed.length) throw new Error(`${failed.length} roster records could not be saved`);
  }
  await loadRoster();
  return { classes: norm.classes.length, units: norm.units.length, trainees: norm.trainees.length, changed: docs.length };
}

/* ---------------- CSV ---------------- */
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!clean.length) return [];
  const head = clean[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  return clean.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
function toCSV(rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
function download(filename, content, type = 'text/csv') {
  const blob = new Blob([type === 'text/csv' ? '﻿' + content : content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------------- Mark tab ---------------- */
const sessionId = (date, classCode, unitCode, period) => `session:${date}:${classCode}:${unitCode}:${period}`;
const unitsFor = (classCode) => state.units.filter((u) => u.classCode === classCode);
const activeTraineesFor = (classCode) => state.trainees.filter((t) => t.classCode === classCode && t.active !== false);

function fillSelect(sel, options, value, placeholder) {
  const prev = value ?? sel.value;
  sel.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '')
    + options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  if (options.some((o) => o.value === prev)) sel.value = prev;
}

function renderClassSelects() {
  const classOpts = state.classes.map((c) => ({ value: c.code, label: c.code + ' — ' + c.name }));
  fillSelect($('#fClass'), classOpts, undefined, classOpts.length ? null : 'No classes');
  fillSelect($('#sClass'), classOpts, undefined, 'All classes');
  fillSelect($('#rClass'), classOpts, undefined, classOpts.length ? null : 'No classes');
  renderUnitSelect();
  renderReportUnitSelect();
}
function renderUnitSelect() {
  const opts = unitsFor($('#fClass').value).map((u) => ({ value: u.code, label: u.code + ' — ' + u.name }));
  fillSelect($('#fUnit'), opts, undefined, opts.length ? null : 'No units for this class');
}

async function openFromForm(e) {
  e?.preventDefault();
  const date = $('#fDate').value, classCode = $('#fClass').value, unitCode = $('#fUnit').value, period = $('#fPeriod').value;
  if (!date || !classCode || !unitCode || !period) { toast('Choose a date, class, unit and lesson first', 'err'); return; }
  if (state.dirty) await saveCurrent();
  const id = sessionId(date, classCode, unitCode, period);
  let doc;
  try { doc = await db.get(id); }
  catch (err) {
    if (err.status !== 404) throw err;
    const unit = state.units.find((u) => u.classCode === classCode && u.code === unitCode);
    const cls = state.classes.find((c) => c.code === classCode);
    const marks = {}, names = {};
    for (const t of activeTraineesFor(classCode)) { marks[t.admNo] = state.settings.defaultStatus || 'P'; names[t.admNo] = t.name; }
    doc = {
      _id: id, type: 'session', date, classCode, className: cls?.name || classCode,
      unitCode, unitName: unit?.name || unitCode, period, periodLabel: periodLabel(period),
      trainerId: state.settings.trainerId, trainerName: trainerLabel(), deviceId: state.deviceId,
      marks, names, explicit: {}, notes: '', createdAt: nowISO(), updatedAt: nowISO(), editLog: [],
    };
  }
  setCurrent(doc, !doc._rev);
}

function setCurrent(doc, isNew = false) {
  state.current = doc;
  state.dirty = false;
  state.editReasonGiven = false;
  $('#regSearch').value = '';
  $('#regNotes').value = doc.notes || '';
  setSaveState(isNew ? 'Not saved yet' : 'Saved on this device', isNew ? '' : 'ok');
  renderRegister();
  $('#register').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function rosterForCurrent() {
  const s = state.current;
  const list = activeTraineesFor(s.classCode).map((t) => ({ admNo: t.admNo, name: t.name, unlisted: false }));
  const listed = new Set(list.map((t) => t.admNo));
  for (const adm of Object.keys(s.marks || {})) {
    if (!listed.has(adm)) list.push({ admNo: adm, name: s.names?.[adm] || adm, unlisted: true });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

function isLocked(s) {
  if (!s?._rev) return false;
  return (Date.now() - new Date(s.createdAt).getTime()) / 36e5 >= Number(state.settings.lockHours || 48);
}

function renderRegister() {
  const s = state.current;
  if (!s) { $('#register').hidden = true; return; }
  $('#register').hidden = false;
  $('#regTitle').textContent = `${s.classCode} · ${s.unitCode}`;
  $('#regSub').textContent = `${s.unitName} — ${fmtDate(s.date)}, ${periodLabel(s.period)}${isLocked(s) ? ' · locked' : ''}`;
  const q = $('#regSearch').value.trim().toLowerCase();
  const rows = rosterForCurrent().filter((t) => !q || t.name.toLowerCase().includes(q) || t.admNo.toLowerCase().includes(q));
  $('#traineeList').innerHTML = rows.length ? rows.map((t) => {
    const st = s.marks?.[t.admNo] || '';
    return `<li class="trow${t.unlisted ? ' unlisted' : ''}" data-adm="${esc(t.admNo)}">
      <div class="tinfo"><span class="tname">${esc(t.name)}${qrTag(s, t.admNo)}</span><span class="tadm">${esc(t.admNo)}</span></div>
      <div class="seg" role="group" aria-label="Status for ${esc(t.name)}">
        ${Object.keys(STATUSES).map((k) => `<button type="button" data-s="${k}" class="${st === k ? 'on' : ''}" title="${STATUSES[k]}" aria-pressed="${st === k}">${k}</button>`).join('')}
      </div></li>`;
  }).join('') : '<li class="empty">No trainees match.</li>';
  renderCounts();
  const log = s.editLog || [];
  $('#editLogInfo').textContent = log.length
    ? `Edited after locking ${log.length} time(s). Last: ${fmtTime(log[log.length - 1].at)} by ${log[log.length - 1].by} — "${log[log.length - 1].reason}"`
    : '';
}

function qrTag(s, adm) {
  return s.viaQr?.[adm] ? ` <span class="qrtag" title="Checked in by scanning the lesson QR (${esc(fmtTime(s.viaQr[adm]))})">QR</span>` : '';
}

function countMarks(s) {
  const c = { P: 0, A: 0, L: 0, E: 0, none: 0 };
  for (const v of Object.values(s.marks || {})) { if (c[v] !== undefined) c[v]++; else c.none++; }
  return c;
}
function renderCounts() {
  const s = state.current; if (!s) return;
  const roster = rosterForCurrent();
  const c = { P: 0, A: 0, L: 0, E: 0, none: 0 };
  for (const t of roster) { const v = s.marks?.[t.admNo]; if (c[v] !== undefined) c[v]++; else c.none++; }
  $('#counts').innerHTML = Object.keys(STATUSES).map((k) => `<span class="chip ${k}">${STATUSES[k]} ${c[k]}</span>`).join('')
    + (c.none ? `<span class="chip">Unmarked ${c.none}</span>` : '')
    + `<span class="chip">Total ${roster.length}</span>`;
}

async function ensureEditable() {
  const s = state.current;
  if (!isLocked(s) || state.editReasonGiven) return true;
  const reason = prompt(`This register is more than ${state.settings.lockHours} hours old and is locked.\nType a reason for changing it (it will be recorded):`);
  if (!reason || !reason.trim()) { toast('No changes made — a reason is required for locked registers'); return false; }
  s.editLog = [...(s.editLog || []), { at: nowISO(), by: trainerLabel(), device: state.deviceId, reason: reason.trim() }];
  state.editReasonGiven = true;
  return true;
}

async function setMark(adm, status, { rerender = true } = {}) {
  const s = state.current; if (!s) return false;
  if (!(await ensureEditable())) return false;
  s.marks[adm] = status;
  s.explicit = { ...(s.explicit || {}), [adm]: true };
  if (!s.names[adm]) s.names[adm] = state.trainees.find((t) => t.admNo === adm)?.name || adm;
  const row = $(`.trow[data-adm="${CSS.escape(adm)}"]`);
  if (row) $$('.seg button', row).forEach((b) => { const on = b.dataset.s === status; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  if (rerender) renderCounts();
  markDirty();
  return true;
}

async function setAll(status) {
  if (!state.current) return;
  if (!(await ensureEditable())) return;
  for (const t of rosterForCurrent()) { state.current.marks[t.admNo] = status; state.current.names[t.admNo] = t.name; }
  state.current.explicit = {}; // "All present/absent" sets the default; QR check-ins can still change it
  renderRegister();
  markDirty();
}

let saveTimer;
function markDirty() {
  state.dirty = true;
  state.editSeq++;
  setSaveState('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrent, 600);
}
function setSaveState(text, kind = '') { const el = $('#saveState'); el.textContent = text; el.className = 'save-state ' + kind; }

let saving = Promise.resolve();
function saveCurrent() {
  clearTimeout(saveTimer);
  saving = saving.then(doSave, doSave);
  return saving;
}
async function doSave() {
  const s = state.current;
  if (!s || !state.dirty) return;
  const seq = state.editSeq;
  s.notes = $('#regNotes').value.trim();
  s.updatedAt = nowISO();
  s.updatedBy = trainerLabel();
  s.deviceId = state.deviceId;
  if (!s.trainerName || s.trainerName === 'Unknown trainer') { s.trainerName = trainerLabel(); s.trainerId = state.settings.trainerId; }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await db.put(clone(s));
      s._rev = r.rev;
      if (state.current === s && state.editSeq !== seq) return; // newer edits: the pending timer saves them
      state.dirty = false;
      setSaveState('Saved on this device', 'ok');
      refreshPending();
      scheduleAutoSync();
      return;
    } catch (e) {
      if (e.status === 409) { // changed by replication meanwhile: this device's edit wins, keep its marks
        const latest = await db.get(s._id);
        s._rev = latest._rev;
        continue;
      }
      setSaveState('Not saved: ' + e.message, 'err');
      toast('Could not save: ' + e.message, 'err');
      return;
    }
  }
}

async function closeRegister() {
  if (state.dirty) await saveCurrent();
  state.current = null;
  renderRegister();
}

/* ---------------- QR scanning ---------------- */
let scanStream = null, scanning = false;
async function startScan() {
  if (!state.current) { toast('Open a register first', 'err'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast('This browser cannot use the camera', 'err'); return; }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) { toast('Camera not available: ' + e.message, 'err'); return; }
  const video = $('#scanVideo');
  video.srcObject = scanStream;
  $('#scanDialog').showModal();
  await video.play().catch(() => {});
  scanning = true;
  $('#scanResult').textContent = 'Point the camera at a card';
  $('#scanResult').className = 'scan-result';

  let detector = null;
  try {
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      detector = new BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch { detector = null; }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const lastSeen = new Map();

  const tick = async () => {
    if (!scanning) return;
    let codes = [];
    try {
      if (video.readyState >= 2) {
        if (detector) codes = (await detector.detect(video)).map((x) => x.rawValue);
        else if (window.jsQR) {
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (r?.data) codes = [r.data];
        }
      }
    } catch { /* keep scanning */ }
    for (const code of codes) {
      const t = Date.now();
      if (t - (lastSeen.get(code) || 0) < 2500) continue;
      lastSeen.set(code, t);
      await handleScan(code);
    }
    setTimeout(tick, detector ? 120 : 200);
  };
  tick();
}

async function handleScan(raw) {
  let adm = String(raw).trim();
  try { const j = JSON.parse(adm); if (j && (j.adm || j.admNo)) adm = String(j.adm || j.admNo).trim(); } catch { /* plain text code */ }
  const s = state.current;
  const roster = rosterForCurrent();
  const t = roster.find((x) => x.admNo.toLowerCase() === adm.toLowerCase());
  const out = $('#scanResult');
  if (!t) {
    const other = state.trainees.find((x) => x.admNo.toLowerCase() === adm.toLowerCase());
    out.textContent = other ? `${other.name} is in ${other.classCode}, not this class` : `Unknown card: ${adm}`;
    out.className = 'scan-result err';
    navigator.vibrate?.([60, 60, 60]);
    return;
  }
  const status = $('#scanAs').value;
  const ok = await setMark(t.admNo, status);
  if (!ok) return;
  out.textContent = `${t.name} — ${STATUSES[status]}`;
  out.className = 'scan-result ok';
  navigator.vibrate?.(80);
  const row = $(`.trow[data-adm="${CSS.escape(t.admNo)}"]`);
  if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  if (s) renderCounts();
}

function stopScan() {
  scanning = false;
  scanStream?.getTracks().forEach((tr) => tr.stop());
  scanStream = null;
  if ($('#scanDialog').open) $('#scanDialog').close();
}

/* ---------------- Registers tab ---------------- */
async function renderSessions() {
  const [sessions, map] = await Promise.all([byPrefix('session:'), sheetsSyncMap()]);
  const cls = $('#sClass').value, sync = $('#sSync').value;
  const list = sessions
    .filter((s) => (!cls || s.classCode === cls))
    .filter((s) => { const done = map[s._id] === s._rev; return !sync || (sync === 'synced' ? done : !done); })
    .sort((a, b) => (b.date + b.period).localeCompare(a.date + a.period));
  $('#sessionList').innerHTML = list.length ? list.map((s) => {
    const c = countMarks(s);
    const synced = map[s._id] === s._rev;
    return `<button class="sitem" data-id="${esc(s._id)}">
      <span class="s-title">${esc(s.classCode)} · ${esc(s.unitCode)} — ${esc(periodLabel(s.period))}</span>
      <span class="s-badges">
        <span class="pill ${synced ? 'synced' : 'pending'}">${synced ? 'In Google Sheets' : 'Waiting to sync'}</span>
        ${isLocked(s) ? '<span class="pill locked">Locked</span>' : ''}
      </span>
      <span class="s-meta">${esc(fmtDate(s.date))} · P ${c.P} · A ${c.A} · L ${c.L} · E ${c.E} · ${esc(s.trainerName || '')}</span>
    </button>`;
  }).join('') : '<p class="empty">No registers yet. Marked registers appear here.</p>';
}

async function openSessionById(id) {
  if (state.dirty) await saveCurrent();
  const doc = await db.get(id);
  switchTab('mark');
  $('#fDate').value = doc.date;
  $('#fClass').value = doc.classCode; renderUnitSelect();
  $('#fUnit').value = doc.unitCode; $('#fPeriod').value = doc.period;
  setCurrent(doc);
}

/* ---------------- Reports ---------------- */
function renderReportUnitSelect() {
  const opts = unitsFor($('#rClass').value).map((u) => ({ value: u.code, label: u.code + ' — ' + u.name }));
  fillSelect($('#rUnit'), opts, undefined, 'All units');
}

async function buildReport() {
  const classCode = $('#rClass').value, unitCode = $('#rUnit').value;
  const from = $('#rFrom').value, to = $('#rTo').value;
  const threshold = Number($('#rThreshold').value || state.settings.threshold || 75);
  const sessions = (await byPrefix('session:')).filter((s) => s.classCode === classCode
    && (!unitCode || s.unitCode === unitCode) && (!from || s.date >= from) && (!to || s.date <= to));
  const rows = new Map();
  for (const t of activeTraineesFor(classCode)) rows.set(t.admNo, { admNo: t.admNo, name: t.name, P: 0, A: 0, L: 0, E: 0 });
  for (const s of sessions) {
    for (const [adm, st] of Object.entries(s.marks || {})) {
      if (!STATUSES[st]) continue;
      if (!rows.has(adm)) rows.set(adm, { admNo: adm, name: s.names?.[adm] || adm, P: 0, A: 0, L: 0, E: 0 });
      rows.get(adm)[st]++;
    }
  }
  const list = [...rows.values()].map((r) => {
    const counted = r.P + r.L + r.A; // excused sessions are left out of the percentage
    const pct = counted ? Math.round(((r.P + r.L) / counted) * 1000) / 10 : null;
    return { ...r, counted, pct, below: pct !== null && pct < threshold };
  }).sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101) || a.name.localeCompare(b.name));
  return { classCode, unitCode, from, to, threshold, sessions, list };
}

async function renderReport() {
  if (!$('#rClass').value) { $('#reportTable').innerHTML = ''; $('#reportSummary').innerHTML = '<p class="empty">Add a roster to see reports.</p>'; return; }
  const r = await buildReport();
  const below = r.list.filter((x) => x.below).length;
  const withPct = r.list.filter((x) => x.pct !== null);
  const avg = withPct.length ? Math.round(withPct.reduce((a, x) => a + x.pct, 0) / withPct.length) : 0;
  $('#reportSummary').innerHTML = `
    <div class="stat"><b>${r.sessions.length}</b><span>Lessons recorded</span></div>
    <div class="stat"><b>${r.list.length}</b><span>Trainees</span></div>
    <div class="stat"><b>${avg}%</b><span>Average attendance</span></div>
    <div class="stat ${below ? 'warn' : ''}"><b>${below}</b><span>Below ${r.threshold}%</span></div>`;
  $('#reportTable').innerHTML = `<thead><tr><th>#</th><th>Trainee</th><th class="num">P</th><th class="num">L</th><th class="num">A</th><th class="num">E</th><th class="num">%</th></tr></thead>
    <tbody>${r.list.map((x, i) => `<tr class="${x.below ? 'below' : ''}">
      <td>${i + 1}</td><td class="who">${esc(x.name)}<small>${esc(x.admNo)}</small></td>
      <td class="num">${x.P}</td><td class="num">${x.L}</td><td class="num">${x.A}</td><td class="num">${x.E}</td>
      <td class="num">${x.pct === null ? '—' : `<span class="bar"><i style="width:${x.pct}%"></i></span>${x.pct}%`}</td></tr>`).join('')
      || '<tr><td colspan="7" class="empty">No trainees in this class.</td></tr>'}</tbody>`;
}

async function exportReport() {
  if (!$('#rClass').value) return;
  const r = await buildReport();
  const head = [['RVNP attendance report'], ['Class', r.classCode], ['Unit', r.unitCode || 'All units'],
    ['Period', `${r.from || 'start'} to ${r.to || 'today'}`], ['Lessons recorded', r.sessions.length], ['Minimum %', r.threshold], []];
  const table = [['#', 'AdmNo', 'Name', 'Present', 'Late', 'Absent', 'Excused', 'Attendance %', 'Below minimum']]
    .concat(r.list.map((x, i) => [i + 1, x.admNo, x.name, x.P, x.L, x.A, x.E, x.pct ?? '', x.below ? 'YES' : '']));
  download(`attendance_${r.classCode}_${r.unitCode || 'all'}_${todayISO()}.csv`, toCSV(head.concat(table)));
}

async function exportRaw() {
  const sessions = (await byPrefix('session:')).sort((a, b) => (a.date + a.period).localeCompare(b.date + b.period));
  const rows = [['Date', 'Lesson', 'ClassCode', 'UnitCode', 'UnitName', 'AdmNo', 'Name', 'Status', 'Trainer', 'SessionID', 'UpdatedAt']];
  for (const s of sessions) for (const [adm, st] of Object.entries(s.marks || {})) {
    rows.push([s.date, periodLabel(s.period), s.classCode, s.unitCode, s.unitName, adm, s.names?.[adm] || '', STATUSES[st] || '', s.trainerName, s._id, s.updatedAt]);
  }
  download(`attendance_all_records_${todayISO()}.csv`, toCSV(rows));
}

function printQRCards() {
  const classCode = $('#rClass').value;
  const list = activeTraineesFor(classCode);
  if (!list.length) { toast('No trainees in this class', 'err'); return; }
  $('#printArea').innerHTML = list.map((t) => {
    const qr = qrcode(0, 'M'); qr.addData(t.admNo); qr.make();
    return `<div class="qr-card">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<b>${esc(t.name)}</b><small>${esc(t.admNo)}</small><small>${esc(classCode)}</small></div>`;
  }).join('');
  document.body.classList.add('printing');
  const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);
}

/* ---------------- Google Sheets sync (Apps Script web app) ----------------
 * Registers are pushed straight to the Sheet whenever the phone is online;
 * class lists are pulled from the Sheet's Classes / Units / Trainees tabs. */
async function callSheets(method, body, params = {}) {
  if (!state.settings.sheetsUrl) throw new Error('Add the Apps Script web app URL in Setup');
  const url = new URL(state.settings.sheetsUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const opts = method === 'GET'
      ? { method: 'GET', signal: ctrl.signal, redirect: 'follow' }
      // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight
      : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctrl.signal, redirect: 'follow' };
    const res = await fetch(url.toString(), opts);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error('Unexpected reply from Apps Script — check the deployment is set to "Anyone" and the URL ends in /exec'); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Google Sheets took too long to answer');
    if (e instanceof TypeError) throw new Error('No connection to Google Sheets');
    throw e;
  } finally { clearTimeout(timer); }
}

async function sheetsSyncMap() { return (await getLocal('sheetsSync', { map: {} })).map || {}; }
async function pendingSessions() {
  const [sessions, map] = await Promise.all([byPrefix('session:'), sheetsSyncMap()]);
  return sessions.filter((s) => map[s._id] !== s._rev);
}
async function refreshPending() {
  const pending = await pendingSessions();
  const n = pending.length;
  const el = $('#pendingCount');
  el.textContent = n;
  el.classList.toggle('zero', n === 0);
  // Long-unsent registers matter most for QR lessons: students' scans are verified only once the lesson reaches the Sheet.
  const oldest = pending.reduce((m, s) => (!m || s.updatedAt < m ? s.updatedAt : m), '');
  const days = oldest ? Math.floor((Date.now() - new Date(oldest).getTime()) / 864e5) : 0;
  const qr = pending.filter((s) => s.qr).length;
  const warn = $('#syncWarn');
  if (days >= 2) {
    warn.hidden = false;
    warn.textContent = `${n} register(s) not sent for ${days} days${qr ? ` (${qr} with student QR check-ins waiting to be verified)` : ''}. They are safe on this phone — connect and tap Sync.`;
  } else if (state.storage === 'not-protected' && n) {
    warn.hidden = false;
    warn.textContent = 'Install this app (browser menu → Add to Home screen) so the phone keeps unsent registers safely.';
  } else warn.hidden = true;
}

function toSheetSession(s) {
  const c = countMarks(s);
  return {
    sessionId: s._id, date: s.date, classCode: s.classCode, className: s.className || '',
    unitCode: s.unitCode, unitName: s.unitName || '', period: periodLabel(s.period),
    trainerId: s.trainerId || '', trainerName: s.trainerName || '', deviceId: s.deviceId || '',
    notes: s.notes || '', createdAt: s.createdAt || '', updatedAt: s.updatedAt || '',
    edits: (s.editLog || []).length, counts: { P: c.P, A: c.A, L: c.L, E: c.E },
    marks: Object.entries(s.marks || {}).filter(([, v]) => STATUSES[v])
      .map(([admNo, st]) => ({ admNo, name: s.names?.[admNo] || '', status: STATUSES[st], explicit: !!s.explicit?.[admNo] })),
    ...(s.qr ? { qr: { secret: s.qr.secret, intervals: s.qr.intervals } } : {}),
  };
}

async function syncSheets({ silent = false, pull = true } = {}) {
  if (!state.settings.sheetsUrl) { if (!silent) { toast('Add your Google Sheets web app URL in Setup first'); switchTab('settings'); } return; }
  if (state.syncing) return;
  if (!navigator.onLine) { if (!silent) toast('No network — registers are safe on this device and will sync later'); return; }
  if (state.dirty) await saveCurrent();
  state.syncing = true;
  $('#syncBtn').classList.add('syncing');
  let sent = 0;
  const pushPending = async () => {
    for (const batch of chunk(await pendingSessions(), 20)) {
      const res = await callSheets('POST', { action: 'push', token: state.settings.sheetsToken, deviceId: state.deviceId, sessions: batch.map(toSheetSession) });
      if (!res.ok) throw new Error(res.error || 'Google Sheets rejected the upload');
      await updateLocal('sheetsSync', (d) => { d.map = d.map || {}; for (const s of batch) d.map[s._id] = s._rev; }, { map: {} });
      sent += batch.length;
    }
  };
  try {
    await pushPending();
    const qrUpdated = pull ? await pullCheckins() : 0; // uploads alone skip fetching; the live pulse handles that
    if (qrUpdated) await pushPending();
    await updateLocal('syncLog', (d) => { d.lastSheets = nowISO(); });
    renderSheetsStatus();
    if (!silent) {
      const parts = [];
      if (sent) parts.push(`Sent ${sent} register(s) to Google Sheets`);
      if (qrUpdated) parts.push(`QR check-ins added to ${qrUpdated} register(s)`);
      toast(parts.join(' · ') || 'Everything is already in Google Sheets', 'ok');
    }
  } catch (e) {
    $('#sheetsStatus').textContent = `Sync stopped${sent ? ` after ${sent} register(s)` : ''}: ${e.message}`;
    if (!silent) toast('Sync failed: ' + e.message, 'err');
  } finally {
    state.syncing = false;
    $('#syncBtn').classList.remove('syncing');
    refreshPending();
    if (state.activeTab === 'sessions') renderSessions();
  }
}

let autoTimer;
function scheduleAutoSync() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => { if (navigator.onLine) syncSheets({ silent: true, pull: false }); }, 5000);
}

async function pullRoster({ silent = false } = {}) {
  if (!state.settings.sheetsUrl) { if (!silent) toast('Add your Google Sheets web app URL first', 'err'); return; }
  const btn = $('#pullRoster'); btn.disabled = true;
  if (!silent) $('#sheetsStatus').textContent = 'Downloading class lists…';
  try {
    const res = await callSheets('GET', null, { action: 'roster', token: state.settings.sheetsToken });
    if (!res.ok) throw new Error(res.error || 'Could not read the class lists');
    if (!(res.trainees || []).length && state.trainees.length) throw new Error('the Trainees tab is empty — kept the class lists already on this phone');
    const r = await replaceRoster(res, ['class', 'unit', 'trainee']);
    await updateLocal('syncLog', (d) => { d.lastRoster = nowISO(); });
    renderSheetsStatus();
    if (!silent) toast(`Class lists saved: ${r.classes} classes, ${r.trainees} trainees — you can now mark offline`, 'ok');
  } catch (e) {
    $('#sheetsStatus').textContent = 'Class list download failed: ' + e.message;
    if (!silent) toast(e.message, 'err');
  } finally { btn.disabled = false; }
}

async function testSheets() {
  $('#sheetsStatus').textContent = 'Testing…';
  try {
    const res = await callSheets('GET', null, { action: 'ping', token: state.settings.sheetsToken });
    if (!res.ok) throw new Error(res.error);
    $('#sheetsStatus').textContent = `Connected to "${res.spreadsheet}".`;
    toast('Google Sheets connection works', 'ok');
  } catch (e) { $('#sheetsStatus').textContent = 'Connection failed: ' + e.message; }
}

async function renderSheetsStatus() {
  const log = await getLocal('syncLog');
  const parts = [];
  if (log.lastSheets) parts.push(`Registers last sent ${fmtTime(log.lastSheets)}`);
  if (log.lastRoster) parts.push(`class lists downloaded ${fmtTime(log.lastRoster)}`);
  $('#sheetsStatus').textContent = parts.length ? parts.join(' · ') + '.' : (state.settings.sheetsUrl ? 'Not synced yet.' : 'Not connected yet.');
}

/* Refresh class lists automatically when they are more than 12 hours old. */
async function maybeRefreshRoster() {
  if (!state.settings.sheetsUrl || !navigator.onLine) return;
  const log = await getLocal('syncLog');
  if (!log.lastRoster || Date.now() - new Date(log.lastRoster).getTime() > 12 * 36e5) pullRoster({ silent: true });
}

/* When two devices edit the same register, keep the most recent version and
 * fill in any trainee marks that only exist in the other version. */
async function resolveConflicts() {
  const res = await db.allDocs({ include_docs: true, conflicts: true, startkey: 'session:', endkey: 'session:￰' });
  for (const row of res.rows) {
    const doc = row.doc;
    if (!doc?._conflicts?.length) continue;
    try {
      const others = await Promise.all(doc._conflicts.map((rev) => db.get(doc._id, { rev })));
      const all = [doc, ...others].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const { _conflicts, ...winner } = all[0];
      const merged = { ...clone(winner), _rev: doc._rev };
      merged.marks = { ...winner.marks };
      merged.names = { ...winner.names };
      const logs = new Map();
      for (const v of all) {
        for (const [k, st] of Object.entries(v.marks || {})) if (!merged.marks[k]) { merged.marks[k] = st; merged.names[k] = v.names?.[k] || k; }
        for (const l of v.editLog || []) logs.set(l.at + l.device, l);
      }
      merged.editLog = [...logs.values(), { at: nowISO(), by: 'auto-merge', device: state.deviceId,
        reason: `Combined ${others.length + 1} versions edited on ${[...new Set(all.map((v) => v.deviceId))].join(', ')}` }]
        .sort((a, b) => a.at.localeCompare(b.at));
      merged.updatedAt = nowISO();
      await db.bulkDocs([merged, ...doc._conflicts.map((rev) => ({ _id: doc._id, _rev: rev, _deleted: true }))]);
    } catch (e) { console.warn('Conflict resolution failed for', doc._id, e); }
  }
}

const changedIds = new Set();
const onDbChange = debounce(async () => {
  const ids = new Set(changedIds);
  changedIds.clear();
  if ([...ids].some((id) => /^(class|unit|trainee):/.test(id))) await loadRoster();
  await resolveConflicts();
  refreshPending();
  const cur = state.current;
  if (cur && ids.has(cur._id) && !state.dirty) {
    try {
      const fresh = await db.get(cur._id);
      if (fresh._rev !== cur._rev) { state.current = fresh; renderRegister(); toast('This register was updated from another device'); }
    } catch { /* deleted */ }
  }
  if (state.activeTab === 'sessions') renderSessions();
  if (state.activeTab === 'reports') renderReport();
}, 400);

/* ---------------- QR check-in: students scan a code the trainer shows ----------------
 * The lesson QR changes every QR_WINDOW seconds. Each code is an HMAC of the lesson and the
 * time window, made with a secret that only this phone (and later the Sheet) knows, so
 * students cannot make their own codes. The Sheet checks every check-in against it. */
const QR_WINDOW = 20; // seconds — must match WINDOW_SECONDS in Code.gs
const qrWindow = (t = Date.now()) => Math.floor(t / 1000 / QR_WINDOW);
const b64url = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const studentPageUrl = () => new URL('student.html', location.href.split('#')[0]).toString();

async function qrToken(secret, sessionId, w) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${sessionId}|${w}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
}
function qrSvg(text, cell = 6) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}

let lessonQrTimer = null;
async function openLessonQR() {
  const s = state.current;
  if (!s) return;
  if (isLocked(s)) { toast('This lesson is locked — open the current lesson to show a QR code', 'err'); return; }
  if (!s.qr) {
    s.qr = { secret: randomHex(16), intervals: [] };
    // In a QR lesson, trainees who do not scan count as absent unless the trainer marks them.
    for (const t of rosterForCurrent()) if (!s.explicit?.[t.admNo]) { s.marks[t.admNo] = 'A'; s.names[t.admNo] = t.name; }
    renderRegister();
    toast('Trainees who don\'t scan are marked absent unless you mark them yourself');
  }
  const w0 = qrWindow();
  s.qr.intervals.push([w0, w0]);
  markDirty();
  // Upload straight away, so the Sheet can confirm students' scans from the first second.
  saveCurrent().then(() => { if (navigator.onLine) syncSheets({ silent: true, pull: false }); });
  renderQrLive();
  $('#lessonQrTitle').textContent = `${s.classCode} · ${s.unitCode} — ${periodLabel(s.period)}`;
  $('#lessonQrSub').textContent = `${s.unitName} · ${fmtDate(s.date)}`;
  $('#lessonQrDialog').showModal();
  let shown = null;
  const tick = async () => {
    if (state.current !== s) { closeLessonQR(); return; }
    const w = qrWindow();
    if (w !== shown) {
      shown = w;
      const iv = s.qr.intervals[s.qr.intervals.length - 1];
      if (iv[1] !== w) { iv[1] = w; markDirty(); saveCurrent().then(() => scheduleAutoSync()); }
      const t = await qrToken(s.qr.secret, s._id, w);
      const url = studentPageUrl() + '#l=' + b64url({ v: 1, s: s._id, c: s.classCode, un: s.unitName, p: periodLabel(s.period), n: s.trainerName, u: state.settings.sheetsUrl, w, t });
      const box = $('#lessonQrCode');
      box.innerHTML = qrSvg(url, 6);
      box.dataset.url = url;
    }
    const left = QR_WINDOW - ((Date.now() / 1000) % QR_WINDOW);
    $('#lessonQrBar').style.width = `${(left / QR_WINDOW) * 100}%`;
  };
  await tick();
  lessonQrTimer = setInterval(tick, 250);
}
/* Live count on the QR screen: who has checked in so far. */
function renderQrLive() {
  const s = state.current;
  const el = $('#lessonQrLive');
  if (!s || !el) return;
  const via = Object.entries(s.viaQr || {}).sort((a, b) => String(b[1]).localeCompare(String(a[1])));
  const total = activeTraineesFor(s.classCode).length;
  el.innerHTML = `<b>${via.length}</b> of ${total} checked in`
    + (via.length ? `<span>${via.slice(0, 4).map(([adm]) => esc((s.names?.[adm] || adm).split(' ')[0])).join(', ')}${via.length > 4 ? '…' : ''}</span>` : '<span>Waiting for the first scan…</span>');
}

function isLiveLesson() {
  const s = state.current;
  return $('#lessonQrDialog').open || !!(s && s.qr && s.date === todayISO());
}

/* One loop decides how often to check: every few seconds during a live lesson, else every minute. */
let liveTimer = null;
async function liveTick() {
  clearTimeout(liveTimer);
  const live = isLiveLesson();
  try {
    if (navigator.onLine && document.visibilityState === 'visible' && state.settings.sheetsUrl && !state.syncing) {
      if (live) {
        const res = await callSheets('GET', null, { action: 'pulse', token: state.settings.sheetsToken });
        // Fetch details only when the Sheet says something changed (or it cannot tell).
        if (!res.ok || res.last !== state.lastPulse) {
          state.lastPulse = res.last || '';
          await syncSheets({ silent: true });
        } else if ((await pendingSessions()).length) await syncSheets({ silent: true, pull: false });
      } else await syncSheets({ silent: true });
    }
  } catch { /* offline or slow network: try again next round */ }
  liveTimer = setTimeout(liveTick, live ? LIVE_FAST_MS : LIVE_SLOW_MS);
}

function closeLessonQR() {
  clearInterval(lessonQrTimer);
  lessonQrTimer = null;
  if ($('#lessonQrDialog').open) $('#lessonQrDialog').close();
  if (state.dirty) saveCurrent();
}

/* Fetch check-ins that reached the Sheet since the last check and save them into the
 * register for that lesson. Runs automatically whenever the phone is online. */
async function pullCheckins() {
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10); // students may sync months late
  const sessions = (await byPrefix('session:')).filter((s) => s.qr && s.date >= since);
  if (!sessions.length) return 0;
  const log = await getLocal('syncLog');
  const res = await callSheets('POST', { action: 'checkins', token: state.settings.sheetsToken, sessionIds: sessions.map((s) => s._id), since: log.checkinsSince || '' });
  if (!res.ok) throw new Error(res.error || 'Could not read QR check-ins');
  const synced = await sheetsSyncMap();
  let changed = 0, newOnOpen = 0;
  for (const stored of sessions) {
    const list = res.checkins?.[stored._id] || [];
    if (!list.length) continue;
    const open = state.current && state.current._id === stored._id;
    const doc = open ? state.current : stored;
    const wasSynced = !open && synced[stored._id] === stored._rev;
    doc.viaQr = doc.viaQr || {};
    let added = 0;
    for (const c of list) {
      if (doc.viaQr[c.admNo]) continue;
      doc.viaQr[c.admNo] = c.scannedAt || nowISO();
      if (!doc.explicit?.[c.admNo]) doc.marks[c.admNo] = 'P';
      if (!doc.names[c.admNo]) doc.names[c.admNo] = c.name || c.admNo;
      added++;
    }
    if (!added) continue;
    changed++;
    if (open) {
      newOnOpen += added;
      state.dirty = true; state.editSeq++;
      await saveCurrent();
      renderRegister();
    } else {
      try {
        const r = await db.put(doc);
        // The Sheet already has these check-ins, so a register that was in sync stays in sync.
        if (wasSynced) await updateLocal('sheetsSync', (d) => { d.map = d.map || {}; d.map[doc._id] = r.rev; }, { map: {} });
      } catch (e) { if (e.status !== 409) throw e; }
    }
  }
  if (res.serverTime) {
    // Ask again from 2 minutes earlier next time, so nothing written at the same moment is missed.
    await updateLocal('syncLog', (d) => { d.checkinsSince = new Date(new Date(res.serverTime).getTime() - 120000).toISOString(); });
  }
  if (newOnOpen) { toast(`${newOnOpen} student(s) checked in by QR`, 'ok'); renderQrLive(); navigator.vibrate?.(40); }
  return changed;
}

/* ---------------- backup ---------------- */
async function exportBackup() {
  const all = await db.allDocs();
  const ids = all.rows.map((r) => r.id).filter((id) => !id.startsWith('_design/'));
  const res = ids.length ? await db.bulkGet({ docs: ids.map((id) => ({ id })), revs: true }) : { results: [] };
  const docs = res.results.map((r) => r.docs[0]?.ok).filter(Boolean);
  const payload = { app: 'rvnp-attendance', version: APP_VERSION, exportedAt: nowISO(), deviceId: state.deviceId, trainer: trainerLabel(), docs };
  download(`attendance_backup_${state.deviceId}_${todayISO()}.json`, JSON.stringify(payload), 'application/json');
  toast(`Backup saved: ${docs.length} records`, 'ok');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'rvnp-attendance' || !Array.isArray(data.docs)) throw new Error('This is not an attendance backup file');
    // new_edits:false keeps revision history, so the same record is never duplicated
    // and edits made on two devices are merged like a normal sync.
    await db.bulkDocs(data.docs, { new_edits: false });
    await resolveConflicts();
    await loadRoster();
    refreshPending();
    toast(`Imported ${data.docs.length} records from ${data.trainer || data.deviceId}`, 'ok');
  } catch (e) { toast('Import failed: ' + e.message, 'err'); }
}

async function wipeData() {
  const pending = (await pendingSessions()).length;
  const warn = pending ? `\n\n${pending} register(s) have NOT been synced and will be lost.` : '';
  if (!confirm('Erase all attendance data and settings from this device?' + warn)) return;
  if (pending && prompt('Type ERASE to confirm') !== 'ERASE') return;
  await db.destroy();
  location.reload();
}

async function renderDbInfo() {
  const info = await db.info();
  $('#dbInfo').textContent = `Device ${state.deviceId} · ${info.doc_count} records stored · storage ${state.storage === 'protected' ? 'protected ✓' : state.storage === 'not-protected' ? 'not protected — add the app to your home screen' : 'status unknown'} · app v${APP_VERSION}`;
}

/* ---------------- tabs, network, wiring ---------------- */
function switchTab(name) {
  state.activeTab = name;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'sessions') renderSessions();
  if (name === 'reports') renderReport();
  if (name === 'settings') renderDbInfo();
}

function updateNet() {
  const on = navigator.onLine;
  const b = $('#netBadge');
  b.textContent = on ? 'Online' : 'Offline';
  b.className = 'badge ' + (on ? 'online' : 'offline');
}

function renderTrainerLabel() {
  const s = state.settings;
  $('#trainerLabel').textContent = s.trainerName ? `${s.trainerName}${s.trainerId ? ' · ' + s.trainerId : ''}` : 'Not set up yet — open Setup';
}

function fillSettingsForms() {
  const s = state.settings;
  $('#setName').value = s.trainerName; $('#setStaff').value = s.trainerId;
  $('#setLock').value = s.lockHours; $('#setDefault').value = s.defaultStatus;
  $('#setSheetsUrl').value = s.sheetsUrl; $('#setSheetsToken').value = s.sheetsToken;
  $('#rThreshold').value = s.threshold;
}

function wire() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); switchTab(g.dataset.goto); } });

  // Mark
  $('#sessionForm').addEventListener('submit', openFromForm);
  $('#fClass').addEventListener('change', renderUnitSelect);
  $('#traineeList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-s]'); if (!b) return;
    setMark(b.closest('.trow').dataset.adm, b.dataset.s);
  });
  $('#regSearch').addEventListener('input', renderRegister);
  $('#regNotes').addEventListener('input', () => { if (state.current) markDirty(); });
  $('#allPresent').addEventListener('click', () => setAll('P'));
  $('#allAbsent').addEventListener('click', () => setAll('A'));
  $('#saveReg').addEventListener('click', async () => { state.dirty = true; await saveCurrent(); toast('Register saved on this device', 'ok'); });
  $('#closeReg').addEventListener('click', closeRegister);
  $('#scanBtn').addEventListener('click', startScan);
  $('#lessonQrBtn').addEventListener('click', openLessonQR);
  $('#closeLessonQr').addEventListener('click', closeLessonQR);
  $('#lessonQrDialog').addEventListener('close', closeLessonQR);
  $('#stopScan').addEventListener('click', stopScan);
  $('#scanDialog').addEventListener('close', stopScan);

  // Registers
  $('#sClass').addEventListener('change', renderSessions);
  $('#sSync').addEventListener('change', renderSessions);
  $('#sessionList').addEventListener('click', (e) => { const it = e.target.closest('.sitem'); if (it) openSessionById(it.dataset.id); });

  // Reports
  $('#rClass').addEventListener('change', () => { renderReportUnitSelect(); renderReport(); });
  ['#rUnit', '#rFrom', '#rTo'].forEach((s) => $(s).addEventListener('change', renderReport));
  $('#rThreshold').addEventListener('change', async () => { await saveSettings({ threshold: Number($('#rThreshold').value) || 75 }); renderReport(); });
  $('#exportReport').addEventListener('click', exportReport);
  $('#exportRaw').addEventListener('click', exportRaw);
  $('#printQR').addEventListener('click', printQRCards);

  // Setup
  $('#trainerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveSettings({ trainerName: $('#setName').value.trim(), trainerId: $('#setStaff').value.trim(),
      lockHours: Number($('#setLock').value) || 48, defaultStatus: $('#setDefault').value });
    toast('Trainer details saved', 'ok');
  });
  const saveSheets = () => saveSettings({ sheetsUrl: $('#setSheetsUrl').value.trim(), sheetsToken: $('#setSheetsToken').value.trim() });
  $('#sheetsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await saveSheets();
    toast('Saved — downloading class lists…', 'ok');
    await pullRoster();
    syncSheets({ silent: true });
  });
  $('#testSheets').addEventListener('click', async () => { await saveSheets(); testSheets(); });
  $('#studentLinkBtn').addEventListener('click', async () => {
    await saveSheets();
    if (!state.settings.sheetsUrl) { toast('Add the web app URL first', 'err'); return; }
    const url = studentPageUrl() + '#u=' + encodeURIComponent(state.settings.sheetsUrl);
    $('#studentLinkCode').innerHTML = qrSvg(url, 4);
    $('#studentLink').value = url;
    $('#studentLinkDialog').showModal();
  });
  $('#closeStudentLink').addEventListener('click', () => $('#studentLinkDialog').close());
  $('#copyStudentLink').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#studentLink').value); toast('Link copied — share it in the class WhatsApp group', 'ok'); }
    catch { $('#studentLink').select(); toast('Select and copy the link'); }
  });
  $('#pullRoster').addEventListener('click', async () => { await saveSheets(); pullRoster(); });
  $('#importTrainees').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const rows = parseCSV(await f.text());
      const r = await replaceRoster({ trainees: rows, classes: [] }, ['class', 'trainee']);
      toast(`Imported ${r.trainees} trainees in ${r.classes} classes`, 'ok');
    } catch (err) { toast('Import failed: ' + err.message, 'err'); }
    e.target.value = '';
  });
  $('#importUnits').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const r = await replaceRoster({ units: parseCSV(await f.text()) }, ['unit']);
      toast(`Imported ${r.units} units`, 'ok');
    } catch (err) { toast('Import failed: ' + err.message, 'err'); }
    e.target.value = '';
  });
  $('#exportBackup').addEventListener('click', exportBackup);
  $('#importBackup').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) await importBackup(f); e.target.value = ''; renderDbInfo(); });
  $('#wipeData').addEventListener('click', wipeData);

  // Sync + network
  $('#syncBtn').addEventListener('click', () => syncSheets());
  window.addEventListener('online', () => { updateNet(); syncSheets({ silent: true }); maybeRefreshRoster(); });
  window.addEventListener('offline', updateNet);
  // Automatic sync: fast during a live lesson, once a minute otherwise, and whenever the app comes back into view.
  liveTimer = setTimeout(liveTick, 1500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && state.dirty) saveCurrent();
    if (document.visibilityState === 'visible' && navigator.onLine) liveTick();
  });
  window.addEventListener('pagehide', () => { if (state.dirty) saveCurrent(); });

  db.changes({ since: 'now', live: true }).on('change', (c) => {
    if (c.id.startsWith('_local/')) return;
    changedIds.add(c.id);
    onDbChange();
  });
}

async function init() {
  fillSelect($('#fPeriod'), PERIODS.map((p) => ({ value: p.code, label: p.label })));
  $('#fDate').value = todayISO();
  await loadDevice();
  await protectStorage();
  await loadSettings();
  fillSettingsForms();
  renderTrainerLabel();
  updateNet();
  wire();
  await loadRoster();
  await resolveConflicts();
  refreshPending();
  renderSheetsStatus();
  if (!state.settings.trainerName) switchTab('settings');
  if (navigator.onLine) setTimeout(() => { syncSheets({ silent: true }); maybeRefreshRoster(); }, 2000);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
    // When a new version of the app arrives, switch to it right away (unless something is unsaved or the QR is showing).
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (!state.dirty && !$('#lessonQrDialog').open) location.reload();
      else toast('App updated — it will refresh next time you open it');
    });
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

init().catch((e) => { console.error(e); toast('Start-up error: ' + e.message, 'err'); });
