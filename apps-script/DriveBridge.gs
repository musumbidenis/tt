/**
 * RVNP Attendance — Google Drive bridge (Apps Script web app, under the school's Google Workspace account).
 *
 * The attendance database lives on Cloudflare; this small script is the only part that touches Drive:
 *   1. Whenever something changes, the database pokes this script (action: nudge) and about two minutes
 *      later it asks what changed and updates, in each trainer's Drive folder, the Google Sheet
 *      "Attendance register - <term>": one tab per class and unit in the class register layout
 *      (WK1–WK12, Possible/Actual hours, %), and a CAT tab where CATs were taken. An hourly trigger
 *      catches anything a missed poke would have left behind.
 *   2. Student phones send POE evidence (PDF) here; it is saved as
 *      POE / <Class> / <Adm No - Name> / <Unit name> - <CAT1…PRAC3> - v<N>.pdf
 *      and listed in the sheet "POE - Evidence index" in the POE folder.
 *   3. Trainers' phones fetch a file here to preview it before approving.
 * Every upload and preview needs a ticket signed by the database with the shared SECRET, so the open
 * web app address cannot be used to read or write anything else.
 *
 * Set up (once): Project Settings → Script Properties:
 *   WORKER_URL          https://rvnp-attendance.<name>.workers.dev/
 *   TRAINERS_FOLDER_ID  the folder that holds one folder per trainer (the ID from its Drive link)
 *   POE_FOLDER_ID       the POE folder
 *   (WEB_APP_URL        optional: the web app's /exec address, if the automatic one is ever wrong)
 * Then run setup() once (it makes the SECRET, shows it, and starts the hourly safety check), and
 * Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 */

var BRIDGE_VERSION = '1.2.0';
var WEEKS = 12, CELLS = WEEKS * 3;
var TIME_BUDGET_MS = 4.5 * 60 * 1000;   // stop and carry on next run before Apps Script's 6-minute limit

/* ---------- setup ---------- */
function setup() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('SECRET')) p.setProperty('SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  ['WORKER_URL', 'TRAINERS_FOLDER_ID', 'POE_FOLDER_ID'].forEach(function (k) {
    if (!p.getProperty(k)) throw new Error('Add the Script Property ' + k + ' first (Project Settings → Script Properties).');
  });
  DriveApp.getFolderById(p.getProperty('TRAINERS_FOLDER_ID')).getName();   // checks access
  DriveApp.getFolderById(p.getProperty('POE_FOLDER_ID')).getName();
  // Out with the old 10-minute trigger (and any one-off left over): the database now pokes this script
  // after a change, and an hourly run is only the safety net.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sync' || t.getHandlerFunction() === 'syncOnce') ScriptApp.deleteTrigger(t);
  });
  p.deleteProperty('NUDGE_ID'); p.deleteProperty('NUDGE_AT'); p.deleteProperty('NUDGE_WANTED');
  ScriptApp.newTrigger('sync').timeBased().everyHours(1).create();
  var msg = 'Drive bridge ready.\n\nCopy this SECRET into the Cloudflare Worker as the secret BRIDGE_SECRET:\n\n' + p.getProperty('SECRET') +
    '\n\nThen Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone). The database then asks for an' +
    ' update whenever something changes, and an hourly check catches anything missed.';
  Logger.log(msg);
  return msg;
}

