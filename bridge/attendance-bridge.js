#!/usr/bin/env node
/*
 * RVNP Attendance — CouchDB ⇄ Google Sheets bridge.
 *
 * Normally run by the GitHub Action in .github/workflows/sheets-sync.yml every 10 minutes
 * (it can also run continuously on any machine with `node attendance-bridge.js --watch`).
 *   • Registers (CouchDB "session:" docs) → Google Sheets "Sessions" and "Attendance" tabs (upsert, never duplicated)
 *   • Class lists in Google Sheets ("Classes", "Units", "Trainees" tabs) → CouchDB, so every phone receives them
 *   • Writes a "status:sheets" doc into CouchDB so the app can show when Sheets was last updated
 *
 * Usage:
 *   node attendance-bridge.js --sync     class lists Sheets → CouchDB, then new registers CouchDB → Sheets, then exit
 *   node attendance-bridge.js --setup    prepare CouchDB (database, CORS, security, trainer login) and the Sheet tabs
 *   node attendance-bridge.js --roster   only copy class lists from Sheets into CouchDB
 *   node attendance-bridge.js --watch    run continuously instead of on a schedule
 *
 * Configuration: environment variables (GitHub secrets) or config.json next to this file.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { sheets: sheetsApi, auth: googleAuth } = require('@googleapis/sheets');

/* ---------------- configuration ---------------- */
const cfgFile = process.env.BRIDGE_CONFIG || path.join(__dirname, 'config.json');
const fileCfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
const env = (k, fallback) => process.env[k] ?? fallback;
const cfg = {
  couchUrl: env('COUCH_URL', fileCfg.couchUrl),                 // e.g. http://127.0.0.1:5984/rvnp_attendance
  couchUser: env('COUCH_USER', fileCfg.couchUser || ''),
  couchPassword: env('COUCH_PASSWORD', fileCfg.couchPassword || ''),
  spreadsheetId: env('SPREADSHEET_ID', fileCfg.spreadsheetId),
  googleKeyFile: env('GOOGLE_KEY_FILE', fileCfg.googleKeyFile || path.join(__dirname, 'service-account.json')),
  googleKeyJson: env('GOOGLE_SERVICE_ACCOUNT_JSON', ''),           // the key file's contents (used by the GitHub Action)
  trainerUser: env('TRAINER_USER', fileCfg.trainerUser || 'trainer'),
  trainerPassword: env('TRAINER_PASSWORD', fileCfg.trainerPassword || ''),
  corsOrigin: env('CORS_ORIGIN', fileCfg.corsOrigin || ''),        // e.g. https://musumbidenis.github.io
  rosterEveryMinutes: Number(env('ROSTER_EVERY_MINUTES', fileCfg.rosterEveryMinutes ?? 15)),
  batchDelayMs: Number(env('BATCH_DELAY_MS', fileCfg.batchDelayMs ?? 4000)),
  sheetsRootUrl: env('SHEETS_ROOT_URL', fileCfg.sheetsRootUrl || ''), // only for testing against a mock API
};
if (!path.isAbsolute(cfg.googleKeyFile)) cfg.googleKeyFile = path.resolve(path.dirname(cfgFile), cfg.googleKeyFile);
if (!cfg.couchUrl) fail('couchUrl is not set (config.json or COUCH_URL)');
if (!cfg.spreadsheetId) fail('spreadsheetId is not set (config.json or SPREADSHEET_ID)');

const STATUS_ID = 'status:sheets';
const ROSTER_CMD_ID = 'cmd:roster-refresh';
const CHECKPOINT = 'sheets-bridge-checkpoint';

