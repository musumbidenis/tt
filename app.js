/* RVNP Attendance Register — offline-first, for the ICT Department.
 * Storage: PouchDB (IndexedDB) on the device.
 * Sync:    to the online database (Cloudflare Worker + D1; the older Apps Script + Google Sheet also works).
 *          Staff sign in once with their staff code and PIN; registers are pushed whenever the device
 *          is online, and class lists and loading come back from the server.
 * Roles:   TRAINER marks; HOD approves term registers; MIS sets up terms, loading and class lists.
 */
'use strict';

const APP_VERSION = '4.59.0';
const db = new PouchDB('rvnp_attendance', { auto_compaction: true });

const STATUSES = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };
// Live updates: while the lesson QR is on screen the app asks the server a tiny "anything new?" every few
// seconds; with today's QR register open, every 15 seconds; otherwise once a minute, and once every three
// minutes when the device has been left alone for ten. Nothing at all is asked while the app is off screen.
const LIVE_FAST_MS = window.__liveFastMs || 4000;
const LIVE_SLOW_MS = window.__liveSlowMs || 60000;
const LIVE_MID_MS = window.__liveMidMs || Math.min(15000, LIVE_SLOW_MS);
const IDLE_AFTER_MS = window.__idleAfterMs || 10 * 60000;
// While the QR is shown, the register (whose QR record grows every 20 s) is uploaded at most every 2 minutes,
// and again when the QR is closed. The server accepts genuine codes for "right now" without waiting for it.
const QR_UPLOAD_MS = window.__qrUploadMs || 120000;
const MAX_LESSONS_PER_WEEK = 3; // the register has 3 lesson cells per week
// The college timetable: six slots a day. Two slots back to back make a double lesson (two cells in the register).
const SLOTS = [['7.30', '9.00'], ['9.00', '10.30'], ['10.30', '12.00'], ['13.00', '14.30'], ['14.30', '16.00'], ['16.00', '17.30']];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const LUNCH_AFTER = 3; // a double is two slots in the same morning or afternoon
const LUNCH_SLOT = 7, LUNCH_TIME = ['12.00', '13.00']; // lunch can hold a CAT or extra attendance, never a lesson
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
  meta: { term: null, weeks: [], pending: [], rejected: [], aliases: [], staff: {}, terms: [], unlocks: [], archived: [] },
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
/** "Lesson 2 - 9.00–10.30", or for a double "Lessons 1–2 - 7.30–10.30". */
function slotLabel(period, slots = 1) {
  const n = slotNo(period);
  if (n === LUNCH_SLOT) return `Lunch - ${LUNCH_TIME[0]}–${LUNCH_TIME[1]}`;
  if (!n || !SLOTS[n - 1]) return periodLabel(period);
  const end = SLOTS[Math.min(SLOTS.length, n + (slots === 2 ? 1 : 0)) - 1][1];
  return (slots === 2 ? `Lessons ${n}–${n + 1}` : `Lesson ${n}`) + ` - ${SLOTS[n - 1][0]}–${end}`;
}
const kindOf = (s) => (s && ['cat', 'extra'].includes(s.kind) ? s.kind : 'lesson');
/** What a register is: "Lesson 2 - 9.00–10.30" or "CAT 1 - Lesson 3 - 10.30–12.00". */
const sessionLabel = (s) => (kindOf(s) === 'lesson' ? '' : `${s.title || KIND_LABEL[kindOf(s)]} - `) + slotLabel(s.period, Number(s.slots) === 2 ? 2 : 1);
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
/* The server: the address in config.js, unless this device was given another one. An old Google Apps Script
 * address saved on the device gives way once config.js points at the new database. */
const OLD_SERVER = /script\.google(usercontent)?\.com/;
const serverUrl = () => {
  const own = state.settings.serverUrl || '', cfg = window.ATTENDANCE_CONFIG?.serverUrl || window.ATTENDANCE_CONFIG?.sheetsUrl || '';
  return own && !(OLD_SERVER.test(own) && cfg && !OLD_SERVER.test(cfg)) ? own : cfg;
};

let toastTimer;
const scrollBehavior = () => (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, kind === 'err' ? 6000 : 3500);
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
  // Kept in the database and in a second place, so the device ID survives if one is lost.
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
  state.meta = { term: null, weeks: [], pending: [], rejected: [], aliases: [], staff: {}, terms: [], unlocks: [], archived: [], ...meta };
  renderClassSelects();
  $('#emptyRoster').hidden = markableUnits().length > 0;
  $('#rosterInfo').textContent = state.classes.length
    ? `On this device: ${markClasses().length} classes, ${markableUnits().length} units${state.meta.term ? ` - ${state.meta.term.name}` : ''}.`
    : 'No class lists on this device yet.';
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
function reportUnits() { return hasRole('HOD') || hasRole('MIS') || hasRole('IAO') ? state.units : markableUnits(); }
/** The units the Reports choices offer: this term's, or (looking back) the chosen earlier term's. */
const reportUnitList = () => (state.reportTerm ? state.pastUnits || [] : reportUnits());
/** Earlier terms, newest first; the running one is the first choice. */
function fillTermSelect() {
  const box = $('#rTermBox'); if (!box) return;
  const now = state.meta.term?.id || '';
  const past = (state.meta.terms || []).filter((t) => t.id !== now);
  box.hidden = !past.length;
  const sel = $('#rTerm'), keep = state.reportTerm || '';
  sel.innerHTML = `<option value="">${esc(state.meta.term ? `${state.meta.term.duration || state.meta.term.name} (current)` : 'Current term')}</option>`
    + past.map((t) => `<option value="${esc(t.id)}">${esc(t.duration || t.name)}</option>`).join('');
  sel.value = past.some((t) => t.id === keep) ? keep : '';
}
async function chooseReportTerm(termId) {
  state.reportTerm = termId || '';
  state.pastUnits = null;
  if (state.reportTerm) {
    if (!navigator.onLine) { toast('Earlier terms need internet', 'err'); state.reportTerm = ''; $('#rTerm').value = ''; }
    else {
      try {
        const res = await api('termUnits', { termId: state.reportTerm });
        if (!res.ok) throw new Error(res.error);
        state.pastUnits = res.units || [];
      } catch (e) { toast(e.message, 'err'); state.reportTerm = ''; $('#rTerm').value = ''; }
    }
  }
  Tables.reset('report');
  fillReportClasses();
  renderReport();
}
function fillReportClasses() {
  const list = reportUnitList();
  const codes = [...new Set(list.map((u) => u.classCode))].sort();
  // A class with streams is listed once; the Stream choice then shows all of them or one.
  const rep = [], groups = new Set();
  for (const code of codes) {
    const g = streamGroup(code);
    if (g) {
      if (groups.has(g.base)) continue;
      groups.add(g.base);
      const mis = [...new Set(g.codes.map((c) => state.classes.find((x) => x.code === c)?.misClass || ''))];
      rep.push({ value: 'streams:' + g.base, label: streamsLabel(g) + (mis.length === 1 && mis[0] ? ` (${mis[0]})` : '') });
      continue;
    }
    const c = state.classes.find((x) => x.code === code);
    rep.push({ value: code, label: c ? classLabel(c) : code });
  }
  fillSelect($('#rClass'), rep, undefined, rep.length ? null : 'No classes');
  renderReportUnitSelect();
}
/** The class with streams chosen in Reports ({ base, codes }), or null for a class without streams. */
function reportGroup() {
  const v = $('#rClass').value;
  if (!v.startsWith('streams:')) return null;
  const base = v.slice(8), codes = streamGroups().get(base);
  return codes ? { base, codes } : null;
}
/** May this person see this stream's report? The HOD and MIS Officer always; a trainer for the streams they teach. */
function streamAccess(classCode, unitCode) {
  if (reportUnitList().some((u) => u.classCode === classCode && u.code === unitCode)) return { ok: true };
  const u = (state.reportTerm ? state.pastUnits || [] : state.units).find((x) => x.classCode === classCode && x.code === unitCode);
  return u ? { ok: false, who: u.trainerName || '' } : { ok: false, none: true };
}
/** The streams that take the chosen unit, and which of them may be seen. */
function streamChoices() {
  const g = reportGroup(), unit = $('#rUnit').value;
  const acc = g ? g.codes.map((c) => ({ c, ...streamAccess(c, unit) })) : [];
  const taking = acc.filter((a) => !a.none), open = acc.filter((a) => a.ok).map((a) => a.c);
  // Two or more streams that may be seen are offered together: all of them, or (a trainer of some streams) theirs.
  return { acc, all: open.length > 1, every: open.length === taking.length, open };
}
function renderStreamSelect() {
  const g = reportGroup(), box = $('#rStreamBox'), sel = $('#rStream');
  if (!g) { box.hidden = true; sel.innerHTML = ''; delete sel.dataset.picked; return; }
  const prev = sel.value, { acc, all, every, open } = streamChoices(), unit = $('#rUnit').value;
  // Streams taught by someone else are shown but locked; a stream that doesn't take this unit can't be chosen.
  sel.innerHTML = (all ? `<option value="">${every ? 'All streams' : `Streams ${open.map((c) => esc(streamLetter(c))).join(' + ')} (yours)`}</option>` : '')
    + acc.map((a) => `<option value="${esc(a.c)}"${a.ok ? '' : ' disabled'}>Stream ${esc(streamLetter(a.c))}${a.ok ? '' : a.none ? ` - no ${esc(unit)}` : ` - locked${a.who ? ` (${esc(a.who)})` : ''}`}</option>`).join('');
  // All streams unless a stream was picked by hand (and can still be seen).
  const keep = sel.dataset.picked && acc.some((a) => a.ok && a.c === prev);
  sel.value = keep ? prev : all ? '' : (acc.find((a) => a.ok)?.c || '');
  box.hidden = false;
}
/** The one class the report is for, or '' when all streams are shown together. */
function reportClassCode() { return reportGroup() ? $('#rStream').value : $('#rClass').value; }
/** The classes the report covers: one, or every stream of the chosen class that takes the unit. */
function reportCodes() {
  const g = reportGroup();
  if (!g) return $('#rClass').value ? [$('#rClass').value] : [];
  return $('#rStream').value ? [$('#rStream').value] : streamChoices().open;
}
const isMyUnit = (u) => !!u && (!u.trainerCode || lower(u.trainerCode) === lower(me()?.code));

