/**
 * RVNP Attendance Register — Cloudflare Worker + D1 database (ICT Department).
 *
 * Same requests and replies as apps-script/Code.gs, so the phones work with either server.
 *
 * Set up (Cloudflare dashboard only, free plan, no card):
 *   1. Storage & Databases → D1 → Create database, name it rvnp-attendance.
 *   2. Workers & Pages → Create → Worker → name it rvnp-attendance → Deploy → Edit code:
 *      replace everything with this file → Deploy.
 *   3. The Worker → Settings → Bindings → Add → D1 database: variable name DB, database rvnp-attendance.
 *   4. The Worker → Settings → Variables and Secrets → Add → Secret: ADMIN_PIN = a 6-digit PIN of your choice.
 *      The first sign-in is staff code MIS with that PIN; you then choose your own PIN.
 * The tables are created automatically on the first request. To update later: Edit code, paste, Deploy.
 *
 * Who can do what: TRAINER marks and adds students (pending); HOD approves term registers and sees every
 * class; MIS sets up terms, uploads loading and class lists, approves students and manages staff.
 */

export const VERSION = '7.17.0';
const SCHEMA_VERSION = '20';
const WINDOW_SECONDS = 20;   // how often the lesson QR changes — must match QR_WINDOW in app.js
const CODE_LENGTH = 10;
const TERM_WEEKS = 12;       // every term has 12 teaching weeks (the register template has 12 week blocks)
const STATUS_CODE = { Present: 'P', Absent: 'A', Late: 'L', Excused: 'E' };
// IAO: Internal Assessment Officer (reads all evidence and registers; panels). EAO: External Assessment Officer (a visitor
// account with an end date; sees only the verification work given to them).
const ROLES = ['TRAINER', 'HOD', 'MIS', 'IAO', 'EAO'];
const GONE = "('withdrawn','rejected','inactive')";

// One statement per line (D1 exec runs them in order).
const SCHEMA = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS staff (code TEXT PRIMARY KEY COLLATE NOCASE, name TEXT, roles TEXT, responsibility TEXT, active INTEGER DEFAULT 1, pin_hash TEXT, pin_salt TEXT, pin_version INTEGER DEFAULT 0, must_change INTEGER DEFAULT 1, late_pct INTEGER, excused_pct INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS login_fails (code TEXT PRIMARY KEY COLLATE NOCASE, fails INTEGER, until TEXT);
CREATE TABLE IF NOT EXISTS terms (id TEXT PRIMARY KEY, name TEXT, duration TEXT, start_date TEXT, weeks INTEGER, breaks TEXT, status TEXT, updated_at TEXT, cat_weeks TEXT);
CREATE TABLE IF NOT EXISTS classes (code TEXT PRIMARY KEY, name TEXT, level TEXT, mis_class TEXT, population INTEGER);
CREATE TABLE IF NOT EXISTS units (class_code TEXT, code TEXT, name TEXT, PRIMARY KEY (class_code, code));
CREATE TABLE IF NOT EXISTS loading (term_id TEXT, class_code TEXT, unit_code TEXT, unit_name TEXT, trainer_code TEXT COLLATE NOCASE, trainer_name TEXT, lessons_per_week REAL, hours_per_week REAL, population INTEGER, updated_at TEXT, joint TEXT, PRIMARY KEY (term_id, class_code, unit_code));
CREATE TABLE IF NOT EXISTS trainees (adm_no TEXT PRIMARY KEY COLLATE NOCASE, name TEXT, class_code TEXT, status TEXT DEFAULT 'active', mis_class TEXT, added_by TEXT, added_at TEXT, updated_by TEXT, updated_at TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS trainees_class ON trainees (class_code);
CREATE INDEX IF NOT EXISTS trainees_mis ON trainees (mis_class);
CREATE INDEX IF NOT EXISTS classes_mis ON classes (mis_class);
CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, adm_no TEXT, name TEXT, class_code TEXT, reason TEXT, requested_by TEXT, requested_name TEXT, requested_at TEXT, status TEXT, decided_by TEXT, decided_at TEXT, merged_into TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, date TEXT, class_code TEXT, unit_code TEXT, unit_name TEXT, period TEXT, trainer_id TEXT, trainer_name TEXT, present INTEGER, absent INTEGER, late INTEGER, excused INTEGER, total INTEGER, pct REAL, updated_at TEXT, synced_at TEXT, term_id TEXT, week INTEGER, data TEXT, kind TEXT, slots INTEGER);
CREATE INDEX IF NOT EXISTS sessions_cu ON sessions (class_code, unit_code, date);
CREATE TABLE IF NOT EXISTS checkins (session_id TEXT, adm_no TEXT, device_id TEXT, name TEXT, w TEXT, code TEXT, scanned_at TEXT, updated_at TEXT, status TEXT, reason TEXT, PRIMARY KEY (session_id, adm_no, device_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS checkins_updated ON checkins (updated_at);
CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY, adm_no TEXT COLLATE NOCASE, name TEXT, class_code TEXT, registered_at TEXT, last_seen TEXT);
CREATE INDEX IF NOT EXISTS devices_adm ON devices (adm_no);
CREATE TABLE IF NOT EXISTS signoffs (id TEXT PRIMARY KEY, term_id TEXT, class_code TEXT, unit_code TEXT, unit_name TEXT, trainer_code TEXT, trainer_name TEXT, lecturer_comment TEXT, submitted_at TEXT, status TEXT, hod_code TEXT, hod_name TEXT, hod_comment TEXT, decided_at TEXT);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, staff_code TEXT, name TEXT, action TEXT, details TEXT);
CREATE INDEX IF NOT EXISTS sessions_synced ON sessions (synced_at);
CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, adm_no TEXT COLLATE NOCASE, name TEXT, class_code TEXT, unit_code TEXT, unit_name TEXT, item TEXT, version INTEGER, file_id TEXT, file_name TEXT, bytes INTEGER, pages INTEGER, submitted_at TEXT, status TEXT, decided_by TEXT, decided_name TEXT, decided_at TEXT, comment TEXT, received_at TEXT, updated_at TEXT, seen_at TEXT);
CREATE INDEX IF NOT EXISTS evidence_adm ON evidence (adm_no, unit_code, item);
CREATE INDEX IF NOT EXISTS evidence_cu ON evidence (class_code, unit_code);
CREATE INDEX IF NOT EXISTS evidence_upd ON evidence (updated_at);
CREATE INDEX IF NOT EXISTS evidence_status ON evidence (status, submitted_at);
CREATE INDEX IF NOT EXISTS evidence_sub ON evidence (submitted_at);
CREATE TABLE IF NOT EXISTS marks (term_id TEXT, class_code TEXT, unit_code TEXT, adm_no TEXT COLLATE NOCASE, cat1 REAL, cat2 REAL, cat3 REAL, prac1 REAL, prac2 REAL, prac3 REAL, updated_at TEXT, updated_by TEXT, synced_at TEXT, PRIMARY KEY (term_id, class_code, unit_code, adm_no));
CREATE INDEX IF NOT EXISTS marks_synced ON marks (synced_at);
CREATE TABLE IF NOT EXISTS unit_marks (class_code TEXT, unit_code TEXT, adm_no TEXT COLLATE NOCASE, cat1 REAL, cat2 REAL, cat3 REAL, prac1 REAL, prac2 REAL, prac3 REAL, meta TEXT, updated_at TEXT, updated_by TEXT, synced_at TEXT, PRIMARY KEY (class_code, unit_code, adm_no));
CREATE INDEX IF NOT EXISTS unit_marks_synced ON unit_marks (synced_at);
CREATE TABLE IF NOT EXISTS unlocks (term_id TEXT, class_code TEXT, unit_code TEXT, by_code TEXT, by_name TEXT, at TEXT, until TEXT, PRIMARY KEY (term_id, class_code, unit_code));
CREATE INDEX IF NOT EXISTS sessions_trainer ON sessions (trainer_id, synced_at, id);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, adm_no TEXT COLLATE NOCASE, device_id TEXT, created_at TEXT, last_ok_at TEXT, fail_count INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS push_adm ON push_subs (adm_no);
CREATE TABLE IF NOT EXISTS panels (id TEXT PRIMARY KEY, term_id TEXT, name TEXT, chair TEXT, members TEXT, status TEXT, note TEXT, created_by TEXT, created_at TEXT, decided_by TEXT, decided_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY, panel_id TEXT, class_code TEXT, unit_code TEXT, unit_name TEXT, trainer_code TEXT, trainer_name TEXT, verifier TEXT, external TEXT, population INTEGER, risk REAL, size INTEGER, seed TEXT, sample TEXT, reasons TEXT, round INTEGER DEFAULT 1, status TEXT, result TEXT, actions TEXT, response TEXT, responded_at TEXT, submitted_at TEXT, signed_by TEXT, signed_at TEXT, ext_result TEXT, ext_note TEXT, ext_at TEXT, log TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS verifications_panel ON verifications (panel_id);
CREATE TABLE IF NOT EXISTS approvals (ref TEXT PRIMARY KEY, kind TEXT, subject TEXT, title TEXT, info TEXT, fingerprint TEXT, by_code TEXT, by_name TEXT, by_role TEXT, at TEXT, sig TEXT, status TEXT, replaced_by TEXT);
CREATE INDEX IF NOT EXISTS approvals_subject ON approvals (kind, subject);
CREATE TABLE IF NOT EXISTS marksheets (id TEXT PRIMARY KEY, class_code TEXT, unit_code TEXT, unit_name TEXT, status TEXT, prepared_code TEXT, prepared_name TEXT, prepared_at TEXT, received_code TEXT, received_name TEXT, received_at TEXT, approved_code TEXT, approved_name TEXT, approved_at TEXT, comment TEXT, approval_ref TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS enrolments (term_id TEXT, adm_no TEXT COLLATE NOCASE, class_code TEXT, status TEXT, at TEXT, PRIMARY KEY (term_id, adm_no));
CREATE TABLE IF NOT EXISTS verify_list (term_id TEXT, class_code TEXT, unit_code TEXT, unit_name TEXT, trainer_code TEXT, trainer_name TEXT, students INTEGER, added_by TEXT, added_at TEXT, PRIMARY KEY (term_id, class_code, unit_code));
CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, at TEXT, by_code TEXT, by_name TEXT, title TEXT, body TEXT, audience TEXT, channels TEXT, staff TEXT, students TEXT, groups TEXT, counts TEXT);
CREATE INDEX IF NOT EXISTS notices_at ON notices (at);
CREATE TABLE IF NOT EXISTS notice_reads (notice_id TEXT, who TEXT COLLATE NOCASE, at TEXT, PRIMARY KEY (notice_id, who));
CREATE TABLE IF NOT EXISTS mail_groups (key TEXT PRIMARY KEY, email TEXT, name TEXT, group_name TEXT, added TEXT, want_hash TEXT, synced_at TEXT, error TEXT, failed TEXT);
CREATE TABLE IF NOT EXISTS mail_out (id TEXT PRIMARY KEY, notice_id TEXT, bcc TEXT, reply_to TEXT, subject TEXT, body TEXT, status TEXT, tries INTEGER DEFAULT 0, error TEXT, at TEXT, sent_at TEXT);
CREATE TABLE IF NOT EXISTS verify_checks (verification_id TEXT, adm_no TEXT COLLATE NOCASE, who TEXT, valid INTEGER, authentic INTEGER, current INTEGER, sufficient INTEGER, agree INTEGER, comment TEXT, by_code TEXT, at TEXT, PRIMARY KEY (verification_id, adm_no, who));`;

const MIGRATIONS = ['ALTER TABLE terms ADD COLUMN cat_weeks TEXT', 'ALTER TABLE sessions ADD COLUMN kind TEXT', 'ALTER TABLE sessions ADD COLUMN slots INTEGER',
  'ALTER TABLE staff ADD COLUMN drive_folder TEXT', 'ALTER TABLE trainees ADD COLUMN reg_code TEXT', 'ALTER TABLE terms ADD COLUMN series TEXT',
  'ALTER TABLE evidence ADD COLUMN seen_at TEXT', 'ALTER TABLE classes ADD COLUMN status TEXT', 'ALTER TABLE classes ADD COLUMN archived_at TEXT',
  'ALTER TABLE classes ADD COLUMN archived_by TEXT', 'ALTER TABLE terms ADD COLUMN lesson_hours REAL',
  // Evidence kept in the student's own Google Drive (source 'drive'), checked by its fingerprint (md5).
  'ALTER TABLE staff ADD COLUMN email TEXT', 'ALTER TABLE trainees ADD COLUMN email TEXT', 'ALTER TABLE evidence ADD COLUMN source TEXT',
  'ALTER TABLE evidence ADD COLUMN owner_email TEXT', 'ALTER TABLE evidence ADD COLUMN md5 TEXT', 'ALTER TABLE evidence ADD COLUMN modified_at TEXT',
  'ALTER TABLE evidence ADD COLUMN shared TEXT', 'ALTER TABLE evidence ADD COLUMN changed_at TEXT',
  // The backup copy of an approved document in the backup account's Drive.
  'ALTER TABLE evidence ADD COLUMN archived_at TEXT', 'ALTER TABLE evidence ADD COLUMN archive_id TEXT', 'ALTER TABLE evidence ADD COLUMN archive_tries INTEGER',
  'ALTER TABLE evidence ADD COLUMN archive_error TEXT',
  // Classes taught one unit together ("ICT L6ICT-26J, ICT L6ICT-26M-CT" in the loading): each class's row names them all.
  'ALTER TABLE loading ADD COLUMN joint TEXT',
  // An External Assessment Officer's account stops working after this date.
  'ALTER TABLE staff ADD COLUMN ends_on TEXT',
  // A class representative (in the class reps' email group).
  'ALTER TABLE trainees ADD COLUMN rep INTEGER',
  // The approval (stamp, name and QR on the outputs) of an approved register or piece of evidence.
  'ALTER TABLE signoffs ADD COLUMN approval_ref TEXT', 'ALTER TABLE evidence ADD COLUMN approval_ref TEXT',
  // Two verifiers for each class-unit, each with their own result; the external officer's own sample.
  'ALTER TABLE verifications ADD COLUMN verifier2 TEXT', 'ALTER TABLE verifications ADD COLUMN v1_result TEXT', 'ALTER TABLE verifications ADD COLUMN v1_actions TEXT',
  'ALTER TABLE verifications ADD COLUMN v1_at TEXT', 'ALTER TABLE verifications ADD COLUMN v2_result TEXT', 'ALTER TABLE verifications ADD COLUMN v2_actions TEXT',
  'ALTER TABLE verifications ADD COLUMN v2_at TEXT', 'ALTER TABLE verifications ADD COLUMN ext_sample TEXT',
  // Panels are numbered; the name follows ("Term 3 2026 - Panel 1").
  'ALTER TABLE panels ADD COLUMN number INTEGER',
  // Google connected once: the long-lived permission Google gives (kept encrypted), so nobody signs in again.
  'ALTER TABLE trainees ADD COLUMN g_refresh TEXT', 'ALTER TABLE staff ADD COLUMN g_refresh TEXT'];
/* Data moved once when the schema version changes (each is one statement, safe to run again). */
const MARK_CELLS = ['cat1', 'cat2', 'cat3', 'prac1', 'prac2', 'prac3'];
const SAME_ROW = 'x.class_code=m.class_code AND x.unit_code=m.unit_code AND x.adm_no=m.adm_no';
const DATA_MIGRATIONS = [
  // Marks used to be kept per term; a unit now has one marksheet for its whole life. Each cell keeps the
  // newest value it had in any term, and remembers the term it was entered in (for the end-of-term lock).
  `INSERT OR IGNORE INTO unit_marks (class_code, unit_code, adm_no, ${MARK_CELLS.join(', ')}, meta, updated_at, updated_by, synced_at)
   SELECT m.class_code, m.unit_code, m.adm_no,
   ${MARK_CELLS.map((c) => `(SELECT x.${c} FROM marks x WHERE ${SAME_ROW} AND x.${c} IS NOT NULL ORDER BY x.updated_at DESC LIMIT 1)`).join(', ')},
   json_object(${MARK_CELLS.map((c) => `'${c}', json((SELECT json_object('term', x.term_id, 'by', x.updated_by, 'at', x.updated_at) FROM marks x WHERE ${SAME_ROW} AND x.${c} IS NOT NULL ORDER BY x.updated_at DESC LIMIT 1))`).join(', ')}),
   MAX(m.updated_at), (SELECT x.updated_by FROM marks x WHERE ${SAME_ROW} ORDER BY x.updated_at DESC LIMIT 1), MAX(m.synced_at)
   FROM marks m GROUP BY m.class_code, m.unit_code, m.adm_no`,
];

/* ---------- small helpers ---------- */
const nowIso = () => new Date().toISOString();
const todayIso = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // Africa/Nairobi
const lower = (s) => String(s ?? '').trim().toLowerCase();
class Fail extends Error { constructor(message, extra) { super(message); Object.assign(this, extra || {}); } }
const fail = (message, extra) => { throw new Fail(message, extra); };
const rolesList = (roles) => { const have = String(roles || '').toUpperCase().split(/[\s,;]+/); return ROLES.filter((r) => have.includes(r)); };
const hasRole = (roles, role) => rolesList(roles).includes(role);
const levelOf = (code) => { const m = /L(\d)/i.exec(String(code)); return m ? m[1] : ''; };
const classFromSession = (id) => String(id).split(':')[2] || '';
/** Streams of one class differ only in a last letter ("ICT L6CS-26S-A" / "-B", "ICT L6CS-25SA" / "SB"): the shared part, or null. */
const streamBase = (code) => { const m = /^(.*\d{2}-?[A-Z])-?([A-H])$/.exec(String(code || '')); return m ? m[1].replace(/-$/, '') : null; };
const unitFromSession = (id) => String(id).split(':')[3] || '';
/** The loading's two ways of joining classes: "ICT L5LIS-26S/L6LIM-26S" is one class taught together for every unit;
 * "ICT L6ICT-26J, ICT L6ICT-26M-CT" is two classes taught together for that one unit. jointParts gives the classes of the second. */
export function jointParts(code) {
  const parts = String(code || '').split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const prefix = (parts[0].match(/^([A-Z]+)\s/) || [])[1];
  return [...new Set(parts.map((x) => (prefix && !/\s/.test(x) ? `${prefix} ${x}` : x)))];
}
/** A combined lesson ("ICT L6ICT-26J, ICT L6ICT-26M-CT") belongs to each class it names. */
export function classParts(code) {
  const parts = String(code).split(/\s*[,/]\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [code];
  const prefix = (parts[0].match(/^([A-Z]+)\s/) || [])[1];
  return [code, ...parts.map((x) => (prefix && !/\s/.test(x) ? `${prefix} ${x}` : x))];
}
// "inactive": the term ended and the student is not on a class list for the new term yet (the list's upload brings them back).
const active = (t) => t && !['withdrawn', 'rejected', 'inactive'].includes(String(t.status || 'active').toLowerCase());
const JSONH = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const reply = (obj) => new Response(JSON.stringify(obj), { headers: JSONH });

/* ---------- database helpers ---------- */
const q = (env, sql, ...p) => env.DB.prepare(sql).bind(...p);
const all = async (env, sql, ...p) => (await q(env, sql, ...p).all()).results || [];
const one = (env, sql, ...p) => q(env, sql, ...p).first();
const run = (env, sql, ...p) => q(env, sql, ...p).run();
const IN = '(SELECT value FROM json_each(?))';
/** Several statements in ONE trip to the database (each item: [sql, ...params]); returns each one's rows. */
async function many(env, ...items) {
  items = items.filter(Boolean);
  if (!items.length) return [];
  const res = await env.DB.batch(items.map(([sql, ...p]) => env.DB.prepare(sql).bind(...p)));
  return res.map((r) => r.results || []);
}
const ACTIVE_TERM = "(SELECT id FROM terms WHERE status='active' ORDER BY updated_at DESC LIMIT 1)";

/** Statements that insert or update many rows, one per ~900 KB (well under D1's 2 MB value limit). */
/* Names are shown with each word starting with a capital letter ("JOHN KAMAU" -> "John Kamau"); short forms like ICT stay. */
const KEEP_UPPER = new Set(['ICT', 'IT', 'CAT', 'POE', 'HOD', 'MIS', 'PC', 'CCTV', 'HTML', 'CSS', 'SQL', 'PHP', 'ID', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI', 'XII',
  'AI', 'IOT', 'LAN', 'WAN', 'UI', 'UX', 'OS', 'CAD', 'GIS', 'KCSE', 'TVET', 'CDACC', 'RVNP', 'ICDL', 'DTP', 'ERP', 'GPS', 'API', 'CBET', 'KNEC', 'NITA', 'ICTS']);
const nameCase = (s) => (s === null || s === undefined ? s : String(s).replace(/\s+/g, ' ').trim().toLowerCase()
  .replace(/(^|[\s\-'’(./])([a-z])/g, (m, p, c) => p + c.toUpperCase())
  .split(' ').map((w) => (KEEP_UPPER.has(w.toUpperCase().replace(/[^A-Z]/g, '')) ? w.toUpperCase() : w)).join(' '));
const NAME_COLS = { trainees: ['name'], staff: ['name'], requests: ['name', 'requested_name'], loading: ['unit_name', 'trainer_name'], units: ['name'] };
function upsertStmts(table, cols, rows, key, update = cols.filter((c) => !(key || []).includes(c))) {
  const named = (NAME_COLS[table] || []).filter((c) => cols.includes(c));
  if (named.length) rows = rows.map((r) => { const o = { ...r }; for (const c of named) o[c] = nameCase(o[c]); return o; });
  const conflict = key ? ` ON CONFLICT(${key.join(',')}) DO ${update.length ? 'UPDATE SET ' + update.map((c) => `${c}=excluded.${c}`).join(',') : 'NOTHING'}` : '';
  const sql = `INSERT INTO ${table} (${cols.join(',')}) SELECT ${cols.map((_, j) => `json_extract(value,'$[${j}]')`).join(',')} FROM json_each(?) WHERE true${conflict}`;
  const out = [];
  let part = [], size = 2;
  const flush = () => { if (part.length) out.push([sql, '[' + part.join(',') + ']']); part = []; size = 2; };
  for (const r of rows) {
    const item = JSON.stringify(cols.map((c) => (r[c] === undefined ? null : r[c])));
    if (size + item.length > 900000) flush();
    part.push(item); size += item.length + 1;
  }
  flush();
  return out;
}
const upsertMany = (env, ...a) => many(env, ...upsertStmts(...a));

let schemaReady = false;
async function ready(env) {
  if (schemaReady) return;
  try {
    const r = await one(env, "SELECT value FROM meta WHERE key='schema'");
    if (r && r.value === SCHEMA_VERSION) { schemaReady = true; return; }
  } catch { /* first run: no tables yet */ }
  await env.DB.exec(SCHEMA);
  // Columns added after a database was first created (fail harmlessly when already there).
  for (const sql of MIGRATIONS) { try { await env.DB.exec(sql); } catch { /* column exists */ } }
  for (const sql of DATA_MIGRATIONS) { try { await env.DB.prepare(sql).run(); } catch (e) { console.error('data migration', e); } }
  try { await caseNames(env); } catch (e) { console.error('names', e); }
  await setMeta(env, 'schema', SCHEMA_VERSION);
  schemaReady = true;
}
/** Once: names already in the database get a capital letter at the start of each word. */
const CASE_COLS = [['trainees', 'name'], ['staff', 'name'], ['requests', 'name'], ['requests', 'requested_name'], ['loading', 'unit_name'], ['loading', 'trainer_name'],
  ['units', 'name'], ['evidence', 'name'], ['evidence', 'decided_name'], ['signoffs', 'trainer_name'], ['signoffs', 'hod_name'], ['signoffs', 'unit_name'], ['devices', 'name'],
  ['sessions', 'trainer_name'], ['sessions', 'unit_name'], ['verifications', 'trainer_name'], ['verifications', 'unit_name'], ['notices', 'by_name'], ['approvals', 'by_name']];
async function caseNames(env) {
  if (await getMeta(env, 'names_cased')) return;
  for (const [t, c] of CASE_COLS) {
    const rows = await all(env, `SELECT rowid AS k, ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL AND ${c} <> ''`);
    const changed = rows.map((r) => ({ k: r.k, v: nameCase(r.v) })).filter((r, i) => r.v !== rows[i].v);
    for (let i = 0; i < changed.length; i += 500) {
      const part = JSON.stringify(changed.slice(i, i + 500));
      await run(env, `UPDATE ${t} SET ${c} = (SELECT json_extract(value,'$.v') FROM json_each(?1) WHERE json_extract(value,'$.k') = ${t}.rowid) WHERE rowid IN (SELECT json_extract(value,'$.k') FROM json_each(?1))`, part);
    }
  }
  await setMeta(env, 'names_cased', nowIso());
  await bumpRoster(env);   // staff phones fetch the lists again
}
const getMeta = async (env, key) => (await one(env, 'SELECT value FROM meta WHERE key=?', key))?.value ?? null;
const metaStmt = (key, value) => ['INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)];
const setMeta = (env, key, value) => many(env, metaStmt(key, value));
const changedStmt = () => metaStmt('last_change', nowIso());
const markChanged = (env) => many(env, changedStmt());
const bumpRoster = (env) => setMeta(env, 'roster_v', nowIso() + '#' + Math.random().toString(36).slice(2, 6));
const catWeeksOf = (v) => [...new Set(String(v || '').split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= TERM_WEEKS))].sort((a, b) => a - b);
const termOut = (r) => (r ? { id: r.id, name: r.name, duration: r.duration, startDate: r.start_date, weeks: TERM_WEEKS, breaks: String(r.breaks || '').split(/[\s,;]+/).filter(Boolean),
  catWeeks: catWeeksOf(r.cat_weeks), series: r.series || '', lessonHours: Number(r.lesson_hours) || null } : null);
async function audit(env, me, action, details) {
  await run(env, 'INSERT INTO audit (at,staff_code,name,action,details) VALUES (?,?,?,?,?)', nowIso(), me.code, me.name, action, String(details || '').slice(0, 2000));
}

/* ---------- crypto ---------- */
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const keys = new Map();
async function hmacHex(msg, secret) {
  let k = keys.get(secret);
  if (!k) { k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); keys.set(secret, k); }
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const randomPin = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b % 10).join('');
let secretCache = null;
async function authSecret(env) {
  if (secretCache) return secretCache;
  // Created once: if two requests race on a new database, both end up with the one that was stored first.
  const [, rows] = await many(env, ["INSERT INTO meta (key,value) VALUES ('auth_secret',?) ON CONFLICT(key) DO NOTHING", crypto.randomUUID() + crypto.randomUUID()],
    ["SELECT value FROM meta WHERE key='auth_secret'"]);
  return (secretCache = rows[0].value);
}

/* ---------- web requests ---------- */
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' } });
    try {
      if (!env.DB) fail('The database is not connected: add a D1 binding called DB to this Worker (Settings → Bindings).');
      await ready(env);
      if (request.method === 'GET') {
        const p = Object.fromEntries(new URL(request.url).searchParams);
        if (p.action === 'classes') return reply(await publicClasses(env));
        if (p.action === 'check') return reply(await checkApproval(env, p.ref));
        if (p.action === 'classlist') return reply(await classList(env, p.class));
        if (p.action === 'units') return reply(await classUnits(env, p.class));
        if (p.action === 'ping') return reply({ ok: true, version: VERSION, server: 'cloudflare', time: nowIso(), push: !!env.VAPID_PRIVATE_KEY, googleConnect: googleReady(env) });
        return reply({ ok: false, error: 'Unknown action' });
      }
      const b = JSON.parse((await request.text()) || '{}');
      if (b.action === 'checkin') return reply(await receiveCheckins(env, b.checkins || []));
      if (b.action === 'register') return reply(await registerDevice(env, b));
      if (b.action === 'login') return reply(await login(env, b));
      // After a change the Drive bridge cares about, poke it (never from the bridge's own requests: no loops).
      const nudge = () => { if (ctx?.waitUntil && NUDGE_ACTIONS.has(b.action)) ctx.waitUntil(nudgeDrive(env).catch((e) => console.error('nudge', e))); };
      // Student phones (checked against their registration) and the Drive bridge (signed with BRIDGE_SECRET).
      if (STUDENT_ACTIONS[b.action]) { const out = await STUDENT_ACTIONS[b.action](env, b, ctx); nudge(); return reply(out); }
      if (BRIDGE_ACTIONS[b.action]) return reply(await BRIDGE_ACTIONS[b.action](env, b));
      const h = ACTIONS[b.action];
      // The sign-in check and the action's first reads go to the database together, in one trip.
      const [me, pre] = await auth(env, b.auth, h && h.pre ? h.pre(b) : []);
      if (!h) return reply({ ok: false, error: 'Unknown action' });
      if (h.role && !me.roles.some((r) => h.role.includes(r))) fail(`This needs the ${h.role.join(' or ')} role. Ask the MIS Officer.`);
      if (me.mustChange && b.action !== 'setPin') fail('Choose a new PIN first', { mustChange: true });
      const out = await h.fn(env, b, me, pre, ctx);
      nudge();
      if (b.action === 'roster' && ctx?.waitUntil) ctx.waitUntil(foldOldCheckins(env).catch((e) => console.error('fold', e)));
      return reply(out);
    } catch (err) {
      const out = { ok: false, error: String(err && err.message || err) };
      if (err && err.authError) out.authError = true;
      if (err && err.mustChange) out.mustChange = true;
      if (err && err.needPin) out.needPin = true;
      if (!(err instanceof Fail)) console.error(err);
      return reply(out);
    }
  },
};

const ACTIONS = {
  setPin: { fn: (env, b, me) => setPin(env, b, me) },
  me: { fn: async (env, b, me) => ({ ok: true, staff: me }) },
  roster: { fn: (env, b, me, pre) => readRoster(env, b, me, pre) },
  pulse: { fn: async (env, b, me, pre) => ({ ok: true, last: pre.meta.last_change || '' }) },
  push: { role: ['TRAINER', 'HOD'], pre: (b) => pushPre(b.sessions || []), fn: (env, b, me, pre) => pushSessions(env, b.sessions || [], me, pre) },
  mySessions: { role: ['TRAINER', 'HOD'], fn: (env, b, me) => mySessions(env, b, me) },
  checkins: { role: ['TRAINER', 'HOD'], pre: (b) => [checkinsQuery(b.sessionIds || [], b.since || '')], fn: (env, b, me, pre) => acceptedCheckins(b.sessionIds || [], pre.rows[0]) },
  addStudents: { role: ['TRAINER', 'HOD'], fn: (env, b, me) => addStudents(env, b.students || [], me) },
  mySettings: { fn: (env, b, me) => saveMySettings(env, b, me) },
  report: { pre: (b) => reportPre(b), fn: (env, b, me, pre) => reportData(env, b, me, pre) },
  submitSignoff: { role: ['TRAINER', 'HOD'], fn: (env, b, me) => submitSignoff(env, b, me) },
  signoffs: { fn: (env, b, me) => listSignoffs(env, b, me) },
  decideSignoff: { role: ['HOD'], fn: (env, b, me) => decideSignoff(env, b, me) },
  decideSignoffs: { role: ['HOD'], fn: (env, b, me) => decideSignoffs(env, b, me) },
  overview: { role: ['HOD', 'MIS'], pre: (b) => overviewPre(b), fn: (env, b, me, pre) => overview(pre) },
  termUnits: { fn: (env, b, me) => termUnits(env, b, me) },
  unlock: { role: ['HOD', 'MIS'], fn: (env, b, me) => setUnlock(env, b, me, true) },
  relock: { role: ['HOD', 'MIS'], fn: (env, b, me) => setUnlock(env, b, me, false) },
  archiveClasses: { role: ['MIS'], fn: (env, b, me) => archiveClasses(env, b, me) },
  classExport: { role: ['MIS'], fn: (env, b, me) => classExport(env, b, me) },
  deleteClasses: { role: ['MIS'], fn: (env, b, me) => deleteClasses(env, b, me) },
  saveTerm: { role: ['MIS'], fn: (env, b, me) => saveTerm(env, b, me) },
  uploadLoading: { role: ['MIS'], fn: (env, b, me) => uploadLoading(env, b, me) },
  importClassList: { role: ['MIS'], fn: (env, b, me) => importClassList(env, b, me) },
  students: { role: ['MIS', 'HOD'], fn: (env, b) => studentsOf(env, b.misClass || '', b.classCode || '') },
  updateStudent: { role: ['MIS'], fn: (env, b, me) => updateStudent(env, b, me) },
  phones: { role: ['HOD', 'MIS'], fn: (env) => listPhones(env) },
  resetPhone: { role: ['HOD', 'MIS'], fn: (env, b, me) => resetPhone(env, b, me) },
  requests: { role: ['MIS', 'HOD'], fn: (env) => listRequests(env) },
  decideRequest: { role: ['MIS', 'HOD'], fn: (env, b, me) => decideRequest(env, b, me) },
  staff: { role: ['MIS'], fn: (env) => listStaff(env) },
  updateStaff: { role: ['MIS'], fn: (env, b, me) => updateStaff(env, b, me) },
  poeList: { fn: (env, b, me) => poeList(env, b, me) },
  poeView: { fn: (env, b, me) => poeView(env, b, me) },
  poeChanged: { fn: (env, b, me) => poeChanged(env, b, me) },
  setGoogle: { fn: (env, b, me) => setGoogle(env, b, me) },
  googleConnect: { fn: (env, b, me) => googleConnect(env, 'staff', me.code, b.code) },
  googleToken: { fn: (env, b, me) => googleToken(env, 'staff', me.code) },
  setArchiveEmail: { role: ['MIS'], fn: (env, b, me) => setArchiveEmail(env, b, me) },
  backupStatus: { role: ['MIS', 'HOD'], fn: (env) => backupStatus(env) },
  setBackup: { role: ['MIS', 'HOD'], fn: (env, b, me) => setBackup(env, b, me) },
  poeDecide: { role: ['TRAINER', 'HOD'], fn: (env, b, me, pre, ctx) => poeDecide(env, b, me, ctx) },
  poeDecideMany: { role: ['TRAINER', 'HOD'], fn: (env, b, me, pre, ctx) => poeDecideMany(env, b, me, ctx) },
  poeReceive: { role: ['MIS'], fn: (env, b, me) => poeReceive(env, b, me) },
  driveStatus: { role: ['MIS', 'HOD'], fn: (env) => driveStatus(env) },
  poeClass: { role: ['MIS', 'HOD', 'IAO'], fn: (env, b) => poeClass(env, b) },
  verifyData: { fn: (env, b, me) => verifyData(env, b, me) },
  savePanel: { role: ['MIS', 'IAO'], fn: (env, b, me) => savePanel(env, b, me) },
  assignVerification: { role: ['MIS', 'IAO'], fn: (env, b, me) => assignVerification(env, b, me) },
  verifyListSave: { role: ['MIS', 'IAO'], fn: (env, b, me) => verifyListSave(env, b, me) },
  deletePanel: { role: ['MIS', 'IAO'], fn: (env, b, me) => deletePanel(env, b, me) },
  deleteVerification: { role: ['MIS', 'IAO'], fn: (env, b, me) => deleteVerification(env, b, me) },
  clearVerification: { role: ['MIS', 'IAO'], fn: (env, b, me) => clearVerification(env, b, me) },
  deleteStaff: { role: ['MIS'], fn: (env, b, me) => deleteStaff(env, b, me) },
  deleteStudent: { role: ['MIS'], fn: (env, b, me) => deleteStudent(env, b, me) },
  allocateVerification: { role: ['MIS', 'IAO'], fn: (env, b, me) => allocateVerification(env, b, me) },
  setupVerification: { role: ['MIS', 'IAO'], fn: (env, b, me) => setupVerification(env, b, me) },
  verifyPool: { role: ['EAO', 'IAO', 'HOD', 'MIS'], fn: (env, b, me) => verifyPool(env, b, me) },
  externalSample: { role: ['EAO'], fn: (env, b, me) => externalSample(env, b, me) },
  setExternal: { role: ['MIS', 'IAO'], fn: (env, b, me) => setExternal(env, b, me) },
  redrawSample: { role: ['HOD', 'MIS', 'IAO'], fn: (env, b, me) => redrawSample(env, b, me) },
  moreSample: { role: ['EAO', 'IAO'], fn: (env, b, me) => moreSample(env, b, me) },
  saveCheck: { fn: (env, b, me) => saveCheck(env, b, me) },
  saveChecks: { fn: (env, b, me) => saveChecks(env, b, me) },
  submitVerification: { fn: (env, b, me) => submitVerification(env, b, me) },
  respondVerification: { role: ['TRAINER', 'HOD'], fn: (env, b, me) => respondVerification(env, b, me) },
  signVerification: { fn: (env, b, me) => signVerification(env, b, me) },
  externalVerdict: { role: ['EAO'], fn: (env, b, me) => externalVerdict(env, b, me) },
  noticeOptions: { role: ['TRAINER', 'HOD', 'MIS', 'IAO'], fn: (env, b, me) => noticeOptions(env, me) },
  sendNotice: { role: ['TRAINER', 'HOD', 'MIS', 'IAO'], fn: (env, b, me, pre, ctx) => sendNotice(env, b, me, ctx) },
  myNotices: { fn: (env, b, me) => myNotices(env, b, me) },
  setRep: { role: ['MIS', 'HOD', 'TRAINER'], fn: (env, b, me) => setRep(env, b, me) },
  marksPull: { fn: (env, b, me) => marksPull(env, b, me) },
  marksPush: { role: ['TRAINER', 'HOD'], fn: (env, b, me) => marksPush(env, b, me) },
  msList: { fn: (env, b, me) => msList(env, b, me) },
  candidates: { role: ['IAO', 'HOD', 'MIS'], fn: (env, b, me) => candidates(env, b, me) },
  bulkTicket: { role: ['MIS', 'HOD'], fn: (env, b, me) => bulkTicket(env, b, me) },
  msSubmit: { role: ['TRAINER', 'HOD'], fn: (env, b, me) => msSubmit(env, b, me) },
  msReceive: { role: ['IAO', 'HOD'], fn: (env, b, me) => msReceive(env, b, me) },
  msDecide: { role: ['HOD'], fn: (env, b, me) => msDecide(env, b, me) },
  importRegCodes: { role: ['MIS'], fn: (env, b, me) => importRegCodes(env, b, me) },
  setDefaultPin: { role: ['MIS'], fn: (env, b, me) => setDefaultPin(env, b, me) },
  absences: { role: ['HOD', 'MIS'], fn: (env, b, me) => absences(env, b, me) },
  setAbsenceLimit: { role: ['HOD', 'MIS'], fn: (env, b, me) => setAbsenceLimit(env, b, me) },
};

/* Changes the Google Drive bridge needs to see: registers, marks, evidence, sign-offs, and anything
 * that alters the class lists, the loading, the term or a trainer's settings or Drive folder. */
const NUDGE_ACTIONS = new Set(['push', 'marksPush', 'msSubmit', 'msReceive', 'msDecide', 'poeDone', 'poeDecide', 'poeDecideMany', 'poeReceive', 'submitSignoff', 'decideSignoff', 'decideSignoffs',
  'saveTerm', 'uploadLoading', 'importClassList', 'importRegCodes', 'addStudents', 'decideRequest',
  'updateStudent', 'updateStaff', 'deleteStaff', 'deleteStudent', 'mySettings', 'archiveClasses', 'deleteClasses', 'unlock', 'relock', 'setBackup', 'setRep']);

/* ---------- staff sign-in ---------- */
function staffPublic(r) {
  return { code: r.code, name: r.name, roles: rolesList(r.roles), responsibility: r.responsibility || '', active: !!r.active,
    hasPin: !!r.pin_hash, mustChange: !!r.must_change, latePct: r.late_pct ?? 50, excusedPct: r.excused_pct ?? 100, driveFolder: r.drive_folder || '', email: r.email || '',
    endsOn: r.ends_on || '' };
}
const accountEnded = (r) => !!(r && r.ends_on && todayIso() > r.ends_on);
const getStaff = (env, code) => one(env, 'SELECT * FROM staff WHERE code=?', String(code || '').trim());

/** Sets a PIN (creating the account when `create` is given). Bumps pin_version, which signs out old sessions. */
export async function setStaffPin(env, code, pin, mustChange, create) {
  let row = await getStaff(env, code);
  if (!row) {
    if (!create) fail('No staff member with code ' + code);
    row = { code: String(code).trim().toUpperCase(), name: create.name || code, roles: create.roles || 'TRAINER', responsibility: create.resp || '', pin_version: 0, late_pct: null, excused_pct: null };
  }
  let roles = row.roles;
  if (create?.roles && !hasRole(roles, create.roles)) roles = rolesList(roles + ',' + create.roles).join(', ');
  const salt = crypto.randomUUID().slice(0, 12);
  const next = { ...row, roles, active: 1, pin_salt: salt, pin_hash: await sha256Hex(salt + '|' + pin), pin_version: (Number(row.pin_version) || 0) + 1, must_change: mustChange ? 1 : 0, updated_at: nowIso() };
  await run(env, `INSERT INTO staff (code,name,roles,responsibility,active,pin_hash,pin_salt,pin_version,must_change,late_pct,excused_pct,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, roles=excluded.roles, active=1, pin_hash=excluded.pin_hash, pin_salt=excluded.pin_salt, pin_version=excluded.pin_version, must_change=excluded.must_change, updated_at=excluded.updated_at`,
  next.code, next.name, next.roles, next.responsibility || '', 1, next.pin_hash, next.pin_salt, next.pin_version, next.must_change, next.late_pct ?? null, next.excused_pct ?? null, next.updated_at);
  return next;
}

async function makeToken(env, row) {
  const payload = `${row.code}|${row.pin_version}|${Date.now()}`;
  return payload + '|' + (await hmacHex(payload, await authSecret(env))).slice(0, 32);
}

async function login(env, b) {
  const code = String(b.staff || '').trim(), pin = String(b.pin || '').trim();
  if (!code || !pin) fail('Enter your staff code and PIN');
  const [lfRows, staffRows, misRows, secretRows, defRows] = await many(env, ['SELECT * FROM login_fails WHERE code=?', code], ['SELECT * FROM staff WHERE code=?', code],
    ["SELECT 1 AS x FROM staff WHERE active=1 AND upper(roles) LIKE '%MIS%' LIMIT 1"], ["SELECT value FROM meta WHERE key='auth_secret'"], ["SELECT value FROM meta WHERE key='default_pin'"]);
  if (!secretCache && secretRows[0]) secretCache = secretRows[0].value;
  const lf = lfRows[0];
  if (lf && lf.fails >= 5 && lf.until > nowIso()) fail('Too many wrong PINs. Try again in 15 minutes.');
  let row = staffRows[0];
  // First sign-in on a new database: staff code MIS with the ADMIN_PIN secret set on the Worker.
  if (!row && lower(code) === 'mis' && env.ADMIN_PIN && !misRows.length) {
    row = await setStaffPin(env, 'MIS', String(env.ADMIN_PIN), true, { name: 'MIS Officer', roles: 'MIS' });
  }
  if (!row && lower(code) === 'mis' && !env.ADMIN_PIN) fail('First sign-in: add the ADMIN_PIN secret to the Worker (Settings → Variables and Secrets), then try again.');
  // Someone who has no PIN of their own yet may use the first-time PIN the MIS Officer set; they then choose their own.
  let firstTime = false;
  if (row && row.active && !row.pin_hash && defRows[0]) {
    const d = JSON.parse(defRows[0].value || '{}');
    firstTime = !!d.hash && (await sha256Hex(d.salt + '|' + pin)) === d.hash;
  }
  if (!firstTime && (!row || !row.active || !row.pin_hash || (await sha256Hex(row.pin_salt + '|' + pin)) !== row.pin_hash)) {
    const fails = lf && lf.until > nowIso() ? lf.fails + 1 : 1;
    await run(env, 'INSERT INTO login_fails (code,fails,until) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET fails=excluded.fails, until=excluded.until',
      code, fails, new Date(Date.now() + 15 * 6e4).toISOString());
    fail(row && !row.pin_hash && !defRows[0] ? 'No PIN has been set for this staff code yet. Ask the MIS Officer.' : 'Wrong staff code or PIN');
  }
  if (lf) await run(env, 'DELETE FROM login_fails WHERE code=?', code);
  if (accountEnded(row)) fail(`This account ended on ${row.ends_on}. Ask the MIS Officer if you need it again.`);
  if (firstTime && !row.must_change) { await run(env, 'UPDATE staff SET must_change=1 WHERE code=?', row.code); row.must_change = 1; }
  return { ok: true, token: await makeToken(env, row), staff: staffPublic(row), mustChange: firstTime || !!row.must_change };
}

/** Approving asks for the PIN again (the app remembers it for a few minutes). Wrong PINs count towards the sign-in lock. */
async function confirmPin(env, me, pin) {
  pin = String(pin || '').trim();
  if (!pin) fail('Enter your PIN to approve', { needPin: true });
  const [lfRows, rows] = await many(env, ['SELECT * FROM login_fails WHERE code=?', me.code], ['SELECT pin_salt, pin_hash FROM staff WHERE code=?', me.code]);
  const lf = lfRows[0], r = rows[0];
  if (lf && lf.fails >= 5 && lf.until > nowIso()) fail('Too many wrong PINs. Try again in 15 minutes.', { needPin: true });
  if (!r || !r.pin_hash || (await sha256Hex(r.pin_salt + '|' + pin)) !== r.pin_hash) {
    const fails = lf && lf.until > nowIso() ? lf.fails + 1 : 1;
    await run(env, 'INSERT INTO login_fails (code,fails,until) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET fails=excluded.fails, until=excluded.until',
      me.code, fails, new Date(Date.now() + 15 * 6e4).toISOString());
    fail('Wrong PIN', { needPin: true });
  }
  if (lf) await run(env, 'DELETE FROM login_fails WHERE code=?', me.code);
}
/** What an approval says when the approver leaves the comment empty: the copy is taken as good. */
const OK_SAID = { register: 'Checked - complete and in order.', poe: 'Checked - complete and acceptable.', marksheet: 'Checked - marks complete and in order.' };
const BATCH_MAX = 50;

/** Checks a sign-in token: genuine, staff still active, PIN not changed or reset since.
 * Reads the staff row, the change markers and any `extra` statements in one database trip;
 * returns [me, { meta, rows }] where rows are the results of `extra`. */
async function auth(env, token, extra = []) {
  const parts = String(token || '').split('|');
  if (parts.length !== 4) fail('Sign in to continue', { authError: true });
  const wanted = secretCache ? ['last_change', 'roster_v'] : ['last_change', 'roster_v', 'auth_secret'];
  const [staffRows, metaRows, ...rows] = await many(env, ['SELECT * FROM staff WHERE code=?', parts[0]], [`SELECT key, value FROM meta WHERE key IN (${wanted.map(() => '?').join(',')})`, ...wanted], ...extra);
  const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
  if (!secretCache && meta.auth_secret) secretCache = meta.auth_secret;
  const payload = parts.slice(0, 3).join('|');
  if ((await hmacHex(payload, await authSecret(env))).slice(0, 32) !== parts[3]) fail('Sign in again', { authError: true });
  const row = staffRows[0];
  if (!row || !row.active || accountEnded(row) || String(row.pin_version) !== String(Number(parts[1]))) {
    fail('Your sign-in has ended (PIN changed or account switched off). Sign in again.', { authError: true });
  }
  const p = staffPublic(row);
  return [{ code: p.code, name: p.name, roles: p.roles, mustChange: p.mustChange, latePct: p.latePct, excusedPct: p.excusedPct }, { meta, rows }];
}

async function setPin(env, b, me) {
  const pin = String(b.newPin || '').trim();
  if (!/^\d{4,8}$/.test(pin)) fail('Use 4 to 8 digits for your PIN');
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) fail('Choose a PIN that is harder to guess');
  const row = await setStaffPin(env, me.code, pin, false);
  return { ok: true, token: await makeToken(env, row), staff: staffPublic(row) };
}

async function saveMySettings(env, b, me) {
  const clamp = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);
  await run(env, 'UPDATE staff SET late_pct=COALESCE(?,late_pct), excused_pct=COALESCE(?,excused_pct), updated_at=? WHERE code=?', clamp(b.latePct), clamp(b.excusedPct), nowIso(), me.code);
  await bumpRoster(env);
  return { ok: true, staff: staffPublic(await getStaff(env, me.code)) };
}

/* ---------- terms ---------- */
const TERM_SQL = "SELECT * FROM terms WHERE status='active' ORDER BY updated_at DESC LIMIT 1";
const activeTerm = async (env) => termOut(await one(env, TERM_SQL));
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
/** Monday of each of the 10 teaching weeks, skipping break weeks. */
function teachingWeeks(term) {
  if (!term || !term.startDate) return [];
  const breaks = new Set(term.breaks.map(mondayOf));
  const out = [];
  const d = new Date(mondayOf(term.startDate) + 'T00:00:00Z');
  for (let guard = 0; out.length < TERM_WEEKS && guard < 60; guard++) {
    const iso = d.toISOString().slice(0, 10);
    if (!breaks.has(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}
const weekOf = (term, date) => { const i = teachingWeeks(term).indexOf(mondayOf(date)); return i === -1 ? null : i + 1; };

/** A term ends (closed, or a new term started): who was in which class is kept for that term, and every student is marked
 *  inactive until the class lists for the next term are uploaded (the upload brings back everyone on them). */
async function endTerm(env, term, me) {
  const now = nowIso(), live = `(status IS NULL OR status NOT IN ${GONE})`;
  const n = (await one(env, `SELECT COUNT(*) AS n FROM trainees WHERE ${live}`))?.n || 0;
  await many(env,
    [`INSERT OR IGNORE INTO enrolments (term_id, adm_no, class_code, status, at) SELECT ?, adm_no, class_code, 'active', ? FROM trainees WHERE ${live}`, term.id, now],
    ["UPDATE enrolments SET status='completed', at=? WHERE term_id=? AND status='active'", now, term.id],
    [`UPDATE trainees SET status='inactive', updated_by=?, updated_at=? WHERE ${live}`, me.code, now]);
  await audit(env, me, 'end of term', `${term.id} ${term.name}: ${n} students inactive until the next class lists`);
  return n;
}
async function saveTerm(env, b, me) {
  if (!b.name || !/^\d{4}-\d{2}-\d{2}$/.test(b.startDate || '')) fail('Give the term a name and a start date');
  const id = String(b.termId || '').trim() || 'T' + b.startDate;
  const before = await activeTerm(env);
  const ending = before && (before.id !== id || b.close) ? before : null;
  const breaks = (b.breaks || []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).map(mondayOf);
  await run(env, "UPDATE terms SET status='closed' WHERE status='active' AND id<>?", id);
  const cats = catWeeksOf((b.catWeeks || []).join(','));
  const hours = Number(b.lessonHours) > 0 && Number(b.lessonHours) <= 8 ? Math.round(Number(b.lessonHours) * 100) / 100 : null;
  await run(env, `INSERT INTO terms (id,name,duration,start_date,weeks,breaks,status,updated_at,cat_weeks,series,lesson_hours) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, duration=excluded.duration, start_date=excluded.start_date, breaks=excluded.breaks, status=excluded.status, updated_at=excluded.updated_at, cat_weeks=excluded.cat_weeks, series=excluded.series, lesson_hours=excluded.lesson_hours`,
  id, b.name, b.duration || '', b.startDate, TERM_WEEKS, breaks.join(', '), b.close ? 'closed' : 'active', nowIso(), cats.join(', '), String(b.series || '').trim().slice(0, 60), hours);
  await audit(env, me, b.close ? 'close term' : 'save term', `${id} ${b.name} from ${b.startDate}${breaks.length ? ' breaks ' + breaks.join(' ') : ''}${cats.length ? ' CAT weeks ' + cats.join(' ') : ''}`);
  const inactive = ending ? await endTerm(env, ending, me) : 0;
  await bumpRoster(env);
  const term = await activeTerm(env);
  return { ok: true, term, weeks: teachingWeeks(term), ended: ending ? ending.name : '', inactive };
}

/* ---------- trainer loading ---------- */
async function uploadLoading(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail('Set up the term first (Manage > Term)');
  const now = nowIso();
  const seen = new Map();
  for (const r of b.rows || []) {
    if (!r || !r.classCode || !r.unitCode) continue;
    // "A, B": the classes are taught this unit together. Each class gets the unit, and its row names the classes taught
    // together, so the trainer marks them as one lesson. ("A/B" is one class for every unit and stays as it is.)
    const parts = jointParts(r.classCode);
    for (const cls of parts || [r.classCode]) {
      const k = cls + '|' + r.unitCode, had = seen.get(k);
      if (!had) seen.set(k, { ...r, classCode: cls, joint: parts ? parts.join(', ') : '', population: parts ? null : r.population });
      else if (parts && !had.joint && lower(had.trainerCode) === lower(r.trainerCode)) had.joint = parts.join(', ');
    }
  }
  if (!seen.size) fail('No loading rows found in that file');
  const rows = [...seen.values()];
  // Units the class had in an earlier term carry on (their marks and evidence stay); the rest are new.
  const [earlier, lastTerm] = await many(env, ['SELECT DISTINCT class_code, unit_code FROM loading WHERE term_id<>?', term.id],
    ['SELECT l.class_code, l.unit_code, l.unit_name FROM loading l WHERE l.term_id = (SELECT t.id FROM terms t WHERE t.id<>? AND EXISTS (SELECT 1 FROM loading x WHERE x.term_id=t.id) ORDER BY t.start_date DESC LIMIT 1)', term.id]);
  const had = new Set(earlier.map((r) => r.class_code + '|' + r.unit_code)), nowKeys = new Set(rows.map((r) => r.classCode + '|' + r.unitCode));
  const continuing = rows.filter((r) => had.has(r.classCode + '|' + r.unitCode)).length;
  const finished = lastTerm.filter((r) => !nowKeys.has(r.class_code + '|' + r.unit_code)).map((r) => ({ classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name || r.unit_code }));
  await run(env, 'DELETE FROM loading WHERE term_id=?', term.id);
  await upsertMany(env, 'loading', ['term_id', 'class_code', 'unit_code', 'unit_name', 'trainer_code', 'trainer_name', 'lessons_per_week', 'hours_per_week', 'population', 'updated_at', 'joint'],
    rows.map((r) => ({ term_id: term.id, class_code: r.classCode, unit_code: r.unitCode, unit_name: r.unitName || r.unitCode, trainer_code: r.trainerCode || '',
      trainer_name: r.trainerName || '', lessons_per_week: Number(r.lessonsPerWeek) || 2, hours_per_week: Number(r.hoursPerWeek) || 3, population: Number(r.population) || null, updated_at: now,
      joint: r.joint || null })),
    ['term_id', 'class_code', 'unit_code']);
  // Earlier loadings made a class out of each "A, B" code: remove those that nothing uses any more.
  const unused = (t) => `NOT EXISTS (SELECT 1 FROM ${t} x WHERE x.class_code = classes.code)`;
  await run(env, `DELETE FROM classes WHERE code LIKE '%,%' AND ${['loading', 'trainees', 'sessions', 'unit_marks', 'marks', 'evidence', 'signoffs', 'requests'].map(unused).join(' AND ')}`);
  // Classes: add new class codes; keep names, levels and MIS links already set.
  const classes = new Map();
  for (const r of rows) if (!classes.has(r.classCode)) classes.set(r.classCode, { code: r.classCode, name: r.classCode, level: levelOf(r.classCode), mis_class: null, population: Number(r.population) || null });
  await upsertMany(env, 'classes', ['code', 'name', 'level', 'mis_class', 'population'], [...classes.values()], ['code'], []);
  // Staff: every trainer in the loading gets an account (no PIN until the MIS Officer issues one).
  const info = new Map();
  for (const r of rows) if (r.trainerCode) info.set(lower(r.trainerCode), { code: r.trainerCode, name: r.trainerName });
  const extra = new Map();
  for (const t of b.trainers || []) if (t.code) { extra.set(lower(t.code), t); if (!info.has(lower(t.code))) info.set(lower(t.code), { code: t.code, name: t.name }); }
  const existing = new Map((await all(env, `SELECT * FROM staff WHERE code IN ${IN}`, JSON.stringify([...info.values()].map((x) => x.code)))).map((r) => [lower(r.code), r]));
  let added = 0;
  const staffRows = [...info.entries()].map(([k, x]) => {
    const e = extra.get(k) || {}, old = existing.get(k);
    const isHod = /^HOD$/i.test(String(e.responsibility || '').trim());
    if (!old) added++;
    return { code: old ? old.code : String(x.code).trim().toUpperCase(), name: e.name || x.name || old?.name || x.code,
      roles: rolesList((old ? old.roles + ',' : '') + 'TRAINER' + (isHod ? ',HOD' : '')).join(', '),
      responsibility: e.responsibility || old?.responsibility || '', active: old ? old.active : 1, must_change: old ? old.must_change : 1,
      pin_version: old ? old.pin_version : 0, updated_at: now };
  });
  await upsertMany(env, 'staff', ['code', 'name', 'roles', 'responsibility', 'active', 'must_change', 'pin_version', 'updated_at'], staffRows, ['code'], ['name', 'roles', 'responsibility', 'updated_at']);
  await audit(env, me, 'upload loading', `${term.id}: ${rows.length} class-units, ${info.size} trainers`);
  await bumpRoster(env);
  return { ok: true, term: term.id, rows: rows.length, trainers: info.size, newStaff: added, classes: classes.size, continuing, newUnits: rows.length - continuing, finished };
}


/* ---------- roster for staff phones ---------- */
async function readRoster(env, b, me, pre) {
  const version = pre.meta.roster_v || 'none';
  if (b.version && b.version === version) return { ok: true, unchanged: true, version, me };
  const [termRows, loading, unitRows, classRows, reqs, staffRows] = await many(env, [TERM_SQL], [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`], ['SELECT * FROM units'],
    ['SELECT * FROM classes'], ["SELECT adm_no, name, class_code, requested_name, reason, status, merged_into FROM requests WHERE status IN ('pending','rejected','merged')"],
    ['SELECT code, name, late_pct, excused_pct FROM staff']);
  const [termList, unlockRows, earlierRows] = await many(env, ['SELECT * FROM terms ORDER BY start_date DESC'], [`SELECT term_id, class_code, unit_code, until FROM unlocks WHERE ${UNLOCK_LIVE}`],
    [`SELECT DISTINCT class_code, unit_code FROM loading WHERE term_id <> COALESCE(${ACTIVE_TERM}, '')`]);
  const carried = new Set(earlierRows.map((r) => r.class_code + '|' + r.unit_code));
  const term = termOut(termRows[0]);
  // Archived classes are kept but left out of everything a trainer works with day to day.
  const gone = new Set(classRows.filter((r) => r.status === 'archived').map((r) => r.code));
  const keep = (code) => !classParts(code).some((c) => gone.has(c)) && !gone.has(code);
  loading.splice(0, loading.length, ...loading.filter((r) => keep(r.class_code)));
  const units = loading.length
    ? loading.map((r) => ({ classCode: r.class_code, code: r.unit_code, name: r.unit_name || r.unit_code, trainerCode: r.trainer_code, trainerName: r.trainer_name,
      lessonsPerWeek: Number(r.lessons_per_week) || 2, hoursPerWeek: Number(r.hours_per_week) || 3, ...(r.joint ? { joint: r.joint.split(/\s*,\s*/) } : {}),
      ...(carried.has(r.class_code + '|' + r.unit_code) ? { continuing: true } : {}) }))
    : unitRows.filter((r) => keep(r.class_code)).map((r) => ({ classCode: r.class_code, code: r.code, name: r.name || r.code, lessonsPerWeek: 2, hoursPerWeek: 3 }));
  // Trainers get only the class lists of the classes they teach; the HOD and MIS Officer get all.
  const mine = new Set();
  if (!seesAll(me)) {
    for (const u of loading) if (lower(u.trainer_code) === lower(me.code)) classParts(u.class_code).forEach((c) => mine.add(c));
  }
  const everyone = visitorOnly(me) ? [] : mine.size ? await all(env, `SELECT adm_no, name, class_code, status, reg_code FROM trainees WHERE class_code IN ${IN}`, JSON.stringify([...mine]))
    : await all(env, 'SELECT adm_no, name, class_code, status, reg_code FROM trainees');
  const trainees = everyone.filter((r) => !gone.has(r.class_code));
  // A trainer also gets the names in the other streams of the classes they teach, so a student placed in the
  // wrong stream can be added to theirs (marked at once, pending until the MIS Officer moves them).
  let streamMates = [];
  if (mine.size) {
    const bases = new Set([...mine].map(streamBase).filter(Boolean));
    const others = classRows.map((r) => r.code).filter((c) => !mine.has(c) && !gone.has(c) && bases.has(streamBase(c)));
    if (others.length) streamMates = (await all(env, `SELECT adm_no, name, class_code, status FROM trainees WHERE class_code IN ${IN}`, JSON.stringify(others)))
      .filter(active).map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no, classCode: r.class_code }));
  }
  const staff = {};
  for (const r of staffRows) staff[r.code] = { name: r.name, latePct: r.late_pct ?? 50, excusedPct: r.excused_pct ?? 100 };
  return {
    ok: true, version, me, term, weeks: teachingWeeks(term),
    classes: classRows.filter((r) => !gone.has(r.code)).map((r) => ({ code: r.code, name: r.name || r.code, level: r.level || levelOf(r.code), misClass: r.mis_class || '' })),
    units,
    terms: termList.map((r) => ({ id: r.id, name: r.name, duration: r.duration || '', startDate: r.start_date || '', status: r.status || '' })),
    unlocks: unlockRows.map((r) => ({ termId: r.term_id, classCode: r.class_code, unitCode: r.unit_code, until: r.until || '' })),
    archived: me.roles.includes('MIS') ? classRows.filter((r) => gone.has(r.code)).map((r) => ({ code: r.code, misClass: r.mis_class || '', archivedAt: r.archived_at || '',
      archivedBy: r.archived_by || '', students: everyone.filter((x) => x.class_code === r.code && active(x)).length })) : [],
    trainees: trainees.map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no, classCode: r.class_code, active: active(r), regCode: r.reg_code || '' })),
    pending: reqs.filter((r) => r.status === 'pending').map((r) => ({ admNo: r.adm_no, name: r.name, classCode: r.class_code, requestedBy: r.requested_name, reason: r.reason })),
    rejected: reqs.filter((r) => r.status === 'rejected').map((r) => ({ admNo: r.adm_no, classCode: r.class_code })),
    aliases: reqs.filter((r) => r.status === 'merged' && r.merged_into).map((r) => ({ from: r.adm_no, to: r.merged_into, classCode: r.class_code })),
    streamMates, staff,
    // Set when the MIS Officer starts afresh: phones drop their registers and marks from before this moment.
    resetAt: (await getMeta(env, 'data_reset')) || '',
  };
}