const TABS = {
  Classes: ['ClassCode', 'ClassName'],
  Units: ['ClassCode', 'UnitCode', 'UnitName'],
  Trainees: ['AdmNo', 'Name', 'ClassCode', 'Active'],
  Sessions: ['SessionID', 'Date', 'ClassCode', 'ClassName', 'UnitCode', 'UnitName', 'Period',
    'TrainerID', 'TrainerName', 'Present', 'Absent', 'Late', 'Excused', 'Total', 'AttendancePct',
    'Notes', 'Edits', 'DeviceID', 'CreatedAt', 'UpdatedAt', 'SyncedAt'],
  Attendance: ['RecordID', 'SessionID', 'Date', 'ClassCode', 'UnitCode', 'UnitName', 'Period',
    'AdmNo', 'Name', 'Status', 'TrainerID', 'TrainerName', 'UpdatedAt', 'SyncedAt'],
};
const STATUS_LABEL = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };
const PERIOD_LABEL = { L1: 'Lesson 1', L2: 'Lesson 2', L3: 'Lesson 3', L4: 'Lesson 4', L5: 'Lesson 5', L6: 'Lesson 6', EV: 'Evening' };

/* ---------------- small helpers ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();
function log(...a) { console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a); }
function fail(msg) { console.error('Configuration error: ' + msg); process.exit(1); }
function col(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function chunk(a, n) { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; }

// Serialise work so the change feed, roster timer and commands never write at the same time.
let queue = Promise.resolve();
const exclusive = (fn) => (queue = queue.then(fn, fn));

/* ---------------- CouchDB over HTTP ---------------- */
const couchBase = cfg.couchUrl.replace(/\/+$/, '');
const couchAuth = cfg.couchUser ? 'Basic ' + Buffer.from(`${cfg.couchUser}:${cfg.couchPassword}`).toString('base64') : null;

async function couch(method, p, body, query, timeoutMs = 30000) {
  const url = new URL(couchBase + p);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(couchAuth ? { Authorization: couchAuth } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) { const e = new Error(`CouchDB ${method} ${p} → ${res.status} ${data.reason || data.error || ''}`); e.status = res.status; throw e; }
    return data;
  } finally { clearTimeout(timer); }
}
const docPath = (id) => '/' + encodeURIComponent(id);
async function getDoc(id) { try { return await couch('GET', docPath(id)); } catch (e) { if (e.status === 404) return null; throw e; } }
async function upsertDoc(id, patch) {
  for (let i = 0; i < 5; i++) {
    const cur = (await getDoc(id)) || { _id: id };
    const next = { ...cur, ...patch, _id: id };
    try { await couch('PUT', docPath(id), next); return next; } catch (e) { if (e.status !== 409) throw e; }
  }
  throw new Error('Could not update ' + id);
}
async function byPrefix(prefix) {
  const r = await couch('GET', '/_all_docs', undefined, { include_docs: 'true', startkey: prefix, endkey: prefix + '￰' });
  return r.rows.map((x) => x.doc).filter(Boolean);
}
async function loadCheckpoint() {
  try { return (await couch('GET', '/_local/' + CHECKPOINT)).seq ?? '0'; } catch (e) { if (e.status === 404) return '0'; throw e; }
}
async function saveCheckpoint(seq) {
  let rev;
  try { rev = (await couch('GET', '/_local/' + CHECKPOINT))._rev; } catch (e) { if (e.status !== 404) throw e; }
  await couch('PUT', '/_local/' + CHECKPOINT, { seq, savedAt: nowISO(), ...(rev ? { _rev: rev } : {}) });
}
async function setStatus(patch) {
  try { await upsertDoc(STATUS_ID, { type: 'status', ...patch, updatedAt: nowISO() }); }
  catch (e) { log('Could not write status doc:', e.message); }
}

