/**
 * Attendance Register — Google Sheets backend.
 *
 * Paste this into Extensions > Apps Script of the Google Sheet that holds the
 * attendance data, run setup() once, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone). Give trainers the /exec URL and the
 * access token shown by setup(). After pasting a newer version of this file,
 * use Deploy > Manage deployments > Edit > New version so the URL stays the same.
 *
 * Tabs:
 *   Classes     ClassCode | ClassName                         (you maintain)
 *   Units       ClassCode | UnitCode | UnitName               (you maintain)
 *   Trainees    AdmNo | Name | ClassCode | Active             (you maintain)
 *   Sessions    one row per lesson register                   (written by the app)
 *   Attendance  one row per trainee per lesson                (written by the app)
 *   CheckIns    every QR check-in a student phone sent, with its result
 *   Devices     which phone belongs to which student — set when the student first logs in
 *               (delete a row to let a student change phone or fix a wrong choice)
 *   SessionData raw register data used to merge trainer marks and QR check-ins (hidden)
 */

var SHEETS = {
  Classes: ['ClassCode', 'ClassName'],
  Units: ['ClassCode', 'UnitCode', 'UnitName'],
  Trainees: ['AdmNo', 'Name', 'ClassCode', 'Active'],
  Sessions: ['SessionID', 'Date', 'ClassCode', 'ClassName', 'UnitCode', 'UnitName', 'Period',
    'TrainerID', 'TrainerName', 'Present', 'Absent', 'Late', 'Excused', 'Total', 'AttendancePct',
    'Notes', 'Edits', 'DeviceID', 'CreatedAt', 'UpdatedAt', 'SyncedAt'],
  Attendance: ['RecordID', 'SessionID', 'Date', 'ClassCode', 'UnitCode', 'UnitName', 'Period',
    'AdmNo', 'Name', 'Status', 'TrainerID', 'TrainerName', 'UpdatedAt', 'SyncedAt', 'Source'],
  CheckIns: ['CheckInID', 'SessionID', 'AdmNo', 'Name', 'ClassCode', 'DeviceID', 'Window', 'Code',
    'ScannedAt', 'UpdatedAt', 'Status', 'Reason'],
  Devices: ['DeviceID', 'AdmNo', 'Name', 'ClassCode', 'RegisteredAt', 'LastSeen'],
  SessionData: ['SessionID', 'UpdatedAt', 'Json']
};
var NUMERIC = { Present: 1, Absent: 1, Late: 1, Excused: 1, Total: 1, AttendancePct: 1, Edits: 1 };
var WINDOW_SECONDS = 20;   // how often the lesson QR changes — must match QR_WINDOW in app.js
var CODE_LENGTH = 10;
var STATUS_CODE = { Present: 'P', Absent: 'A', Late: 'L', Excused: 'E' };
var INACTIVE = /^(no|n|false|0|inactive|left|discontinued)$/i;

/* ---------- menu & setup ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Attendance')
    .addItem('Set up sheets', 'setup')
    .addItem('Show access token', 'showToken')
    .addItem('Generate a new access token', 'resetToken')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) { sheet_(name); });
  addSampleRows_(ss);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', newToken_());
  showToken();
}

/** Returns the tab, creating it (or adding missing header columns) when needed. */
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
    if (sh.getLastColumn() > headers.length) { // columns left over from an older version
      sh.getRange(1, headers.length + 1, 1, sh.getLastColumn() - headers.length).clearContent();
    }
  }
  return sh;
}

function addSampleRows_(ss) {
  var classes = ss.getSheetByName('Classes');
  if (classes.getLastRow() > 1) return; // only on a brand-new sheet
  classes.getRange(2, 1, 2, 2).setValues([
    ['ICT6A', 'Diploma in ICT L6 - Sept 2025 A'],
    ['ICT5B', 'Certificate in ICT L5 - Jan 2026 B']
  ]);
  ss.getSheetByName('Units').getRange(2, 1, 4, 3).setValues([
    ['ICT6A', 'PROG-601', 'Object Oriented Programming (Java)'],
    ['ICT6A', 'NET-602', 'Computer Networking'],
    ['ICT5B', 'APP-501', 'Computer Applications'],
    ['ICT5B', 'PROG-502', 'Fundamentals of Programming']
  ]);
  ss.getSheetByName('Trainees').getRange(2, 1, 4, 4).setValues([
    ['RVNP/ICT/0101', 'Achieng Mary Otieno', 'ICT6A', 'Yes'],
    ['RVNP/ICT/0102', 'Brian Kiprono Rotich', 'ICT6A', 'Yes'],
    ['RVNP/ICT/0201', 'Ian Kipchumba Kirui', 'ICT5B', 'Yes'],
    ['RVNP/ICT/0202', 'Joy Akinyi Ochieng', 'ICT5B', 'Yes']
  ]);
}