/* ---------- student app: setup lists and phone registration ---------- */
const GROUP = "COALESCE(NULLIF(t.mis_class,''), NULLIF(c.mis_class,''), t.class_code)";
/** The class dropdown: worked out once and kept until the class lists change (1–2 rows read per phone). */
async function publicClasses(env) {
  const [cache, ver] = await many(env, ["SELECT value FROM meta WHERE key='pub_classes'"], ["SELECT value FROM meta WHERE key='roster_v'"]);
  const v = ver[0]?.value || 'none';
  if (cache[0]) { const c = JSON.parse(cache[0].value); if (c.v === v) return { ok: true, classes: c.classes }; }
  const rows = await all(env, `SELECT DISTINCT ${GROUP} AS g FROM trainees t LEFT JOIN classes c ON c.code=t.class_code WHERE t.status NOT IN ${GONE} ORDER BY g`);
  const classes = rows.map((r) => ({ code: r.g, name: r.g }));
  await setMeta(env, 'pub_classes', JSON.stringify({ v, classes }));
  return { ok: true, classes };
}
/** The name dropdown for one class: found through indexes, so only that class's students are read. */
async function classList(env, group) {
  if (!group) fail('Choose a class');
  const rows = await all(env, `SELECT t.adm_no, t.name, t.class_code, t.status, t.mis_class, c.mis_class AS cm FROM trainees t LEFT JOIN classes c ON c.code=t.class_code
    WHERE t.mis_class=?1 OR t.class_code=?1 OR t.class_code IN (SELECT code FROM classes WHERE mis_class=?1)`, group);
  const list = rows.filter((r) => active(r) && (r.mis_class || r.cm || r.class_code) === group).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, classCode: group, trainees: list.map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no, classCode: r.class_code })) };
}

/** First login on a student phone: ties the phone to the chosen student, once. */
async function registerDevice(env, b) {
  const adm = String(b.admNo || '').trim();
  const [tRows, devRows, admRows] = await many(env, ['SELECT t.*, c.name AS class_name FROM trainees t LEFT JOIN classes c ON c.code=t.class_code WHERE t.adm_no=?', adm],
    ['SELECT d.*, t.name AS tname FROM devices d LEFT JOIN trainees t ON t.adm_no=d.adm_no WHERE d.device_id=?', String(b.deviceId || '')],
    ['SELECT * FROM devices WHERE adm_no=?', adm]);
  const t = tRows[0], dev = devRows[0], byAdm = admRows[0];
  if (!t || !active(t)) return { ok: false, error: 'That student is not on the class list' };
  if (!b.deviceId) return { ok: false, error: 'Missing phone ID' };
  if (dev && lower(dev.adm_no) !== lower(t.adm_no)) return { ok: false, error: `This phone is already registered to ${dev.tname || dev.adm_no}. Ask the HOD or MIS Officer to reset it.` };
  if (byAdm && byAdm.device_id !== b.deviceId) return { ok: false, error: `${t.name} is already registered on another phone or browser. Ask the HOD or MIS Officer to reset it.` };
  const now = nowIso();
  await run(env, 'INSERT INTO devices (device_id,adm_no,name,class_code,registered_at,last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET last_seen=excluded.last_seen',
    b.deviceId, t.adm_no, t.name, t.class_code, now, now);
  return { ok: true, admNo: t.adm_no, name: t.name, classCode: t.class_code, className: t.class_name || t.class_code };
}

/** HOD and MIS: the students whose phone is registered (classes not archived), newest first. */
async function listPhones(env) {
  const rows = await all(env, `SELECT d.adm_no, COALESCE(t.name, d.name) AS name, COALESCE(t.class_code, d.class_code) AS class_code, d.registered_at, d.last_seen
    FROM devices d LEFT JOIN trainees t ON t.adm_no=d.adm_no LEFT JOIN classes c ON c.code=COALESCE(t.class_code, d.class_code)
    WHERE COALESCE(c.status,'') <> 'archived' ORDER BY d.registered_at DESC`);
  return { ok: true, phones: rows.map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no, classCode: r.class_code || '', registeredAt: r.registered_at || '', lastSeen: r.last_seen || '' })) };
}

/** HOD and MIS: frees a student from their registered phone (lost, changed or reset phone, another browser).
 *  The next phone they set up becomes theirs. Their check-ins, evidence and attendance stay. */
async function resetPhone(env, b, me) {
  const adm = String(b.admNo || '').trim();
  const rows = await all(env, 'SELECT * FROM devices WHERE adm_no=?', adm);
  if (!rows.length) return { ok: true, reset: 0 };
  const ids = JSON.stringify(rows.map((r) => r.device_id));
  await many(env, ['DELETE FROM devices WHERE adm_no=?', adm], [`DELETE FROM push_subs WHERE device_id IN (SELECT value FROM json_each(?))`, ids]);
  await audit(env, me, 'reset phone', `${rows[0].adm_no} ${rows[0].name || ''}`.trim());
  return { ok: true, reset: rows.length };
}

/* ---------- class lists (MIS Officer) ---------- */
const TCOLS = ['adm_no', 'name', 'class_code', 'status', 'mis_class', 'added_by', 'added_at', 'updated_by', 'updated_at', 'note'];