/* ---------- web app: student uploads and trainer previews ---------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'file') return json_(viewFile_(p.ticket));
  return json_({ ok: true, bridge: BRIDGE_VERSION });
}
function doPost(e) {
  try {
    var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (b.action === 'upload') return json_(upload_(b));
    if (b.action === 'file') return json_(viewFile_(b.ticket));
    if (b.action === 'nudge') return json_(nudge_(b));
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function secret_() {
  var s = PropertiesService.getScriptProperties().getProperty('SECRET');
  if (!s) throw new Error('The bridge is not set up: run setup()');
  return s;
}
function hmacHex_(msg) {
  return Utilities.computeHmacSha256Signature(msg, secret_()).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
function readTicket_(ticket, kind) {
  var parts = String(ticket || '').split('.');
  if (parts.length !== 2 || hmacHex_(parts[0]) !== parts[1]) throw new Error('That ticket is not valid');
  var body = parts[0].replace(/-/g, '+').replace(/_/g, '/');
  while (body.length % 4) body += '=';
  var t = JSON.parse(Utilities.newBlob(Utilities.base64Decode(body)).getDataAsString('UTF-8'));
  if (t.k !== kind) throw new Error('That ticket is for something else');
  if (t.exp < Date.now()) throw new Error('That ticket has expired');
  return t;
}
function childFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/* ---------- "something changed": the database asks for an update ---------- */
var NUDGE_DELAY_MS = 2 * 60 * 1000;   // wait two minutes, so a burst of changes becomes one update
var NUDGE_STALE_MS = 15 * 60 * 1000;
/** The same signature the database uses for bridgeFeed and bridgeReport, the other way round. */
function verifySigned_(b) {
  var ts = Number(b.ts) || 0;
  if (Math.abs(Date.now() - ts) > NUDGE_STALE_MS) throw new Error('That request is too old (check the clock)');
  if (hmacHex_(b.action + '|' + ts + '|' + (b.body || '')) !== b.sig) throw new Error('The signature does not match: the SECRET differs');
  return JSON.parse(b.body || '{}');
}
/** How long an update is already waiting for, or 0 when none is. Clears away anything left behind,
 *  so one-off triggers never pile up (Apps Script allows only 20 per script). */
function pendingSync_() {
  var p = PropertiesService.getScriptProperties();
  var id = p.getProperty('NUDGE_ID'), at = Number(p.getProperty('NUDGE_AT') || 0);
  var waiting = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'syncOnce'; });
  var live = id && at > Date.now() - NUDGE_STALE_MS && waiting.filter(function (t) { return t.getUniqueId() === id; })[0];
  if (live) return at;
  waiting.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  p.deleteProperty('NUDGE_ID'); p.deleteProperty('NUDGE_AT');
  return 0;
}
/** Books one update in two minutes, unless one is already booked. */
function scheduleSync_() {
  var waiting = pendingSync_();
  if (waiting) return waiting;
  var p = PropertiesService.getScriptProperties();
  var t = ScriptApp.newTrigger('syncOnce').timeBased().after(NUDGE_DELAY_MS).create();
  p.setProperty('NUDGE_ID', t.getUniqueId());
  p.setProperty('NUDGE_AT', String(Date.now() + NUDGE_DELAY_MS));
  return Number(p.getProperty('NUDGE_AT'));
}
/** Asks for one update soon. Twenty nudges in a row still make a single update. */
function nudge_(b) {
  verifySigned_(b);
  var lock = LockService.getScriptLock();
  // A sync may be running right now and holding the lock. Rather than lose this change until the hourly
  // run, leave a note: the sync books another update for itself when it finishes.
  if (!lock.tryLock(10000)) {
    PropertiesService.getScriptProperties().setProperty('NUDGE_WANTED', '1');
    return { ok: true, queued: false, reason: 'busy' };
  }
  try {
    var before = pendingSync_();
    var at = scheduleSync_();
    return { ok: true, queued: !before, at: at };
  } finally { lock.releaseLock(); }
}
/** What the one-off trigger runs. It deletes itself first, so nothing is left behind even if sync() fails. */
function syncOnce() {
  var p = PropertiesService.getScriptProperties();
  try {
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'syncOnce') ScriptApp.deleteTrigger(t); });
  } catch (e) { Logger.log('syncOnce: could not tidy the trigger: ' + e); }
  p.deleteProperty('NUDGE_ID'); p.deleteProperty('NUDGE_AT');
  sync();
}