function newToken_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 24); }
function apiToken_() { return PropertiesService.getScriptProperties().getProperty('API_TOKEN'); }

function showToken() {
  var msg = 'Access token for the attendance app:\n\n' + apiToken_() +
    '\n\nPaste it in the app under Setup > Google Sheets. Keep it private.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from the editor: see the log */ }
}

function resetToken() {
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', newToken_());
  showToken();
}

/* ---------- helpers ---------- */

function hex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function hmacHex_(message, secret) { return hex_(Utilities.computeHmacSha256Signature(message, secret)); }
function classFromSession_(sessionId) { return String(sessionId).split(':')[2] || ''; }
function nowIso_() { return new Date().toISOString(); }

/* ---------- web app ---------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    // Student app (no token): the class and name dropdowns for first-time setup.
    if (p.action === 'classes') return json_(publicClasses_());
    if (p.action === 'classlist') return json_(classList_(p['class']));
    checkToken_(p.token);
    if (p.action === 'ping') {
      return json_({ ok: true, spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName(), time: nowIso_() });
    }
    if (p.action === 'roster') return json_(readRoster_());
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    // Students send check-ins without the trainer token; each one is verified against the
    // lesson code the trainer's phone showed, so a check-in cannot be faked.
    if (body.action === 'checkin') return json_(receiveCheckins_(body.checkins || []));
    if (body.action === 'register') return json_(registerDevice_(body));
    checkToken_(body.token);
    if (body.action === 'push') return json_(pushSessions_(body.sessions || []));
    if (body.action === 'checkins') return json_(acceptedCheckins_(body.sessionIds || [], body.since || ''));
    if (body.action === 'ping') return json_({ ok: true });
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkToken_(token) {
  var expected = apiToken_();
  if (!expected) throw new Error('The sheet is not set up yet. Run setup() in Apps Script.');
  if (!token || token !== expected) throw new Error('Invalid access token');
}

/* ---------- roster ---------- */

function readTable_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
  var head = values[0].map(function (h) { return String(h).trim(); });
  return values.slice(1)
    .filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); })
    .map(function (r) {
      var o = {};
      head.forEach(function (h, i) { o[h] = String(r[i]).trim(); });
      return o;
    });
}

function readRoster_() {
  return {
    ok: true,
    classes: readTable_('Classes').filter(function (r) { return r.ClassCode; })
      .map(function (r) { return { code: r.ClassCode, name: r.ClassName || r.ClassCode }; }),
    units: readTable_('Units').filter(function (r) { return r.ClassCode && r.UnitCode; })
      .map(function (r) { return { classCode: r.ClassCode, code: r.UnitCode, name: r.UnitName || r.UnitCode }; }),
    trainees: readTable_('Trainees').filter(function (r) { return r.AdmNo && r.ClassCode; })
      .map(function (r) { return { admNo: r.AdmNo, name: r.Name || r.AdmNo, classCode: r.ClassCode, active: !INACTIVE.test(r.Active || '') }; })
  };
}

/* ---------- student app: setup lists and phone registration ---------- */

function publicClasses_() {
  var withTrainees = {};
  readTable_('Trainees').forEach(function (r) { if (r.ClassCode && !INACTIVE.test(r.Active || '')) withTrainees[r.ClassCode] = 1; });
  var named = {};
  readTable_('Classes').forEach(function (r) { if (r.ClassCode) named[r.ClassCode] = r.ClassName || r.ClassCode; });
  return {
    ok: true,
    classes: Object.keys(withTrainees).sort().map(function (code) { return { code: code, name: named[code] || code }; })
  };
}

function classList_(classCode) {
  if (!classCode) throw new Error('Choose a class');
  return {
    ok: true,
    classCode: classCode,
    trainees: readTable_('Trainees')
      .filter(function (r) { return r.ClassCode === classCode && r.AdmNo && !INACTIVE.test(r.Active || ''); })
      .map(function (r) { return { admNo: r.AdmNo, name: r.Name || r.AdmNo }; })
      .sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; })
  };
}

/** First login on a student phone: ties the phone to the chosen student, once. */
function registerDevice_(b) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ctx = loadCtx_();
    var t = ctx.trainees[String(b.admNo || '').toLowerCase()];
    if (!t || INACTIVE.test(t.Active || '')) return { ok: false, error: 'That student is not on the class list' };
    if (b.classCode && t.ClassCode !== b.classCode) return { ok: false, error: t.Name + ' is not in ' + b.classCode };
    if (!b.deviceId) return { ok: false, error: 'Missing phone ID' };
    var di = ctx.devT.index[b.deviceId], ai = ctx.byAdm[t.AdmNo.toLowerCase()];
    if (di !== undefined && ctx.devT.rows[di][1].toLowerCase() !== t.AdmNo.toLowerCase()) {
      var other = ctx.trainees[ctx.devT.rows[di][1].toLowerCase()];
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

function loadKeyed_(sh, width) {
  var last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, width).getDisplayValues() : [];
  var index = {};
  rows.forEach(function (r, i) { if (r[0]) index[r[0]] = i; });
  return { rows: rows, index: index, firstDirty: Infinity };
}