/* ---------------- CouchDB first-time setup ---------------- */
const serverBase = couchBase.replace(/\/[^/]+$/, '');
const dbName = decodeURIComponent(couchBase.slice(serverBase.length + 1));
async function server(method, p, body) {
  const res = await fetch(serverBase + p, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(couchAuth ? { Authorization: couchAuth } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { data = { reason: text.slice(0, 120) }; }
  return { status: res.status, data };
}
const okOr = (r, ...codes) => (r.status >= 200 && r.status < 300) || codes.includes(r.status);

async function setupCouch() {
  const up = await server('GET', '/');
  if (up.status >= 400 || (!up.data.couchdb && !up.data['express-pouchdb'])) {
    throw new Error(`No CouchDB answered at ${serverBase} (HTTP ${up.status}). Check COUCH_URL and that the server is on.`);
  }
  log(`CouchDB ${up.data.version || ''} reachable at ${serverBase}`);

  // System databases (a fresh single-node install needs them for logins).
  for (const sys of ['_users', '_replicator']) await server('PUT', '/' + sys);

  const db = await server('PUT', '/' + encodeURIComponent(dbName));
  if (okOr(db, 412)) log(db.status === 412 ? `Database "${dbName}" already exists` : `Created database "${dbName}"`);
  else throw new Error(`Could not create database "${dbName}": ${db.data.reason || db.status}`);

  // Let the GitHub Pages app talk to CouchDB from the browser.
  if (cfg.corsOrigin) {
    const origin = cfg.corsOrigin.toLowerCase().replace(/\/+$/, '');
    const settings = [
      ['chttpd', 'enable_cors', 'true'], ['cors', 'origins', origin], ['cors', 'credentials', 'true'],
      ['cors', 'methods', 'GET, PUT, POST, HEAD, DELETE'],
      ['cors', 'headers', 'accept, authorization, content-type, origin, referer'],
    ];
    let ok = true;
    for (const [section, key, value] of settings) {
      const r = await server('PUT', `/_node/_local/_config/${section}/${key}`, value);
      if (!okOr(r)) ok = false;
    }
    log(ok ? `CORS allows ${origin}` : `Could not set CORS automatically (hosted CouchDB?) — allow ${origin} in its dashboard`);
  }

  // A shared trainer login; only it (and the admin) may read or write the register database.
  if (cfg.trainerPassword) {
    const id = 'org.couchdb.user:' + cfg.trainerUser;
    const cur = await server('GET', '/_users/' + encodeURIComponent(id));
    const user = { _id: id, name: cfg.trainerUser, password: cfg.trainerPassword, roles: ['trainer'], type: 'user', ...(cur.status === 200 ? { _rev: cur.data._rev } : {}) };
    const r = await server('PUT', '/_users/' + encodeURIComponent(id), user);
    if (!okOr(r)) log(`Could not create the trainer login (${r.data.reason || r.status}) — on hosted CouchDB, create a login with read/write access instead`);
    else {
      const sec = await server('PUT', `/${encodeURIComponent(dbName)}/_security`,
        { admins: { names: [], roles: [] }, members: { names: [], roles: ['trainer'] } });
      log(okOr(sec) ? `Trainer login "${cfg.trainerUser}" is ready; the database is closed to everyone else`
        : `Trainer login created, but could not lock the database: ${sec.data.reason || sec.status}`);
    }
  } else log('TRAINER_PASSWORD not set — skipped creating the trainer login');
}

/* ---------------- Google Sheets ---------------- */
function makeSheets() {
  const opts = { version: 'v4' };
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  if (cfg.sheetsRootUrl) opts.rootUrl = cfg.sheetsRootUrl;
  else if (cfg.googleKeyJson.trim()) {
    let credentials;
    try { credentials = JSON.parse(cfg.googleKeyJson); } catch { fail('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON — paste the whole key file'); }
    if (!credentials.client_email || !credentials.private_key) fail('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email/private_key — use a service account JSON key');
    opts.auth = new googleAuth.GoogleAuth({ credentials, scopes });
  } else {
    if (!fs.existsSync(cfg.googleKeyFile)) fail(`Google key not found: set GOOGLE_SERVICE_ACCOUNT_JSON or put the key at ${cfg.googleKeyFile}`);
    opts.auth = new googleAuth.GoogleAuth({ keyFile: cfg.googleKeyFile, scopes });
  }
  return sheetsApi(opts);
}
const api = makeSheets();
const spreadsheetId = cfg.spreadsheetId;

async function ensureTabs() {
  const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const have = new Set((meta.data.sheets || []).map((s) => s.properties.title));
  const missing = Object.keys(TABS).filter((t) => !have.has(t));
  if (missing.length) {
    await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) } });
    log('Created tabs:', missing.join(', '));
  }
  const names = Object.keys(TABS);
  const res = await api.spreadsheets.values.batchGet({ spreadsheetId, ranges: names.map((n) => `${n}!1:1`) });
  const data = [];
  (res.data.valueRanges || []).forEach((vr, i) => {
    if (!vr.values || !vr.values.length || !vr.values[0].length) data.push({ range: `${names[i]}!A1`, values: [TABS[names[i]]] });
  });
  if (data.length) await api.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data } });
  return missing;
}