/** POE / Class / Adm - Name / Unit - ITEM - vN.pdf. A version already in the folder moves the new one up. */
function upload_(b) {
  var t = readTicket_(b.ticket, 'up');
  if (!b.data) throw new Error('No file was sent');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('POE_FOLDER_ID'));
    t.folders.forEach(function (f) { folder = childFolder_(folder, f); });
    var v = Number(t.v) || 1, name = t.name;
    var stem = name.replace(/ - v\d+\.pdf$/, '');
    while (folder.getFilesByName(name).hasNext()) { v++; name = stem + ' - v' + v + '.pdf'; }
    var blob = Utilities.newBlob(Utilities.base64Decode(b.data), b.mime || 'application/pdf', name);
    var file = folder.createFile(blob);
    file.setDescription('POE evidence ' + t.item + ' for ' + t.unit + ', uploaded from the student app ' + new Date().toISOString());
    return { ok: true, fileId: file.getId(), fileName: name, version: v, sig: hmacHex_('done|' + t.id + '|' + file.getId() + '|' + v + '|' + name) };
  } finally { lock.releaseLock(); }
}
function viewFile_(ticket) {
  try {
    var t = readTicket_(ticket, 'view');
    var f = DriveApp.getFileById(t.fileId), blob = f.getBlob();
    return { ok: true, name: f.getName(), mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/* ---------- every 10 minutes: attendance sheets and the evidence index ---------- */
function callWorker_(action, body) {
  var p = PropertiesService.getScriptProperties();
  var payload = JSON.stringify(body || {}), ts = Date.now();
  var res = UrlFetchApp.fetch(p.getProperty('WORKER_URL'), {
    method: 'post', contentType: 'text/plain;charset=utf-8', muteHttpExceptions: true,
    payload: JSON.stringify({ action: action, ts: ts, body: payload, sig: hmacHex_(action + '|' + ts + '|' + payload) }),
  });
  var out = JSON.parse(res.getContentText());
  if (!out.ok) throw new Error(action + ': ' + out.error);
  return out;
}

function sync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {                       // the previous run is still going
    PropertiesService.getScriptProperties().setProperty('NUDGE_WANTED', '1');
    return;
  }
  var started = Date.now(), p = PropertiesService.getScriptProperties();
  try {
    // A traversal of the changes can span several runs: PENDING keeps where it got to.
    var pend = JSON.parse(p.getProperty('PENDING') || 'null');
    var since = pend ? pend.since : (p.getProperty('CURSOR') || ''), offset = pend ? pend.offset : 0, startNow = pend ? pend.now : null;
    var folders = trainerFolders_(), sheets = JSON.parse(p.getProperty('SHEETS') || '{}');
    var report = { matched: 0, unmatched: [], sheets: {} };
    var trainers = pend ? JSON.parse(p.getProperty('TRAINERS') || '[]') : null;
    while (true) {
      var feed = callWorker_('bridgeFeed', { since: since, offset: offset });
      if (!startNow) startNow = feed.now;
      if (feed.trainers) { trainers = feed.trainers; p.setProperty('TRAINERS', JSON.stringify(trainers)); }
      if (feed.evidence && feed.evidence.length) writeEvidenceIndex_(feed.evidence);
      feed.units.forEach(function (u) {
        var tr = (trainers || []).filter(function (x) { return lowerEq_(x.code, u.trainerCode); })[0] || { code: u.trainerCode, name: u.trainerName, folder: '' };
        var folder = resolveFolder_(tr, folders);
        if (!folder) return;
        var ss = trainerSheet_(tr, folder, u.termName, sheets);
        writeRegister_(ss, u);
        if (u.cats && u.cats.length) writeCats_(ss, u);
        if (u.marksheet) writeMarksheet_(trainerSheet_(tr, folder, u.termName, sheets, 'marks'), u);
      });
      p.setProperty('SHEETS', JSON.stringify(sheets));
      if (feed.next === null || feed.next === undefined) { p.setProperty('CURSOR', startNow); p.deleteProperty('PENDING'); break; }
      offset = feed.next;
      if (Date.now() - started > TIME_BUDGET_MS) { p.setProperty('PENDING', JSON.stringify({ since: since, offset: offset, now: startNow })); break; }
    }
    var matchedNow = [];
    (trainers || []).forEach(function (tr) {
      var f = resolveFolder_(tr, folders);
      if (f) { report.matched++; matchedNow.push(tr.code + '=' + f.getId()); var id = sheets[tr.code + '|' + currentTerm_(sheets, tr.code)]; if (id) report.sheets[tr.code] = 'https://docs.google.com/spreadsheets/d/' + id; }
      else report.unmatched.push({ code: tr.code, name: tr.name });
    });
    // A trainer whose folder was only just found (or a new Trainers folder) gets all their registers next run,
    // not only the ones that change from now on.
    var before = JSON.parse(p.getProperty('MATCHED') || '[]'), fresh = matchedNow.filter(function (k) { return before.indexOf(k) === -1; });
    if (fresh.length && since && !p.getProperty('PENDING')) p.deleteProperty('CURSOR');
    p.setProperty('MATCHED', JSON.stringify(matchedNow));
    report.url = webAppUrl_();
    report.indexUrl = p.getProperty('INDEX_ID') ? 'https://docs.google.com/spreadsheets/d/' + p.getProperty('INDEX_ID') : '';
    report.folders = folders.map(function (f) { return { id: f.id, name: f.name }; });
    report.bridge = BRIDGE_VERSION;
    callWorker_('bridgeReport', report);
  } finally { lock.releaseLock(); }
  // Anything that changed while this run was going, or a page of changes still to work through,
  // gets its own update in two minutes instead of waiting for the hour.
  if (p.getProperty('NUDGE_WANTED') || p.getProperty('PENDING')) {
    p.deleteProperty('NUDGE_WANTED');
    try { scheduleSync_(); } catch (e) { Logger.log('could not book the next update: ' + e); }
  }
}
/** The address phones use. A school-domain address (/a/macros/<domain>/) is turned into the plain one, which
 * works for students who are not signed in; WEB_APP_URL in Script Properties overrides it if ever needed. */
function webAppUrl_() {
  var own = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  var url = own || ScriptApp.getService().getUrl() || '';
  return url.replace(/\/a\/macros\/[^/]+\//, '/macros/').replace(/\/dev$/, '/exec');
}
/** Run by hand to rewrite every trainer's sheet from the database on the next update (or straight away). */
function resyncAll() {
  var p = PropertiesService.getScriptProperties();
  p.deleteProperty('CURSOR'); p.deleteProperty('PENDING'); p.deleteProperty('NUDGE_WANTED');
  pendingSync_();   // an update already waiting is dropped: this run covers everything anyway
  sync();
}
function currentTerm_(sheets, code) {
  var keys = Object.keys(sheets).filter(function (k) { return k.indexOf(code + '|') === 0; });
  return keys.length ? keys[keys.length - 1].split('|')[1] : '';
}
function lowerEq_(a, b) { return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase(); }

/* ---------- finding each trainer's folder ---------- */
function trainerFolders_() {
  var out = [], it = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('TRAINERS_FOLDER_ID')).getFolders();
  while (it.hasNext()) { var f = it.next(); out.push({ id: f.getId(), name: f.getName(), folder: f }); }
  return out;
}
function words_(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean); }
/** The MIS Officer's choice first; else a folder naming the staff code; else the one folder with the trainer's surname. */
function resolveFolder_(tr, folders) {
  if (tr.folder) { var o = folders.filter(function (f) { return f.id === tr.folder; })[0]; if (o) return o.folder; try { return DriveApp.getFolderById(tr.folder); } catch (e) { /* not reachable */ } }
  var code = String(tr.code || '').toUpperCase();
  var byCode = folders.filter(function (f) { return words_(f.name).indexOf(code) !== -1 || f.name.toUpperCase().indexOf(code) !== -1; });
  if (byCode.length === 1) return byCode[0].folder;
  var w = words_(tr.name);
  if (w.length > 1 && /^[A-Z]{2,4}$/.test(w[0]) && w[0] !== w[w.length - 1]) w = w.slice(1);   // "ICT MUSUMBI .D": department prefix
  var surname = w.filter(function (x) { return x.length >= 3; }).sort(function (a, b) { return b.length - a.length; })[0];
  if (!surname) return null;
  var hits = folders.filter(function (f) { return words_(f.name).indexOf(surname) !== -1; });
  if (hits.length > 1) {
    var initials = w.filter(function (x) { return x !== surname; }).map(function (x) { return x[0]; });
    hits = hits.filter(function (f) { var fw = words_(f.name); return initials.every(function (i) { return fw.some(function (x) { return x[0] === i && x !== surname; }); }); });
  }
  return hits.length === 1 ? hits[0].folder : null;
}

/* ---------- the trainer's attendance sheet ---------- */
function trainerSheet_(tr, folder, termName, sheets, kind) {
  var marks = kind === 'marks';
  var key = (marks ? 'M|' : '') + tr.code + '|' + termName, id = sheets[key];
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* deleted: make a new one */ } }
  var name = (marks ? 'Marksheets - ' : 'Attendance register - ') + termName;
  var it = folder.getFilesByName(name);
  var ss = it.hasNext() ? SpreadsheetApp.openById(it.next().getId()) : null;
  if (!ss) {
    ss = SpreadsheetApp.create(name);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
    var first = ss.getSheets()[0];
    first.setName('About');
    first.getRange(1, 1, 3, 1).setValues(marks
      ? [['Continuous assessment marksheets for ' + tr.name + ' — ' + termName], ['Updated automatically, within a few minutes of marks being entered in the RVNP attendance app. Changes made here are overwritten: enter marks in the app.'], ['One tab per class and unit, in the RVNP marksheet layout.']]
      : [['Attendance register for ' + tr.name + ' — ' + termName], ['Updated automatically, within a few minutes of a register being marked in the RVNP attendance app. Changes made here are overwritten.'], ['One tab per class and unit; CAT registers in the tabs ending in "CATs".']]);
    first.getRange(1, 1).setFontWeight('bold').setFontSize(14);
  }
  sheets[key] = ss.getId();
  return ss;
}
function tabName_(u, suffix) {
  return (String(u.classCode).split(' ').pop() + ' ' + u.unitCode + (suffix || '')).replace(/[\[\]\*\?\/\\:]/g, '-').slice(0, 90);
}
function colName_(n) { var s = ''; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }

