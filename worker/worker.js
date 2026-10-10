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

export const VERSION = '5.3.1';
const SCHEMA_VERSION = '4';
const WINDOW_SECONDS = 20;   // how often the lesson QR changes — must match QR_WINDOW in app.js
const CODE_LENGTH = 10;
const TERM_WEEKS = 12;       // every term has 12 teaching weeks (the register template has 12 week blocks)
const STATUS_CODE = { Present: 'P', Absent: 'A', Late: 'L', Excused: 'E' };
const ROLES = ['TRAINER', 'HOD', 'MIS'];
const GONE = "('withdrawn','rejected')";

// One statement per line (D1 exec runs them in order).
const SCHEMA = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS staff (code TEXT PRIMARY KEY COLLATE NOCASE, name TEXT, roles TEXT, responsibility TEXT, active INTEGER DEFAULT 1, pin_hash TEXT, pin_salt TEXT, pin_version INTEGER DEFAULT 0, must_change INTEGER DEFAULT 1, late_pct INTEGER, excused_pct INTEGER, updated_at TEXT);
CREATE TABLE IF NOT EXISTS login_fails (code TEXT PRIMARY KEY COLLATE NOCASE, fails INTEGER, until TEXT);
CREATE TABLE IF NOT EXISTS terms (id TEXT PRIMARY KEY, name TEXT, duration TEXT, start_date TEXT, weeks INTEGER, breaks TEXT, status TEXT, updated_at TEXT, cat_weeks TEXT);
CREATE TABLE IF NOT EXISTS classes (code TEXT PRIMARY KEY, name TEXT, level TEXT, mis_class TEXT, population INTEGER);
CREATE TABLE IF NOT EXISTS units (class_code TEXT, code TEXT, name TEXT, PRIMARY KEY (class_code, code));
CREATE TABLE IF NOT EXISTS loading (term_id TEXT, class_code TEXT, unit_code TEXT, unit_name TEXT, trainer_code TEXT COLLATE NOCASE, trainer_name TEXT, lessons_per_week REAL, hours_per_week REAL, population INTEGER, updated_at TEXT, PRIMARY KEY (term_id, class_code, unit_code));
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
CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, adm_no TEXT COLLATE NOCASE, name TEXT, class_code TEXT, unit_code TEXT, unit_name TEXT, item TEXT, version INTEGER, file_id TEXT, file_name TEXT, bytes INTEGER, pages INTEGER, submitted_at TEXT, status TEXT, decided_by TEXT, decided_name TEXT, decided_at TEXT, comment TEXT, received_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS evidence_adm ON evidence (adm_no, unit_code, item);
CREATE INDEX IF NOT EXISTS evidence_cu ON evidence (class_code, unit_code);
CREATE INDEX IF NOT EXISTS evidence_upd ON evidence (updated_at);
CREATE INDEX IF NOT EXISTS evidence_status ON evidence (status, submitted_at);
CREATE INDEX IF NOT EXISTS evidence_sub ON evidence (submitted_at);`;

const MIGRATIONS = ['ALTER TABLE terms ADD COLUMN cat_weeks TEXT', 'ALTER TABLE sessions ADD COLUMN kind TEXT', 'ALTER TABLE sessions ADD COLUMN slots INTEGER',
  'ALTER TABLE staff ADD COLUMN drive_folder TEXT'];

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
const unitFromSession = (id) => String(id).split(':')[3] || '';
/** A combined lesson ("ICT L6ICT-26J, ICT L6ICT-26M-CT") belongs to each class it names. */
export function classParts(code) {
  const parts = String(code).split(/\s*[,/]\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [code];
  const prefix = (parts[0].match(/^([A-Z]+)\s/) || [])[1];
  return [code, ...parts.map((x) => (prefix && !/\s/.test(x) ? `${prefix} ${x}` : x))];
}
const active = (t) => t && !['withdrawn', 'rejected'].includes(String(t.status || 'active').toLowerCase());
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
function upsertStmts(table, cols, rows, key, update = cols.filter((c) => !(key || []).includes(c))) {
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
  await setMeta(env, 'schema', SCHEMA_VERSION);
  schemaReady = true;
}
const getMeta = async (env, key) => (await one(env, 'SELECT value FROM meta WHERE key=?', key))?.value ?? null;
const metaStmt = (key, value) => ['INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)];
const setMeta = (env, key, value) => many(env, metaStmt(key, value));
const changedStmt = () => metaStmt('last_change', nowIso());
const markChanged = (env) => many(env, changedStmt());
const bumpRoster = (env) => setMeta(env, 'roster_v', nowIso() + '#' + Math.random().toString(36).slice(2, 6));
const catWeeksOf = (v) => [...new Set(String(v || '').split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= TERM_WEEKS))].sort((a, b) => a - b);
const termOut = (r) => (r ? { id: r.id, name: r.name, duration: r.duration, startDate: r.start_date, weeks: TERM_WEEKS, breaks: String(r.breaks || '').split(/[\s,;]+/).filter(Boolean),
  catWeeks: catWeeksOf(r.cat_weeks) } : null);
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
        if (p.action === 'classlist') return reply(await classList(env, p.class));
        if (p.action === 'units') return reply(await classUnits(env, p.class));
        if (p.action === 'ping') return reply({ ok: true, version: VERSION, server: 'cloudflare', time: nowIso() });
        return reply({ ok: false, error: 'Unknown action' });
      }
      const b = JSON.parse((await request.text()) || '{}');
      if (b.action === 'checkin') return reply(await receiveCheckins(env, b.checkins || []));
      if (b.action === 'register') return reply(await registerDevice(env, b));
      if (b.action === 'login') return reply(await login(env, b));
      // Student phones (checked against their registration) and the Drive bridge (signed with BRIDGE_SECRET).
      if (STUDENT_ACTIONS[b.action]) return reply(await STUDENT_ACTIONS[b.action](env, b));
      if (BRIDGE_ACTIONS[b.action]) return reply(await BRIDGE_ACTIONS[b.action](env, b));
      const h = ACTIONS[b.action];
      // The sign-in check and the action's first reads go to the database together, in one trip.
      const [me, pre] = await auth(env, b.auth, h && h.pre ? h.pre(b) : []);
      if (!h) return reply({ ok: false, error: 'Unknown action' });
      if (h.role && !me.roles.some((r) => h.role.includes(r))) fail(`This needs the ${h.role.join(' or ')} role. Ask the MIS Officer.`);
      if (me.mustChange && b.action !== 'setPin') fail('Choose a new PIN first', { mustChange: true });
      const out = await h.fn(env, b, me, pre);
      if (b.action === 'roster' && ctx?.waitUntil) ctx.waitUntil(foldOldCheckins(env).catch((e) => console.error('fold', e)));
      return reply(out);
    } catch (err) {
      const out = { ok: false, error: String(err && err.message || err) };
      if (err && err.authError) out.authError = true;
      if (err && err.mustChange) out.mustChange = true;
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
  checkins: { role: ['TRAINER', 'HOD'], pre: (b) => [checkinsQuery(b.sessionIds || [], b.since || '')], fn: (env, b, me, pre) => acceptedCheckins(b.sessionIds || [], pre.rows[0]) },
  addStudents: { role: ['TRAINER', 'HOD'], fn: (env, b, me) => addStudents(env, b.students || [], me) },
  mySettings: { fn: (env, b, me) => saveMySettings(env, b, me) },
  report: { pre: (b) => reportPre(b), fn: (env, b, me, pre) => reportData(env, b, me, pre) },
  submitSignoff: { role: ['TRAINER', 'HOD'], fn: (env, b, me) => submitSignoff(env, b, me) },
  signoffs: { fn: (env, b, me) => listSignoffs(env, me) },
  decideSignoff: { role: ['HOD'], fn: (env, b, me) => decideSignoff(env, b, me) },
  overview: { role: ['HOD', 'MIS'], pre: () => overviewPre(), fn: (env, b, me, pre) => overview(pre) },
  saveTerm: { role: ['MIS'], fn: (env, b, me) => saveTerm(env, b, me) },
  uploadLoading: { role: ['MIS'], fn: (env, b, me) => uploadLoading(env, b, me) },
  importClassList: { role: ['MIS'], fn: (env, b, me) => importClassList(env, b, me) },
  students: { role: ['MIS', 'HOD'], fn: (env, b) => studentsOf(env, b.misClass || '', b.classCode || '') },
  updateStudent: { role: ['MIS'], fn: (env, b, me) => updateStudent(env, b, me) },
  requests: { role: ['MIS', 'HOD'], fn: (env) => listRequests(env) },
  decideRequest: { role: ['MIS'], fn: (env, b, me) => decideRequest(env, b, me) },
  staff: { role: ['MIS'], fn: (env) => listStaff(env) },
  updateStaff: { role: ['MIS'], fn: (env, b, me) => updateStaff(env, b, me) },
  importSheet: { role: ['MIS'], fn: (env, b, me) => importSheet(env, b, me) },
  poeList: { fn: (env, b, me) => poeList(env, b, me) },
  poeView: { fn: (env, b, me) => poeView(env, b, me) },
  poeDecide: { role: ['TRAINER', 'HOD'], fn: (env, b, me) => poeDecide(env, b, me) },
  poeReceive: { role: ['MIS'], fn: (env, b, me) => poeReceive(env, b, me) },
  driveStatus: { role: ['MIS', 'HOD'], fn: (env) => driveStatus(env) },
  poeClass: { role: ['MIS', 'HOD'], fn: (env, b) => poeClass(env, b) },
};

/* ---------- staff sign-in ---------- */
function staffPublic(r) {
  return { code: r.code, name: r.name, roles: rolesList(r.roles), responsibility: r.responsibility || '', active: !!r.active,
    hasPin: !!r.pin_hash, mustChange: !!r.must_change, latePct: r.late_pct ?? 50, excusedPct: r.excused_pct ?? 100, driveFolder: r.drive_folder || '' };
}
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
  const [lfRows, staffRows, misRows, secretRows] = await many(env, ['SELECT * FROM login_fails WHERE code=?', code], ['SELECT * FROM staff WHERE code=?', code],
    ["SELECT 1 AS x FROM staff WHERE active=1 AND upper(roles) LIKE '%MIS%' LIMIT 1"], ["SELECT value FROM meta WHERE key='auth_secret'"]);
  if (!secretCache && secretRows[0]) secretCache = secretRows[0].value;
  const lf = lfRows[0];
  if (lf && lf.fails >= 5 && lf.until > nowIso()) fail('Too many wrong PINs. Try again in 15 minutes.');
  let row = staffRows[0];
  // First sign-in on a new database: staff code MIS with the ADMIN_PIN secret set on the Worker.
  if (!row && lower(code) === 'mis' && env.ADMIN_PIN && !misRows.length) {
    row = await setStaffPin(env, 'MIS', String(env.ADMIN_PIN), true, { name: 'MIS Officer', roles: 'MIS' });
  }
  if (!row && lower(code) === 'mis' && !env.ADMIN_PIN) fail('First sign-in: add the ADMIN_PIN secret to the Worker (Settings → Variables and Secrets), then try again.');
  if (!row || !row.active || !row.pin_hash || (await sha256Hex(row.pin_salt + '|' + pin)) !== row.pin_hash) {
    const fails = lf && lf.until > nowIso() ? lf.fails + 1 : 1;
    await run(env, 'INSERT INTO login_fails (code,fails,until) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET fails=excluded.fails, until=excluded.until',
      code, fails, new Date(Date.now() + 15 * 6e4).toISOString());
    fail(row && !row.pin_hash ? 'No PIN has been set for this staff code yet. Ask the MIS Officer.' : 'Wrong staff code or PIN');
  }
  if (lf) await run(env, 'DELETE FROM login_fails WHERE code=?', code);
  return { ok: true, token: await makeToken(env, row), staff: staffPublic(row), mustChange: !!row.must_change };
}

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
  if (!row || !row.active || String(row.pin_version) !== String(Number(parts[1]))) {
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

async function saveTerm(env, b, me) {
  if (!b.name || !/^\d{4}-\d{2}-\d{2}$/.test(b.startDate || '')) fail('Give the term a name and a start date');
  const id = String(b.termId || '').trim() || 'T' + b.startDate;
  const breaks = (b.breaks || []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).map(mondayOf);
  await run(env, "UPDATE terms SET status='closed' WHERE status='active' AND id<>?", id);
  const cats = catWeeksOf((b.catWeeks || []).join(','));
  await run(env, `INSERT INTO terms (id,name,duration,start_date,weeks,breaks,status,updated_at,cat_weeks) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, duration=excluded.duration, start_date=excluded.start_date, breaks=excluded.breaks, status=excluded.status, updated_at=excluded.updated_at, cat_weeks=excluded.cat_weeks`,
  id, b.name, b.duration || '', b.startDate, TERM_WEEKS, breaks.join(', '), b.close ? 'closed' : 'active', nowIso(), cats.join(', '));
  await audit(env, me, b.close ? 'close term' : 'save term', `${id} ${b.name} from ${b.startDate}${breaks.length ? ' breaks ' + breaks.join(' ') : ''}${cats.length ? ' CAT weeks ' + cats.join(' ') : ''}`);
  await bumpRoster(env);
  const term = await activeTerm(env);
  return { ok: true, term, weeks: teachingWeeks(term) };
}

/* ---------- trainer loading ---------- */
async function uploadLoading(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail('Set up the term first (Manage > Term)');
  const now = nowIso();
  const seen = new Map();
  for (const r of b.rows || []) {
    if (!r || !r.classCode || !r.unitCode) continue;
    const k = r.classCode + '|' + r.unitCode;
    if (!seen.has(k)) seen.set(k, r);
  }
  if (!seen.size) fail('No loading rows found in that file');
  const rows = [...seen.values()];
  await run(env, 'DELETE FROM loading WHERE term_id=?', term.id);
  await upsertMany(env, 'loading', ['term_id', 'class_code', 'unit_code', 'unit_name', 'trainer_code', 'trainer_name', 'lessons_per_week', 'hours_per_week', 'population', 'updated_at'],
    rows.map((r) => ({ term_id: term.id, class_code: r.classCode, unit_code: r.unitCode, unit_name: r.unitName || r.unitCode, trainer_code: r.trainerCode || '',
      trainer_name: r.trainerName || '', lessons_per_week: Number(r.lessonsPerWeek) || 2, hours_per_week: Number(r.hoursPerWeek) || 3, population: Number(r.population) || null, updated_at: now })),
    ['term_id', 'class_code', 'unit_code']);
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
  return { ok: true, term: term.id, rows: rows.length, trainers: info.size, newStaff: added, classes: classes.size };
}


/* ---------- roster for staff phones ---------- */
async function readRoster(env, b, me, pre) {
  const version = pre.meta.roster_v || 'none';
  if (b.version && b.version === version) return { ok: true, unchanged: true, version, me };
  const [termRows, loading, unitRows, classRows, reqs, staffRows] = await many(env, [TERM_SQL], [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`], ['SELECT * FROM units'],
    ['SELECT * FROM classes'], ["SELECT adm_no, name, class_code, requested_name, reason, status, merged_into FROM requests WHERE status IN ('pending','rejected','merged')"],
    ['SELECT code, name, late_pct, excused_pct FROM staff']);
  const term = termOut(termRows[0]);
  const units = loading.length
    ? loading.map((r) => ({ classCode: r.class_code, code: r.unit_code, name: r.unit_name || r.unit_code, trainerCode: r.trainer_code, trainerName: r.trainer_name,
      lessonsPerWeek: Number(r.lessons_per_week) || 2, hoursPerWeek: Number(r.hours_per_week) || 3 }))
    : unitRows.map((r) => ({ classCode: r.class_code, code: r.code, name: r.name || r.code, lessonsPerWeek: 2, hoursPerWeek: 3 }));
  // Trainers get only the class lists of the classes they teach; the HOD and MIS Officer get all.
  const mine = new Set();
  if (!(me.roles.includes('HOD') || me.roles.includes('MIS'))) {
    for (const u of loading) if (lower(u.trainer_code) === lower(me.code)) classParts(u.class_code).forEach((c) => mine.add(c));
  }
  const trainees = mine.size ? await all(env, `SELECT adm_no, name, class_code, status FROM trainees WHERE class_code IN ${IN}`, JSON.stringify([...mine]))
    : await all(env, 'SELECT adm_no, name, class_code, status FROM trainees');
  const staff = {};
  for (const r of staffRows) staff[r.code] = { name: r.name, latePct: r.late_pct ?? 50, excusedPct: r.excused_pct ?? 100 };
  return {
    ok: true, version, me, term, weeks: teachingWeeks(term),
    classes: classRows.map((r) => ({ code: r.code, name: r.name || r.code, level: r.level || levelOf(r.code), misClass: r.mis_class || '' })),
    units,
    trainees: trainees.map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no, classCode: r.class_code, active: active(r) })),
    pending: reqs.filter((r) => r.status === 'pending').map((r) => ({ admNo: r.adm_no, name: r.name, classCode: r.class_code, requestedBy: r.requested_name, reason: r.reason })),
    rejected: reqs.filter((r) => r.status === 'rejected').map((r) => ({ admNo: r.adm_no, classCode: r.class_code })),
    aliases: reqs.filter((r) => r.status === 'merged' && r.merged_into).map((r) => ({ from: r.adm_no, to: r.merged_into, classCode: r.class_code })),
    staff,
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
  if (dev && lower(dev.adm_no) !== lower(t.adm_no)) return { ok: false, error: `This phone is already registered to ${dev.tname || dev.adm_no}. Ask your trainer to reset it.` };
  if (byAdm && byAdm.device_id !== b.deviceId) return { ok: false, error: `${t.name} is already registered on another phone. Ask your trainer to reset it.` };
  const now = nowIso();
  await run(env, 'INSERT INTO devices (device_id,adm_no,name,class_code,registered_at,last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET last_seen=excluded.last_seen',
    b.deviceId, t.adm_no, t.name, t.class_code, now, now);
  return { ok: true, admNo: t.adm_no, name: t.name, classCode: t.class_code, className: t.class_name || t.class_code };
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
  const out = { added: [], unchanged: 0, renamed: [], moved: [], confirmed: [], missing: [], byStream: {}, plan: [] };
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
    if (!active(row)) { row.status = 'active'; changed = true; }
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
    out.missing.push({ admNo: r.adm_no, name: r.name, classCode: r.class_code });
    if (withdraw.has(lower(r.adm_no))) {
      writes.push({ ...r, status: 'withdrawn', updated_by: me.code, updated_at: now, note: `Not on the ${mis} list ${todayIso()}` });
      inStream[r.class_code]--;
    }
  }
  for (const s of streams) out.byStream[s] = inStream[s];
  if (!b.dryRun) {
    await many(env, ...upsertStmts('trainees', TCOLS, writes, ['adm_no']),
      pend.length && [`UPDATE requests SET status='approved', decided_by=?, decided_at=?, note=? WHERE id IN ${IN}`, me.code, now, 'On the MIS list for ' + mis, JSON.stringify(pend.map((r) => r.id))],
      // Link the streams to this MIS class so the student app groups them and reports show the MIS code.
      ...upsertStmts('classes', ['code', 'name', 'level', 'mis_class'], streams.map((s) => ({ code: s, name: s, level: levelOf(s) || levelOf(mis), mis_class: mis })), ['code'], ['mis_class']));
    await audit(env, me, 'class list', `${mis} → ${streams.join(', ')}: ${out.added.length} added, ${out.moved.length} moved, ${(b.withdraw || []).length} withdrawn, ${out.confirmed.length} trainer additions confirmed`);
    await bumpRoster(env);
  }
  return { ...out, ok: true, dryRun: !!b.dryRun, misClass: mis, streams, total: students.length };
}