function rowsToObjects(values) {
  if (!values || values.length < 2) return [];
  const head = values[0].map((h) => String(h).trim());
  return values.slice(1)
    .filter((r) => r.some((v) => String(v ?? '').trim() !== ''))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] ?? '').trim()])));
}

/* ---------------- registers → Sheets ---------------- */
function sessionRows(doc, syncedAt) {
  const c = { P: 0, A: 0, L: 0, E: 0 };
  for (const v of Object.values(doc.marks || {})) if (c[v] !== undefined) c[v]++;
  const counted = c.P + c.L + c.A;
  const period = doc.periodLabel || PERIOD_LABEL[doc.period] || doc.period || '';
  const session = [
    doc._id, doc.date, doc.classCode, doc.className || '', doc.unitCode, doc.unitName || '', period,
    doc.trainerId || '', doc.trainerName || '', c.P, c.A, c.L, c.E, c.P + c.A + c.L + c.E,
    counted ? Math.round(((c.P + c.L) / counted) * 1000) / 10 : '',
    doc.notes || '', (doc.editLog || []).length, doc.deviceId || '', doc.createdAt || '', doc.updatedAt || '', syncedAt,
  ];
  const attendance = Object.entries(doc.marks || {})
    .filter(([, st]) => STATUS_LABEL[st])
    .map(([adm, st]) => [`${doc._id}|${adm}`, doc._id, doc.date, doc.classCode, doc.unitCode, doc.unitName || '', period,
      adm, (doc.names || {})[adm] || '', STATUS_LABEL[st], doc.trainerId || '', doc.trainerName || '', doc.updatedAt || '', syncedAt]);
  return { session, attendance };
}

async function writeSessions(docs) {
  if (!docs.length) return { added: 0, updated: 0, stale: 0, records: 0 };
  const updCol = col(TABS.Sessions.indexOf('UpdatedAt') + 1);
  const res = await api.spreadsheets.values.batchGet({
    spreadsheetId, ranges: ['Sessions!A:A', `Sessions!${updCol}:${updCol}`, 'Attendance!A:A'],
  });
  const [sKeys, sUpd, aKeys] = (res.data.valueRanges || []).map((vr) => vr.values || []);
  const sIndex = new Map(); sKeys.forEach((r, i) => { if (i > 0 && r[0]) sIndex.set(String(r[0]), i + 1); });
  const aIndex = new Map(); aKeys.forEach((r, i) => { if (i > 0 && r[0]) aIndex.set(String(r[0]), i + 1); });

  const syncedAt = nowISO();
  const updates = [], newSessions = [], newRecords = [];
  const out = { added: 0, updated: 0, stale: 0, records: 0 };
  const sLast = col(TABS.Sessions.length), aLast = col(TABS.Attendance.length);

  for (const doc of docs) {
    const row = sIndex.get(doc._id);
    const sheetUpdated = row ? String((sUpd[row - 1] || [])[0] || '') : '';
    // An older copy (from a device that was offline longer) never overwrites a newer one.
    if (row && sheetUpdated && sheetUpdated > String(doc.updatedAt || '')) { out.stale++; continue; }
    const { session, attendance } = sessionRows(doc, syncedAt);
    if (row) { updates.push({ range: `Sessions!A${row}:${sLast}${row}`, values: [session] }); out.updated++; }
    else { newSessions.push(session); out.added++; }
    for (const rec of attendance) {
      const r = aIndex.get(rec[0]);
      if (r) updates.push({ range: `Attendance!A${r}:${aLast}${r}`, values: [rec] });
      else newRecords.push(rec);
      out.records++;
    }
  }
  for (const part of chunk(updates, 400)) {
    await api.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: part } });
  }
  const append = (tab, values) => api.spreadsheets.values.append({
    spreadsheetId, range: `${tab}!A1`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values },
  });
  for (const part of chunk(newSessions, 2000)) await append('Sessions', part);
  for (const part of chunk(newRecords, 2000)) await append('Attendance', part);
  return out;
}