/** Applies (or, with dryRun, previews) one MIS class register: new students are added, nobody is removed. */
async function importClassList(env, b, me) {
  const mis = String(b.misClass || '').trim();
  let streams = [...new Set((b.streams || []).map((s) => String(s).trim()).filter(Boolean))];
  if (!mis) fail('The class code is missing');
  if (!streams.length) streams = [mis];
  const students = [], seenAdm = new Set();
  for (const s of b.students || []) {
    const adm = String(s.admNo || '').trim(), name = String(s.name || '').replace(/\s+/g, ' ').trim();
    if (!adm || seenAdm.has(lower(adm))) continue;
    seenAdm.add(lower(adm));
    students.push({ admNo: adm, name: name || adm });
  }
  if (!students.length) fail('No students found in that list');
  // The MIS Officer's placement from the preview: { admNo: stream }. Anything else follows the rules below.
  const assign = new Map(Object.entries(b.assign || {}).map(([k, v]) => [lower(k), String(v)]).filter(([, v]) => streams.includes(v)));
  const now = nowIso();
  const [rows, pend] = await many(env, [`SELECT * FROM trainees WHERE class_code IN ${IN} OR adm_no IN ${IN}`, JSON.stringify(streams), JSON.stringify(students.map((s) => s.admNo))],
    [`SELECT * FROM requests WHERE status='pending' AND adm_no IN ${IN}`, JSON.stringify(students.map((s) => s.admNo))]);
  const byAdm = new Map(rows.map((r) => [lower(r.adm_no), r]));
  const inStream = Object.fromEntries(streams.map((s) => [s, 0]));
  for (const r of rows) if (inStream[r.class_code] !== undefined && active(r)) inStream[r.class_code]++;
  const firstUpload = streams.every((s) => !inStream[s]);
  const out = { added: [], unchanged: 0, renamed: [], moved: [], confirmed: [], missing: [], back: [], byStream: {}, plan: [] };
  // First upload: the whole list is divided into equal parts, in list order. Later: students already in one of
  // these streams stay there, and newcomers go to the smallest stream. The preview lets the MIS Officer move anyone.
  const smallest = () => [...streams].sort((a, c) => inStream[a] - inStream[c] || (a < c ? -1 : 1))[0];
  const writes = [];
  students.forEach((s, idx) => {
    const old = byAdm.get(lower(s.admNo));
    const here = old && streams.includes(old.class_code) ? old.class_code : '';
    let to = assign.get(lower(s.admNo));
    // Equal parts: 82 students in 3 streams are 28, 27 and 27.
    if (!to) to = here || (firstUpload ? streams[Math.floor((idx * streams.length) / students.length)] : smallest());
    if (here && active(old)) inStream[here]--;
    inStream[to]++;
    out.plan.push({ admNo: s.admNo, name: s.name, from: old ? old.class_code : '', fromActive: old ? active(old) : false, to, isNew: !old });
    if (!old) {
      out.added.push({ admNo: s.admNo, name: s.name, classCode: to });
      writes.push({ adm_no: s.admNo, name: s.name, class_code: to, status: 'active', mis_class: mis, added_by: me.code, added_at: now, updated_by: me.code, updated_at: now, note: '' });
      return;
    }
    const row = { ...old };
    let changed = false;
    if (row.name !== s.name) { out.renamed.push({ admNo: row.adm_no, old: row.name, name: s.name }); if (b.useNewNames) { row.name = s.name; changed = true; } }
    if (row.class_code !== to) { out.moved.push({ admNo: row.adm_no, name: row.name, from: row.class_code, to, within: !!here }); row.class_code = to; changed = true; }
    if (!active(row)) { if (row.status === 'inactive') out.back.push({ admNo: row.adm_no, name: row.name }); row.status = 'active'; changed = true; }
    if (row.mis_class !== mis) { row.mis_class = mis; changed = true; }
    if (changed) writes.push({ ...row, updated_by: me.code, updated_at: now });
    else out.unchanged++;
  });
  // Students added by trainers while marking are confirmed when the official list includes them.
  for (const r of pend) out.confirmed.push({ admNo: r.adm_no, name: r.name, requestedBy: r.requested_name });
  // Anyone on these streams who is not on this list is reported, never removed automatically.
  const withdraw = new Set((b.withdraw || []).map(lower));
  for (const r of rows) {
    if (seenAdm.has(lower(r.adm_no)) || inStream[r.class_code] === undefined || !active(r)) continue;
    if (r.mis_class && r.mis_class !== mis) continue;     // from another MIS list (a class like "ICT L5LIS-26S/L6LIM-26S" takes two)
    out.missing.push({ admNo: r.adm_no, name: r.name, classCode: r.class_code });
    if (withdraw.has(lower(r.adm_no))) {
      writes.push({ ...r, status: 'withdrawn', updated_by: me.code, updated_at: now, note: `Not on the ${mis} list ${todayIso()}` });
      inStream[r.class_code]--;
    }
  }
  for (const s of streams) out.byStream[s] = inStream[s];
  if (!b.dryRun) {
    const term = await activeTerm(env);
    await many(env, ...upsertStmts('trainees', TCOLS, writes, ['adm_no']),
      // This term's record: the student is in this class for this term.
      ...(term ? upsertStmts('enrolments', ['term_id', 'adm_no', 'class_code', 'status', 'at'], out.plan.map((p) => ({ term_id: term.id, adm_no: p.admNo, class_code: p.to, status: 'active', at: now })), ['term_id', 'adm_no']) : []),
      pend.length && [`UPDATE requests SET status='approved', decided_by=?, decided_at=?, note=? WHERE id IN ${IN}`, me.code, now, 'On the MIS list for ' + mis, JSON.stringify(pend.map((r) => r.id))],
      // Link the streams to this MIS class so the student app groups them and reports show the MIS code.
      ...upsertStmts('classes', ['code', 'name', 'level', 'mis_class'], streams.map((s) => ({ code: s, name: s, level: levelOf(s) || levelOf(mis), mis_class: mis })), ['code'], ['mis_class']));
    await audit(env, me, 'class list', `${mis} → ${streams.join(', ')}: ${out.added.length} added, ${out.back.length} back for the term, ${out.moved.length} moved, ${(b.withdraw || []).length} withdrawn, ${out.confirmed.length} trainer additions confirmed`);
    await bumpRoster(env);
  }
  return { ...out, ok: true, dryRun: !!b.dryRun, misClass: mis, streams, total: students.length };
}

async function studentsOf(env, misClass, classCode) {
  const rows = classCode
    ? await all(env, 'SELECT * FROM trainees WHERE class_code=?', classCode)
    : await all(env, 'SELECT t.* FROM trainees t LEFT JOIN classes c ON c.code=t.class_code WHERE t.mis_class=? OR c.mis_class=?', misClass, misClass);
  // The terms each student was on a class list for, newest first.
  const terms = await all(env, `SELECT e.adm_no, e.class_code, e.status, t.name FROM enrolments e LEFT JOIN terms t ON t.id=e.term_id WHERE e.adm_no IN ${IN} ORDER BY t.start_date DESC`, JSON.stringify(rows.map((r) => r.adm_no)));
  const byAdm = new Map();
  for (const e of terms) { const k = lower(e.adm_no); if (!byAdm.has(k)) byAdm.set(k, []); byAdm.get(k).push({ term: e.name || '', classCode: e.class_code, status: e.status }); }
  return { ok: true, students: rows.map((r) => ({ admNo: r.adm_no, name: r.name, classCode: r.class_code, status: active(r) ? 'active' : (r.status || 'withdrawn'), note: r.note, rep: !!r.rep, email: !!r.email,
    terms: byAdm.get(lower(r.adm_no)) || [] })) };
}

/** MIS: move a student to another stream, withdraw them, or bring them back. */
async function updateStudent(env, b, me) {
  const r = await one(env, 'SELECT * FROM trainees WHERE adm_no=?', String(b.admNo || '').trim());
  if (!r) fail('No student with admission number ' + b.admNo);
  const what = [];
  if (b.classCode && b.classCode !== r.class_code) { what.push(`moved ${r.class_code} → ${b.classCode}`); r.class_code = b.classCode; }
  if (b.status === 'withdrawn' || b.status === 'active') { what.push(b.status); r.status = b.status; }
  if (b.name) { what.push('renamed'); r.name = String(b.name).trim(); }
  if (b.note !== undefined) r.note = String(b.note);
  await upsertMany(env, 'trainees', TCOLS, [{ ...r, updated_by: me.code, updated_at: nowIso() }], ['adm_no']);
  await audit(env, me, 'student', `${r.adm_no} ${what.join(', ')}`);
  await bumpRoster(env);
  return { ok: true, student: { admNo: r.adm_no, name: r.name, classCode: r.class_code, status: r.status || 'active' } };
}

/* ---------- students added by trainers (pending until the MIS Officer decides) ---------- */
async function addStudents(env, list, me) {
  list = list.slice(0, 100).filter((s) => s && s.admNo && s.classCode);
  const adms = list.map((s) => String(s.admNo).trim());
  const trainees = new Map((await all(env, `SELECT * FROM trainees WHERE adm_no IN ${IN}`, JSON.stringify(adms))).map((r) => [lower(r.adm_no), r]));
  const reqs = new Map((await all(env, `SELECT * FROM requests WHERE id IN ${IN}`, JSON.stringify(list.map((s) => s.classCode + '|' + String(s.admNo).trim())))).map((r) => [r.id, r]));
  const now = nowIso(), results = [], writes = [];
  for (const s of list) {
    const adm = String(s.admNo).trim(), cls = String(s.classCode).trim();
    const t = trainees.get(lower(adm));
    if (t && t.class_code === cls && active(t)) { results.push({ admNo: adm, classCode: cls, status: 'on-list' }); continue; }
    const id = cls + '|' + adm, old = reqs.get(id);
    if (old && old.status !== 'rejected') { results.push({ admNo: adm, classCode: cls, status: old.status }); continue; }
    writes.push({ id, adm_no: adm, name: String(s.name || adm).trim(), class_code: cls, reason: String(s.reason || '').slice(0, 300), requested_by: me.code, requested_name: me.name,
      requested_at: s.addedAt || now, status: 'pending', decided_by: null, decided_at: null, merged_into: null, note: t ? `On the list of ${t.class_code}${active(t) ? '' : ' (withdrawn)'}` : '' });
    results.push({ admNo: adm, classCode: cls, status: 'pending' });
  }
  if (writes.length) {
    await upsertMany(env, 'requests', ['id', 'adm_no', 'name', 'class_code', 'reason', 'requested_by', 'requested_name', 'requested_at', 'status', 'decided_by', 'decided_at', 'merged_into', 'note'], writes, ['id']);
    await bumpRoster(env);
  }
  return { ok: true, results };
}

async function listRequests(env) {
  const reqs = await all(env, 'SELECT * FROM requests ORDER BY requested_at DESC LIMIT 500');
  const trainees = new Map((await all(env, `SELECT * FROM trainees WHERE adm_no IN ${IN}`, JSON.stringify(reqs.map((r) => r.adm_no)))).map((r) => [lower(r.adm_no), r]));
  return {
    ok: true,
    requests: reqs.map((r) => {
      const t = trainees.get(lower(r.adm_no));
      return { id: r.id, admNo: r.adm_no, name: r.name, classCode: r.class_code, reason: r.reason, requestedBy: r.requested_name, requestedAt: r.requested_at,
        status: r.status, decidedAt: r.decided_at, mergedInto: r.merged_into, note: r.note, existing: t ? { classCode: t.class_code, name: t.name, active: active(t) } : null };
    }),
  };
}

/** approve: add (or move) the student to the class; reject: drop from reports; merge: it was a typo for an existing student. */
async function decideRequest(env, b, me) {
  const r = await one(env, 'SELECT * FROM requests WHERE id=?', b.id);
  if (!r) fail('That request no longer exists');
  // The HOD decides moves between streams of one class; everything else is the MIS Officer's.
  if (!me.roles.includes('MIS')) {
    const t = await one(env, 'SELECT class_code FROM trainees WHERE adm_no=?', r.adm_no);
    const base = streamBase(r.class_code);
    if (!t || !base || t.class_code === r.class_code || streamBase(t.class_code) !== base || b.decision === 'merge') fail('Only the MIS Officer can decide this one');
  }
  const now = nowIso();
  if (b.decision === 'approve') {
    const t = await one(env, 'SELECT * FROM trainees WHERE adm_no=?', r.adm_no);
    const cls = await one(env, 'SELECT mis_class FROM classes WHERE code=?', r.class_code);
    const row = t ? { ...t } : { adm_no: r.adm_no, name: b.name || r.name, mis_class: cls?.mis_class || '', added_by: r.requested_by, added_at: r.requested_at, note: 'Added by ' + r.requested_name };
    Object.assign(row, { class_code: r.class_code, status: 'active', updated_by: me.code, updated_at: now });
    if (b.name) row.name = b.name;
    await upsertMany(env, 'trainees', TCOLS, [row], ['adm_no']);
    r.status = 'approved';
  } else if (b.decision === 'reject') r.status = 'rejected';
  else if (b.decision === 'merge') {
    const target = await one(env, 'SELECT adm_no FROM trainees WHERE adm_no=?', String(b.mergeInto || '').trim());
    if (!target) fail('No student with admission number ' + b.mergeInto);
    r.status = 'merged'; r.merged_into = target.adm_no;
  } else fail('Choose approve, reject or merge');
  await run(env, 'UPDATE requests SET status=?, merged_into=?, decided_by=?, decided_at=?, note=COALESCE(?,note) WHERE id=?', r.status, r.merged_into || null, me.code, now, b.note || null, r.id);
  await audit(env, me, 'student request', `${r.adm_no} in ${r.class_code}: ${r.status}${r.merged_into ? ' into ' + r.merged_into : ''}`);
  await bumpRoster(env);
  return { ok: true, status: r.status };
}

/* ---------- staff (MIS Officer) ---------- */
async function listStaff(env) {
  const [rows, def] = await many(env, ['SELECT * FROM staff ORDER BY name'], ["SELECT value FROM meta WHERE key='default_pin'"]);
  const d = def[0] ? JSON.parse(def[0].value || '{}') : null;
  return { ok: true, staff: rows.map(staffPublic), defaultPin: d ? { at: d.at || '', by: d.by || '' } : null };
}
/** The MIS Officer's first-time PIN (kept only as a salted hash). An empty PIN removes it. */
async function setDefaultPin(env, b, me) {
  const pin = String(b.pin || '').trim();
  if (!pin) { await run(env, "DELETE FROM meta WHERE key='default_pin'"); await audit(env, me, 'first-time PIN', 'removed'); return { ok: true, set: false }; }
  if (!/^\d{4,8}$/.test(pin)) fail('Use 4 to 8 digits for the first-time PIN');
  const salt = crypto.randomUUID().slice(0, 12);
  await setMeta(env, 'default_pin', JSON.stringify({ salt, hash: await sha256Hex(salt + '|' + pin), at: nowIso(), by: me.name }));
  await audit(env, me, 'first-time PIN', 'set');
  return { ok: true, set: true };
}
async function updateStaff(env, b, me) {
  const code = String(b.code || '').trim().toUpperCase();
  if (!code) fail('Enter a staff code');
  let row = await getStaff(env, code);
  if (!row) {
    if (!b.name) fail("Enter the staff member's name");
    row = { code, name: nameCase(b.name), roles: 'TRAINER', responsibility: '', active: 1, pin_version: 0, must_change: 1 };
  }
  if (b.name) row.name = nameCase(b.name);
  if (b.roles) {
    const roles = rolesList(Array.isArray(b.roles) ? b.roles.join(',') : b.roles);
    if (lower(code) === lower(me.code) && !roles.includes('MIS')) fail('You cannot remove your own MIS role');
    // Internal or external, never both: the External Assessment Officer is a visitor with no other role.
    if (roles.includes('EAO') && roles.length > 1) fail('An External Assessment Officer is a visitor and has no other role. Choose either External, or the internal roles.');
    row.roles = roles.join(', ');
  }
  if (b.driveFolder !== undefined) {
    // A Drive folder link or ID chosen by the MIS Officer when the name match does not find it.
    const id = (String(b.driveFolder).match(/[-\w]{20,}/) || [''])[0];
    await run(env, 'UPDATE staff SET drive_folder=?, updated_at=? WHERE code=?', id || null, nowIso(), code);
    if (!b.roles && b.active === undefined && !b.resetPin && !b.name) return { ok: true, staff: staffPublic(await getStaff(env, code)) };
  }
  if (b.endsOn !== undefined) {
    const d = String(b.endsOn || '').trim();
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) fail('Give the end date as a date');
    row.ends_on = d || null;
    if (row.pin_version !== undefined && !b.roles && b.active === undefined && !b.resetPin && !b.name) {
      await run(env, 'UPDATE staff SET ends_on=?, updated_at=? WHERE code=?', row.ends_on, nowIso(), code);
      return { ok: true, staff: staffPublic(await getStaff(env, code)) };
    }
  }
  if (b.active !== undefined) {
    if (lower(code) === lower(me.code) && !b.active) fail('You cannot switch off your own account');
    row.active = b.active ? 1 : 0;
    row.pin_version = (Number(row.pin_version) || 0) + 1; // signs them out everywhere
  }
  await run(env, `INSERT INTO staff (code,name,roles,responsibility,active,pin_version,must_change,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, roles=excluded.roles, active=excluded.active, pin_version=excluded.pin_version, updated_at=excluded.updated_at`,
  row.code, row.name, row.roles, row.responsibility || '', row.active ? 1 : 0, Number(row.pin_version) || 0, row.must_change ? 1 : 0, nowIso());
  if (b.endsOn !== undefined) await run(env, 'UPDATE staff SET ends_on=?, updated_at=? WHERE code=?', row.ends_on, nowIso(), row.code);
  let pin = null, toDefault = false;
  if (b.resetPin && b.toDefault && (await getMeta(env, 'default_pin'))) {
    // Back to the first-time PIN: their own PIN stops working and they choose a new one at their next sign-in.
    await run(env, 'UPDATE staff SET pin_hash=NULL, pin_salt=NULL, must_change=1, pin_version=COALESCE(pin_version,0)+1, updated_at=? WHERE code=?', nowIso(), code);
    toDefault = true;
  } else if (b.resetPin) { pin = randomPin(); row = await setStaffPin(env, code, pin, true); }
  await audit(env, me, 'staff', `${code}${b.roles ? ' roles ' + row.roles : ''}${b.active !== undefined ? (b.active ? ' switched on' : ' switched off') : ''}${pin ? ' PIN reset' : ''}${toDefault ? ' back to the first-time PIN' : ''}`);
  await bumpRoster(env);
  return { ok: true, staff: staffPublic(await getStaff(env, code)), pin, toDefault };
}

/* ---------- trainer registers ---------- */
function finalMarks(s, accepted) {
  const out = {};
  for (const m of s.marks || []) out[m.admNo] = { admNo: m.admNo, name: m.name, status: m.status, source: m.explicit ? 'trainer' : 'default' };
  // qrFolded: accepted check-ins of old lessons, moved into the lesson itself to keep the database small.
  for (const [adm, c] of Object.entries({ ...(s.qrFolded || {}), ...(accepted || {}) })) {
    if (out[adm]?.source === 'trainer') continue;
    out[adm] = { admNo: adm, name: out[adm]?.name || c.name, status: 'Present', source: 'qr' };
  }
  return Object.values(out);
}
/** {sessionId: {admNo: {name, scannedAt}}} from check-in rows (only accepted ones count). */
function acceptedOf(rows) {
  const map = {};
  for (const r of rows) if (r.status === undefined || r.status === 'accepted') (map[r.session_id] = map[r.session_id] || {})[r.adm_no] = { name: r.name, scannedAt: r.scanned_at };
  return map;
}
async function acceptedMap(env, ids) {
  const map = {};
  if (!ids.length) return map;
  for (const r of await all(env, `SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN ${IN}`, JSON.stringify(ids))) {
    (map[r.session_id] = map[r.session_id] || {})[r.adm_no] = { name: r.name, scannedAt: r.scanned_at };
  }
  return map;
}
function sessionRow(s, accepted, term, now) {
  const c = { P: 0, A: 0, L: 0, E: 0 };
  for (const m of finalMarks(s, accepted)) { const k = STATUS_CODE[m.status]; if (k) c[k]++; }
  const counted = c.P + c.L + c.A;
  return {
    id: s.sessionId, date: s.date, class_code: s.classCode, unit_code: s.unitCode, unit_name: s.unitName, period: s.period,
    trainer_id: s.trainerId, trainer_name: s.trainerName, present: c.P, absent: c.A, late: c.L, excused: c.E, total: c.P + c.A + c.L + c.E,
    pct: counted ? Math.round(((c.P + c.L) / counted) * 1000) / 10 : null, updated_at: s.updatedAt || '', synced_at: now,
    term_id: s.termId || term?.id || '', week: Number(s.week) || (term ? weekOf(term, s.date) : null), data: JSON.stringify(s),
    kind: ['cat', 'extra'].includes(s.kind) ? s.kind : 'lesson', slots: Number(s.slots) === 2 ? 2 : 1,
  };
}
const SCOLS = ['id', 'date', 'class_code', 'unit_code', 'unit_name', 'period', 'trainer_id', 'trainer_name', 'present', 'absent', 'late', 'excused', 'total', 'pct', 'updated_at', 'synced_at', 'term_id', 'week', 'data', 'kind', 'slots'];

const pushList = (sessions) => sessions.filter((s) => s && s.sessionId).slice(0, 50);
/** Read together with the sign-in check: the stored copies, the term, and check-ins for these lessons. */
function pushPre(sessions) {
  const J = JSON.stringify(pushList(sessions).map((s) => s.sessionId));
  return [[`SELECT id, updated_at, term_id, data FROM sessions WHERE id IN ${IN}`, J], [TERM_SQL],
    [`SELECT * FROM checkins WHERE session_id IN ${IN} AND status IN ('accepted','pending')`, J],
    [`SELECT term_id, class_code, unit_code FROM unlocks WHERE ${UNLOCK_LIVE}`]];
}
async function pushSessions(env, sessions, me, pre) {
  sessions = pushList(sessions);
  const [old, termRows, cis, unlockRows] = pre.rows;
  const prev = new Map(old.map((r) => [r.id, r]));
  const activeId = termRows[0]?.id || '';
  const open = new Set(unlockRows.map((r) => `${r.term_id}|${r.class_code}|${r.unit_code}`));
  const results = [], fresh = [];
  for (const s of sessions) {
    const had = prev.get(s.sessionId);
    // A register from a term that has ended stays as it was, unless the HOD or MIS Officer unlocked it. One the
    // server has never seen (a device that was offline when the term ended) is still taken in: that is not a change.
    const termId = had?.term_id || s.termId || '';
    if (had && termId && activeId && termId !== activeId && !open.has(`${termId}|${s.classCode}|${s.unitCode}`)) {
      results.push({ sessionId: s.sessionId, status: 'locked' }); continue;
    }
    // Two devices (or a device that was offline a long time) can both have changed this register: every
    // student keeps the mark that was set last, wherever it was set, so neither copy undoes the other.
    const out = had ? mergeRegisters(JSON.parse(had.data), s) : s;
    out.uploadedBy = me.code;
    fresh.push(out);
    const differs = had && registerKey(out) !== registerKey(s);
    results.push({ sessionId: s.sessionId, status: !had ? 'added' : differs ? 'merged' : 'updated', ...(differs ? { session: out } : {}) });
  }
  if (!fresh.length) return { ok: true, results };
  // Student check-ins that arrived before this register can be verified now.
  const byId = new Map(fresh.map((s) => [s.sessionId, s]));
  const now = nowIso(), ciWrites = [];
  for (const r of cis) {
    if (r.status !== 'pending' || !byId.has(r.session_id)) continue;
    const v = await verifyCode({ sessionId: r.session_id, w: r.w, token: r.code }, byId.get(r.session_id));
    if (v === null) continue;
    Object.assign(r, { status: v ? 'accepted' : 'rejected', reason: v ? '' : 'invalid-code', updated_at: now });
    ciWrites.push(r);
  }
  const accepted = acceptedOf(cis.filter((r) => r.status === 'accepted'));
  const term = termOut(termRows[0]);
  await many(env, ...upsertStmts('sessions', SCOLS, fresh.map((s) => sessionRow(s, accepted[s.sessionId], term, now)), ['id']),
    ...upsertStmts('checkins', CICOLS, ciWrites, CIKEY), ciWrites.some((r) => r.status === 'accepted') && changedStmt());
  return { ok: true, results };
}

/** Two copies of one register made one: each student's latest mark wins; the edit history of both is kept. */
function mergeRegisters(a, b) {
  const newer = String(b.updatedAt || '') >= String(a.updatedAt || '') ? b : a, older = newer === b ? a : b;
  const best = new Map();
  [older, newer].forEach((s, rank) => {
    for (const m of s.marks || []) {
      const at = m.at || s.createdAt || '', k = lower(m.admNo), had = best.get(k);
      if (!had || at > had.at || (at === had.at && rank >= had.rank)) best.set(k, { m: { ...m, at }, at, rank });
    }
  });
  const logs = new Map();
  for (const l of [...(a.editLog || []), ...(b.editLog || [])]) logs.set(`${l.at}|${l.device || ''}|${l.reason || ''}`, l);
  const marks = [...best.values()].map((x) => x.m);
  const counts = { P: 0, A: 0, L: 0, E: 0 };
  for (const m of marks) { const k = STATUS_CODE[m.status]; if (k) counts[k]++; }
  const created = [a.createdAt, b.createdAt].filter(Boolean).sort()[0] || '';
  return { ...older, ...newer, marks, counts, createdAt: created, updatedAt: newer.updatedAt || older.updatedAt || '',
    editLog: [...logs.values()].sort((x, y) => String(x.at).localeCompare(String(y.at))), edits: logs.size,
    viaQr: { ...(older.viaQr || {}), ...(newer.viaQr || {}) }, qrFolded: { ...(older.qrFolded || {}), ...(newer.qrFolded || {}) },
    qr: newer.qr || older.qr, notes: newer.notes || older.notes || '' };
}
/** What a trainer sees of a register: whether the merged copy differs from the one a device sent. */
const registerKey = (s) => JSON.stringify([(s.marks || []).map((m) => `${lower(m.admNo)}=${m.status}`).sort(), s.notes || '']);

/** Every register this trainer has on the server, a page at a time (in the order they reached it), for their other devices. */
async function mySessions(env, b, me) {
  const at = String(b.cursor?.at || ''), id = String(b.cursor?.id || '');
  const rows = await all(env, `SELECT id, data, synced_at FROM sessions WHERE trainer_id=? AND (synced_at > ? OR (synced_at = ? AND id > ?))
    ORDER BY synced_at, id LIMIT ${PULL_PAGE}`, me.code, at, at, id);
  const last = rows[rows.length - 1];
  return { ok: true, sessions: rows.map((r) => r.data), cursor: last ? { at: last.synced_at, id: last.id } : { at, id }, more: rows.length === PULL_PAGE };
}
const PULL_PAGE = 120;

/* ---------- terms that have ended: locked, unless the HOD or MIS Officer unlocks a class and unit ---------- */
const UNLOCK_LIVE = "(until IS NULL OR until = '' OR until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
async function setUnlock(env, b, me, on) {
  const termId = String(b.termId || ''), cls = String(b.classCode || ''), unit = String(b.unitCode || '');
  if (!termId || !cls || !unit) fail('Choose the term, class and unit');
  const term = await one(env, 'SELECT id, status FROM terms WHERE id=?', termId);
  if (!term) fail('That term does not exist');
  if (on) {
    const days = Math.min(60, Math.max(1, Number(b.days) || 7));
    const until = new Date(Date.now() + days * 864e5).toISOString();
    await run(env, `INSERT INTO unlocks (term_id,class_code,unit_code,by_code,by_name,at,until) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(term_id,class_code,unit_code) DO UPDATE SET by_code=excluded.by_code, by_name=excluded.by_name, at=excluded.at, until=excluded.until`,
    termId, cls, unit, me.code, me.name, nowIso(), until);
    await audit(env, me, 'unlock', `${termId} ${cls} ${unit} for ${days} day(s)`);
  } else {
    await run(env, 'DELETE FROM unlocks WHERE term_id=? AND class_code=? AND unit_code=?', termId, cls, unit);
    await audit(env, me, 'relock', `${termId} ${cls} ${unit}`);
  }
  await bumpRoster(env);
  return { ok: true };
}
const unlockedSet = async (env) => new Set((await all(env, `SELECT term_id, class_code, unit_code FROM unlocks WHERE ${UNLOCK_LIVE}`))
  .map((r) => `${r.term_id}|${r.class_code}|${r.unit_code}`));

/** The class-units of any term: the trainer's own (or, for the HOD and MIS Officer, all), for looking back at earlier terms. */
async function termUnits(env, b, me) {
  const termId = String(b.termId || '');
  const term = termOut(termId ? await one(env, 'SELECT * FROM terms WHERE id=?', termId) : await one(env, TERM_SQL));
  if (!term) fail('That term does not exist');
  const rows = await all(env, 'SELECT * FROM loading WHERE term_id=? ORDER BY class_code, unit_code', term.id);
  const mine = seesAll(me) ? rows : rows.filter((r) => lower(r.trainer_code) === lower(me.code));
  return { ok: true, term, weeks: teachingWeeks(term),
    units: mine.map((r) => ({ classCode: r.class_code, code: r.unit_code, name: r.unit_name || r.unit_code, trainerCode: r.trainer_code, trainerName: r.trainer_name,
      lessonsPerWeek: Number(r.lessons_per_week) || 2, hoursPerWeek: Number(r.hours_per_week) || 3 })) };
}

/* ---------- absences: students who have missed more lessons of a unit than the limit ---------- */
async function absenceLimit(env) { return Math.max(0, Math.round(Number(await getMeta(env, 'absence_limit')) || 3)); }
async function setAbsenceLimit(env, b, me) {
  const n = Math.max(0, Math.min(60, Math.round(Number(b.limit))));
  if (!Number.isFinite(n)) fail('Enter a number of lessons');
  await setMeta(env, 'absence_limit', String(n));
  await audit(env, me, 'absence limit', String(n));
  return { ok: true, limit: n };
}
/** Counted in the database from the registers' marks (a double counts as two lessons), so the Worker does little work. */
async function absences(env, b, me) {
  const term = termOut(b.termId ? await one(env, 'SELECT * FROM terms WHERE id=?', String(b.termId)) : await one(env, TERM_SQL));
  if (!term) return { ok: true, term: null, limit: await absenceLimit(env), rows: [] };
  const limit = b.limit !== undefined && b.limit !== '' ? Math.max(0, Math.round(Number(b.limit) || 0)) : await absenceLimit(env);
  const [missed, held, loading, archived] = await many(env,
    [`SELECT s.class_code, s.unit_code, MAX(s.unit_name) AS unit_name, json_extract(m.value,'$.admNo') AS adm, MAX(json_extract(m.value,'$.name')) AS name,
      SUM(CASE WHEN json_extract(m.value,'$.status')='Absent' THEN COALESCE(s.slots,1) ELSE 0 END) AS missed,
      SUM(CASE WHEN json_extract(m.value,'$.status') IN ('Present','Late') THEN COALESCE(s.slots,1) ELSE 0 END) AS attended
      FROM sessions s, json_each(s.data, '$.marks') m
      WHERE s.term_id=? AND COALESCE(s.kind,'lesson')='lesson'
      GROUP BY s.class_code, s.unit_code, adm HAVING missed > ?`, term.id, limit],
    [`SELECT class_code, unit_code, SUM(COALESCE(slots,1)) AS held FROM sessions WHERE term_id=? AND COALESCE(kind,'lesson')='lesson' GROUP BY class_code, unit_code`, term.id],
    ['SELECT class_code, unit_code, unit_name, trainer_name FROM loading WHERE term_id=?', term.id], ["SELECT code FROM classes WHERE status='archived'"]);
  const gone = new Set(archived.map((r) => r.code));
  const heldOf = new Map(held.map((r) => [r.class_code + '|' + r.unit_code, r.held]));
  const load = new Map(loading.map((r) => [r.class_code + '|' + r.unit_code, r]));
  const rows = missed.filter((r) => r.adm && !gone.has(r.class_code)).map((r) => {
    const k = r.class_code + '|' + r.unit_code, l = load.get(k) || {}, h = Number(heldOf.get(k)) || 0;
    return { classCode: r.class_code, unitCode: r.unit_code, unitName: l.unit_name || r.unit_name || r.unit_code, trainerName: l.trainer_name || '',
      admNo: r.adm, name: r.name || r.adm, missed: Number(r.missed) || 0, held: h, pct: h ? Math.round(((Number(r.attended) || 0) / h) * 100) : null };
  });
  return { ok: true, term, limit, rows };
}

/* ---------- archiving and deleting a class (the MIS Officer) ---------- */
const codesOf = (b) => [...new Set((b.codes || []).map((c) => String(c || '').trim()).filter(Boolean))].slice(0, 50);
async function archiveClasses(env, b, me) {
  const codes = codesOf(b);
  if (!codes.length) fail('Choose a class');
  const on = b.archive !== false, J = JSON.stringify(codes), now = nowIso();
  await many(env, [`INSERT OR IGNORE INTO classes (code, name, level) SELECT value, value, '' FROM json_each(?)`, J],
    [`UPDATE classes SET status=?, archived_at=?, archived_by=? WHERE code IN ${IN}`, on ? 'archived' : 'active', on ? now : null, on ? me.name : null, J]);
  await audit(env, me, on ? 'archive class' : 'restore class', codes.join(', '));
  await bumpRoster(env);
  return { ok: true, codes, archived: on };
}
/** Everything kept about these classes, for a file the MIS Officer saves before deleting them. */
async function classExport(env, b, me) {
  const codes = codesOf(b);
  if (!codes.length) fail('Choose a class');
  const J = JSON.stringify(codes);
  const [classes, trainees, loading, sessions, checkins, marks, oldMarks, signoffs, evidence, requests, devices] = await many(env,
    [`SELECT * FROM classes WHERE code IN ${IN}`, J], [`SELECT * FROM trainees WHERE class_code IN ${IN}`, J], [`SELECT * FROM loading WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM sessions WHERE class_code IN ${IN}`, J], [`SELECT * FROM checkins WHERE session_id IN (SELECT id FROM sessions WHERE class_code IN ${IN})`, J],
    [`SELECT * FROM unit_marks WHERE class_code IN ${IN}`, J], [`SELECT * FROM marks WHERE class_code IN ${IN}`, J], [`SELECT * FROM signoffs WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM evidence WHERE class_code IN ${IN}`, J], [`SELECT * FROM requests WHERE class_code IN ${IN}`, J], [`SELECT * FROM devices WHERE class_code IN ${IN}`, J]);
  await audit(env, me, 'class export', codes.join(', '));
  return { ok: true, app: 'rvnp-class-export', exportedAt: nowIso(), by: me.name, codes,
    tables: { classes, trainees, loading, sessions, checkins, marks, oldMarks, signoffs, evidence, requests, devices } };
}
async function deleteClasses(env, b, me) {
  const codes = codesOf(b);
  if (!codes.length) fail('Choose a class');
  const J = JSON.stringify(codes);
  const rows = await all(env, `SELECT code, status FROM classes WHERE code IN ${IN}`, J);
  if (rows.length !== codes.length || rows.some((r) => r.status !== 'archived')) fail('Archive a class before deleting it');
  if (String(b.confirm || '').trim().toLowerCase() !== String(b.label || codes[0]).trim().toLowerCase()) fail('Type the class name exactly to confirm');
  const SESS = `(SELECT id FROM sessions WHERE class_code IN ${IN})`, ADMS = `(SELECT adm_no FROM trainees WHERE class_code IN ${IN})`;
  // The Google Drive copies (attendance sheets, marksheets, students' evidence files) are never touched.
  await many(env, [`DELETE FROM checkins WHERE session_id IN ${SESS}`, J], [`DELETE FROM sessions WHERE class_code IN ${IN}`, J],
    [`DELETE FROM unit_marks WHERE class_code IN ${IN}`, J], [`DELETE FROM marks WHERE class_code IN ${IN}`, J], [`DELETE FROM signoffs WHERE class_code IN ${IN}`, J],
    [`DELETE FROM unlocks WHERE class_code IN ${IN}`, J], [`DELETE FROM loading WHERE class_code IN ${IN}`, J], [`DELETE FROM units WHERE class_code IN ${IN}`, J],
    [`DELETE FROM push_subs WHERE adm_no IN ${ADMS}`, J], [`DELETE FROM devices WHERE class_code IN ${IN}`, J], [`DELETE FROM evidence WHERE class_code IN ${IN}`, J],
    [`DELETE FROM requests WHERE class_code IN ${IN}`, J], [`DELETE FROM trainees WHERE class_code IN ${IN}`, J], [`DELETE FROM classes WHERE code IN ${IN}`, J],
    ["DELETE FROM meta WHERE key='pub_classes'"]);
  await audit(env, me, 'delete class', codes.join(', '));
  await bumpRoster(env);
  return { ok: true, deleted: codes };
}