async function studentsOf(env, misClass, classCode) {
  const rows = classCode
    ? await all(env, 'SELECT * FROM trainees WHERE class_code=?', classCode)
    : await all(env, 'SELECT t.* FROM trainees t LEFT JOIN classes c ON c.code=t.class_code WHERE t.mis_class=? OR c.mis_class=?', misClass, misClass);
  return { ok: true, students: rows.map((r) => ({ admNo: r.adm_no, name: r.name, classCode: r.class_code, status: active(r) ? 'active' : (r.status || 'withdrawn'), note: r.note })) };
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
  return { ok: true, staff: (await all(env, 'SELECT * FROM staff ORDER BY name')).map(staffPublic) };
}
async function updateStaff(env, b, me) {
  const code = String(b.code || '').trim().toUpperCase();
  if (!code) fail('Enter a staff code');
  let row = await getStaff(env, code);
  if (!row) {
    if (!b.name) fail("Enter the staff member's name");
    row = { code, name: b.name, roles: 'TRAINER', responsibility: '', active: 1, pin_version: 0, must_change: 1 };
  }
  if (b.name) row.name = String(b.name).trim();
  if (b.roles) {
    const roles = rolesList(Array.isArray(b.roles) ? b.roles.join(',') : b.roles);
    if (lower(code) === lower(me.code) && !roles.includes('MIS')) fail('You cannot remove your own MIS role');
    row.roles = roles.join(', ');
  }
  if (b.driveFolder !== undefined) {
    // A Drive folder link or ID chosen by the MIS Officer when the name match does not find it.
    const id = (String(b.driveFolder).match(/[-\w]{20,}/) || [''])[0];
    await run(env, 'UPDATE staff SET drive_folder=?, updated_at=? WHERE code=?', id || null, nowIso(), code);
    if (!b.roles && b.active === undefined && !b.resetPin && !b.name) return { ok: true, staff: staffPublic(await getStaff(env, code)) };
  }
  if (b.active !== undefined) {
    if (lower(code) === lower(me.code) && !b.active) fail('You cannot switch off your own account');
    row.active = b.active ? 1 : 0;
    row.pin_version = (Number(row.pin_version) || 0) + 1; // signs them out everywhere
  }
  await run(env, `INSERT INTO staff (code,name,roles,responsibility,active,pin_version,must_change,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, roles=excluded.roles, active=excluded.active, pin_version=excluded.pin_version, updated_at=excluded.updated_at`,
  row.code, row.name, row.roles, row.responsibility || '', row.active ? 1 : 0, Number(row.pin_version) || 0, row.must_change ? 1 : 0, nowIso());
  let pin = null;
  if (b.resetPin) { pin = randomPin(); row = await setStaffPin(env, code, pin, true); }
  await audit(env, me, 'staff', `${code}${b.roles ? ' roles ' + row.roles : ''}${b.active !== undefined ? (b.active ? ' switched on' : ' switched off') : ''}${pin ? ' PIN reset' : ''}`);
  await bumpRoster(env);
  return { ok: true, staff: staffPublic(await getStaff(env, code)), pin };
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
  return [[`SELECT id, updated_at, json_extract(data, '$.qrFolded') AS folded FROM sessions WHERE id IN ${IN}`, J], [TERM_SQL],
    [`SELECT * FROM checkins WHERE session_id IN ${IN} AND status IN ('accepted','pending')`, J]];
}
async function pushSessions(env, sessions, me, pre) {
  sessions = pushList(sessions);
  const [old, termRows, cis] = pre.rows;
  const have = new Map(old.map((r) => [r.id, r.updated_at]));
  const folded = new Map(old.filter((r) => r.folded).map((r) => [r.id, JSON.parse(r.folded)]));
  const results = [], fresh = [];
  for (const s of sessions) {
    // Never let an older copy (e.g. from a phone that was offline longer) overwrite a newer one.
    if (have.has(s.sessionId) && String(have.get(s.sessionId)) > String(s.updatedAt || '')) { results.push({ sessionId: s.sessionId, status: 'stale' }); continue; }
    s.uploadedBy = me.code;
    if (folded.has(s.sessionId)) s.qrFolded = { ...folded.get(s.sessionId), ...(s.qrFolded || {}) };
    fresh.push(s);
    results.push({ sessionId: s.sessionId, status: have.has(s.sessionId) ? 'updated' : 'added' });
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
  const c = String(b.classCode || ''), u = String(b.unitCode || '');
  return [[TERM_SQL], [`SELECT 1 AS x FROM loading WHERE term_id=${ACTIVE_TERM} LIMIT 1`], [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM} AND class_code=? AND unit_code=?`, c, u],
    ['SELECT id, date, data FROM sessions WHERE class_code=? AND unit_code=?', c, u],
    ["SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN (SELECT id FROM sessions WHERE class_code=? AND unit_code=?)", c, u],
    ['SELECT * FROM signoffs WHERE class_code=? AND unit_code=?', c, u]];
}
/** Every lesson of one class and unit this term, with final marks, for the term register. */
async function reportData(env, b, me, pre) {
  if (!b.classCode || !b.unitCode) fail('Choose a class and a unit');
  const [termRows, anyLoading, loadRows, sessRows, acc, soRows] = pre.rows;
  const term = termOut(termRows[0]), load = loadRows[0] || null;
  const staffOnly = !(me.roles.includes('HOD') || me.roles.includes('MIS'));
  if (staffOnly && term && anyLoading.length && !(load && lower(load.trainer_code) === lower(me.code))) fail('You can only see reports for the units in your loading');
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
  return { ok: true, term, weeks, lessons, serverTime: nowIso(), signoff: so ? signoffOut(so) : null,
    loading: load ? { trainerCode: load.trainer_code, trainerName: load.trainer_name, unitName: load.unit_name, lessonsPerWeek: Number(load.lessons_per_week) || 2, hoursPerWeek: Number(load.hours_per_week) || 3 } : null };
}

const signoffId = (term, c, u) => `${term ? term.id : 'no-term'}|${c}|${u}`;
const signoffOut = (r) => ({ id: r.id, classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name, trainerCode: r.trainer_code, trainerName: r.trainer_name,
  lecturerComment: r.lecturer_comment, submittedAt: r.submitted_at, status: r.status, hodName: r.hod_name, hodComment: r.hod_comment, decidedAt: r.decided_at });

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

async function decideSignoff(env, b, me) {
  const old = await one(env, 'SELECT * FROM signoffs WHERE id=?', b.id);
  if (!old) fail('That register has not been submitted');
  if (b.decision !== 'approved' && b.decision !== 'returned') fail('Choose approve or return');
  if (b.decision === 'returned' && !String(b.comment || '').trim()) fail('Say what needs fixing when returning a register');
  await run(env, 'UPDATE signoffs SET status=?, hod_code=?, hod_name=?, hod_comment=?, decided_at=? WHERE id=?', b.decision, me.code, me.name, String(b.comment || '').slice(0, 1000), nowIso(), b.id);
  await audit(env, me, 'sign-off', `${b.id} ${b.decision}`);
  return { ok: true, signoff: signoffOut(await one(env, 'SELECT * FROM signoffs WHERE id=?', b.id)) };
}

async function listSignoffs(env, me) {
  const term = await activeTerm(env);
  const mine = !me.roles.includes('HOD') && !me.roles.includes('MIS');
  const rows = await all(env, `SELECT * FROM signoffs WHERE (? IS NULL OR term_id=?) ${mine ? 'AND trainer_code=?' : ''} ORDER BY submitted_at DESC`,
    ...(mine ? [term?.id ?? null, term?.id ?? null, me.code] : [term?.id ?? null, term?.id ?? null]));
  return { ok: true, signoffs: rows.map(signoffOut) };
}

/** HOD view: for each class and unit in the loading, how many lessons are marked against how many were due. */
const overviewPre = () => [[TERM_SQL],
  [`SELECT class_code, unit_code, SUM(COALESCE(slots,1)) AS lessons, MAX(date) AS last, SUM(present+late) AS att, SUM(present+late+absent) AS counted FROM sessions
    WHERE COALESCE(kind,'lesson')='lesson' AND (term_id=${ACTIVE_TERM} OR ((term_id IS NULL OR term_id='') AND date >= date((SELECT start_date FROM terms WHERE status='active' ORDER BY updated_at DESC LIMIT 1), '-6 days')))
    GROUP BY class_code, unit_code`],
  [`SELECT class_code, unit_code, status FROM signoffs WHERE term_id=${ACTIVE_TERM}`], [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`]];
function overview(pre) {
  const [termRows, statRows, soRows, loading] = pre.rows;
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

/* ---------- moving in from the Google Sheet ---------- */
const yes = (v) => /^(yes|y|true|1)$/i.test(String(v ?? '').trim());
const numOr = (v, d = null) => { const n = Number(String(v ?? '').replace(/\.$/, '')); return String(v ?? '').trim() === '' || !Number.isFinite(n) ? d : n; };
const SHEET_MAP = {
  Staff: (r) => ['staff', { code: r.StaffCode, name: r.Name, roles: r.Roles, responsibility: r.Responsibility, active: /^(no|n|false|0|inactive)$/i.test(r.Active || '') ? 0 : 1,
    pin_hash: r.PinHash || null, pin_salt: r.PinSalt || null, pin_version: numOr(r.PinVersion, 0), must_change: yes(r.MustChange) ? 1 : 0, late_pct: numOr(r.LatePct), excused_pct: numOr(r.ExcusedPct), updated_at: r.UpdatedAt }, ['code']],
  Terms: (r) => ['terms', { id: r.TermID, name: r.Name, duration: r.Duration, start_date: r.StartDate, weeks: TERM_WEEKS, breaks: r.Breaks, status: r.Status, updated_at: r.UpdatedAt, cat_weeks: r.CatWeeks || null }, ['id']],
  Classes: (r) => ['classes', { code: r.ClassCode, name: r.ClassName, level: r.Level, mis_class: r.MisClass || null, population: numOr(r.Population) }, ['code']],
  Units: (r) => ['units', { class_code: r.ClassCode, code: r.UnitCode, name: r.UnitName }, ['class_code', 'code']],
  Loading: (r) => ['loading', { term_id: r.TermID, class_code: r.ClassCode, unit_code: r.UnitCode, unit_name: r.UnitName, trainer_code: r.TrainerCode, trainer_name: r.TrainerName,
    lessons_per_week: numOr(r.LessonsPerWeek, 2), hours_per_week: numOr(r.HoursPerWeek, 3), population: numOr(r.Population), updated_at: r.UpdatedAt }, ['term_id', 'class_code', 'unit_code']],
  Trainees: (r) => ['trainees', { adm_no: r.AdmNo, name: r.Name, class_code: r.ClassCode,
    status: /^(no|n|false|0|inactive|left|discontinued|withdrawn)$/i.test(r.Active || '') ? 'withdrawn' : (r.Status || 'active'), mis_class: r.MisClass || null,
    added_by: r.AddedBy, added_at: r.AddedAt, updated_by: r.UpdatedBy, updated_at: r.UpdatedAt, note: r.Note }, ['adm_no']],
  Requests: (r) => ['requests', { id: r.RequestID, adm_no: r.AdmNo, name: r.Name, class_code: r.ClassCode, reason: r.Reason, requested_by: r.RequestedBy, requested_name: r.RequestedName,
    requested_at: r.RequestedAt, status: r.Status, decided_by: r.DecidedBy, decided_at: r.DecidedAt, merged_into: r.MergedInto || null, note: r.Note }, ['id']],
  SignOffs: (r) => ['signoffs', { id: r.SignOffID, term_id: r.TermID, class_code: r.ClassCode, unit_code: r.UnitCode, unit_name: r.UnitName, trainer_code: r.TrainerCode, trainer_name: r.TrainerName,
    lecturer_comment: r.LecturerComment, submitted_at: r.SubmittedAt, status: r.Status, hod_code: r.HodCode, hod_name: r.HodName, hod_comment: r.HodComment, decided_at: r.DecidedAt }, ['id']],
  CheckIns: (r) => ['checkins', { session_id: r.SessionID, adm_no: r.AdmNo, device_id: r.DeviceID, name: r.Name, w: r.Window, code: r.Code,
    scanned_at: r.ScannedAt, updated_at: r.UpdatedAt, status: r.Status, reason: r.Reason }, CIKEY],
  Devices: (r) => ['devices', { device_id: r.DeviceID, adm_no: r.AdmNo, name: r.Name, class_code: r.ClassCode, registered_at: r.RegisteredAt, last_seen: r.LastSeen }, ['device_id']],
};

/** MIS: copies one tab of the Google Sheet export into the database (the app sends it in parts). Existing rows are updated. */
async function importSheet(env, b, me) {
  const tab = String(b.tab || '');
  const rows = (b.rows || []).slice(0, 1000);
  if (tab === 'SessionData') {
    const term = await activeTerm(env);
    const list = rows.map((r) => { try { return JSON.parse(r.Json); } catch { return null; } }).filter((s) => s && s.sessionId);
    const accepted = await acceptedMap(env, list.map((s) => s.sessionId));
    const now = nowIso();
    await upsertMany(env, 'sessions', SCOLS, list.map((s) => sessionRow(s, accepted[s.sessionId], term, now)), ['id']);
    return { ok: true, tab, saved: list.length };
  }
  if (tab === 'AuditLog') {
    await upsertMany(env, 'audit', ['at', 'staff_code', 'name', 'action', 'details'], rows.filter((r) => r.At).map((r) => ({ at: r.At, staff_code: r.StaffCode, name: r.Name, action: r.Action, details: r.Details })), null);
    return { ok: true, tab, saved: rows.length };
  }
  const map = SHEET_MAP[tab];
  if (!map) return { ok: true, tab, saved: 0, skipped: true };
  let table, key;
  const out = [];
  for (const r of rows) {
    const [t, row, k] = map(r);
    table = t; key = k;
    if (!k.every((c) => row[c] !== undefined && row[c] !== null && String(row[c]).trim() !== '')) continue;
    if (t === 'staff' && lower(row.code) === lower(me.code)) continue; // keep the PIN you are signed in with
    out.push(row);
  }
  if (out.length) await upsertMany(env, table, Object.keys(out[0]), out, key);
  await audit(env, me, 'import from Sheet', `${tab}: ${out.length} rows`);
  await bumpRoster(env);
  return { ok: true, tab, saved: out.length };
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
};

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
    const [sess, tr, rq, so, st, ld, tm] = await many(env, ['SELECT DISTINCT class_code, unit_code FROM sessions WHERE synced_at > ?', since],
      ['SELECT DISTINCT class_code FROM trainees WHERE updated_at > ? OR added_at > ?', since, since],
      ['SELECT DISTINCT class_code FROM requests WHERE requested_at > ? OR decided_at > ?', since, since],
      ['SELECT DISTINCT class_code, unit_code FROM signoffs WHERE submitted_at > ? OR decided_at > ?', since, since],
      ['SELECT code FROM staff WHERE updated_at > ?', since], ['SELECT 1 AS x FROM loading WHERE updated_at > ? LIMIT 1', since], ['SELECT 1 AS x FROM terms WHERE updated_at > ? LIMIT 1', since]);
    const all = ld.length || tm.length;
    const want = new Set([...sess, ...so].map(unitKey));
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
  const res = await many(env, ...stmts, [`SELECT adm_no, name, class_code, status FROM trainees WHERE class_code IN ${IN}`, JSON.stringify(classSet)],
    [`SELECT adm_no, name, class_code, status, merged_into FROM requests WHERE class_code IN ${IN} AND status IN ('pending','rejected','merged')`, JSON.stringify(units.map((u) => u.class_code))],
    [`SELECT * FROM signoffs WHERE term_id=?`, term.id], [`SELECT code, late_pct, excused_pct FROM staff`], [`SELECT code, mis_class FROM classes WHERE code IN ${IN}`, JSON.stringify(units.map((u) => u.class_code))]);
  const [trainees, reqs, signoffs, staffPct, classes] = res.slice(units.length * 2);
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
    const h = (Number(u.hours_per_week) || 3) / (Number(u.lessons_per_week) || 2);
    const so = signoffs.find((x) => x.class_code === u.class_code && x.unit_code === u.unit_code);
    const lessons = all.filter((l) => l.kind === 'lesson');
    out.units.push({
      key: unitKey(u), trainerCode: u.trainer_code, trainerName: u.trainer_name, classCode: u.class_code, unitCode: u.unit_code, unitName: u.unit_name,
      misClass: (classes.find((c) => c.code === u.class_code) || {}).mis_class || u.class_code, level: levelOf(u.class_code), termName: term.name, duration: term.duration || '',
      weeks, lessonHours: h, lessonsHeld: lessons.length,
      rows: buildRegister({ weeks, lessons, roster, alias, rejected, h, latePct: pct.late_pct ?? 50, excPct: pct.excused_pct ?? 100 }),
      lecturerComment: so?.lecturer_comment || '', hodComment: so?.hod_comment || '', signoff: so?.status || '',
      cats: all.filter((l) => l.kind !== 'lesson').sort((a, c) => a.date.localeCompare(c.date)).map((l) => ({ title: l.title || (l.kind === 'cat' ? 'CAT' : 'Extra'), date: l.date, kind: l.kind, marks: l.marks })),
    });
  });
  return out;
}

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
  const [loading, url] = await many(env, [`SELECT class_code, unit_code, unit_name FROM loading WHERE term_id=${ACTIVE_TERM}`], ["SELECT value FROM meta WHERE key='drive_url'"]);
  const seen = new Set(), units = [];
  for (const u of unitsForClass(loading, cls)) if (!seen.has(u.unit_code)) { seen.add(u.unit_code); units.push({ code: u.unit_code, name: u.unit_name || u.unit_code }); }
  return { ok: true, classCode: cls, units, items: ITEMS, driveReady: !!url[0] };
}
const evidenceOut = (r) => ({ id: r.id, admNo: r.adm_no, name: r.name, classCode: r.class_code, unitCode: r.unit_code, unitName: r.unit_name, item: r.item,
  version: r.version, fileId: r.file_id, fileName: r.file_name, bytes: r.bytes, pages: r.pages, submittedAt: r.submitted_at, status: r.status,
  decidedName: r.decided_name || '', decidedAt: r.decided_at || '', comment: r.comment || '', receivedAt: r.received_at || '', updatedAt: r.updated_at });
