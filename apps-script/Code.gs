/**
 * RVNP Attendance Register — Google Sheets backend (ICT Department).
 *
 * Paste this into Extensions > Apps Script of the Google Sheet that holds the attendance data,
 * run setup() once (it shows the first MIS Officer sign-in), then Deploy > New deployment >
 * Web app (Execute as: Me, Who has access: Anyone). After pasting a newer version of this file,
 * use Deploy > Manage deployments > Edit > Version: New version, so the URL stays the same.
 *
 * Who can do what (Roles column of the Staff tab):
 *   TRAINER  marks registers for the classes and units in their loading, adds students (pending)
 *   HOD      approves term registers, sees every class's reports and the department overview
 *   MIS      sets up terms, uploads trainer loading and class lists, approves students, manages staff
 *
 * Tabs:
 *   Staff       sign-in accounts and roles (PINs are stored only as salted hashes)
 *   Terms       term name, dates and breaks (10 teaching weeks each); one is active
 *   Classes     ClassCode (stream, as in the loading) | name | level | MisClass (the MIS class list it comes from)
 *   Loading     who teaches which unit to which class, per term (uploaded from the loading workbook)
 *   Trainees    the official class lists (uploaded by the MIS Officer from the class register PDFs)
 *   Requests    students added by trainers while marking, waiting for the MIS Officer
 *   Sessions    one row per lesson register                    (written by the app)
 *   Attendance  one row per trainee per lesson                 (written by the app)
 *   SignOffs    term registers submitted to and approved by the HOD
 *   CheckIns    every QR check-in a student phone sent, with its result
 *   Devices     which phone belongs to which student (delete a row to let a student change phone)
 *   AuditLog    who changed what in the Manage section
 *   SessionData raw register data used to merge trainer marks and QR check-ins (hidden)
 *   Units       optional: units per class, used only when the active term has no loading
 */

var SHEETS = {
  Staff: ['StaffCode', 'Name', 'Roles', 'Responsibility', 'Active', 'PinHash', 'PinSalt', 'PinVersion',
    'MustChange', 'LatePct', 'ExcusedPct', 'UpdatedAt'],
  Terms: ['TermID', 'Name', 'Duration', 'StartDate', 'Weeks', 'Breaks', 'Status', 'UpdatedAt'],
  Classes: ['ClassCode', 'ClassName', 'Level', 'MisClass', 'Population'],
  Units: ['ClassCode', 'UnitCode', 'UnitName'],
  Loading: ['LoadID', 'TermID', 'ClassCode', 'UnitCode', 'UnitName', 'TrainerCode', 'TrainerName',
    'LessonsPerWeek', 'HoursPerWeek', 'Population', 'UpdatedAt'],
  Trainees: ['AdmNo', 'Name', 'ClassCode', 'Active', 'Status', 'MisClass', 'AddedBy', 'AddedAt', 'UpdatedBy', 'UpdatedAt', 'Note'],
  Requests: ['RequestID', 'AdmNo', 'Name', 'ClassCode', 'Reason', 'RequestedBy', 'RequestedName', 'RequestedAt',
    'Status', 'DecidedBy', 'DecidedAt', 'MergedInto', 'Note'],
  Sessions: ['SessionID', 'Date', 'ClassCode', 'ClassName', 'UnitCode', 'UnitName', 'Period',
    'TrainerID', 'TrainerName', 'Present', 'Absent', 'Late', 'Excused', 'Total', 'AttendancePct',
    'Notes', 'Edits', 'DeviceID', 'CreatedAt', 'UpdatedAt', 'SyncedAt', 'TermID', 'Week'],
  Attendance: ['RecordID', 'SessionID', 'Date', 'ClassCode', 'UnitCode', 'UnitName', 'Period',
    'AdmNo', 'Name', 'Status', 'TrainerID', 'TrainerName', 'UpdatedAt', 'SyncedAt', 'Source'],
  SignOffs: ['SignOffID', 'TermID', 'ClassCode', 'UnitCode', 'UnitName', 'TrainerCode', 'TrainerName',
    'LecturerComment', 'SubmittedAt', 'Status', 'HodCode', 'HodName', 'HodComment', 'DecidedAt'],
  CheckIns: ['CheckInID', 'SessionID', 'AdmNo', 'Name', 'ClassCode', 'DeviceID', 'Window', 'Code',
    'ScannedAt', 'UpdatedAt', 'Status', 'Reason'],
  Devices: ['DeviceID', 'AdmNo', 'Name', 'ClassCode', 'RegisteredAt', 'LastSeen'],
  AuditLog: ['At', 'StaffCode', 'Name', 'Action', 'Details'],
  SessionData: ['SessionID', 'UpdatedAt', 'Json']
};
var NUMERIC = { Present: 1, Absent: 1, Late: 1, Excused: 1, Total: 1, AttendancePct: 1, Edits: 1,
  LessonsPerWeek: 1, HoursPerWeek: 1, Population: 1, Weeks: 1, Week: 1, PinVersion: 1, LatePct: 1, ExcusedPct: 1 };
var WINDOW_SECONDS = 20;   // how often the lesson QR changes — must match QR_WINDOW in app.js
var CODE_LENGTH = 10;
var TERM_WEEKS = 10;       // every term has 10 teaching weeks (the register template has 10 week blocks)
var STATUS_CODE = { Present: 'P', Absent: 'A', Late: 'L', Excused: 'E' };
var STATUS_NAME = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };
var INACTIVE = /^(no|n|false|0|inactive|left|discontinued|withdrawn)$/i;
var ROLES = ['TRAINER', 'HOD', 'MIS'];

/* ---------- menu & setup ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Attendance')
    .addItem('Set up sheets', 'setup')
    .addItem('Create or reset an MIS Officer sign-in', 'resetMisAccount')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) { sheet_(name); });
  addSampleRows_(ss);
  authSecret_();
  var hasMis = readTable_('Staff').some(function (r) { return hasRole_(r.Roles, 'MIS') && !INACTIVE.test(r.Active || ''); });
  if (!hasMis) resetMisAccount();
}

/** Creates the MIS account (code MIS) if needed and gives it a new one-time PIN. */
function resetMisAccount() {
  var pin = randomPin_();
  setStaffPin_('MIS', pin, true, { name: 'MIS Officer', roles: 'MIS' });
  var msg = 'MIS Officer sign-in for the attendance app:\n\nStaff code: MIS\nPIN: ' + pin +
    '\n\nYou will be asked to choose your own PIN after signing in. In the app, add the real staff and give roles under Manage > Staff.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from the editor: see the log */ }
  return pin;
}

/** Returns the tab, creating it (or updating its header row) when needed. */
function sheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var headers = SHEETS[name];
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    // Keep codes, dates and timestamps as text so Sheets does not reformat them.
    headers.forEach(function (h, i) {
      sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat(NUMERIC[h] ? '0.##' : '@');
    });
    if (name === 'SessionData') sh.hideSheet();
  } else {
    var head = sh.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
    if (head.join('|') !== headers.join('|')) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    }
  }
  return sh;
}

function addSampleRows_(ss) {
  var classes = ss.getSheetByName('Classes');
  if (classes.getLastRow() > 1) return; // only on a brand-new sheet
  classes.getRange(2, 1, 2, 5).setValues([
    ['ICT6A', 'Diploma in ICT L6 - Sept 2025 A', '6', '', ''],
    ['ICT5B', 'Certificate in ICT L5 - Jan 2026 B', '5', '', '']
  ]);
  ss.getSheetByName('Units').getRange(2, 1, 4, 3).setValues([
    ['ICT6A', 'PROG-601', 'Object Oriented Programming (Java)'],
    ['ICT6A', 'NET-602', 'Computer Networking'],
    ['ICT5B', 'APP-501', 'Computer Applications'],
    ['ICT5B', 'PROG-502', 'Fundamentals of Programming']
  ]);
  ss.getSheetByName('Trainees').getRange(2, 1, 4, 5).setValues([
    ['RVNP/ICT/0101', 'Achieng Mary Otieno', 'ICT6A', 'Yes', 'active'],
    ['RVNP/ICT/0102', 'Brian Kiprono Rotich', 'ICT6A', 'Yes', 'active'],
    ['RVNP/ICT/0201', 'Ian Kipchumba Kirui', 'ICT5B', 'Yes', 'active'],
    ['RVNP/ICT/0202', 'Joy Akinyi Ochieng', 'ICT5B', 'Yes', 'active']
  ]);
}

