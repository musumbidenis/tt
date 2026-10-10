/* RVNP Attendance Register — offline-first, for the ICT Department.
 * Storage: PouchDB (IndexedDB) on the device.
 * Sync:    to the online database (Cloudflare Worker + D1; the older Apps Script + Google Sheet also works).
 *          Staff sign in once with their staff code and PIN; registers are pushed whenever the phone
 *          is online, and class lists and loading come back from the server.
 * Roles:   TRAINER marks; HOD approves term registers; MIS sets up terms, loading and class lists.
 */
'use strict';

const APP_VERSION = '4.4.3';
const db = new PouchDB('rvnp_attendance', { auto_compaction: true });

const STATUSES = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };
// Live updates: while the lesson QR is on screen the app asks the server a tiny "anything new?" every few
// seconds; with today's QR register open, every 15 seconds; otherwise once a minute. Only while online and on screen.
const LIVE_FAST_MS = window.__liveFastMs || 4000;
const LIVE_SLOW_MS = window.__liveSlowMs || 60000;
const LIVE_MID_MS = window.__liveMidMs || Math.min(15000, LIVE_SLOW_MS);
// While the QR is shown, the register (whose QR record grows every 20 s) is uploaded at most every 2 minutes,
// and again when the QR is closed. The server accepts genuine codes for "right now" without waiting for it.
const QR_UPLOAD_MS = window.__qrUploadMs || 120000;
const MAX_LESSONS_PER_WEEK = 3; // the register has 3 lesson cells per week
// The college timetable: six slots a day. Two slots back to back make a double lesson (two cells in the register).
const SLOTS = [['7.30', '9.00'], ['9.00', '10.30'], ['10.30', '12.00'], ['13.00', '14.30'], ['14.30', '16.00'], ['16.00', '17.30']];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const LUNCH_AFTER = 3; // a double is two slots in the same morning or afternoon
const KIND_LABEL = { lesson: 'Lesson', cat: 'CAT', extra: 'Extra CAT attendance' };
const PERIODS = [
  { code: 'L1', label: 'Lesson 1' }, { code: 'L2', label: 'Lesson 2' },
  { code: 'L3', label: 'Lesson 3' }, { code: 'L4', label: 'Lesson 4' },
  { code: 'L5', label: 'Lesson 5' }, { code: 'L6', label: 'Lesson 6' },
  { code: 'EV', label: 'Evening' },
];
const DEFAULT_SETTINGS = { lockHours: 48, defaultStatus: 'P', threshold: 75, latePct: 50, excusedPct: 100, serverUrl: '', reportView: '' };

const state = {
  settings: { ...DEFAULT_SETTINGS },
  auth: null,             // { token, staff: { code, name, roles }, mustChange }
  deviceId: '',
  classes: [], units: [], trainees: [], addreqs: [],
  meta: { term: null, weeks: [], pending: [], rejected: [], aliases: [], staff: {} },
  current: null,          // session document open in the Mark tab
  dirty: false,           // unsaved changes in the open register
  editSeq: 0,             // bumps on every edit, so a save never swallows a newer edit
  editReasonGiven: false, // reason already captured for a locked register
  syncing: false,
  activeTab: 'mark',
  report: null,           // last report shown, for export
  reportFilter: 'all',
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
const slotNo = (period) => { const m = /^L(\d)$/.exec(period || ''); return m ? Number(m[1]) : 0; };
/** "Lesson 2 · 9.00–10.30", or for a double "Lessons 1–2 · 7.30–10.30". */
function slotLabel(period, slots = 1) {
  const n = slotNo(period);
  if (!n || !SLOTS[n - 1]) return periodLabel(period);
  const end = SLOTS[Math.min(SLOTS.length, n + (slots === 2 ? 1 : 0)) - 1][1];
  return (slots === 2 ? `Lessons ${n}–${n + 1}` : `Lesson ${n}`) + ` · ${SLOTS[n - 1][0]}–${end}`;
}
const kindOf = (s) => (s && ['cat', 'extra'].includes(s.kind) ? s.kind : 'lesson');
/** What a register is: "Lesson 2 · 9.00–10.30" or "CAT 1 · Lesson 3 · 10.30–12.00". */
const sessionLabel = (s) => (kindOf(s) === 'lesson' ? '' : `${s.title || KIND_LABEL[kindOf(s)]} · `) + slotLabel(s.period, Number(s.slots) === 2 ? 2 : 1);
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso + 'T00:00:00'); return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); };
const fmtShort = (iso) => { if (!iso) return ''; const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
const fmtTime = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const clone = (o) => JSON.parse(JSON.stringify(o));
const lower = (s) => String(s ?? '').trim().toLowerCase();
const me = () => state.auth?.staff || null;
const hasRole = (r) => !!me()?.roles?.includes(r);
const trainerLabel = () => me()?.name || 'Unknown trainer';
/* The server: the address in config.js, unless this phone was given another one. An old Google Apps Script
 * address saved on the phone gives way once config.js points at the new database. */
const OLD_SERVER = /script\.google(usercontent)?\.com/;
const serverUrl = () => {
  const own = state.settings.serverUrl || '', cfg = window.ATTENDANCE_CONFIG?.serverUrl || window.ATTENDANCE_CONFIG?.sheetsUrl || '';
  return own && !(OLD_SERVER.test(own) && cfg && !OLD_SERVER.test(cfg)) ? own : cfg;
};

let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3500);
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
  const { _id, _rev, ...rest } = await getLocal('settings');
  state.settings = { ...DEFAULT_SETTINGS, ...rest };
}
async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  await updateLocal('settings', (d) => Object.assign(d, state.settings));
}
async function loadAuth() {
  const d = await getLocal('auth');
  state.auth = d.token ? { token: d.token, staff: d.staff, mustChange: !!d.mustChange } : null;
}
async function saveAuth(a) {
  state.auth = a;
  await updateLocal('auth', (d) => { d.token = a?.token || ''; d.staff = a?.staff || null; d.mustChange = !!a?.mustChange; });
  renderIdentity();
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
  state.addreqs = await byPrefix('addreq:');
  const { _id, _rev, ...meta } = await getLocal('meta', { term: null, weeks: [], pending: [], rejected: [], aliases: [], staff: {} });
  state.meta = { term: null, weeks: [], pending: [], rejected: [], aliases: [], staff: {}, ...meta };
  renderClassSelects();
  $('#emptyRoster').hidden = markableUnits().length > 0;
  $('#rosterInfo').textContent = state.classes.length
    ? `On this phone: ${markClasses().length} of your classes, ${markableUnits().length} units${state.meta.term ? ` · ${state.meta.term.name}` : ''}.`
    : 'No class lists on this phone yet.';
  renderWeekSelect();
}

/** Units this person marks: their own loading, or every unit when no loading has been uploaded. */
function markableUnits() {
  if (!(hasRole('TRAINER') || hasRole('HOD'))) return [];
  const loaded = state.units.some((u) => u.trainerCode);
  return loaded ? state.units.filter((u) => lower(u.trainerCode) === lower(me()?.code)) : state.units;
}
const markClasses = () => { const set = new Set(markableUnits().map((u) => u.classCode)); return state.classes.filter((c) => set.has(c.code)); };
/** Units whose reports this person may open: their own, or all for the HOD and MIS Officer. */
function reportUnits() { return hasRole('HOD') || hasRole('MIS') ? state.units : markableUnits(); }
const isMyUnit = (u) => !!u && (!u.trainerCode || lower(u.trainerCode) === lower(me()?.code));

function normaliseRoster(input) {
  const classes = (input.classes || []).filter((c) => c.code).map((c) => ({
    _id: 'class:' + c.code, type: 'class', code: c.code, name: c.name || c.code, level: c.level || '', misClass: c.misClass || '' }));
  const known = new Set(classes.map((c) => c.code));
  const trainees = (input.trainees || []).filter((t) => t.admNo && t.classCode).map((t) => ({
    _id: 'trainee:' + t.admNo, type: 'trainee', admNo: t.admNo, name: t.name || t.admNo, classCode: t.classCode, active: t.active !== false }));
  const units = (input.units || []).filter((u) => u.classCode && u.code).map((u) => ({
    _id: `unit:${u.classCode}:${u.code}`, type: 'unit', classCode: u.classCode, code: u.code, name: u.name || u.code,
    trainerCode: u.trainerCode || '', trainerName: u.trainerName || '', lessonsPerWeek: Number(u.lessonsPerWeek) || 2, hoursPerWeek: Number(u.hoursPerWeek) || 3 }));
  for (const x of [...trainees, ...units]) {
    if (!known.has(x.classCode)) { known.add(x.classCode); classes.push({ _id: 'class:' + x.classCode, type: 'class', code: x.classCode, name: x.classCode, level: '', misClass: '' }); }
  }
  return { classes, units, trainees };
}