const STUDENT_ACTIONS = {
  async poeTicket(env, b) {
    const t = await studentOf(env, b);
    const item = String(b.item || '').toUpperCase();
    if (!ITEMS.includes(item)) fail('Choose CAT1–CAT4 or PRAC1–PRAC3');
    if (Number(b.bytes) > MAX_EVIDENCE_BYTES) fail('That file is over 20 MB. Scan fewer pages or use the Document filter.');
    const [loading, ver, url] = await many(env, [`SELECT unit_code, unit_name, class_code FROM loading WHERE term_id=${ACTIVE_TERM} AND unit_code=?`, String(b.unitCode || '')],
      ['SELECT MAX(version) AS v FROM evidence WHERE adm_no=? AND unit_code=? AND item=?', t.adm_no, String(b.unitCode || ''), item], ["SELECT value FROM meta WHERE key='drive_url'"]);
    const unit = unitsForClass(loading, t.class_code)[0];
    if (!unit) fail('That unit is not taught to your class this term');
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
    return { ok: true, evidence: (await all(env, 'SELECT * FROM evidence WHERE adm_no=? ORDER BY submitted_at DESC', t.adm_no)).map(evidenceOut) };
  },
};

/* ---------- trainers, HOD and MIS ---------- */
async function myUnitPairs(env, me) {
  const loading = await all(env, `SELECT class_code, unit_code, unit_name, trainer_code FROM loading WHERE term_id=${ACTIVE_TERM}`);
  const mine = loading.filter((u) => lower(u.trainer_code) === lower(me.code));
  return { loading, pairs: new Set(mine.flatMap((u) => classParts(u.class_code).map((c) => c + '|' + u.unit_code))) };
}
const seesAll = (me) => me.roles.includes('HOD') || me.roles.includes('MIS');
async function poeList(env, b, me) {
  const { pairs } = await myUnitPairs(env, me);
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
  // Links into Drive: the trainer's own attendance sheet; the evidence index for the HOD and MIS Officer.
  const rep = JSON.parse((await getMeta(env, 'drive_report')) || 'null') || {};
  const sheetUrl = Object.entries(rep.sheets || {}).find(([c]) => lower(c) === lower(me.code))?.[1] || '';
  return { ok: true, evidence: list.map(evidenceOut), mine: [...pairs], sheetUrl, indexUrl: seesAll(me) ? rep.indexUrl || '' : '', driveReady: !!rep.url };
}
async function evidenceFor(env, id, me, decide) {
  const r = await one(env, 'SELECT * FROM evidence WHERE id=?', String(id || ''));
  if (!r) fail('That submission no longer exists');
  const { pairs } = await myUnitPairs(env, me);
  const ok = pairs.has(r.class_code + '|' + r.unit_code) || me.roles.includes('HOD') || (!decide && me.roles.includes('MIS'));
  if (!ok) fail('Only the trainer of this unit or the HOD can do that');
  return r;
}
async function poeView(env, b, me) {
  const r = await evidenceFor(env, b.id, me, false);
  const url = await getMeta(env, 'drive_url');
  if (!url) fail('The Google Drive link is not set up yet');
  return { ok: true, driveUrl: url, fileName: r.file_name, ticket: await signTicket(env, { k: 'view', fileId: r.file_id, exp: Date.now() + 10 * 6e4 }) };
}
async function poeDecide(env, b, me) {
  const r = await evidenceFor(env, b.id, me, true);
  if (!['approved', 'returned'].includes(b.decision)) fail('Choose approve or return');
  const comment = String(b.comment || '').trim().slice(0, 500);
  if (b.decision === 'returned' && !comment) fail('Say what needs fixing when returning evidence');
  const now = nowIso();
  await run(env, 'UPDATE evidence SET status=?, decided_by=?, decided_name=?, decided_at=?, comment=?, updated_at=? WHERE id=?', b.decision, me.code, me.name, now, comment, now, r.id);
  await audit(env, me, 'evidence', `${r.adm_no} ${r.unit_code} ${r.item} v${r.version} ${b.decision}`);
  return { ok: true, evidence: evidenceOut(await one(env, 'SELECT * FROM evidence WHERE id=?', r.id)) };
}
async function poeReceive(env, b, me) {
  const ids = (b.ids || []).map(String).slice(0, 1000), now = nowIso();
  await run(env, `UPDATE evidence SET received_at=?, updated_at=? WHERE status='approved' AND received_at IS NULL AND id IN ${IN}`, now, now, JSON.stringify(ids));
  await audit(env, me, 'evidence received', `${ids.length} file(s)`);
  return { ok: true };
}
/** POE by student: the classes taught this term, and for one class its students and units. */
async function poeClass(env, b) {
  const loading = await all(env, `SELECT class_code, unit_code, unit_name FROM loading WHERE term_id=${ACTIVE_TERM}`);
  const classes = [...new Set(loading.flatMap((u) => classParts(u.class_code)))].sort();
  const cls = String(b.classCode || '');
  if (!cls) return { ok: true, classes };
  const seen = new Set(), units = [];
  for (const u of unitsForClass(loading, cls)) if (!seen.has(u.unit_code)) { seen.add(u.unit_code); units.push({ code: u.unit_code, name: u.unit_name || u.unit_code }); }
  const students = (await all(env, `SELECT adm_no, name FROM trainees WHERE class_code=? AND COALESCE(status,'') NOT IN ${GONE} ORDER BY name`, cls))
    .map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no }));
  return { ok: true, classes, classCode: cls, units, students };
}
async function driveStatus(env) {
  const r = await getMeta(env, 'drive_report');
  return { ok: true, secret: !!env.BRIDGE_SECRET, report: r ? JSON.parse(r) : null };
}

/* Exported for the local test harness (worker/dev.js); not used by Cloudflare. */
export const internals = { all, one, run, many, finalMarks, acceptedMap, setMeta, getMeta, teachingWeeks, activeTerm, weekOf,
  resetCaches() { schemaReady = false; secretCache = null; keys.clear(); } };