/* ---------- helpers ---------- */

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function hmacHex_(message, secret) { return hex_(Utilities.computeHmacSha256Signature(message, secret)); }
function sha256Hex_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function classFromSession_(sessionId) { return String(sessionId).split(':')[2] || ''; }
function unitFromSession_(sessionId) { return String(sessionId).split(':')[3] || ''; }
function lastChange_() { try { return CacheService.getScriptCache().get('LAST_CHECKIN') || ''; } catch (e) { return ''; } }
function markChanged_() { try { CacheService.getScriptCache().put('LAST_CHECKIN', nowIso_(), 21600); } catch (e) { /* cache is best-effort */ } }
function nowIso_() { return new Date().toISOString(); }
function todayIso_() { return Utilities.formatDate(new Date(), 'Africa/Nairobi', 'yyyy-MM-dd'); }
function lower_(s) { return String(s || '').trim().toLowerCase(); }
function randomPin_() { var p = ''; for (var i = 0; i < 6; i++) p += Math.floor(Math.random() * 10); return p; }
function hasRole_(roles, role) { return String(roles || '').toUpperCase().split(/[\s,;]+/).indexOf(role) !== -1; }
function rolesList_(roles) {
  var have = String(roles || '').toUpperCase().split(/[\s,;]+/);
  return ROLES.filter(function (r) { return have.indexOf(r) !== -1; });
}
function fail_(message, extra) { var e = new Error(message); if (extra) for (var k in extra) e[k] = extra[k]; throw e; }

/* ---------- web app ---------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    // Student app (no sign-in): the class and name dropdowns for first-time setup.
    if (p.action === 'classes') return json_(publicClasses_());
    if (p.action === 'classlist') return json_(classList_(p['class']));
    if (p.action === 'ping') return json_({ ok: true, version: '4.0.1', time: nowIso_() });
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_(errorOut_(err));
  }
}

function doPost(e) {
  try {
    var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    // Students send check-ins without signing in; each one is verified against the
    // lesson code the trainer's phone showed, so a check-in cannot be faked.
    if (b.action === 'checkin') return json_(receiveCheckins_(b.checkins || []));
    if (b.action === 'register') return json_(registerDevice_(b));
    if (b.action === 'login') return json_(login_(b));
    var me = auth_(b.auth);
    var handler = ACTIONS[b.action];
    if (!handler) return json_({ ok: false, error: 'Unknown action' });
    if (handler.role && !me.roles.some(function (r) { return handler.role.indexOf(r) !== -1; })) {
      fail_('This needs the ' + handler.role.join(' or ') + ' role. Ask the MIS Officer.');
    }
    if (me.mustChange && b.action !== 'setPin') fail_('Choose a new PIN first', { mustChange: true });
    return json_(handler.fn(b, me));
  } catch (err) {
    return json_(errorOut_(err));
  }
}

var ACTIONS = {
  setPin: { fn: function (b, me) { return setPin_(b, me); } },
  me: { fn: function (b, me) { return { ok: true, staff: me }; } },
  roster: { fn: function (b, me) { return readRoster_(me); } },
  pulse: { fn: function () { return { ok: true, last: lastChange_() }; } },
  push: { role: ['TRAINER', 'HOD'], fn: function (b, me) { return pushSessions_(b.sessions || [], me); } },
  checkins: { role: ['TRAINER', 'HOD'], fn: function (b) { return acceptedCheckins_(b.sessionIds || [], b.since || ''); } },
  addStudents: { role: ['TRAINER', 'HOD'], fn: function (b, me) { return addStudents_(b.students || [], me); } },
  mySettings: { fn: function (b, me) { return saveMySettings_(b, me); } },
  report: { fn: function (b, me) { return reportData_(b, me); } },
  submitSignoff: { role: ['TRAINER', 'HOD'], fn: function (b, me) { return submitSignoff_(b, me); } },
  signoffs: { fn: function (b, me) { return listSignoffs_(me); } },
  decideSignoff: { role: ['HOD'], fn: function (b, me) { return decideSignoff_(b, me); } },
  overview: { role: ['HOD', 'MIS'], fn: function () { return overview_(); } },
  saveTerm: { role: ['MIS'], fn: function (b, me) { return saveTerm_(b, me); } },
  uploadLoading: { role: ['MIS'], fn: function (b, me) { return uploadLoading_(b, me); } },
  importClassList: { role: ['MIS'], fn: function (b, me) { return importClassList_(b, me); } },
  students: { role: ['MIS', 'HOD'], fn: function (b) { return studentsOf_(b.misClass || '', b.classCode || ''); } },
  updateStudent: { role: ['MIS'], fn: function (b, me) { return updateStudent_(b, me); } },
  requests: { role: ['MIS', 'HOD'], fn: function () { return listRequests_(); } },
  decideRequest: { role: ['MIS'], fn: function (b, me) { return decideRequest_(b, me); } },
  staff: { role: ['MIS'], fn: function () { return listStaff_(); } },
  updateStaff: { role: ['MIS'], fn: function (b, me) { return updateStaff_(b, me); } }
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function errorOut_(err) {
  var out = { ok: false, error: String(err && err.message || err) };
  if (err && err.authError) out.authError = true;
  if (err && err.mustChange) out.mustChange = true;
  return out;
}

/* ---------- staff sign-in ---------- */

function authSecret_() {
  var props = PropertiesService.getScriptProperties();
  var s = props.getProperty('AUTH_SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('AUTH_SECRET', s); }
  return s;
}

function staffRows_() {
  var sh = sheet_('Staff');
  return { sh: sh, t: loadKeyed_(sh, SHEETS.Staff.length, true) };
}
var ST = { CODE: 0, NAME: 1, ROLES: 2, RESP: 3, ACTIVE: 4, HASH: 5, SALT: 6, VER: 7, MUST: 8, LATE: 9, EXC: 10, UPD: 11 };

function staffPublic_(r) {
  return { code: r[ST.CODE], name: r[ST.NAME], roles: rolesList_(r[ST.ROLES]), responsibility: r[ST.RESP],
    active: !INACTIVE.test(r[ST.ACTIVE] || ''), hasPin: !!r[ST.HASH], mustChange: /^yes$/i.test(r[ST.MUST] || ''),
    latePct: r[ST.LATE] === '' ? 50 : Number(r[ST.LATE]), excusedPct: r[ST.EXC] === '' ? 100 : Number(r[ST.EXC]) };
}

function newStaffRow_(code, name, roles, resp) {
  return [code, name || code, roles || 'TRAINER', resp || '', 'Yes', '', '', '0', 'Yes', '', '', nowIso_()];
}

/** Sets a staff member's PIN (creating the account when `create` is given). Bumps PinVersion, which signs out old sessions. */
function setStaffPin_(code, pin, mustChange, create) {
  var s = staffRows_();
  var key = lower_(code), i = s.t.index[key], row;
  if (i === undefined) {
    if (!create) fail_('No staff member with code ' + code);
    row = newStaffRow_(String(code).trim().toUpperCase(), create.name, create.roles, create.resp);
  } else row = s.t.rows[i].slice();
  if (create && create.roles && !hasRole_(row[ST.ROLES], create.roles)) row[ST.ROLES] = rolesList_(row[ST.ROLES] + ',' + create.roles).join(', ');
  row[ST.ACTIVE] = 'Yes';
  var salt = Utilities.getUuid().slice(0, 12);
  row[ST.SALT] = salt;
  row[ST.HASH] = sha256Hex_(salt + '|' + pin);
  row[ST.VER] = String((Number(row[ST.VER]) || 0) + 1);
  row[ST.MUST] = mustChange ? 'Yes' : 'No';
  row[ST.UPD] = nowIso_();
  upsert_(s.t, key, row);
  writeKeyed_(s.sh, s.t, SHEETS.Staff);
  clearStaffCache_();
  return row;
}

function makeToken_(row) {
  var payload = row[ST.CODE] + '|' + row[ST.VER] + '|' + Date.now();
  return payload + '|' + hmacHex_(payload, authSecret_()).slice(0, 32);
}

function login_(b) {
  var code = String(b.staff || '').trim(), pin = String(b.pin || '').trim();
  if (!code || !pin) fail_('Enter your staff code and PIN');
  var cache = CacheService.getScriptCache(), failKey = 'FAIL_' + lower_(code);
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) fail_('Too many wrong PINs. Try again in 15 minutes.');
  var s = staffRows_(), i = s.t.index[lower_(code)];
  var row = i === undefined ? null : s.t.rows[i];
  if (!row || INACTIVE.test(row[ST.ACTIVE] || '') || !row[ST.HASH] || sha256Hex_(row[ST.SALT] + '|' + pin) !== row[ST.HASH]) {
    cache.put(failKey, String(fails + 1), 900);
    fail_(row && !row[ST.HASH] ? 'No PIN has been set for this staff code yet. Ask the MIS Officer.' : 'Wrong staff code or PIN');
  }
  cache.remove(failKey);
  return { ok: true, token: makeToken_(row), staff: staffPublic_(row), mustChange: /^yes$/i.test(row[ST.MUST] || '') };
}

function clearStaffCache_() { try { CacheService.getScriptCache().remove('STAFF_V'); } catch (e) { /* best-effort */ } }