function normaliseRoster(input) {
  const classes = (input.classes || []).filter((c) => c.code).map((c) => ({
    _id: 'class:' + c.code, type: 'class', code: c.code, name: c.name || c.code, level: c.level || '', misClass: c.misClass || '' }));
  const known = new Set(classes.map((c) => c.code));
  const trainees = (input.trainees || []).filter((t) => t.admNo && t.classCode).map((t) => ({
    _id: 'trainee:' + t.admNo, type: 'trainee', admNo: t.admNo, name: t.name || t.admNo, classCode: t.classCode, active: t.active !== false, regCode: t.regCode || '' }));
  const units = (input.units || []).filter((u) => u.classCode && u.code).map((u) => ({
    _id: `unit:${u.classCode}:${u.code}`, type: 'unit', classCode: u.classCode, code: u.code, name: u.name || u.code,
    trainerCode: u.trainerCode || '', trainerName: u.trainerName || '', lessonsPerWeek: Number(u.lessonsPerWeek) || 2, hoursPerWeek: Number(u.hoursPerWeek) || 3,
    ...(Array.isArray(u.joint) && u.joint.length > 1 ? { joint: u.joint } : {}) }));
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

/* ---------------- downloads ---------------- */
function download(filename, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
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
const classLabel = (c) => c.misClass && c.misClass !== c.code ? `${c.code} (${c.misClass})` : (c.name && c.name !== c.code ? `${c.code} - ${c.name}` : c.code);

function renderClassSelects() {
  const mark = markClasses().map((c) => ({ value: c.code, label: classLabel(c) }));
  fillSelect($('#fClass'), mark, undefined, mark.length ? null : 'No classes');
  fillTermSelect();
  if (!state.reportTerm) fillReportClasses();
  renderUnitSelect();
  applyWantedReport();
}
/* A report asked for (e.g. from the HOD's approval list) before the class lists finished downloading
 * is opened as soon as its class and unit are available. */
function applyWantedReport() {
  const w = state.wantReport;
  const g = w && streamGroup(w.classCode), value = g ? 'streams:' + g.base : w?.classCode;
  if (!w || ![...$('#rClass').options].some((o) => o.value === value)) return false;
  $('#rClass').value = value;
  renderReportUnitSelect();
  if (![...$('#rUnit').options].some((o) => o.value === w.unitCode)) return false;
  $('#rUnit').value = w.unitCode;
  if (g) { $('#rStream').dataset.picked = '1'; renderStreamSelect(); $('#rStream').value = w.classCode; }
  state.wantReport = null;
  if (state.activeTab === 'reports') renderReport();
  return true;
}
function openReport(classCode, unitCode) {
  if (state.reportTerm) { state.reportTerm = ''; state.pastUnits = null; fillTermSelect(); fillReportClasses(); }
  state.wantReport = { classCode, unitCode };
  switchTab('reports');
  if (!applyWantedReport()) $('#reportSummary').innerHTML = '<p class="empty">Loading the class lists…</p>';
}
function renderUnitSelect() {
  const opts = unitsFor($('#fClass').value).map((u) => ({ value: u.code, label: u.code + ' - ' + u.name }));
  fillSelect($('#fUnit'), opts, undefined, opts.length ? null : 'No units for this class');
  renderStreamChoice();
  renderTimetable();
}

/* ---------------- choosing the lesson: week and timetable ---------------- */
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Weeks to choose from: the term's 12 teaching weeks, or (no term yet) the last few weeks. */
function weekOptions() {
  const weeks = state.meta.weeks || [], cats = state.meta.term?.catWeeks || [];
  // Short: "Week 6 - 12 Oct", or "Week 6 - CAT" (the timetable below shows each day's date).
  if (weeks.length) return weeks.map((m, i) => ({ value: m, label: `Week ${i + 1} - ${cats.includes(i + 1) ? 'CAT' : fmtShort(m)}` }));
  const now = TermReport.mondayOf(todayISO());
  return [0, 1, 2, 3, 4, 5].map((k) => addDays(now, -7 * k)).map((m) => ({ value: m, label: `Week of ${fmtShort(m)}` }));
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
  const catRadio = $('input[name="fKind"][value="cat"]'), lessonRadio = $('input[name="fKind"][value="lesson"]');
  catRadio.disabled = !cat;
  $('#kindCat').classList.toggle('off', !cat);
  $('#kindCat').title = cat ? '' : 'CAT registers are for the CAT weeks the MIS Officer set';
  // In a CAT week there are no lessons: the CAT register (or extra CAT attendance) is taken instead.
  lessonRadio.disabled = cat;
  lessonRadio.closest('.kchip').classList.toggle('off', cat);
  lessonRadio.closest('.kchip').title = cat ? 'This is a CAT week: take the CAT register, or extra CAT attendance' : '';
  if (cat && lessonRadio.checked) catRadio.checked = true;
  if (!cat && catRadio.checked) lessonRadio.checked = true;
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
  // A slot marked "repeat every week" is already chosen when you reach a week without a register in it.
  const rkey = `${classCode}|${unitCode}`;
  const repeats = (state.settings.repeats || {})[rkey] || [];
  if ((!state.pick || state.pick.monday !== monday || (state.pick.classCode && (state.pick.classCode !== classCode || state.pick.unitCode !== unitCode))) && repeats.length && state.autoOff !== `${monday}|${rkey}` && chosenKind() === 'lesson') {
    const nowIso = todayISO();
    for (const r of repeats) {
      const date = addDays(monday, r.day);
      if (date > nowIso) continue;
      const free = Array.from({ length: r.slots }, (_, k) => r.slot + k).every((n) => !mineHere[`${date}|${n}`]);
      if (free) { state.pick = { monday, date, slot: r.slot, slots: r.slots, classCode, unitCode }; break; }
    }
  }
  const lessonMode = chosenKind() === 'lesson';
  if (lessonMode && state.pick?.slot === LUNCH_SLOT) state.pick = null;   // lunch is never a lesson
  // The chosen slot belongs to one class, unit and week; a background refresh of the lists keeps it.
  const p = state.pick;
  const sel = p && p.monday === monday && (!p.classCode || (p.classCode === classCode && p.unitCode === unitCode)) ? p : null;
  const today = todayISO();
  // Days run down the side and the six lessons across the top, with lunch as a thin column between them.
  const cellFor = (d, n) => {
    const key = `${d.date}|${n}`, have = mineHere[key], other = elsewhere[key];
    const picked = sel && sel.date === d.date && n >= sel.slot && n < sel.slot + sel.slots;
    const future = d.date > today;
    if (have) {
      const k = kindOf(have.doc);
      const c = countMarks(have.doc);
      return `<button type="button" class="tt-cell have ${k}${have.first ? '' : ' cont'}" data-open="${esc(have.doc._id)}" title="Open this register">
        <b>${have.first ? esc(k === 'lesson' ? (Number(have.doc.slots) === 2 ? 'Double' : 'Marked') : (have.doc.title || KIND_LABEL[k])) : '←'}</b>${have.first ? `<span>${c.P + c.L}/${c.P + c.L + c.A + c.E}</span>` : ''}</button>`;
    }
    return `<button type="button" class="tt-cell${picked ? ' picked' : ''}${picked && n > sel.slot ? ' cont' : ''}${future ? ' future' : ''}" data-date="${d.date}" data-slot="${n}" ${future ? 'disabled' : ''}
      aria-pressed="${picked}">${other ? `<span class="other">${esc(other.map((o) => o.classCode.split(' ').pop() + ' ' + o.unitCode).join(', '))}</span>` : ''}</button>`;
  };
  // Lunch: a thin break for lessons; for a CAT or extra attendance it is a slot that can be chosen.
  const lunchCell = (d) => (mineHere[`${d.date}|${LUNCH_SLOT}`] || !lessonMode ? cellFor(d, LUNCH_SLOT).replace('class="tt-cell', 'class="tt-cell lunch')
    : '<button type="button" class="tt-cell lunch off" disabled title="Lunch is for a CAT or extra attendance, not a lesson"></button>');
  let html = '<div class="tt-corner"></div>';
  SLOTS.forEach(([a, b], i) => {
    if (i === LUNCH_AFTER) html += `<div class="tt-lunch" title="Lunch ${LUNCH_TIME[0]}–${LUNCH_TIME[1]}${lessonMode ? '' : ': can be chosen for this'}"><span>Lunch</span></div>`;
    html += `<div class="tt-time"><b>${a.replace('.', ':')} - ${b.replace('.', ':')}</b></div>`;
  });
  for (const d of days) {
    html += `<div class="tt-day${d.date === today ? ' today' : ''}"><b>${d.name}</b><span>${esc(fmtShort(d.date))}</span></div>`;
    SLOTS.forEach((_, i) => {
      if (i === LUNCH_AFTER) html += lunchCell(d);
      html += cellFor(d, i + 1);
    });
  }
  box.classList.add('lunch-open');
  box.innerHTML = html;
  // The button says exactly what will open.
  const btn = $('#openBtn');
  if (sel) {
    $('#fDate').value = sel.date; $('#fPeriod').value = 'L' + sel.slot; $('#fSlots').value = String(sel.slots);
    btn.disabled = false;
    btn.textContent = 'Open register';
    const dayIdx = days.findIndex((d) => d.date === sel.date);
    const dayName = new Date(sel.date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' });
    $('#repeatBox').hidden = chosenKind() !== 'lesson';
    $('#repeatText').textContent = `Repeat every ${dayName} at ${(sel.slot === LUNCH_SLOT ? LUNCH_TIME : SLOTS[sel.slot - 1])[0].replace('.', ':')}`;
    $('#repeatOn').checked = repeats.some((r) => r.day === dayIdx && r.slot === sel.slot && r.slots === sel.slots);
  } else {
    $('#fDate').value = ''; $('#fPeriod').value = '';
    btn.disabled = true;
    btn.textContent = 'Tap a slot above (tap the next one too for a double)';
    $('#repeatBox').hidden = true;
  }
  renderWeekHint();
}
function pickSlot(date, slot) {
  const monday = TermReport.mondayOf(date), p = state.pick;
  // Lunch is one slot on its own: never half of a double.
  if (p && (slot === LUNCH_SLOT || p.slot === LUNCH_SLOT) && !(p.date === date && slot === p.slot)) {
    state.pick = { monday, date, slot, slots: 1, classCode: $('#fClass').value, unitCode: $('#fUnit').value };
    return renderTimetable();
  }
  if (p && p.monday === monday && p.date === date && p.classCode === $('#fClass').value && p.unitCode === $('#fUnit').value) {
    if (slot === p.slot && p.slots === 1) { state.pick = null; state.autoOff = `${monday}|${$('#fClass').value}|${$('#fUnit').value}`; return renderTimetable(); }           // tap again: clear
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
  if (kind === 'lesson' && slotNo(period) === LUNCH_SLOT) { toast('Lunch can hold a CAT or extra attendance, not a lesson', 'err'); return; }
  if (state.dirty) await saveCurrent();
  // A combined lesson opens (or starts) the register of every stream ticked, and shows them as one.
  const codes = chosenStreams(), docs = [];
  for (const code of codes) {
    const got = await sessionFor(code, { date, unitCode, period, slots, kind, title }, codes.length > 1);
    if (!got) return;                                          // the reason was shown
    if (got.open) { setCurrent(await withPartners(got.open)); return; }
    docs.push(got.doc);
  }
  state.pick = null;
  if (docs.length === 1) { setCurrent(docs[0], !docs[0]._rev); return; }
  for (const d of docs) d.combined = codes;
  setCurrent(combineDocs(docs), docs.every((d) => !d._rev));
  if (docs.some((d) => !d._rev) && docs.some((d) => d._rev)) markDirty();   // a stream added to a saved lesson is saved straight away
}
/** The register of one class for the chosen slot: the one on this device, or a new one.
 * Returns { doc }, { open } (another register already fills that slot: open it instead), or null (a message was shown). */
async function sessionFor(classCode, { date, unitCode, period, slots, kind, title }, combining) {
  const id = sessionId(date, classCode, unitCode, period, kind);
  const who = combining ? `Stream ${streamLetter(classCode)}: ` : '';
  try { return { doc: await db.get(id) }; }
  catch (err) { if (err.status !== 404) throw err; }
  const { week, term } = weekInfo(date);
  if (term && !week) { toast(`${fmtDate(date)} is not in a teaching week of ${term.name}`, 'err'); return null; }
  if (kind === 'cat' && !isCatWeek(TermReport.mondayOf(date))) { toast('CAT registers are for the CAT weeks set by the MIS Officer. Use "Extra CAT attendance" for other weeks.', 'err'); return null; }
  const sameWeek = (await byPrefix('session:')).filter((s) => s.classCode === classCode && s.unitCode === unitCode
    && TermReport.mondayOf(s.date) === TermReport.mondayOf(date));
  const n = slotNo(period);
  const clash = sameWeek.find((s) => s.date === date && (() => { const a = slotNo(s.period), b = a + (Number(s.slots) === 2 ? 1 : 0); return n <= b && n + slots - 1 >= a; })());
  if (clash && combining) { toast(`${who}that slot already has a register (${sessionLabel(clash)}). Untick stream ${streamLetter(classCode)} or choose another slot.`, 'err'); return null; }
  if (clash) { toast(`That slot already has a register (${sessionLabel(clash)}); opening it`); return { open: clash }; }
  if (kind === 'lesson') {
    const used = sameWeek.filter((s) => kindOf(s) === 'lesson').reduce((a, s) => a + (Number(s.slots) === 2 ? 2 : 1), 0);
    if (used + slots > MAX_LESSONS_PER_WEEK) {
      toast(`${who}${unitCode} already has ${used} lesson(s) in ${week ? 'week ' + week : 'this week'}. The register has room for ${MAX_LESSONS_PER_WEEK} a week${slots === 2 ? ' (a double counts as two)' : ''}; open one of those instead.`, 'err');
      return null;
    }
  }
  if (!rosterFor(classCode).length && navigator.onLine && state.auth) {
    toast('No students on this device for ' + classCode + ' yet — downloading class lists…');
    await pullRoster({ silent: true });
  }
  const unit = state.units.find((u) => u.classCode === classCode && u.code === unitCode);
  const cls = state.classes.find((c) => c.code === classCode);
  const marks = {}, names = {};
  for (const t of rosterFor(classCode)) { marks[t.admNo] = state.settings.defaultStatus || 'P'; names[t.admNo] = t.name; }
  const catNo = kind === 'cat' ? (state.meta.term?.catWeeks || []).indexOf(week) + 1 : 0;
  return { doc: {
    _id: id, type: 'session', date, classCode, className: cls?.name || classCode,
    unitCode, unitName: unit?.name || unitCode, period, slots, kind, title: kind === 'cat' ? (title || `CAT ${catNo || ''}`.trim()) : kind === 'extra' ? title : '',
    periodLabel: slotLabel(period, slots),
    termId: term?.id || '', week: week || '',
    trainerId: me()?.code || '', trainerName: trainerLabel(), deviceId: state.deviceId,
    marks, names, explicit: {}, notes: '', createdAt: nowISO(), updatedAt: nowISO(), editLog: [],
  } };
}

function setCurrent(doc, isNew = false) {
  state.current = doc;
  state.dirty = false;
  state.editReasonGiven = false;
  $('#regSearch').value = ''; Tables.reset('register');
  $('#regNotes').value = doc.notes || '';
  setSaveState(isNew ? 'Not saved yet' : 'Saved on this device', isNew ? '' : 'ok');
  renderRegister();
  $('#register').scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
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
  const codes = classParts(classCode);
  const rejected = new Set(state.meta.rejected.filter((r) => codes.includes(r.classCode)).map((r) => lower(r.admNo)));
  const out = new Map();
  for (const code of codes) {
    for (const t of activeTraineesFor(code)) if (!out.has(lower(t.admNo))) out.set(lower(t.admNo), { admNo: t.admNo, name: t.name, pending: false, regCode: t.regCode || '' });
  }
  const pend = [...state.meta.pending.filter((p) => codes.includes(p.classCode)),
    ...state.addreqs.filter((a) => codes.includes(a.classCode) && !a.done)];
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
  const rejected = new Set(state.meta.rejected.filter((r) => classParts(s.classCode).includes(r.classCode)).map((r) => r.admNo));
  for (const adm of Object.keys(s.marks || {})) {
    if (!listed.has(adm) && !rejected.has(adm)) list.push({ admNo: adm, name: s.names?.[adm] || adm, unlisted: true });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------- streams ----------------
 * Streams of one class differ only in a last letter: "ICT L6CS-26S-A" / "ICT L6CS-26S-B", "ICT L6CS-25SA" / "SB" / "SC".
 * A code counts as a stream only when the class list has another stream of it. */
const STREAM_RE = /^(.*\d{2}-?[A-Z])-?([A-H])$/;
const streamLetter = (code) => (STREAM_RE.exec(String(code || '')) || [])[2] || '';
function streamGroups() {
  if (streamGroups.from === state.classes) return streamGroups.map;
  const map = new Map();
  for (const c of state.classes) {
    const m = STREAM_RE.exec(c.code); if (!m) continue;
    const base = m[1].replace(/-$/, '');
    map.set(base, [...(map.get(base) || []), c.code].sort());
  }
  for (const [k, v] of map) if (v.length < 2) map.delete(k);
  streamGroups.from = state.classes; streamGroups.map = map;
  return map;
}
/** { base, codes } for a class that has streams, else null. */
function streamGroup(code) {
  const m = STREAM_RE.exec(String(code || '')); if (!m) return null;
  const base = m[1].replace(/-$/, ''), codes = streamGroups().get(base);
  return codes && codes.includes(code) ? { base, codes } : null;
}
const streamsLabel = (g) => `${g.base} (streams ${g.codes.map(streamLetter).join(', ')})`;

/* A combined lesson: streams taught together in one slot are marked on one register on screen, but each
 * stream keeps its own register (reports, sign-off, the HOD's overview and Drive stay per stream).
 * The screen holds a joined copy (_parts = the streams' registers); saving splits it back. */
const PER_STUDENT = ['marks', 'names', 'explicit', 'marksAt', 'viaQr'];
function combineDocs(docs) {
  docs = [...docs].sort((a, b) => a.classCode.localeCompare(b.classCode));
  const first = docs[0], codes = docs.map((d) => d.classCode);
  const v = { ...clone(first), classCode: codes.join(', '), className: codes.join(', '), combined: codes, _parts: docs.map(clone) };
  for (const f of PER_STUDENT) v[f] = Object.assign({}, ...docs.map((d) => d[f] || {}));
  const logs = new Map();
  for (const l of docs.flatMap((d) => d.editLog || [])) logs.set(`${l.at}|${l.device || ''}|${l.reason || ''}`, l);
  v.editLog = [...logs.values()].sort((x, y) => String(x.at).localeCompare(String(y.at)));
  v.notes = docs.map((d) => d.notes).find(Boolean) || '';
  v.idScan = docs.some((d) => d.idScan);
  const qr = docs.find((d) => d.qr)?.qr;
  if (qr) v.qr = clone(qr); else delete v.qr;
  v.createdAt = docs.map((d) => d.createdAt).filter(Boolean).sort()[0] || first.createdAt;
  return v;
}
/** Puts each student's marks back on their own stream's register; shared things (notes, QR, edit log) go on all. */
function splitDoc(v) {
  const parts = v._parts;
  const lists = parts.map((p) => new Set(rosterFor(p.classCode).map((t) => lower(t.admNo))));
  const ownerOf = (adm) => {
    const k = lower(adm);
    const req = state.addreqs.find((a) => !a.done && lower(a.admNo) === k && parts.some((p) => p.classCode === a.classCode));
    let i = req ? parts.findIndex((p) => p.classCode === req.classCode) : lists.findIndex((l) => l.has(k));
    if (i === -1) i = parts.findIndex((p) => p.marks && adm in p.marks);
    if (i === -1) { const t = state.trainees.find((x) => lower(x.admNo) === k); i = t ? parts.findIndex((p) => p.classCode === t.classCode) : -1; }
    return i === -1 ? 0 : i;
  };
  const out = parts.map(() => Object.fromEntries(PER_STUDENT.map((f) => [f, {}])));
  for (const f of PER_STUDENT) for (const [adm, val] of Object.entries(v[f] || {})) out[ownerOf(adm)][f][adm] = val;
  parts.forEach((p, i) => Object.assign(p, out[i], {
    notes: v.notes, editLog: v.editLog || [], idScan: !!v.idScan, combined: v.combined, updatedAt: v.updatedAt, updatedBy: v.updatedBy, deviceId: v.deviceId,
    trainerId: p.trainerId || v.trainerId, trainerName: p.trainerName || v.trainerName, ...(v.qr ? { qr: clone(v.qr) } : {}) }));
  return parts;
}
/** A register that was marked together with other streams opens with them again (those on this device). */
async function withPartners(doc) {
  const others = (doc.combined || []).filter((c) => c !== doc.classCode);
  if (!others.length) return doc;
  const docs = [doc];
  for (const c of others) { try { docs.push(await db.get(doc._id.replace(`:${doc.classCode}:`, `:${c}:`))); } catch { /* not on this device */ } }
  return docs.length > 1 ? combineDocs(docs) : doc;
}
/** Is this register the one on screen (on its own or as one stream of a combined lesson)? */
const isOnScreen = (id) => !!state.current && (state.current._id === id || !!state.current._parts?.some((p) => p._id === id));
/** Streams of the chosen class this trainer teaches the chosen unit in (2 or more: they can be combined). */
/** The classes the chosen lesson can be marked with: the other streams this trainer teaches the unit in, and the classes the
 * loading joins for this unit ("ICT L6ICT-26J, ICT L6ICT-26M-CT"; those start ticked). all includes the chosen class. */
function lessonPartners() {
  const cls = $('#fClass').value, unit = $('#fUnit').value;
  const mine = new Set(markableUnits().filter((u) => u.code === unit).map((u) => u.classCode));
  const joint = (markableUnits().find((u) => u.classCode === cls && u.code === unit)?.joint || []).filter((c) => mine.has(c) && c !== cls);
  const streams = (streamGroup(cls)?.codes || []).filter((c) => mine.has(c));
  const all = [...new Set([cls, ...streams, ...joint])].sort();
  return { all: all.length > 1 ? all : [], joint };
}
/** A short name for a class among others: its stream letter, or the last part of its code. */
const partTag = (code) => streamLetter(code) || String(code).split(' ').pop();
const comboKey = (all) => `${$('#fUnit').value}|${all.join(',')}`;
function renderStreamChoice() {
  const box = $('#fStreamsBox'); if (!box) return;
  const cls = $('#fClass').value, { all, joint } = lessonPartners();
  if (all.length < 2) { box.hidden = true; box.innerHTML = ''; return; }
  const saved = (state.settings.combine || {})[comboKey(all)];
  const streamsOnly = !!streamGroup(cls) && all.every((c) => streamGroup(cls).codes.includes(c));   // every class here is a stream of one class
  box.hidden = false;
  box.innerHTML = `<span class="kr-label">${streamsOnly ? 'Streams' : 'Classes'} in this lesson</span>` + all.map((c) => {
    // Saved: the classes marked together last time; this one goes with the chosen class only if both were in it.
    const self = c === cls, on = self || (saved ? saved.includes(cls) && saved.includes(c) : joint.includes(c));
    const title = self ? 'The class chosen above' : joint.includes(c) ? 'The loading has this unit taught to these classes together' : 'Tick to mark this stream on the same register (a combined lesson)';
    return `<label class="kchip" title="${title}"><input type="checkbox" value="${esc(c)}" ${on ? 'checked' : ''} ${self ? 'disabled' : ''}><span>${streamsOnly ? `Stream ${esc(streamLetter(c))}` : esc(partTag(c))}</span></label>`;
  }).join('');
}
const chosenStreams = () => {
  const cls = $('#fClass').value, box = $('#fStreamsBox');
  return !box || box.hidden ? [cls] : [cls, ...$$('input:checked:not(:disabled)', box).map((i) => i.value)].sort();
};
/** The classes ticked are remembered for this set of classes and unit (an untick too: joined classes start ticked). */
async function rememberStreams() {
  const { all } = lessonPartners(); if (!all.length) return;
  await saveSettings({ combine: { ...(state.settings.combine || {}), [comboKey(all)]: chosenStreams() } });
}

/** A register of a term that has ended stays as it is, unless the HOD or MIS Officer unlocked its class and unit. */
const endedTerm = (s) => !!(s?.termId && state.meta.term?.id && s.termId !== state.meta.term.id);
const isUnlocked = (s) => (s._parts || [s]).every((p) => (state.meta.unlocks || []).some((u) => u.termId === p.termId && u.classCode === p.classCode && u.unitCode === p.unitCode));
const termLocked = (s) => endedTerm(s) && !isUnlocked(s);
function stampMark(s, adm, at = nowISO()) { s.marksAt = { ...(s.marksAt || {}), [adm]: at }; }

function isLocked(s) {
  if (!s?._rev) return false;
  return (Date.now() - new Date(s.createdAt).getTime()) / 36e5 >= Number(state.settings.lockHours || 48);
}

function renderRegister() {
  const s = state.current;
  if (!s) { $('#register').hidden = true; return; }
  $('#register').hidden = false;
  const g = s._parts && streamGroup(s._parts[0].classCode);
  const allStreams = g && s._parts.every((p) => g.codes.includes(p.classCode));
  $('#regTitle').textContent = s._parts ? (allStreams ? `${g.base} - streams ${s._parts.map((p) => streamLetter(p.classCode)).join(' + ')}` : s._parts.map((p) => p.classCode).join(' + ')) : s.classCode;
  // On a combined lesson each student shows their stream.
  const streamTag = s._parts ? (() => {
    const of = new Map();
    for (const p of s._parts) for (const t of rosterFor(p.classCode)) of.set(lower(t.admNo), partTag(p.classCode));
    return (adm) => (of.has(lower(adm)) ? ` <span class="stag" title="Class">${esc(of.get(lower(adm)))}</span>` : '');
  })() : () => '';
  const wk = s.week ? `Week ${s.week} ` : '';
  const day = fmtDate(s.date).replace(/, (?=[0-9]{4}$)/, ' ');
  $('#regSub').textContent = `${s.unitName} - ${wk}(${day})${termLocked(s) ? ' - term ended, locked' : isLocked(s) ? ' - locked' : ''}`;
  $('#register').dataset.kind = kindOf(s);
  const q = $('#regSearch').value.trim().toLowerCase();
  const order = { P: 0, L: 1, E: 2, A: 3 };
  const by = $('#regSort')?.value || 'name';
  const all = rosterForCurrent().filter((t) => !q || t.name.toLowerCase().includes(q) || t.admNo.toLowerCase().includes(q))
    .sort(by === 'adm' ? (x, y) => x.admNo.localeCompare(y.admNo, undefined, { numeric: true })
      : by === 'absent' ? (x, y) => (order[s.marks?.[y.admNo]] ?? -1) - (order[s.marks?.[x.admNo]] ?? -1) || x.name.localeCompare(y.name)
        : (x, y) => x.name.localeCompare(y.name))
    .map((t, i) => ({ ...t, sn: i + 1 }));
  const rows = Tables.slice('register', all);
  $('#registerPager').innerHTML = Tables.bar('register', all);
  $('#traineeList').innerHTML = rows.length ? rows.map((t) => {
    const st = s.marks?.[t.admNo] || '';
    return `<li class="trow${t.unlisted ? ' unlisted' : ''}" data-adm="${esc(t.admNo)}">
      <span class="sn">${t.sn}</span>
      <div class="tinfo"><span class="tname">${esc(t.name)}${streamTag(t.admNo)}${qrTag(s, t.admNo)}${t.pending ? ' <span class="ptag" title="Waiting for the MIS Officer to approve">Pending</span>' : ''}</span><span class="tadm">${esc(t.admNo)}</span></div>
      <div class="seg" role="group" aria-label="Status for ${esc(t.name)}">
        ${Object.keys(STATUSES).map((k) => `<button type="button" data-s="${k}" class="${st === k ? 'on' : ''}" title="${STATUSES[k]}" aria-pressed="${st === k}">${k}</button>`).join('')}
      </div></li>`;
  }).join('') : q ? '<li class="empty">No trainees match.</li>'
    : `<li class="empty roster-empty"><b>No students on ${esc(s.classCode)}'s list on this device yet.</b>
      <span>Tap <b>Download class lists</b>. If it stays empty, the MIS Officer needs to upload this class's register, with stream ${esc(s.classCode.split(' ').pop())} ticked.</span>
      <button type="button" class="btn" data-action="pull-roster">Download class lists</button></li>`;
  renderCounts();
  const log = s.editLog || [];
  $('#editLogInfo').textContent = log.length
    ? `Edited after locking ${log.length} time(s). Last: ${fmtTime(log[log.length - 1].at)} by ${log[log.length - 1].by} - "${log[log.length - 1].reason}"`
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
  if (termLocked(s)) { toast('This register is from a term that has ended, so it is locked. The HOD or MIS Officer can unlock it.', 'err'); return false; }
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
  stampMark(s, adm);
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
  for (const t of rosterForCurrent()) { state.current.marks[t.admNo] = status; state.current.names[t.admNo] = t.name; stampMark(state.current, t.admNo); }
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
  // A combined lesson is saved as each stream's own register.
  for (const d of s._parts ? splitDoc(s) : [s]) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await db.put(clone(d));
        d._rev = r.rev;
        break;
      } catch (e) {
        if (e.status === 409 && attempt < 3) { const latest = await db.get(d._id); d._rev = latest._rev; continue; }
        setSaveState('Not saved: ' + e.message, 'err');
        toast('Could not save: ' + e.message, 'err');
        return;
      }
    }
  }
  if (s._parts) s._rev = s._parts[0]._rev;
  if (state.current === s && state.editSeq !== seq) return; // newer edits: the pending timer saves them
  state.dirty = false;
  setSaveState('Saved on this device', 'ok');
  refreshPending();
  scheduleAutoSync();
  if (!shownInGrid.has(s)) { shownInGrid.add(s); renderTimetable(); } // a new register appears on the timetable
}

async function closeRegister() {
  if (state.dirty) await saveCurrent();
  state.current = null;
  renderRegister();
}

/* ---------------- adding a student while marking (pending until the MIS Officer approves) ---------------- */
const WRONG_STREAM = 'In the wrong stream';
/** The stream a student is added to: the register's, or on a combined lesson the one chosen. */
const addTarget = () => (state.current?._parts ? $('#asStream').value : state.current?.classCode);
function openAddStudent() {
  if (!state.current) { toast('Open a register first', 'err'); return; }
  $('#addStudentForm').reset();
  $('#asMsg').textContent = '';
  const parts = state.current._parts;
  $('#asStreamBox').hidden = !parts;
  $('#asStream').innerHTML = (parts || []).map((p) => `<option value="${esc(p.classCode)}">${streamLetter(p.classCode) ? `Stream ${esc(streamLetter(p.classCode))} (${esc(p.classCode)})` : esc(p.classCode)}</option>`).join('');
  $('#asReason').innerHTML = '';
  fillAddStudent();
  $('#addStudentDialog').showModal();
  setTimeout(() => $('#asReason').focus(), 50);
}
/** The reason decides how the student is chosen: "In the wrong stream" picks from the other streams' lists; any other reason types them in. */
function fillAddStudent() {
  const mates = otherStreamStudents(addTarget()), form = $('#addStudentForm');
  const reasons = ['Late admission', ...(mates.length ? [WRONG_STREAM] : []), 'Transferred from another class', 'Missing from the class list', 'Other'];
  const keep = $('#asReason').value;
  $('#asReason').innerHTML = reasons.map((r) => `<option>${esc(r)}</option>`).join('');
  $('#asReason').value = reasons.includes(keep) ? keep : reasons[0];
  const swap = $('#asReason').value === WRONG_STREAM, was = form.dataset.swap === '1';
  form.dataset.swap = swap ? '1' : '';
  $('#asPickBox').hidden = !swap; $('#asAdmBox').hidden = swap;
  $('#asPick').required = swap; $('#asAdm').required = !swap;
  $('#asName').readOnly = swap;
  if (swap) {
    const prev = $('#asPick').value;
    $('#asPick').innerHTML = '<option value="">Choose the student</option>'
      + mates.map((t) => `<option value="${esc(t.admNo)}">${esc(t.admNo)} - ${esc(t.name)} (stream ${esc(streamLetter(t.classCode) || t.classCode)})</option>`).join('');
    $('#asPick').value = mates.some((t) => t.admNo === prev) ? prev : '';
    $('#asName').value = mates.find((t) => t.admNo === $('#asPick').value)?.name || '';
  } else if (was) { $('#asAdm').value = ''; $('#asName').value = ''; }
}
/** Students on the list of another stream of the class (a student may have been put in the wrong stream). */
function otherStreamStudents(target) {
  const g = streamGroup(target); if (!g) return [];
  const onTarget = new Set(rosterFor(target).map((t) => lower(t.admNo)));
  // The HOD and MIS Officer have every class list; a trainer gets the other streams' names with the class lists.
  const pool = [...state.trainees.filter((t) => t.active !== false).map((t) => ({ admNo: t.admNo, name: t.name, classCode: t.classCode })), ...(state.meta.streamMates || [])];
  const out = new Map();
  for (const t of pool) if (g.codes.includes(t.classCode) && t.classCode !== target && !onTarget.has(lower(t.admNo)) && !out.has(lower(t.admNo))) out.set(lower(t.admNo), t);
  return [...out.values()].sort((a, b) => a.admNo.localeCompare(b.admNo, undefined, { numeric: true }));
}
async function saveAddStudent(e) {
  e.preventDefault();
  const s = state.current; if (!s) return;
  const msg = $('#asMsg'), swap = $('#asReason').value === WRONG_STREAM;
  // On a combined lesson the student is added to the stream chosen.
  const classCode = addTarget();
  const picked = swap ? otherStreamStudents(classCode).find((t) => t.admNo === $('#asPick').value) : null;
  if (swap && !picked) { msg.textContent = 'Choose the student from the list.'; return; }
  const adm = picked ? picked.admNo : $('#asAdm').value.trim().toUpperCase().replace(/\s+/g, ''), name = picked ? picked.name : $('#asName').value.replace(/\s+/g, ' ').trim();
  if (!picked && !Imports.isAdm(adm)) { msg.textContent = 'Use the admission number as written on the class list, for example L6CS/25S/305999.'; return; }
  if (name.length < 3) { msg.textContent = 'Enter the student\'s full name.'; return; }
  if (rosterFor(classCode).some((t) => lower(t.admNo) === lower(adm))) { msg.textContent = `${adm} is already on this class list.`; return; }
  const elsewhere = [...state.trainees, ...(state.meta.streamMates || [])].find((t) => lower(t.admNo) === lower(adm) && !classParts(s.classCode).includes(t.classCode));
  if (!(await ensureEditable())) return;
  const id = `addreq:${classCode}|${adm}`;
  let doc;
  try { doc = await db.get(id); } catch { doc = { _id: id }; }
  Object.assign(doc, { type: 'addreq', admNo: adm, name, classCode, reason: $('#asReason').value, addedAt: nowISO(),
    addedBy: me()?.code || '', sentAt: '', done: false, note: elsewhere ? `On the list of ${elsewhere.classCode}` : '' });
  await db.put(doc);
  state.addreqs = await byPrefix('addreq:');
  s.marks[adm] = $('#asMark').value;
  s.names[adm] = name;
  stampMark(s, adm);
  s.explicit = { ...(s.explicit || {}), [adm]: true };
  $('#addStudentDialog').close();
  renderRegister();
  markDirty();
  toast(picked ? `${name} added as pending. They stay on ${picked.classCode}'s list until the MIS Officer or HOD moves them.`
    : elsewhere ? `${name} added as pending. They're on ${elsewhere.classCode}'s list; the MIS Officer will decide.` : `${name} added as pending. The MIS Officer will approve them.`, 'ok');
}

/* ---------------- QR scanning of ID cards ---------------- */
let scanStream = null, scanning = false;
async function startScan() {
  if (!state.current) { toast('Open a register first', 'err'); return; }
  if (!navigator.mediaDevices?.getUserMedia) { toast('This browser cannot use the camera', 'err'); return; }
  if (!(await ensureEditable())) return;
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) { toast('Camera not available: ' + e.message, 'err'); return; }
  // Scanning ID cards: everyone starts absent, and only the cards scanned (or students marked by hand) count as here.
  const s = state.current;
  if (!s.idScan) {
    s.idScan = true;
    for (const t of rosterForCurrent()) if (!s.explicit?.[t.admNo] && !s.viaQr?.[t.admNo]) { s.marks[t.admNo] = 'A'; s.names[t.admNo] = t.name; stampMark(s, t.admNo); }
    renderRegister(); markDirty();
    toast('Everyone starts absent; each card scanned marks that student');
  }
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
  out.textContent = `${t.name} - ${STATUSES[status]}`;
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
  setCurrent(await withPartners(doc));
}

/* ---------------- Reports: the term register ---------------- */
function renderReportUnitSelect() {
  const g = reportGroup(), seen = new Set();
  // For a class with streams: every unit this person may see in any of its streams.
  const units = g ? reportUnitList().filter((u) => g.codes.includes(u.classCode) && !seen.has(u.code) && seen.add(u.code)).sort((a, b) => a.code.localeCompare(b.code))
    : unitsFor($('#rClass').value, reportUnitList());
  const opts = units.map((u) => ({ value: u.code, label: u.code + ' - ' + u.name }));
  fillSelect($('#rUnit'), opts, undefined, opts.length ? null : 'No units');
  renderStreamSelect();
}

/** Lessons for one class and unit this term: this device's registers, plus the server's copy when online. */
async function reportSource(classCode, unitCode) {
  const tid = state.reportTerm || '';
  const unit = reportUnitList().find((u) => u.classCode === classCode && u.code === unitCode);
  const range = tid ? null : termRange();
  const local = (await byPrefix('session:')).filter((s) => s.classCode === classCode && s.unitCode === unitCode
    && (tid ? s.termId === tid : (!range || (s.date >= range.from && s.date <= range.to))))
    .map((s) => ({ id: s._id, date: s.date, period: sessionLabel(s), slots: Number(s.slots) === 2 ? 2 : 1, kind: kindOf(s), title: s.title || '',
      marks: s.marks || {}, names: s.names || {}, updatedAt: s.updatedAt, local: true }));
  const key = `report:${tid ? tid + '|' : ''}${classCode}|${unitCode}`;
  let server = null;
  if (navigator.onLine && state.auth) {
    try {
      const res = await api('report', tid ? { classCode, unitCode, termId: tid } : { classCode, unitCode });
      if (res.ok) { server = res; await updateLocal(key, (d) => { d.data = res; d.at = nowISO(); }); }
    } catch { /* use the cached copy */ }
  }
  if (!server) { const c = await getLocal(key), at = await resetAt(); if (c.data && !(at && String(c.at || '') < at)) server = { ...c.data, cached: c.at }; }
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
  if (state.reportMode === 'absences') return window.Alerts?.render();   // Absences is its own Report(s) section
  if (state.reportMode === 'marks') return Marks.render();
  const codes = reportCodes(), unitCode = $('#rUnit').value;
  const body = $('#reportBody');
  $('#signoffCard').hidden = true;
  if (!codes.length || !unitCode) {
    state.report = null;
    $('#reportSummary').innerHTML = '<p class="empty">Choose a class and unit to see its term register.</p>';
    body.innerHTML = ''; $('#reportControls').hidden = true; $('#reportLegend').hidden = true; $('#reportSource').textContent = '';
    return;
  }
  const token = (renderReport.seq = (renderReport.seq || 0) + 1);
  const parts = await Promise.all(codes.map((c) => reportPart(c, unitCode)));
  if (token !== renderReport.seq) return; // a newer choice was made meanwhile
  // One class, or all streams of a class: each stream's register is built on its own, then the rows are put together.
  const one = parts.length === 1, p0 = parts[0], g = reportGroup();
  const r = one ? p0.r : mergeReports(parts);
  const classCode = one ? p0.classCode : codes.join(', ');
  renderReportLock(one ? p0.src.server : null, classCode, unitCode);
  const mis = [...new Set(parts.map((p) => state.classes.find((c) => c.code === p.classCode)?.misClass || ''))];
  const cls = one ? (state.classes.find((c) => c.code === classCode) || { code: classCode })
    : { code: g.base, name: g.base, misClass: mis.length === 1 ? mis[0] : '', level: state.classes.find((c) => c.code === codes[0])?.level || '' };
  state.report = { r, unit: p0.unit, cls, classCode, unitCode, mine: one && p0.mine, signoff: one ? p0.src.server?.signoff || null : null,
    term: p0.src.server?.term || state.meta.term, parts, streams: one ? null : codes };

  const localCount = parts.reduce((a, p) => a + p.src.localCount, 0), servers = parts.map((p) => p.src.server);
  $('#reportSource').textContent = (servers.every(Boolean)
    ? (servers.some((s) => s.cached) ? `From the server as of ${fmtTime(servers.find((s) => s.cached).cached)}` : 'Up to date with the server')
      + (localCount ? ` - includes this device's ${localCount} register(s)` : '')
    : localCount ? 'From the registers on this device (connect to include other devices)' : (p0.mine ? 'No lessons marked yet for this unit this term.' : 'Connect to the internet to load this report.'))
    + (one ? '' : ' - Choose one stream to submit or approve its register.');
  if (!r.list.length) {
    $('#reportSummary').innerHTML = `<div class="empty-state"><svg class="i" aria-hidden="true"><use href="#i-me"/></svg><b>No trainees in this class yet</b><span>Once the class list is loaded, the register shows up here.</span></div>`;
    $('#reportControls').hidden = true; $('#reportLegend').hidden = true; $('#signoffCard').hidden = true; $('#catCard').hidden = true;
    body.innerHTML = '';
    return;
  }
  const helds = parts.map((p) => p.r.lessonsHeld), same = new Set(helds).size === 1;
  $('#reportSummary').innerHTML = `
    <div class="stat"><b>${same ? helds[0] : helds.join(' / ')}</b><span>Lessons recorded${same ? '' : ` (${parts.map((p) => p.letter).join(' / ')})`}</span></div>
    <div class="stat"><b>${r.list.length}</b><span>Trainees${one ? '' : ` in ${parts.length} streams`}</span></div>
    <div class="stat"><b>${r.avg}%</b><span>Average attendance</span></div>
    <div class="stat ${r.below ? 'warn' : ''}"><b>${r.below}</b><span>Below ${r.threshold}%</span></div>`;
  $('#reportControls').hidden = false;
  $('#chipBelow').textContent = `Below ${r.threshold}% (${r.below})`;
  const pendingN = r.list.filter((x) => x.pending).length;
  $('#chipPending').textContent = `Pending (${pendingN})`;
  $('#chipPending').hidden = !pendingN;
  $$('.chipbtn').forEach((b) => b.classList.toggle('on', b.dataset.filter === state.reportFilter));
  $('#legendHours').textContent = `Late counts - ${r.latePct}%, Excused counts - ${r.excusedPct}%`;
  $('#legendCat').hidden = !TermReport.catMap(r).size;
  $('#reportLegend').hidden = false;
  drawReportBody();
  if (one) renderSignoff();
  renderCats(parts.flatMap((p) => (one ? p.src.assessments : p.src.assessments.map((a) => ({ ...a, title: `${a.title || KIND_LABEL[kindOf(a)]} - stream ${p.letter}` })))),
    parts.flatMap((p) => rosterFor(p.classCode)));
}
/** One class's term register for the report. */
async function reportPart(classCode, unitCode) {
  const src = await reportSource(classCode, unitCode);
  const unit = src.unit || {};
  const mine = !state.reportTerm && isMyUnit(unit) && (hasRole('TRAINER') || hasRole('HOD'));
  const trainer = mine ? { latePct: state.settings.latePct, excusedPct: state.settings.excusedPct }
    : (state.meta.staff?.[unit.trainerCode] || { latePct: 50, excusedPct: 100 });
  const aliases = {};
  for (const a of state.meta.aliases || []) if (a.classCode === classCode) aliases[a.from] = a.to;
  const rejected = new Set((state.meta.rejected || []).filter((r) => r.classCode === classCode).map((r) => r.admNo));
  const threshold = Number($('#rThreshold').value || state.settings.threshold || 75);
  const r = TermReport.build({
    weeks: src.server?.weeks?.length ? src.server.weeks : state.meta.weeks, lessons: src.lessons,
    roster: rosterFor(classCode), aliases, rejected,
    lessonHours: src.server?.term?.lessonHours || (!state.reportTerm && state.meta.term?.lessonHours) || (unit.hoursPerWeek || 3) / (unit.lessonsPerWeek || 2),
    latePct: trainer.latePct, excusedPct: trainer.excusedPct, threshold,
    // CAT weeks have no lessons: the register shows each as one "CAT 1" column, dated from the CAT registers.
    catWeeks: (state.reportTerm ? src.server?.term?.catWeeks : src.server?.term?.catWeeks || state.meta.term?.catWeeks) || [],
    assessments: src.assessments,
  });
  return { classCode, letter: streamLetter(classCode) || classCode, src, unit, mine, r };
}
/** All streams on one register: every stream's rows, each tagged with its stream. */
function mergeReports(parts) {
  const list = parts.flatMap((p) => p.r.list.map((x) => ({ ...x, stream: p.letter })));
  const withPct = list.filter((x) => x.pct !== null);
  // A CAT week is one column only if no stream had lessons in it; its dates are every stream's.
  const cats = parts[0].r.cats.map((c) => {
    const all = parts.map((p) => p.r.cats.find((x) => x.w === c.w)).filter(Boolean);
    return { ...c, merge: all.length === parts.length && all.every((x) => x.merge), dates: [...new Set(all.flatMap((x) => x.dates))].sort() };
  });
  return { ...parts[0].r, list, cats, overflow: parts.flatMap((p) => p.r.overflow), lessonsHeld: Math.max(...parts.map((p) => p.r.lessonsHeld)),
    avg: withPct.length ? Math.round(withPct.reduce((a, x) => a + x.pct, 0) / withPct.length) : 0, below: list.filter((x) => x.below).length };
}

/** An earlier term's register is read only; the HOD and MIS Officer can unlock one class and unit for a week. */
function renderReportLock(server, classCode, unitCode) {
  const box = $('#reportLock'); if (!box) return;
  if (!server?.ended) { box.hidden = true; box.innerHTML = ''; return; }
  const can = hasRole('HOD') || hasRole('MIS');
  box.hidden = false;
  box.dataset.term = server.term?.id || ''; box.dataset.cls = classCode; box.dataset.unit = unitCode;
  box.innerHTML = server.unlocked
    ? `<span><b>Unlocked.</b> ${esc(server.term?.duration || server.term?.name || 'This term')} has ended, but this register can be changed for now.</span>${can ? '<button type="button" class="btn small" data-lock="relock">Lock again</button>' : ''}`
    : `<span><b>Locked.</b> ${esc(server.term?.duration || server.term?.name || 'This term')} has ended, so this register can be looked at but not changed.</span>${can ? '<button type="button" class="btn small" data-lock="unlock">Unlock for 7 days</button>' : ''}`;
}
async function toggleReportLock(action) {
  const box = $('#reportLock');
  try {
    const res = await api(action, { termId: box.dataset.term, classCode: box.dataset.cls, unitCode: box.dataset.unit, days: 7 });
    if (!res.ok) throw new Error(res.error);
    toast(action === 'unlock' ? 'Unlocked for 7 days. The trainer can correct this term\'s registers and marks.' : 'Locked again', 'ok');
    await pullRoster({ silent: true });
    renderReport();
  } catch (e) { toast(e.message, 'err'); }
}

/** CATs and extra CAT attendance for this class and unit (not part of the term register's hours). */
function renderCats(list, roster) {
  const card = $('#catCard');
  if (!list.length) { card.hidden = true; return; }
  const rows = [...list].sort((a, b) => (a.date + a.period).localeCompare(b.date + b.period)).map((l) => {
    const v = Object.values(l.marks || {});
    const sat = v.filter((x) => x === 'P' || x === 'L').length;
    return `<li><button type="button" class="mrow" ${l.local ? `data-session="${esc(l.id)}"` : 'disabled'}>
      <span><b>${esc(l.title || KIND_LABEL[kindOf(l)])}</b><small>${esc(fmtDate(l.date))} - ${esc(String(l.period).replace(/^.*?\s[·-]\s(?=Lesson)/, ''))}${l.local ? '' : ' - marked on another device'}</small></span>
      <span class="pill ${kindOf(l)}">${sat} sat - ${v.filter((x) => x === 'A').length} absent</span></button></li>`;
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
  // The order: tap a heading in the sheet view, or use the Sort choice; both set the same thing.
  list = Tables.sort('report', list, { adm: (x) => x.admNo, name: (x) => x.name, pct: (x) => x.pct, possible: (x) => x.possible, actual: (x) => x.actual }, 'adm');
  list.forEach((x, i) => { x.sn = i + 1; });
  const ord = Tables.sortState('report', 'adm');
  $('#rSort').value = ord.dir === 1 && { adm: 'list', name: 'name', pct: 'pct' }[ord.col] || 'custom';
  const view = reportView(), cats = TermReport.catMap(r);
  const tgl = $('#viewToggle');
  tgl.querySelector('use').setAttribute('href', view === 'sheet' ? '#i-rows' : '#i-grid');
  tgl.querySelector('span').textContent = view === 'sheet' ? 'List view' : 'Sheet view';
  const warn = r.overflow.length
    ? `<p class="card warn-banner">${r.overflow.length} lesson(s) are not on the register: ${r.overflow.slice(0, 3).map((l) => esc(fmtShort(l.date) + ' ' + l.period)).join(', ')}${r.overflow.length > 3 ? '…' : ''}. They fall outside the term's 12 weeks or go past 3 lessons in one week (a double counts as two).</p>` : '';
  if (view === 'sheet') {
    const th = (col, label, cls, extra) => Tables.th('report', col, label, cls, extra);
    $('#reportBody').innerHTML = warn + `<div class="card sheet-wrap">${TermReport.sheetTable({ ...r, list: Tables.slice('report', list) }, esc, th)}</div>${Tables.bar('report', list)}`;
    return;
  }
  $('#reportBody').innerHTML = warn + (list.length ? `<ul class="card rlist">${Tables.slice('report', list).map((x) => `
    <li class="rrow${x.below ? ' below' : ''}">
      <div class="rinfo"><b>${esc(x.name)}${x.stream ? ` <span class="stag" title="Stream">${esc(x.stream)}</span>` : ''}${x.pending ? ' <span class="ptag">Pending</span>' : ''}</b>
        <span class="tadm">${esc(x.admNo)}</span>${TermReport.strip(x.cells, cats)}</div>
      <div class="rpct"><b>${x.pct === null ? '–' : x.pct + '%'}</b><span>${x.actual}/${x.possible} h</span></div>
    </li>`).join('')}</ul>${Tables.bar('report', list)}` : '<p class="empty">Nobody matches this filter.</p>');
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
    html += `<label>HOD's comment<textarea id="soHod" rows="2" placeholder="Left empty: ${esc(OK_SAID.register)}">${esc(so.hodComment || '')}</textarea></label>
      <div class="row-actions"><button type="button" class="btn primary" id="soApprove">Approve register</button><button type="button" class="btn" id="soReturn">Return to trainer</button></div>`;
  }
  card.innerHTML = html;
  card.hidden = false;
}

async function submitSignoff() {
  const rep = state.report; if (!rep) return;
  if (!navigator.onLine) { toast('Submitting needs internet. Your register is safe on this device.', 'err'); return; }
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
    const body = { id: rep.signoff.id, decision, comment: $('#soHod').value.trim() };
    const res = decision === 'approved' ? await withPin('Approve this register', (pin) => api('decideSignoff', { ...body, pin })) : await api('decideSignoff', body);
    if (!res) return;
    if (!res.ok) throw new Error(res.error);
    rep.signoff = res.signoff;
    renderSignoff();
    toast(decision === 'approved' ? 'Register approved' : 'Register returned to the trainer', 'ok');
    window.Admin?.refreshBadge?.();
  } catch (e) { toast(e.message, 'err'); }
}

/** Opens a class and unit's marksheet in Reports (from Manage - Marksheets). */
window.openMarks = (cls, unit) => {
  switchTab('reports');
  const sel = $('#rClass');
  const opt = [...sel.options].find((o) => o.value === cls) || [...sel.options].find((o) => o.value.startsWith('streams:') && cls.startsWith(o.value.slice(8)));
  if (!opt) { toast(`${cls} is not in this term's classes`, 'err'); return; }
  sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true }));
  setTimeout(() => {
    if (opt.value.startsWith('streams:') && $('#rStream')) { $('#rStream').value = cls; $('#rStream').dispatchEvent(new Event('change', { bubbles: true })); }
    $('#rUnit').value = unit; $('#rUnit').dispatchEvent(new Event('change', { bubbles: true }));
    Marks.setMode('marks');
  }, 60);
};