/* ---------------- class lists: Sheets → CouchDB ---------------- */
const inactive = /^(no|n|false|0|inactive|left|discontinued)$/i;

async function syncRoster() {
  const res = await api.spreadsheets.values.batchGet({ spreadsheetId, ranges: ['Classes!A:Z', 'Units!A:Z', 'Trainees!A:Z'] });
  const [cRows, uRows, tRows] = (res.data.valueRanges || []).map((vr) => rowsToObjects(vr.values));
  const want = { class: new Map(), unit: new Map(), trainee: new Map() };
  for (const r of cRows) if (r.ClassCode) want.class.set('class:' + r.ClassCode, { type: 'class', code: r.ClassCode, name: r.ClassName || r.ClassCode });
  for (const r of uRows) if (r.ClassCode && r.UnitCode) {
    want.unit.set(`unit:${r.ClassCode}:${r.UnitCode}`, { type: 'unit', classCode: r.ClassCode, code: r.UnitCode, name: r.UnitName || r.UnitCode });
  }
  for (const r of tRows) if (r.AdmNo && r.ClassCode) {
    want.trainee.set('trainee:' + r.AdmNo, { type: 'trainee', admNo: r.AdmNo, name: r.Name || r.AdmNo, classCode: r.ClassCode, active: !inactive.test(r.Active || '') });
    if (!want.class.has('class:' + r.ClassCode)) want.class.set('class:' + r.ClassCode, { type: 'class', code: r.ClassCode, name: r.ClassCode });
  }

  const docs = [];
  const counts = {};
  for (const kind of ['class', 'unit', 'trainee']) {
    const existing = await byPrefix(kind + ':');
    const byId = new Map(existing.map((d) => [d._id, d]));
    counts[kind] = want[kind].size;
    for (const [id, body] of want[kind]) {
      const old = byId.get(id);
      if (old) {
        const { _id, _rev, ...oldBody } = old;
        if (JSON.stringify(oldBody) === JSON.stringify(body)) continue;
        docs.push({ _id: id, _rev, ...body });
      } else docs.push({ _id: id, ...body });
    }
    // Safety: an empty tab (e.g. accidentally cleared) never wipes the class lists on every phone.
    if (want[kind].size === 0 && existing.length) { log(`Warning: no ${kind} rows found in Sheets — keeping the ${existing.length} already in CouchDB`); continue; }
    for (const old of existing) if (!want[kind].has(old._id)) docs.push({ _id: old._id, _rev: old._rev, _deleted: true });
  }
  if (docs.length) {
    const r = await couch('POST', '/_bulk_docs', { docs });
    const failed = r.filter((x) => x.error);
    if (failed.length) throw new Error(`${failed.length} roster records could not be saved: ${failed[0].reason || failed[0].error}`);
  }
  log(`Roster: ${counts.class} classes, ${counts.unit} units, ${counts.trainee} trainees (${docs.length} changes written to CouchDB)`);
  return { ...counts, changes: docs.length };
}

async function rosterJob(requestedAt) {
  try {
    const r = await syncRoster();
    await setStatus({ lastRoster: nowISO(), roster: r, rosterError: '', ...(requestedAt ? { rosterRequestHandled: requestedAt } : {}) });
  } catch (e) {
    log('Roster sync failed:', e.message);
    await setStatus({ rosterError: e.message, ...(requestedAt ? { rosterRequestHandled: requestedAt } : {}) });
  }
}