/** Checks a sign-in token: genuine, staff still active, and PIN not changed or reset since. */
function auth_(token) {
  var parts = String(token || '').split('|');
  if (parts.length !== 4) fail_('Sign in to continue', { authError: true });
  var payload = parts.slice(0, 3).join('|');
  if (hmacHex_(payload, authSecret_()).slice(0, 32) !== parts[3]) fail_('Sign in again', { authError: true });
  var cache = CacheService.getScriptCache(), cached = null;
  try { cached = JSON.parse(cache.get('STAFF_V') || 'null'); } catch (e) { cached = null; }
  if (!cached) {
    cached = {};
    staffRows_().t.rows.forEach(function (r) { if (r[0]) cached[lower_(r[0])] = r; });
    try { cache.put('STAFF_V', JSON.stringify(cached), 60); } catch (e) { /* too big: read each time */ }
  }
  var row = cached[lower_(parts[0])];
  if (!row || INACTIVE.test(row[ST.ACTIVE] || '') || String(row[ST.VER]) !== parts[1]) {
    fail_('Your sign-in has ended (PIN changed or account switched off). Sign in again.', { authError: true });
  }
  var p = staffPublic_(row);
  return { code: p.code, name: p.name, roles: p.roles, mustChange: p.mustChange, latePct: p.latePct, excusedPct: p.excusedPct };
}

function setPin_(b, me) {
  var pin = String(b.newPin || '').trim();
  if (!/^\d{4,8}$/.test(pin)) fail_('Use 4 to 8 digits for your PIN');
  if (/^(\d)\1+$/.test(pin) || '0123456789'.indexOf(pin) !== -1) fail_('Choose a PIN that is harder to guess');
  var row = setStaffPin_(me.code, pin, false);
  return { ok: true, token: makeToken_(row), staff: staffPublic_(row) };
}

function saveMySettings_(b, me) {
  var s = staffRows_(), i = s.t.index[lower_(me.code)];
  var row = s.t.rows[i].slice();
  var late = Math.max(0, Math.min(100, Math.round(Number(b.latePct))));
  var exc = Math.max(0, Math.min(100, Math.round(Number(b.excusedPct))));
  if (isFinite(late)) row[ST.LATE] = String(late);
  if (isFinite(exc)) row[ST.EXC] = String(exc);
  row[ST.UPD] = nowIso_();
  upsert_(s.t, lower_(me.code), row);
  writeKeyed_(s.sh, s.t, SHEETS.Staff);
  clearStaffCache_();
  return { ok: true, staff: staffPublic_(row) };
}

function audit_(me, action, details) {
  var sh = sheet_('AuditLog');
  var t = loadKeyed_(sh, SHEETS.AuditLog.length);
  var key = nowIso_() + '#' + Utilities.getUuid().slice(0, 6);
  // AuditLog is append-only; use a unique first column so upsert always appends.
  upsert_(t, key, [key.split('#')[0], me.code, me.name, action, String(details || '').slice(0, 2000)]);
  writeKeyed_(sh, t, SHEETS.AuditLog);
}

/* ---------- terms ---------- */

function activeTerm_() {
  var rows = readTable_('Terms').filter(function (r) { return /^active$/i.test(r.Status || ''); });
  if (!rows.length) return null;
  var r = rows[rows.length - 1];
  return { id: r.TermID, name: r.Name, duration: r.Duration, startDate: r.StartDate, weeks: TERM_WEEKS,
    breaks: String(r.Breaks || '').split(/[\s,;]+/).filter(Boolean) };
}

function mondayOf_(iso) {
  var d = new Date(iso + 'T00:00:00Z');
  var day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
/** Monday of each of the 10 teaching weeks, skipping break weeks. */
function teachingWeeks_(term) {
  if (!term || !term.startDate) return [];
  var breaks = {}; term.breaks.forEach(function (b) { breaks[mondayOf_(b)] = 1; });
  var out = [], d = new Date(mondayOf_(term.startDate) + 'T00:00:00Z');
  for (var guard = 0; out.length < TERM_WEEKS && guard < 60; guard++) {
    var iso = d.toISOString().slice(0, 10);
    if (!breaks[iso]) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}
function weekOf_(term, dateIso) {
  var weeks = teachingWeeks_(term);
  var i = weeks.indexOf(mondayOf_(dateIso));
  return i === -1 ? '' : i + 1;
}

function saveTerm_(b, me) {
  if (!b.name || !/^\d{4}-\d{2}-\d{2}$/.test(b.startDate || '')) fail_('Give the term a name and a start date');
  var sh = sheet_('Terms'), t = loadKeyed_(sh, SHEETS.Terms.length);
  var id = String(b.termId || '').trim() || ('T' + b.startDate);
  var breaks = (b.breaks || []).filter(function (x) { return /^\d{4}-\d{2}-\d{2}$/.test(x); }).map(mondayOf_);
  // Only one active term: the new one replaces the old one as active.
  t.rows.forEach(function (r, i) { if (r[0] !== id && /^active$/i.test(r[6])) { var c = r.slice(); c[6] = 'closed'; upsert_(t, r[0], c); } });
  upsert_(t, id, [id, b.name, b.duration || '', b.startDate, String(TERM_WEEKS), breaks.join(', '), b.close ? 'closed' : 'active', nowIso_()]);
  writeKeyed_(sh, t, SHEETS.Terms);
  audit_(me, b.close ? 'close term' : 'save term', id + ' ' + b.name + ' from ' + b.startDate + (breaks.length ? ' breaks ' + breaks.join(' ') : ''));
  var term = activeTerm_();
  return { ok: true, term: term, weeks: teachingWeeks_(term) };
}

/* ---------- trainer loading ---------- */

function levelOf_(classCode) { var m = /L(\d)/i.exec(String(classCode)); return m ? m[1] : ''; }

function uploadLoading_(b, me) {
  var term = activeTerm_();
  if (!term) fail_('Set up the term first (Manage > Term)');
  var rows = (b.rows || []).filter(function (r) { return r && r.classCode && r.unitCode; });
  if (!rows.length) fail_('No loading rows found in that file');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var now = nowIso_();
    // Loading: replace this term's rows, keep other terms.
    var keep = readTable_('Loading').filter(function (r) { return r.TermID && r.TermID !== term.id; })
      .map(function (r) { return SHEETS.Loading.map(function (h) { return r[h] || ''; }); });
    var seen = {};
    rows.forEach(function (r) {
      var id = term.id + '|' + r.classCode + '|' + r.unitCode;
      if (seen[id]) return; seen[id] = 1;
      keep.push([id, term.id, r.classCode, r.unitCode, r.unitName || r.unitCode, r.trainerCode || '', r.trainerName || '',
        Number(r.lessonsPerWeek) || 2, Number(r.hoursPerWeek) || 3, Number(r.population) || '', now]);
    });
    writeAll_('Loading', keep);

    // Classes: add any new class codes; keep names, levels and MIS links already set.
    var csh = sheet_('Classes'), ct = loadKeyed_(csh, SHEETS.Classes.length, true);
    rows.forEach(function (r) {
      var k = lower_(r.classCode), i = ct.index[k];
      if (i === undefined) upsert_(ct, k, [r.classCode, r.classCode, levelOf_(r.classCode), '', r.population || '']);
      else if (r.population && !ct.rows[i][4]) { var c = ct.rows[i].slice(); c[4] = String(r.population); upsert_(ct, k, c); }
    });
    writeKeyed_(csh, ct, SHEETS.Classes);

    // Staff: every trainer in the loading gets an account (no PIN until the MIS Officer issues one).
    var s = staffRows_(), added = 0;
    var resp = {}; (b.trainers || []).forEach(function (t) { if (t.code) resp[lower_(t.code)] = t; });
    var codes = {};
    rows.forEach(function (r) { if (r.trainerCode) codes[lower_(r.trainerCode)] = { code: r.trainerCode, name: r.trainerName }; });
    (b.trainers || []).forEach(function (t) { if (t.code) codes[lower_(t.code)] = codes[lower_(t.code)] || { code: t.code, name: t.name }; });
    Object.keys(codes).forEach(function (k) {
      var info = codes[k], extra = resp[k] || {}, i = s.t.index[k];
      var isHod = /^HOD$/i.test(String(extra.responsibility || '').trim());
      if (i === undefined) {
        upsert_(s.t, k, newStaffRow_(String(info.code).trim().toUpperCase(), extra.name || info.name, isHod ? 'TRAINER, HOD' : 'TRAINER', extra.responsibility || ''));
        added++;
      } else {
        var row = s.t.rows[i].slice();
        row[ST.NAME] = extra.name || info.name || row[ST.NAME];
        row[ST.RESP] = extra.responsibility || row[ST.RESP];
        var roles = row[ST.ROLES] + ', TRAINER' + (isHod ? ', HOD' : '');
        row[ST.ROLES] = rolesList_(roles).join(', ');
        row[ST.UPD] = now;
        upsert_(s.t, k, row);
      }
    });
    writeKeyed_(s.sh, s.t, SHEETS.Staff);
    clearStaffCache_();
    audit_(me, 'upload loading', term.id + ': ' + Object.keys(seen).length + ' class-units, ' + Object.keys(codes).length + ' trainers');
    return { ok: true, term: term.id, rows: Object.keys(seen).length, trainers: Object.keys(codes).length, newStaff: added,
      classes: Object.keys(rows.reduce(function (m, r) { m[r.classCode] = 1; return m; }, {})).length };
  } finally { lock.releaseLock(); }
}

function loadingFor_(termId) {
  return readTable_('Loading').filter(function (r) { return r.TermID === termId && r.ClassCode && r.UnitCode; });
}

/* ---------- roster for staff phones ---------- */

function readTable_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(1, 1, sh.getLastRow(), Math.max(sh.getLastColumn(), SHEETS[name] ? SHEETS[name].length : 1)).getDisplayValues();
  var head = values[0].map(function (h) { return String(h).trim(); });
  return values.slice(1)
    .filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); })
    .map(function (r) {
      var o = {};
      head.forEach(function (h, i) { if (h) o[h] = String(r[i]).trim(); });
      return o;
    });
}

