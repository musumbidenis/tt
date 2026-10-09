/**
 * Attendance Register — Google Sheets backend.
 *
 * Paste this into Extensions > Apps Script of the Google Sheet that will hold
 * the attendance data, run setup() once, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone). Give trainers the /exec URL and the
 * access token shown by setup().
 *
 * Sheets used:
 *   Classes     ClassCode | ClassName                         (you maintain)
 *   Units       ClassCode | UnitCode | UnitName               (you maintain)
 *   Trainees    AdmNo | Name | ClassCode | Active             (you maintain)
 *   Sessions    one row per lesson register                   (written by the app)
 *   Attendance  one row per trainee per lesson                (written by the app)
 */

var SHEETS = {
  Classes: ['ClassCode', 'ClassName'],
  Units: ['ClassCode', 'UnitCode', 'UnitName'],
  Trainees: ['AdmNo', 'Name', 'ClassCode', 'Active'],
  Sessions: ['SessionID', 'Date', 'ClassCode', 'ClassName', 'UnitCode', 'UnitName', 'Period',
    'TrainerID', 'TrainerName', 'Present', 'Absent', 'Late', 'Excused', 'Total', 'AttendancePct',
    'Notes', 'Edits', 'DeviceID', 'CreatedAt', 'UpdatedAt', 'SyncedAt'],
  Attendance: ['RecordID', 'SessionID', 'Date', 'ClassCode', 'UnitCode', 'UnitName', 'Period',
    'AdmNo', 'Name', 'Status', 'TrainerID', 'TrainerName', 'UpdatedAt', 'SyncedAt']
};
var NUMERIC = { Present: 1, Absent: 1, Late: 1, Excused: 1, Total: 1, AttendancePct: 1, Edits: 1 };

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
  Object.keys(SHEETS).forEach(function (name) {
    var headers = SHEETS[name];
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    // Keep codes, dates and timestamps as text so Sheets does not reformat them.
    headers.forEach(function (h, i) {
      sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat(NUMERIC[h] ? '0.##' : '@');
    });
  });
  addSampleRows_(ss);
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('API_TOKEN')) props.setProperty('API_TOKEN', newToken_());
  showToken();
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

function showToken() {
  var token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  var msg = 'Access token for the attendance app:\n\n' + token +
    '\n\nPaste it in the app under Setup > Google Sheets. Keep it private.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* run from the editor: see the log */ }
}

function resetToken() {
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', newToken_());
  showToken();
}

/* ---------- web app ---------- */

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    checkToken_(p.token);
    if (p.action === 'ping') {
      return json_({ ok: true, spreadsheet: SpreadsheetApp.getActiveSpreadsheet().getName(), time: new Date().toISOString() });
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
    checkToken_(body.token);
    if (body.action === 'push') return json_(pushSessions_(body.sessions || []));
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
  var expected = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
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
  var inactive = /^(no|n|false|0|inactive|left|discontinued)$/i;
  return {
    ok: true,
    classes: readTable_('Classes').filter(function (r) { return r.ClassCode; })
      .map(function (r) { return { code: r.ClassCode, name: r.ClassName || r.ClassCode }; }),
    units: readTable_('Units').filter(function (r) { return r.ClassCode && r.UnitCode; })
      .map(function (r) { return { classCode: r.ClassCode, code: r.UnitCode, name: r.UnitName || r.UnitCode }; }),
    trainees: readTable_('Trainees').filter(function (r) { return r.AdmNo && r.ClassCode; })
      .map(function (r) { return { admNo: r.AdmNo, name: r.Name || r.AdmNo, classCode: r.ClassCode, active: !inactive.test(r.Active || '') }; })
  };
}

/* ---------- push (upsert) ---------- */

function pushSessions_(sessions) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sessSh = ss.getSheetByName('Sessions');
    var attSh = ss.getSheetByName('Attendance');
    if (!sessSh || !attSh) throw new Error('Run setup() first — Sessions/Attendance sheets are missing');
    var sTable = loadKeyed_(sessSh, SHEETS.Sessions.length);
    var aTable = loadKeyed_(attSh, SHEETS.Attendance.length);
    var updCol = SHEETS.Sessions.indexOf('UpdatedAt');
    var now = new Date().toISOString();
    var results = [];

    sessions.forEach(function (s) {
      if (!s || !s.sessionId) return;
      var existing = sTable.index[s.sessionId];
      // Never let an older copy (e.g. from a phone that was offline longer) overwrite a newer one.
      if (existing !== undefined && String(sTable.rows[existing][updCol]) > String(s.updatedAt || '')) {
        results.push({ sessionId: s.sessionId, status: 'stale' });
        return;
      }
      var c = s.counts || {};
      var P = Number(c.P) || 0, A = Number(c.A) || 0, L = Number(c.L) || 0, E = Number(c.E) || 0;
      var counted = P + L + A;
      upsert_(sTable, s.sessionId, [
        s.sessionId, s.date, s.classCode, s.className, s.unitCode, s.unitName, s.period,
        s.trainerId, s.trainerName, P, A, L, E, P + A + L + E,
        counted ? Math.round((P + L) / counted * 1000) / 10 : '',
        s.notes, Number(s.edits) || 0, s.deviceId, s.createdAt, s.updatedAt, now
      ]);
      (s.marks || []).forEach(function (m) {
        var rid = s.sessionId + '|' + m.admNo;
        upsert_(aTable, rid, [rid, s.sessionId, s.date, s.classCode, s.unitCode, s.unitName, s.period,
          m.admNo, m.name, m.status, s.trainerId, s.trainerName, s.updatedAt, now]);
      });
      results.push({ sessionId: s.sessionId, status: existing === undefined ? 'added' : 'updated' });
    });

    writeKeyed_(sessSh, sTable, SHEETS.Sessions);
    writeKeyed_(attSh, aTable, SHEETS.Attendance);
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

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
}