/* ---------- reports, sign-off and overview ---------- */
async function teachesUnit(env, me, classCode, unitCode, term) {
  if (me.roles.includes('HOD') || me.roles.includes('MIS')) return true;
  if (!term) return true;
  const any = await one(env, 'SELECT 1 FROM loading WHERE term_id=? LIMIT 1', term.id);
  if (!any) return true; // no loading yet: trainers can see the lessons they marked
  return !!(await one(env, 'SELECT 1 FROM loading WHERE term_id=? AND class_code=? AND unit_code=? AND trainer_code=?', term.id, classCode, unitCode, me.code));
}

/** Read together with the sign-in check: everything one term register needs. */
function reportPre(b) {
  const c = String(b.classCode || ''), u = String(b.unitCode || ''), tid = String(b.termId || '');
  // An earlier term when one is asked for, otherwise the term that is running.
  const TERM = tid ? ['SELECT * FROM terms WHERE id=?', tid] : [TERM_SQL], T = tid ? '?' : ACTIVE_TERM, tp = tid ? [tid] : [];
  return [TERM, [`SELECT 1 AS x FROM loading WHERE term_id=${T} LIMIT 1`, ...tp], [`SELECT * FROM loading WHERE term_id=${T} AND class_code=? AND unit_code=?`, ...tp, c, u],
    ['SELECT id, date, data FROM sessions WHERE class_code=? AND unit_code=?', c, u],
    ["SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN (SELECT id FROM sessions WHERE class_code=? AND unit_code=?)", c, u],
    ['SELECT * FROM signoffs WHERE class_code=? AND unit_code=?', c, u],
    [TERM_SQL], [`SELECT 1 AS x FROM loading WHERE term_id=${ACTIVE_TERM} AND class_code=? AND unit_code=?`, c, u],
    [`SELECT 1 AS x FROM unlocks WHERE term_id=${T} AND class_code=? AND unit_code=? AND ${UNLOCK_LIVE}`, ...tp, c, u]];
}
/** Every lesson of one class and unit this term, with final marks, for the term register. */
async function reportData(env, b, me, pre) {
  if (!b.classCode || !b.unitCode) fail('Choose a class and a unit');
  const [termRows, anyLoading, loadRows, sessRows, acc, soRows, activeRows, nowLoad, unlockRow] = pre.rows;
  const term = termOut(termRows[0]), load = loadRows[0] || null;
  if (b.termId && !term) fail('That term does not exist');
  const staffOnly = !seesAll(me);
  const ended = !!(term && activeRows[0] && term.id !== activeRows[0].id);
  // A trainer sees the units they taught that term; whoever teaches the unit now also sees its earlier terms.
  const teachesNow = ended && nowLoad.length && !!(await one(env, `SELECT 1 FROM loading WHERE term_id=${ACTIVE_TERM} AND class_code=? AND unit_code=? AND trainer_code=?`, b.classCode, b.unitCode, me.code));
  if (staffOnly && term && anyLoading.length && !(load && lower(load.trainer_code) === lower(me.code)) && !teachesNow) fail('You can only see reports for the units in your loading');
  const weeks = teachingWeeks(term);
  let from = '0000-00-00', to = '9999-12-31';
  if (weeks.length) { from = weeks[0]; const e = new Date(weeks[weeks.length - 1] + 'T00:00:00Z'); e.setUTCDate(e.getUTCDate() + 6); to = e.toISOString().slice(0, 10); }
  const accepted = acceptedOf(acc);
  const lessons = sessRows.filter((r) => r.date >= from && r.date <= to).map((r) => {
    const s = JSON.parse(r.data);
    const marks = {}, names = {};
    for (const m of finalMarks(s, accepted[r.id])) { const k = STATUS_CODE[m.status]; if (k) { marks[m.admNo] = k; names[m.admNo] = m.name; } }
    return { id: r.id, date: s.date, period: s.period, slots: Number(s.slots) === 2 ? 2 : 1, kind: s.kind || 'lesson', title: s.title || '',
      trainerId: s.trainerId, trainerName: s.trainerName, updatedAt: s.updatedAt, marks, names };
  });
  const so = soRows.find((r) => r.id === signoffId(term, b.classCode, b.unitCode));
  return { ok: true, term, weeks, lessons, serverTime: nowIso(), signoff: so ? signoffOut(so) : null, ended, unlocked: unlockRow.length > 0,
    loading: load ? { trainerCode: load.trainer_code, trainerName: load.trainer_name, unitName: load.unit_name, lessonsPerWeek: Number(load.lessons_per_week) || 2, hoursPerWeek: Number(load.hours_per_week) || 3 } : null };
}

const signoffId = (term, c, u) => `${term ? term.id : 'no-term'}|${c}|${u}`;
const signoffOut = (r) => ({ id: r.id, classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name, trainerCode: r.trainer_code, trainerName: r.trainer_name,
  lecturerComment: r.lecturer_comment, submittedAt: r.submitted_at, status: r.status, hodName: r.hod_name, hodComment: r.hod_comment, decidedAt: r.decided_at,
  approvalRef: r.status === 'approved' ? r.approval_ref || '' : '' });

async function submitSignoff(env, b, me) {
  const term = await activeTerm(env);
  if (!(await teachesUnit(env, me, b.classCode, b.unitCode, term))) fail('You can only submit registers for the units in your loading');
  const id = signoffId(term, b.classCode, b.unitCode);
  const old = await one(env, 'SELECT * FROM signoffs WHERE id=?', id);
  if (old && old.status === 'approved' && !b.resubmit) fail('The HOD has already approved this register');
  await run(env, `INSERT INTO signoffs (id,term_id,class_code,unit_code,unit_name,trainer_code,trainer_name,lecturer_comment,submitted_at,status,hod_code,hod_name,hod_comment,decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,NULL) ON CONFLICT(id) DO UPDATE SET trainer_code=excluded.trainer_code, trainer_name=excluded.trainer_name,
    lecturer_comment=excluded.lecturer_comment, submitted_at=excluded.submitted_at, status='submitted', hod_code=NULL, hod_name=NULL, decided_at=NULL`,
  id, term ? term.id : '', b.classCode, b.unitCode, b.unitName || '', me.code, me.name, String(b.comment || '').slice(0, 1000), nowIso(), 'submitted', old?.hod_comment || null);
  return { ok: true, signoff: signoffOut(await one(env, 'SELECT * FROM signoffs WHERE id=?', id)) };
}

async function decideSignoff(env, b, me, pinDone = false) {
  const old = await one(env, 'SELECT * FROM signoffs WHERE id=?', b.id);
  if (!old) fail('That register has not been submitted');
  if (b.decision !== 'approved' && b.decision !== 'returned') fail('Choose approve or return');
  if (b.decision === 'returned' && !String(b.comment || '').trim()) fail('Say what needs fixing when returning a register');
  if (b.decision === 'approved' && !pinDone) await confirmPin(env, me, b.pin);
  const said = String(b.comment || '').trim() || (b.decision === 'approved' ? OK_SAID.register : '');
  await run(env, 'UPDATE signoffs SET status=?, hod_code=?, hod_name=?, hod_comment=?, decided_at=? WHERE id=?', b.decision, me.code, me.name, said.slice(0, 1000), nowIso(), b.id);
  if (b.decision === 'approved') {
    const ref = await makeApproval(env, me, 'HOD', 'register', old.id, `Term register - ${old.unit_code} ${old.unit_name || ''}`.trim(),
      { classCode: old.class_code, unitCode: old.unit_code, unitName: old.unit_name, trainer: old.trainer_name, termId: old.term_id }, await registerPrint(env, old));
    await run(env, 'UPDATE signoffs SET approval_ref=? WHERE id=?', ref, old.id);
  } else await withdrawApprovals(env, 'register', old.id);
  await audit(env, me, 'sign-off', `${b.id} ${b.decision}`);
  return { ok: true, signoff: signoffOut(await one(env, 'SELECT * FROM signoffs WHERE id=?', b.id)) };
}

/** The HOD approves several registers at once (one PIN). Each gets its own approval. */
async function decideSignoffs(env, b, me) {
  const ids = [...new Set((b.ids || []).map(String))].slice(0, BATCH_MAX);
  if (!ids.length) fail('Choose the registers to approve');
  await confirmPin(env, me, b.pin);
  const out = [], failed = [];
  for (const id of ids) {
    try { out.push((await decideSignoff(env, { id, decision: 'approved', comment: b.comment }, me, true)).signoff); } catch (e) { failed.push({ id, error: e.message }); }
  }
  return { ok: true, signoffs: out, failed };
}
async function listSignoffs(env, b, me) {
  const term = b.termId ? termOut(await one(env, 'SELECT * FROM terms WHERE id=?', String(b.termId))) : await activeTerm(env);
  const mine = !me.roles.includes('HOD') && !me.roles.includes('MIS');
  const rows = await all(env, `SELECT * FROM signoffs WHERE (? IS NULL OR term_id=?) ${mine ? 'AND trainer_code=?' : ''} ORDER BY submitted_at DESC`,
    ...(mine ? [term?.id ?? null, term?.id ?? null, me.code] : [term?.id ?? null, term?.id ?? null]));
  return { ok: true, signoffs: rows.map(signoffOut) };
}

/** HOD view: for each class and unit in the loading, how many lessons are marked against how many were due. */
function overviewPre(b = {}) {
  const tid = String(b.termId || '');
  if (tid) {
    return [['SELECT * FROM terms WHERE id=?', tid],
      [`SELECT class_code, unit_code, SUM(COALESCE(slots,1)) AS lessons, MAX(date) AS last, SUM(present+late) AS att, SUM(present+late+absent) AS counted FROM sessions
        WHERE COALESCE(kind,'lesson')='lesson' AND term_id=? GROUP BY class_code, unit_code`, tid],
      ['SELECT class_code, unit_code, status FROM signoffs WHERE term_id=?', tid], ['SELECT * FROM loading WHERE term_id=?', tid], ["SELECT code FROM classes WHERE status='archived'"]];
  }
  return [[TERM_SQL],
    [`SELECT class_code, unit_code, SUM(COALESCE(slots,1)) AS lessons, MAX(date) AS last, SUM(present+late) AS att, SUM(present+late+absent) AS counted FROM sessions
      WHERE COALESCE(kind,'lesson')='lesson' AND (term_id=${ACTIVE_TERM} OR ((term_id IS NULL OR term_id='') AND date >= date((SELECT start_date FROM terms WHERE status='active' ORDER BY updated_at DESC LIMIT 1), '-6 days')))
      GROUP BY class_code, unit_code`],
    [`SELECT class_code, unit_code, status FROM signoffs WHERE term_id=${ACTIVE_TERM}`], [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`], ["SELECT code FROM classes WHERE status='archived'"]];
}
function overview(pre) {
  const [termRows, statRows, soRows, allLoading, archivedRows] = pre.rows;
  const archived = new Set(archivedRows.map((r) => r.code));
  const loading = allLoading.filter((r) => !archived.has(r.class_code));
  const term = termOut(termRows[0]);
  if (!term) return { ok: true, term: null, rows: [] };
  const weeks = teachingWeeks(term), today = todayIso();
  const elapsed = weeks.filter((w) => w <= today).length;
  const stats = new Map(statRows.map((r) => [r.class_code + '|' + r.unit_code, r]));
  const so = new Map(soRows.map((r) => [r.class_code + '|' + r.unit_code, r.status]));
  const rows = loading.map((r) => {
    const k = r.class_code + '|' + r.unit_code, s = stats.get(k) || { lessons: 0, last: '', att: 0, counted: 0 };
    return { classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name, trainerCode: r.trainer_code, trainerName: r.trainer_name,
      lessons: s.lessons, due: elapsed * (Number(r.lessons_per_week) || 2), last: s.last || '', pct: s.counted ? Math.round((s.att / s.counted) * 100) : null, signoff: so.get(k) || '' };
  });
  return { ok: true, term, week: elapsed, rows };
}

/* ---------- QR check-ins from student phones ---------- */
/** true = code genuine, false = fake or expired, null = cannot tell yet (trainer has not synced that lesson). */
async function verifyCode(c, s) {
  if (!s || !s.qr || !s.qr.secret) return null;
  const w = Number(c.w);
  if (!Number.isFinite(w)) return false;
  const intervals = s.qr.intervals || [];
  const inRange = intervals.some((iv) => w >= iv[0] - 1 && w <= iv[1] + 1);
  const genuine = (await hmacHex(`${c.sessionId}|${w}`, s.qr.secret)).slice(0, CODE_LENGTH) === String(c.token || '').toLowerCase();
  if (!inRange) {
    const lastEnd = intervals.reduce((m, iv) => Math.max(m, iv[1]), -Infinity);
    if (w <= lastEnd + 1) return false;
    // Shown after the trainer's phone last uploaded: a genuine code for (about) right now is accepted at once.
    const nowW = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    if (genuine && Math.abs(w - nowW) <= 3) return true;
    return null;
  }
  return genuine;
}

const CICOLS = ['session_id', 'adm_no', 'device_id', 'name', 'w', 'code', 'scanned_at', 'updated_at', 'status', 'reason'];
const CIKEY = ['session_id', 'adm_no', 'device_id'];
const ciId = (r) => `${r.session_id}|${r.adm_no}|${r.device_id}`;

async function receiveCheckins(env, list) {
  list = list.filter((c) => c && c.sessionId && c.admNo && c.deviceId).slice(0, 200);
  if (!list.length) return { ok: true, results: [] };
  const now = nowIso();
  const adms = JSON.stringify(list.map((c) => String(c.admNo))), sids = JSON.stringify([...new Set(list.map((c) => c.sessionId))]);
  // Everything needed is read in one trip, and everything changed is written in one more.
  const [tRows, dRows, aRows, cRows, sRows, termRows] = await many(env, [`SELECT * FROM trainees WHERE adm_no IN ${IN}`, adms],
    [`SELECT * FROM devices WHERE device_id IN ${IN}`, JSON.stringify(list.map((c) => c.deviceId))], [`SELECT * FROM devices WHERE adm_no IN ${IN}`, adms],
    [`SELECT * FROM checkins WHERE session_id IN ${IN}`, sids], [`SELECT id, data FROM sessions WHERE id IN ${IN}`, sids], [TERM_SQL]);
  const trainees = new Map(tRows.map((r) => [lower(r.adm_no), r]));
  const devById = new Map(dRows.map((r) => [r.device_id, r]));
  const devByAdm = new Map(aRows.map((r) => [lower(r.adm_no), r]));
  const ids = list.map((c) => { const t = trainees.get(lower(c.admNo)); return `${c.sessionId}|${t ? t.adm_no : c.admNo}|${c.deviceId}`; });
  const existing = new Map(cRows.map((r) => [ciId(r), r]));
  const sessions = new Map(sRows.map((r) => [r.id, JSON.parse(r.data)]));
  const results = [], ciWrites = [], devWrites = new Map(), touched = new Set();
  for (let i = 0; i < list.length; i++) {
    const c = list[i], t = trainees.get(lower(c.admNo)), adm = t ? t.adm_no : String(c.admNo), id = ids[i];
    const row = existing.get(id) || { session_id: c.sessionId, adm_no: adm, device_id: c.deviceId, name: t ? t.name : '',
      w: String(c.w), code: String(c.token || ''), scanned_at: c.scannedAt || '', updated_at: '', status: '', reason: '' };
    if (row.status !== 'accepted') {
      let status, reason = '';
      if (!t || !active(t)) { status = 'rejected'; reason = 'unknown-student'; }
      else if (!classParts(classFromSession(c.sessionId)).includes(t.class_code)) { status = 'rejected'; reason = 'wrong-class'; }
      else {
        const di = devById.get(c.deviceId), ai = devByAdm.get(lower(adm));
        if (di && lower(di.adm_no) !== lower(adm)) { status = 'rejected'; reason = 'device-other-student'; }
        else if (ai && ai.device_id !== c.deviceId) { status = 'rejected'; reason = 'student-other-device'; }
        else {
          // Normally registered at first login; a first submission from an unregistered phone registers it too.
          const reg = { device_id: c.deviceId, adm_no: adm, name: t.name, class_code: t.class_code, registered_at: di?.registered_at || now, last_seen: now };
          devWrites.set(c.deviceId, reg); devById.set(c.deviceId, reg); devByAdm.set(lower(adm), reg);
          const v = await verifyCode({ sessionId: c.sessionId, w: row.w, token: row.code }, sessions.get(c.sessionId));
          status = v === null ? 'pending' : (v ? 'accepted' : 'rejected');
          if (v === false) reason = 'invalid-code';
        }
      }
      if (!existing.has(id) || row.status !== status || row.reason !== reason) { Object.assign(row, { status, reason, updated_at: now }); ciWrites.push(row); existing.set(id, row); }
    }
    if (row.status === 'accepted') touched.add(c.sessionId);
    results.push({ id, status: row.status, reason: row.reason, name: t ? t.name : '', classCode: t ? t.class_code : '' });
  }
  // Lessons with newly accepted check-ins get their counts updated in the same write.
  const newly = [...new Set(ciWrites.filter((r) => r.status === 'accepted').map((r) => r.session_id))].filter((id) => sessions.has(id));
  const accepted = acceptedOf([...existing.values()].filter((r) => r.status === 'accepted'));
  const term = termOut(termRows[0]);
  await many(env, ...upsertStmts('checkins', CICOLS, ciWrites, CIKEY),
    ...upsertStmts('devices', ['device_id', 'adm_no', 'name', 'class_code', 'registered_at', 'last_seen'], [...devWrites.values()], ['device_id'], ['last_seen']),
    newly.length && changedStmt(), ...upsertStmts('sessions', SCOLS, newly.map((id) => sessionRow(sessions.get(id), accepted[id], term, now)), ['id']));
  return { ok: true, results };
}



/**
 * Keeps the database small for years: once a lesson is 5 months old (trainer phones stop asking about
 * check-ins after 4), its accepted QR check-ins are written into the lesson itself and the rows removed.
 * Runs at most once a day, in small batches, after a class list request.
 */
const FOLD_DAYS = 150;
export async function foldOldCheckins(env, force = false) {
  const last = await getMeta(env, 'fold_at');
  if (!force && last && last > new Date(Date.now() - 864e5).toISOString()) return 0;
  const cutoff = new Date(Date.now() - FOLD_DAYS * 864e5).toISOString();
  const ids = (await all(env, "SELECT DISTINCT session_id FROM checkins INDEXED BY checkins_updated WHERE updated_at < ? AND status IN ('accepted','rejected') LIMIT 100", cutoff)).map((r) => r.session_id);
  if (ids.length < 100) await setMeta(env, 'fold_at', nowIso()); // otherwise carry on next time
  if (!ids.length) return 0;
  const J = JSON.stringify(ids);
  const sessions = await all(env, `SELECT id, data FROM sessions WHERE id IN ${IN}`, J);
  const accepted = await acceptedMap(env, ids);
  const writes = [];
  for (const r of sessions) {
    if (!accepted[r.id]) continue;
    const s = JSON.parse(r.data);
    s.qrFolded = { ...(s.qrFolded || {}), ...accepted[r.id] };
    writes.push({ id: r.id, data: JSON.stringify(s) });
  }
  if (writes.length) await upsertMany(env, 'sessions', ['id', 'data'], writes, ['id'], ['data']);
  // Pending check-ins stay: their lesson has not reached the server yet.
  await run(env, `DELETE FROM checkins WHERE session_id IN ${IN} AND updated_at < ? AND status IN ('accepted','rejected')`, J, cutoff);
  return ids.length;
}

/** For the trainer's phone: check-ins accepted since its last check (all of them when since is empty).
 * With "since", only the recent check-ins are read (a few rows) instead of every check-in of these lessons. */
function checkinsQuery(ids, since) {
  if (!ids.length) return ['SELECT 1 AS x WHERE 0'];
  return since ? ["SELECT session_id, adm_no, name, scanned_at FROM checkins INDEXED BY checkins_updated WHERE updated_at > ? AND status='accepted'", since]
    : [`SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN ${IN}`, JSON.stringify(ids.slice(0, 2000))];
}
function acceptedCheckins(ids, rows) {
  const want = new Set(ids.slice(0, 2000));
  const out = {};
  let count = 0;
  for (const r of rows) {
    if (!want.has(r.session_id)) continue;
    (out[r.session_id] = out[r.session_id] || []).push({ admNo: r.adm_no, name: r.name, scannedAt: r.scanned_at });
    count++;
  }
  return { ok: true, serverTime: nowIso(), count, checkins: out };
}

/* ====================== Google Drive bridge and POE evidence ======================
 * The Drive bridge is a small Apps Script web app (apps-script/DriveBridge.gs) running under the school's
 * Google Workspace account. It is the only part that touches Drive:
 *   - every few minutes it asks this Worker what changed (bridgeFeed) and updates each trainer's attendance
 *     sheet and the index of approved evidence;
 *   - student phones send their evidence PDFs straight to it, with an upload ticket signed here;
 *   - trainers' phones fetch a file to preview with a view ticket signed here.
 * Both sides share the BRIDGE_SECRET (a Worker secret, and a Script Property on the bridge). */
const ITEMS = ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'PRAC1', 'PRAC2', 'PRAC3'];
const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
const b64u = (str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (t) => decodeURIComponent(escape(atob(t.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (t.length % 4)) % 4))));
function bridgeSecret(env) {
  if (!env.BRIDGE_SECRET) fail('The Google Drive link is not set up yet: the MIS Officer adds the BRIDGE_SECRET to the Worker (README → Google Drive).');
  return String(env.BRIDGE_SECRET);
}
async function signTicket(env, payload) {
  const body = b64u(JSON.stringify(payload));
  return body + '.' + (await hmacHex(body, bridgeSecret(env)));
}
async function readTicket(env, ticket, kind, { late = false } = {}) {
  const [body, sig] = String(ticket || '').split('.');
  if (!body || !sig || (await hmacHex(body, bridgeSecret(env))) !== sig) fail('That upload ticket is not valid');
  const t = JSON.parse(unb64u(body));
  if (t.k !== kind) fail('That ticket is for something else');
  if (!late && t.exp < Date.now()) fail('That ticket has expired; try again');
  return t;
}
// Folder names keep the admission number as written (L6CS/25S/304001 - Name); Drive allows "/" in names.
const folderName = (s) => String(s || '').replace(/[\\:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

/* ---------- requests from the bridge ---------- */
async function verifyBridge(env, b) {
  const ts = Number(b.ts) || 0;
  if (Math.abs(Date.now() - ts) > 15 * 6e4) fail('Bridge request is too old (check the clock)');
  if ((await hmacHex(`${b.action}|${ts}|${b.body || ''}`, bridgeSecret(env))) !== b.sig) fail('Bridge signature does not match: the BRIDGE_SECRET differs');
  return JSON.parse(b.body || '{}');
}
const BRIDGE_ACTIONS = {
  bridgeFeed: async (env, b) => bridgeFeed(env, await verifyBridge(env, b)),
  bridgeReport: async (env, b) => {
    const r = await verifyBridge(env, b);
    await many(env, metaStmt('drive_report', JSON.stringify({ ...r, at: nowIso() })), r.url && metaStmt('drive_url', r.url));
    return { ok: true };
  },
  backupJob: async (env, b) => backupJob(env, await verifyBridge(env, b)),
  backupDone: async (env, b) => backupDone(env, await verifyBridge(env, b)),
  groupsJob: async (env, b) => { await verifyBridge(env, b); return groupsJob(env); },
  groupsDone: async (env, b) => groupsDone(env, await verifyBridge(env, b)),
};

/* ---------- backup: approved documents copied into the backup account's Drive ----------
 * The bridge runs as the backup account (ictpoe), which every student file is shared with. On each run it asks
 * whether a backup is due (the HOD or MIS Officer tapped "Back up now", or the repeat setting says so), copies
 * a batch, and reports. It also reports the account's storage: from 80% the HOD and MIS Officer are warned, and at
 * 95% backups pause so the Drive never fills up halfway through. */
const BACKUP_WARN = 0.8, BACKUP_STOP = 0.95, BACKUP_BATCH = 60, BACKUP_TRIES = 3;
const nairobi = (iso) => new Date((iso ? Date.parse(iso) : Date.now()) + 3 * 3600e3);   // East Africa Time, no daylight saving
const readJson = (v, d) => { try { return JSON.parse(v || '') || d; } catch { return d; } };
function backupDue(plan, rep) {
  if (plan.nowAt && plan.nowAt > (rep.startedAt || '')) return true;
  if (rep.running) return true;
  const repeat = plan.repeat || 'off';
  if (repeat === 'off') return false;
  const now = nairobi(), hour = Number(plan.hour ?? 18);
  if (now.getUTCHours() < hour) return false;
  if (!rep.startedAt) return true;
  const last = nairobi(rep.startedAt);
  if (repeat === 'daily') return last.toISOString().slice(0, 10) < now.toISOString().slice(0, 10);
  if (repeat === 'weekly') return Date.now() - Date.parse(rep.startedAt) > 6.5 * 86400e3;
  if (repeat === 'monthly') return last.toISOString().slice(0, 7) < now.toISOString().slice(0, 7);
  return false;
}
const WAITING_SQL = `SELECT COUNT(*) AS n FROM evidence WHERE status='approved' AND source='drive' AND archived_at IS NULL AND COALESCE(archive_tries,0) < ${BACKUP_TRIES}`;
async function backupJob(env, q) {
  const [planRow, repRow, archive, quota] = await many(env, ["SELECT value FROM meta WHERE key='backup_plan'"], ["SELECT value FROM meta WHERE key='backup_report'"],
    ["SELECT value FROM meta WHERE key='archive_email'"], ["SELECT value FROM meta WHERE key='backup_quota_gb'"]);
  const plan = readJson(planRow[0]?.value, {}), rep = readJson(repRow[0]?.value, {});
  // The storage reading is kept every time, so the gauge stays current even when nothing is due. The limit is the
  // space the college gave the account (typed in Manage): with pooled storage Google only reports the college's total.
  const limit = (Number(quota[0]?.value) || 50) * 1024 ** 3;
  Object.assign(rep, { email: lower(q.email || ''), used: Number(q.used) || 0, limit, checkedAt: nowIso() });
  const full = rep.limit > 0 && rep.used / rep.limit >= BACKUP_STOP;
  const wrongAccount = archive[0]?.value && rep.email && lower(archive[0].value) !== rep.email;
  rep.wrongAccount = wrongAccount ? archive[0].value : '';
  let out = { ok: true, due: false, stopAt: BACKUP_STOP, limit };
  if (backupDue(plan, rep)) {
    if (full) { rep.paused = true; rep.running = false; }
    else if (wrongAccount) { rep.running = false; rep.lastError = `The Drive bridge runs as ${rep.email}, but students share their files with ${archive[0].value}.`; }
    else {
      if (!rep.running) Object.assign(rep, { running: true, startedAt: nowIso(), finishedAt: '', copied: 0, changed: 0, failed: 0, paused: false, lastError: '' });
      const rows = await all(env, `SELECT id, adm_no, name, class_code, unit_name, item, version, file_id, file_name, md5 FROM evidence
        WHERE status='approved' AND source='drive' AND archived_at IS NULL AND COALESCE(archive_tries,0) < ${BACKUP_TRIES} ORDER BY decided_at LIMIT ${BACKUP_BATCH}`);
      if (!rows.length) Object.assign(rep, { running: false, finishedAt: nowIso() });
      out = { ok: true, due: rows.length > 0, stopAt: BACKUP_STOP, limit, files: rows.map((r) => ({ id: r.id, fileId: r.file_id, md5: r.md5 || '',
        name: r.file_name || `${safeName(r.unit_name)} - ${r.item} - v${r.version}.pdf`, folders: [safeName(r.class_code), folderName(`${r.adm_no} - ${r.name}`)] })) };
    }
  }
  if (!full) rep.paused = false;
  await setMeta(env, 'backup_report', JSON.stringify(rep));
  return out;
}
async function backupDone(env, q) {
  const now = nowIso(), results = (q.results || []).slice(0, 200);
  const rows = new Map((await all(env, `SELECT id, md5, changed_at FROM evidence WHERE id IN ${IN}`, JSON.stringify(results.map((r) => String(r.id))))).map((r) => [r.id, r]));
  const stmts = [];
  let copied = 0, changed = 0, failed = 0;
  for (const r of results) {
    const row = rows.get(String(r.id)); if (!row) continue;
    if (r.archiveId) {
      copied++;
      const differs = r.md5 && row.md5 && r.md5 !== row.md5;
      if (differs) changed++;
      stmts.push(['UPDATE evidence SET archived_at=?, archive_id=?, archive_error=NULL, changed_at=COALESCE(changed_at, ?) WHERE id=?', now, String(r.archiveId), differs ? now : null, row.id]);
    } else {
      failed++;
      stmts.push(['UPDATE evidence SET archive_tries=COALESCE(archive_tries,0)+1, archive_error=? WHERE id=?', String(r.error || 'Could not copy').slice(0, 300), row.id]);
    }
  }
  const rep = readJson(await getMeta(env, 'backup_report'), {});
  Object.assign(rep, { copied: (rep.copied || 0) + copied, changed: (rep.changed || 0) + changed, failed: (rep.failed || 0) + failed,
    used: Number(q.used) || rep.used || 0, checkedAt: now });
  if (q.paused) Object.assign(rep, { paused: true, running: false });
  if (q.finished && !q.paused) Object.assign(rep, { running: false, finishedAt: now });
  await many(env, ...stmts, metaStmt('backup_report', JSON.stringify(rep)));
  return { ok: true };
}
async function backupStatus(env) {
  const [planRow, repRow, archive, waiting, failedRows, quota] = await many(env, ["SELECT value FROM meta WHERE key='backup_plan'"], ["SELECT value FROM meta WHERE key='backup_report'"],
    ["SELECT value FROM meta WHERE key='archive_email'"], [WAITING_SQL],
    [`SELECT adm_no, name, unit_name, item, version, archive_error FROM evidence WHERE status='approved' AND source='drive' AND archived_at IS NULL AND COALESCE(archive_tries,0) >= ${BACKUP_TRIES} LIMIT 50`], ["SELECT value FROM meta WHERE key='backup_quota_gb'"]);
  const rep = readJson(repRow[0]?.value, {});
  rep.limit = (Number(quota[0]?.value) || 50) * 1024 ** 3;      // the allowance as it is now, even before the bridge's next run
  const share = rep.limit ? rep.used / rep.limit : 0;
  return { ok: true, plan: { repeat: 'off', hour: 18, ...readJson(planRow[0]?.value, {}) }, report: rep, archiveEmail: archive[0]?.value || '', waiting: waiting[0]?.n || 0,
    gaveUp: failedRows.map((r) => ({ admNo: r.adm_no, name: r.name, what: `${r.unit_name} ${r.item} v${r.version}`, error: r.archive_error || '' })),
    level: share >= BACKUP_STOP ? 'full' : share >= BACKUP_WARN ? 'warn' : 'ok', warnAt: BACKUP_WARN, stopAt: BACKUP_STOP };
}
async function setBackup(env, b, me) {
  const plan = { repeat: 'off', hour: 18, ...readJson(await getMeta(env, 'backup_plan'), {}) };
  if (b.repeat !== undefined) { if (!['off', 'daily', 'weekly', 'monthly'].includes(b.repeat)) fail('Choose off, daily, weekly or monthly'); plan.repeat = b.repeat; }
  if (b.hour !== undefined) { const h = Number(b.hour); if (!(h >= 0 && h <= 23)) fail('Choose an hour from 0 to 23'); plan.hour = h; }
  if (b.now) plan.nowAt = nowIso();
  if (b.retry) await run(env, "UPDATE evidence SET archive_tries=0, archive_error=NULL WHERE archived_at IS NULL AND source='drive'");
  await setMeta(env, 'backup_plan', JSON.stringify(plan));
  await audit(env, me, 'backup', b.now ? 'back up now' : `repeat ${plan.repeat} at ${plan.hour}:00`);
  return { ...(await backupStatus(env)) };
}

/** Term register rows for one class and unit, the same way the app's Reports work them out. */
const PERIOD_NO = (p) => { const m = /(\d+)/.exec(p || ''); return m ? Number(m[1]) : 9; };
function buildRegister({ weeks, lessons, roster, alias, rejected, h, latePct, excPct }) {
  const late = latePct / 100, exc = excPct / 100;
  const list = [...lessons].sort((a, c) => (a.date + PERIOD_NO(a.period)).localeCompare(c.date + PERIOD_NO(c.period)));
  const used = weeks.map(() => 0), cellsOf = new Map();
  for (const l of list) {
    const w = weeks.indexOf(mondayOf(l.date));
    if (w === -1 || used[w] >= 3) continue;
    const n = Math.min(Number(l.slots) === 2 ? 2 : 1, 3 - used[w]);
    cellsOf.set(l.id, Array.from({ length: n }, (_, k) => w * 3 + used[w] + k));
    used[w] += n;
  }
  const rows = new Map();
  const ensure = (adm, name, pending = false) => {
    if (!rows.has(adm)) rows.set(adm, { admNo: adm, name: name || adm, pending, cells: Array(TERM_WEEKS * 3).fill(''), P: 0, A: 0, L: 0, E: 0, held: 0 });
    return rows.get(adm);
  };
  for (const t of roster) if (!rejected.has(t.admNo)) ensure(t.admNo, t.name, t.pending);
  for (const l of list) {
    const cells = cellsOf.get(l.id); if (!cells) continue;
    const marks = {};
    for (const [adm, st] of Object.entries(l.marks)) { const to = alias[adm] || adm; if (marks[to] && to !== adm) continue; marks[to] = st; }
    for (const [adm, st] of Object.entries(marks)) {
      if (!'PALE'.includes(st) || rejected.has(adm)) continue;
      const r = ensure(adm, l.names[adm]);
      for (const c of cells) { r.cells[c] = st; r[st]++; r.held++; }
    }
  }
  return [...rows.values()].sort((a, c) => a.admNo.localeCompare(c.admNo, undefined, { numeric: true })).map((r) => {
    const possible = Math.round(r.held * h * 100) / 100, actual = Math.round((r.P + r.L * late + r.E * exc) * h * 100) / 100;
    return { admNo: r.admNo, name: r.name, pending: r.pending, cells: r.cells, possible, actual, pct: possible ? actual / possible : null };
  });
}

/** What changed since the bridge last asked, one page of class-units at a time (keeps each request small). */
const FEED_PAGE = 12;
async function bridgeFeed(env, q) {
  const since = String(q.since || ''), offset = Math.max(0, Number(q.offset) || 0), now = nowIso();
  const [termRows, loading] = await many(env, [TERM_SQL], [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`]);
  const term = termOut(termRows[0]);
  const unitKey = (u) => u.class_code + '|' + u.unit_code;
  let keys;
  if (!since) keys = loading.map(unitKey);
  else {
    const [sess, tr, rq, so, st, ld, tm, mk] = await many(env, ['SELECT DISTINCT class_code, unit_code FROM sessions WHERE synced_at > ?', since],
      ['SELECT DISTINCT class_code FROM trainees WHERE updated_at > ? OR added_at > ?', since, since],
      ['SELECT DISTINCT class_code FROM requests WHERE requested_at > ? OR decided_at > ?', since, since],
      ['SELECT DISTINCT class_code, unit_code FROM signoffs WHERE submitted_at > ? OR decided_at > ?', since, since],
      ['SELECT code FROM staff WHERE updated_at > ?', since], ['SELECT 1 AS x FROM loading WHERE updated_at > ? LIMIT 1', since], ['SELECT 1 AS x FROM terms WHERE updated_at > ? LIMIT 1', since],
      ['SELECT DISTINCT class_code, unit_code FROM unit_marks WHERE synced_at > ? UNION SELECT class_code, unit_code FROM marksheets WHERE updated_at > ?', since, since]);
    const all = ld.length || tm.length;
    const want = new Set([...sess, ...so, ...mk].map(unitKey));
    const classes = new Set([...tr, ...rq].map((r) => r.class_code)), staffSet = new Set(st.map((r) => lower(r.code)));
    keys = loading.filter((u) => all || want.has(unitKey(u)) || classParts(u.class_code).some((c) => classes.has(c)) || staffSet.has(lower(u.trainer_code))).map(unitKey);
  }
  keys = [...new Set(keys)].sort();
  const page = keys.slice(offset, offset + FEED_PAGE);
  const out = { ok: true, now, term, total: keys.length, next: offset + FEED_PAGE < keys.length ? offset + FEED_PAGE : null, units: [] };
  if (offset === 0) {
    const [staffRows, ev] = await many(env, ['SELECT code, name, drive_folder FROM staff WHERE active=1'],
      ['SELECT * FROM evidence WHERE updated_at > ? ORDER BY updated_at LIMIT 1000', since]);
    const codes = new Set(loading.map((u) => lower(u.trainer_code)));
    out.trainers = staffRows.filter((r) => codes.has(lower(r.code))).map((r) => ({ code: r.code, name: r.name, folder: r.drive_folder || '' }));
    out.evidence = ev.map(evidenceOut);
  }
  if (!page.length || !term) return out;
  const units = page.map((k) => loading.find((u) => unitKey(u) === k));
  const classSet = [...new Set(units.flatMap((u) => classParts(u.class_code)))];
  const stmts = units.flatMap((u) => [
    ['SELECT id, data FROM sessions WHERE class_code=? AND unit_code=?', u.class_code, u.unit_code],
    ["SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN (SELECT id FROM sessions WHERE class_code=? AND unit_code=?)", u.class_code, u.unit_code],
  ]);
  const res = await many(env, ...stmts, [`SELECT adm_no, name, class_code, status, reg_code FROM trainees WHERE class_code IN ${IN}`, JSON.stringify(classSet)],
    [`SELECT adm_no, name, class_code, status, merged_into FROM requests WHERE class_code IN ${IN} AND status IN ('pending','rejected','merged')`, JSON.stringify(units.map((u) => u.class_code))],
    [`SELECT * FROM signoffs WHERE term_id=?`, term.id], [`SELECT code, late_pct, excused_pct FROM staff`], [`SELECT code, name, mis_class FROM classes WHERE code IN ${IN}`, JSON.stringify(classSet.concat(units.map((u) => u.class_code)))],
    [`SELECT * FROM unit_marks WHERE class_code IN ${IN}`, JSON.stringify(units.map((u) => u.class_code))],
    [`SELECT * FROM marksheets WHERE class_code IN ${IN}`, JSON.stringify(units.map((u) => u.class_code))]);
  const [trainees, reqs, signoffs, staffPct, classes, markRows, sheetRows] = res.slice(units.length * 2);
  const weeks = teachingWeeks(term);
  const from = weeks[0], to = (() => { const e = new Date(weeks[weeks.length - 1] + 'T00:00:00Z'); e.setUTCDate(e.getUTCDate() + 6); return e.toISOString().slice(0, 10); })();
  units.forEach((u, i) => {
    const accepted = acceptedOf(res[i * 2 + 1]);
    const all = res[i * 2].map((r) => {
      const s = JSON.parse(r.data), marks = {}, names = {};
      for (const m of finalMarks(s, accepted[r.id])) { const k = STATUS_CODE[m.status]; if (k) { marks[m.admNo] = k; names[m.admNo] = m.name; } }
      return { id: r.id, date: s.date, period: s.period, slots: s.slots, kind: s.kind || 'lesson', title: s.title || '', marks, names };
    }).filter((l) => l.date >= from && l.date <= to);
    const parts = classParts(u.class_code);
    const roster = trainees.filter((t) => parts.includes(t.class_code) && active(t)).map((t) => ({ admNo: t.adm_no, name: t.name }));
    const mine = reqs.filter((r) => r.class_code === u.class_code);
    for (const r of mine) if (r.status === 'pending' && !roster.some((t) => lower(t.admNo) === lower(r.adm_no))) roster.push({ admNo: r.adm_no, name: r.name, pending: true });
    const rejected = new Set(mine.filter((r) => r.status === 'rejected').map((r) => r.adm_no));
    const alias = Object.fromEntries(mine.filter((r) => r.status === 'merged' && r.merged_into).map((r) => [r.adm_no, r.merged_into]));
    const pct = staffPct.find((x) => lower(x.code) === lower(u.trainer_code)) || {};
    const h = term.lessonHours || (Number(u.hours_per_week) || 3) / (Number(u.lessons_per_week) || 2);
    const so = signoffs.find((x) => x.class_code === u.class_code && x.unit_code === u.unit_code);
    const lessons = all.filter((l) => l.kind === 'lesson');
    const regRows = buildRegister({ weeks, lessons, roster, alias, rejected, h, latePct: pct.late_pct ?? 50, excPct: pct.excused_pct ?? 100 });
    const catItems = all.filter((l) => l.kind !== 'lesson');
    out.units.push({
      key: unitKey(u), trainerCode: u.trainer_code, trainerName: u.trainer_name, classCode: u.class_code, unitCode: u.unit_code, unitName: u.unit_name,
      misClass: (classes.find((c) => c.code === u.class_code) || {}).mis_class || u.class_code, level: levelOf(u.class_code), termName: term.name, duration: term.duration || '',
      weeks, lessonHours: h, lessonsHeld: lessons.length,
      rows: regRows, catCols: catColumns(term, weeks, all), catTable: catItems.length ? catTable(regRows, catItems) : null,
      lecturerComment: so?.lecturer_comment || '', hodComment: so?.hod_comment || '', signoff: so?.status || '',
      cats: all.filter((l) => l.kind !== 'lesson').sort((a, c) => a.date.localeCompare(c.date)).map((l) => ({ title: l.title || (l.kind === 'cat' ? 'CAT' : 'Extra'), date: l.date, kind: l.kind, marks: l.marks })),
      marksheet: { ...marksheetOf(u, roster, trainees, markRows, classes, term), footer: marksheetFooter(u, sheetRows.find((m) => m.class_code === u.class_code && m.unit_code === u.unit_code)) },
    });
  });
  return out;
}

const shortDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
/** The CAT weeks of the term register: each is one merged "CAT 1" column, unless lessons were marked in that week anyway. */
function catColumns(term, weeks, all) {
  return (term.catWeeks || []).filter((n) => n >= 1 && n <= weeks.length).map((n, i) => {
    const inWeek = all.filter((l) => mondayOf(l.date) === weeks[n - 1]);
    return { w: n - 1, label: `CAT ${i + 1}`, merge: !inWeek.some((l) => l.kind === 'lesson'),
      date: [...new Set(inWeek.filter((l) => l.kind === 'cat').map((l) => l.date))].sort().map(shortDate).join(', ') };
  });
}
/** The CATs tab, as report.js catTable(): a student absent from a CAT who sat the extra attendance making it up reads
 * "Ab (Supplementary CAT - Sat 19 Mar)"; an extra attendance makes up the CAT its title names, else the latest CAT before it. */
export function catTable(rows, items) {
  const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
  const cats = sorted.filter((a) => a.kind === 'cat'), makesUp = new Map();
  for (const x of sorted.filter((a) => a.kind === 'extra')) {
    const m = /CAT\s*(\d+)/i.exec(x.title || '');
    const t = (m && cats.find((c) => new RegExp(`CAT\\s*${m[1]}\\b`, 'i').test(c.title || ''))) || [...cats].reverse().find((c) => c.date <= x.date);
    if (t) makesUp.set(x, t);
  }
  const sat = (v) => v === 'P' || v === 'L';
  const out = rows.map((r) => cats.map((a) => {
    const v = a.marks[r.admNo] || '';
    if (v === 'A') {
      const sup = sorted.find((x) => makesUp.get(x) === a && sat(x.marks[r.admNo]));
      if (sup) return `Ab (Supplementary CAT - Sat ${shortDate(sup.date)})`;
    }
    return v === 'A' ? 'Ab' : v;
  }));
  const count = (k, test) => out.filter((v) => test(v[k])).length;
  return {
    // A column per CAT ("CAT 1", "CAT 2" …); a make-up shows inside the CAT it makes up.
    cols: cats.map((a, i) => { const m = /^\s*CAT\s*(\d+)(.*)$/i.exec(a.title || ''); return { label: m ? `CAT ${m[1]}${m[2].trimEnd()}` : `CAT ${i + 1}`, date: shortDate(a.date), kind: 'cat' }; }), vals: out,
    totals: [['Sat', cats.map((a, k) => count(k, sat))], ['Absent', cats.map((a, k) => count(k, (v) => v.startsWith('Ab')))],
      ['Sat the supplementary', cats.map((a, k) => count(k, (v) => v.startsWith('Ab (')))]],
  };
}

/** The marksheet footer: Prepared by (the unit's trainer), Received by (the Assessment Officer), Approved by; initials sign. */
const initialsOf = (name) => String(name || '').replace(/[^A-Za-z\s'-]/g, ' ').split(/[\s-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + '.').join('');
const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' }) : '');
function marksheetFooter(u, m) {
  const who = (name, at) => ({ name: name || '', initials: at ? initialsOf(name) : '', date: dayOf(at) });
  return { prepared: who(m?.prepared_name || u.trainer_name, m?.prepared_at), received: who(m?.received_name, m?.received_at),
    approved: who(m?.status === 'approved' ? m.approved_name : '', m?.status === 'approved' ? m.approved_at : ''), status: m?.status || '' };
}
/** The marksheet for one class-unit, students in admission number order (as the register). */
function marksheetOf(u, roster, trainees, markRows, classes, term) {
  const mine = markRows.filter((m) => m.class_code === u.class_code && m.unit_code === u.unit_code);
  const byAdm = new Map(mine.map((m) => [lower(m.adm_no), m])), reg = new Map(trainees.map((t) => [lower(t.adm_no), t.reg_code || '']));
  const cls = classes.find((c) => c.code === u.class_code) || classes.find((c) => classParts(u.class_code).includes(c.code)) || {};
  const rows = [...roster].sort((a, c) => String(a.admNo).localeCompare(String(c.admNo))).map((t) => {
    const m = byAdm.get(lower(t.admNo)) || {};
    return { admNo: t.admNo, name: t.name, regCode: reg.get(lower(t.admNo)) || '', cat: ['cat1', 'cat2', 'cat3'].map((c) => m[c] ?? ''), prac: ['prac1', 'prac2', 'prac3'].map((c) => m[c] ?? '') };
  });
  return { courseCode: cls.mis_class || u.class_code, courseName: cls.name && cls.name !== cls.code ? cls.name : (cls.mis_class || u.class_code), series: term.series || '', entered: mine.length, rows };
}

/* ---------- poking the Drive bridge when something changes ---------- */
/* The bridge used to ask every 10 minutes whether anything had changed. Now the Worker pokes it right
 * after a change and it syncs about two minutes later; an hourly trigger on its side is the safety net.
 * At most one poke a minute, it happens after the reply has gone out (ctx.waitUntil), and a poke that
 * fails is simply forgotten - nothing here can slow down or break the request that caused it. */
const NUDGE_EVERY_MS = 60e3;
let nudgedAt = 0;   // this isolate's last poke, so most requests never even read the database
async function nudgeDrive(env) {
  const now = Date.now();
  if (!env.BRIDGE_SECRET || now - nudgedAt < NUDGE_EVERY_MS) return 'skipped';
  nudgedAt = now;
  const url = await getMeta(env, 'drive_url');
  if (!url) return 'no-bridge';                              // the bridge has not reported in yet
  // One statement settles it, so two Workers at once cannot both poke: the marker only moves on when it
  // is already a minute old, and whoever moves it is the one that sends.
  const claim = await run(env, `INSERT INTO meta (key,value) VALUES ('drive_nudged_at', ?1)
    ON CONFLICT(key) DO UPDATE SET value=?1 WHERE CAST(meta.value AS INTEGER) < ?2`, String(now), now - NUDGE_EVERY_MS);
  if (!claim.meta?.changes) return 'skipped';                // another Worker poked it a moment ago
  const ts = now, body = '{}';
  const payload = JSON.stringify({ action: 'nudge', ts, body, sig: await hmacHex(`nudge|${ts}|${body}`, bridgeSecret(env)) });
  // Apps Script answers a web app POST with a redirect to script.googleusercontent.com, so follow it.
  const res = await fetch(url, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: payload });
  if (!res.ok) { console.error(`nudge: the Drive bridge answered ${res.status}`); return 'error'; }
  return 'sent';
}

/* ====================== free notifications for students (Web Push with VAPID) ======================
 * Standard browser push: no Firebase, no other service, nothing to pay for. The public key sits in
 * config.js and the private key is the Worker secret VAPID_PRIVATE_KEY (README -> "Notifications").
 * A push carries NO message ("a tickle"), so the Worker never has to encrypt anything: the phone's
 * service worker is woken, asks for `notices`, and shows what it finds. Signing the token is the slow
 * part, so each push service's token is reused for 12 hours. */
const PUSH_MAX = 8;        // phones poked per change (a student normally has one)
const MAX_SUBS = 4;        // kept per student, newest first
const PUSH_GIVE_UP = 10;   // failures in a row before an address is dropped
const bytesB64u = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uBytes = (s) => { const x = String(s || '').replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(x + '='.repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0)); };

let vapidKey = null;
/** The signing key, from VAPID_PRIVATE_KEY: either the whole JWK, or just `d` with VAPID_PUBLIC_KEY beside it. */
async function vapidKeys(env) {
  if (vapidKey) return vapidKey;
  const raw = String(env.VAPID_PRIVATE_KEY || '').trim();
  if (!raw) fail('Notifications are not set up on the server yet (the Worker has no VAPID_PRIVATE_KEY).');
  let jwk;
  if (raw.startsWith('{')) jwk = JSON.parse(raw);
  else {
    const pub = b64uBytes(env.VAPID_PUBLIC_KEY || '');
    if (pub.length !== 65 || pub[0] !== 4) fail('Notifications: with a plain private key, add VAPID_PUBLIC_KEY to the Worker as well.');
    jwk = { d: raw.replace(/=+$/, ''), x: bytesB64u(pub.slice(1, 33)), y: bytesB64u(pub.slice(33)) };
  }
  if (!jwk.d || !jwk.x || !jwk.y) fail('Notifications: VAPID_PRIVATE_KEY is not a P-256 key (see the README).');
  const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return (vapidKey = { key, pub: bytesB64u(new Uint8Array([4, ...b64uBytes(jwk.x), ...b64uBytes(jwk.y)])) });
}
const vapidTokens = new Map();   // push service origin -> { token, until }
async function vapidAuth(env, origin) {
  const { key, pub } = await vapidKeys(env);
  const have = vapidTokens.get(origin);
  if (have && have.until > Date.now()) return { token: have.token, pub };
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claim = b64u(JSON.stringify({ aud: origin, exp: Math.floor(Date.now() / 1000) + 23 * 3600, sub: String(env.VAPID_SUBJECT || 'mailto:ict@rvnp.ac.ke') }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + claim));
  const token = `${head}.${claim}.${bytesB64u(new Uint8Array(sig))}`;
  vapidTokens.set(origin, { token, until: Date.now() + 12 * 3600e3 });
  return { token, pub };
}

/** Wakes one student's phones. Addresses the browser has thrown away (404 / 410) are deleted. */
async function pushToStudent(env, admNo) {
  const subs = await all(env, 'SELECT endpoint FROM push_subs WHERE adm_no=? ORDER BY last_ok_at DESC LIMIT ?', admNo, PUSH_MAX);
  if (!subs.length) return 0;
  const now = nowIso(), gone = [], good = [], bad = [];
  for (const s of subs) {
    try {
      const { token, pub } = await vapidAuth(env, new URL(s.endpoint).origin);
      const res = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: `vapid t=${token}, k=${pub}`, TTL: '86400', Urgency: 'normal' } });
      if (res.status === 404 || res.status === 410) gone.push(s.endpoint);          // unsubscribed or expired
      else if (res.ok) good.push(s.endpoint);
      else { bad.push(s.endpoint); console.error(`push: ${new URL(s.endpoint).host} answered ${res.status}`); }
    } catch (e) { bad.push(s.endpoint); console.error('push', e); }
  }
  await many(env,
    good.length && [`UPDATE push_subs SET last_ok_at=?, fail_count=0 WHERE endpoint IN ${IN}`, now, JSON.stringify(good)],
    bad.length && [`UPDATE push_subs SET fail_count=COALESCE(fail_count,0)+1 WHERE endpoint IN ${IN}`, JSON.stringify(bad)],
    gone.length && [`DELETE FROM push_subs WHERE endpoint IN ${IN}`, JSON.stringify(gone)],
    bad.length && ['DELETE FROM push_subs WHERE fail_count >= ?', PUSH_GIVE_UP]);
  return good.length;
}
/** Sends after the reply has gone out, and never lets a push get in the way of the real work.
 *  Other events can use this too: call it wherever a student should hear about something. */
function pushLater(ctx, env, admNo) {
  if (!ctx?.waitUntil || !env.VAPID_PRIVATE_KEY || !admNo) return;
  ctx.waitUntil(pushToStudent(env, admNo).catch((e) => console.error('push', e)));
}
const noticeOut = (r) => ({ kind: 'evidence', id: r.id, item: r.item, unitCode: r.unit_code, unitName: r.unit_name || r.unit_code,
  version: r.version, status: r.status, comment: r.comment || '', decidedName: r.decided_name || '', decidedAt: r.decided_at || '' });

/* ---------- the student phone: units, upload tickets, my evidence ---------- */
async function studentOf(env, b) {
  const [tRows, dRows] = await many(env, ['SELECT * FROM trainees WHERE adm_no=?', String(b.admNo || '').trim()], ['SELECT * FROM devices WHERE device_id=?', String(b.deviceId || '')]);
  const t = tRows[0], d = dRows[0];
  if (!t || !active(t)) fail('That student is not on the class list');
  if (!d || lower(d.adm_no) !== lower(t.adm_no)) fail('This phone is not registered to that student. Set up the phone first.');
  return t;
}
const unitsForClass = (loading, cls) => loading.filter((u) => classParts(u.class_code).includes(cls) || u.class_code === cls);
async function classUnits(env, cls) {
  if (!cls) fail('Choose a class');
  // Every unit the class has had in any term (a unit can span terms): this term's first, then the earlier ones.
  const [loading, url, now] = await many(env, [`SELECT l.class_code, l.unit_code, l.unit_name, l.term_id FROM loading l LEFT JOIN terms t ON t.id=l.term_id ORDER BY t.start_date DESC`],
    ["SELECT value FROM meta WHERE key='drive_url'"], [TERM_SQL]);
  const activeId = now[0]?.id || '', seen = new Map(), units = [];
  for (const u of unitsForClass(loading, cls)) {
    const current = u.term_id === activeId, had = seen.get(u.unit_code);
    if (had) { if (current && !had.current) { had.current = true; had.name = u.unit_name || had.name; } continue; }
    const x = { code: u.unit_code, name: u.unit_name || u.unit_code, current };
    seen.set(u.unit_code, x); units.push(x);
  }
  units.sort((a, b) => (b.current - a.current) || a.name.localeCompare(b.name));
  return { ok: true, classCode: cls, units, items: ITEMS, driveReady: !!url[0], pushReady: !!env.VAPID_PRIVATE_KEY };
}
const evidenceOut = (r) => ({ approvalRef: r.status === 'approved' ? r.approval_ref || '' : '', id: r.id, admNo: r.adm_no, name: r.name, classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name, item: r.item,
  version: r.version, fileId: r.file_id, fileName: r.file_name, bytes: r.bytes, pages: r.pages, submittedAt: r.submitted_at, status: r.status,
  decidedName: r.decided_name || '', decidedAt: r.decided_at || '', comment: r.comment || '', receivedAt: r.received_at || '', updatedAt: r.updated_at,
  source: r.source || 'bridge', ownerEmail: r.owner_email || '', changedAt: r.changed_at || '' });

/* ---------- evidence in the student's own Google Drive ----------
 * The student's phone saves the PDF in the student's college Drive and shares it (view only) with the unit's trainer,
 * the HOD(s), the MIS Officer(s) and the backup account. The Worker checks the file with Google itself, using the
 * student's short-lived Google access (never stored), and keeps its fingerprint (md5) so a later change shows. */
const GOOGLE_API = 'https://www.googleapis.com';
async function google(env, path, token) {
  // GOOGLE_API_TEST points the local test harness at a stand-in for Google; never set on Cloudflare.
  const res = await fetch((env.GOOGLE_API_TEST || GOOGLE_API) + path, { headers: { Authorization: 'Bearer ' + String(token || '') } });
  if (res.status === 401) fail('Your Google sign-in has expired. Sign in to Google again.');
  if (!res.ok) fail(`Google said no (${res.status}). Try again.`);
  return res.json();
}
/* ---------- Google connected once ----------
 * The app sends the one-time code from Google's sign-in window; the server swaps it for a refresh token (kept encrypted with
 * the server's own key) and from then on hands the device a fresh access token (an hour long) whenever it needs one. Needs
 * GOOGLE_CLIENT_ID (a plain variable) and the secret GOOGLE_CLIENT_SECRET on the Worker; without them the app keeps the
 * old sign-in window. */
const googleReady = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
async function sealKey(env) { return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', enc.encode('g_refresh|' + (await authSecret(env)))), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(env), enc.encode(text)));
  return bytesB64u(iv) + '.' + bytesB64u(out);
}
async function unseal(env, s) {
  const [iv, data] = String(s || '').split('.');
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64uBytes(iv) }, await sealKey(env), b64uBytes(data)));
}
async function googleOauth(env, params) {
  const res = await fetch((env.GOOGLE_OAUTH_TEST || 'https://oauth2.googleapis.com') + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...params }) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Fail(out.error_description || out.error || 'Google did not accept that'), { grant: out.error });
  return out;
}
/** Swaps the code for tokens, checks the account is a college one, keeps the refresh token. table: 'trainees' | 'staff'. */
async function googleConnect(env, table, key, code) {
  if (!googleReady(env)) fail('Connecting Google once is not set up on the server yet');
  if (!code) fail('Google did not send a code');
  const t = await googleOauth(env, { code: String(code), grant_type: 'authorization_code', redirect_uri: 'postmessage' });
  const u = await google(env, '/oauth2/v3/userinfo', t.access_token);
  const email = lower(u.email || '');
  if (!okDomain(env, email)) fail(`Use your college Google account (@${env.GOOGLE_DOMAIN}), not ${email}.`);
  const col = table === 'staff' ? 'code' : 'adm_no';
  // Google gives the refresh token only the first time someone allows the app; a reconnect without one keeps the old one.
  if (t.refresh_token) await run(env, `UPDATE ${table} SET g_refresh=?, email=?, updated_at=? WHERE ${col}=?`, await seal(env, t.refresh_token), email, nowIso(), key);
  else await run(env, `UPDATE ${table} SET email=?, updated_at=? WHERE ${col}=?`, email, nowIso(), key);
  if (table === 'staff') await markChanged(env);
  return { ok: true, accessToken: t.access_token, expiresIn: Number(t.expires_in) || 3600, email, kept: !!t.refresh_token };
}
/** A fresh access token from the kept refresh token; needConnect when there is none or Google no longer accepts it. */
async function googleToken(env, table, key) {
  if (!googleReady(env)) return { ok: false, needConnect: true, error: 'Connecting Google once is not set up on the server yet' };
  const col = table === 'staff' ? 'code' : 'adm_no';
  const row = await one(env, `SELECT g_refresh, email FROM ${table} WHERE ${col}=?`, key);
  if (!row?.g_refresh) return { ok: false, needConnect: true, error: 'Connect Google first' };
  try {
    const t = await googleOauth(env, { refresh_token: await unseal(env, row.g_refresh), grant_type: 'refresh_token' });
    return { ok: true, accessToken: t.access_token, expiresIn: Number(t.expires_in) || 3600, email: row.email || '' };
  } catch (e) {
    if (e.grant === 'invalid_grant') { await run(env, `UPDATE ${table} SET g_refresh=NULL WHERE ${col}=?`, key); return { ok: false, needConnect: true, error: 'Google asks you to connect again' }; }
    throw e;
  }
}
const okDomain = (env, email) => !env.GOOGLE_DOMAIN || lower(String(email || '').split('@')[1]) === lower(env.GOOGLE_DOMAIN);
/** Signed with the database's own key (no Drive bridge needed): what the phone may save, and as which version. */
async function signPlan(env, payload) { const body = b64u(JSON.stringify(payload)); return body + '.' + (await hmacHex('plan|' + body, await authSecret(env))); }
async function readPlan(env, plan) {
  const [body, sig] = String(plan || '').split('.');
  if (!body || !sig || (await hmacHex('plan|' + body, await authSecret(env))) !== sig) fail('That upload plan is not valid');
  return JSON.parse(unb64u(body));
}
/** Who should see a student's file: the unit's trainer now (earlier ones are never removed), HODs, MIS Officers and
 *  the backup account. Only people who have connected Google in the staff app have an address to share with. */