function traineeActive_(r) { return !INACTIVE.test(r.Active || '') && !/^(withdrawn|rejected)$/i.test(r.Status || ''); }

function readRoster_(me) {
  var term = activeTerm_();
  var loading = term ? loadingFor_(term.id) : [];
  var units = loading.length
    ? loading.map(function (r) {
      return { classCode: r.ClassCode, code: r.UnitCode, name: r.UnitName || r.UnitCode, trainerCode: r.TrainerCode,
        trainerName: r.TrainerName, lessonsPerWeek: Number(r.LessonsPerWeek) || 2, hoursPerWeek: Number(r.HoursPerWeek) || 3 };
    })
    : readTable_('Units').filter(function (r) { return r.ClassCode && r.UnitCode; })
      .map(function (r) { return { classCode: r.ClassCode, code: r.UnitCode, name: r.UnitName || r.UnitCode, lessonsPerWeek: 2, hoursPerWeek: 3 }; });
  var reqs = readTable_('Requests');
  var staff = {};
  readTable_('Staff').forEach(function (r) {
    if (r.StaffCode) staff[r.StaffCode] = { name: r.Name, latePct: r.LatePct === '' ? 50 : Number(r.LatePct), excusedPct: r.ExcusedPct === '' ? 100 : Number(r.ExcusedPct) };
  });
  return {
    ok: true,
    me: me,
    term: term,
    weeks: teachingWeeks_(term),
    classes: readTable_('Classes').filter(function (r) { return r.ClassCode; })
      .map(function (r) { return { code: r.ClassCode, name: r.ClassName || r.ClassCode, level: r.Level || levelOf_(r.ClassCode), misClass: r.MisClass || '' }; }),
    units: units,
    trainees: readTable_('Trainees').filter(function (r) { return r.AdmNo && r.ClassCode; })
      .map(function (r) { return { admNo: r.AdmNo, name: r.Name || r.AdmNo, classCode: r.ClassCode, active: traineeActive_(r) }; }),
    pending: reqs.filter(function (r) { return /^pending$/i.test(r.Status); })
      .map(function (r) { return { admNo: r.AdmNo, name: r.Name, classCode: r.ClassCode, requestedBy: r.RequestedName, reason: r.Reason }; }),
    rejected: reqs.filter(function (r) { return /^rejected$/i.test(r.Status); }).map(function (r) { return { admNo: r.AdmNo, classCode: r.ClassCode }; }),
    aliases: reqs.filter(function (r) { return /^merged$/i.test(r.Status) && r.MergedInto; })
      .map(function (r) { return { from: r.AdmNo, to: r.MergedInto, classCode: r.ClassCode }; }),
    staff: staff
  };
}

/* ---------- student app: setup lists and phone registration ---------- */

/** Classes for the student dropdown: grouped by MIS class list when streams are linked to one. */
function publicClasses_() {
  var groupOf = {};
  readTable_('Classes').forEach(function (r) { if (r.ClassCode) groupOf[r.ClassCode] = r.MisClass || r.ClassCode; });
  var groups = {};
  readTable_('Trainees').forEach(function (r) {
    if (r.ClassCode && traineeActive_(r)) groups[r.MisClass || groupOf[r.ClassCode] || r.ClassCode] = 1;
  });
  return { ok: true, classes: Object.keys(groups).sort().map(function (code) { return { code: code, name: code }; }) };
}

function classList_(group) {
  if (!group) fail_('Choose a class');
  var groupOf = {};
  readTable_('Classes').forEach(function (r) { if (r.ClassCode) groupOf[r.ClassCode] = r.MisClass || r.ClassCode; });
  return {
    ok: true,
    classCode: group,
    trainees: readTable_('Trainees')
      .filter(function (r) { return r.AdmNo && traineeActive_(r) && (r.MisClass || groupOf[r.ClassCode] || r.ClassCode) === group; })
      .map(function (r) { return { admNo: r.AdmNo, name: r.Name || r.AdmNo, classCode: r.ClassCode }; })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; })
  };
}

/** First login on a student phone: ties the phone to the chosen student, once. */
function registerDevice_(b) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ctx = loadCtx_();
    var t = ctx.trainees[lower_(b.admNo)];
    if (!t || !traineeActive_(t)) return { ok: false, error: 'That student is not on the class list' };
    if (!b.deviceId) return { ok: false, error: 'Missing phone ID' };
    var di = ctx.devT.index[b.deviceId], ai = ctx.byAdm[lower_(t.AdmNo)];
    if (di !== undefined && lower_(ctx.devT.rows[di][1]) !== lower_(t.AdmNo)) {
      var other = ctx.trainees[lower_(ctx.devT.rows[di][1])];
      return { ok: false, error: 'This phone is already registered to ' + (other ? other.Name : ctx.devT.rows[di][1]) + '. Ask your trainer to reset it.' };
    }
    if (ai !== undefined && ctx.devT.rows[ai][0] !== b.deviceId) {
      return { ok: false, error: t.Name + ' is already registered on another phone. Ask your trainer to reset it.' };
    }
    var cls = readTable_('Classes').filter(function (r) { return r.ClassCode === t.ClassCode; })[0];
    var reg = di !== undefined ? ctx.devT.rows[di].slice() : [b.deviceId, t.AdmNo, t.Name, t.ClassCode, ctx.now, ctx.now];
    reg[5] = ctx.now;
    upsert_(ctx.devT, b.deviceId, reg);
    saveCtx_(ctx);
    return { ok: true, admNo: t.AdmNo, name: t.Name, classCode: t.ClassCode, className: cls ? (cls.ClassName || t.ClassCode) : t.ClassCode };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- table helpers (read once, change in memory, write once) ---------- */

function loadKeyed_(sh, width, caseless) {
  var last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, width).getDisplayValues() : [];
  var index = {};
  rows.forEach(function (r, i) { if (r[0]) index[caseless ? lower_(r[0]) : r[0]] = i; });
  return { rows: rows, index: index, firstDirty: Infinity };
}

function upsert_(table, key, row) {
  var i = table.index[key];
  if (i === undefined) { i = table.rows.length; table.index[key] = i; table.rows.push(row); }
  else table.rows[i] = row;
  if (i < table.firstDirty) table.firstDirty = i;
}

function cellsFor_(headers, rows) {
  return rows.map(function (r) {
    return headers.map(function (h, c) {
      var v = r[c];
      if (NUMERIC[h]) return v === '' || v === null || v === undefined || !isFinite(Number(v)) ? '' : Number(v);
      return v === null || v === undefined ? '' : String(v);
    });
  });
}

function writeKeyed_(sh, table, headers) {
  if (table.firstDirty === Infinity) return;
  var start = table.firstDirty;
  var out = cellsFor_(headers, table.rows.slice(start));
  var needed = start + out.length + 1; // +1 for the header row
  if (sh.getMaxRows() < needed) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows());
  headers.forEach(function (h, c) {
    sh.getRange(start + 2, c + 1, out.length, 1).setNumberFormat(NUMERIC[h] ? '0.##' : '@');
  });
  sh.getRange(start + 2, 1, out.length, headers.length).setValues(out);
  table.firstDirty = Infinity;
}

/** Replaces every data row of a tab. */
function writeAll_(name, rows) {
  var sh = sheet_(name), headers = SHEETS[name];
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, Math.max(headers.length, sh.getLastColumn())).clearContent();
  if (!rows.length) return;
  var out = cellsFor_(headers, rows);
  if (sh.getMaxRows() < out.length + 1) sh.insertRowsAfter(sh.getMaxRows(), out.length + 1 - sh.getMaxRows());
  headers.forEach(function (h, c) { sh.getRange(2, c + 1, out.length, 1).setNumberFormat(NUMERIC[h] ? '0.##' : '@'); });
  sh.getRange(2, 1, out.length, headers.length).setValues(out);
}

/* ---------- class lists (MIS Officer) ---------- */