/** Writes one class register in RVNP's layout. Rows 1–8 are the heading, then one row per student, then the comments. */
function writeRegister_(ss, u) {
  var name = tabName_(u), sh = ss.getSheetByName(name), fresh = !sh;
  if (!sh) sh = ss.insertSheet(name);
  var W = 3 + CELLS + 3, n = Math.max(1, u.rows.length), last = 8 + n + 2;
  var blank = function () { var r = []; for (var i = 0; i < W; i++) r.push(''); return r; };
  var v = [];
  for (var i = 0; i < last; i++) v.push(blank());
  v[0][2] = 'RIFT VALLEY NATIONAL POLYTECHNIC';
  v[1][2] = 'NAME OF LECTURER'; v[1][3] = u.trainerName; v[1][21] = 'DURATION'; v[1][27] = u.duration;
  v[2][2] = 'CLASS'; v[2][3] = u.misClass + (u.misClass !== u.classCode ? ' (' + u.classCode + ')' : ''); v[2][21] = 'LEVEL'; v[2][27] = u.level;
  v[3][2] = 'SUBJECT'; v[3][3] = u.unitCode + ' - ' + u.unitName;
  v[4][0] = 'GENERAL CLASS REGISTER';
  v[5][0] = 'FILTERED BY: {Class: ' + u.misClass + '}   ·   ' + u.termName + '   ·   updated ' + Utilities.formatDate(new Date(), 'Africa/Nairobi', 'd MMM yyyy HH:mm');
  v[6][0] = '#'; v[6][1] = 'ADMISSION NO'; v[6][2] = 'NAMES';
  for (var w = 0; w < WEEKS; w++) { v[6][3 + w * 3] = 'WK' + (w + 1); for (var k = 0; k < 3; k++) v[7][3 + w * 3 + k] = k + 1; }
  v[6][W - 3] = 'Possible Hrs'; v[6][W - 2] = 'Actual Hrs'; v[6][W - 1] = 'Actual Attendance %';
  u.rows.forEach(function (r, i) {
    var row = v[8 + i];
    row[0] = i + 1; row[1] = r.admNo; row[2] = r.name + (r.pending ? ' (pending)' : '');
    for (var c = 0; c < CELLS; c++) row[3 + c] = r.cells[c] || '';
    row[W - 3] = r.possible || ''; row[W - 2] = r.actual || ''; row[W - 1] = r.pct === null ? '-' : r.pct;
  });
  v[last - 2][0] = "Lecturer's Comment"; v[last - 2][3] = u.lecturerComment || '';
  v[last - 1][0] = "HOD's Comment"; v[last - 1][3] = u.hodComment || '';
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  if (sh.getMaxColumns() < W) sh.insertColumnsAfter(sh.getMaxColumns(), W - sh.getMaxColumns());
  if (sh.getMaxRows() < last) sh.insertRowsAfter(sh.getMaxRows(), last - sh.getMaxRows());
  sh.getRange(1, 1, last, W).setValues(v);
  var L = colName_(W);
  ['C1:' + L + '1', 'D2:U2', 'V2:AA2', 'AB2:' + L + '2', 'D3:U3', 'V3:AA3', 'AB3:' + L + '3', 'D4:' + L + '4', 'A5:' + L + '5', 'A6:' + L + '6',
    'A' + (last - 1) + ':C' + (last - 1), 'D' + (last - 1) + ':' + L + (last - 1), 'A' + last + ':C' + last, 'D' + last + ':' + L + last]
    .forEach(function (a) { sh.getRange(a).merge(); });
  for (w = 0; w < WEEKS; w++) sh.getRange(7, 4 + w * 3, 1, 3).merge();
  ['A7:A8', 'B7:B8', 'C7:C8', colName_(W - 2) + '7:' + colName_(W - 2) + '8', colName_(W - 1) + '7:' + colName_(W - 1) + '8', L + '7:' + L + '8'].forEach(function (a) { sh.getRange(a).merge(); });
  sh.getRange(1, 1, 8, W).setFontWeight('bold').setVerticalAlignment('middle');
  sh.getRange('C1').setFontSize(14).setHorizontalAlignment('center');
  sh.getRange('A5:A6').setHorizontalAlignment('center');
  sh.getRange(7, 1, 2 + n, W).setBorder(true, true, true, true, true, true).setHorizontalAlignment('center');
  sh.getRange(9, 2, n, 2).setHorizontalAlignment('left');
  sh.getRange(9, W, n, 1).setNumberFormat('0.0%');
  sh.getRange(last - 1, 1, 2, W).setBorder(true, true, true, true, true, true).setVerticalAlignment('top').setWrap(true);
  sh.getRange(last - 1, 1, 2, 3).setFontWeight('bold');
  if (fresh) {
    sh.setColumnWidth(1, 32); sh.setColumnWidth(2, 150); sh.setColumnWidth(3, 230);
    sh.setColumnWidths(4, CELLS, 22); sh.setColumnWidths(W - 2, 2, 70); sh.setColumnWidth(W, 90);
    sh.setFrozenRows(8);   // columns are not frozen: the heading rows are merged across them, which Sheets refuses
  }
  var cells = sh.getRange(9, 4, n, CELLS), rules = [];
  [['P', '#e0f2e7', '#10773c'], ['L', '#fcefd8', '#a35f00'], ['A', '#fbe4e5', '#c42830'], ['E', '#e2eaf5', '#33598a']].forEach(function (x) {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(x[0]).setBackground(x[1]).setFontColor(x[2]).setRanges([cells]).build());
  });
  sh.setConditionalFormatRules(rules);
}