/* Replace the roster docs on this device with the server's. */
async function replaceRoster(incoming) {
  const norm = normaliseRoster(incoming);
  const lists = { class: norm.classes, unit: norm.units, trainee: norm.trainees };
  const docs = [];
  for (const kind of Object.keys(lists)) {
    const existing = await byPrefix(kind + ':');
    const byId = new Map(existing.map((d) => [d._id, d]));
    const seen = new Set();
    for (const doc of lists[kind]) {
      if (seen.has(doc._id)) continue;
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
  if (docs.length) {
    const res = await db.bulkDocs(docs);
    const failed = res.filter((r) => r.error);
    if (failed.length) throw new Error(`${failed.length} roster records could not be saved`);
  }
  return { classes: norm.classes.length, units: norm.units.length, trainees: norm.trainees.length };
}

/* ---------------- CSV ---------------- */
function toCSV(rows) {
  const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
function download(filename, content, type = 'text/csv') {
  const blob = content instanceof Blob ? content : new Blob([type === 'text/csv' ? '﻿' + content : content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

/* ---------------- term weeks ---------------- */
function weekInfo(date) {
  const weeks = state.meta.weeks || [];
  if (!state.meta.term || !weeks.length || !date) return { week: null, term: null };
  const i = weeks.indexOf(TermReport.mondayOf(date));
  return { week: i === -1 ? null : i + 1, term: state.meta.term };
}
function termRange() {
  const w = state.meta.weeks || [];
  if (!w.length) return null;
  const end = new Date(w[w.length - 1] + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 6);
  return { from: w[0], to: end.toISOString().slice(0, 10) };
}
function renderWeekHint() {
  const el = $('#weekHint'); if (!el) return;
  const { week, term } = weekInfo($('#fDate').value || $('#fWeek').value);
  el.className = 'hint' + (term && !week ? ' bad' : '');
  const cats = term?.catWeeks || [];
  el.textContent = !term ? '' : week ? `Week ${week} of ${(state.meta.weeks || []).length || 12} · ${term.name}${cats.includes(week) ? ' · CAT week' : ''}` : `Not a teaching week of ${term.name}`;
}

/* ---------------- Mark tab ---------------- */
const sessionId = (date, classCode, unitCode, period, kind = 'lesson') => `session:${date}:${classCode}:${unitCode}:${period}${kind === 'lesson' ? '' : ':' + kind}`;
const unitsFor = (classCode, list = markableUnits()) => list.filter((u) => u.classCode === classCode);
const activeTraineesFor = (classCode) => state.trainees.filter((t) => t.classCode === classCode && t.active !== false);

function fillSelect(sel, options, value, placeholder) {
  const prev = value ?? sel.value;
  sel.innerHTML = (placeholder ? `<option value="">${esc(placeholder)}</option>` : '')
    + options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  if (options.some((o) => o.value === prev)) sel.value = prev;
}
const classLabel = (c) => c.misClass && c.misClass !== c.code ? `${c.code} (${c.misClass})` : (c.name && c.name !== c.code ? `${c.code} — ${c.name}` : c.code);

function renderClassSelects() {
  const mark = markClasses().map((c) => ({ value: c.code, label: classLabel(c) }));
  fillSelect($('#fClass'), mark, undefined, mark.length ? null : 'No classes');
  fillSelect($('#sClass'), mark, undefined, 'All classes');
  const rset = new Set(reportUnits().map((u) => u.classCode));
  const rep = state.classes.filter((c) => rset.has(c.code)).map((c) => ({ value: c.code, label: classLabel(c) }));
  fillSelect($('#rClass'), rep, undefined, rep.length ? null : 'No classes');
  renderUnitSelect();
  renderReportUnitSelect();
  applyWantedReport();
}
/* A report asked for (e.g. from the HOD's approval list) before the class lists finished downloading
 * is opened as soon as its class and unit are available. */
function applyWantedReport() {
  const w = state.wantReport;
  if (!w || ![...$('#rClass').options].some((o) => o.value === w.classCode)) return false;
  $('#rClass').value = w.classCode;
  renderReportUnitSelect();
  if (![...$('#rUnit').options].some((o) => o.value === w.unitCode)) return false;
  $('#rUnit').value = w.unitCode;
  state.wantReport = null;
  if (state.activeTab === 'reports') renderReport();
  return true;
}
function openReport(classCode, unitCode) {
  state.wantReport = { classCode, unitCode };
  switchTab('reports');
  if (!applyWantedReport()) $('#reportSummary').innerHTML = '<p class="empty">Loading the class lists…</p>';
}
function renderUnitSelect() {
  const opts = unitsFor($('#fClass').value).map((u) => ({ value: u.code, label: u.code + ' — ' + u.name }));
  fillSelect($('#fUnit'), opts, undefined, opts.length ? null : 'No units for this class');
  renderTimetable();
}

/* ---------------- choosing the lesson: week and timetable ---------------- */
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Weeks to choose from: the term's 12 teaching weeks, or (no term yet) the last few weeks. */
function weekOptions() {
  const weeks = state.meta.weeks || [], cats = state.meta.term?.catWeeks || [];
  const range = (m) => `${fmtShort(m)} – ${fmtShort(addDays(m, 4))}`;
  if (weeks.length) return weeks.map((m, i) => ({ value: m, label: `Week ${i + 1} · ${range(m)}${cats.includes(i + 1) ? ' · CAT week' : ''}` }));
  const now = TermReport.mondayOf(todayISO());
  return [0, 1, 2, 3, 4, 5].map((k) => addDays(now, -7 * k)).map((m) => ({ value: m, label: `Week of ${range(m)}` }));
}
/** The current teaching week, or the nearest one before it (break weeks), or week 1 before the term starts. */
function currentWeek() {
  const opts = weekOptions().map((o) => o.value).sort();
  const now = TermReport.mondayOf(todayISO());
  return [...opts].reverse().find((m) => m <= now) || opts[0] || now;
}
function renderWeekSelect(keep = true) {
  fillSelect($('#fWeek'), weekOptions(), keep && $('#fWeek').value ? $('#fWeek').value : currentWeek());
  if (!$('#fWeek').value) $('#fWeek').value = currentWeek();
  renderKind();
}
const chosenKind = () => ($$('input[name="fKind"]').find((r) => r.checked) || {}).value || 'lesson';
const isCatWeek = (monday) => { const i = (state.meta.weeks || []).indexOf(monday); return i !== -1 && (state.meta.term?.catWeeks || []).includes(i + 1); };
function renderKind() {
  const cat = isCatWeek($('#fWeek').value);
  const catRadio = $('input[name="fKind"][value="cat"]');
  catRadio.disabled = !cat;
  $('#kindCat').classList.toggle('off', !cat);
  $('#kindCat').title = cat ? '' : 'CAT registers are for the CAT weeks the MIS Officer set';
  if (!cat && catRadio.checked) $('input[name="fKind"][value="lesson"]').checked = true;
  $('#fTitleBox').hidden = chosenKind() !== 'extra';
  renderTimetable();
}

/** Mon–Fri × 6 slots for the chosen week: registers already made, and the slot(s) chosen now. */
async function renderTimetable() {
  const box = $('#timetable'); if (!box) return;
  const monday = $('#fWeek').value, classCode = $('#fClass').value, unitCode = $('#fUnit').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monday || '')) { box.innerHTML = ''; return; }
  const seq = (renderTimetable.seq = (renderTimetable.seq || 0) + 1);
  const days = DAYS.map((d, k) => ({ name: d, date: addDays(monday, k) }));
  const r = monday ? await db.allDocs({ include_docs: true, startkey: 'session:' + monday, endkey: 'session:' + addDays(monday, 4) + '￿' }) : { rows: [] };
  if (seq !== renderTimetable.seq) return;
  const mineHere = {}, elsewhere = {};
  for (const { doc } of r.rows) {
    if (!doc || doc.type !== 'session') continue;
    const n = slotNo(doc.period); if (!n) continue;
    const span = Number(doc.slots) === 2 ? [n, n + 1] : [n];
    for (const k of span) {
      const key = `${doc.date}|${k}`;
      if (doc.classCode === classCode && doc.unitCode === unitCode) mineHere[key] = { doc, first: k === n };
      else (elsewhere[key] = elsewhere[key] || []).push(doc);
    }
  }
  // The chosen slot belongs to one class, unit and week; a background refresh of the lists keeps it.
  const p = state.pick;
  const sel = p && p.monday === monday && (!p.classCode || (p.classCode === classCode && p.unitCode === unitCode)) ? p : null;
  const today = todayISO();
  let html = '<div class="tt-corner"></div>' + days.map((d) => `<div class="tt-day${d.date === today ? ' today' : ''}"><b>${d.name}</b><span>${esc(fmtShort(d.date))}</span></div>`).join('');
  SLOTS.forEach(([a, b], i) => {
    const n = i + 1;
    if (n === LUNCH_AFTER + 1) html += `<div class="tt-lunch">Lunch ${SLOTS[LUNCH_AFTER - 1][1]}–${a}</div>`;
    html += `<div class="tt-time"><b>${a}</b><span>${b}</span></div>`;
    for (const d of days) {
      const key = `${d.date}|${n}`, have = mineHere[key], other = elsewhere[key];
      const picked = sel && sel.date === d.date && n >= sel.slot && n < sel.slot + sel.slots;
      const future = d.date > today;
      if (have) {
        const k = kindOf(have.doc);
        const c = countMarks(have.doc);
        html += `<button type="button" class="tt-cell have ${k}${have.first ? '' : ' cont'}" data-open="${esc(have.doc._id)}" title="Open this register">
          <b>${have.first ? esc(k === 'lesson' ? (Number(have.doc.slots) === 2 ? 'Double' : 'Marked') : (have.doc.title || KIND_LABEL[k])) : '↑'}</b>${have.first ? `<span>${c.P + c.L}/${c.P + c.L + c.A + c.E}</span>` : ''}</button>`;
      } else {
        html += `<button type="button" class="tt-cell${picked ? ' picked' : ''}${picked && n > sel.slot ? ' cont' : ''}${future ? ' future' : ''}" data-date="${d.date}" data-slot="${n}" ${future ? 'disabled' : ''}
          aria-pressed="${picked}">${other ? `<span class="other">${esc(other.map((o) => o.classCode.split(' ').pop() + ' ' + o.unitCode).join(', '))}</span>` : ''}</button>`;
      }
    }
  });
  box.innerHTML = html;
  // The button says exactly what will open.
  const btn = $('#openBtn');
  if (sel) {
    $('#fDate').value = sel.date; $('#fPeriod').value = 'L' + sel.slot; $('#fSlots').value = String(sel.slots);
    btn.disabled = false;
    const dayName = new Date(sel.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
    btn.textContent = `Open ${sel.slots === 2 ? 'double ' : ''}${chosenKind() === 'lesson' ? 'register' : KIND_LABEL[chosenKind()]} · ${dayName} ${fmtShort(sel.date)} · ${slotLabel('L' + sel.slot, sel.slots).split(' · ')[1]}`;
  } else {
    $('#fDate').value = ''; $('#fPeriod').value = '';
    btn.disabled = true;
    btn.textContent = 'Tap a slot above (tap the next one too for a double)';
  }
  renderWeekHint();
}
function pickSlot(date, slot) {
  const monday = TermReport.mondayOf(date), p = state.pick;
  if (p && p.monday === monday && p.date === date && p.classCode === $('#fClass').value && p.unitCode === $('#fUnit').value) {
    if (slot === p.slot && p.slots === 1) { state.pick = null; return renderTimetable(); }           // tap again: clear
    const sameHalf = (a, b) => (a <= LUNCH_AFTER) === (b <= LUNCH_AFTER);
    if (slot === p.slot + 1 && p.slots === 1 && sameHalf(slot, p.slot)) { p.slots = 2; return renderTimetable(); }   // next slot: double
    if (slot === p.slot - 1 && p.slots === 1 && sameHalf(slot, p.slot)) { p.slot = slot; p.slots = 2; return renderTimetable(); }
    if (p.slots === 2 && (slot === p.slot || slot === p.slot + 1)) { p.slots = 1; p.slot = slot === p.slot ? p.slot + 1 : p.slot; return renderTimetable(); }
  }
  state.pick = { monday, date, slot, slots: 1, classCode: $('#fClass').value, unitCode: $('#fUnit').value };
  return renderTimetable();
}

async function openFromForm(e) {
  e?.preventDefault();
  const date = $('#fDate').value, classCode = $('#fClass').value, unitCode = $('#fUnit').value, period = $('#fPeriod').value;
  const slots = Number($('#fSlots').value) === 2 ? 2 : 1, kind = chosenKind(), title = $('#fTitle').value.trim();
  if (!date || !classCode || !unitCode || !period) { toast('Choose a class, unit and a slot on the timetable first', 'err'); return; }
  if (kind === 'extra' && !title) { toast('Give this attendance a title, e.g. "CAT 1 make-up"', 'err'); $('#fTitle').focus(); return; }
  if (date > todayISO()) { toast('That day has not come yet', 'err'); return; }
  if (state.dirty) await saveCurrent();
  const id = sessionId(date, classCode, unitCode, period, kind);
  let doc;
  try { doc = await db.get(id); }
  catch (err) {
    if (err.status !== 404) throw err;
    const { week, term } = weekInfo(date);
    if (term && !week) { toast(`${fmtDate(date)} is not in a teaching week of ${term.name}`, 'err'); return; }
    if (kind === 'cat' && !isCatWeek(TermReport.mondayOf(date))) { toast('CAT registers are for the CAT weeks set by the MIS Officer. Use "Extra CAT attendance" for other weeks.', 'err'); return; }
    const sameWeek = (await byPrefix('session:')).filter((s) => s.classCode === classCode && s.unitCode === unitCode
      && TermReport.mondayOf(s.date) === TermReport.mondayOf(date));
    const n = slotNo(period);
    const clash = sameWeek.find((s) => s.date === date && (() => { const a = slotNo(s.period), b = a + (Number(s.slots) === 2 ? 1 : 0); return n <= b && n + slots - 1 >= a; })());
    if (clash) { toast(`That slot already has a register (${sessionLabel(clash)}); opening it`); setCurrent(clash); return; }
    if (kind === 'lesson') {
      const used = sameWeek.filter((s) => kindOf(s) === 'lesson').reduce((a, s) => a + (Number(s.slots) === 2 ? 2 : 1), 0);
      if (used + slots > MAX_LESSONS_PER_WEEK) {
        toast(`${unitCode} already has ${used} lesson(s) in ${week ? 'week ' + week : 'this week'}. The register has room for ${MAX_LESSONS_PER_WEEK} a week${slots === 2 ? ' (a double counts as two)' : ''}; open one of those instead.`, 'err');
        return;
      }
    }
    if (!rosterFor(classCode).length && navigator.onLine && state.auth) {
      toast('No students on this phone for ' + classCode + ' yet — downloading class lists…');
      await pullRoster({ silent: true });
    }
    const unit = state.units.find((u) => u.classCode === classCode && u.code === unitCode);
    const cls = state.classes.find((c) => c.code === classCode);
    const marks = {}, names = {};
    for (const t of rosterFor(classCode)) { marks[t.admNo] = state.settings.defaultStatus || 'P'; names[t.admNo] = t.name; }
    const catNo = kind === 'cat' ? (state.meta.term?.catWeeks || []).indexOf(week) + 1 : 0;
    doc = {
      _id: id, type: 'session', date, classCode, className: cls?.name || classCode,
      unitCode, unitName: unit?.name || unitCode, period, slots, kind, title: kind === 'cat' ? (title || `CAT ${catNo || ''}`.trim()) : kind === 'extra' ? title : '',
      periodLabel: slotLabel(period, slots),
      termId: term?.id || '', week: week || '',
      trainerId: me()?.code || '', trainerName: trainerLabel(), deviceId: state.deviceId,
      marks, names, explicit: {}, notes: '', createdAt: nowISO(), updatedAt: nowISO(), editLog: [],
    };
  }
  state.pick = null;
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
  goLive();
}

/** Class list for marking: official list + students waiting for approval (yours and other trainers'), minus rejected. */
/** A combined lesson in the loading ("ICT L6ICT-26J, ICT L6ICT-26M-CT") takes its students from each class it names. */
function classParts(classCode) {
  const parts = String(classCode).split(/\s*[,/]\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [classCode];
  const prefix = (parts[0].match(/^([A-Z]+)\s/) || [])[1];
  return [classCode, ...parts.map((x) => (prefix && !/\s/.test(x) ? `${prefix} ${x}` : x))];
}
function rosterFor(classCode) {
  const rejected = new Set(state.meta.rejected.filter((r) => r.classCode === classCode).map((r) => lower(r.admNo)));
  const out = new Map();
  for (const code of classParts(classCode)) {
    for (const t of activeTraineesFor(code)) if (!out.has(lower(t.admNo))) out.set(lower(t.admNo), { admNo: t.admNo, name: t.name, pending: false });
  }
  const pend = [...state.meta.pending.filter((p) => p.classCode === classCode),
    ...state.addreqs.filter((a) => a.classCode === classCode && !a.done)];
  for (const p of pend) {
    const k = lower(p.admNo);
    if (!out.has(k) && !rejected.has(k)) out.set(k, { admNo: p.admNo, name: p.name, pending: true });
  }
  return [...out.values()];
}

function rosterForCurrent() {
  const s = state.current;
  const list = rosterFor(s.classCode).map((t) => ({ ...t, unlisted: false }));
  // Students who reach the class list during today's lesson join it with the default mark; older lessons are left as marked.
  if (s.date === todayISO()) for (const t of list) if (!s.marks[t.admNo]) { s.marks[t.admNo] = s.qr ? 'A' : (state.settings.defaultStatus || 'P'); s.names[t.admNo] = t.name; }
  const listed = new Set(list.map((t) => t.admNo));
  const rejected = new Set(state.meta.rejected.filter((r) => r.classCode === s.classCode).map((r) => r.admNo));
  for (const adm of Object.keys(s.marks || {})) {
    if (!listed.has(adm) && !rejected.has(adm)) list.push({ admNo: adm, name: s.names?.[adm] || adm, unlisted: true });
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
  const wk = s.week ? `Week ${s.week}, ` : '';
  $('#regSub').textContent = `${s.unitName} — ${wk}${fmtDate(s.date)}, ${sessionLabel(s)}${isLocked(s) ? ' · locked' : ''}`;
  $('#register').dataset.kind = kindOf(s);
  const q = $('#regSearch').value.trim().toLowerCase();
  const rows = rosterForCurrent().filter((t) => !q || t.name.toLowerCase().includes(q) || t.admNo.toLowerCase().includes(q));
  $('#traineeList').innerHTML = rows.length ? rows.map((t) => {
    const st = s.marks?.[t.admNo] || '';
    return `<li class="trow${t.unlisted ? ' unlisted' : ''}" data-adm="${esc(t.admNo)}">
      <div class="tinfo"><span class="tname">${esc(t.name)}${qrTag(s, t.admNo)}${t.pending ? ' <span class="ptag" title="Waiting for the MIS Officer to approve">Pending</span>' : ''}</span><span class="tadm">${esc(t.admNo)}</span></div>
      <div class="seg" role="group" aria-label="Status for ${esc(t.name)}">
        ${Object.keys(STATUSES).map((k) => `<button type="button" data-s="${k}" class="${st === k ? 'on' : ''}" title="${STATUSES[k]}" aria-pressed="${st === k}">${k}</button>`).join('')}
      </div></li>`;
  }).join('') : q ? '<li class="empty">No trainees match.</li>'
    : `<li class="empty roster-empty"><b>No students on ${esc(s.classCode)}'s list on this phone yet.</b>
      <span>Tap <b>Download class lists</b>. If it stays empty, the MIS Officer needs to upload this class's register under Manage → Class lists, with stream ${esc(s.classCode.split(' ').pop())} ticked.</span>
      <button type="button" class="btn" data-action="pull-roster">Download class lists</button></li>`;
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
  if (!s.names[adm]) s.names[adm] = rosterForCurrent().find((t) => t.admNo === adm)?.name || adm;
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
const shownInGrid = new WeakSet();
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
  if (!s.trainerId) { s.trainerName = trainerLabel(); s.trainerId = me()?.code || ''; }
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await db.put(clone(s));
      s._rev = r.rev;
      if (state.current === s && state.editSeq !== seq) return; // newer edits: the pending timer saves them
      state.dirty = false;
      setSaveState('Saved on this device', 'ok');
      refreshPending();
      scheduleAutoSync();
      if (!shownInGrid.has(s)) { shownInGrid.add(s); renderTimetable(); } // a new register appears on the timetable
      return;
    } catch (e) {
      if (e.status === 409) { const latest = await db.get(s._id); s._rev = latest._rev; continue; }
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

/* ---------------- adding a student while marking (pending until the MIS Officer approves) ---------------- */
function openAddStudent() {
  if (!state.current) { toast('Open a register first', 'err'); return; }
  $('#addStudentForm').reset();
  $('#asMsg').textContent = '';
  $('#addStudentDialog').showModal();
  setTimeout(() => $('#asAdm').focus(), 50);
}
async function saveAddStudent(e) {
  e.preventDefault();
  const s = state.current; if (!s) return;
  const adm = $('#asAdm').value.trim().toUpperCase().replace(/\s+/g, ''), name = $('#asName').value.replace(/\s+/g, ' ').trim();
  const msg = $('#asMsg');
  if (!Imports.isAdm(adm)) { msg.textContent = 'Use the admission number as written on the class list, for example L6CS/25S/305999.'; return; }
  if (name.length < 3) { msg.textContent = 'Enter the student\'s full name.'; return; }
  if (rosterForCurrent().some((t) => lower(t.admNo) === lower(adm) && !t.unlisted)) { msg.textContent = `${adm} is already on this class list.`; return; }
  const elsewhere = state.trainees.find((t) => lower(t.admNo) === lower(adm) && t.classCode !== s.classCode);
  if (!(await ensureEditable())) return;
  const id = `addreq:${s.classCode}|${adm}`;
  let doc;
  try { doc = await db.get(id); } catch { doc = { _id: id }; }
  Object.assign(doc, { type: 'addreq', admNo: adm, name, classCode: s.classCode, reason: $('#asReason').value, addedAt: nowISO(),
    addedBy: me()?.code || '', sentAt: '', done: false, note: elsewhere ? `On the list of ${elsewhere.classCode}` : '' });
  await db.put(doc);
  state.addreqs = await byPrefix('addreq:');
  s.marks[adm] = $('#asMark').value;
  s.names[adm] = name;
  s.explicit = { ...(s.explicit || {}), [adm]: true };
  $('#addStudentDialog').close();
  renderRegister();
  markDirty();
  toast(elsewhere ? `${name} added as pending. They're on ${elsewhere.classCode}'s list; the MIS Officer will decide.` : `${name} added as pending. The MIS Officer will approve them.`, 'ok');
}

/* ---------------- QR scanning of ID cards ---------------- */
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
    if ('BarcodeDetector' in window && (await BarcodeDetector.getSupportedFormats()).includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] });
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
  const t = rosterForCurrent().find((x) => x.admNo.toLowerCase() === adm.toLowerCase());
  const out = $('#scanResult');
  if (!t) {
    const other = state.trainees.find((x) => x.admNo.toLowerCase() === adm.toLowerCase());
    out.textContent = other ? `${other.name} is in ${other.classCode}, not this class` : `Unknown card: ${adm}`;
    out.className = 'scan-result err';
    navigator.vibrate?.([60, 60, 60]);
    return;
  }
  const status = $('#scanAs').value;
  if (!(await setMark(t.admNo, status))) return;
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
      <span class="s-title">${esc(s.classCode)} · ${esc(s.unitCode)} — ${esc(sessionLabel(s))}</span>
      <span class="s-badges">
        <span class="pill ${synced ? 'synced' : 'pending'}">${synced ? 'Sent' : 'Waiting to sync'}</span>
        ${isLocked(s) ? '<span class="pill locked">Locked</span>' : ''}
      </span>
      <span class="s-meta">${s.week ? `Week ${s.week}, ` : ''}${esc(fmtDate(s.date))} · P ${c.P} · A ${c.A} · L ${c.L} · E ${c.E}</span>
    </button>`;
  }).join('') : '<p class="empty">No registers yet. Marked registers appear here.</p>';
}

async function openSessionById(id) {
  if (state.dirty) await saveCurrent();
  const doc = await db.get(id);
  switchTab('mark');
  $('#fClass').value = doc.classCode; renderUnitSelect();
  $('#fUnit').value = doc.unitCode;
  const monday = TermReport.mondayOf(doc.date);
  if (![...$('#fWeek').options].some((o) => o.value === monday)) $('#fWeek').insertAdjacentHTML('beforeend', `<option value="${monday}">Week of ${esc(fmtShort(monday))}</option>`);
  $('#fWeek').value = monday;
  state.pick = null; renderKind();
  setCurrent(doc);
}

/* ---------------- Reports: the term register ---------------- */
function renderReportUnitSelect() {
  const opts = unitsFor($('#rClass').value, reportUnits()).map((u) => ({ value: u.code, label: u.code + ' — ' + u.name }));
  fillSelect($('#rUnit'), opts, undefined, opts.length ? null : 'No units');
}

/** Lessons for one class and unit this term: this phone's registers, plus the server's copy when online. */
async function reportSource(classCode, unitCode) {
  const unit = state.units.find((u) => u.classCode === classCode && u.code === unitCode);
  const range = termRange();
  const local = (await byPrefix('session:')).filter((s) => s.classCode === classCode && s.unitCode === unitCode
    && (!range || (s.date >= range.from && s.date <= range.to)))
    .map((s) => ({ id: s._id, date: s.date, period: sessionLabel(s), slots: Number(s.slots) === 2 ? 2 : 1, kind: kindOf(s), title: s.title || '',
      marks: s.marks || {}, names: s.names || {}, updatedAt: s.updatedAt, local: true }));
  const key = `report:${classCode}|${unitCode}`;
  let server = null;
  if (navigator.onLine && state.auth) {
    try {
      const res = await api('report', { classCode, unitCode });
      if (res.ok) { server = res; await updateLocal(key, (d) => { d.data = res; d.at = nowISO(); }); }
    } catch { /* use the cached copy */ }
  }
  if (!server) { const c = await getLocal(key); if (c.data) server = { ...c.data, cached: c.at }; }
  const byId = new Map(local.map((l) => [l.id, l]));
  for (const l of server?.lessons || []) {
    const mine = byId.get(l.id);
    if (!mine || String(l.updatedAt) > String(mine.updatedAt)) byId.set(l.id, { ...l, local: false });
  }
  const all = [...byId.values()];
  // The term register is lessons only; CATs and extra CAT attendance are listed on their own.
  return { unit, lessons: all.filter((l) => kindOf(l) === 'lesson'), assessments: all.filter((l) => kindOf(l) !== 'lesson'), server, localCount: local.length };
}

async function renderReport() {
  const classCode = $('#rClass').value, unitCode = $('#rUnit').value;
  const body = $('#reportBody');
  $('#signoffCard').hidden = true;
  if (!classCode || !unitCode) {
    state.report = null;
    $('#reportSummary').innerHTML = '<p class="empty">Choose a class and unit to see its term register.</p>';
    body.innerHTML = ''; $('#reportControls').hidden = true; $('#reportLegend').hidden = true; $('#reportSource').textContent = '';
    return;
  }
  const token = (renderReport.seq = (renderReport.seq || 0) + 1);
  const src = await reportSource(classCode, unitCode);
  if (token !== renderReport.seq) return; // a newer choice was made meanwhile
  const unit = src.unit || {};
  const mine = isMyUnit(unit) && (hasRole('TRAINER') || hasRole('HOD'));
  const trainer = mine ? { latePct: state.settings.latePct, excusedPct: state.settings.excusedPct }
    : (state.meta.staff?.[unit.trainerCode] || { latePct: 50, excusedPct: 100 });
  const aliases = {};
  for (const a of state.meta.aliases || []) if (a.classCode === classCode) aliases[a.from] = a.to;
  const rejected = new Set((state.meta.rejected || []).filter((r) => r.classCode === classCode).map((r) => r.admNo));
  const threshold = Number($('#rThreshold').value || state.settings.threshold || 75);
  const r = TermReport.build({
    weeks: src.server?.weeks?.length ? src.server.weeks : state.meta.weeks, lessons: src.lessons,
    roster: rosterFor(classCode), aliases, rejected,
    lessonHours: (unit.hoursPerWeek || 3) / (unit.lessonsPerWeek || 2), latePct: trainer.latePct, excusedPct: trainer.excusedPct, threshold,
  });
  const cls = state.classes.find((c) => c.code === classCode) || { code: classCode };
  state.report = { r, unit, cls, classCode, unitCode, mine, signoff: src.server?.signoff || null, term: src.server?.term || state.meta.term };

  $('#reportSource').textContent = src.server
    ? (src.server.cached ? `From the server as of ${fmtTime(src.server.cached)}` : 'Up to date with the server')
      + (src.localCount ? ` · includes this phone's ${src.localCount} register(s)` : '')
    : src.localCount ? 'From the registers on this phone (connect to include other phones)' : (mine ? 'No lessons marked yet for this unit this term.' : 'Connect to the internet to load this report.');
  $('#reportSummary').innerHTML = `
    <div class="stat"><b>${r.lessonsHeld}</b><span>Lessons recorded</span></div>
    <div class="stat"><b>${r.list.length}</b><span>Trainees</span></div>
    <div class="stat"><b>${r.avg}%</b><span>Average attendance</span></div>
    <div class="stat ${r.below ? 'warn' : ''}"><b>${r.below}</b><span>Below ${r.threshold}%</span></div>`;
  $('#reportControls').hidden = false;
  $('#chipBelow').textContent = `Below ${r.threshold}% (${r.below})`;
  const pendingN = r.list.filter((x) => x.pending).length;
  $('#chipPending').textContent = `Pending (${pendingN})`;
  $('#chipPending').hidden = !pendingN;
  $$('.chipbtn').forEach((b) => b.classList.toggle('on', b.dataset.filter === state.reportFilter));
  $('#legendHours').textContent = `Each lesson ${r.lessonHours} h · Late counts ${r.latePct}% · Excused ${r.excusedPct}%`;
  $('#reportLegend').hidden = false;
  drawReportBody();
  renderSignoff();
  renderCats(src.assessments, rosterFor(classCode));
}

/** CATs and extra CAT attendance for this class and unit (not part of the term register's hours). */
function renderCats(list, roster) {
  const card = $('#catCard');
  if (!list.length) { card.hidden = true; return; }
  const rows = [...list].sort((a, b) => (a.date + a.period).localeCompare(b.date + b.period)).map((l) => {
    const v = Object.values(l.marks || {});
    const sat = v.filter((x) => x === 'P' || x === 'L').length;
    return `<li><button type="button" class="mrow" ${l.local ? `data-session="${esc(l.id)}"` : 'disabled'}>
      <span><b>${esc(l.title || KIND_LABEL[kindOf(l)])}</b><small>${esc(fmtDate(l.date))} · ${esc(String(l.period).replace(/^.*?· (?=Lesson)/, ''))}${l.local ? '' : ' · marked on another phone'}</small></span>
      <span class="pill ${kindOf(l)}">${sat} sat · ${v.filter((x) => x === 'A').length} absent</span></button></li>`;
  }).join('');
  card.hidden = false;
  card.innerHTML = `<h2>CATs and extra attendance</h2><p class="muted small">Recorded separately: these do not count in the term register's hours. ${roster.length} on the class list.</p><ul class="mlist">${rows}</ul>`;
}

function reportView() {
  return state.settings.reportView || (matchMedia('(min-width: 900px)').matches ? 'sheet' : 'list');
}
function drawReportBody() {
  const rep = state.report; if (!rep) return;
  const { r } = rep;
  let list = r.list;
  if (state.reportFilter === 'below') list = list.filter((x) => x.below);
  if (state.reportFilter === 'pending') list = list.filter((x) => x.pending);
  const sort = $('#rSort').value;
  list = [...list].sort(sort === 'pct' ? (a, b) => (a.pct ?? 101) - (b.pct ?? 101) || a.name.localeCompare(b.name)
    : sort === 'list' ? (a, b) => a.admNo.localeCompare(b.admNo, undefined, { numeric: true }) : (a, b) => a.name.localeCompare(b.name));
  const view = reportView();
  const tgl = $('#viewToggle');
  tgl.querySelector('use').setAttribute('href', view === 'sheet' ? '#i-rows' : '#i-grid');
  tgl.querySelector('span').textContent = view === 'sheet' ? 'List view' : 'Sheet view';
  const warn = r.overflow.length
    ? `<p class="card warn-banner">${r.overflow.length} lesson(s) are not on the register: ${r.overflow.slice(0, 3).map((l) => esc(fmtShort(l.date) + ' ' + l.period)).join(', ')}${r.overflow.length > 3 ? '…' : ''}. They fall outside the term's 12 weeks or go past 3 lessons in one week (a double counts as two).</p>` : '';
  if (view === 'sheet') {
    $('#reportBody').innerHTML = warn + `<div class="card sheet-wrap">${TermReport.sheetTable({ ...r, list }, esc)}</div>`;
    return;
  }
  $('#reportBody').innerHTML = warn + (list.length ? `<ul class="card rlist">${list.map((x) => `
    <li class="rrow${x.below ? ' below' : ''}">
      <div class="rinfo"><b>${esc(x.name)}${x.pending ? ' <span class="ptag">Pending</span>' : ''}</b>
        <span class="tadm">${esc(x.admNo)}</span>${TermReport.strip(x.cells)}</div>
      <div class="rpct"><b>${x.pct === null ? '–' : x.pct + '%'}</b><span>${x.actual}/${x.possible} h</span></div>
    </li>`).join('')}</ul>` : '<p class="empty">Nobody matches this filter.</p>');
}

/* Sign-off: the trainer submits the term register; the HOD approves or returns it. */
function renderSignoff() {
  const rep = state.report, card = $('#signoffCard');
  if (!rep || !state.meta.term) { card.hidden = true; return; }
  const so = rep.signoff;
  const isHod = hasRole('HOD');
  const status = !so ? 'Not submitted to the HOD yet'
    : so.status === 'submitted' ? `Submitted to the HOD on ${fmtShort(so.submittedAt)}`
      : so.status === 'approved' ? `Approved by ${so.hodName} on ${fmtShort(so.decidedAt)}`
        : `Returned by ${so.hodName} on ${fmtShort(so.decidedAt)}`;
  const kind = !so ? '' : so.status === 'approved' ? 'ok' : so.status === 'returned' ? 'err' : 'wait';
  let html = `<div class="so-head"><h2>HOD approval</h2><span class="so-status ${kind}">${esc(status)}</span></div>`;
  if (so?.hodComment) html += `<p class="so-quote"><b>HOD's comment:</b> ${esc(so.hodComment)}</p>`;
  if (rep.mine) {
    html += `<label>Lecturer's comment<textarea id="soComment" rows="2" placeholder="Shown on the register under Lecturer's Comment">${esc(so?.lecturerComment || '')}</textarea></label>
      <button type="button" class="btn primary" id="soSubmit"><svg class="i" aria-hidden="true"><use href="#i-send"/></svg>${so ? 'Submit again' : 'Submit to HOD'}</button>`;
  } else if (so?.lecturerComment) html += `<p class="so-quote"><b>Lecturer's comment:</b> ${esc(so.lecturerComment)}</p>`;
  if (isHod && so && so.status !== 'approved') {
    html += `<label>HOD's comment<textarea id="soHod" rows="2" placeholder="Shown on the register under HOD's Comment">${esc(so.hodComment || '')}</textarea></label>
      <div class="row-actions"><button type="button" class="btn primary" id="soApprove">Approve register</button><button type="button" class="btn" id="soReturn">Return to trainer</button></div>`;
  }
  card.innerHTML = html;
  card.hidden = false;
}

async function submitSignoff() {
  const rep = state.report; if (!rep) return;
  if (!navigator.onLine) { toast('Submitting needs internet. Your register is safe on this phone.', 'err'); return; }
  try {
    await syncSheets({ silent: true, pull: false });
    const res = await api('submitSignoff', { classCode: rep.classCode, unitCode: rep.unitCode, unitName: rep.unit.name, comment: $('#soComment').value.trim(), resubmit: true });
    if (!res.ok) throw new Error(res.error);
    rep.signoff = res.signoff;
    renderSignoff();
    toast('Submitted to the HOD', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}
async function decideSignoff(decision) {
  const rep = state.report; if (!rep?.signoff) return;
  try {
    const res = await api('decideSignoff', { id: rep.signoff.id, decision, comment: $('#soHod').value.trim() });
    if (!res.ok) throw new Error(res.error);
    rep.signoff = res.signoff;
    renderSignoff();
    toast(decision === 'approved' ? 'Register approved' : 'Register returned to the trainer', 'ok');
    window.Admin?.refreshBadge?.();
  } catch (e) { toast(e.message, 'err'); }
}

function registerExportData() {
  const rep = state.report;
  const { r, unit, cls, classCode, unitCode, signoff, term } = rep;
  const so = signoff;
  const lect = (rep.mine ? $('#soComment')?.value.trim() : '') || so?.lecturerComment || '';
  const hod = so?.status === 'approved' ? [so.hodComment, `Approved by ${so.hodName}, ${fmtShort(so.decidedAt)}`].filter(Boolean).join(' — ') : (so?.hodComment || '');
  return TermReport.exportData(r, {
    lecturer: unit.trainerName || (rep.mine ? trainerLabel() : ''), duration: term?.duration || '',
    classLabel: cls.misClass ? `${cls.misClass} (${classCode})` : classCode, level: cls.level || '',
    subject: `${unitCode} - ${unit.name || unitCode}`, misClass: cls.misClass, classCode,
    sheetName: `${classCode.split(' ').pop()} ${unitCode}`, lecturerComment: lect, hodComment: hod,
  });
}
async function exportXlsx() {
  if (!state.report) { toast('Choose a class and unit first', 'err'); return; }
  try {
    const t = await (await fetch('templates/class-register.xlsx')).arrayBuffer();
    const blob = await Xlsx.registerFile(t, registerExportData());
    download(`Register_${fileSafe(state.report.classCode)}_${fileSafe(state.report.unitCode)}_${todayISO()}.xlsx`, blob);
    toast('Excel register saved', 'ok');
  } catch (e) { toast('Could not make the Excel file: ' + e.message, 'err'); }
}
function printRegister() {
  if (!state.report) { toast('Choose a class and unit first', 'err'); return; }
  $('#printArea').innerHTML = TermReport.printHtml(registerExportData(), esc);
  document.body.classList.add('printing', 'print-register');
  const done = () => { document.body.classList.remove('printing', 'print-register'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 80);
}

async function exportRaw() {
  const sessions = (await byPrefix('session:')).sort((a, b) => (a.date + a.period).localeCompare(b.date + b.period));
  const rows = [['Date', 'Week', 'Lesson', 'ClassCode', 'UnitCode', 'UnitName', 'AdmNo', 'Name', 'Status', 'Trainer', 'SessionID', 'UpdatedAt']];
  for (const s of sessions) for (const [adm, st] of Object.entries(s.marks || {})) {
    rows.push([s.date, s.week || '', periodLabel(s.period), s.classCode, s.unitCode, s.unitName, adm, s.names?.[adm] || '', STATUSES[st] || '', s.trainerName, s._id, s.updatedAt]);
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

/* ---------------- Server (Cloudflare Worker, or the older Google Apps Script) ---------------- */
async function callSheets(method, body, params = {}) {
  if (!serverUrl()) throw new Error('No server address set. Ask the MIS Officer for the app link.');
  const url = new URL(serverUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const opts = method === 'GET'
      ? { method: 'GET', signal: ctrl.signal, redirect: 'follow' }
      // text/plain keeps this a "simple" request, so Apps Script needs no CORS preflight
      : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctrl.signal, redirect: 'follow' };
    let res = await fetch(url.toString(), opts);
    let text = await res.text();
    let parsed = tryJson(text);
    if (!parsed) { // Google sometimes answers with a temporary error page: try once more
      await new Promise((r) => setTimeout(r, 1500));
      res = await fetch(url.toString(), opts);
      text = await res.text();
      parsed = tryJson(text);
    }
    if (parsed) return parsed;
    throw new Error(`The server did not answer properly (${res.status}${googleMessage(text) ? ': ' + googleMessage(text) : ''}). Try again in a moment; if it keeps happening, tell the MIS Officer.`);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The server took too long to answer');
    if (e instanceof TypeError) throw new Error('No connection to the server');
    throw e;
  } finally { clearTimeout(timer); }
}

function tryJson(text) { try { return JSON.parse(text); } catch { return null; } }
/** The readable part of an error page, so the message says what actually went wrong. */
function googleMessage(html) {
  const t = String(html || '');
  const pick = t.match(/<div[^>]*class="?errorMessage"?[^>]*>([\s\S]*?)<\/div>/i) || t.match(/<title>([\s\S]*?)<\/title>/i);
  const raw = pick ? pick[1] : t.replace(/<[^>]+>/g, ' ');
  return raw.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Signed-in call. If the sign-in has ended, shows the sign-in screen (nothing on the phone is lost). */
async function api(action, body = {}) {
  if (!state.auth?.token) { showSignin(); throw new Error('Sign in first'); }
  const used = state.auth.token;
  const res = await callSheets('POST', { action, auth: used, ...body });
  // A reply to a request sent before a PIN change carries the old sign-in: ignore it rather than sign out.
  if (res && res.authError) { if (state.auth?.token === used) showSignin(res.error); throw new Error(res.error); }
  if (res && res.mustChange) { showSignin(); showPinForm(); throw new Error(res.error); }
  return res;
}

/* Which register versions the server has. Kept per server address: after a move to a new server every
 * register on this phone is sent again, so nothing is left behind. */
const LEGACY_SERVER = 'https://script.google.com/macros/s/AKfycbw3bSI2h4GrfV2BBmZOqDkyioa4tYZz3ND_PL-0JurcQKneg9TNBwbuLMPBh3qqIKOxTA/exec';
async function sheetsSyncMap() {
  const d = await getLocal('sheetsSync', { map: {} });
  return (d.server || LEGACY_SERVER) === serverUrl() ? d.map || {} : {};
}
function markSent(fn) {
  return updateLocal('sheetsSync', (d) => {
    if ((d.server || LEGACY_SERVER) !== serverUrl()) d.map = {};
    d.server = serverUrl(); d.map = d.map || {};
    fn(d.map);
  }, { map: {} });
}
async function pendingSessions() {
  const [sessions, map] = await Promise.all([byPrefix('session:'), sheetsSyncMap()]);
  return sessions.filter((s) => map[s._id] !== s._rev);
}
/** The register whose QR is on screen waits until 2 minutes after its last upload (unless a sync is forced). */
const qrSentAt = {};
function heldBack(s) {
  return $('#lessonQrDialog').open && state.current && s._id === state.current._id && Date.now() - (qrSentAt[s._id] || 0) < QR_UPLOAD_MS;
}
async function refreshPending() {
  const pending = await pendingSessions();
  const unsentReqs = state.addreqs.filter((a) => !a.sentAt).length;
  const n = pending.length + unsentReqs;
  const el = $('#pendingCount');
  el.textContent = n;
  el.classList.toggle('zero', n === 0);
  // Long-unsent registers matter most for QR lessons: students' scans are verified only once the lesson reaches the server.
  const oldest = pending.reduce((m, s) => (!m || s.updatedAt < m ? s.updatedAt : m), '');
  const days = oldest ? Math.floor((Date.now() - new Date(oldest).getTime()) / 864e5) : 0;
  const qr = pending.filter((s) => s.qr).length;
  const warn = $('#syncWarn');
  if (days >= 2) {
    warn.hidden = false;
    warn.textContent = `${pending.length} register(s) not sent for ${days} days${qr ? ` (${qr} with student QR check-ins waiting to be verified)` : ''}. They are safe on this phone — connect and tap Sync.`;
  } else if (state.storage === 'not-protected' && n) {
    warn.hidden = false;
    warn.textContent = 'Install this app (browser menu → Add to Home screen) so the phone keeps unsent registers safely.';
  } else warn.hidden = true;
}

function toSheetSession(s) {
  const c = countMarks(s);
  return {
    sessionId: s._id, date: s.date, classCode: s.classCode, className: s.className || '',
    unitCode: s.unitCode, unitName: s.unitName || '', period: slotLabel(s.period, Number(s.slots) === 2 ? 2 : 1),
    kind: kindOf(s), title: s.title || '', slots: Number(s.slots) === 2 ? 2 : 1,
    trainerId: s.trainerId || '', trainerName: s.trainerName || '', deviceId: s.deviceId || '',
    termId: s.termId || '', week: s.week || '',
    notes: s.notes || '', createdAt: s.createdAt || '', updatedAt: s.updatedAt || '',
    edits: (s.editLog || []).length, counts: { P: c.P, A: c.A, L: c.L, E: c.E },
    marks: Object.entries(s.marks || {}).filter(([, v]) => STATUSES[v])
      .map(([admNo, st]) => ({ admNo, name: s.names?.[admNo] || '', status: STATUSES[st], explicit: !!s.explicit?.[admNo] })),
    ...(s.qr ? { qr: { secret: s.qr.secret, intervals: s.qr.intervals } } : {}),
  };
}

async function pushRequests() {
  const unsent = state.addreqs.filter((a) => !a.sentAt);
  if (!unsent.length) return 0;
  const res = await api('addStudents', { students: unsent.map((a) => ({ admNo: a.admNo, name: a.name, classCode: a.classCode, reason: a.reason, addedAt: a.addedAt })) });
  if (!res.ok) throw new Error(res.error || 'Could not send the added students');
  const docs = unsent.map((a) => ({ ...a, sentAt: nowISO(), serverStatus: (res.results || []).find((r) => lower(r.admNo) === lower(a.admNo))?.status || '' }));
  await db.bulkDocs(docs);
  state.addreqs = await byPrefix('addreq:');
  return unsent.length;
}

async function syncSheets({ silent = false, pull = true, force = !silent } = {}) {
  if (!state.auth || state.auth.mustChange) { if (!silent) showSignin(); return; }
  if (state.syncing) return;
  if (!navigator.onLine) { if (!silent) toast('No network — registers are safe on this device and will sync later'); return; }
  if (state.dirty) await saveCurrent();
  state.syncing = true;
  $('#syncBtn').classList.add('syncing');
  let sent = 0;
  const pushPending = async () => {
    for (const batch of chunk((await pendingSessions()).filter((s) => force || !heldBack(s)), 20)) {
      const res = await api('push', { deviceId: state.deviceId, sessions: batch.map(toSheetSession) });
      if (!res.ok) throw new Error(res.error || 'The server rejected the upload');
      await markSent((map) => { for (const s of batch) map[s._id] = s._rev; });
      for (const s of batch) qrSentAt[s._id] = Date.now();
      sent += batch.length;
    }
  };
  try {
    await pushPending();
    const reqs = await pushRequests();
    const qrUpdated = pull ? await pullCheckins() : 0; // uploads alone skip fetching; the live pulse handles that
    if (qrUpdated) await pushPending();
    await updateLocal('syncLog', (d) => { d.lastSheets = nowISO(); });
    renderSheetsStatus();
    if (!silent) {
      const parts = [];
      if (sent) parts.push(`Sent ${sent} register(s)`);
      if (reqs) parts.push(`${reqs} added student(s) sent to the MIS Officer`);
      if (qrUpdated) parts.push(`QR check-ins added to ${qrUpdated} register(s)`);
      toast(parts.join(' · ') || 'Everything is already sent', 'ok');
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
  if (!state.auth || state.auth.mustChange) return;
  const btn = $('#pullRoster'); btn.disabled = true;
  if (!silent) $('#sheetsStatus').textContent = 'Downloading class lists…';
  try {
    const log0 = await getLocal('syncLog');
    // Background checks send the version this phone has; the server then answers "unchanged" in a few bytes.
    const have = silent && state.trainees.length && log0.rosterServer === serverUrl() ? log0.rosterVersion || '' : '';
    const res = await api('roster', have ? { version: have } : {});
    if (!res.ok) throw new Error(res.error || 'Could not read the class lists');
    if (res.unchanged) {
      if (res.me) await saveAuth({ ...state.auth, staff: { ...state.auth.staff, ...res.me, roles: res.me.roles } });
      await updateLocal('syncLog', (d) => { d.lastRoster = nowISO(); });
      renderSheetsStatus();
      return;
    }
    if (!(res.trainees || []).length && state.trainees.length) throw new Error('the server has no students yet — kept the class lists already on this phone');
    const r = await replaceRoster(res);
    await updateLocal('meta', (d) => {
      Object.assign(d, { term: res.term || null, weeks: res.weeks || [], pending: res.pending || [], rejected: res.rejected || [], aliases: res.aliases || [], staff: res.staff || {} });
    });
    // Students this phone added: done once the MIS Officer has decided (on the list, rejected or merged).
    const stillPending = new Set((res.pending || []).map((p) => `${p.classCode}|${lower(p.admNo)}`));
    const done = state.addreqs.filter((a) => a.sentAt && !a.done && !stillPending.has(`${a.classCode}|${lower(a.admNo)}`));
    if (done.length) await db.bulkDocs(done.map((a) => ({ ...a, done: true })));
    if (res.me) {
      await saveAuth({ ...state.auth, staff: { ...state.auth.staff, ...res.me, roles: res.me.roles } });
      const s = res.me;
      if (s.latePct !== undefined) await saveSettings({ latePct: s.latePct, excusedPct: s.excusedPct });
      fillSettingsForms();
    }
    await updateLocal('syncLog', (d) => { d.lastRoster = nowISO(); d.rosterVersion = res.version || ''; d.rosterServer = serverUrl(); });
    await loadRoster();
    applyRoles();
    if (state.current) renderRegister();
    renderSheetsStatus();
    if (!silent) toast(`Class lists saved: ${markClasses().length} of your classes, ${r.trainees} students — you can now mark offline`, 'ok');
  } catch (e) {
    $('#sheetsStatus').textContent = 'Class list download failed: ' + e.message;
    if (!silent) toast(e.message, 'err');
  } finally { btn.disabled = false; }
}

async function renderSheetsStatus() {
  const log = await getLocal('syncLog');
  const parts = [];
  if (log.lastSheets) parts.push(`Registers last sent ${fmtTime(log.lastSheets)}`);
  if (log.lastRoster) parts.push(`class lists downloaded ${fmtTime(log.lastRoster)}`);
  $('#sheetsStatus').textContent = parts.length ? parts.join(' · ') + '.' : 'Not synced yet.';
}

/* Check for new class lists when they are more than 10 minutes old (an unchanged list costs almost nothing). */
async function maybeRefreshRoster() {
  if (!state.auth || !navigator.onLine) return;
  const log = await getLocal('syncLog');
  if (!log.lastRoster || log.rosterServer !== serverUrl() || Date.now() - new Date(log.lastRoster).getTime() > 10 * 6e4) pullRoster({ silent: true });
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
  if ([...ids].some((id) => /^(class|unit|trainee|addreq):/.test(id))) await loadRoster();
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
}, 400);

/* ---------------- QR check-in: students scan a code the trainer shows ----------------
 * The lesson QR changes every QR_WINDOW seconds. Each code is an HMAC of the lesson and the
 * time window, made with a secret that only this phone (and later the server) knows, so
 * students cannot make their own codes. The server checks every check-in against it. */
const QR_WINDOW = 20; // seconds — must match WINDOW_SECONDS in Code.gs
const qrWindow = (t = Date.now()) => Math.floor(t / 1000 / QR_WINDOW);
const b64url = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const studentPageUrl = () => new URL('student.html', location.href.split('#')[0]).toString();

async function qrToken(secret, sid, w) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${sid}|${w}`));
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
  // Upload straight away, so the server can confirm students' scans from the first second.
  saveCurrent().then(() => { if (navigator.onLine) syncSheets({ silent: true, pull: false, force: true }); });
  renderQrLive();
  $('#lessonQrTitle').textContent = `${s.classCode} · ${s.unitCode} — ${sessionLabel(s)}`;
  $('#lessonQrSub').textContent = `${s.unitName} · ${fmtDate(s.date)}`;
  $('#lessonQrDialog').showModal();
  goLive();
  let shown = null;
  const tick = async () => {
    if (state.current !== s) { closeLessonQR(); return; }
    const w = qrWindow();
    if (w !== shown) {
      shown = w;
      const iv = s.qr.intervals[s.qr.intervals.length - 1];
      if (iv[1] !== w) { iv[1] = w; markDirty(); saveCurrent().then(() => scheduleAutoSync()); }
      const t = await qrToken(s.qr.secret, s._id, w);
      const url = studentPageUrl() + '#l=' + b64url({ v: 1, s: s._id, c: s.classCode, un: (kindOf(s) === 'lesson' ? '' : (s.title || 'CAT') + ' · ') + s.unitName, p: slotLabel(s.period, Number(s.slots) === 2 ? 2 : 1), n: s.trainerName, u: serverUrl(), w, t });
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
  const total = rosterFor(s.classCode).length;
  el.innerHTML = `<b>${via.length}</b> of ${total} checked in`
    + (via.length ? `<span>${via.slice(0, 4).map(([adm]) => esc((s.names?.[adm] || adm).split(' ')[0])).join(', ')}${via.length > 4 ? '…' : ''}</span>` : '<span>Waiting for the first scan…</span>');
}

function isLiveLesson() {
  const s = state.current;
  return $('#lessonQrDialog').open || !!(s && s.qr && s.date === todayISO());
}

/* One loop decides how often to check: every few seconds while the QR is shown, every 15 s with today's QR register open, else every minute. */
let liveTimer = null, liveBusy = false;
async function liveTick() {
  clearTimeout(liveTimer);
  if (liveBusy) return; // a check is already running; it schedules the next one when done
  liveBusy = true;
  const live = isLiveLesson();
  try {
    if (navigator.onLine && document.visibilityState === 'visible' && state.auth && !state.auth.mustChange && !state.syncing) {
      // A tiny "anything new?" first; fetch details only when the server says something changed (or it cannot tell).
      const res = await api('pulse');
      if (!res.ok || res.last !== state.lastPulse) {
        state.lastPulse = res.last || '';
        await syncSheets({ silent: true });
      } else if ((await pendingSessions()).some((s) => !heldBack(s)) || state.addreqs.some((a) => !a.sentAt)) await syncSheets({ silent: true, pull: false });
    }
  } catch { /* offline or slow network: try again next round */ }
  liveBusy = false;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(liveTick, liveDelay());
}
function liveDelay() {
  if ($('#lessonQrDialog').open) return LIVE_FAST_MS;
  return isLiveLesson() ? LIVE_MID_MS : LIVE_SLOW_MS;
}
/* Switch to fast checking straight away when a live lesson starts, instead of waiting out a slow round. */
function goLive() {
  if (isLiveLesson()) { clearTimeout(liveTimer); liveTimer = setTimeout(liveTick, 1000); }
}

function closeLessonQR() {
  clearInterval(lessonQrTimer);
  lessonQrTimer = null;
  if ($('#lessonQrDialog').open) $('#lessonQrDialog').close();
  // Upload the register now, with the full record of which codes were shown.
  Promise.resolve(state.dirty && saveCurrent()).then(() => {
    if (!navigator.onLine || !state.auth) return;
    if (state.syncing) scheduleAutoSync(); else syncSheets({ silent: true, pull: false, force: true });
  });
}

/* Fetch check-ins that reached the server since the last check and save them into the
 * register for that lesson. Runs automatically whenever the phone is online. */
async function pullCheckins() {
  const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10); // students may sync months late
  const sessions = (await byPrefix('session:')).filter((s) => s.qr && s.date >= since);
  if (!sessions.length) return 0;
  const log = await getLocal('syncLog');
  const since0 = (log.checkinsServer || LEGACY_SERVER) === serverUrl() ? log.checkinsSince || '' : '';
  const res = await api('checkins', { sessionIds: sessions.map((s) => s._id), since: since0 });
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
        // The server already has these check-ins, so a register that was in sync stays in sync.
        if (wasSynced) await markSent((map) => { map[doc._id] = r.rev; });
      } catch (e) { if (e.status !== 409) throw e; }
    }
  }
  if (res.serverTime) {
    // Ask again from 2 minutes earlier next time, so nothing written at the same moment is missed.
    await updateLocal('syncLog', (d) => { d.checkinsSince = new Date(new Date(res.serverTime).getTime() - 120000).toISOString(); d.checkinsServer = serverUrl(); });
  }
  if (newOnOpen) { toast(`${newOnOpen} student(s) checked in by QR`, 'ok'); renderQrLive(); navigator.vibrate?.(40); }
  return changed;
}

/* ---------------- sign-in ---------------- */
function showSignin(message = '') {
  $('#signin').hidden = false;
  document.body.classList.add('locked');
  $('#signinForm').hidden = false;
  $('#pinForm').hidden = true;
  $('#siMsg').textContent = message || (!navigator.onLine ? 'Connect to the internet to sign in.' : '');
  if (state.auth?.staff?.code && !$('#siCode').value) $('#siCode').value = state.auth.staff.code;
}
function showPinForm() {
  $('#signin').hidden = false;
  document.body.classList.add('locked');
  $('#signinForm').hidden = true;
  $('#pinForm').hidden = false;
  $('#pinMsg').textContent = '';
  setTimeout(() => $('#newPin').focus(), 50);
}
function hideSignin() { $('#signin').hidden = true; document.body.classList.remove('locked'); }

async function signIn(e) {
  e.preventDefault();
  const code = $('#siCode').value.trim(), pin = $('#siPin').value.trim();
  const btn = $('#siBtn'); btn.disabled = true; $('#siMsg').textContent = 'Signing in…';
  try {
    const res = await callSheets('POST', { action: 'login', staff: code, pin });
    if (!res.ok) throw new Error(res.error);
    $('#siPin').value = '';
    await saveAuth({ token: res.token, staff: res.staff, mustChange: res.mustChange });
    if (res.mustChange) { showPinForm(); return; }
    await afterSignIn();
  } catch (err) { $('#siMsg').textContent = err.message; }
  finally { btn.disabled = false; }
}
async function savePin(e) {
  e.preventDefault();
  const a = $('#newPin').value.trim(), b = $('#newPin2').value.trim();
  if (a !== b) { $('#pinMsg').textContent = 'The two PINs are different.'; return; }
  try {
    const res = await callSheets('POST', { action: 'setPin', auth: state.auth.token, newPin: a });
    if (!res.ok) throw new Error(res.error);
    $('#newPin').value = ''; $('#newPin2').value = '';
    await saveAuth({ token: res.token, staff: res.staff, mustChange: false });
    toast('PIN saved', 'ok');
    await afterSignIn();
  } catch (err) { $('#pinMsg').textContent = err.message; }
}
function homeTab() {
  if (markableUnits().length) return 'mark';
  if (hasRole('MIS')) return 'manage';
  if (hasRole('HOD')) return 'manage';
  return hasRole('TRAINER') ? 'mark' : 'me';
}
async function afterSignIn() {
  hideSignin();
  applyRoles();
  const seq = state.tabSeq || 0;
  await pullRoster({ silent: true });
  if ((state.tabSeq || 0) === seq) switchTab(homeTab()); // don't pull people away from a tab they chose meanwhile
  syncSheets({ silent: true });
  liveTick();
}
async function signOut() {
  const pending = (await pendingSessions()).length;
  if (!confirm(pending ? `${pending} register(s) are not sent yet. They stay on this phone and are sent after you sign in again. Sign out?` : 'Sign out of this phone?')) return;
  await saveAuth(null);
  PoeStaff.reset();
  showSignin();
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

/* ---------------- tabs, roles, network, wiring ---------------- */
function switchTab(name) {
  const btn = $(`.tabs button[data-tab="${name}"]`);
  if (!btn || btn.hidden) name = 'reports';
  state.activeTab = name;
  state.tabSeq = (state.tabSeq || 0) + 1;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'sessions') renderSessions();
  if (name === 'reports') renderReport();
  if (name === 'manage') window.Admin?.render();
  if (name === 'poe') PoeStaff.render();
  if (name === 'me') { renderDbInfo(); renderMe(); }
}

/** Shows only the sections this person's roles allow. */
function applyRoles() {
  const marks = hasRole('TRAINER') || hasRole('HOD');
  $('.tabs button[data-tab="mark"]').hidden = !marks;
  $('.tabs button[data-tab="sessions"]').hidden = !marks;
  $('.tabs button[data-tab="manage"]').hidden = !(hasRole('HOD') || hasRole('MIS'));
  $('.tabs').style.setProperty('--tabs', $$('.tabs button').filter((b) => !b.hidden).length);
  if ($(`.tabs button[data-tab="${state.activeTab}"]`)?.hidden) switchTab(marks ? 'mark' : 'reports');
  renderIdentity();
  renderClassSelects();
  window.Admin?.refreshBadge?.();
  if (me()) PoeStaff.refreshBadge();
}

function updateNet() {
  const on = navigator.onLine;
  const b = $('#netBadge');
  b.textContent = on ? 'Online' : 'Offline';
  b.className = 'badge ' + (on ? 'online' : 'offline');
}

const ROLE_NAMES = { TRAINER: 'Trainer', HOD: 'HOD', MIS: 'MIS Officer' };
function renderIdentity() {
  const s = me();
  const roles = s ? s.roles.map((r) => ROLE_NAMES[r]).join(', ') || 'no role yet' : '';
  $('#trainerLabel').textContent = !s ? 'Not signed in' : s.name === roles ? s.name : `${s.name} · ${roles}`;
}
function renderMe() {
  const s = me();
  $('#meName').textContent = s?.name || 'Not signed in';
  $('#meMeta').textContent = s ? `Staff code ${s.code} · ${s.roles.map((r) => ROLE_NAMES[r]).join(', ') || 'No role yet — ask the MIS Officer'}` : '';
}

function fillSettingsForms() {
  const s = state.settings;
  $('#setLock').value = s.lockHours; $('#setDefault').value = s.defaultStatus;
  $('#setLate').value = s.latePct; $('#setExcused').value = s.excusedPct;
  $('#rThreshold').value = s.threshold;
  $('#setServer').value = s.serverUrl || '';
}

function wire() {
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  PoeStaff.wire();
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); switchTab(g.dataset.goto); } });

  // Sign-in
  $('#signinForm').addEventListener('submit', signIn);
  $('#pinForm').addEventListener('submit', savePin);
  $('#signOut').addEventListener('click', signOut);
  $('#changePin').addEventListener('click', () => { if (!navigator.onLine) { toast('Changing your PIN needs internet', 'err'); return; } showPinForm(); });

  // Mark
  $('#sessionForm').addEventListener('submit', openFromForm);
  $('#fClass').addEventListener('change', renderUnitSelect);
  $('#fUnit').addEventListener('change', () => renderTimetable());
  $('#fWeek').addEventListener('change', () => renderKind());
  $$('input[name="fKind"]').forEach((r) => r.addEventListener('change', renderKind));
  $('#catCard').addEventListener('click', (e) => { const b = e.target.closest('[data-session]'); if (b) openSessionById(b.dataset.session); });
  $('#timetable').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { if (state.dirty) await saveCurrent(); setCurrent(await db.get(open.dataset.open)); return; }
    const cell = e.target.closest('.tt-cell[data-slot]');
    if (cell && !cell.disabled) pickSlot(cell.dataset.date, Number(cell.dataset.slot));
  });
  $('#traineeList').addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="pull-roster"]')) { await pullRoster(); renderRegister(); return; }
    const b = e.target.closest('button[data-s]'); if (!b) return;
    setMark(b.closest('.trow').dataset.adm, b.dataset.s);
  });
  $('#regSearch').addEventListener('input', renderRegister);
  $('#regNotes').addEventListener('input', () => { if (state.current) markDirty(); });
  $('#allPresent').addEventListener('click', () => setAll('P'));
  $('#allAbsent').addEventListener('click', () => setAll('A'));
  $('#addStudentBtn').addEventListener('click', openAddStudent);
  $('#addStudentForm').addEventListener('submit', saveAddStudent);
  $('#cancelAddStudent').addEventListener('click', () => $('#addStudentDialog').close());
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
  $('#rUnit').addEventListener('change', renderReport);
  $('#rThreshold').addEventListener('change', async () => { await saveSettings({ threshold: Number($('#rThreshold').value) || 75 }); renderReport(); });
  $('#rSort').addEventListener('change', drawReportBody);
  $$('.chipbtn').forEach((b) => b.addEventListener('click', () => { state.reportFilter = b.dataset.filter; $$('.chipbtn').forEach((x) => x.classList.toggle('on', x === b)); drawReportBody(); }));
  $('#viewToggle').addEventListener('click', async () => { await saveSettings({ reportView: reportView() === 'sheet' ? 'list' : 'sheet' }); drawReportBody(); });
  $('#signoffCard').addEventListener('click', (e) => {
    if (e.target.closest('#soSubmit')) submitSignoff();
    if (e.target.closest('#soApprove')) decideSignoff('approved');
    if (e.target.closest('#soReturn')) decideSignoff('returned');
  });
  $('#exportXlsx').addEventListener('click', exportXlsx);
  $('#printReg').addEventListener('click', printRegister);
  $('#exportRaw').addEventListener('click', exportRaw);
  $('#printQR').addEventListener('click', printQRCards);

  // Me
  $('#trainerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const latePct = Math.max(0, Math.min(100, Number($('#setLate').value)));
    const excusedPct = Math.max(0, Math.min(100, Number($('#setExcused').value)));
    await saveSettings({ lockHours: Number($('#setLock').value) || 48, defaultStatus: $('#setDefault').value, latePct, excusedPct });
    toast('Saved', 'ok');
    if (navigator.onLine && state.auth) api('mySettings', { latePct, excusedPct }).catch(() => {});
  });
  $('#serverForm').addEventListener('submit', async (e) => { e.preventDefault(); await saveSettings({ serverUrl: $('#setServer').value.trim() }); toast('Server address saved', 'ok'); });
  $('#studentLinkBtn').addEventListener('click', () => {
    if (!serverUrl()) { toast('No server address set', 'err'); return; }
    const url = studentPageUrl() + '#u=' + encodeURIComponent(serverUrl());
    $('#studentLinkCode').innerHTML = qrSvg(url, 4);
    $('#studentLink').value = url;
    $('#studentLinkDialog').showModal();
  });
  $('#closeStudentLink').addEventListener('click', () => $('#studentLinkDialog').close());
  $('#copyStudentLink').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#studentLink').value); toast('Link copied — share it in the class WhatsApp group', 'ok'); }
    catch { $('#studentLink').select(); toast('Select and copy the link'); }
  });
  $('#pullRoster').addEventListener('click', () => pullRoster());
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
    if (document.visibilityState === 'visible' && navigator.onLine) { liveTick(); maybeRefreshRoster(); }
  });
  window.addEventListener('pagehide', () => { if (state.dirty) saveCurrent(); });

  db.changes({ since: 'now', live: true }).on('change', (c) => {
    if (c.id.startsWith('_local/')) return;
    changedIds.add(c.id);
    onDbChange();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((e) => console.warn('Service worker not registered', e));
  // When a new version of the app arrives, switch to it right away (unless something is unsaved or the QR is showing).
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (!state.dirty && !$('#lessonQrDialog')?.open) location.reload();
    else toast('App updated — it will refresh next time you open it');
  });
}

/** If start-up fails (for example, parts of two app versions were cached), clear the app's cached files once and reload.
 *  Registers and other data in the phone's database are not touched. */
async function repairAndReload(err) {
  console.error(err);
  let tried = false;
  try { tried = sessionStorage.getItem('rvnp_repair') === '1'; sessionStorage.setItem('rvnp_repair', '1'); } catch { /* private mode */ }
  if (tried) { toast('Start-up error: ' + err.message + '. Close and reopen the app.', 'err'); return; }
  toast('Updating the app…');
  try {
    for (const r of (await navigator.serviceWorker?.getRegistrations?.()) || []) await r.unregister();
    for (const k of (await caches?.keys?.()) || []) await caches.delete(k);
  } catch { /* best effort */ }
  location.reload();
}

async function init() {
  registerServiceWorker();
  await loadDevice();
  await protectStorage();
  await loadSettings();
  await loadAuth();
  fillSettingsForms();
  updateNet();
  wire();
  await loadRoster();
  applyRoles();
  await resolveConflicts();
  refreshPending();
  renderSheetsStatus();
  if (!state.auth) showSignin();
  else if (state.auth.mustChange) showPinForm();
  else {
    switchTab(homeTab());
    if (navigator.onLine) setTimeout(() => { syncSheets({ silent: true }); maybeRefreshRoster(); }, 2000);
  }
  try { sessionStorage.removeItem('rvnp_repair'); } catch { /* private mode */ }
}

init().catch(repairAndReload);