async function shareTargets(env, classCode, unitCode, ctx = {}) {
  const [loading, staff, archive] = ctx.loading ? [ctx.loading, ctx.staff, ctx.archive] : await many(env,
    ['SELECT l.class_code, l.unit_code, l.trainer_code, l.term_id FROM loading l LEFT JOIN terms t ON t.id=l.term_id ORDER BY t.start_date DESC'],
    ["SELECT code, roles, email FROM staff WHERE active=1 AND email IS NOT NULL AND email<>''"], ["SELECT value FROM meta WHERE key='archive_email'"]);
  Object.assign(ctx, { loading, staff, archive });
  const byCode = new Map(staff.map((s) => [lower(s.code), s]));
  // The trainer this term; if the unit is not taught this term, whoever had it last.
  const trainer = unitsForClass(loading.filter((u) => u.unit_code === unitCode), classCode)[0];
  const out = new Set();
  if (trainer && byCode.get(lower(trainer.trainer_code))) out.add(lower(byCode.get(lower(trainer.trainer_code)).email));
  for (const s of staff) if (hasRole(s.roles, 'HOD') || hasRole(s.roles, 'MIS')) out.add(lower(s.email));
  if (archive[0]?.value) out.add(lower(archive[0].value));
  return [...out];
}
const sharedOf = (r) => { try { return JSON.parse(r.shared || '[]') || []; } catch { return []; } };
const STUDENT_ACTIONS = {
  async googleConnect(env, b) { const t = await studentOf(env, b); return googleConnect(env, 'trainees', t.adm_no, b.code); },
  async googleToken(env, b) { const t = await studentOf(env, b); return googleToken(env, 'trainees', t.adm_no); },
  /** Every lesson of this student's class with their mark, so the student keeps a copy of their own attendance. */
  async myAttendance(env, b) {
    const t = await studentOf(env, b);
    const [rows, acc] = await many(env,
      [`SELECT s.id, s.date, s.unit_code, s.unit_name, s.period, COALESCE(s.kind,'lesson') AS kind, s.slots, json_extract(m.value,'$.status') AS status
        FROM sessions s, json_each(s.data, '$.marks') m
        WHERE (s.class_code=?1 OR instr(s.class_code, ?1) > 0) AND lower(json_extract(m.value,'$.admNo'))=lower(?2)
        ORDER BY s.date DESC, s.period LIMIT 800`, t.class_code, t.adm_no],
      ["SELECT session_id FROM checkins WHERE adm_no=? AND status='accepted'", t.adm_no]);
    const qr = new Set(acc.map((r) => r.session_id));
    return { ok: true, serverTime: nowIso(), lessons: rows.map((r) => ({ id: r.id, date: r.date, unitCode: r.unit_code, unitName: r.unit_name || r.unit_code,
      period: r.period, kind: r.kind, slots: Number(r.slots) === 2 ? 2 : 1, status: qr.has(r.id) && r.status !== 'Late' ? 'Present' : r.status || '' })) };
  },
  async poeTicket(env, b) {
    const t = await studentOf(env, b);
    const item = String(b.item || '').toUpperCase();
    if (!ITEMS.includes(item)) fail('Choose CAT1–CAT4 or PRAC1–PRAC3');
    if (Number(b.bytes) > MAX_EVIDENCE_BYTES) fail('That file is over 20 MB. Scan fewer pages or use the Document filter.');
    const [loading, ver, url] = await many(env, [`SELECT l.unit_code, l.unit_name, l.class_code FROM loading l LEFT JOIN terms t ON t.id=l.term_id WHERE l.unit_code=? ORDER BY t.start_date DESC`, String(b.unitCode || '')],
      ['SELECT MAX(version) AS v FROM evidence WHERE adm_no=? AND unit_code=? AND item=?', t.adm_no, String(b.unitCode || ''), item], ["SELECT value FROM meta WHERE key='drive_url'"]);
    const unit = unitsForClass(loading, t.class_code)[0];
    if (!unit) fail('That unit has not been taught to your class');
    if (!url[0]) fail('Evidence uploads are not switched on yet (the Google Drive link is not set up). Your scan is kept on this phone.');
    const v = (Number(ver[0]?.v) || 0) + 1, unitName = unit.unit_name || unit.unit_code;
    const fileName = `${safeName(unitName)} - ${item} - v${v}.pdf`;
    const ticket = await signTicket(env, { k: 'up', id: crypto.randomUUID(), adm: t.adm_no, sname: t.name, cls: t.class_code, unit: unit.unit_code, unitName, item, v, name: fileName,
      folders: [safeName(t.class_code), folderName(`${t.adm_no} - ${t.name}`)], bytes: Number(b.bytes) || 0, pages: Number(b.pages) || 0, exp: Date.now() + 6 * 3600e3 });
    return { ok: true, ticket, driveUrl: url[0].value, fileName, version: v };
  },
  /** After the bridge saved the file: it signed what it saved, so the record cannot be made up. */
  async poeDone(env, b) {
    // Late is fine here: the bridge's signature proves the file was saved while the ticket was valid.
    const t = await readTicket(env, b.ticket, 'up', { late: true });
    if ((await hmacHex(`done|${t.id}|${b.fileId}|${b.version}|${b.fileName}`, bridgeSecret(env))) !== b.sig) fail('The Drive bridge did not confirm this file');
    const now = nowIso();
    await run(env, `INSERT INTO evidence (id,adm_no,name,class_code,unit_code,unit_name,item,version,file_id,file_name,bytes,pages,submitted_at,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?) ON CONFLICT(id) DO NOTHING`, t.id, t.adm, t.sname, t.cls, t.unit, t.unitName, t.item, Number(b.version) || t.v,
    String(b.fileId), String(b.fileName), t.bytes, t.pages, now, now);
    return { ok: true, evidence: evidenceOut(await one(env, 'SELECT * FROM evidence WHERE id=?', t.id)) };
  },
  async poeMine(env, b) {
    const t = await studentOf(env, b);
    const rows = await all(env, 'SELECT * FROM evidence WHERE adm_no=? ORDER BY submitted_at DESC', t.adm_no);
    // For files in the student's Drive: anyone who should see it but has not been given access yet (a new trainer,
    // a new HOD). The phone shares it and reports back; nobody is ever removed.
    const ctx = {};
    const out = [];
    for (const r of rows) {
      const e = evidenceOut(r);
      if (r.source === 'drive') { const have = new Set(sharedOf(r)); e.share = (await shareTargets(env, r.class_code, r.unit_code, ctx)).filter((x) => !have.has(x) && x !== lower(r.owner_email)); }
      out.push(e);
    }
    return { ok: true, evidence: out };
  },
  /** Before saving to the student's Drive: the file name, the version, and who to share it with. */
  async poeDrivePlan(env, b) {
    const t = await studentOf(env, b);
    const item = String(b.item || '').toUpperCase();
    if (!ITEMS.includes(item)) fail('Choose CAT1–CAT4 or PRAC1–PRAC3');
    if (Number(b.bytes) > MAX_EVIDENCE_BYTES) fail('That file is over 20 MB. Scan fewer pages or use the Document filter.');
    const [loading, ver] = await many(env, [`SELECT l.unit_code, l.unit_name, l.class_code FROM loading l LEFT JOIN terms t ON t.id=l.term_id WHERE l.unit_code=? ORDER BY t.start_date DESC`, String(b.unitCode || '')],
      ['SELECT MAX(version) AS v FROM evidence WHERE adm_no=? AND unit_code=? AND item=?', t.adm_no, String(b.unitCode || ''), item]);
    const unit = unitsForClass(loading, t.class_code)[0];
    if (!unit) fail('That unit has not been taught to your class');
    const v = (Number(ver[0]?.v) || 0) + 1, unitName = unit.unit_name || unit.unit_code;
    const fileName = `${safeName(unitName)} - ${item} - v${v}.pdf`;
    const plan = await signPlan(env, { id: crypto.randomUUID(), adm: t.adm_no, sname: t.name, cls: t.class_code, unit: unit.unit_code, unitName, item, v, name: fileName,
      pages: Number(b.pages) || 0, exp: Date.now() + 24 * 3600e3 });
    return { ok: true, plan, fileName, version: v, folder: 'The ARK - POE', subfolder: safeName(unitName),
      description: `POE evidence ${item} for ${unitName}, ${t.name} (${t.adm_no}), sent from The ARK`, share: await shareTargets(env, t.class_code, unit.unit_code) };
  },
  /** After the phone saved the file: the Worker reads it from Google with the student's access and records it. */
  async poeDriveDone(env, b) {
    const t = await studentOf(env, b);
    const p = await readPlan(env, b.plan);
    if (lower(p.adm) !== lower(t.adm_no)) fail('That upload plan is for another student');
    const f = await google(env, `/drive/v3/files/${encodeURIComponent(String(b.fileId || ''))}?fields=id,name,mimeType,size,md5Checksum,modifiedTime,trashed,owners(emailAddress)`, b.accessToken);
    const owner = lower(f.owners?.[0]?.emailAddress || '');
    if (f.trashed) fail('That file is in the bin in Google Drive');
    if (f.mimeType !== 'application/pdf') fail('Only PDF files can be sent');
    if (!okDomain(env, owner)) fail(`Use your college Google account (@${env.GOOGLE_DOMAIN}), not ${owner}.`);
    if (Number(f.size) > MAX_EVIDENCE_BYTES) fail('That file is over 20 MB');
    const now = nowIso(), shared = (b.shared || []).map((x) => lower(String(x))).filter(Boolean).slice(0, 50);
    await many(env, [`INSERT INTO evidence (id,adm_no,name,class_code,unit_code,unit_name,item,version,file_id,file_name,bytes,pages,submitted_at,status,updated_at,source,owner_email,md5,modified_at,shared)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?,'drive',?,?,?,?) ON CONFLICT(id) DO NOTHING`, p.id, t.adm_no, t.name, t.class_code, p.unit, p.unitName, p.item, p.v,
    f.id, f.name || p.name, Number(f.size) || 0, p.pages, now, now, owner, f.md5Checksum || '', f.modifiedTime || '', JSON.stringify(shared)],
    ['UPDATE trainees SET email=? WHERE adm_no=?', owner, t.adm_no], changedStmt());
    return { ok: true, evidence: evidenceOut(await one(env, 'SELECT * FROM evidence WHERE id=?', p.id)) };
  },
  /** The phone shared a file with more people (a new trainer or HOD): remember them, so they are not asked for again. */
  async poeShared(env, b) {
    const t = await studentOf(env, b);
    const r = await one(env, "SELECT * FROM evidence WHERE id=? AND adm_no=? AND source='drive'", String(b.id || ''), t.adm_no);
    if (!r) fail('That submission no longer exists');
    const all2 = [...new Set([...sharedOf(r), ...(b.emails || []).map((x) => lower(String(x))).filter(Boolean)])].slice(0, 100);
    await run(env, 'UPDATE evidence SET shared=? WHERE id=?', JSON.stringify(all2), r.id);
    return { ok: true };
  },
  /** The student turned notifications on. The address comes from the browser and is only an address:
   *  nothing private is kept, and only this student's registered phone can add or remove one. */
  async pushSubscribe(env, b) {
    const t = await studentOf(env, b);
    const endpoint = String(b.endpoint || '').trim();
    // Real push services are always https; http is allowed only for localhost, which is the test harness.
    if (!/^https:\/\/\S{10,900}$/.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(endpoint)) {
      fail('That notification address does not look right');
    }
    const now = nowIso();
    await many(env,
      ['INSERT INTO push_subs (endpoint,adm_no,device_id,created_at,last_ok_at,fail_count) VALUES (?,?,?,?,?,0) ON CONFLICT(endpoint) DO UPDATE SET adm_no=excluded.adm_no, device_id=excluded.device_id, fail_count=0',
        endpoint, t.adm_no, String(b.deviceId || ''), now, now],
      // Only the newest few are kept, so changing phone or browser does not leave old addresses behind.
      ['DELETE FROM push_subs WHERE adm_no=? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE adm_no=? ORDER BY created_at DESC LIMIT ?)', t.adm_no, t.adm_no, MAX_SUBS]);
    return { ok: true, on: true };
  },
  async pushUnsubscribe(env, b) {
    const t = await studentOf(env, b);
    await run(env, 'DELETE FROM push_subs WHERE endpoint=? AND adm_no=?', String(b.endpoint || ''), t.adm_no);
    return { ok: true, on: false };
  },
  /** What to tell this student, and nothing they have already been told. `seen` marks notices read,
   *  so the same decision is never shown twice. More kinds can be added to the list later (each one
   *  carries its own `kind`), for example a warning when attendance falls below the minimum. */
  /** Messages to this student (from a trainer, the HOD, the MIS Officer or the Internal Assessment Officer), newest first;
   *  `read` marks some read. */
  async messages(env, b) {
    const t = await studentOf(env, b);
    return { ok: true, messages: await noticesFor(env, t.adm_no, 'students', b.read) };
  },
  async notices(env, b) {
    const t = await studentOf(env, b);
    const seen = (b.seen || []).map(String).filter(Boolean).slice(0, 50);
    if (seen.length) await run(env, `UPDATE evidence SET seen_at=? WHERE adm_no=? AND seen_at IS NULL AND id IN ${IN}`, nowIso(), t.adm_no, JSON.stringify(seen));
    const rows = await all(env, "SELECT * FROM evidence WHERE adm_no=? AND status IN ('approved','returned') AND seen_at IS NULL ORDER BY decided_at DESC LIMIT 20", t.adm_no);
    const msgs = (await noticesFor(env, t.adm_no, 'students')).filter((m) => !m.read).slice(0, 5).map((m) => ({ kind: 'message', id: m.id, title: m.title, body: m.body, from: m.from, at: m.at }));
    return { ok: true, notices: [...rows.map(noticeOut), ...msgs] };
  },
};

/* ---------- trainers, HOD and MIS ---------- */
async function myUnitPairs(env, me) {
  const loading = await all(env, `SELECT class_code, unit_code, unit_name, trainer_code FROM loading WHERE term_id=${ACTIVE_TERM}`);
  const mine = loading.filter((u) => lower(u.trainer_code) === lower(me.code));
  return { loading, pairs: new Set(mine.flatMap((u) => classParts(u.class_code).map((c) => c + '|' + u.unit_code))) };
}
const seesAll = (me) => me.roles.includes('HOD') || me.roles.includes('MIS') || me.roles.includes('IAO');
/** Only an External Assessment Officer (no other role): sees nothing but the verification work given to them. */
const visitorOnly = (me) => me.roles.length > 0 && me.roles.every((r) => r === 'EAO');
/** Class-units a trainer taught in any term: they can still look at that evidence, but only this term's trainer decides. */
async function everTaught(env, me) {
  const rows = await all(env, 'SELECT DISTINCT class_code, unit_code FROM loading WHERE trainer_code=?', me.code);
  return new Set(rows.flatMap((u) => classParts(u.class_code).map((c) => c + '|' + u.unit_code)));
}
async function poeList(env, b, me) {
  const { pairs: now } = await myUnitPairs(env, me);
  const pairs = seesAll(me) ? now : new Set([...now, ...(await everTaught(env, me))]);
  const status = ['submitted', 'approved', 'returned'].includes(b.status) ? b.status : '';
  let list = [];
  if (seesAll(me)) {
    list = status ? await all(env, 'SELECT * FROM evidence WHERE status=? ORDER BY submitted_at DESC LIMIT 3000', status)
      : await all(env, 'SELECT * FROM evidence ORDER BY submitted_at DESC LIMIT 3000');
  } else {
    // Only this trainer's class-units are read (through the class/unit index), a few dozen at a time.
    const keys = [...pairs].map((k) => k.split('|'));
    for (let i = 0; i < keys.length; i += 40) {
      const part = keys.slice(i, i + 40);
      const rows = await all(env, `SELECT * FROM evidence WHERE (${part.map(() => '(class_code=? AND unit_code=?)').join(' OR ')})${status ? ' AND status=?' : ''}`,
        ...part.flat(), ...(status ? [status] : []));
      list.push(...rows);
    }
    list.sort((a, c) => String(c.submitted_at).localeCompare(String(a.submitted_at)));
  }
  // A panel member sees the approved evidence of the class-units given to them; an External Assessment Officer, only the
  // students in the sample of the ones given to them.
  if (!seesAll(me)) {
    const mineV = await all(env, "SELECT class_code, unit_code, sample, verifier, external FROM verifications WHERE lower(verifier)=lower(?) OR (lower(external)=lower(?) AND status IN ('submitted','signed'))", me.code, me.code);
    const have = new Set(list.map((r) => r.id));
    for (const v of mineV) {
      const rows = await all(env, "SELECT * FROM evidence WHERE class_code=? AND unit_code=? AND status='approved'", v.class_code, v.unit_code);
      const only = lower(v.verifier) === lower(me.code) ? null : new Set(JSON.parse(v.sample || '[]').map(lower));
      for (const r of rows) if (!have.has(r.id) && (!only || only.has(lower(r.adm_no)))) { have.add(r.id); list.push(r); }
    }
  }
  // Links into Drive: the trainer's own attendance sheet; the evidence index for the HOD and MIS Officer.
  const rep = JSON.parse((await getMeta(env, 'drive_report')) || 'null') || {};
  const sheetUrl = Object.entries(rep.sheets || {}).find(([c]) => lower(c) === lower(me.code))?.[1] || '';
  return { ok: true, evidence: list.map(evidenceOut), marks: await marksFor(env, list), mine: [...now], sheetUrl, indexUrl: seesAll(me) ? rep.indexUrl || '' : '', driveReady: !!rep.url };
}
async function evidenceFor(env, id, me, decide) {
  const r = await one(env, 'SELECT * FROM evidence WHERE id=?', String(id || ''));
  if (!r) fail('That submission no longer exists');
  const { pairs, loading } = await myUnitPairs(env, me);
  const key = r.class_code + '|' + r.unit_code;
  let ok = pairs.has(key) || me.roles.includes('HOD') || (!decide && (me.roles.includes('MIS') || me.roles.includes('IAO') || (await everTaught(env, me)).has(key)));
  if (!ok && !decide) ok = await verifiesEvidence(env, me, r);
  if (!ok && decide && !unitsForClass(loading.filter((u) => u.unit_code === r.unit_code), r.class_code).length) {
    // The unit is not taught this term (it has ended or pauses): the trainer who had it last decides.
    const past = await all(env, 'SELECT l.class_code, l.trainer_code FROM loading l LEFT JOIN terms t ON t.id=l.term_id WHERE l.unit_code=? ORDER BY t.start_date DESC', r.unit_code);
    const last = unitsForClass(past, r.class_code)[0];
    ok = !!last && lower(last.trainer_code) === lower(me.code);
  }
  if (!ok) fail('Only the trainer of this unit or the HOD can do that');
  return r;
}
async function poeView(env, b, me) {
  const r = await evidenceFor(env, b.id, me, false);
  // In the student's Drive: the trainer's own Google sign-in opens it; the fingerprint shows if it changed since.
  // A panel member or an Assessment Officer it is not shared with opens it through the bridge (the backup account can read it).
  const sharedWithMe = me.roles.includes('HOD') || me.roles.includes('MIS') || (await myUnitPairs(env, me)).pairs.has(r.class_code + '|' + r.unit_code) || (await everTaught(env, me)).has(r.class_code + '|' + r.unit_code);
  if (r.source === 'drive' && sharedWithMe) return { ok: true, source: 'drive', fileId: r.file_id, fileName: r.file_name, md5: r.md5 || '', ownerEmail: r.owner_email || '' };
  const url = await getMeta(env, 'drive_url');
  if (!url) fail('The Google Drive link is not set up yet');
  return { ok: true, driveUrl: url, fileName: r.file_name, ticket: await signTicket(env, { k: 'view', fileId: r.file_id, exp: Date.now() + 10 * 6e4 }) };
}
/** Reports in bulk: a ticket for the bridge to save this run's files in Drive (Reports / <run> / ...), good for three hours. */
async function bulkTicket(env, b, me) {
  const url = await getMeta(env, 'drive_url');
  if (!url) fail('The Google Drive link is not set up yet');
  const run = String(b.run || todayIso()).replace(/[\/:*?"<>|]+/g, '-').slice(0, 80);
  await audit(env, me, 'reports in bulk', run);
  return { ok: true, driveUrl: url, ticket: await signTicket(env, { k: 'bulk', run, by: me.name, exp: Date.now() + 3 * 3600e3 }) };
}
/** A trainer's device found the file in the student's Drive no longer matches what was sent. */
async function poeChanged(env, b, me) {
  const r = await evidenceFor(env, b.id, me, false);
  if (r.source !== 'drive' || !b.md5 || b.md5 === r.md5 || r.changed_at) return { ok: true };
  const now = nowIso();
  await many(env, ['UPDATE evidence SET changed_at=?, updated_at=? WHERE id=?', now, now, r.id], changedStmt());
  await audit(env, me, 'evidence changed', `${r.adm_no} ${r.unit_code} ${r.item} v${r.version}: the file in the student's Drive changed after it was sent`);
  return { ok: true, changedAt: now };
}
/** Connect Google in the staff app: the address students' files are shared with. Checked with Google, never typed in. */
async function setGoogle(env, b, me) {
  if (b.clear) { await run(env, 'UPDATE staff SET email=NULL, g_refresh=NULL, updated_at=? WHERE code=?', nowIso(), me.code); return { ok: true, email: '' }; }
  const u = await google(env, '/oauth2/v3/userinfo', b.accessToken);
  const email = lower(u.email || '');
  if (!email || u.email_verified === false) fail('Google did not give an email address');
  if (!okDomain(env, email)) fail(`Use your college Google account (@${env.GOOGLE_DOMAIN}), not ${email}.`);
  await many(env, ['UPDATE staff SET email=?, updated_at=? WHERE code=?', email, nowIso(), me.code], changedStmt());
  return { ok: true, email };
}
async function setArchiveEmail(env, b, me) {
  const email = lower(String(b.email || '').trim());
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('That does not look like an email address');
  if (email && !okDomain(env, email)) fail(`Use a college Google account (@${env.GOOGLE_DOMAIN})`);
  const quotaGb = Math.round(Number(b.quotaGb) || 0) || Number(await getMeta(env, 'backup_quota_gb')) || 50;
  if (quotaGb < 1 || quotaGb > 100000) fail('Give the space in GB, from 1 to 100000');
  await many(env, metaStmt('archive_email', email), metaStmt('backup_quota_gb', quotaGb));
  await audit(env, me, 'backup account', `${email || '(none)'}, ${quotaGb} GB`);
  return { ok: true, email, quotaGb };
}
async function poeDecide(env, b, me, ctx, pinDone = false) {
  const r = await evidenceFor(env, b.id, me, true);
  if (!['approved', 'returned'].includes(b.decision)) fail('Choose approve or return');
  let comment = String(b.comment || '').trim().slice(0, 500);
  if (b.decision === 'returned' && !comment) fail('Say what needs fixing when returning evidence');
  if (b.decision === 'approved' && !pinDone) await confirmPin(env, me, b.pin);
  if (b.decision === 'approved' && !comment) comment = OK_SAID.poe;
  const now = nowIso();
  // seen_at goes back to empty: a fresh decision is something the student has not been told yet.
  await run(env, 'UPDATE evidence SET status=?, decided_by=?, decided_name=?, decided_at=?, comment=?, updated_at=?, seen_at=NULL WHERE id=?', b.decision, me.code, me.name, now, comment, now, r.id);
  if (b.decision === 'approved') {
    const ref = await makeApproval(env, me, me.roles.includes('HOD') && !(await myUnitPairs(env, me)).pairs.has(r.class_code + '|' + r.unit_code) ? 'HOD' : 'Trainer', 'poe', r.id,
      `POE evidence - ${r.item} - ${r.unit_code} ${r.unit_name || ''}`.trim(), { classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name, item: r.item, version: r.version }, evidencePrint(r));
    await run(env, 'UPDATE evidence SET approval_ref=? WHERE id=?', ref, r.id);
  } else await withdrawApprovals(env, 'poe', r.id);
  await audit(env, me, 'evidence', `${r.adm_no} ${r.unit_code} ${r.item} v${r.version} ${b.decision}`);
  pushLater(ctx, env, r.adm_no);
  return { ok: true, evidence: evidenceOut(await one(env, 'SELECT * FROM evidence WHERE id=?', r.id)) };
}
/** Approves several submissions at once (one PIN). Each gets its own approval; the students are told. */
async function poeDecideMany(env, b, me, ctx) {
  const ids = [...new Set((b.ids || []).map(String))].slice(0, BATCH_MAX);
  if (!ids.length) fail('Choose the evidence to approve');
  await confirmPin(env, me, b.pin);
  const out = [], failed = [];
  for (const id of ids) {
    try { out.push((await poeDecide(env, { id, decision: 'approved', comment: b.comment }, me, ctx, true)).evidence); } catch (e) { failed.push({ id, error: e.message }); }
  }
  return { ok: true, evidence: out, failed };
}
async function poeReceive(env, b, me) {
  const ids = (b.ids || []).map(String).slice(0, 1000), now = nowIso();
  await run(env, `UPDATE evidence SET received_at=?, updated_at=? WHERE status='approved' AND received_at IS NULL AND id IN ${IN}`, now, now, JSON.stringify(ids));
  await audit(env, me, 'evidence received', `${ids.length} file(s)`);
  return { ok: true };
}
/* ---------- marks (continuous assessment): entered in the app, offline too; the Drive sheet mirrors them ---------- */
const MARK_COLS = ['cat1', 'cat2', 'cat3', 'prac1', 'prac2', 'prac3'];
// Marks are whole numbers from 0 to 100.
const markOf = (v) => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 100) fail('Marks are whole numbers from 0 to 100'); return n; };
const marksOut = (r) => ({ admNo: r.adm_no, ...Object.fromEntries(MARK_COLS.map((c) => [c, r[c] ?? null])), updatedAt: r.updated_at, updatedBy: r.updated_by || '' });
const metaOf = (r) => { try { return JSON.parse(r?.meta || '{}') || {}; } catch { return {}; } };
/** The cells of a row entered in a term that has ended, and not unlocked for this class and unit: they cannot change. */
function lockedCells(r, activeId, open, cls, unit) {
  const meta = metaOf(r);
  return MARK_COLS.filter((c) => { const t = meta[c]?.term; return t && activeId && t !== activeId && !open.has(`${t}|${cls}|${unit}`); });
}
async function marksAccess(env, me, cls, unit, write) {
  if (!cls || !unit) fail('Choose the class and unit');
  if (me.roles.includes('HOD') || (!write && (me.roles.includes('MIS') || me.roles.includes('IAO')))) return;
  const { pairs } = await myUnitPairs(env, me);
  if (!pairs.has(cls + '|' + unit)) fail('Only the trainer of this unit (or the HOD) can enter its marks');
}
async function marksPull(env, b, me) {
  const cls = String(b.classCode || ''), unit = String(b.unitCode || '');
  await marksAccess(env, me, cls, unit, false);
  const [rows, termRows] = await many(env, ['SELECT * FROM unit_marks WHERE class_code=? AND unit_code=?', cls, unit], [TERM_SQL]);
  const activeId = termRows[0]?.id || '', open = await unlockedSet(env);
  const terms = Object.fromEntries((await all(env, 'SELECT id, name FROM terms')).map((x) => [x.id, x.name]));
  const sheet = msOut(await one(env, 'SELECT * FROM marksheets WHERE id=?', msId(cls, unit)));
  return { ok: true, classCode: cls, unitCode: unit, activeTerm: activeId, sheet,
    rows: rows.map((r) => { const meta = metaOf(r); return { ...marksOut(r), locked: lockedCells(r, activeId, open, cls, unit),
      terms: Object.fromEntries(MARK_COLS.filter((c) => meta[c]?.term).map((c) => [c, terms[meta[c].term] || meta[c].term])) }; }),
    lockedTerms: [...new Set(rows.flatMap((r) => lockedCells(r, activeId, open, cls, unit).map((c) => metaOf(r)[c].term)))].map((id) => ({ id, name: terms[id] || id })) };
}
/** One marksheet per unit for its whole life. A row's newer edit wins (two devices of one trainer do not undo each
 * other); each cell remembers the term it was entered in, and cells from an ended term stay as they were unless unlocked. */
async function marksPush(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail('The MIS Officer has not set up the term yet');
  const cls = String(b.classCode || ''), unit = String(b.unitCode || '');
  await marksAccess(env, me, cls, unit, true);
  const now = nowIso(), open = await unlockedSet(env);
  const incoming = (b.rows || []).slice(0, 400).filter((r) => r && r.admNo);
  const have = new Map((await all(env, `SELECT * FROM unit_marks WHERE class_code=? AND unit_code=? AND adm_no IN ${IN}`, cls, unit,
    JSON.stringify(incoming.map((r) => String(r.admNo).trim())))).map((r) => [lower(r.adm_no), r]));
  let held = 0;
  const writes = [];
  for (const r of incoming) {
    const adm = String(r.admNo).trim(), old = have.get(lower(adm));
    const at = String(r.updatedAt || now) > now ? now : String(r.updatedAt || now);
    if (old && String(old.updated_at || '') > at) continue;
    const meta = metaOf(old), locked = new Set(old ? lockedCells(old, term.id, open, cls, unit) : []);
    const vals = MARK_COLS.map((c) => {
      const v = markOf(r[c]), was = old ? old[c] ?? null : null;
      if (v === was) return was;
      if (locked.has(c)) { held++; return was; }
      meta[c] = { term: term.id, by: me.code, at: now };
      return v;
    });
    writes.push([cls, unit, adm, ...vals, JSON.stringify(meta), at, me.code, now]);
  }
  const sql = `INSERT INTO unit_marks (class_code,unit_code,adm_no,${MARK_COLS.join(',')},meta,updated_at,updated_by,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(class_code,unit_code,adm_no) DO UPDATE SET ${MARK_COLS.map((c) => `${c}=excluded.${c}`).join(', ')}, meta=excluded.meta, updated_at=excluded.updated_at,
    updated_by=excluded.updated_by, synced_at=excluded.synced_at`;
  for (let i = 0; i < writes.length; i += 50) await many(env, ...writes.slice(i, i + 50).map((w) => [sql, ...w]));
  if (writes.length) await audit(env, me, 'marks', `${cls} ${unit}: ${writes.length} student(s)${held ? `, ${held} locked mark(s) kept` : ''}`);
  return { ...(await marksPull(env, b, me)), held };
}
/** CDACC registration numbers, from any sheet with admission numbers and registration codes (a marksheet works). */
async function importRegCodes(env, b, me) {
  const pairs = (b.rows || []).map((r) => [String(r.admNo || '').trim(), String(r.regCode || '').trim()]).filter(([a, c]) => a && c).slice(0, 5000);
  if (!pairs.length) fail('No admission numbers with registration codes were found in that file');
  const known = new Set((await all(env, `SELECT adm_no FROM trainees WHERE adm_no IN ${IN}`, JSON.stringify(pairs.map((p) => p[0])))).map((r) => lower(r.adm_no)));
  const use = pairs.filter(([a]) => known.has(lower(a))), now = nowIso();
  for (let i = 0; i < use.length; i += 50) await many(env, ...use.slice(i, i + 50).map(([a, c]) => ['UPDATE trainees SET reg_code=?, updated_at=? WHERE adm_no=?', c, now, a]));
  await audit(env, me, 'registration codes', `${use.length} of ${pairs.length}`);
  if (use.length) await bumpRoster(env);
  return { ok: true, updated: use.length, unknown: pairs.filter(([a]) => !known.has(lower(a))).map(([a]) => a).slice(0, 50), total: pairs.length };
}