/** CATs and extra CAT attendance: one column per CAT register. */
function writeCats_(ss, u) {
  var name = tabName_(u, ' CATs'), sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var head = ['#', 'ADMISSION NO', 'NAMES'].concat(u.cats.map(function (c) { return c.title + '\n' + c.date; }));
  var v = [[u.unitCode + ' - ' + u.unitName + ' · ' + u.misClass + ' · CAT attendance (not counted in the class register hours)'].concat(head.slice(1).map(function () { return ''; })), head];
  u.rows.forEach(function (r, i) { v.push([i + 1, r.admNo, r.name].concat(u.cats.map(function (c) { return c.marks[r.admNo] || ''; }))); });
  sh.clear();
  sh.getRange(1, 1, v.length, head.length).setValues(v);
  sh.getRange(1, 1, 2, head.length).setFontWeight('bold');
  sh.getRange(2, 1, v.length - 1, head.length).setBorder(true, true, true, true, true, true).setHorizontalAlignment('center').setWrap(true);
  sh.setFrozenRows(2);
}

/** The continuous assessment marks sheet per unit of competency, in the RVNP layout. AVG = sum ÷ 3. */
function writeMarksheet_(ss, u) {
  var m = u.marksheet, name = tabName_(u), sh = ss.getSheetByName(name), fresh = !sh;
  if (!sh) sh = ss.insertSheet(name);
  var W = 12, n = Math.max(1, m.rows.length), first = 11, last = first + n - 1, foot = last + 2, end = foot + 4;
  var v = [];
  for (var i = 0; i < end; i++) { var r = []; for (var j = 0; j < W; j++) r.push(''); v.push(r); }
  v[0][0] = 'THE RIFT VALLEY NATIONAL POLYTECHNIC'; v[1][0] = 'ICT DEPARTMENT'; v[2][0] = 'CONTINUOUS ASSESSMENT MARKS SHEET PER UNIT OF COMPETENCY';
  v[4][0] = 'Course Code:'; v[4][2] = m.courseCode; v[4][4] = 'Course Name:'; v[4][6] = m.courseName;
  v[5][0] = 'Unit Code:'; v[5][2] = u.unitCode; v[5][4] = 'Unit Title:'; v[5][6] = u.unitName;
  v[6][0] = 'Assessment Series:'; v[6][2] = m.series;
  v[8][0] = 'S/N'; v[8][1] = 'Candidate’s Reg Code'; v[8][2] = 'Center Admission No.'; v[8][3] = 'Candidate’s Name'; v[8][4] = 'Oral/Theory Marks (100%)'; v[8][8] = 'Practical Marks (100%)';
  ['CAT 1', 'CAT 2', 'CAT 3', 'AVG', 'PRAC 1', 'PRAC 2', 'PRAC 3', 'AVG'].forEach(function (t, k) { v[9][4 + k] = t; });
  m.rows.forEach(function (s, i) {
    var row = v[first - 1 + i], rn = first + i;
    row[0] = i + 1; row[1] = s.regCode || ''; row[2] = s.admNo; row[3] = s.name;
    for (var k = 0; k < 3; k++) { row[4 + k] = s.cat[k] === null ? '' : s.cat[k]; row[8 + k] = s.prac[k] === null ? '' : s.prac[k]; }
    row[7] = '=IF(COUNT(E' + rn + ':G' + rn + ')=0,"",SUM(E' + rn + ':G' + rn + ')/3)';
    row[11] = '=IF(COUNT(I' + rn + ':K' + rn + ')=0,"",SUM(I' + rn + ':K' + rn + ')/3)';
  });
  v[foot - 1][0] = 'Prepared by: ..............................'; v[foot - 1][4] = 'Signature: ..................'; v[foot - 1][9] = 'Date: ............';
  v[foot][0] = 'Received by: ..............................'; v[foot][4] = 'Signature: ..................'; v[foot][9] = 'Date: ............';
  v[foot + 1][0] = 'Approved by: ..............................'; v[foot + 1][4] = 'Signature: ..................'; v[foot + 1][9] = 'Date: ............';
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  if (sh.getMaxRows() < end) sh.insertRowsAfter(sh.getMaxRows(), end - sh.getMaxRows());
  sh.getRange(1, 1, end, W).setValues(v);
  ['A1:L1', 'A2:L2', 'A3:L3', 'A5:B5', 'C5:D5', 'E5:F5', 'G5:L5', 'A6:B6', 'C6:D6', 'E6:F6', 'G6:L6', 'A7:B7', 'C7:D7',
    'A9:A10', 'B9:B10', 'C9:C10', 'D9:D10', 'E9:H9', 'I9:L9'].forEach(function (a) { sh.getRange(a).merge(); });
  sh.getRange('A1:L3').setHorizontalAlignment('center').setFontWeight('bold');
  sh.getRange('A1').setFontSize(13); sh.getRange('A3').setFontColor('#1f6fbf');
  sh.getRange('A5:A7').setFontWeight('bold'); sh.getRange('E5:E6').setFontWeight('bold');
  sh.getRange('A9:L10').setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sh.getRange('E10:H10').setBackground('#d9d9d9'); sh.getRange('I10:L10').setBackground('#fbe4d5');
  sh.getRange(9, 1, 2 + n, W).setBorder(true, true, true, true, true, true);
  sh.getRange(first, 1, n, 1).setHorizontalAlignment('center');
  sh.getRange(first, 5, n, 8).setHorizontalAlignment('center');
  sh.getRange(first, 8, n, 1).setNumberFormat('0'); sh.getRange(first, 12, n, 1).setNumberFormat('0');
  sh.getRange(foot, 1, 3, W).setFontWeight('bold');
  if (fresh) {
    sh.setColumnWidth(1, 40); sh.setColumnWidths(2, 2, 190); sh.setColumnWidth(4, 210); sh.setColumnWidths(5, 8, 62);
    sh.setFrozenRows(10);
  }
}