function upsert_(table, key, row) {
  var i = table.index[key];
  if (i === undefined) { i = table.rows.length; table.index[key] = i; table.rows.push(row); }
  else table.rows[i] = row;
  if (i < table.firstDirty) table.firstDirty = i;
}

function writeKeyed_(sh, table, headers) {
  if (table.firstDirty === Infinity) return;
  var start = table.firstDirty;
  var out = table.rows.slice(start).map(function (r) {
    return headers.map(function (h, c) {
      var v = r[c];
      if (NUMERIC[h]) return v === '' || v === null || v === undefined ? '' : Number(v);
      return v === null || v === undefined ? '' : String(v);
    });
  });
  var needed = start + out.length + 1; // +1 for the header row
  if (sh.getMaxRows() < needed) sh.insertRowsAfter(sh.getMaxRows(), needed - sh.getMaxRows());
  headers.forEach(function (h, c) {
    sh.getRange(start + 2, c + 1, out.length, 1).setNumberFormat(NUMERIC[h] ? '0.##' : '@');
  });
  sh.getRange(start + 2, 1, out.length, headers.length).setValues(out);
  table.firstDirty = Infinity;
}

/* ---------- trainer registers ---------- */

function pushSessions_(sessions) {
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
      s.notes, Number(s.edits) || 0, s.deviceId, s.createdAt, s.updatedAt, now
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
  if (!inRange) {
    var lastEnd = intervals.reduce(function (m, iv) { return Math.max(m, iv[1]); }, -Infinity);
    return w > lastEnd + 1 ? null : false; // later than the newest data we have: wait for the trainer's next sync
  }
  var expected = hmacHex_(c.sessionId + '|' + w, s.qr.secret).slice(0, CODE_LENGTH);
  return expected === String(c.token || '').toLowerCase();
}

function loadCtx_() {
  var ctx = { now: nowIso_(), trainees: {}, byAdm: {} };
  readTable_('Trainees').forEach(function (r) { if (r.AdmNo) ctx.trainees[r.AdmNo.toLowerCase()] = r; });
  ctx.devSh = sheet_('Devices'); ctx.devT = loadKeyed_(ctx.devSh, SHEETS.Devices.length);
  ctx.devT.rows.forEach(function (r, i) { if (r[1]) ctx.byAdm[r[1].toLowerCase()] = i; });
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
  var t = ctx.trainees[String(c.admNo).toLowerCase()];
  var adm = t ? t.AdmNo : String(c.admNo);
  var id = c.sessionId + '|' + adm + '|' + c.deviceId;
  var i = ctx.ciT.index[id];
  var row = i !== undefined ? ctx.ciT.rows[i].slice()
    : [id, c.sessionId, adm, t ? t.Name : '', classFromSession_(c.sessionId), c.deviceId, String(c.w), String(c.token || ''), c.scannedAt || '', '', '', ''];
  while (row.length < SHEETS.CheckIns.length) row.push('');
  if (row[CI.STATUS] !== 'accepted') {
    var status, reason = '';
    if (!t || INACTIVE.test(t.Active || '')) { status = 'rejected'; reason = 'unknown-student'; }
    else if (classFromSession_(c.sessionId) !== t.ClassCode) { status = 'rejected'; reason = 'wrong-class'; }
    else {
      var di = ctx.devT.index[c.deviceId], ai = ctx.byAdm[adm.toLowerCase()];
      if (di !== undefined && ctx.devT.rows[di][1].toLowerCase() !== adm.toLowerCase()) { status = 'rejected'; reason = 'device-other-student'; }
      else if (ai !== undefined && ctx.devT.rows[ai][0] !== c.deviceId) { status = 'rejected'; reason = 'student-other-device'; }
      else {
        // Normally registered at first login; a first submission from an unregistered phone registers it too.
        var reg = di !== undefined ? ctx.devT.rows[di].slice() : [c.deviceId, adm, t.Name, t.ClassCode, ctx.now, ctx.now];
        reg[5] = ctx.now;
        upsert_(ctx.devT, c.deviceId, reg);
        ctx.byAdm[adm.toLowerCase()] = ctx.devT.index[c.deviceId];
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
    rebuildSessions_(Object.keys(touched), dataT);
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

function reevaluatePending_(ids, ctx, dataT) {
  if (!ids.length) return;
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
  });
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