/** POE by student: the classes taught this term, and for one class its students and units. */
/** The marks (the unit's whole-life marksheet) of the students in these evidence rows: [{ c, u, a, cat1 … prac3 }]. */
const markOut = (r) => Object.fromEntries([['c', r.class_code], ['u', r.unit_code], ['a', r.adm_no], ...MARK_COLS.filter((k) => r[k] !== null && r[k] !== undefined).map((k) => [k, r[k]])]);
async function marksFor(env, rows) {
  const keys = [...new Set(rows.map((r) => r.class_code + '|' + r.unit_code))].map((k) => k.split('|')), want = new Set(rows.map((r) => lower(r.adm_no)));
  const out = [];
  for (let i = 0; i < keys.length; i += 40) {
    const part = keys.slice(i, i + 40);
    const got = await all(env, `SELECT class_code, unit_code, adm_no, ${MARK_COLS.join(', ')} FROM unit_marks WHERE ${part.map(() => '(class_code=? AND unit_code=?)').join(' OR ')}`, ...part.flat());
    for (const r of got) if (want.has(lower(r.adm_no))) out.push(markOut(r));
  }
  return out;
}
async function poeClass(env, b) {
  const loading = await all(env, `SELECT class_code, unit_code, unit_name FROM loading WHERE term_id=${ACTIVE_TERM}`);
  const classes = [...new Set(loading.flatMap((u) => classParts(u.class_code)))].sort();
  const cls = String(b.classCode || '');
  if (!cls) return { ok: true, classes };
  const seen = new Set(), units = [];
  for (const u of unitsForClass(loading, cls)) if (!seen.has(u.unit_code)) { seen.add(u.unit_code); units.push({ code: u.unit_code, name: u.unit_name || u.unit_code }); }
  const students = (await all(env, `SELECT adm_no, name FROM trainees WHERE class_code=? AND COALESCE(status,'') NOT IN ${GONE} ORDER BY name`, cls))
    .map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no }));
  const marks = (await all(env, `SELECT class_code, unit_code, adm_no, ${MARK_COLS.join(', ')} FROM unit_marks WHERE class_code=?`, cls)).map(markOut);
  return { ok: true, classes, classCode: cls, units, students, marks };
}
/* ---------- internal verification of POE: panels, sampling, checks, results ---------- */
// A panel is drafted by the MIS Officer or the Internal Assessment Officer and approved by the HOD. Each class-unit is given to
// one member (never its own trainer), who checks a sample of the students whose evidence the trainer approved.
const SAMPLE_MIN = 5, SAMPLE_MAX = 10;
const VERDICTS = ['verified', 'actions', 'not_verified'];
/** A small seeded random generator (mulberry32), so a sample can be drawn again exactly from its saved seed. */
function seeded(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** How many to check: everyone up to 10; otherwise the larger of 10 and the square root of the population times the risk. */
export const sampleSize = (n, risk) => (n <= SAMPLE_MIN ? n : Math.min(n, SAMPLE_MAX, Math.max(SAMPLE_MIN, Math.ceil(Math.sqrt(n) * risk))));
/** Everything the draw needs about one class-unit: the population, why each might be included, and the trainer's risk. */
async function samplingFacts(env, cls, unit, trainerCode, termId) {
  const parts = classParts(cls).length ? classParts(cls) : [cls];
  const [roster, ev, marks, before, last] = await many(env, [`SELECT adm_no FROM trainees WHERE class_code IN ${IN} AND COALESCE(status,'') NOT IN ${GONE}`, JSON.stringify(parts)],
    ['SELECT adm_no, item, status, changed_at FROM evidence WHERE class_code=? AND unit_code=?', cls, unit],
    [`SELECT adm_no, ${MARK_COLS.join(', ')} FROM unit_marks WHERE class_code=? AND unit_code=?`, cls, unit],
    ['SELECT 1 AS x FROM loading WHERE unit_code=? AND lower(trainer_code)=lower(?) AND term_id<>? LIMIT 1', unit, trainerCode || '', termId || ''],
    ["SELECT result FROM verifications WHERE lower(trainer_code)=lower(?) AND status IN ('submitted','signed') ORDER BY submitted_at DESC LIMIT 1", trainerCode || '']);
  const approved = new Set(ev.filter((e) => e.status === 'approved').map((e) => lower(e.adm_no)));
  // N is the class size: the sample is drawn from the whole class list as the unit is given out (a student with no approved
  // evidence in the sample is itself something the verifiers record).
  const pop = [...new Set(roster.length ? roster.map((r) => lower(r.adm_no)) : approved)].sort();
  const returned = new Set(ev.filter((e) => e.status === 'returned').map((e) => lower(e.adm_no) + '|' + e.item));
  const backAgain = new Set(ev.filter((e) => e.status === 'approved' && returned.has(lower(e.adm_no) + '|' + e.item)).map((e) => lower(e.adm_no)));
  const changed = new Set(ev.filter((e) => e.status === 'approved' && e.changed_at).map((e) => lower(e.adm_no)));
  const avg = new Map();
  for (const m of marks) { const v = MARK_COLS.map((k) => m[k]).filter((n) => n !== null && n !== undefined); if (v.length) avg.set(lower(m.adm_no), v.reduce((a, b) => a + b, 0) / v.length); }
  const why = [];
  let risk = 1;
  if (trainerCode && !before.length) { risk = Math.max(risk, 1.5); why.push('the trainer is new to this unit'); }
  if (approved.size && !ev.some((e) => e.status === 'returned')) { risk = Math.max(risk, 1.5); why.push('nothing was returned'); }
  if (last[0]?.result === 'not_verified') { risk = 2; why.push("the trainer's last verification was not verified"); }
  return { pop, backAgain, changed, avg, risk, why };
}
/** The draw: those who must be looked at first (returned then approved, changed after sending, one from each third of the
 * marks), then at random from the seed until the sample is full. reasons: adm → why they are in it. */
function drawSample(f, size, seed, keep = []) {
  const rnd = seeded(seed), out = [...keep], reasons = {};
  const add = (adm, why) => { if (out.length < size && f.pop.includes(adm) && !out.includes(adm)) { out.push(adm); reasons[adm] = why; } };
  for (const a of f.pop) if (f.backAgain.has(a)) add(a, 'returned, then approved');
  for (const a of f.pop) if (f.changed.has(a)) add(a, 'changed after sending');
  const marked = f.pop.filter((a) => f.avg.has(a)).sort((a, b) => f.avg.get(b) - f.avg.get(a));
  if (marked.length >= 3) {
    const third = Math.ceil(marked.length / 3);
    [['top', 0], ['middle', 1], ['bottom', 2]].forEach(([name, k]) => {
      const band = marked.slice(k * third, (k + 1) * third).filter((a) => !out.includes(a));
      if (band.length) add(band[Math.floor(rnd() * band.length)], `${name} third of the marks`);
    });
  }
  const rest = f.pop.filter((a) => !out.includes(a));
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  for (const a of rest) add(a, 'at random');
  return { sample: out, reasons };
}
const panelOut = (r) => ({ id: r.id, termId: r.term_id, number: r.number || null, name: r.name, chair: r.chair, members: JSON.parse(r.members || '[]'), status: r.status, note: r.note || '',
  createdBy: r.created_by, createdAt: r.created_at, decidedBy: r.decided_by || '', decidedAt: r.decided_at || '' });
const verOut = (r) => ({ id: r.id, panelId: r.panel_id, classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name, trainerCode: r.trainer_code, trainerName: r.trainer_name,
  verifier: r.verifier, external: r.external || '', population: r.population, risk: r.risk, size: r.size, seed: r.seed, sample: JSON.parse(r.sample || '[]'),
  reasons: JSON.parse(r.reasons || '{}'), round: r.round || 1, status: r.status, result: r.result || '', actions: r.actions || '', response: r.response || '',
  respondedAt: r.responded_at || '', submittedAt: r.submitted_at || '', signedBy: r.signed_by || '', signedAt: r.signed_at || '',
  extResult: r.ext_result || '', extNote: r.ext_note || '', extAt: r.ext_at || '', log: JSON.parse(r.log || '[]'),
  v1: { result: r.v1_result || '', actions: r.v1_actions || '', at: r.v1_at || '' },
  extSample: JSON.parse(r.ext_sample || '[]') });
const checkOut = (r) => ({ verificationId: r.verification_id, admNo: r.adm_no, who: r.who, valid: !!r.valid, authentic: !!r.authentic, current: !!r.current,
  sufficient: !!r.sufficient, agree: r.agree === null ? null : !!r.agree, comment: r.comment || '', by: r.by_code, at: r.at });
/** 'internal' when this person is the class-unit's verifier, else ''. */
const verifierSlot = (v, code) => (lower(v.verifier) === lower(code) ? 'internal' : '');
const inPanel = (p, code) => p && (lower(p.chair) === lower(code) || JSON.parse(p.members || '[]').some((m) => lower(m) === lower(code)));
async function verifiesEvidence(env, me, r) {
  const rows = await all(env, 'SELECT verifier, external, sample, ext_sample, status FROM verifications WHERE class_code=? AND unit_code=?', r.class_code, r.unit_code);
  const inList = (s) => JSON.parse(s || '[]').some((a) => lower(a) === lower(r.adm_no));
  // The two verifiers see the class-unit's evidence; an External Assessment Officer sees any student in a sample (theirs or the panel's).
  return rows.some((v) => verifierSlot(v, me.code) || (me.roles.includes('EAO') && (inList(v.sample) || inList(v.ext_sample))));
}
/** Panels, the class-units given out, and the checks this person may see; with the staff and loading to choose from. */
async function verifyData(env, b, me) {
  const term = await activeTerm(env);
  const [panels, vers, staff, loading] = await many(env, ['SELECT * FROM panels ORDER BY term_id DESC, number, created_at'], ['SELECT * FROM verifications ORDER BY updated_at DESC'],
    ['SELECT code, name, roles, active, ends_on FROM staff WHERE active=1 ORDER BY name'], [`SELECT class_code, unit_code, unit_name, trainer_code, trainer_name FROM loading WHERE term_id=${ACTIVE_TERM}`]);
  const office = seesAll(me), ext = me.roles.includes('EAO');
  // The External Assessment Officer sees every panel and what each was given (this term).
  const myPanels = panels.filter((p) => office || (p.status === 'approved' && (inPanel(p, me.code) || (ext && p.term_id === term?.id))));
  const panelIds = new Set(myPanels.map((p) => p.id));
  const seeV = vers.filter((v) => office || panelIds.has(v.panel_id) || verifierSlot(v, me.code) || lower(v.external) === lower(me.code)
    || (lower(v.trainer_code) === lower(me.code) && ['submitted', 'signed'].includes(v.status)));
  const ids = seeV.map((v) => v.id);
  const checks = ids.length ? await all(env, `SELECT * FROM verify_checks WHERE verification_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)) : [];
  // A trainer sees the verifier's findings on their units, not the external officer's working; the external officer sees both.
  const seeCheck = (c) => { const v = seeV.find((x) => x.id === c.verification_id); return office || ext || verifierSlot(v, me.code) || panelIds.has(v.panel_id) || c.who !== 'external'; };
  const names = Object.fromEntries((await all(env, `SELECT adm_no, name FROM trainees WHERE adm_no IN (SELECT value FROM json_each(?))`, JSON.stringify([...new Set(seeV.flatMap((v) => [...JSON.parse(v.sample || '[]'), ...JSON.parse(v.ext_sample || '[]')]))]))).map((t) => [lower(t.adm_no), t.name]));
  const list = office || ext ? (await all(env, 'SELECT * FROM verify_list WHERE term_id=? ORDER BY class_code, unit_code', term?.id || '')).map((r) => ({ classCode: r.class_code, unitCode: r.unit_code,
    unitName: r.unit_name || r.unit_code, trainerCode: r.trainer_code || '', trainerName: r.trainer_name || '', students: r.students || 0,
    verificationId: seeV.find((v) => v.class_code === r.class_code && v.unit_code === r.unit_code && myPanels.some((p) => p.id === v.panel_id && p.term_id === term?.id))?.id || '' })) : [];
  return { ok: true, termId: term?.id || '', panels: myPanels.map(panelOut), verifications: seeV.map(verOut), checks: checks.filter(seeCheck).map(checkOut), names,
    staff: office ? staff.map((s) => ({ code: s.code, name: s.name, roles: rolesList(s.roles), endsOn: s.ends_on || '' })) : staff.filter((s) => myPanels.some((p) => inPanel(p, s.code)) || hasRole(s.roles, 'EAO')).map((s) => ({ code: s.code, name: s.name, roles: rolesList(s.roles) })),
    loading: office ? loading.map((u) => ({ classCode: u.class_code, unitCode: u.unit_code, unitName: u.unit_name || u.unit_code, trainerCode: u.trainer_code, trainerName: u.trainer_name })) : [],
    list, sampleMin: SAMPLE_MIN,
    classStudents: office ? Object.fromEntries((await all(env, `SELECT class_code, COUNT(*) AS n FROM trainees WHERE COALESCE(status,'') NOT IN ${GONE} GROUP BY class_code`)).map((r) => [r.class_code, r.n])) : {} };
}
async function savePanel(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail('Set up the term first');
  const chair = String(b.chair || '').trim();
  const members = [...new Set([chair, ...(Array.isArray(b.members) ? b.members : [])].map((m) => String(m || '').trim()).filter(Boolean))];
  // The panel's number this term; its name is the term and the number, e.g. "Term 3 2026 - Panel 1".
  const taken = await all(env, 'SELECT id, number FROM panels WHERE term_id=? AND number IS NOT NULL', term.id);
  let number = Math.round(Number(b.number) || 0);
  if (!number) { const old = b.id && taken.find((t) => t.id === String(b.id)); number = old ? old.number : Math.max(0, ...taken.map((t) => t.number)) + 1; }
  if (number < 1 || number > 50) fail('Choose a panel number from 1 to 50');
  if (taken.some((t) => t.number === number && t.id !== String(b.id || ''))) fail(`There is already a panel ${number} this term`);
  const name = `${term.name} - Panel ${number}`;
  if (!chair) fail('Choose the chair');
  if (members.length < 2) fail('A panel needs the chair and at least one more member');
  const known = new Set((await all(env, 'SELECT code FROM staff WHERE active=1')).map((s) => lower(s.code)));
  if (members.some((m) => !known.has(lower(m)))) fail('Every member must be an active staff member');
  // Each person sits on one panel a term.
  const others = await all(env, 'SELECT id, name, members FROM panels WHERE term_id=? AND id<>?', term.id, String(b.id || ''));
  const busy = members.map((m) => ({ m, p: others.find((o) => JSON.parse(o.members || '[]').some((x) => lower(x) === lower(m))) })).filter((x) => x.p);
  if (busy.length) fail(`${busy.map((x) => `${x.m} is already on ${x.p.name}`).join('; ')}. A member sits on one panel only.`);
  const now = nowIso();
  if (b.id) {
    const p = await one(env, 'SELECT * FROM panels WHERE id=?', String(b.id));
    if (!p) fail('That panel no longer exists');
    // Panels are approved for the HOD as they are saved; the HOD can still return one.
    await run(env, "UPDATE panels SET name=?, number=?, chair=?, members=?, status='approved', note='', decided_by=?, decided_at=?, updated_at=? WHERE id=?", name, number, chair, JSON.stringify(members), 'Approved automatically', now, now, p.id);
    await audit(env, me, 'panel', `${name}: changed (approved automatically)`);
    return { ok: true, panel: panelOut(await one(env, 'SELECT * FROM panels WHERE id=?', p.id)) };
  }
  const id = crypto.randomUUID();
  await run(env, "INSERT INTO panels (id,term_id,name,number,chair,members,status,created_by,created_at,decided_by,decided_at,updated_at) VALUES (?,?,?,?,?,?,'approved',?,?,?,?,?)",
    id, term.id, name, number, chair, JSON.stringify(members), me.name, now, 'Approved automatically', now, now);
  await audit(env, me, 'panel', `${name}: drafted (approved automatically)`);
  return { ok: true, panel: panelOut(await one(env, 'SELECT * FROM panels WHERE id=?', id)) };
}
const logLine = (me, what) => ({ at: nowIso(), by: me.name, what });
async function assignVerification(env, b, me) {
  const p = await one(env, 'SELECT * FROM panels WHERE id=?', String(b.panelId || ''));
  if (!p || p.status !== 'approved') fail('The HOD has to approve the panel first');
  const cls = String(b.classCode || ''), unit = String(b.unitCode || ''), verifier = String(b.verifier || '');
  if (!inPanel(p, verifier)) fail('Choose a member of this panel');
  const term = await activeTerm(env);
  const load = unitsForClass(await all(env, `SELECT * FROM loading WHERE term_id=${ACTIVE_TERM} AND unit_code=?`, unit), cls)[0];
  if (!load) fail('That class and unit are not in this term\'s loading');
  const own = await teachersOf(env, unit);
  if (own.has(lower(verifier))) fail('A member cannot verify a unit they teach. Choose another member.');
  if (await one(env, 'SELECT 1 AS x FROM verifications v JOIN panels p ON p.id=v.panel_id WHERE p.term_id=? AND v.class_code=? AND v.unit_code=?', p.term_id, cls, unit)) fail('That class and unit has already been given out this term');
  const v = await createVerification(env, me, p, load, verifier, term);
  return { ok: true, verification: verOut(v) };
}
/** Everyone who teaches a unit this term (any class): none of them verifies it. */
async function teachersOf(env, unit) {
  return new Set((await all(env, `SELECT trainer_code FROM loading WHERE term_id=${ACTIVE_TERM} AND unit_code=?`, unit)).map((r) => lower(r.trainer_code)).filter(Boolean));
}
/** A class-unit given to two members: the sample is drawn now, or later once some evidence is approved. */
async function createVerification(env, me, p, load, verifier, term, note = '') {
  const cls = load.class_code, unit = load.unit_code;
  const f = await samplingFacts(env, cls, unit, load.trainer_code, term?.id);
  const size = sampleSize(f.pop.length, f.risk), seed = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const { sample, reasons } = drawSample(f, size, seed);
  const id = crypto.randomUUID(), now = nowIso();
  const line = f.pop.length ? `sample of ${size} from the class of ${f.pop.length} drawn${f.why.length ? ` (higher risk: ${f.why.join(', ')})` : ''}` : 'the class list is empty: no sample';
  await run(env, `INSERT INTO verifications (id,panel_id,class_code,unit_code,unit_name,trainer_code,trainer_name,verifier,population,risk,size,seed,sample,reasons,round,status,log,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'open',?,?)`, id, p.id, cls, unit, load.unit_name || unit, load.trainer_code, load.trainer_name || '', verifier,
  f.pop.length, f.risk, size, seed, JSON.stringify(sample), JSON.stringify(reasons), JSON.stringify([logLine(me, `given to ${verifier}; ${line}${note ? ` (${note})` : ''}`)]), now);
  await audit(env, me, 'verification', `${cls} ${unit} to ${verifier}: ${size} of ${f.pop.length}${note ? ` (${note})` : ''}`);
  return one(env, 'SELECT * FROM verifications WHERE id=?', id);
}

/* ---------- the master list and giving it out automatically ----------
 * The MIS Officer (or the Internal Assessment Officer) lists the class-units to verify this term. Allocating gives each
 * one to a panel - the biggest classes first, each to the panel with the fewest students so far - and, within it, to two
 * members picked at random among those with the fewest students so far. Nobody verifies a unit they teach. */
/** The MIS Officer ticks the trainers and the classes; the system makes the panels (about `size` members each, no more
 *  panels than classes), names and numbers them, then allocates: classes to panels by students, units to two members. */
async function setupVerification(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail('Set up the term first');
  const want = [...new Set((b.trainers || []).map((c) => String(c).trim()).filter(Boolean))];
  const classes = [...new Set((b.classes || []).map(String).filter(Boolean))];
  if (!want.length) fail('Tick the trainers who verify');
  if (!classes.length) fail('Tick the classes to verify');
  const staff = await all(env, `SELECT code, name, roles FROM staff WHERE active=1 AND code IN ${IN}`, JSON.stringify(want));
  const people = staff.filter((s) => !hasRole(s.roles, 'EAO')).map((s) => s.code);
  if (!people.length) fail('Tick at least one active trainer');
  // Starting again is fine until any checking has begun.
  const old = (await all(env, 'SELECT v.id FROM verifications v JOIN panels p ON p.id=v.panel_id WHERE p.term_id=?', term.id)).map((r) => r.id);
  if (old.length && (await one(env, `SELECT 1 AS x FROM verify_checks WHERE verification_id IN ${IN} LIMIT 1`, JSON.stringify(old)))) fail("Checking has already started this term. Delete this term's verification first if you really want to start again.");
  await many(env, [`DELETE FROM verifications WHERE id IN ${IN}`, JSON.stringify(old)], ['DELETE FROM panels WHERE term_id=?', term.id], ['DELETE FROM verify_list WHERE term_id=?', term.id]);
  const size = Math.max(1, Math.min(8, Math.round(Number(b.size) || 3)));
  const count = Math.max(1, Math.min(Math.floor(people.length / size), classes.length));
  // Trainers are shuffled (with a seed, so it can be repeated), then dealt round the panels.
  const rnd = seeded(String(b.seed || crypto.randomUUID()));
  const deck = people.map((c) => ({ c, k: rnd() })).sort((a, d) => a.k - d.k).map((x) => x.c);
  const groups = Array.from({ length: count }, () => []);
  deck.forEach((c, i) => groups[i % count].push(c));
  const now = nowIso(), made = [];
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID(), name = `${term.name} - Panel ${i + 1}`;
    made.push(['INSERT INTO panels (id,term_id,name,number,chair,members,status,created_by,created_at,decided_by,decided_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, term.id, name, i + 1, groups[i][0], JSON.stringify(groups[i]), 'approved', me.name, now, 'Approved automatically', now, now]);
  }
  await many(env, ...made);
  await audit(env, me, 'verification set up', `${people.length} trainers in ${count} panel(s), ${classes.length} class(es)`);
  await verifyListSave(env, { classes }, me);
  const r = await allocateVerification(env, { seed: b.seed }, me);
  return { ...r, panels: count, trainers: people.length };
}
async function verifyListSave(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail('Set up the term first');
  const loading = await all(env, `SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`);
  // Classes chosen: every unit the class has this term. Single class-units can still be added or removed.
  const classes = new Set((b.classes || []).map(String)), dropClasses = new Set((b.removeClasses || []).map(String));
  const want = [...(b.items || []).map((i) => ({ classCode: String(i.classCode || ''), unitCode: String(i.unitCode || '') })),
    ...loading.filter((l) => classes.has(l.class_code)).map((l) => ({ classCode: l.class_code, unitCode: l.unit_code }))].filter((i) => i.classCode && i.unitCode).slice(0, 800);
  const drop = [...(b.remove || []).map((i) => [String(i.classCode || ''), String(i.unitCode || '')]),
    ...(dropClasses.size ? (await all(env, 'SELECT class_code, unit_code FROM verify_list WHERE term_id=?', term.id)).filter((r) => dropClasses.has(r.class_code)).map((r) => [r.class_code, r.unit_code]) : [])].slice(0, 800);
  const counts = new Map((await all(env, `SELECT class_code, COUNT(*) AS n FROM trainees WHERE COALESCE(status,'') NOT IN ${GONE} GROUP BY class_code`)).map((r) => [r.class_code, r.n]));
  const now = nowIso(), rows = [];
  for (const i of want) {
    const u = loading.find((l) => l.class_code === i.classCode && l.unit_code === i.unitCode);
    if (!u) continue;
    const students = (classParts(u.class_code).length ? classParts(u.class_code) : [u.class_code]).reduce((n, c) => n + (counts.get(c) || 0), 0);
    rows.push({ term_id: term.id, class_code: u.class_code, unit_code: u.unit_code, unit_name: u.unit_name || u.unit_code, trainer_code: u.trainer_code || '', trainer_name: u.trainer_name || '', students, added_by: me.name, added_at: now });
  }
  // Class-units already given out stay on the list.
  const given = new Set((await all(env, 'SELECT v.class_code, v.unit_code FROM verifications v JOIN panels p ON p.id=v.panel_id WHERE p.term_id=?', term.id)).map((r) => r.class_code + '|' + r.unit_code));
  const out = drop.filter(([c, u]) => !given.has(c + '|' + u));
  await many(env, ...upsertStmts('verify_list', ['term_id', 'class_code', 'unit_code', 'unit_name', 'trainer_code', 'trainer_name', 'students', 'added_by', 'added_at'], rows, ['term_id', 'class_code', 'unit_code']),
    ...out.map(([c, u]) => ['DELETE FROM verify_list WHERE term_id=? AND class_code=? AND unit_code=?', term.id, c, u]));
  await audit(env, me, 'verification list', `${rows.length} added, ${out.length} removed`);
  return { ok: true, added: rows.length, removed: out.length };
}
async function allocateVerification(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail('Set up the term first');
  const [listRows, panelRows, given, loading] = await many(env, ['SELECT * FROM verify_list WHERE term_id=?', term.id],
    ["SELECT * FROM panels WHERE term_id=? AND status='approved' ORDER BY created_at", term.id],
    ['SELECT v.* FROM verifications v JOIN panels p ON p.id=v.panel_id WHERE p.term_id=?', term.id], [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`]);
  const only = new Set((b.panelIds || []).map(String));
  const panels = panelRows.filter((p) => !only.size || only.has(p.id)).map((p) => ({ ...p, people: JSON.parse(p.members || '[]') }));
  if (!panels.length) fail('Draft at least one panel first');
  const done = new Set(given.map((v) => v.class_code + '|' + v.unit_code));
  const todo = listRows.filter((r) => !done.has(r.class_code + '|' + r.unit_code)).slice(0, 120);
  if (!todo.length) fail(listRows.length ? 'Everything on the list has already been given out' : 'Add class-units to the list first');
  const teach = new Map();
  for (const l of loading) { if (!teach.has(l.unit_code)) teach.set(l.unit_code, new Set()); if (l.trainer_code) teach.get(l.unit_code).add(lower(l.trainer_code)); }
  const rnd = seeded(String(b.seed || crypto.randomUUID()));
  const weight = (r) => Math.max(1, Number(r.students) || 0);
  const panelLoad = new Map(panels.map((p) => [p.id, 0])), memberLoad = new Map();
  for (const v of given) {
    if (panelLoad.has(v.panel_id)) panelLoad.set(v.panel_id, panelLoad.get(v.panel_id) + Math.max(1, v.population || 0));
    for (const m of [v.verifier].filter(Boolean)) memberLoad.set(lower(m), (memberLoad.get(lower(m)) || 0) + Math.max(1, v.population || 0));
  }
  // Classes first: the biggest class (by students) goes to the panel with the fewest students so far, preferring a panel
  // that can staff all of its units. Then each of the class's units goes to two of that panel's members (the least loaded,
  // at random among equals) who do not teach the unit; a unit that panel cannot staff goes to another panel that can.
  const classes = new Map();
  for (const r of todo) { if (!classes.has(r.class_code)) classes.set(r.class_code, { code: r.class_code, students: weight(r), units: [], k: rnd() }); classes.get(r.class_code).units.push(r); }
  const can = (p, r) => p.people.filter((m) => !(teach.get(r.unit_code) || new Set()).has(lower(m)));
  const least = (people) => people.map((m) => ({ m, k: rnd() })).sort((a, c) => (memberLoad.get(lower(a.m)) || 0) - (memberLoad.get(lower(c.m)) || 0) || a.k - c.k)[0]?.m;
  const made = [], placed = [], relaxed = [];
  for (const c of [...classes.values()].sort((a, d) => d.students - a.students || a.k - d.k)) {
    // Every class gets a panel: the one that can cover most of its units, then the one with the fewest students so far.
    const home = panels.map((p) => ({ p, staffs: c.units.filter((r) => can(p, r).length).length, k: rnd() }))
      .sort((a, d) => d.staffs - a.staffs || panelLoad.get(a.p.id) - panelLoad.get(d.p.id) || a.k - d.k)[0];
    panelLoad.set(home.p.id, panelLoad.get(home.p.id) + c.students);
    placed.push({ classCode: c.code, panel: home.p.name, students: c.students });
    for (const r of c.units) {
      // One member per unit: someone on the class's panel who does not teach it; else someone on another panel who does
      // not; only then (the rules bent, and said so) a member who teaches the unit in another class, and last of all anyone.
      let p = home.p, who = least(can(home.p, r)), note = '';
      if (!who) {
        const other = panels.filter((q) => q.id !== home.p.id && can(q, r).length).sort((a, d) => panelLoad.get(a.id) - panelLoad.get(d.id))[0];
        if (other) { p = other; who = least(can(other, r)); note = `given to ${other.name}: nobody on ${home.p.name} is free of this unit`; }
      }
      if (!who) {
        who = least(home.p.people.filter((m) => lower(m) !== lower(r.trainer_code))) || least(home.p.people);
        note = lower(who) === lower(r.trainer_code) ? 'rule bent: the only member left is the unit\'s own trainer' : 'rule bent: every member teaches this unit in some class';
      }
      const load = loading.find((l) => l.class_code === r.class_code && l.unit_code === r.unit_code)
        || { class_code: r.class_code, unit_code: r.unit_code, unit_name: r.unit_name, trainer_code: r.trainer_code, trainer_name: r.trainer_name };
      const v = await createVerification(env, me, p, load, who, term, note);
      memberLoad.set(lower(who), (memberLoad.get(lower(who)) || 0) + weight(r));
      if (note.startsWith('rule bent')) relaxed.push({ classCode: r.class_code, unitCode: r.unit_code, why: note });
      made.push(verOut(v));
    }
  }
  const skipped = [];
  await audit(env, me, 'verification allocated', `${made.length} given out to ${panels.length} panel(s)${relaxed.length ? `, ${relaxed.length} with the rules bent` : ''}`);
  return { ok: true, allocated: made.length, classes: placed, skipped, relaxed, verifications: made };
}
async function getVer(env, id) { const v = await one(env, 'SELECT * FROM verifications WHERE id=?', String(id || '')); if (!v) fail('That verification no longer exists'); return v; }
async function saveVer(env, v, fields, line) {
  const log = JSON.parse(v.log || '[]'); if (line) log.push(line);
  const keys = Object.keys(fields);
  await run(env, `UPDATE verifications SET ${keys.map((k) => k + '=?').join(', ')}, log=?, updated_at=? WHERE id=?`, ...keys.map((k) => fields[k]), JSON.stringify(log), nowIso(), v.id);
  return verOut(await one(env, 'SELECT * FROM verifications WHERE id=?', v.id));
}
async function setExternal(env, b, me) {
  const v = await getVer(env, b.id), code = String(b.external || '').trim();
  if (code) { const s = await getStaff(env, code); if (!s || !hasRole(s.roles, 'EAO')) fail('Choose an External Assessment Officer'); }
  return { ok: true, verification: await saveVer(env, v, { external: code || null }, logLine(me, code ? `external officer ${code}` : 'external officer removed')) };
}
async function redrawSample(env, b, me) {
  const v = await getVer(env, b.id);
  if (v.status !== 'open') fail('Only a verification still in progress can be drawn again');
  if (!me.roles.includes('HOD') && JSON.parse(v.sample || '[]').length) fail('Only the HOD can draw a sample again');
  const term = await activeTerm(env), f = await samplingFacts(env, v.class_code, v.unit_code, v.trainer_code, term?.id);
  const size = sampleSize(f.pop.length, f.risk), seed = crypto.randomUUID().replace(/-/g, '').slice(0, 16), { sample, reasons } = drawSample(f, size, seed);
  if (!f.pop.length) fail('This class has no students on its list, so there is nothing to sample');
  await run(env, "DELETE FROM verify_checks WHERE verification_id=? AND who='internal'", v.id);
  return { ok: true, verification: await saveVer(env, v, { seed, sample: JSON.stringify(sample), reasons: JSON.stringify(reasons), size, population: f.pop.length, risk: f.risk, round: 1,
    v1_result: null, v1_actions: null, v1_at: null },
    logLine(me, `drawn again by the HOD: ${size} of ${f.pop.length}${b.reason ? ` (${String(b.reason).slice(0, 200)})` : ''}`)) };
}
async function moreSample(env, b, me) {
  const v = await getVer(env, b.id);
  if (me.roles.includes('EAO') && !me.roles.includes('IAO')) fail('Pick the students you want under Your own sample');
  const term = await activeTerm(env), f = await samplingFacts(env, v.class_code, v.unit_code, v.trainer_code, term?.id);
  const had = JSON.parse(v.sample || '[]').map(lower), add = Math.max(1, Math.min(10, Number(b.count) || 5));
  const { sample, reasons } = drawSample(f, Math.min(f.pop.length, had.length + add), v.seed + ':more' + had.length, had);
  const got = sample.length - had.length;
  if (!got) fail('Every student in the class is already in the sample');
  return { ok: true, verification: await saveVer(env, v, { sample: JSON.stringify(sample), reasons: JSON.stringify({ ...JSON.parse(v.reasons || '{}'), ...Object.fromEntries(Object.entries(reasons).map(([a]) => [a, 'asked for by ' + me.name])) }), size: sample.length },
    logLine(me, `${got} more students asked for`)) };
}
async function saveCheck(env, b, me) {
  const v = await getVer(env, b.id), adm = String(b.admNo || '');
  const slot = verifierSlot(v, me.code), who = slot || (me.roles.includes('EAO') ? 'external' : '');
  if (!who) fail('This verification is not given to you');
  if (slot && v.status !== 'open') fail('This verification has been submitted');
  const inS = (s) => JSON.parse(s || '[]').some((a) => lower(a) === lower(adm));
  if (who === 'external' ? !(inS(v.ext_sample) || (inS(v.sample) && ['submitted', 'signed'].includes(v.status))) : !inS(v.sample)) fail('That student is not in the sample');
  const t = (k) => (b[k] ? 1 : 0), agree = b.agree === true ? 1 : b.agree === false ? 0 : null;
  if (agree === 0 && !String(b.comment || '').trim()) fail('Say why you do not agree with the trainer');
  await run(env, `INSERT INTO verify_checks (verification_id,adm_no,who,valid,authentic,current,sufficient,agree,comment,by_code,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(verification_id,adm_no,who) DO UPDATE SET valid=excluded.valid, authentic=excluded.authentic, current=excluded.current, sufficient=excluded.sufficient, agree=excluded.agree, comment=excluded.comment, by_code=excluded.by_code, at=excluded.at`,
  v.id, adm, who, t('valid'), t('authentic'), t('current'), t('sufficient'), agree, String(b.comment || '').trim().slice(0, 1000), me.code, nowIso());
  return { ok: true, check: checkOut(await one(env, 'SELECT * FROM verify_checks WHERE verification_id=? AND adm_no=? AND who=?', v.id, adm, who)) };
}
/** The verifier marks several students at once: the same ticks and decision (and comment) for each. */
async function saveChecks(env, b, me) {
  const adms = [...new Set((b.admNos || []).map(String))].slice(0, 200);
  if (!adms.length) fail('Tick the students first');
  const out = [];
  for (const admNo of adms) out.push((await saveCheck(env, { ...b, admNo }, me)).check);
  return { ok: true, checks: out };
}
/** The verifier's result. Too many disagreements (2 or more, or over 20% of the sample) first doubles the sample, then takes in
 * every student, before a result can be given. */
async function submitVerification(env, b, me) {
  const v = await getVer(env, b.id), slot = verifierSlot(v, me.code);
  if (!slot) fail('Only the member given this class and unit can submit it');
  if (v.status !== 'open') fail('This verification has already been submitted');
  const sample = JSON.parse(v.sample || '[]');
  if (!sample.length) fail('The sample has not been drawn yet');
  const checks = await all(env, "SELECT * FROM verify_checks WHERE verification_id=? AND who='internal'", v.id);
  const done = new Set(checks.filter((c) => c.agree !== null).map((c) => lower(c.adm_no)));
  const left = sample.filter((a) => !done.has(lower(a)));
  if (left.length) fail(`Check every student in the sample first (${left.length} left)`);
  const against = checks.filter((c) => c.agree === 0).length;
  const round = Number(v.round) || 1;
  if ((against >= 2 || against > sample.length * 0.2) && round < 3) {
    const term = await activeTerm(env), f = await samplingFacts(env, v.class_code, v.unit_code, v.trainer_code, term?.id);
    const size = round === 1 ? Math.min(f.pop.length, sample.length * 2) : f.pop.length;
    if (size > sample.length) {
      const { sample: next, reasons } = drawSample(f, size, v.seed + ':r' + (round + 1), sample.map(lower));
      const why = Object.fromEntries(Object.keys(reasons).map((a) => [a, round === 1 ? 'sample doubled' : 'every student']));
      const ver = await saveVer(env, v, { sample: JSON.stringify(next), reasons: JSON.stringify({ ...JSON.parse(v.reasons || '{}'), ...why }), size: next.length, round: round + 1,
        v1_result: null, v1_actions: null, v1_at: null },
        logLine(me, `${against} disagreement(s): ${round === 1 ? 'sample doubled' : 'every student taken in'} (${next.length})`));
      return { ok: true, extended: round === 1 ? 'doubled' : 'everyone', verification: ver };
    }
  }
  const result = String(b.result || '');
  if (!VERDICTS.includes(result)) fail('Choose the result');
  const actions = String(b.actions || '').trim().slice(0, 2000);
  if (result !== 'verified' && !actions) fail('Write the actions the trainer should take');
  const now = nowIso();
  return { ok: true, verification: await saveVer(env, v, { v1_result: result, v1_actions: actions, v1_at: now, status: 'submitted', result, actions, submitted_at: now }, logLine(me, `submitted: ${result.replace('_', ' ')}`)) };
}
async function respondVerification(env, b, me) {
  const v = await getVer(env, b.id);
  if (lower(v.trainer_code) !== lower(me.code)) fail('Only the trainer of this unit can respond');
  if (!['submitted', 'signed'].includes(v.status)) fail('There is nothing to respond to yet');
  const text = String(b.response || '').trim().slice(0, 2000);
  if (!text) fail('Write your response');
  return { ok: true, verification: await saveVer(env, v, { response: text, responded_at: nowIso() }, logLine(me, 'trainer responded')) };
}
async function signVerification(env, b, me) {
  const v = await getVer(env, b.id), p = await one(env, 'SELECT * FROM panels WHERE id=?', v.panel_id);
  if (!(me.roles.includes('HOD') || (p && lower(p.chair) === lower(me.code)))) fail('Only the panel chair or the HOD can sign the report');
  if (v.status !== 'submitted') fail(v.status === 'signed' ? 'This report is already signed' : 'The verifier has not submitted it yet');
  return { ok: true, verification: await saveVer(env, v, { status: 'signed', signed_by: me.name, signed_at: nowIso() }, logLine(me, 'report signed')) };
}
async function externalVerdict(env, b, me) {
  const v = await getVer(env, b.id);
  if (v.external && lower(v.external) !== lower(me.code)) fail('Another External Assessment Officer has this one');
  const result = String(b.result || '');
  if (!VERDICTS.includes(result)) fail('Choose the result');
  return { ok: true, verification: await saveVer(env, v, { external: me.code, ext_result: result, ext_note: String(b.note || '').trim().slice(0, 2000), ext_at: nowIso() }, logLine(me, `external result: ${result.replace('_', ' ')}`)) };
}
/** The students of a class-unit with approved evidence (the external officer picks their own sample from them). */
async function verifyPool(env, b, me) {
  const v = await getVer(env, b.id);
  const parts = classParts(v.class_code).length ? classParts(v.class_code) : [v.class_code];
  const [rows, ev] = await many(env, [`SELECT adm_no, name FROM trainees WHERE class_code IN ${IN} AND COALESCE(status,'') NOT IN ${GONE} ORDER BY adm_no`, JSON.stringify(parts)],
    ["SELECT DISTINCT adm_no FROM evidence WHERE class_code=? AND unit_code=? AND status='approved'", v.class_code, v.unit_code]);
  const s = new Set(JSON.parse(v.sample || '[]').map(lower)), mine = new Set(JSON.parse(v.ext_sample || '[]').map(lower)), has = new Set(ev.map((r) => lower(r.adm_no)));
  return { ok: true, students: rows.map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no, inSample: s.has(lower(r.adm_no)), mine: mine.has(lower(r.adm_no)), evidence: has.has(lower(r.adm_no)) })) };
}
async function externalSample(env, b, me) {
  const v = await getVer(env, b.id);
  if (v.external && lower(v.external) !== lower(me.code)) fail('Another External Assessment Officer has this one');
  const parts = classParts(v.class_code).length ? classParts(v.class_code) : [v.class_code];
  const pool = new Set((await all(env, `SELECT adm_no FROM trainees WHERE class_code IN ${IN} AND COALESCE(status,'') NOT IN ${GONE}`, JSON.stringify(parts))).map((r) => lower(r.adm_no)));
  const pick = [...new Set((b.admNos || []).map((a) => String(a).trim()).filter((a) => pool.has(lower(a))))].slice(0, 200);
  if (!pick.length && (b.admNos || []).length) fail('Choose students on this class list');
  return { ok: true, verification: await saveVer(env, v, { external: me.code, ext_sample: JSON.stringify(pick) }, logLine(me, `external sample: ${pick.length} student(s)`)) };
}
/* ---------- messages: in the app, on the phone, and by email to Google Groups ----------
 * Anyone with a staff role but the External Assessment Officer can send a message. Who it can reach follows their access:
 * a trainer their own classes, their class reps and their panels; the HOD, MIS Officer and Internal Assessment Officer
 * anyone. Each message shows in the bell of everyone it is for, wakes students' phones (when notifications are set up),
 * and goes by email to the groups the bridge keeps (one email per group, sent as a hidden copy) and to anyone named. */