var TR = { ADM: 0, NAME: 1, CLASS: 2, ACTIVE: 3, STATUS: 4, MIS: 5, ADDEDBY: 6, ADDEDAT: 7, UPDBY: 8, UPDAT: 9, NOTE: 10 };
var RQ = { ID: 0, ADM: 1, NAME: 2, CLASS: 3, REASON: 4, BY: 5, BYNAME: 6, AT: 7, STATUS: 8, DBY: 9, DAT: 10, MERGED: 11, NOTE: 12 };

/**
 * Applies (or, with dryRun, previews) one MIS class register: new students are added, nobody is removed.
 * Students are spread over the class's streams: on the first upload in list order, later on to the smallest stream.
 */
function importClassList_(b, me) {
  var mis = String(b.misClass || '').trim();
  var streams = (b.streams || []).map(function (s) { return String(s).trim(); }).filter(Boolean);
  if (!mis) fail_('The class code is missing');
  if (!streams.length) streams = [mis];
  var students = [], seenAdm = {};
  (b.students || []).forEach(function (s) {
    var adm = String(s.admNo || '').trim(), name = String(s.name || '').replace(/\s+/g, ' ').trim();
    if (!adm || seenAdm[lower_(adm)]) return;
    seenAdm[lower_(adm)] = 1;
    students.push({ admNo: adm, name: name || adm });
  });
  if (!students.length) fail_('No students found in that list');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var now = nowIso_();
    var tsh = sheet_('Trainees'), tt = loadKeyed_(tsh, SHEETS.Trainees.length, true);
    var rsh = sheet_('Requests'), rt = loadKeyed_(rsh, SHEETS.Requests.length);
    var inStream = {}; streams.forEach(function (s) { inStream[s] = 0; });
    tt.rows.forEach(function (r) { if (inStream[r[TR.CLASS]] !== undefined && !INACTIVE.test(r[TR.ACTIVE]) && !/^(withdrawn|rejected)$/i.test(r[TR.STATUS])) inStream[r[TR.CLASS]]++; });
    var firstUpload = streams.every(function (s) { return !inStream[s]; });
    var out = { added: [], unchanged: 0, renamed: [], moved: [], confirmed: [], missing: [], byStream: {} };
    var fresh = students.filter(function (s) { return tt.index[lower_(s.admNo)] === undefined; });
    var per = Math.ceil(fresh.length / streams.length), freshIdx = 0;
    students.forEach(function (s) {
      var key = lower_(s.admNo), i = tt.index[key];
      if (i === undefined) {
        var target;
        if (firstUpload) target = streams[Math.min(streams.length - 1, Math.floor(freshIdx / per))];
        else target = streams.slice().sort(function (a, c) { return inStream[a] - inStream[c] || (a < c ? -1 : 1); })[0];
        freshIdx++;
        inStream[target]++;
        out.added.push({ admNo: s.admNo, name: s.name, classCode: target });
        upsert_(tt, key, [s.admNo, s.name, target, 'Yes', 'active', mis, me.code, now, me.code, now, '']);
        return;
      }
      var row = tt.rows[i].slice();
      var changed = false;
      if (row[TR.NAME] !== s.name) {
        out.renamed.push({ admNo: row[TR.ADM], old: row[TR.NAME], name: s.name });
        if (b.useNewNames) { row[TR.NAME] = s.name; changed = true; }
      }
      if (!streams.some(function (x) { return x === row[TR.CLASS]; })) {
        // On another class's list: the MIS register is authoritative, so the student moves here.
        var to = streams.slice().sort(function (a, c) { return inStream[a] - inStream[c]; })[0];
        out.moved.push({ admNo: row[TR.ADM], name: row[TR.NAME], from: row[TR.CLASS], to: to });
        inStream[to]++;
        row[TR.CLASS] = to; changed = true;
      }
      if (INACTIVE.test(row[TR.ACTIVE]) || /^(withdrawn|rejected)$/i.test(row[TR.STATUS])) { row[TR.ACTIVE] = 'Yes'; row[TR.STATUS] = 'active'; changed = true; }
      if (row[TR.MIS] !== mis) { row[TR.MIS] = mis; changed = true; }
      if (changed) { row[TR.UPDBY] = me.code; row[TR.UPDAT] = now; upsert_(tt, key, row); }
      else out.unchanged++;
    });
    // Students added by trainers while marking are confirmed when the official list includes them.
    rt.rows.forEach(function (r) {
      if (!/^pending$/i.test(r[RQ.STATUS]) || !seenAdm[lower_(r[RQ.ADM])]) return;
      var c = r.slice(); c[RQ.STATUS] = 'approved'; c[RQ.DBY] = me.code; c[RQ.DAT] = now; c[RQ.NOTE] = 'On the MIS list for ' + mis;
      upsert_(rt, r[RQ.ID], c);
      out.confirmed.push({ admNo: r[RQ.ADM], name: r[RQ.NAME], requestedBy: r[RQ.BYNAME] });
    });
    // Anyone on these streams who is not on this list is reported, never removed automatically.
    var withdraw = {}; (b.withdraw || []).forEach(function (a) { withdraw[lower_(a)] = 1; });
    tt.rows.forEach(function (r) {
      if (!r[TR.ADM] || seenAdm[lower_(r[TR.ADM])] || inStream[r[TR.CLASS]] === undefined) return;
      if (INACTIVE.test(r[TR.ACTIVE]) || /^(withdrawn|rejected)$/i.test(r[TR.STATUS])) return;
      out.missing.push({ admNo: r[TR.ADM], name: r[TR.NAME], classCode: r[TR.CLASS] });
      if (withdraw[lower_(r[TR.ADM])]) {
        var c = r.slice(); c[TR.STATUS] = 'withdrawn'; c[TR.UPDBY] = me.code; c[TR.UPDAT] = now; c[TR.NOTE] = 'Not on the ' + mis + ' list ' + todayIso_();
        upsert_(tt, lower_(r[TR.ADM]), c);
        inStream[r[TR.CLASS]]--;
      }
    });
    streams.forEach(function (s) { out.byStream[s] = inStream[s]; });
    if (!b.dryRun) {
      writeKeyed_(tsh, tt, SHEETS.Trainees);
      writeKeyed_(rsh, rt, SHEETS.Requests);
      // Link the streams to this MIS class so the student app groups them and reports show the MIS code.
      var csh = sheet_('Classes'), ct = loadKeyed_(csh, SHEETS.Classes.length, true);
      streams.forEach(function (s) {
        var k = lower_(s), i = ct.index[k];
        var row = i === undefined ? [s, s, levelOf_(s) || levelOf_(mis), mis, ''] : ct.rows[i].slice();
        row[3] = mis;
        if (!row[2]) row[2] = levelOf_(s) || levelOf_(mis);
        upsert_(ct, k, row);
      });
      writeKeyed_(csh, ct, SHEETS.Classes);
      audit_(me, 'class list', mis + ' → ' + streams.join(', ') + ': ' + out.added.length + ' added, ' + out.moved.length + ' moved, ' +
        (b.withdraw || []).length + ' withdrawn, ' + out.confirmed.length + ' trainer additions confirmed');
    }
    out.ok = true; out.dryRun = !!b.dryRun; out.misClass = mis; out.streams = streams; out.total = students.length;
    return out;
  } finally { lock.releaseLock(); }
}

function studentsOf_(misClass, classCode) {
  var groupOf = {};
  readTable_('Classes').forEach(function (r) { if (r.ClassCode) groupOf[r.ClassCode] = r.MisClass || ''; });
  return {
    ok: true,
    students: readTable_('Trainees').filter(function (r) {
      return r.AdmNo && ((classCode && r.ClassCode === classCode) || (misClass && (r.MisClass === misClass || groupOf[r.ClassCode] === misClass)));
    }).map(function (r) {
      return { admNo: r.AdmNo, name: r.Name, classCode: r.ClassCode, status: traineeActive_(r) ? 'active' : (r.Status || 'withdrawn'), note: r.Note };
    })
  };
}

/** MIS: move a student to another stream, withdraw them, or bring them back. */
function updateStudent_(b, me) {
  var tsh = sheet_('Trainees'), tt = loadKeyed_(tsh, SHEETS.Trainees.length, true);
  var key = lower_(b.admNo), i = tt.index[key];
  if (i === undefined) fail_('No student with admission number ' + b.admNo);
  var row = tt.rows[i].slice(), what = [];
  if (b.classCode && b.classCode !== row[TR.CLASS]) { what.push('moved ' + row[TR.CLASS] + ' → ' + b.classCode); row[TR.CLASS] = b.classCode; }
  if (b.status === 'withdrawn' || b.status === 'active') { what.push(b.status); row[TR.STATUS] = b.status; row[TR.ACTIVE] = b.status === 'active' ? 'Yes' : 'No'; }
  if (b.name) { what.push('renamed'); row[TR.NAME] = String(b.name).trim(); }
  if (b.note !== undefined) row[TR.NOTE] = String(b.note);
  row[TR.UPDBY] = me.code; row[TR.UPDAT] = nowIso_();
  upsert_(tt, key, row);
  writeKeyed_(tsh, tt, SHEETS.Trainees);
  audit_(me, 'student', row[TR.ADM] + ' ' + what.join(', '));
  return { ok: true, student: { admNo: row[TR.ADM], name: row[TR.NAME], classCode: row[TR.CLASS], status: row[TR.STATUS] || 'active' } };
}