/* ---------- approving: the PIN again, initials for signatures ---------- */
/** What an approval says when the comment is left empty (the server writes the same). */
const OK_SAID = { register: 'Checked - complete and in order.', poe: 'Checked - complete and acceptable.', marksheet: 'Checked - marks complete and in order.' };
/** A signature written as the person's initials: "Musumbi Denis" -> "M.D." */
const initials = (name) => String(name || '').replace(/[^A-Za-z\s'-]/g, ' ').split(/[\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + '.').join('');
/** Approving asks for the PIN again. It is kept in memory (never saved) for 5 minutes, so a run of approvals asks once. */
let pinMemo = null;
function askPin(what) {
  if (pinMemo && pinMemo.until > Date.now()) return Promise.resolve(pinMemo.pin);
  return new Promise((resolve) => {
    let d = $('#pinDialog');
    if (!d) {
      document.body.insertAdjacentHTML('beforeend', `<dialog id="pinDialog" class="pin-dialog"><form method="dialog"><h2>Confirm with your PIN</h2><p id="pinWhat" class="muted small"></p>
        <label>PIN<input id="pinInput" type="password" inputmode="numeric" autocomplete="current-password" maxlength="12"></label>
        <div class="row-actions"><button value="cancel" class="btn" formnovalidate>Cancel</button><button value="ok" class="btn primary">Approve</button></div></form></dialog>`);
      d = $('#pinDialog');
    }
    $('#pinWhat').textContent = what;
    $('#pinInput').value = '';
    d.returnValue = '';
    d.onclose = () => {
      const v = $('#pinInput').value.trim();
      $('#pinInput').value = '';
      if (d.returnValue === 'ok' && v) { pinMemo = { pin: v, until: Date.now() + 5 * 6e4 }; resolve(v); } else resolve(null);
    };
    d.showModal();
    $('#pinInput').focus();
  });
}
/** Runs call(pin); a wrong PIN asks again once. Gives null when the person cancels. */
async function withPin(what, call) {
  for (let i = 0; i < 3; i++) {
    const pin = await askPin(what);
    if (!pin) return null;
    const res = await call(pin);
    if (res && !res.ok && res.needPin) { pinMemo = null; toast(res.error, 'err'); continue; }
    return res;
  }
  return null;
}

/* ---------- approvals: the stamp, the approver's name and a QR code to the public check page ---------- */
const checkUrl = (ref) => new URL('check.html?r=' + encodeURIComponent(ref), location.href).href;
/** The approval block for printed documents. a = { ref, by, role, at }. */
function approvalBlock(a) {
  if (!a?.ref) return '';
  const d = new Date(a.at), day = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  let qr = '';
  try { const q = qrcode(0, 'M'); q.addData(checkUrl(a.ref)); q.make(); qr = q.createSvgTag({ cellSize: 3, margin: 1, scalable: true }); } catch { /* no QR library on this page */ }
  return `<div class="approval">
    <svg class="stamp" viewBox="0 0 220 110" role="img" aria-label="Approved stamp"><g transform="rotate(-5 110 55)">
      <rect x="6" y="8" width="208" height="94" rx="10" fill="none" stroke="currentColor" stroke-width="4"/><rect x="13" y="15" width="194" height="80" rx="7" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <text x="110" y="45" text-anchor="middle" font-size="26" font-weight="800" textLength="168" lengthAdjust="spacingAndGlyphs" fill="currentColor">APPROVED</text>
      <text x="110" y="66" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">${esc(String(a.role || '').toUpperCase())} - ${esc(day)}</text>
      <text x="110" y="84" text-anchor="middle" font-size="8.5" font-weight="700" textLength="178" lengthAdjust="spacingAndGlyphs" fill="currentColor">DEPARTMENT OF COMPUTING AND INFORMATICS</text></g></svg>
    <div class="approval-who"><b>Approved by ${esc(a.by)} (${esc(a.role)})</b><span>${esc(d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>
      <span>Ref <b>${esc(a.ref)}</b></span><span class="small">Scan the code to check this document.</span></div>
    ${qr ? `<div class="approval-qr">${qr}</div>` : ''}</div>`;
}

/** One class and unit's term register, built like the Reports screen (for reports made in bulk). */
async function reportFor(classCode, unitCode) {
  const p = await reportPart(classCode, unitCode);
  const cls = state.classes.find((c) => c.code === classCode) || { code: classCode };
  return { r: p.r, unit: p.unit, cls, classCode, unitCode, mine: false, signoff: p.src.server?.signoff || null, term: p.src.server?.term || state.meta.term, parts: [p], streams: null };
}
function registerExportData(rep = state.report) {
  const { r, unit, cls, classCode, unitCode, signoff, term } = rep;
  // All streams together: one register for the MIS class, with every stream's lecturer.
  const lecturers = rep.streams ? [...new Set(rep.parts.map((p) => p.unit.trainerName).filter(Boolean))].join(' / ') : '';
  const so = signoff;
  const lect = (rep.mine && rep === state.report ? $('#soComment')?.value.trim() : '') || so?.lecturerComment || '';
  const hod = so?.status === 'approved' ? [so.hodComment, `APPROVED by ${so.hodName} (HOD), ${fmtShort(so.decidedAt)}`, so.approvalRef && `Ref ${so.approvalRef} - check at ${checkUrl(so.approvalRef)}`].filter(Boolean).join(' - ') : (so?.hodComment || '');
  return TermReport.exportData(r, {
    lecturer: lecturers || unit.trainerName || (rep.mine ? trainerLabel() : ''), duration: term?.duration || '',
    classLabel: rep.streams ? `${cls.misClass ? cls.misClass + ' - ' : ''}${cls.code} streams ${rep.parts.map((p) => p.letter).join(', ')}` : cls.misClass ? `${cls.misClass} (${classCode})` : classCode, level: cls.level || '',
    subject: `${unitCode} - ${unit.name || unitCode}`, misClass: cls.misClass, classCode,
    sheetName: `${cls.code.split(' ').pop()} ${unitCode}`, lecturerComment: lect, hodComment: hod,
    assessments: rep.parts.flatMap((p) => p.src.assessments.map((a) => (rep.streams ? { ...a, title: `${a.title || KIND_LABEL[kindOf(a)]} - ${p.letter}` } : a))),
    approval: so?.status === 'approved' && so.approvalRef ? { ref: so.approvalRef, by: so.hodName, role: 'HOD', at: so.decidedAt } : null,
  });
}
async function exportXlsx() {
  if (!state.report) { toast('Choose a class and unit first', 'err'); return; }
  try {
    const t = await (await fetch('templates/class-register.xlsx')).arrayBuffer();
    const blob = await Xlsx.registerFile(t, registerExportData());
    download(`Register_${fileSafe(state.report.cls.code)}_${fileSafe(state.report.unitCode)}_${todayISO()}.xlsx`, blob);
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

function printQRCards() {
  const list = reportCodes().flatMap((c) => activeTraineesFor(c));
  if (!list.length) { toast('No trainees in this class', 'err'); return; }
  $('#printArea').innerHTML = list.map((t) => {
    const qr = qrcode(0, 'M'); qr.addData(t.admNo); qr.make();
    return `<div class="qr-card">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}<b>${esc(t.name)}</b><small>${esc(t.admNo)}</small><small>${esc(t.classCode)}</small></div>`;
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
    if (parsed) { setMaintenance(!!parsed.maintenance); return parsed; }
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

/** Signed-in call. If the sign-in has ended, shows the sign-in screen (nothing on the device is lost). */
async function api(action, body = {}) {
  if (!state.auth?.token) { showSignin(); throw new Error('Sign in first'); }
  const used = state.auth.token;
  const res = await callSheets('POST', { action, auth: used, ...body });
  // A reply to a request sent before a PIN change carries the old sign-in: ignore it rather than sign out.
  if (res && res.authError) { if (state.auth?.token === used) showSignin(res.error); throw new Error(res.error); }
  if (res && res.mustChange) { showSignin(); showPinForm(); throw new Error(res.error); }
  if (res && (res.busy || res.degraded === 'hard')) noteBusy();
  return res;
}
/* The server is at today's database read limit and some admin/reporting views are standing aside. Marking
 * attendance and syncing still work; say so once in a while rather than on every reply. */
let busyNotedAt = 0;
function noteBusy() {
  if (Date.now() - busyNotedAt < 10 * 60e3) return;
  busyNotedAt = Date.now();
  toast('The system is very busy (daily database read limit). Marking and syncing still work; some reports may be unavailable until tomorrow.', 'err');
}
/* The database has spent its daily read limit; nothing loads until it resets (00:00 UTC = 3.00 am EAT).
 * Show one calm, centered screen over everything and take it away as soon as the server answers again. */
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

/* Which register versions the server has. Kept per server address: after a move to a new server every
 * register on this device is sent again, so nothing is left behind. */
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
/* ---------- one trainer, several devices ----------
 * Each device sends its registers up and brings down the ones the trainer made elsewhere. Every mark carries
 * the time it was set; when two copies of a register meet, each student keeps the latest mark, so neither
 * device undoes the other. */
const CODE_OF = Object.fromEntries(Object.entries(STATUSES).map(([k, v]) => [v, k]));
function fromServer(x, local) {
  const marks = {}, names = {}, explicit = {}, marksAt = {};
  for (const m of x.marks || []) {
    const k = CODE_OF[m.status]; if (!k) continue;
    marks[m.admNo] = k; names[m.admNo] = m.name || m.admNo;
    if (m.explicit) explicit[m.admNo] = true;
    if (m.at) marksAt[m.admNo] = m.at;
  }
  const parts = String(x.sessionId).split(':');
  return { ...(local || {}), _id: x.sessionId, type: 'session', date: x.date, classCode: x.classCode, className: x.className || x.classCode,
    unitCode: x.unitCode, unitName: x.unitName || x.unitCode, period: parts[4] || local?.period || '', slots: Number(x.slots) === 2 ? 2 : 1,
    kind: x.kind || 'lesson', title: x.title || '', periodLabel: x.period || local?.periodLabel || '', termId: x.termId || '', week: x.week || '',
    trainerId: x.trainerId || '', trainerName: x.trainerName || '', deviceId: x.deviceId || local?.deviceId || '',
    marks, names, explicit, marksAt, notes: x.notes || '', createdAt: x.createdAt || '', updatedAt: x.updatedAt || '',
    editLog: x.editLog || [], viaQr: x.viaQr || {}, ...(x.combined?.length > 1 ? { combined: x.combined } : {}), ...(x.qr ? { qr: { ...(local?.qr || {}), secret: x.qr.secret, intervals: x.qr.intervals || [] } } : {}) };
}
function mergeDocs(a, b) {
  const newer = String(b.updatedAt || '') >= String(a.updatedAt || '') ? b : a, older = newer === b ? a : b;
  const at = (s, k) => s.marksAt?.[k] || s.createdAt || '';
  const out = { ...older, ...newer, marks: {}, names: { ...(older.names || {}), ...(newer.names || {}) }, explicit: {}, marksAt: {} };
  for (const k of new Set([...Object.keys(older.marks || {}), ...Object.keys(newer.marks || {})])) {
    const inN = k in (newer.marks || {}), inO = k in (older.marks || {});
    const src = !inO ? newer : !inN ? older : at(older, k) > at(newer, k) ? older : newer;
    out.marks[k] = src.marks[k];
    if (src.explicit?.[k]) out.explicit[k] = true;
    if (src.marksAt?.[k]) out.marksAt[k] = src.marksAt[k];
  }
  const logs = new Map();
  for (const l of [...(a.editLog || []), ...(b.editLog || [])]) logs.set(`${l.at}|${l.device || ''}|${l.reason || ''}`, l);
  out.editLog = [...logs.values()].sort((x, y) => String(x.at).localeCompare(String(y.at)));
  out.viaQr = { ...(older.viaQr || {}), ...(newer.viaQr || {}) };
  out.createdAt = [a.createdAt, b.createdAt].filter(Boolean).sort()[0] || '';
  return out;
}
const sameRegister = (a, b) => JSON.stringify([
  Object.entries(a.marks || {}).sort(),
  a.notes || '',
  a.slots || 1, a.kind || 'lesson', a.period || '', a.date || '',
  a.qr ? 'qr' : '', a.viaQr ? 'viaQr' : '', a.qrFolded ? 'qrFolded' : ''
]) === JSON.stringify([
  Object.entries(b.marks || {}).sort(),
  b.notes || '',
  b.slots || 1, b.kind || 'lesson', b.period || '', b.date || '',
  b.qr ? 'qr' : '', b.viaQr ? 'viaQr' : '', b.qrFolded ? 'qrFolded' : ''
]);
/** Brings one register from the server into this device, combined with whatever this device has of it. */
async function takeServerCopy(x) {
  if (!x?.sessionId) return false;
  if (isOnScreen(x.sessionId) && state.dirty) await saveCurrent();
  let local = null;
  try { local = await db.get(x.sessionId); } catch (e) { if (e.status !== 404) throw e; }
  const srv = fromServer(x, local);
  if (!local) { const { _rev, ...fresh } = srv; const r = await db.put(fresh); await markSent((m) => { m[fresh._id] = r.rev; }); return true; }
  if (sameRegister(local, srv)) return false;
  const merged = { ...mergeDocs(local, srv), _id: local._id, _rev: local._rev };
  if (sameRegister(merged, local)) return false;          // this device already has everything; it sends it next
  const r = await db.put(merged);
  if (sameRegister(merged, srv)) await markSent((m) => { m[merged._id] = r.rev; });
  return true;
}
/** The trainer's registers that reached the server from their other devices since the last time. */
async function pullMine({ force = false } = {}) {
  if (!state.auth || state.auth.mustChange || !navigator.onLine || !(hasRole('TRAINER') || hasRole('HOD'))) return 0;
  if (!force && Date.now() - (pullMine.at || 0) < 2 * 60e3) return 0;
  pullMine.at = Date.now();
  const key = `${serverUrl()}|${me()?.code || ''}`;
  const log0 = await getLocal('pullLog');
  let cursor = log0.cursors?.[key] || null, delSince = log0.delSince?.[key] || '', changed = 0;
  for (let page = 0; page < 60; page++) {
    const res = await api('mySessions', { cursor, delSince });
    if (!res.ok) throw new Error(res.error || 'Could not fetch your registers');
    // Deleted elsewhere: this copy goes too, unless it was made again here after the deletion.
    const drop = [];
    for (const g of res.deleted || []) {
      try { const d = await db.get(g.id); if (!(String(d.createdAt || '') > g.at)) drop.push(g.id); } catch { /* not on this device */ }
    }
    if (drop.length) changed += await dropLocal(drop);
    delSince = res.delSince || delSince;
    await updateLocal('pullLog', (d) => { d.delSince = { ...(d.delSince || {}), [key]: delSince }; });
    for (const raw of res.sessions || []) {
      let x; try { x = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
      if (await takeServerCopy(x)) changed++;
    }
    cursor = res.cursor;
    await updateLocal('pullLog', (d) => { d.cursors = { ...(d.cursors || {}), [key]: cursor }; });
    if (!res.more) break;
  }
  if (changed) renderTimetable();
  return changed;
}

/* ---------- deleting registers ----------
 * A register marked by mistake (wrong slot, marked twice, wrong class) can be deleted, one or many at once. Online, the
 * server removes it (from reports, the term register and Drive) and tells this trainer's other devices. Offline, only
 * registers that never left this device can go; the rest wait for internet. */
async function dropLocal(ids) {
  const docs = [];
  for (const id of ids) { try { docs.push(await db.get(id)); } catch { /* not here */ } }
  if (docs.length) await db.bulkDocs(docs.map((d) => ({ _id: d._id, _rev: d._rev, _deleted: true })));
  await markSent((m) => { for (const id of ids) delete m[id]; });
  if (state.current && ids.some((id) => isOnScreen(id))) { state.dirty = false; state.current = null; renderRegister(); }
  return docs.length;
}
async function deleteRegisters(ids) {
  ids = [...new Set(ids)];
  const out = { deleted: 0, failed: [], waiting: 0 };
  if (!ids.length) return out;
  if (state.dirty) await saveCurrent();
  let gone = [];
  if (navigator.onLine) {
    for (const part of chunk(ids, 100)) {
      const r = await api('deleteSessions', { ids: part });
      if (!r.ok) throw new Error(r.error || 'The server refused that');
      gone.push(...(r.deleted || [])); out.failed.push(...(r.failed || []));
    }
  } else {
    const map = await sheetsSyncMap();
    gone = ids.filter((id) => !map[id]);
    out.waiting = ids.length - gone.length;
  }
  out.deleted = await dropLocal(gone);
  renderTimetable(); refreshPending();
  return out;
}
function deletedToast(r) {
  const parts = [`Deleted ${r.deleted} register${r.deleted === 1 ? '' : 's'}`];
  if (r.waiting) parts.push(`${r.waiting} already sent - deleting them needs internet`);
  if (r.failed.length) parts.push(`${r.failed.length} not deleted: ${r.failed[0].error}`);
  toast(parts.join(' - '), r.failed.length || r.waiting ? 'err' : 'ok');
}
const DEL_WARN = 'Its marks go from this device, the server, the term register and Google Drive. This cannot be undone.';
const DEL_WARN_MANY = 'Their marks go from this device, the server, the term register and Google Drive. This cannot be undone.';
async function deleteOpenRegister() {
  const s = state.current; if (!s) return;
  const ids = (s._parts || [s]).filter((p) => p._rev).map((p) => p._id);
  if (!ids.length) { state.dirty = false; closeRegister(); return; }   // never saved: nothing to delete
  const what = `${s.classCode} - ${s.unitCode} - ${fmtShort(s.date)} ${sessionLabel(s)}`;
  if (!confirm(`Delete this register?

${what}${ids.length > 1 ? `
(all ${ids.length} streams)` : ''}

${DEL_WARN}`)) return;
  try { deletedToast(await deleteRegisters(ids)); } catch (e) { toast(e.message, 'err'); }
}
/** The registers on this device for the chosen class and unit, newest first, to tick and delete together. */
const delPicked = new Set();
async function openDeleteList() {
  const cls = $('#fClass').value, unit = $('#fUnit').value;
  if (!cls || !unit) { toast('Choose the class and unit first', 'err'); return; }
  if (state.dirty) await saveCurrent();
  delPicked.clear();
  await drawDeleteList();
  $('#delRegsDialog').showModal();
}
async function drawDeleteList() {
  const cls = $('#fClass').value, unit = $('#fUnit').value;
  const list = (await byPrefix('session:')).filter((s) => s.classCode === cls && s.unitCode === unit)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || slotNo(a.period) - slotNo(b.period));
  const uname = (unitsFor(cls).find((u) => u.code === unit) || {}).name || unit;
  const day = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const rows = list.map((s) => {
    const c = countMarks(s), wk = s.week ? `Week ${s.week} - ` : '';
    return `<li><label><input type="checkbox" data-delpick="${esc(s._id)}"${delPicked.has(s._id) ? ' checked' : ''}>
      <span><b>${esc(wk + day(s.date))} - ${esc(sessionLabel(s))}</b><small>${c.P + c.L}/${c.P + c.L + c.A + c.E} present${termLocked(s) ? ' - term ended' : ''}</small></span></label></li>`;
  }).join('');
  const n = delPicked.size;
  $('#delRegsBody').innerHTML = `<div class="scan-head"><strong>Delete registers - ${esc(cls)} - ${esc(unit)}</strong><button type="button" class="btn small ghost" data-delclose>Close</button></div>
    <p class="muted small">${esc(uname)}. Tick the registers marked by mistake. ${DEL_WARN_MANY}</p>
    ${list.length ? `<div class="batch-bar"><label class="kchip"><input type="checkbox" data-delall${n && n === list.length ? ' checked' : ''}><span>Select all ${list.length}</span></label>
      <button type="button" class="btn small danger solid" data-delgo${n ? '' : ' disabled'}>Delete selected${n ? ` (${n})` : ''}</button></div>
      <ul class="del-list">${rows}</ul>` : '<p class="muted">No registers for this class and unit on this device.</p>'}`;
}

async function pendingSessions() {
  const [sessions, map] = await Promise.all([byPrefix('session:'), sheetsSyncMap()]);
  return sessions.filter((s) => map[s._id] !== s._rev);
}
/** The register whose QR is on screen waits until 2 minutes after its last upload (unless a sync is forced). */
const qrSentAt = {};
function heldBack(s) {
  return $('#lessonQrDialog').open && isOnScreen(s._id) && Date.now() - (qrSentAt[s._id] || 0) < QR_UPLOAD_MS;
}
async function refreshPending() {
  const pending = await pendingSessions();
  const unsentReqs = state.addreqs.filter((a) => !a.sentAt).length;
  const n = pending.length + unsentReqs;
  const el = $('#pendingCount');
  if (el) {
    el.textContent = n;
    el.classList.toggle('zero', n === 0);
  }
  // Long-unsent registers matter most for QR lessons: students' scans are verified only once the lesson reaches the server.
  const oldest = pending.reduce((m, s) => (!m || s.updatedAt < m ? s.updatedAt : m), '');
  const days = oldest ? Math.floor((Date.now() - new Date(oldest).getTime()) / 864e5) : 0;
  const qr = pending.filter((s) => s.qr).length;
  const warn = $('#syncWarn');
  if (days >= 2) {
    warn.hidden = false;
    warn.textContent = `${pending.length} register(s) not sent for ${days} days${qr ? ` (${qr} with student QR check-ins waiting to be verified)` : ''}. They are safe on this device and will be sent when the device is online.`;
  } else if (state.storage === 'not-protected' && n) {
    warn.hidden = false;
    warn.textContent = 'Install this app (Browser menu → Add to Home screen) so the device keeps unsent registers safely.';
  } else warn.hidden = true;
}

function showSyncStatus(text) {
  const status = $('#sheetsStatus');
  if (status) { status.textContent = text; return; }
  const roster = $('#rosterInfo');
  if (roster && state.activeTab === 'me') roster.textContent = text;
}

/** The one way registers and marks leave this device (staff-outbox.js; the service worker uses the same code when the app is closed). */
async function outbox(opts = {}) {
  if (!state.auth?.token) { showSignin(); throw new Error('Sign in first'); }
  const used = state.auth.token;
  let out;
  for (let i = 0; i < 10; i++) {                       // the background worker may be sending right now: wait for it
    out = await StaffOutbox.run({ db, deviceId: state.deviceId, ...opts });
    if (!out.busy) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (out.authError) { if (state.auth?.token === used) showSignin(out.authMessage); throw new Error(out.authMessage || 'Sign in first'); }
  if (out.busy) throw new Error('Another send is still running');
  return out;
}
/** Asks the browser to send what is unsent even if the app gets closed (Chrome/Edge on Android; elsewhere it just works as before). */
function wakeOutbox() {
  try {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready.then((r) => r.sync && r.sync.register('ark-staff-outbox')).catch(() => {});
  } catch { /* not supported */ }
}
async function registerPeriodicOutbox() {
  try {
    if (!('serviceWorker' in navigator) || !navigator.permissions?.query) return;
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) return;
    const p = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (p.state === 'granted') await reg.periodicSync.register('ark-staff-outbox', { minInterval: 12 * 3600 * 1000 });
  } catch { /* not supported */ }
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
  if (!navigator.onLine) { wakeOutbox(); if (!silent) toast('No network — registers are safe on this device and will sync later'); return; }
  if (state.dirty) await saveCurrent();
  state.syncing = true;
  $('#syncBtn')?.classList.add('syncing');
  let sent = 0, locked = 0;
  const pushPending = async () => {
    const out = await outbox({ registers: true, marks: false, force, holdBack: heldBack,
      onBatch: async (batch, res) => {
        // The server combined this register with marks from another device: keep the combined copy here too.
        for (const r of res.results || []) if (r.status === 'merged' && r.session) await takeServerCopy(r.session);
        for (const s of batch) qrSentAt[s._id] = Date.now();
      } }).catch((e) => { sent += e.partial?.registers || 0; wakeOutbox(); throw e; });
    locked += out.locked; sent += out.registers;
    if (out.deleted) renderTimetable();
  };
  try {
    // Registers this trainer made on another device come down first, so nothing here is sent over them.
    const fromOthers = await pullMine({ force: !silent }).catch((e) => { console.warn('pull', e); return 0; });
    await pushPending();
    if (locked) toast(`${locked} register(s) from a term that has ended were not changed: they are locked. The HOD or MIS Officer can unlock them.`, 'err');
    await Marks.syncAll({ quiet: true }).catch(() => {});
    const reqs = await pushRequests();
    const qrUpdated = pull ? await pullCheckins() : 0; // uploads alone skip fetching; the live pulse handles that
    if (qrUpdated) await pushPending();
    await updateLocal('syncLog', (d) => { d.lastSheets = nowISO(); });
    renderSheetsStatus();
    if (!silent) {
      const parts = [];
      if (sent) parts.push(`Sent ${sent} register(s)`);
      if (fromOthers) parts.push(`${fromOthers} register(s) brought in from your other devices`);
      if (reqs) parts.push(`${reqs} added student(s) sent to the MIS Officer`);
      if (qrUpdated) parts.push(`QR check-ins added to ${qrUpdated} register(s)`);
      toast(parts.join(' - ') || 'Everything is already sent', 'ok');
    }
  } catch (e) {
    showSyncStatus(`Sync stopped${sent ? ` after ${sent} register(s)` : ''}: ${e.message}`);
    if (!silent) toast('Sync failed: ' + e.message, 'err');
  } finally {
    state.syncing = false;
    $('#syncBtn')?.classList.remove('syncing');
    refreshPending();
  }
}

let autoTimer;
function scheduleAutoSync() {
  clearTimeout(autoTimer);
  wakeOutbox();
  autoTimer = setTimeout(() => { if (navigator.onLine) syncSheets({ silent: true, pull: false }); }, 5000);
}

/** Starting afresh (the MIS Officer cleared the registers and marks on the server): this device drops its own copies made
 *  before that moment, once. Registers and marks made since are kept. */
async function applyReset(at) {
  if (!at) return;
  const log = await getLocal('syncLog');
  if (log.resetAt === at) return;
  const old = (await byPrefix('session:')).filter((s) => String(s.updatedAt || s.createdAt || '') < at);
  if (old.length) await db.bulkDocs(old.map((s) => ({ ...s, _deleted: true })));
  await updateLocal('syncLog', (d) => { d.resetAt = at; });
  await updateLocal('sheetsSync', (d) => { d.map = {}; }, { map: {} });
  if (old.length) toast(`The registers were cleared to start afresh - ${old.length} old register${old.length === 1 ? '' : 's'} removed from this device`, 'ok');
}
const resetAt = async () => (await getLocal('syncLog')).resetAt || '';

async function pullRoster({ silent = false } = {}) {
  if (!state.auth || state.auth.mustChange) return;
  const btn = $('#pullRoster'); btn.disabled = true;
  if (!silent) showSyncStatus('Downloading class lists...');
  try {
    const log0 = await getLocal('syncLog');
    // Background checks send the version this device has; the server then answers "unchanged" in a few bytes.
    const have = silent && state.trainees.length && log0.rosterServer === serverUrl() ? log0.rosterVersion || '' : '';
    const res = await api('roster', have ? { version: have } : {});
    if (!res.ok) throw new Error(res.error || 'Could not read the class lists');
    if (res.unchanged) {
      if (res.me) await saveAuth({ ...state.auth, staff: { ...state.auth.staff, ...res.me, roles: res.me.roles } });
      await updateLocal('syncLog', (d) => { d.lastRoster = nowISO(); });
      renderSheetsStatus();
      return;
    }
    if (!(res.trainees || []).length && state.trainees.length) throw new Error('the server has no students yet — kept the class lists already on this device');
    const r = await replaceRoster(res);
    await applyReset(res.resetAt);
    await updateLocal('meta', (d) => {
      Object.assign(d, { term: res.term || null, weeks: res.weeks || [], pending: res.pending || [], rejected: res.rejected || [], aliases: res.aliases || [], staff: res.staff || {},
        terms: res.terms || [], unlocks: res.unlocks || [], archived: res.archived || [], streamMates: res.streamMates || [] });
    });
    // Students this device added: done once the MIS Officer has decided (on the list, rejected or merged).
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
    // Manage drawn before the lists arrived: its class and unit choices fill in now.
    if ($('#cdClass') && !$('#cdClass').value) window.Admin?.redrawCandidates?.();
    if ($('#m-bulk') && !$('#m-bulk [data-bkpick]')) window.Bulk?.redraw();
    if (!silent) toast(`Class lists saved: ${markClasses().length} of your classes, ${r.trainees} students — you can now mark offline`, 'ok');
  } catch (e) {
    showSyncStatus('Class list download failed: ' + e.message);
    if (!silent) toast(e.message, 'err');
  } finally { btn.disabled = false; }
}

async function renderSheetsStatus() {
  const log = await getLocal('syncLog');
  const parts = [];
  if (log.lastSheets) parts.push(`Registers last sent ${fmtTime(log.lastSheets)}.`);
  if (log.lastRoster) parts.push(`Class lists downloaded ${fmtTime(log.lastRoster)}.`);
  showSyncStatus(parts.length ? parts.join('\n') : 'Not synced yet.');
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
}, 400);

/* ---------------- QR check-in: students scan a code the trainer shows ----------------
 * The lesson QR changes every QR_WINDOW seconds. Each code is an HMAC of the lesson and the
 * time window, made with a secret that only this device (and later the server) knows, so
 * students cannot make their own codes. The server checks every check-in against it. */
const QR_WINDOW = 20; // seconds — must match WINDOW_SECONDS in Code.gs
const qrWindow = (t = Date.now()) => Math.floor(t / 1000 / QR_WINDOW);
const b64url = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
// The student app's address is /student (Cloudflare Pages, GitHub Pages and the demo all serve student.html there).
const studentPageUrl = () => new URL('student', location.href.split('#')[0]).toString();

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
    for (const t of rosterForCurrent()) if (!s.explicit?.[t.admNo] && !s.viaQr?.[t.admNo]) { s.marks[t.admNo] = 'A'; s.names[t.admNo] = t.name; stampMark(s, t.admNo); }
    renderRegister();
    toast('Trainees who don\'t scan are marked absent unless you mark them yourself');
  }
  const w0 = qrWindow();
  s.qr.intervals.push([w0, w0]);
  markDirty();
  // Upload straight away, so the server can confirm students' scans from the first second.
  saveCurrent().then(() => { if (navigator.onLine) syncSheets({ silent: true, pull: false, force: true }); });
  renderQrLive();
  $('#lessonQrTitle').textContent = `${$('#regTitle').textContent} - ${s.unitCode} - ${sessionLabel(s)}`;
  $('#lessonQrSub').textContent = `${s.unitName} - ${fmtDate(s.date)}`;
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
      // A combined lesson: each other stream's code too, so every student checks in to their own stream's register.
      const xs = s._parts ? Object.fromEntries(await Promise.all(s._parts.slice(1).map(async (p) => [p.classCode, await qrToken(s.qr.secret, p._id, w)]))) : null;
      const url = studentPageUrl() + '#l=' + b64url({ v: 1, s: s._id, c: s.classCode, un: (kindOf(s) === 'lesson' ? '' : (s.title || 'CAT') + ' - ') + s.unitName, p: slotLabel(s.period, Number(s.slots) === 2 ? 2 : 1), n: s.trainerName, u: serverUrl(), w, t, ...(xs ? { x: xs } : {}) });
      const box = $('#lessonQrCode');
      box.innerHTML = qrSvg(url, 6);
      box.dataset.url = url;
    }
    const left = QR_WINDOW - ((Date.now() / 1000) % QR_WINDOW);
    $('#lessonQrBar').style.transform = `scaleX(${left / QR_WINDOW})`;
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

/* Background checks run ONLY during a live lesson — every few seconds while the QR is on screen, every 15 s
 * with today's QR register open — so students' scans show up as they happen. Outside a live lesson there is
 * no idle polling at all: a check runs once when the app is opened, comes back on screen, comes online or is
 * picked up after a rest, and then stops. Uploads of your own work go up separately (scheduleAutoSync). */
let liveTimer = null, liveBusy = false;
let lastTouch = Date.now();
const idle = () => Date.now() - lastTouch > IDLE_AFTER_MS;
async function liveTick() {
  Notices.tick();
  clearTimeout(liveTimer);
  if (liveBusy) return; // a check is already running; it schedules the next one when done
  // Off screen: nothing is asked and nothing is scheduled. visibilitychange starts it again.
  if (document.visibilityState === 'hidden') return;
  liveBusy = true;
  try {
    if (navigator.onLine && state.auth && !state.auth.mustChange && !state.syncing) {
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
  // Keep checking only while a live lesson needs it; otherwise this was a one-off check, so stop here — no idle polling.
  if (document.visibilityState !== 'hidden' && isLiveLesson()) liveTimer = setTimeout(liveTick, liveDelay());
}
function liveDelay() {
  // Only ever called during a live lesson: fast while the QR is on screen, a little slower with the register open.
  return $('#lessonQrDialog').open ? LIVE_FAST_MS : LIVE_MID_MS;
}
/* Check again now instead of waiting out the current round: when a live lesson starts, and when the
 * device is picked up after being left alone. */
function goLive() {
  if (document.visibilityState === 'hidden') return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(liveTick, 1000);
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
 * register for that lesson. Runs automatically whenever the device is online. */
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
    const open = isOnScreen(stored._id);   // on screen on its own, or as one stream of a combined lesson
    const doc = open ? state.current : stored;
    const wasSynced = !open && synced[stored._id] === stored._rev;
    doc.viaQr = doc.viaQr || {};
    let added = 0;
    for (const c of list) {
      if (doc.viaQr[c.admNo]) continue;
      doc.viaQr[c.admNo] = c.scannedAt || nowISO();
      if (!doc.explicit?.[c.admNo]) { doc.marks[c.admNo] = 'P'; stampMark(doc, c.admNo, c.scannedAt); }
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
  if ((hasRole('EAO') || hasRole('IAO')) && !hasRole('MIS') && !hasRole('HOD')) return 'poe';
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
  if (!confirm(pending ? `${pending} register(s) are not sent yet. They stay on this device and are sent after you sign in again. Sign out?` : 'Sign out of this device?')) return;
  await saveAuth(null);
  PoeStaff.reset();
  Notices.reset();
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
  const el = $('#dbInfo');
  if (!el) return;
  const info = await db.info();
  el.textContent = `Device ${state.deviceId} - ${info.doc_count} records stored - storage ${state.storage === 'protected' ? 'protected' : state.storage === 'not-protected' ? 'not protected - add the app to your home screen' : 'status unknown'} - app v${APP_VERSION}`;
}

/* ---------------- tabs, roles, network, wiring ---------------- */
function switchTab(name) {
  const btn = $(`.tabs button[data-tab="${name}"]`);
  if (!btn || btn.hidden) name = 'reports';
  state.activeTab = name;
  state.tabSeq = (state.tabSeq || 0) + 1;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (name === 'reports') renderReport();   // Absences moved to the POE tab (a section after Trainer POE)
  if (name === 'manage') window.Admin?.render();
  if (name === 'poe') PoeStaff.render();
  if (name === 'board') Notices.renderTab($('#board'));
  if (name === 'me') { renderDbInfo(); renderMe(); }
}

/** Shows only the sections this person's roles allow. */
function applyRoles() {
  const marks = hasRole('TRAINER') || hasRole('HOD');
  $('.tabs button[data-tab="mark"]').hidden = !marks;
  $('.tabs button[data-tab="tools"]').hidden = !marks;   // professional tools: coming soon
  $('.tabs button[data-tab="manage"]').hidden = !(hasRole('HOD') || hasRole('MIS') || hasRole('IAO'));
  // Notice Board: the staff who may post (everyone but an EAO visitor). Others still get messages via the bell.
  $('.tabs button[data-tab="board"]').hidden = !['TRAINER', 'HOD', 'MIS', 'IAO'].some(hasRole);
  // An External Assessment Officer (a visitor) sees only the POE tab's verification work and their Profile.
  $('.tabs button[data-tab="reports"]').hidden = hasRole('EAO') && !['TRAINER', 'HOD', 'MIS', 'IAO'].some(hasRole);
  // Absences is a Report(s) section for the HOD and MIS Officer only.
  const absBtn = $('#reportMode [data-rmode="absences"]'); if (absBtn) absBtn.hidden = !(hasRole('HOD') || hasRole('MIS'));
  $('.tabs').style.setProperty('--tabs', $$('.tabs button').filter((b) => !b.hidden).length);
  if ($(`.tabs button[data-tab="${state.activeTab}"]`)?.hidden) switchTab(marks ? 'mark' : $('.tabs button[data-tab="reports"]').hidden ? 'poe' : 'reports');
  renderIdentity();
  renderClassSelects();
  window.Admin?.refreshBadge?.();
  if (me()) PoeStaff.refreshBadge();
  Notices.show();
  if (me()) Notices.tick();
}

function updateNet() {
  const on = navigator.onLine;
  const b = $('#netBadge');
  b.textContent = on ? 'Online' : 'Offline';
  b.className = 'badge ' + (on ? 'online' : 'offline');
}

const ROLE_NAMES = { TRAINER: 'Trainer', HOD: 'HOD', MIS: 'MIS Officer', IAO: 'Internal Assessment Officer', EAO: 'External Assessment Officer' };
const ROLE_ORDER = ['HOD', 'MIS', 'IAO', 'EAO', 'TRAINER'];
/** "HOD, MIS Officer, Trainer": the biggest responsibility first, whatever order the server lists them in. */
const roleText = (s) => ROLE_ORDER.filter((r) => s.roles.includes(r)).map((r) => ROLE_NAMES[r]).join(', ');
function renderIdentity() {
  const s = me();
  $('#trainerLabel').textContent = !s ? 'Not signed in' : `${s.name} - ${roleText(s) || 'no role yet'}`;
}
/* ---------- the trainer's college Google account ----------
 * Students share their POE documents (in their own Drive) with this address, and the app opens them with it. */
/** How the staff app reaches the server for Google (connect once, fresh tokens afterwards), and whether the server does that. */
function setupGoogleServer() {
  if (typeof Google === 'undefined' || !Google.on()) return;
  Google.setServer('staff', { connect: (code) => api('googleConnect', { code }), token: () => api('googleToken', {}), supported: () => Google.supports() });
  Google.probe(serverUrl()).then(() => renderGoogleCard());
}
async function connectGoogle(choose = false) {
  if (!navigator.onLine) { toast('Connecting Google needs internet', 'err'); return false; }
  try {
    const g = await Google.connect('staff', { choose });
    const res = await api('setGoogle', { accessToken: g.token });
    if (!res.ok) throw new Error(res.error);
    await saveAuth({ ...state.auth, staff: { ...state.auth.staff, email: res.email } });
    renderMe();
    toast(`Connected: ${res.email}. Students' documents are shared with this address.`, 'ok');
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}
function renderGoogleCard() {
  const card = $('#googleCard'); if (!card) return;
  card.hidden = !(typeof Google !== 'undefined' && Google.on() && me());
  if (card.hidden) return;
  const mail = me().email || '';
  $('#googleInfo').innerHTML = mail
    ? `Connected: <b>${esc(mail)}</b>. Students' POE documents are shared with this address, and you open them with it.`
    : 'Connect your college Google account, so the POE documents students save in their own Drive are shared with you and you can open them.';
  $('#googleConnect').textContent = mail ? 'Use another account' : 'Connect Google';
}

function renderMe() {
  renderGoogleCard();
  const s = me();
  $('#meName').textContent = s?.name || 'Not signed in';
  $('#meRoles').textContent = s ? roleText(s) || 'No role yet' : '';
  const meta = $('#meMeta');
  if (meta) meta.textContent = s ? `Staff code ${s.code} - ${roleText(s) || 'No role yet - ask the MIS Officer'}` : '';
}

function fillSettingsForms() {
  const s = state.settings;
  if ($('#regSort')) $('#regSort').value = s.regSort || 'name';
  $('#setLock').value = s.lockHours; $('#setDefault').value = s.defaultStatus;
  $('#setLate').value = s.latePct; $('#setExcused').value = s.excusedPct;
  $('#rThreshold').value = s.threshold;
  const server = $('#setServer');
  if (server) server.value = s.serverUrl || '';
}

function wire() {
  $('#googleConnect')?.addEventListener('click', () => connectGoogle(!!me()?.email));
  // On wide screens the tabs become a side bar that starts just under the header, so it needs the header's height.
  const bar = $('.topbar');
  const measureBar = () => document.documentElement.style.setProperty('--top-h', bar.offsetHeight + 'px');
  measureBar(); window.addEventListener('resize', measureBar);
  if (window.ResizeObserver) new ResizeObserver(measureBar).observe(bar);
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  PoeStaff.wire();
  Notices.wire();
  Marks.wire();
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); switchTab(g.dataset.goto); } });

  // Sign-in
  $('#signinForm').addEventListener('submit', signIn);
  $('#pinForm').addEventListener('submit', savePin);
  $('#signOut').addEventListener('click', signOut);
  $('#changePin').addEventListener('click', () => { if (!navigator.onLine) { toast('Changing your PIN needs internet', 'err'); return; } showPinForm(); });

  // Mark
  $('#sessionForm').addEventListener('submit', openFromForm);
  $('#fClass').addEventListener('change', renderUnitSelect);
  $('#fUnit').addEventListener('change', () => { renderStreamChoice(); renderTimetable(); });
  $('#fStreamsBox').addEventListener('change', rememberStreams);
  $('#fWeek').addEventListener('change', () => renderKind());
  $$('input[name="fKind"]').forEach((r) => r.addEventListener('change', renderKind));
  $('#catCard').addEventListener('click', (e) => { const b = e.target.closest('[data-session]'); if (b) openSessionById(b.dataset.session); });
  $('#timetable').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { if (state.dirty) await saveCurrent(); setCurrent(await withPartners(await db.get(open.dataset.open))); return; }
    const cell = e.target.closest('.tt-cell[data-slot]');
    if (cell && !cell.disabled) pickSlot(cell.dataset.date, Number(cell.dataset.slot));
  });
  $('#traineeList').addEventListener('click', async (e) => {
    if (e.target.closest('[data-action="pull-roster"]')) { await pullRoster(); renderRegister(); return; }
    const b = e.target.closest('button[data-s]'); if (!b) return;
    setMark(b.closest('.trow').dataset.adm, b.dataset.s);
  });
  $('#repeatOn').addEventListener('change', async (e) => {
    const p = state.pick; if (!p) return;
    const rkey = `${$('#fClass').value}|${$('#fUnit').value}`, day = Math.round((new Date(p.date) - new Date(p.monday)) / 864e5);
    const all = { ...(state.settings.repeats || {}) };
    const list = (all[rkey] || []).filter((r) => !(r.day === day && r.slot === p.slot));
    if (e.target.checked) list.push({ day, slot: p.slot, slots: p.slots });
    all[rkey] = list;
    await saveSettings({ repeats: all });
    renderTimetable();
  });
  $('#regSearch').addEventListener('input', () => { Tables.reset('register'); renderRegister(); });
  $('#regSort').addEventListener('change', (e) => { saveSettings({ regSort: e.target.value }); Tables.reset('register'); renderRegister(); });
  Tables.on('register', renderRegister);
  $('#regNotes').addEventListener('input', () => { if (state.current) markDirty(); });
  $('#allPresent').addEventListener('click', () => setAll('P'));
  $('#allAbsent').addEventListener('click', () => setAll('A'));
  $('#addStudentBtn').addEventListener('click', openAddStudent);
  $('#addStudentForm').addEventListener('submit', saveAddStudent);
  for (const id of ['#asReason', '#asStream', '#asPick']) $(id).addEventListener('change', fillAddStudent);
  $('#cancelAddStudent').addEventListener('click', () => $('#addStudentDialog').close());
  $('#saveReg').addEventListener('click', async () => { state.dirty = true; await saveCurrent(); toast('Register saved on this device', 'ok'); });
  $('#closeReg').addEventListener('click', closeRegister);
  $('#delReg').addEventListener('click', deleteOpenRegister);
  $('#delRegsBtn').addEventListener('click', openDeleteList);
  $('#delRegsDialog').addEventListener('change', (e) => {
    const t = e.target;
    const boxes = $$('#delRegsBody [data-delpick]');
    if (t.matches('[data-delpick]')) { if (t.checked) delPicked.add(t.dataset.delpick); else delPicked.delete(t.dataset.delpick); }
    if (t.matches('[data-delall]')) { delPicked.clear(); boxes.forEach((i) => { i.checked = t.checked; if (t.checked) delPicked.add(i.dataset.delpick); }); }
    // The ticks stay as they are (no redraw); only the button and "Select all" follow them.
    const n = delPicked.size, go = $('#delRegsBody [data-delgo]'), all = $('#delRegsBody [data-delall]');
    if (go) { go.disabled = !n; go.textContent = n ? `Delete selected (${n})` : 'Delete selected'; }
    if (all) all.checked = boxes.length > 0 && n === boxes.length;
  });
  $('#delRegsDialog').addEventListener('click', async (e) => {
    if (e.target.closest('[data-delclose]')) { $('#delRegsDialog').close(); return; }
    const go = e.target.closest('[data-delgo]'); if (!go) return;
    const n = delPicked.size;
    if (!n || !confirm(`Delete ${n} register${n === 1 ? '' : 's'}?\n\n${n === 1 ? DEL_WARN : DEL_WARN_MANY}`)) return;
    go.disabled = true;
    try { const r = await deleteRegisters([...delPicked]); deletedToast(r); delPicked.clear(); } catch (err) { toast(err.message, 'err'); }
    await drawDeleteList();
  });
  $('#scanBtn').addEventListener('click', startScan);
  $('#lessonQrBtn').addEventListener('click', openLessonQR);
  $('#closeLessonQr').addEventListener('click', closeLessonQR);
  $('#lessonQrDialog').addEventListener('close', closeLessonQR);
  $('#stopScan').addEventListener('click', stopScan);
  $('#scanDialog').addEventListener('close', stopScan);

  // Reports
  Tables.on('report', () => drawReportBody());
  $('#rTerm').addEventListener('change', (e) => chooseReportTerm(e.target.value));
  $('#reportLock').addEventListener('click', (e) => { const b = e.target.closest('[data-lock]'); if (b) toggleReportLock(b.dataset.lock); });
  $('#rClass').addEventListener('change', () => { delete $('#rStream').dataset.picked; Tables.reset('report'); renderReportUnitSelect(); renderReport(); });
  $('#rUnit').addEventListener('change', () => { Tables.reset('report'); renderStreamSelect(); renderReport(); });
  $('#rStream').addEventListener('change', () => { $('#rStream').dataset.picked = '1'; Tables.reset('report'); renderReport(); });
  $('#rThreshold').addEventListener('change', async () => { await saveSettings({ threshold: Number($('#rThreshold').value) || 75 }); renderReport(); });
  $('#rSort').addEventListener('change', (e) => { const col = { list: 'adm', name: 'name', pct: 'pct' }[e.target.value]; if (col) Tables.setSort('report', col, 1); drawReportBody(); });
  $$('.chipbtn').forEach((b) => b.addEventListener('click', () => { Tables.reset('report'); state.reportFilter = b.dataset.filter; $$('.chipbtn').forEach((x) => x.classList.toggle('on', x === b)); drawReportBody(); }));
  $('#viewToggle').addEventListener('click', async () => { await saveSettings({ reportView: reportView() === 'sheet' ? 'list' : 'sheet' }); drawReportBody(); });
  $('#signoffCard').addEventListener('click', (e) => {
    if (e.target.closest('#soSubmit')) submitSignoff();
    if (e.target.closest('#soApprove')) decideSignoff('approved');
    if (e.target.closest('#soReturn')) decideSignoff('returned');
  });
  $('#exportXlsx').addEventListener('click', exportXlsx);
  $('#printReg').addEventListener('click', printRegister);
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
  $('#serverForm')?.addEventListener('submit', async (e) => { e.preventDefault(); await saveSettings({ serverUrl: $('#setServer').value.trim() }); toast('Server address saved', 'ok'); });
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
  $('#syncBtn')?.addEventListener('click', () => syncSheets());
  window.addEventListener('online', () => { updateNet(); syncSheets({ silent: true }); maybeRefreshRoster(); });
  window.addEventListener('offline', updateNet);
  // Automatic checks run only during a live lesson (students scanning). Otherwise a single check on open,
  // on return to the screen, on coming online, and when the device is picked up after a rest — nothing in between.
  liveTimer = setTimeout(liveTick, 1500);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(liveTimer); if (state.dirty) saveCurrent(); }
    if (document.visibilityState === 'visible') { lastTouch = Date.now(); liveTick(); if (navigator.onLine) maybeRefreshRoster(); }
  });
  // "Has anyone touched this device lately?" — a tap or a key press is enough to go back to once a minute.
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    document.addEventListener(ev, () => {
      const wasIdle = idle();
      lastTouch = Date.now();
      if (wasIdle) goLive();   // back from idle: check now rather than waiting out the slow round
    }, { passive: true, capture: true });
  }
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
  registerPeriodicOutbox();
  // When a new version of the app arrives, switch to it right away (unless something is unsaved or the QR is showing).
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (!state.dirty && !$('#lessonQrDialog')?.open) location.reload();
    else toast('App updated — it will refresh next time you open it');
  });
}

/** If start-up fails (for example, parts of two app versions were cached), clear the app's cached files once and reload.
 *  Registers and other data in the device's database are not touched. */
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
  setupGoogleServer();
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

// Start once every script on the page has run: admin.js, poe-staff.js and marks.js load after this file, and
// starting sooner could reach wire() before they exist (a fresh device, with nothing cached, hit that).
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(repairAndReload));
else init().catch(repairAndReload);