const NOTICE_TARGETS = ['class', 'trainers', 'reps', 'coordinators', 'panel', 'student'];
const slugOf = (s) => lower(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
/** A group's address: a class by its code (ict-l6cs-25sa@…); the others start with "ark-" so they cannot clash with a person. */
function groupEmail(env, key, panels = []) {
  if (!env.GOOGLE_DOMAIN) return '';
  const local = key.startsWith('class:') ? slugOf(key.slice(6))
    : key.startsWith('panel:') ? 'ark-panel-' + slugOf(panels.find((p) => p.id === key.slice(6))?.name || key.slice(6, 14))
      : { trainers: 'ark-trainers', reps: 'ark-class-reps', coordinators: 'ark-coordinators' }[key] || 'ark-' + slugOf(key);
  return `${local}@${env.GOOGLE_DOMAIN}`;
}
/** Everything the groups and audiences are made from. */
async function audienceFacts(env) {
  const [loading, trainees, staff, panels, classRows] = await many(env, [`SELECT class_code, unit_code, trainer_code FROM loading WHERE term_id=${ACTIVE_TERM}`],
    [`SELECT adm_no, name, class_code, email, rep, status FROM trainees WHERE COALESCE(status,'') NOT IN ${GONE}`],
    ['SELECT code, name, roles, responsibility, email, active FROM staff WHERE active=1'], ["SELECT * FROM panels WHERE status='approved'"], ["SELECT code FROM classes WHERE status='archived'"]);
  const gone = new Set(classRows.map((r) => r.code));
  const classes = [...new Set(loading.flatMap((u) => classParts(u.class_code)))].filter((c) => !gone.has(c)).sort();
  const trainers = new Set(loading.map((u) => lower(u.trainer_code)).filter(Boolean));
  return { loading, trainees: trainees.filter((t) => !gone.has(t.class_code)), staff, panels, classes, trainers };
}
/** The audiences one person may send to. */
function allowedTargets(me, f) {
  const all = seesAll(me);
  const myClasses = new Set(f.loading.filter((u) => lower(u.trainer_code) === lower(me.code)).flatMap((u) => classParts(u.class_code)));
  const classes = all ? f.classes : f.classes.filter((c) => myClasses.has(c));
  const panels = f.panels.filter((p) => all || inPanel(p, me.code));
  return { classes, panels, trainers: all, reps: all || classes.length > 0, coordinators: all, students: all ? null : new Set(f.trainees.filter((t) => myClasses.has(t.class_code)).map((t) => lower(t.adm_no))) };
}
async function noticeOptions(env, me) {
  const f = await audienceFacts(env), a = allowedTargets(me, f);
  const count = (c) => f.trainees.filter((t) => t.class_code === c).length;
  return { ok: true, classes: a.classes.map((c) => ({ code: c, students: count(c), emails: f.trainees.filter((t) => t.class_code === c && t.email).length })),
    panels: a.panels.map((p) => ({ id: p.id, name: p.name })), trainers: a.trainers, reps: a.reps, coordinators: a.coordinators,
    email: !!env.GOOGLE_DOMAIN, push: !!env.VAPID_PRIVATE_KEY };
}
/** Who one message reaches: staff codes and students for the bell and phones, group addresses and named people for email. */
function resolveAudience(env, targets, me, f) {
  const a = allowedTargets(me, f), staff = new Set(), students = new Set(), groups = new Set(), people = new Set(), label = [];
  const staffBy = new Map(f.staff.map((s) => [lower(s.code), s]));
  for (const t of targets) {
    if (!NOTICE_TARGETS.includes(t.t)) continue;
    if (t.t === 'class') {
      if (!a.classes.includes(t.code)) fail(`You cannot send to ${t.code}`);
      for (const s of f.trainees.filter((x) => x.class_code === t.code)) students.add(lower(s.adm_no));
      groups.add('class:' + t.code); label.push(t.code);
    } else if (t.t === 'trainers') {
      if (!a.trainers) fail('Only the HOD, the MIS Officer or the Internal Assessment Officer can send to all trainers');
      f.trainers.forEach((c) => staff.add(c)); groups.add('trainers'); label.push('All trainers');
    } else if (t.t === 'reps') {
      if (!a.reps) fail('You cannot send to the class reps');
      const mine = new Set(a.classes);
      for (const s of f.trainees.filter((x) => x.rep && mine.has(x.class_code))) { students.add(lower(s.adm_no)); if (seesAll(me)) continue; if (s.email) people.add(lower(s.email)); }
      if (seesAll(me)) groups.add('reps'); label.push('Class reps');
    } else if (t.t === 'coordinators') {
      if (!a.coordinators) fail('You cannot send to the class coordinators');
      for (const s of f.staff.filter((x) => /coordinat/i.test(x.responsibility || ''))) staff.add(lower(s.code));
      groups.add('coordinators'); label.push('Class coordinators');
    } else if (t.t === 'panel') {
      const p = a.panels.find((x) => x.id === t.id);
      if (!p) fail('You cannot send to that panel');
      [p.chair, ...JSON.parse(p.members || '[]')].forEach((c) => staff.add(lower(c))); groups.add('panel:' + p.id); label.push(p.name);
    } else if (t.t === 'student') {
      const s = f.trainees.find((x) => lower(x.adm_no) === lower(t.adm));
      if (!s || (a.students && !a.students.has(lower(s.adm_no)))) fail('You can only write to students in your classes');
      students.add(lower(s.adm_no)); if (s.email) people.add(lower(s.email)); label.push(s.name);
    }
  }
  staff.delete(lower(me.code));
  return { staff: [...staff], students: [...students], groups: [...groups].filter((g) => groupEmail(env, g, f.panels)), people: [...people], label: label.join(', ') };
}
async function sendNotice(env, b, me, ctx) {
  const title = String(b.title || '').trim().slice(0, 120), body = String(b.body || '').trim().slice(0, 4000);
  if (!title) fail('Give the message a title');
  if (!body) fail('Write the message');
  const targets = Array.isArray(b.to) ? b.to.slice(0, 50) : [];
  if (!targets.length) fail('Choose who the message is for');
  const ch = { app: true, push: b.push !== false, email: b.email !== false };
  const f = await audienceFacts(env), aud = resolveAudience(env, targets, me, f);
  if (!aud.staff.length && !aud.students.length && !aud.groups.length && !aud.people.length) fail('Nobody is in that audience yet');
  const id = crypto.randomUUID(), now = nowIso();
  const sender = f.staff.find((s) => lower(s.code) === lower(me.code));
  const groupMails = ch.email ? aud.groups.map((g) => groupEmail(env, g, f.panels)) : [];
  const bcc = ch.email ? [...new Set([...groupMails, ...aud.people])] : [];
  const stmts = [[`INSERT INTO notices (id,at,by_code,by_name,title,body,audience,channels,staff,students,groups,counts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, now, me.code, me.name, title, body, aud.label, JSON.stringify(ch), JSON.stringify(aud.staff), JSON.stringify(aud.students), JSON.stringify(aud.groups),
    JSON.stringify({ staff: aud.staff.length, students: aud.students.length, emails: bcc.length })]];
  if (bcc.length) {
    const text = `${body}\n\n— ${me.name}, through The ARK (${aud.label}). Reply to this email to answer ${me.name}.`;
    stmts.push(['INSERT INTO mail_out (id,notice_id,bcc,reply_to,subject,body,status,at) VALUES (?,?,?,?,?,?,?,?)', crypto.randomUUID(), id, JSON.stringify(bcc), sender?.email || '', title, text, 'queued', now]);
  }
  await many(env, ...stmts);
  await audit(env, me, 'message', `${title} → ${aud.label}`);
  // Students' phones (only when notifications are set up), after the reply has gone out.
  if (ch.push && env.VAPID_PRIVATE_KEY && aud.students.length) ctx?.waitUntil?.((async () => { for (const a of aud.students.slice(0, 300)) { try { await pushToStudent(env, a); } catch { /* next */ } } })());
  if (bcc.length) ctx?.waitUntil?.(nudgeDrive(env).catch(() => {}));
  return { ok: true, id, reached: { staff: aud.staff.length, students: aud.students.length, groups: groupMails.length, people: ch.email ? aud.people.length : 0 } };
}
const noticeView = (r, read) => ({ id: r.id, at: r.at, title: r.title, body: r.body, from: r.by_name, fromCode: r.by_code, to: r.audience, read: !!read });
/** Messages for one person (`staff` code or `students` admission number), newest first, the last 60 days. */
async function noticesFor(env, who, col, markRead) {
  const ids = (Array.isArray(markRead) ? markRead : []).map(String).filter(Boolean).slice(0, 100);
  if (ids.length) await run(env, `INSERT OR IGNORE INTO notice_reads (notice_id, who, at) SELECT value, ?, ? FROM json_each(?)`, who, nowIso(), JSON.stringify(ids));
  const since = new Date(Date.now() - 60 * 864e5).toISOString();
  const rows = await all(env, `SELECT n.*, r.at AS read_at FROM notices n LEFT JOIN notice_reads r ON r.notice_id=n.id AND r.who=?1
    WHERE n.at > ?2 AND EXISTS (SELECT 1 FROM json_each(n.${col}) WHERE lower(value)=lower(?1)) ORDER BY n.at DESC LIMIT 80`, who, since);
  return rows.map((r) => noticeView(r, r.read_at));
}
async function myNotices(env, b, me) {
  const inbox = await noticesFor(env, me.code, 'staff', b.read);
  const sent = (await all(env, 'SELECT * FROM notices WHERE lower(by_code)=lower(?) ORDER BY at DESC LIMIT 30', me.code))
    .map((r) => ({ ...noticeView(r, true), counts: JSON.parse(r.counts || '{}'), channels: JSON.parse(r.channels || '{}') }));
  const mail = sent.length ? await all(env, `SELECT notice_id, status, error FROM mail_out WHERE notice_id IN (SELECT value FROM json_each(?))`, JSON.stringify(sent.map((s) => s.id))) : [];
  for (const s of sent) { const m = mail.find((x) => x.notice_id === s.id); if (m) s.email = { status: m.status, error: m.error || '' }; }
  return { ok: true, inbox, sent, unread: inbox.filter((n) => !n.read).length };
}
async function setRep(env, b, me) {
  const t = await one(env, 'SELECT * FROM trainees WHERE adm_no=?', String(b.admNo || ''));
  if (!t) fail('That student is not on a class list');
  if (!seesAll(me) && !(await myUnitPairs(env, me)).loading.some((u) => lower(u.trainer_code) === lower(me.code) && classParts(u.class_code).includes(t.class_code))) fail('You can only choose class reps for your classes');
  await many(env, ['UPDATE trainees SET rep=?, updated_at=? WHERE adm_no=?', b.rep ? 1 : null, nowIso(), t.adm_no], changedStmt());
  await audit(env, me, 'class rep', `${t.adm_no} ${b.rep ? 'is' : 'is no longer'} a class rep of ${t.class_code}`);
  return { ok: true };
}
/* The groups the bridge keeps: one per class, all trainers, class reps, class coordinators, one per approved panel. */
async function wantedGroups(env) {
  if (!env.GOOGLE_DOMAIN) return [];
  const f = await audienceFacts(env), em = (list) => [...new Set(list.map((x) => lower(x.email || '')).filter(Boolean))].sort();
  const staffBy = new Map(f.staff.map((s) => [lower(s.code), s]));
  const out = f.classes.map((c) => ({ key: 'class:' + c, name: `${c} - students`, want: em(f.trainees.filter((t) => t.class_code === c)) }));
  out.push({ key: 'trainers', name: 'All trainers', want: em([...f.trainers].map((c) => staffBy.get(c)).filter(Boolean)) });
  out.push({ key: 'reps', name: 'Class reps', want: em(f.trainees.filter((t) => t.rep)) });
  out.push({ key: 'coordinators', name: 'Class coordinators', want: em(f.staff.filter((s) => /coordinat/i.test(s.responsibility || ''))) });
  for (const p of f.panels) out.push({ key: 'panel:' + p.id, name: `Panel - ${p.name}`, want: em([p.chair, ...JSON.parse(p.members || '[]')].map((c) => staffBy.get(lower(c))).filter(Boolean)) });
  return out.map((g) => ({ ...g, email: groupEmail(env, g.key, f.panels) }));
}
const hashOf = async (s) => (await sha256Hex(s)).slice(0, 16);
/** For the bridge: messages waiting to be emailed, and the groups whose members changed (a few at a time). */
async function groupsJob(env) {
  const [mail, known] = await many(env, ["SELECT * FROM mail_out WHERE status='queued' ORDER BY at LIMIT 25"], ['SELECT * FROM mail_groups']);
  const byKey = new Map(known.map((g) => [g.key, g])), groups = [], wantedList = await wantedGroups(env);
  for (const g of wantedList) {
    const k = byKey.get(g.key), h = await hashOf(g.email + '|' + g.want.join(','));
    if (k && k.group_name && k.want_hash === h && !k.error) continue;
    groups.push({ key: g.key, email: g.email, name: g.name, description: `${g.name}. Kept by The ARK: members are added and removed automatically.`,
      groupName: k?.email === g.email ? k?.group_name || '' : '', want: g.want, added: JSON.parse(k?.added || '[]'), hash: h });
  }
  // Group email is sent to the group's address, so a message waits until every group it is for exists.
  const ready = new Set(known.filter((g) => g.group_name).map((g) => lower(g.email)));
  const wanted = new Set(wantedList.map((g) => lower(g.email)));
  const sendable = mail.filter((m) => JSON.parse(m.bcc || '[]').every((e) => !wanted.has(lower(e)) || ready.has(lower(e))))
    .map((m) => ({ id: m.id, bcc: JSON.parse(m.bcc || '[]'), replyTo: m.reply_to || '', subject: m.subject, text: m.body,
    html: `<div style="font:15px/1.5 Arial,sans-serif;white-space:pre-wrap">${String(m.body).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>` }))
    .filter((m) => m.bcc.length);
  return { ok: true, mail: sendable, groups: groups.slice(0, 8), more: groups.length > 8 };
}
async function groupsDone(env, b) {
  const now = nowIso(), stmts = [];
  const wanted = new Map((await wantedGroups(env)).map((g) => [g.key, g]));
  for (const r of b.groups || []) {
    const g = wanted.get(r.key); if (!g) continue;
    const k = await one(env, 'SELECT * FROM mail_groups WHERE key=?', r.key);
    const added = new Set(JSON.parse(k?.added || '[]').map(lower));
    (r.added || []).forEach((e) => added.add(lower(e))); (r.removed || []).forEach((e) => added.delete(lower(e)));
    const h = r.error ? null : await hashOf(g.email + '|' + g.want.join(','));
    stmts.push([`INSERT INTO mail_groups (key,email,name,group_name,added,want_hash,synced_at,error,failed) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET email=excluded.email, name=excluded.name, group_name=COALESCE(excluded.group_name, mail_groups.group_name), added=excluded.added, want_hash=excluded.want_hash, synced_at=excluded.synced_at, error=excluded.error, failed=excluded.failed`,
    r.key, g.email, g.name, r.groupName || k?.group_name || null, JSON.stringify([...added]), (r.failed || []).length ? null : h, now, r.error || null, JSON.stringify((r.failed || []).slice(0, 20))]);
  }
  for (const m of b.mail || []) {
    if (m.ok) stmts.push(["UPDATE mail_out SET status='sent', sent_at=?, error=NULL WHERE id=?", now, m.id]);
    else stmts.push([`UPDATE mail_out SET tries=COALESCE(tries,0)+?, error=?, status=CASE WHEN COALESCE(tries,0)+? >= 5 THEN 'failed' ELSE 'queued' END WHERE id=?`, m.later ? 0 : 1, String(m.error || '').slice(0, 300), m.later ? 0 : 1, m.id]);
  }
  if (stmts.length) await many(env, ...stmts);
  return { ok: true };
}
/* ---------- approvals: the stamp, name and QR code on approved documents ----------
 * Approving a term register (the HOD) or a piece of evidence (its trainer or the HOD) makes an approval: a reference, who
 * approved and when, and a fingerprint of what was approved, signed by the server. The printed copy carries a QR code to
 * the public check page, which says whether the document is genuine, has changed since, or was replaced or withdrawn. The
 * check shows no student details. */
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newRef = () => { const b = crypto.getRandomValues(new Uint8Array(6)); return `ARK-${todayIso().slice(2, 4)}-${[...b].map((n) => REF_CHARS[n % REF_CHARS.length]).join('')}`; };
/** What a register's approval covers: every register of that class and unit in that term, as last saved. */
async function registerPrint(env, so) {
  const rows = await all(env, 'SELECT id, updated_at FROM sessions WHERE class_code=? AND unit_code=? AND term_id=? ORDER BY id', so.class_code, so.unit_code, so.term_id);
  return sha256Hex(rows.map((r) => `${r.id}:${r.updated_at}`).join('|'));
}
const evidencePrint = (r) => `${r.md5 || r.file_id || ''}|v${r.version}${r.changed_at ? '|changed' : ''}`;
const approvalSig = async (env, a) => (await hmacHex(`${a.ref}|${a.kind}|${a.subject}|${a.fingerprint}|${a.at}|${a.by_code}`, await authSecret(env))).slice(0, 32);
async function makeApproval(env, me, role, kind, subject, title, info, fingerprint) {
  const a = { ref: newRef(), kind, subject, fingerprint, at: nowIso(), by_code: me.code };
  const sig = await approvalSig(env, a);
  await many(env, ["UPDATE approvals SET status='replaced', replaced_by=? WHERE kind=? AND subject=? AND status='valid'", a.ref, kind, subject],
    ["INSERT INTO approvals (ref,kind,subject,title,info,fingerprint,by_code,by_name,by_role,at,sig,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,'valid')",
      a.ref, kind, subject, title, JSON.stringify(info), fingerprint, me.code, me.name, role, a.at, sig]);
  return a.ref;
}
const withdrawApprovals = (env, kind, subject) => run(env, "UPDATE approvals SET status='withdrawn' WHERE kind=? AND subject=? AND status='valid'", kind, subject);
/** The public check: genuine, changed since, replaced, withdrawn, or not recognised. */
async function checkApproval(env, ref) {
  const r = await one(env, 'SELECT * FROM approvals WHERE ref=?', String(ref || '').trim().toUpperCase());
  if (!r) return { ok: true, found: false };
  const info = JSON.parse(r.info || '{}');
  let status = r.status;
  if ((await approvalSig(env, r)) !== r.sig) status = 'tampered';
  else if (status === 'valid') {
    let now = r.fingerprint;
    if (r.kind === 'register') { const so = await one(env, 'SELECT * FROM signoffs WHERE id=?', r.subject); now = so ? await registerPrint(env, so) : ''; }
    if (r.kind === 'poe') { const e = await one(env, 'SELECT * FROM evidence WHERE id=?', r.subject); now = e ? evidencePrint(e) : ''; }
    if (r.kind === 'marksheet') { const m = await one(env, 'SELECT * FROM marksheets WHERE id=?', r.subject); now = m ? await marksheetPrint(env, m.class_code, m.unit_code) : ''; }
    if (now !== r.fingerprint) status = 'changed';
  }
  const term = info.termId ? await one(env, 'SELECT name, duration FROM terms WHERE id=?', info.termId) : null;
  return { ok: true, found: true, ref: r.ref, kind: r.kind, title: r.title, status, by: r.by_name, role: r.by_role, at: r.at, replacedBy: r.replaced_by || '',
    details: { classCode: info.classCode || '', unit: [info.unitCode, info.unitName].filter(Boolean).join(' - '), item: info.item || '', version: info.version || '', term: term ? term.duration || term.name : '' } };
}
/* ---------- marksheets: prepared by the trainer, received by the Assessment Officer, approved by the HOD ----------
 * The Excel marksheet's footer is filled from this: names, initials for the signatures, and dates. Approving makes an
 * approval (reference and QR check) over the marks as they stood; a change afterwards shows as "changed since approval". */
const msId = (cls, unit) => `${cls}|${unit}`;
const msOut = (r) => (r ? { id: r.id, classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name || '', status: r.status,
  preparedName: r.prepared_name || '', preparedAt: r.prepared_at || '', receivedName: r.received_name || '', receivedAt: r.received_at || '',
  approvedName: r.approved_name || '', approvedAt: r.approved_at || '', comment: r.comment || '', approvalRef: r.status === 'approved' ? r.approval_ref || '' : '' } : null);
async function marksheetPrint(env, cls, unit) {
  const rows = await all(env, `SELECT adm_no, ${MARK_COLS.join(', ')} FROM unit_marks WHERE class_code=? AND unit_code=? ORDER BY adm_no`, cls, unit);
  return sha256Hex(rows.map((r) => [lower(r.adm_no), ...MARK_COLS.map((c) => r[c] ?? '')].join(',')).join('|'));
}
async function msList(env, b, me) {
  const all_ = seesAll(me) ? await all(env, 'SELECT * FROM marksheets ORDER BY updated_at DESC')
    : await all(env, 'SELECT * FROM marksheets WHERE prepared_code=? ORDER BY updated_at DESC', me.code);
  return { ok: true, marksheets: all_.map(msOut) };
}
async function msSubmit(env, b, me) {
  const cls = String(b.classCode || ''), unit = String(b.unitCode || '');
  await marksAccess(env, me, cls, unit, true);
  const id = msId(cls, unit), old = await one(env, 'SELECT * FROM marksheets WHERE id=?', id), now = nowIso();
  if (old?.status === 'approved' && !b.again) fail('This marksheet is already approved');
  const u = await one(env, 'SELECT unit_name FROM loading WHERE class_code=? AND unit_code=? ORDER BY updated_at DESC LIMIT 1', cls, unit);
  await run(env, `INSERT INTO marksheets (id,class_code,unit_code,unit_name,status,prepared_code,prepared_name,prepared_at,received_code,received_name,received_at,approved_code,approved_name,approved_at,comment,approval_ref,updated_at)
    VALUES (?,?,?,?,'submitted',?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,?,NULL,?) ON CONFLICT(id) DO UPDATE SET status='submitted', prepared_code=excluded.prepared_code, prepared_name=excluded.prepared_name,
    prepared_at=excluded.prepared_at, received_code=NULL, received_name=NULL, received_at=NULL, approved_code=NULL, approved_name=NULL, approved_at=NULL, comment=excluded.comment, approval_ref=NULL, updated_at=excluded.updated_at`,
  id, cls, unit, u?.unit_name || b.unitName || unit, me.code, me.name, now, String(b.comment || '').slice(0, 500), now);
  await withdrawApprovals(env, 'marksheet', id);
  await audit(env, me, 'marksheet', `${id} submitted`);
  return { ok: true, marksheet: msOut(await one(env, 'SELECT * FROM marksheets WHERE id=?', id)) };
}
async function msReceive(env, b, me) {
  const ids = [...new Set((b.ids || [b.id]).filter(Boolean).map(String))].slice(0, BATCH_MAX), now = nowIso();
  if (!ids.length) fail('Choose the marksheets');
  const rows = await all(env, `SELECT * FROM marksheets WHERE id IN ${IN}`, JSON.stringify(ids));
  const ok = rows.filter((r) => r.status === 'submitted');
  if (!ok.length) fail('Only marksheets sent by their trainers can be received');
  await run(env, `UPDATE marksheets SET status='received', received_code=?, received_name=?, received_at=?, updated_at=? WHERE status='submitted' AND id IN ${IN}`, me.code, me.name, now, now, JSON.stringify(ok.map((r) => r.id)));
  await audit(env, me, 'marksheet received', ok.map((r) => r.id).join(', '));
  return { ok: true, marksheets: (await all(env, `SELECT * FROM marksheets WHERE id IN ${IN}`, JSON.stringify(ids))).map(msOut), skipped: ids.length - ok.length };
}
async function msDecideOne(env, id, decision, comment, me) {
  const r = await one(env, 'SELECT * FROM marksheets WHERE id=?', id);
  if (!r) fail('That marksheet has not been sent');
  if (decision === 'approved' && r.status !== 'received') fail('The Assessment Officer receives a marksheet before it is approved');
  if (decision === 'returned' && !comment) fail('Say what needs fixing when returning a marksheet');
  const now = nowIso(), said = comment || (decision === 'approved' ? OK_SAID.marksheet : '');
  let ref = null;
  if (decision === 'approved') {
    ref = await makeApproval(env, me, 'HOD', 'marksheet', id, `Marksheet - ${r.unit_code} ${r.unit_name || ''}`.trim(),
      { classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name, trainer: r.prepared_name }, await marksheetPrint(env, r.class_code, r.unit_code));
  } else await withdrawApprovals(env, 'marksheet', id);
  await run(env, 'UPDATE marksheets SET status=?, approved_code=?, approved_name=?, approved_at=?, comment=?, approval_ref=?, updated_at=? WHERE id=?',
    decision, decision === 'approved' ? me.code : null, decision === 'approved' ? me.name : null, decision === 'approved' ? now : null, said.slice(0, 500), ref, now, id);
  await audit(env, me, 'marksheet', `${id} ${decision}`);
  return msOut(await one(env, 'SELECT * FROM marksheets WHERE id=?', id));
}
async function msDecide(env, b, me) {
  if (!['approved', 'returned'].includes(b.decision)) fail('Choose approve or return');
  const comment = String(b.comment || '').trim();
  const ids = [...new Set((b.ids || [b.id]).filter(Boolean).map(String))].slice(0, BATCH_MAX);
  if (!ids.length) fail('Choose the marksheets');
  if (b.decision === 'approved') await confirmPin(env, me, b.pin);
  const out = [], failed = [];
  for (const id of ids) { try { out.push(await msDecideOne(env, id, b.decision, comment, me)); } catch (e) { if (ids.length === 1) throw e; failed.push({ id, error: e.message }); } }
  return { ok: true, marksheets: out, marksheet: out[0], failed };
}

/* ---------- candidates for the summative assessment ----------
 * The Assessment Officers (and the HOD and MIS Officer) list who may sit a unit's summative assessment, by rules they set:
 * the least attendance this term, which POE items must be in (all of them or at least one), and which marks must be in. */
const POE_ITEMS = ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'PRAC1', 'PRAC2', 'PRAC3'];
async function candidates(env, b, me) {
  const cls = String(b.classCode || ''), unit = String(b.unitCode || '');
  if (!cls || !unit) fail('Choose the class and unit');
  const term = await activeTerm(env);
  if (!term) fail('Set up the term first');
  const parts = classParts(cls).length ? classParts(cls) : [cls], P = JSON.stringify(parts);
  const [lo, sess, cks, trs, reqs, ev, mk, staffPct] = await many(env,
    ['SELECT * FROM loading WHERE term_id=? AND class_code=? AND unit_code=?', term.id, cls, unit],
    ['SELECT id, data FROM sessions WHERE class_code=? AND unit_code=?', cls, unit],
    ["SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN (SELECT id FROM sessions WHERE class_code=? AND unit_code=?)", cls, unit],
    [`SELECT adm_no, name, class_code, status, reg_code FROM trainees WHERE class_code IN ${IN}`, P],
    ["SELECT adm_no, name, status, merged_into FROM requests WHERE class_code=? AND status IN ('pending','rejected','merged')", cls],
    [`SELECT adm_no, item, status, version FROM evidence WHERE unit_code=? AND class_code IN ${IN}`, unit, P],
    [`SELECT * FROM unit_marks WHERE unit_code=? AND class_code IN ${IN}`, unit, P],
    ['SELECT code, late_pct, excused_pct FROM staff']);
  const u = lo[0] || { class_code: cls, unit_code: unit, unit_name: unit, trainer_code: '', trainer_name: '', hours_per_week: 3, lessons_per_week: 2 };
  // Attendance as the term register works it out.
  const weeks = teachingWeeks(term), accepted = acceptedOf(cks);
  const from = weeks[0], to = (() => { const e = new Date(weeks[weeks.length - 1] + 'T00:00:00Z'); e.setUTCDate(e.getUTCDate() + 6); return e.toISOString().slice(0, 10); })();
  const lessons = sess.map((r) => {
    const s = JSON.parse(r.data), marks = {}, names = {};
    for (const m of finalMarks(s, accepted[r.id])) { const k = STATUS_CODE[m.status]; if (k) { marks[m.admNo] = k; names[m.admNo] = m.name; } }
    return { id: r.id, date: s.date, period: s.period, slots: s.slots, kind: s.kind || 'lesson', marks, names };
  }).filter((l) => l.kind === 'lesson' && l.date >= from && l.date <= to);
  const roster = trs.filter(active).map((t) => ({ admNo: t.adm_no, name: t.name }));
  const rejected = new Set(reqs.filter((r) => r.status === 'rejected').map((r) => r.adm_no));
  const alias = Object.fromEntries(reqs.filter((r) => r.status === 'merged' && r.merged_into).map((r) => [r.adm_no, r.merged_into]));
  const pct = staffPct.find((s) => lower(s.code) === lower(u.trainer_code)) || {};
  const h = term.lessonHours || (Number(u.hours_per_week) || 3) / (Number(u.lessons_per_week) || 2);
  const reg = new Map(buildRegister({ weeks, lessons, roster, alias, rejected, h, latePct: pct.late_pct ?? 50, excPct: pct.excused_pct ?? 100 }).map((r) => [lower(r.admNo), r]));
  // The rules.
  const rules = b.rules || {}, minAtt = Math.max(0, Math.min(100, Number(rules.minAtt) || 0));
  const poeItems = (rules.poe?.items || []).map((i) => String(i).toUpperCase()).filter((i) => POE_ITEMS.includes(i));
  const markItems = (rules.marks?.items || []).map((i) => lower(i)).filter((i) => MARK_COLS.includes(i));
  const poeAll = rules.poe?.need !== 'any', marksAll = rules.marks?.need !== 'any', approvedOnly = !!rules.poe?.approvedOnly;
  const latest = new Map();
  for (const e of ev) { const k = lower(e.adm_no) + '|' + e.item, had = latest.get(k); if (!had || e.version > had.version) latest.set(k, e); }
  const marks = new Map(mk.map((m) => [lower(m.adm_no), m]));
  const label = (i) => i.replace(/^(CAT|PRAC)(\d)$/i, (m, a, n) => `${a.toUpperCase()} ${n}`);
  const students = [...roster].sort((a, c) => String(a.admNo).localeCompare(String(c.admNo), undefined, { numeric: true })).map((t) => {
    const r = reg.get(lower(t.admNo)), att = r && r.pct !== null ? Math.round(r.pct * 1000) / 10 : null;
    const poe = Object.fromEntries(POE_ITEMS.map((i) => [i, latest.get(lower(t.admNo) + '|' + i)?.status || '']));
    const m = marks.get(lower(t.admNo)) || {};
    const got = Object.fromEntries(MARK_COLS.map((c) => [c, m[c] ?? null]));
    const poeIn = (i) => (approvedOnly ? poe[i] === 'approved' : ['approved', 'submitted'].includes(poe[i]));
    const reasons = [];
    if (minAtt && (att === null || att < minAtt)) reasons.push(`Attendance ${att === null ? 'none recorded' : att + '%'} (needs ${minAtt}%)`);
    const poeMiss = poeItems.filter((i) => !poeIn(i));
    if (poeItems.length && (poeAll ? poeMiss.length : poeMiss.length === poeItems.length)) reasons.push(`POE ${poeAll ? 'missing' : 'none of'}: ${poeMiss.map(label).join(', ')}`);
    const markMiss = markItems.filter((c) => got[c] === null);
    if (markItems.length && (marksAll ? markMiss.length : markMiss.length === markItems.length)) reasons.push(`Marks ${marksAll ? 'missing' : 'none of'}: ${markMiss.map((c) => label(c.toUpperCase())).join(', ')}`);
    return { admNo: t.admNo, name: t.name, regCode: trs.find((x) => lower(x.adm_no) === lower(t.admNo))?.reg_code || '', att, poe, marks: got, eligible: !reasons.length, reasons };
  });
  await audit(env, me, 'summative candidates', `${cls} ${unit}: ${students.filter((s) => s.eligible).length} of ${students.length}`);
  return { ok: true, term: { id: term.id, name: term.name, duration: term.duration || '', series: term.series || '' }, classCode: cls, unitCode: unit, unitName: u.unit_name || unit,
    trainer: u.trainer_name || '', lessonsHeld: lessons.length, rules: { minAtt, poe: { items: poeItems, need: poeAll ? 'all' : 'any', approvedOnly }, marks: { items: markItems, need: marksAll ? 'all' : 'any' } }, students };
}

/* ---------- deleting (MIS Officer; the Internal Assessment Officer for verification) ----------
 * Verification: a panel (with what it was given), one class-unit given out, or this term's verification altogether.
 * People: a staff account or a student. Their registers, marks and evidence stay (they carry the name). */
async function deletePanel(env, b, me) {
  const p = await one(env, 'SELECT * FROM panels WHERE id=?', String(b.id || ''));
  if (!p) fail('That panel no longer exists');
  const ids = (await all(env, 'SELECT id FROM verifications WHERE panel_id=?', p.id)).map((r) => r.id);
  await many(env, [`DELETE FROM verify_checks WHERE verification_id IN ${IN}`, JSON.stringify(ids)], ['DELETE FROM verifications WHERE panel_id=?', p.id], ['DELETE FROM panels WHERE id=?', p.id]);
  await audit(env, me, 'panel deleted', `${p.name} with ${ids.length} class-unit(s)`);
  return { ok: true, deleted: ids.length };
}
async function deleteVerification(env, b, me) {
  const v = await getVer(env, b.id);
  await many(env, ['DELETE FROM verify_checks WHERE verification_id=?', v.id], ['DELETE FROM verifications WHERE id=?', v.id]);
  await audit(env, me, 'verification deleted', `${v.class_code} ${v.unit_code}`);
  return { ok: true };
}
async function clearVerification(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail('Set up the term first');
  const ids = (await all(env, 'SELECT v.id FROM verifications v JOIN panels p ON p.id=v.panel_id WHERE p.term_id=?', term.id)).map((r) => r.id);
  await many(env, [`DELETE FROM verify_checks WHERE verification_id IN ${IN}`, JSON.stringify(ids)], [`DELETE FROM verifications WHERE id IN ${IN}`, JSON.stringify(ids)],
    ['DELETE FROM panels WHERE term_id=?', term.id], ['DELETE FROM verify_list WHERE term_id=?', term.id]);
  await audit(env, me, 'verification cleared', `${term.name}: panels, ${ids.length} class-unit(s) and the classes list`);
  return { ok: true, deleted: ids.length };
}
async function deleteStaff(env, b, me) {
  const s = await getStaff(env, b.code);
  if (!s) fail('No staff member with that code');
  if (lower(s.code) === lower(me.code)) fail('You cannot delete your own account');
  await many(env, ['DELETE FROM staff WHERE code=?', s.code], ['DELETE FROM login_fails WHERE code=?', s.code]);
  await audit(env, me, 'staff deleted', `${s.code} ${s.name}`);
  await bumpRoster(env);
  return { ok: true };
}
async function deleteStudent(env, b, me) {
  const t = await one(env, 'SELECT * FROM trainees WHERE adm_no=?', String(b.admNo || '').trim());
  if (!t) fail('No student with that admission number');
  const devs = JSON.stringify((await all(env, 'SELECT device_id FROM devices WHERE adm_no=?', t.adm_no)).map((r) => r.device_id));
  await many(env, ['DELETE FROM trainees WHERE adm_no=?', t.adm_no], ['DELETE FROM enrolments WHERE adm_no=?', t.adm_no],
    [`DELETE FROM push_subs WHERE device_id IN ${IN}`, devs], ['DELETE FROM devices WHERE adm_no=?', t.adm_no]);
  await audit(env, me, 'student deleted', `${t.adm_no} ${t.name} (${t.class_code})`);
  await bumpRoster(env);
  return { ok: true };
}

async function driveStatus(env) {
  const [r, archive, quota] = await many(env, ["SELECT value FROM meta WHERE key='drive_report'"], ["SELECT value FROM meta WHERE key='archive_email'"], ["SELECT value FROM meta WHERE key='backup_quota_gb'"]);
  return { ok: true, secret: !!env.BRIDGE_SECRET, report: r[0] ? JSON.parse(r[0].value) : null, archiveEmail: archive[0]?.value || '', quotaGb: Number(quota[0]?.value) || 50, domain: env.GOOGLE_DOMAIN || '' };
}

/* Exported for the local test harness (worker/dev.js); not used by Cloudflare. */
export const internals = { all, one, run, many, finalMarks, acceptedMap, setMeta, getMeta, teachingWeeks, activeTerm, weekOf, nudgeDrive, pushToStudent,
  resetCaches() { schemaReady = false; secretCache = null; keys.clear(); vapidKey = null; vapidTokens.clear(); nudgedAt = 0; },
  resetNudge() { nudgedAt = 0; } };