/* ---------- students added by trainers (pending until the MIS Officer decides) ---------- */

function addStudents_(list, me) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var trainees = {};
    readTable_('Trainees').forEach(function (r) { if (r.AdmNo) trainees[lower_(r.AdmNo)] = r; });
    var rsh = sheet_('Requests'), rt = loadKeyed_(rsh, SHEETS.Requests.length);
    var now = nowIso_(), results = [];
    list.slice(0, 100).forEach(function (s) {
      var adm = String(s.admNo || '').trim(), cls = String(s.classCode || '').trim();
      if (!adm || !cls) return;
      var t = trainees[lower_(adm)];
      if (t && t.ClassCode === cls && traineeActive_(t)) { results.push({ admNo: adm, classCode: cls, status: 'on-list' }); return; }
      var id = cls + '|' + adm, i = rt.index[id];
      if (i !== undefined && !/^rejected$/i.test(rt.rows[i][RQ.STATUS])) { results.push({ admNo: adm, classCode: cls, status: rt.rows[i][RQ.STATUS] }); return; }
      var note = t ? 'On the list of ' + t.ClassCode + (traineeActive_(t) ? '' : ' (withdrawn)') : '';
      upsert_(rt, id, [id, adm, String(s.name || adm).trim(), cls, String(s.reason || '').slice(0, 300), me.code, me.name, s.addedAt || now, 'pending', '', '', '', note]);
      results.push({ admNo: adm, classCode: cls, status: 'pending' });
    });
    writeKeyed_(rsh, rt, SHEETS.Requests);
    return { ok: true, results: results };
  } finally { lock.releaseLock(); }
}

function listRequests_() {
  var trainees = {};
  readTable_('Trainees').forEach(function (r) { if (r.AdmNo) trainees[lower_(r.AdmNo)] = r; });
  return {
    ok: true,
    requests: readTable_('Requests').map(function (r) {
      var t = trainees[lower_(r.AdmNo)];
      return { id: r.RequestID, admNo: r.AdmNo, name: r.Name, classCode: r.ClassCode, reason: r.Reason, requestedBy: r.RequestedName,
        requestedAt: r.RequestedAt, status: r.Status, decidedAt: r.DecidedAt, mergedInto: r.MergedInto, note: r.Note,
        existing: t ? { classCode: t.ClassCode, name: t.Name, active: traineeActive_(t) } : null };
    }).reverse()
  };
}

/** approve: add (or move) the student to the class; reject: drop from reports; merge: it was a typo for an existing student. */
function decideRequest_(b, me) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var rsh = sheet_('Requests'), rt = loadKeyed_(rsh, SHEETS.Requests.length);
    var i = rt.index[b.id];
    if (i === undefined) fail_('That request no longer exists');
    var r = rt.rows[i].slice(), now = nowIso_();
    var tsh = sheet_('Trainees'), tt = loadKeyed_(tsh, SHEETS.Trainees.length, true);
    var cls = readTable_('Classes').filter(function (c) { return c.ClassCode === r[RQ.CLASS]; })[0];
    if (b.decision === 'approve') {
      var key = lower_(r[RQ.ADM]), ti = tt.index[key];
      var row = ti === undefined ? [r[RQ.ADM], b.name || r[RQ.NAME], r[RQ.CLASS], 'Yes', 'active', cls ? cls.MisClass : '', r[RQ.BY], r[RQ.AT], me.code, now, 'Added by ' + r[RQ.BYNAME]]
        : tt.rows[ti].slice();
      row[TR.CLASS] = r[RQ.CLASS]; row[TR.ACTIVE] = 'Yes'; row[TR.STATUS] = 'active'; row[TR.UPDBY] = me.code; row[TR.UPDAT] = now;
      if (b.name) row[TR.NAME] = b.name;
      upsert_(tt, key, row);
      writeKeyed_(tsh, tt, SHEETS.Trainees);
      r[RQ.STATUS] = 'approved';
    } else if (b.decision === 'reject') {
      r[RQ.STATUS] = 'rejected';
    } else if (b.decision === 'merge') {
      var target = tt.index[lower_(b.mergeInto)];
      if (target === undefined) fail_('No student with admission number ' + b.mergeInto);
      r[RQ.STATUS] = 'merged';
      r[RQ.MERGED] = tt.rows[target][TR.ADM];
    } else fail_('Choose approve, reject or merge');
    r[RQ.DBY] = me.code; r[RQ.DAT] = now;
    if (b.note) r[RQ.NOTE] = String(b.note);
    upsert_(rt, b.id, r);
    writeKeyed_(rsh, rt, SHEETS.Requests);
    audit_(me, 'student request', r[RQ.ADM] + ' in ' + r[RQ.CLASS] + ': ' + r[RQ.STATUS] + (r[RQ.MERGED] ? ' into ' + r[RQ.MERGED] : ''));
    return { ok: true, status: r[RQ.STATUS] };
  } finally { lock.releaseLock(); }
}

/* ---------- staff (MIS Officer) ---------- */

function listStaff_() {
  return { ok: true, staff: staffRows_().t.rows.filter(function (r) { return r[0]; }).map(staffPublic_) };
}

function updateStaff_(b, me) {
  var s = staffRows_();
  var code = String(b.code || '').trim().toUpperCase();
  if (!code) fail_('Enter a staff code');
  var key = lower_(code), i = s.t.index[key];
  var row = i === undefined ? newStaffRow_(code, b.name, 'TRAINER', '') : s.t.rows[i].slice();
  if (i === undefined && !b.name) fail_('Enter the staff member\'s name');
  if (b.name) row[ST.NAME] = String(b.name).trim();
  if (b.roles) {
    var roles = rolesList_(b.roles.join ? b.roles.join(',') : b.roles);
    if (lower_(code) === lower_(me.code) && roles.indexOf('MIS') === -1) fail_('You cannot remove your own MIS role');
    row[ST.ROLES] = roles.join(', ');
  }
  if (b.active !== undefined) {
    if (lower_(code) === lower_(me.code) && !b.active) fail_('You cannot switch off your own account');
    row[ST.ACTIVE] = b.active ? 'Yes' : 'No';
    row[ST.VER] = String((Number(row[ST.VER]) || 0) + 1); // signs them out everywhere
  }
  row[ST.UPD] = nowIso_();
  upsert_(s.t, key, row);
  writeKeyed_(s.sh, s.t, SHEETS.Staff);
  clearStaffCache_();
  var pin = null;
  if (b.resetPin) { pin = randomPin_(); row = setStaffPin_(code, pin, true); }
  audit_(me, 'staff', code + (b.roles ? ' roles ' + row[ST.ROLES] : '') + (b.active !== undefined ? (b.active ? ' switched on' : ' switched off') : '') + (pin ? ' PIN reset' : ''));
  return { ok: true, staff: staffPublic_(row), pin: pin };
}

/* ---------- trainer registers ---------- */

function pushSessions_(sessions, me) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var dataSh = sheet_('SessionData');
    var dataT = loadKeyed_(dataSh, SHEETS.SessionData.length);
    var results = [], touched = [];
    sessions.forEach(function (s) {
      if (!s || !s.sessionId) return;
      var i = dataT.index[s.sessionId];
      // Never let an older copy (e.g. from a phone that was offline longer) overwrite a newer one.
      if (i !== undefined && String(dataT.rows[i][1]) > String(s.updatedAt || '')) {
        results.push({ sessionId: s.sessionId, status: 'stale' });
        return;
      }
      s.uploadedBy = me.code;
      upsert_(dataT, s.sessionId, [s.sessionId, s.updatedAt || '', JSON.stringify(s)]);
      touched.push(s.sessionId);
      results.push({ sessionId: s.sessionId, status: i === undefined ? 'added' : 'updated' });
    });
    writeKeyed_(dataSh, dataT, SHEETS.SessionData);

    var ctx = loadCtx_();
    reevaluatePending_(touched, ctx, dataT);   // student check-ins that arrived before this register
    saveCtx_(ctx);
    rebuildSessions_(touched, dataT);
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

/** Final mark per trainee: a mark the trainer tapped > an accepted QR check-in > the default. */
function finalMarks_(s, accepted) {
  var out = {};
  (s.marks || []).forEach(function (m) {
    out[m.admNo] = { admNo: m.admNo, name: m.name, status: m.status, source: m.explicit ? 'trainer' : 'default' };
  });
  Object.keys(accepted || {}).forEach(function (adm) {
    var cur = out[adm];
    if (cur && cur.source === 'trainer') return;
    out[adm] = { admNo: adm, name: (cur && cur.name) || accepted[adm].name, status: 'Present', source: 'qr' };
  });
  return Object.keys(out).map(function (k) { return out[k]; });
}