/* ---------------- change feed ---------------- */
async function handleResults(results) {
  const sessions = new Map();
  let rosterRequest = null;
  for (const r of results) {
    if (r.deleted || !r.doc) continue;
    if (r.doc.type === 'session') sessions.set(r.doc._id, r.doc);
    else if (r.id === ROSTER_CMD_ID && r.doc.requestedAt) rosterRequest = r.doc.requestedAt;
  }
  if (sessions.size) {
    const out = await writeSessions([...sessions.values()]);
    log(`Sheets: ${out.added} new and ${out.updated} updated registers, ${out.records} trainee records${out.stale ? `, ${out.stale} older copies ignored` : ''}`);
    const st = (await getDoc(STATUS_ID)) || {};
    await setStatus({ lastSheetsWrite: nowISO(), lastBatch: out, sheetsError: '', registersWritten: (st.registersWritten || 0) + out.added + out.updated });
  }
  if (rosterRequest) {
    const st = (await getDoc(STATUS_ID)) || {};
    if (String(rosterRequest) > String(st.rosterRequestHandled || '')) await rosterJob(rosterRequest);
  }
}

async function fetchChanges(since, longpoll) {
  const q = { since, include_docs: 'true', limit: '500' };
  if (longpoll) { q.feed = 'longpoll'; q.timeout = '50000'; }
  return couch('GET', '/_changes', undefined, q, 65000);
}

async function processPending() {
  let since = await loadCheckpoint();
  for (;;) {
    const data = await fetchChanges(since, false);
    if (!data.results.length) return since;
    await handleResults(data.results);
    since = data.last_seq;
    await saveCheckpoint(since);
  }
}

async function followForever() {
  let since = await loadCheckpoint();
  let backoff = 2000;
  for (;;) {
    try {
      const data = await fetchChanges(since, true);
      let results = data.results || [];
      let last = data.last_seq ?? since;
      if (results.length) {
        // Give phones that come online together a moment, then write everything in one go.
        await sleep(cfg.batchDelayMs);
        for (;;) {
          const more = await fetchChanges(last, false);
          if (!more.results.length) break;
          results = results.concat(more.results);
          last = more.last_seq;
        }
        await exclusive(() => handleResults(results));
        await saveCheckpoint(last);
      }
      since = last;
      backoff = 2000;
    } catch (e) {
      log('Error:', e.message, `— retrying in ${Math.round(backoff / 1000)}s`);
      await setStatus({ sheetsError: e.message, lastErrorAt: nowISO() });
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 120000);
    }
  }
}

/* ---------------- main ---------------- */
async function rosterRequestPending() {
  const [cmd, st] = await Promise.all([getDoc(ROSTER_CMD_ID), getDoc(STATUS_ID)]);
  return cmd?.requestedAt && String(cmd.requestedAt) > String(st?.rosterRequestHandled || '') ? cmd.requestedAt : null;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--setup')) {
    await setupCouch();
    const created = await ensureTabs();
    if (!created.length) log('Sheet tabs already exist');
    log('Setup done. Fill in the Classes, Units and Trainees tabs; phones get them on the next sync.');
    return;
  }
  const info = await couch('GET', '');
  log(`CouchDB database "${info.db_name}" — ${info.doc_count} documents`);
  await ensureTabs();

  if (args.has('--roster')) { await rosterJob(await rosterRequestPending()); return; }
  if (args.has('--watch')) {
    await exclusive(() => rosterJob());
    if (cfg.rosterEveryMinutes > 0) setInterval(() => exclusive(() => rosterJob()), cfg.rosterEveryMinutes * 60000);
    log('Watching CouchDB for registers…');
    await followForever();
    return;
  }
  // Default (--sync): one full pass, made for a scheduled GitHub Action.
  await rosterJob(await rosterRequestPending());
  await processPending();
  log('Sync complete.');
}

main().catch((e) => { log('Failed:', e.message); process.exit(1); });