/* ---------- POE evidence index in the POE folder ---------- */
var INDEX_HEAD = ['ID', 'Class', 'Admission No', 'Name', 'Unit', 'Item', 'Version', 'File', 'Status', 'Decided by', 'Decided at', 'Trainer comment', 'Submitted at', 'Received by MIS'];
function writeEvidenceIndex_(list) {
  var p = PropertiesService.getScriptProperties(), id = p.getProperty('INDEX_ID'), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('POE - Evidence index');
    DriveApp.getFileById(ss.getId()).moveTo(DriveApp.getFolderById(p.getProperty('POE_FOLDER_ID')));
    var s0 = ss.getSheets()[0]; s0.setName('Evidence');
    s0.getRange(1, 1, 1, INDEX_HEAD.length).setValues([INDEX_HEAD]).setFontWeight('bold');
    s0.setFrozenRows(1); s0.hideColumns(1);
    p.setProperty('INDEX_ID', ss.getId());
  }
  var sh = ss.getSheetByName('Evidence') || ss.getSheets()[0];
  var lastRow = sh.getLastRow(), ids = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  var at = {}; ids.forEach(function (x, i) { at[x] = i + 2; });
  list.forEach(function (e) {
    var row = [e.id, e.classCode, e.admNo, e.name, e.unitCode + ' - ' + e.unitName, e.item, 'v' + e.version,
      '=HYPERLINK("https://drive.google.com/file/d/' + e.fileId + '/view","' + String(e.fileName).replace(/"/g, "'") + '")',
      e.status, e.decidedName, e.decidedAt ? e.decidedAt.slice(0, 16).replace('T', ' ') : '', e.comment, String(e.submittedAt).slice(0, 16).replace('T', ' '), e.receivedAt ? 'Yes' : ''];
    var r = at[e.id];
    if (!r) { r = sh.getLastRow() + 1; at[e.id] = r; }
    sh.getRange(r, 1, 1, row.length).setValues([row]);
  });
}