function rebuildSessions_(ids, dataT) {
  if (!ids.length) return;
  var sessSh = sheet_('Sessions'), attSh = sheet_('Attendance');
  var sTable = loadKeyed_(sessSh, SHEETS.Sessions.length);
  var aTable = loadKeyed_(attSh, SHEETS.Attendance.length);
  var accepted = acceptedMap_(ids);
  var term = activeTerm_();
  var now = nowIso_();
  ids.forEach(function (id) {
    var i = dataT.index[id];
    if (i === undefined) return;
    var s = JSON.parse(dataT.rows[i][2]);
    var marks = finalMarks_(s, accepted[id]);
    var c = { P: 0, A: 0, L: 0, E: 0 };
    marks.forEach(function (m) { var k = STATUS_CODE[m.status]; if (k) c[k]++; });
    var counted = c.P + c.L + c.A;
    upsert_(sTable, id, [
      id, s.date, s.classCode, s.className, s.unitCode, s.unitName, s.period,
      s.trainerId, s.trainerName, c.P, c.A, c.L, c.E, c.P + c.A + c.L + c.E,
      counted ? Math.round((c.P + c.L) / counted * 1000) / 10 : '',
      s.notes, Number(s.edits) || 0, s.deviceId, s.createdAt, s.updatedAt, now,
      s.termId || (term ? term.id : ''), s.week || (term ? weekOf_(term, s.date) : '')
    ]);
    marks.forEach(function (m) {
      var rid = id + '|' + m.admNo;
      upsert_(aTable, rid, [rid, id, s.date, s.classCode, s.unitCode, s.unitName, s.period,
        m.admNo, m.name, m.status, s.trainerId, s.trainerName, s.updatedAt, now, m.source]);
    });
  });
  writeKeyed_(sessSh, sTable, SHEETS.Sessions);
  writeKeyed_(attSh, aTable, SHEETS.Attendance);
}

/* ---------- reports, sign-off and overview ---------- */

function teachesUnit_(me, classCode, unitCode, term) {
  if (me.roles.indexOf('HOD') !== -1 || me.roles.indexOf('MIS') !== -1) return true;
  var loading = term ? loadingFor_(term.id) : [];
  if (!loading.length) return true; // no loading yet: trainers can see the lessons they marked
  return loading.some(function (r) { return r.ClassCode === classCode && r.UnitCode === unitCode && lower_(r.TrainerCode) === lower_(me.code); });
}

/** Every lesson of one class and unit this term, with final marks, for the term register. */
function reportData_(b, me) {
  var term = activeTerm_();
  if (!b.classCode || !b.unitCode) fail_('Choose a class and a unit');
  if (!teachesUnit_(me, b.classCode, b.unitCode, term)) fail_('You can only see reports for the units in your loading');
  var weeks = teachingWeeks_(term);
  var from = weeks.length ? weeks[0] : '', toD = '';
  if (weeks.length) { var e = new Date(weeks[weeks.length - 1] + 'T00:00:00Z'); e.setUTCDate(e.getUTCDate() + 6); toD = e.toISOString().slice(0, 10); }
  var dataT = loadKeyed_(sheet_('SessionData'), SHEETS.SessionData.length);
  var list = [], ids = [];
  dataT.rows.forEach(function (r) {
    if (!r[0] || classFromSession_(r[0]) !== b.classCode || unitFromSession_(r[0]) !== b.unitCode) return;
    var s = JSON.parse(r[2]);
    if (from && (s.date < from || s.date > toD)) return;
    list.push(s); ids.push(s.sessionId);
  });
  var accepted = acceptedMap_(ids);
  var lessons = list.map(function (s) {
    var marks = {}, names = {};
    finalMarks_(s, accepted[s.sessionId]).forEach(function (m) { var k = STATUS_CODE[m.status]; if (k) { marks[m.admNo] = k; names[m.admNo] = m.name; } });
    return { id: s.sessionId, date: s.date, period: s.period, trainerId: s.trainerId, trainerName: s.trainerName, updatedAt: s.updatedAt, marks: marks, names: names };
  });
  var load = term ? loadingFor_(term.id).filter(function (r) { return r.ClassCode === b.classCode && r.UnitCode === b.unitCode; })[0] : null;
  var so = readTable_('SignOffs').filter(function (r) { return r.SignOffID === signoffId_(term, b.classCode, b.unitCode); })[0];
  return { ok: true, term: term, weeks: weeks, lessons: lessons, loading: load ? { trainerCode: load.TrainerCode, trainerName: load.TrainerName,
    unitName: load.UnitName, lessonsPerWeek: Number(load.LessonsPerWeek) || 2, hoursPerWeek: Number(load.HoursPerWeek) || 3 } : null,
    signoff: so ? signoffOut_(so) : null, serverTime: nowIso_() };
}

function signoffId_(term, classCode, unitCode) { return (term ? term.id : 'no-term') + '|' + classCode + '|' + unitCode; }
function signoffOut_(r) {
  return { id: r.SignOffID, classCode: r.ClassCode, unitCode: r.UnitCode, unitName: r.UnitName, trainerCode: r.TrainerCode, trainerName: r.TrainerName,
    lecturerComment: r.LecturerComment, submittedAt: r.SubmittedAt, status: r.Status, hodName: r.HodName, hodComment: r.HodComment, decidedAt: r.DecidedAt };
}

function submitSignoff_(b, me) {
  var term = activeTerm_();
  if (!teachesUnit_(me, b.classCode, b.unitCode, term)) fail_('You can only submit registers for the units in your loading');
  var sh = sheet_('SignOffs'), t = loadKeyed_(sh, SHEETS.SignOffs.length);
  var id = signoffId_(term, b.classCode, b.unitCode), i = t.index[id];
  var row = i === undefined ? [id, term ? term.id : '', b.classCode, b.unitCode, b.unitName || '', me.code, me.name, '', '', '', '', '', '', ''] : t.rows[i].slice();
  if (/^approved$/i.test(row[9]) && !b.resubmit) fail_('The HOD has already approved this register');
  row[5] = me.code; row[6] = me.name; row[7] = String(b.comment || '').slice(0, 1000); row[8] = nowIso_(); row[9] = 'submitted';
  row[10] = ''; row[11] = ''; row[13] = '';
  upsert_(t, id, row);
  writeKeyed_(sh, t, SHEETS.SignOffs);
  return { ok: true, signoff: signoffOut_(objOf_(SHEETS.SignOffs, row)) };
}

function decideSignoff_(b, me) {
  var sh = sheet_('SignOffs'), t = loadKeyed_(sh, SHEETS.SignOffs.length);
  var i = t.index[b.id];
  if (i === undefined) fail_('That register has not been submitted');
  var row = t.rows[i].slice();
  if (b.decision !== 'approved' && b.decision !== 'returned') fail_('Choose approve or return');
  if (b.decision === 'returned' && !String(b.comment || '').trim()) fail_('Say what needs fixing when returning a register');
  row[9] = b.decision; row[10] = me.code; row[11] = me.name; row[12] = String(b.comment || '').slice(0, 1000); row[13] = nowIso_();
  upsert_(t, b.id, row);
  writeKeyed_(sh, t, SHEETS.SignOffs);
  audit_(me, 'sign-off', b.id + ' ' + b.decision);
  return { ok: true, signoff: signoffOut_(objOf_(SHEETS.SignOffs, row)) };
}

function listSignoffs_(me) {
  var term = activeTerm_();
  var all = readTable_('SignOffs').filter(function (r) { return !term || r.TermID === term.id; });
  var mine = me.roles.indexOf('HOD') === -1 && me.roles.indexOf('MIS') === -1;
  return { ok: true, signoffs: all.filter(function (r) { return !mine || lower_(r.TrainerCode) === lower_(me.code); }).map(signoffOut_) };
}

function objOf_(headers, row) { var o = {}; headers.forEach(function (h, i) { o[h] = row[i]; }); return o; }

/** HOD view: for each class and unit in the loading, how many lessons are marked against how many were due. */
function overview_() {
  var term = activeTerm_();
  if (!term) return { ok: true, term: null, rows: [] };
  var weeks = teachingWeeks_(term), today = todayIso_();
  var elapsed = weeks.filter(function (w) { return w <= today; }).length;
  var stats = {};
  readTable_('Sessions').forEach(function (r) {
    if (r.TermID && r.TermID !== term.id) return;
    if (!r.TermID && weeks.length && (r.Date < weeks[0])) return;
    var k = r.ClassCode + '|' + r.UnitCode;
    var s = stats[k] = stats[k] || { lessons: 0, last: '', attended: 0, counted: 0 };
    s.lessons++;
    if (r.Date > s.last) s.last = r.Date;
    s.attended += (Number(r.Present) || 0) + (Number(r.Late) || 0);
    s.counted += (Number(r.Present) || 0) + (Number(r.Late) || 0) + (Number(r.Absent) || 0);
  });
  var so = {};
  readTable_('SignOffs').forEach(function (r) { if (r.TermID === term.id) so[r.ClassCode + '|' + r.UnitCode] = r.Status; });
  var rows = loadingFor_(term.id).map(function (r) {
    var k = r.ClassCode + '|' + r.UnitCode, s = stats[k] || { lessons: 0, last: '', attended: 0, counted: 0 };
    var due = elapsed * (Number(r.LessonsPerWeek) || 2);
    return { classCode: r.ClassCode, unitCode: r.UnitCode, unitName: r.UnitName, trainerCode: r.TrainerCode, trainerName: r.TrainerName,
      lessons: s.lessons, due: due, last: s.last, pct: s.counted ? Math.round(s.attended / s.counted * 100) : null, signoff: so[k] || '' };
  });
  return { ok: true, term: term, week: elapsed, rows: rows };
}

/* ---------- QR check-ins from student phones ---------- */

var CI = { ID: 0, SESSION: 1, ADM: 2, NAME: 3, CLASS: 4, DEVICE: 5, WINDOW: 6, CODE: 7, SCANNED: 8,
  UPDATED: 9, STATUS: 10, REASON: 11 };

/** true = code genuine, false = fake or expired, null = cannot tell yet (trainer has not synced that lesson). */
function verifyCode_(c, dataT) {
  var i = dataT.index[c.sessionId];
  if (i === undefined) return null;
  var s = JSON.parse(dataT.rows[i][2]);
  if (!s.qr || !s.qr.secret) return null;
  var w = Number(c.w);
  if (!isFinite(w)) return false;
  var intervals = s.qr.intervals || [];
  var inRange = intervals.some(function (iv) { return w >= iv[0] - 1 && w <= iv[1] + 1; });
  var genuine = hmacHex_(c.sessionId + '|' + w, s.qr.secret).slice(0, CODE_LENGTH) === String(c.token || '').toLowerCase();
  if (!inRange) {
    var lastEnd = intervals.reduce(function (m, iv) { return Math.max(m, iv[1]); }, -Infinity);
    if (w <= lastEnd + 1) return false;
    // Shown after the trainer's phone last uploaded. Only that phone can make a genuine code, so a genuine
    // code for (about) right now is accepted at once; anything else waits for the trainer's next upload.
    var nowW = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    if (genuine && Math.abs(w - nowW) <= 3) return true;
    return null;
  }
  return genuine;
}

function loadCtx_() {
  var ctx = { now: nowIso_(), trainees: {}, byAdm: {} };
  readTable_('Trainees').forEach(function (r) { if (r.AdmNo) ctx.trainees[lower_(r.AdmNo)] = r; });
  ctx.devSh = sheet_('Devices'); ctx.devT = loadKeyed_(ctx.devSh, SHEETS.Devices.length);
  ctx.devT.rows.forEach(function (r, i) { if (r[1]) ctx.byAdm[lower_(r[1])] = i; });
  ctx.ciSh = sheet_('CheckIns'); ctx.ciT = loadKeyed_(ctx.ciSh, SHEETS.CheckIns.length);
  return ctx;
}
function saveCtx_(ctx) {
  writeKeyed_(ctx.devSh, ctx.devT, SHEETS.Devices);
  writeKeyed_(ctx.ciSh, ctx.ciT, SHEETS.CheckIns);
}

/**
 * Checks one check-in sent by a student's phone. One row per lesson + student + phone,
 * so a refused attempt from another phone never overwrites the student's genuine check-in.
 * UpdatedAt changes whenever the result changes, so trainers' phones can fetch just what is new.
 */
function evaluateClaim_(c, ctx, dataT) {
  var t = ctx.trainees[lower_(c.admNo)];
  var adm = t ? t.AdmNo : String(c.admNo);
  var id = c.sessionId + '|' + adm + '|' + c.deviceId;
  var i = ctx.ciT.index[id];
  var row = i !== undefined ? ctx.ciT.rows[i].slice()
    : [id, c.sessionId, adm, t ? t.Name : '', classFromSession_(c.sessionId), c.deviceId, String(c.w), String(c.token || ''), c.scannedAt || '', '', '', ''];
  while (row.length < SHEETS.CheckIns.length) row.push('');
  if (row[CI.STATUS] !== 'accepted') {
    var status, reason = '';
    if (!t || !traineeActive_(t)) { status = 'rejected'; reason = 'unknown-student'; }
    else if (classFromSession_(c.sessionId) !== t.ClassCode) { status = 'rejected'; reason = 'wrong-class'; }
    else {
      var di = ctx.devT.index[c.deviceId], ai = ctx.byAdm[lower_(adm)];
      if (di !== undefined && lower_(ctx.devT.rows[di][1]) !== lower_(adm)) { status = 'rejected'; reason = 'device-other-student'; }
      else if (ai !== undefined && ctx.devT.rows[ai][0] !== c.deviceId) { status = 'rejected'; reason = 'student-other-device'; }
      else {
        // Normally registered at first login; a first submission from an unregistered phone registers it too.
        var reg = di !== undefined ? ctx.devT.rows[di].slice() : [c.deviceId, adm, t.Name, t.ClassCode, ctx.now, ctx.now];
        reg[5] = ctx.now;
        upsert_(ctx.devT, c.deviceId, reg);
        ctx.byAdm[lower_(adm)] = ctx.devT.index[c.deviceId];
        var v = verifyCode_({ sessionId: c.sessionId, w: row[CI.WINDOW], token: row[CI.CODE] }, dataT);
        status = v === null ? 'pending' : (v ? 'accepted' : 'rejected');
        if (v === false) reason = 'invalid-code';
      }
    }
    if (i === undefined || row[CI.STATUS] !== status || row[CI.REASON] !== reason) {
      row[CI.STATUS] = status;
      row[CI.REASON] = reason;
      row[CI.UPDATED] = ctx.now;
      upsert_(ctx.ciT, id, row);
    }
  }
  return { id: id, status: row[CI.STATUS], reason: row[CI.REASON], name: t ? t.Name : '', classCode: t ? t.ClassCode : '' };
}

function receiveCheckins_(list) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ctx = loadCtx_();
    var dataT = loadKeyed_(sheet_('SessionData'), SHEETS.SessionData.length);
    var results = [], touched = {};
    list.slice(0, 200).forEach(function (c) {
      if (!c || !c.sessionId || !c.admNo || !c.deviceId) return;
      var r = evaluateClaim_(c, ctx, dataT);
      if (r.status === 'accepted') touched[c.sessionId] = 1;
      results.push(r);
    });
    saveCtx_(ctx);
    if (Object.keys(touched).length) markChanged_();
    rebuildSessions_(Object.keys(touched), dataT);
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

function reevaluatePending_(ids, ctx, dataT) {
  if (!ids.length) return;
  var changed = false;
  var want = {}; ids.forEach(function (id) { want[id] = 1; });
  ctx.ciT.rows.forEach(function (r) {
    if (r[CI.STATUS] !== 'pending' || !want[r[CI.SESSION]]) return;
    var v = verifyCode_({ sessionId: r[CI.SESSION], w: r[CI.WINDOW], token: r[CI.CODE] }, dataT);
    if (v === null) return;
    var row = r.slice();
    while (row.length < SHEETS.CheckIns.length) row.push('');
    row[CI.STATUS] = v ? 'accepted' : 'rejected';
    row[CI.REASON] = v ? '' : 'invalid-code';
    row[CI.UPDATED] = ctx.now;
    upsert_(ctx.ciT, r[CI.ID], row);
    if (v) changed = true;
  });
  if (changed) markChanged_();
}

function acceptedMap_(ids) {
  var want = {}; ids.forEach(function (id) { want[id] = 1; });
  var map = {};
  readTable_('CheckIns').forEach(function (r) {
    if (r.Status !== 'accepted' || !want[r.SessionID]) return;
    (map[r.SessionID] = map[r.SessionID] || {})[r.AdmNo] = { name: r.Name, scannedAt: r.ScannedAt };
  });
  return map;
}

/** For the trainer's phone: check-ins accepted since its last check (all of them when since is empty). */
function acceptedCheckins_(ids, since) {
  var serverTime = nowIso_();
  var want = {}; ids.forEach(function (id) { want[id] = 1; });
  var out = {}, count = 0;
  readTable_('CheckIns').forEach(function (r) {
    if (r.Status !== 'accepted' || !want[r.SessionID]) return;
    if (since && !(String(r.UpdatedAt) > String(since))) return;
    (out[r.SessionID] = out[r.SessionID] || []).push({ admNo: r.AdmNo, name: r.Name, scannedAt: r.ScannedAt });
    count++;
  });
  return { ok: true, serverTime: serverTime, count: count, checkins: out };
}
