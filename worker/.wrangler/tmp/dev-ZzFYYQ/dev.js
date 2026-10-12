var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var VERSION = "6.2.0";
var SCHEMA_VERSION = "8";
var WINDOW_SECONDS = 20;
var CODE_LENGTH = 10;
var TERM_WEEKS = 12;
var STATUS_CODE = { Present: "P", Absent: "A", Late: "L", Excused: "E" };
var ROLES = ["TRAINER", "HOD", "MIS"];
var GONE = "('withdrawn','rejected')";
var SCHEMA = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
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
CREATE INDEX IF NOT EXISTS push_adm ON push_subs (adm_no);`;
var MIGRATIONS = [
  "ALTER TABLE terms ADD COLUMN cat_weeks TEXT",
  "ALTER TABLE sessions ADD COLUMN kind TEXT",
  "ALTER TABLE sessions ADD COLUMN slots INTEGER",
  "ALTER TABLE staff ADD COLUMN drive_folder TEXT",
  "ALTER TABLE trainees ADD COLUMN reg_code TEXT",
  "ALTER TABLE terms ADD COLUMN series TEXT",
  "ALTER TABLE evidence ADD COLUMN seen_at TEXT",
  "ALTER TABLE classes ADD COLUMN status TEXT",
  "ALTER TABLE classes ADD COLUMN archived_at TEXT",
  "ALTER TABLE classes ADD COLUMN archived_by TEXT",
  "ALTER TABLE terms ADD COLUMN lesson_hours REAL"
];
var MARK_CELLS = ["cat1", "cat2", "cat3", "prac1", "prac2", "prac3"];
var SAME_ROW = "x.class_code=m.class_code AND x.unit_code=m.unit_code AND x.adm_no=m.adm_no";
var DATA_MIGRATIONS = [
  // Marks used to be kept per term; a unit now has one marksheet for its whole life. Each cell keeps the
  // newest value it had in any term, and remembers the term it was entered in (for the end-of-term lock).
  `INSERT OR IGNORE INTO unit_marks (class_code, unit_code, adm_no, ${MARK_CELLS.join(", ")}, meta, updated_at, updated_by, synced_at)
   SELECT m.class_code, m.unit_code, m.adm_no,
   ${MARK_CELLS.map((c) => `(SELECT x.${c} FROM marks x WHERE ${SAME_ROW} AND x.${c} IS NOT NULL ORDER BY x.updated_at DESC LIMIT 1)`).join(", ")},
   json_object(${MARK_CELLS.map((c) => `'${c}', json((SELECT json_object('term', x.term_id, 'by', x.updated_by, 'at', x.updated_at) FROM marks x WHERE ${SAME_ROW} AND x.${c} IS NOT NULL ORDER BY x.updated_at DESC LIMIT 1))`).join(", ")}),
   MAX(m.updated_at), (SELECT x.updated_by FROM marks x WHERE ${SAME_ROW} ORDER BY x.updated_at DESC LIMIT 1), MAX(m.synced_at)
   FROM marks m GROUP BY m.class_code, m.unit_code, m.adm_no`
];
var nowIso = /* @__PURE__ */ __name(() => (/* @__PURE__ */ new Date()).toISOString(), "nowIso");
var todayIso = /* @__PURE__ */ __name(() => new Date(Date.now() + 3 * 36e5).toISOString().slice(0, 10), "todayIso");
var lower = /* @__PURE__ */ __name((s) => String(s ?? "").trim().toLowerCase(), "lower");
var Fail = class extends Error {
  static {
    __name(this, "Fail");
  }
  constructor(message, extra) {
    super(message);
    Object.assign(this, extra || {});
  }
};
var fail = /* @__PURE__ */ __name((message, extra) => {
  throw new Fail(message, extra);
}, "fail");
var rolesList = /* @__PURE__ */ __name((roles) => {
  const have = String(roles || "").toUpperCase().split(/[\s,;]+/);
  return ROLES.filter((r) => have.includes(r));
}, "rolesList");
var hasRole = /* @__PURE__ */ __name((roles, role) => rolesList(roles).includes(role), "hasRole");
var levelOf = /* @__PURE__ */ __name((code) => {
  const m = /L(\d)/i.exec(String(code));
  return m ? m[1] : "";
}, "levelOf");
var classFromSession = /* @__PURE__ */ __name((id) => String(id).split(":")[2] || "", "classFromSession");
function classParts(code) {
  const parts = String(code).split(/\s*[,/]\s*/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [code];
  const prefix = (parts[0].match(/^([A-Z]+)\s/) || [])[1];
  return [code, ...parts.map((x) => prefix && !/\s/.test(x) ? `${prefix} ${x}` : x)];
}
__name(classParts, "classParts");
var active = /* @__PURE__ */ __name((t) => t && !["withdrawn", "rejected"].includes(String(t.status || "active").toLowerCase()), "active");
var JSONH = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
var reply = /* @__PURE__ */ __name((obj) => new Response(JSON.stringify(obj), { headers: JSONH }), "reply");
var q = /* @__PURE__ */ __name((env, sql, ...p) => env.DB.prepare(sql).bind(...p), "q");
var all = /* @__PURE__ */ __name(async (env, sql, ...p) => (await q(env, sql, ...p).all()).results || [], "all");
var one = /* @__PURE__ */ __name((env, sql, ...p) => q(env, sql, ...p).first(), "one");
var run = /* @__PURE__ */ __name((env, sql, ...p) => q(env, sql, ...p).run(), "run");
var IN = "(SELECT value FROM json_each(?))";
async function many(env, ...items) {
  items = items.filter(Boolean);
  if (!items.length) return [];
  const res = await env.DB.batch(items.map(([sql, ...p]) => env.DB.prepare(sql).bind(...p)));
  return res.map((r) => r.results || []);
}
__name(many, "many");
var ACTIVE_TERM = "(SELECT id FROM terms WHERE status='active' ORDER BY updated_at DESC LIMIT 1)";
function upsertStmts(table, cols, rows, key, update = cols.filter((c) => !(key || []).includes(c))) {
  const conflict = key ? ` ON CONFLICT(${key.join(",")}) DO ${update.length ? "UPDATE SET " + update.map((c) => `${c}=excluded.${c}`).join(",") : "NOTHING"}` : "";
  const sql = `INSERT INTO ${table} (${cols.join(",")}) SELECT ${cols.map((_, j) => `json_extract(value,'$[${j}]')`).join(",")} FROM json_each(?) WHERE true${conflict}`;
  const out = [];
  let part = [], size = 2;
  const flush = /* @__PURE__ */ __name(() => {
    if (part.length) out.push([sql, "[" + part.join(",") + "]"]);
    part = [];
    size = 2;
  }, "flush");
  for (const r of rows) {
    const item = JSON.stringify(cols.map((c) => r[c] === void 0 ? null : r[c]));
    if (size + item.length > 9e5) flush();
    part.push(item);
    size += item.length + 1;
  }
  flush();
  return out;
}
__name(upsertStmts, "upsertStmts");
var upsertMany = /* @__PURE__ */ __name((env, ...a) => many(env, ...upsertStmts(...a)), "upsertMany");
var schemaReady = false;
async function ready(env) {
  if (schemaReady) return;
  try {
    const r = await one(env, "SELECT value FROM meta WHERE key='schema'");
    if (r && r.value === SCHEMA_VERSION) {
      schemaReady = true;
      return;
    }
  } catch {
  }
  await env.DB.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    try {
      await env.DB.exec(sql);
    } catch {
    }
  }
  for (const sql of DATA_MIGRATIONS) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e) {
      console.error("data migration", e);
    }
  }
  await setMeta(env, "schema", SCHEMA_VERSION);
  schemaReady = true;
}
__name(ready, "ready");
var getMeta = /* @__PURE__ */ __name(async (env, key) => (await one(env, "SELECT value FROM meta WHERE key=?", key))?.value ?? null, "getMeta");
var metaStmt = /* @__PURE__ */ __name((key, value) => ["INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, String(value)], "metaStmt");
var setMeta = /* @__PURE__ */ __name((env, key, value) => many(env, metaStmt(key, value)), "setMeta");
var changedStmt = /* @__PURE__ */ __name(() => metaStmt("last_change", nowIso()), "changedStmt");
var bumpRoster = /* @__PURE__ */ __name((env) => setMeta(env, "roster_v", nowIso() + "#" + Math.random().toString(36).slice(2, 6)), "bumpRoster");
var catWeeksOf = /* @__PURE__ */ __name((v) => [...new Set(String(v || "").split(/[\s,;]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= TERM_WEEKS))].sort((a, b) => a - b), "catWeeksOf");
var termOut = /* @__PURE__ */ __name((r) => r ? {
  id: r.id,
  name: r.name,
  duration: r.duration,
  startDate: r.start_date,
  weeks: TERM_WEEKS,
  breaks: String(r.breaks || "").split(/[\s,;]+/).filter(Boolean),
  catWeeks: catWeeksOf(r.cat_weeks),
  series: r.series || "",
  lessonHours: Number(r.lesson_hours) || null
} : null, "termOut");
async function audit(env, me, action, details) {
  await run(env, "INSERT INTO audit (at,staff_code,name,action,details) VALUES (?,?,?,?,?)", nowIso(), me.code, me.name, action, String(details || "").slice(0, 2e3));
}
__name(audit, "audit");
var enc = new TextEncoder();
var hex = /* @__PURE__ */ __name((buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""), "hex");
var sha256Hex = /* @__PURE__ */ __name(async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s))), "sha256Hex");
var keys = /* @__PURE__ */ new Map();
async function hmacHex(msg, secret) {
  let k = keys.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keys.set(secret, k);
  }
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
__name(hmacHex, "hmacHex");
var randomPin = /* @__PURE__ */ __name(() => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b % 10).join(""), "randomPin");
var secretCache = null;
async function authSecret(env) {
  if (secretCache) return secretCache;
  const [, rows] = await many(
    env,
    ["INSERT INTO meta (key,value) VALUES ('auth_secret',?) ON CONFLICT(key) DO NOTHING", crypto.randomUUID() + crypto.randomUUID()],
    ["SELECT value FROM meta WHERE key='auth_secret'"]
  );
  return secretCache = rows[0].value;
}
__name(authSecret, "authSecret");
var worker_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" } });
    try {
      if (!env.DB) fail("The database is not connected: add a D1 binding called DB to this Worker (Settings \u2192 Bindings).");
      await ready(env);
      if (request.method === "GET") {
        const p = Object.fromEntries(new URL(request.url).searchParams);
        if (p.action === "classes") return reply(await publicClasses(env));
        if (p.action === "classlist") return reply(await classList(env, p.class));
        if (p.action === "units") return reply(await classUnits(env, p.class));
        if (p.action === "ping") return reply({ ok: true, version: VERSION, server: "cloudflare", time: nowIso(), push: !!env.VAPID_PRIVATE_KEY });
        return reply({ ok: false, error: "Unknown action" });
      }
      const b = JSON.parse(await request.text() || "{}");
      if (b.action === "checkin") return reply(await receiveCheckins(env, b.checkins || []));
      if (b.action === "register") return reply(await registerDevice(env, b));
      if (b.action === "login") return reply(await login(env, b));
      const nudge = /* @__PURE__ */ __name(() => {
        if (ctx?.waitUntil && NUDGE_ACTIONS.has(b.action)) ctx.waitUntil(nudgeDrive(env).catch((e) => console.error("nudge", e)));
      }, "nudge");
      if (STUDENT_ACTIONS[b.action]) {
        const out2 = await STUDENT_ACTIONS[b.action](env, b, ctx);
        nudge();
        return reply(out2);
      }
      if (BRIDGE_ACTIONS[b.action]) return reply(await BRIDGE_ACTIONS[b.action](env, b));
      const h = ACTIONS[b.action];
      const [me, pre] = await auth(env, b.auth, h && h.pre ? h.pre(b) : []);
      if (!h) return reply({ ok: false, error: "Unknown action" });
      if (h.role && !me.roles.some((r) => h.role.includes(r))) fail(`This needs the ${h.role.join(" or ")} role. Ask the MIS Officer.`);
      if (me.mustChange && b.action !== "setPin") fail("Choose a new PIN first", { mustChange: true });
      const out = await h.fn(env, b, me, pre, ctx);
      nudge();
      if (b.action === "roster" && ctx?.waitUntil) ctx.waitUntil(foldOldCheckins(env).catch((e) => console.error("fold", e)));
      return reply(out);
    } catch (err) {
      const out = { ok: false, error: String(err && err.message || err) };
      if (err && err.authError) out.authError = true;
      if (err && err.mustChange) out.mustChange = true;
      if (!(err instanceof Fail)) console.error(err);
      return reply(out);
    }
  }
};
var ACTIONS = {
  setPin: { fn: /* @__PURE__ */ __name((env, b, me) => setPin(env, b, me), "fn") },
  me: { fn: /* @__PURE__ */ __name(async (env, b, me) => ({ ok: true, staff: me }), "fn") },
  roster: { fn: /* @__PURE__ */ __name((env, b, me, pre) => readRoster(env, b, me, pre), "fn") },
  pulse: { fn: /* @__PURE__ */ __name(async (env, b, me, pre) => ({ ok: true, last: pre.meta.last_change || "" }), "fn") },
  push: { role: ["TRAINER", "HOD"], pre: /* @__PURE__ */ __name((b) => pushPre(b.sessions || []), "pre"), fn: /* @__PURE__ */ __name((env, b, me, pre) => pushSessions(env, b.sessions || [], me, pre), "fn") },
  mySessions: { role: ["TRAINER", "HOD"], fn: /* @__PURE__ */ __name((env, b, me) => mySessions(env, b, me), "fn") },
  checkins: { role: ["TRAINER", "HOD"], pre: /* @__PURE__ */ __name((b) => [checkinsQuery(b.sessionIds || [], b.since || "")], "pre"), fn: /* @__PURE__ */ __name((env, b, me, pre) => acceptedCheckins(b.sessionIds || [], pre.rows[0]), "fn") },
  addStudents: { role: ["TRAINER", "HOD"], fn: /* @__PURE__ */ __name((env, b, me) => addStudents(env, b.students || [], me), "fn") },
  mySettings: { fn: /* @__PURE__ */ __name((env, b, me) => saveMySettings(env, b, me), "fn") },
  report: { pre: /* @__PURE__ */ __name((b) => reportPre(b), "pre"), fn: /* @__PURE__ */ __name((env, b, me, pre) => reportData(env, b, me, pre), "fn") },
  submitSignoff: { role: ["TRAINER", "HOD"], fn: /* @__PURE__ */ __name((env, b, me) => submitSignoff(env, b, me), "fn") },
  signoffs: { fn: /* @__PURE__ */ __name((env, b, me) => listSignoffs(env, b, me), "fn") },
  decideSignoff: { role: ["HOD"], fn: /* @__PURE__ */ __name((env, b, me) => decideSignoff(env, b, me), "fn") },
  overview: { role: ["HOD", "MIS"], pre: /* @__PURE__ */ __name((b) => overviewPre(b), "pre"), fn: /* @__PURE__ */ __name((env, b, me, pre) => overview(pre), "fn") },
  termUnits: { fn: /* @__PURE__ */ __name((env, b, me) => termUnits(env, b, me), "fn") },
  unlock: { role: ["HOD", "MIS"], fn: /* @__PURE__ */ __name((env, b, me) => setUnlock(env, b, me, true), "fn") },
  relock: { role: ["HOD", "MIS"], fn: /* @__PURE__ */ __name((env, b, me) => setUnlock(env, b, me, false), "fn") },
  archiveClasses: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => archiveClasses(env, b, me), "fn") },
  classExport: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => classExport(env, b, me), "fn") },
  deleteClasses: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => deleteClasses(env, b, me), "fn") },
  saveTerm: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => saveTerm(env, b, me), "fn") },
  uploadLoading: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => uploadLoading(env, b, me), "fn") },
  importClassList: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => importClassList(env, b, me), "fn") },
  students: { role: ["MIS", "HOD"], fn: /* @__PURE__ */ __name((env, b) => studentsOf(env, b.misClass || "", b.classCode || ""), "fn") },
  updateStudent: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => updateStudent(env, b, me), "fn") },
  requests: { role: ["MIS", "HOD"], fn: /* @__PURE__ */ __name((env) => listRequests(env), "fn") },
  decideRequest: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => decideRequest(env, b, me), "fn") },
  staff: { role: ["MIS"], fn: /* @__PURE__ */ __name((env) => listStaff(env), "fn") },
  updateStaff: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => updateStaff(env, b, me), "fn") },
  poeList: { fn: /* @__PURE__ */ __name((env, b, me) => poeList(env, b, me), "fn") },
  poeView: { fn: /* @__PURE__ */ __name((env, b, me) => poeView(env, b, me), "fn") },
  poeDecide: { role: ["TRAINER", "HOD"], fn: /* @__PURE__ */ __name((env, b, me, pre, ctx) => poeDecide(env, b, me, ctx), "fn") },
  poeReceive: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => poeReceive(env, b, me), "fn") },
  driveStatus: { role: ["MIS", "HOD"], fn: /* @__PURE__ */ __name((env) => driveStatus(env), "fn") },
  poeClass: { role: ["MIS", "HOD"], fn: /* @__PURE__ */ __name((env, b) => poeClass(env, b), "fn") },
  marksPull: { fn: /* @__PURE__ */ __name((env, b, me) => marksPull(env, b, me), "fn") },
  marksPush: { role: ["TRAINER", "HOD"], fn: /* @__PURE__ */ __name((env, b, me) => marksPush(env, b, me), "fn") },
  importRegCodes: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => importRegCodes(env, b, me), "fn") },
  setDefaultPin: { role: ["MIS"], fn: /* @__PURE__ */ __name((env, b, me) => setDefaultPin(env, b, me), "fn") },
  absences: { role: ["HOD", "MIS"], fn: /* @__PURE__ */ __name((env, b, me) => absences(env, b, me), "fn") },
  setAbsenceLimit: { role: ["HOD", "MIS"], fn: /* @__PURE__ */ __name((env, b, me) => setAbsenceLimit(env, b, me), "fn") }
};
var NUDGE_ACTIONS = /* @__PURE__ */ new Set([
  "push",
  "marksPush",
  "poeDone",
  "poeDecide",
  "poeReceive",
  "submitSignoff",
  "decideSignoff",
  "saveTerm",
  "uploadLoading",
  "importClassList",
  "importRegCodes",
  "addStudents",
  "decideRequest",
  "updateStudent",
  "updateStaff",
  "mySettings",
  "archiveClasses",
  "deleteClasses",
  "unlock",
  "relock"
]);
function staffPublic(r) {
  return {
    code: r.code,
    name: r.name,
    roles: rolesList(r.roles),
    responsibility: r.responsibility || "",
    active: !!r.active,
    hasPin: !!r.pin_hash,
    mustChange: !!r.must_change,
    latePct: r.late_pct ?? 50,
    excusedPct: r.excused_pct ?? 100,
    driveFolder: r.drive_folder || ""
  };
}
__name(staffPublic, "staffPublic");
var getStaff = /* @__PURE__ */ __name((env, code) => one(env, "SELECT * FROM staff WHERE code=?", String(code || "").trim()), "getStaff");
async function setStaffPin(env, code, pin, mustChange, create) {
  let row = await getStaff(env, code);
  if (!row) {
    if (!create) fail("No staff member with code " + code);
    row = { code: String(code).trim().toUpperCase(), name: create.name || code, roles: create.roles || "TRAINER", responsibility: create.resp || "", pin_version: 0, late_pct: null, excused_pct: null };
  }
  let roles = row.roles;
  if (create?.roles && !hasRole(roles, create.roles)) roles = rolesList(roles + "," + create.roles).join(", ");
  const salt = crypto.randomUUID().slice(0, 12);
  const next = { ...row, roles, active: 1, pin_salt: salt, pin_hash: await sha256Hex(salt + "|" + pin), pin_version: (Number(row.pin_version) || 0) + 1, must_change: mustChange ? 1 : 0, updated_at: nowIso() };
  await run(
    env,
    `INSERT INTO staff (code,name,roles,responsibility,active,pin_hash,pin_salt,pin_version,must_change,late_pct,excused_pct,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, roles=excluded.roles, active=1, pin_hash=excluded.pin_hash, pin_salt=excluded.pin_salt, pin_version=excluded.pin_version, must_change=excluded.must_change, updated_at=excluded.updated_at`,
    next.code,
    next.name,
    next.roles,
    next.responsibility || "",
    1,
    next.pin_hash,
    next.pin_salt,
    next.pin_version,
    next.must_change,
    next.late_pct ?? null,
    next.excused_pct ?? null,
    next.updated_at
  );
  return next;
}
__name(setStaffPin, "setStaffPin");
async function makeToken(env, row) {
  const payload = `${row.code}|${row.pin_version}|${Date.now()}`;
  return payload + "|" + (await hmacHex(payload, await authSecret(env))).slice(0, 32);
}
__name(makeToken, "makeToken");
async function login(env, b) {
  const code = String(b.staff || "").trim(), pin = String(b.pin || "").trim();
  if (!code || !pin) fail("Enter your staff code and PIN");
  const [lfRows, staffRows, misRows, secretRows, defRows] = await many(
    env,
    ["SELECT * FROM login_fails WHERE code=?", code],
    ["SELECT * FROM staff WHERE code=?", code],
    ["SELECT 1 AS x FROM staff WHERE active=1 AND upper(roles) LIKE '%MIS%' LIMIT 1"],
    ["SELECT value FROM meta WHERE key='auth_secret'"],
    ["SELECT value FROM meta WHERE key='default_pin'"]
  );
  if (!secretCache && secretRows[0]) secretCache = secretRows[0].value;
  const lf = lfRows[0];
  if (lf && lf.fails >= 5 && lf.until > nowIso()) fail("Too many wrong PINs. Try again in 15 minutes.");
  let row = staffRows[0];
  if (!row && lower(code) === "mis" && env.ADMIN_PIN && !misRows.length) {
    row = await setStaffPin(env, "MIS", String(env.ADMIN_PIN), true, { name: "MIS Officer", roles: "MIS" });
  }
  if (!row && lower(code) === "mis" && !env.ADMIN_PIN) fail("First sign-in: add the ADMIN_PIN secret to the Worker (Settings \u2192 Variables and Secrets), then try again.");
  let firstTime = false;
  if (row && row.active && !row.pin_hash && defRows[0]) {
    const d = JSON.parse(defRows[0].value || "{}");
    firstTime = !!d.hash && await sha256Hex(d.salt + "|" + pin) === d.hash;
  }
  if (!firstTime && (!row || !row.active || !row.pin_hash || await sha256Hex(row.pin_salt + "|" + pin) !== row.pin_hash)) {
    const fails = lf && lf.until > nowIso() ? lf.fails + 1 : 1;
    await run(
      env,
      "INSERT INTO login_fails (code,fails,until) VALUES (?,?,?) ON CONFLICT(code) DO UPDATE SET fails=excluded.fails, until=excluded.until",
      code,
      fails,
      new Date(Date.now() + 15 * 6e4).toISOString()
    );
    fail(row && !row.pin_hash && !defRows[0] ? "No PIN has been set for this staff code yet. Ask the MIS Officer." : "Wrong staff code or PIN");
  }
  if (lf) await run(env, "DELETE FROM login_fails WHERE code=?", code);
  if (firstTime && !row.must_change) {
    await run(env, "UPDATE staff SET must_change=1 WHERE code=?", row.code);
    row.must_change = 1;
  }
  return { ok: true, token: await makeToken(env, row), staff: staffPublic(row), mustChange: firstTime || !!row.must_change };
}
__name(login, "login");
async function auth(env, token, extra = []) {
  const parts = String(token || "").split("|");
  if (parts.length !== 4) fail("Sign in to continue", { authError: true });
  const wanted = secretCache ? ["last_change", "roster_v"] : ["last_change", "roster_v", "auth_secret"];
  const [staffRows, metaRows, ...rows] = await many(env, ["SELECT * FROM staff WHERE code=?", parts[0]], [`SELECT key, value FROM meta WHERE key IN (${wanted.map(() => "?").join(",")})`, ...wanted], ...extra);
  const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
  if (!secretCache && meta.auth_secret) secretCache = meta.auth_secret;
  const payload = parts.slice(0, 3).join("|");
  if ((await hmacHex(payload, await authSecret(env))).slice(0, 32) !== parts[3]) fail("Sign in again", { authError: true });
  const row = staffRows[0];
  if (!row || !row.active || String(row.pin_version) !== String(Number(parts[1]))) {
    fail("Your sign-in has ended (PIN changed or account switched off). Sign in again.", { authError: true });
  }
  const p = staffPublic(row);
  return [{ code: p.code, name: p.name, roles: p.roles, mustChange: p.mustChange, latePct: p.latePct, excusedPct: p.excusedPct }, { meta, rows }];
}
__name(auth, "auth");
async function setPin(env, b, me) {
  const pin = String(b.newPin || "").trim();
  if (!/^\d{4,8}$/.test(pin)) fail("Use 4 to 8 digits for your PIN");
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) fail("Choose a PIN that is harder to guess");
  const row = await setStaffPin(env, me.code, pin, false);
  return { ok: true, token: await makeToken(env, row), staff: staffPublic(row) };
}
__name(setPin, "setPin");
async function saveMySettings(env, b, me) {
  const clamp = /* @__PURE__ */ __name((v) => Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null, "clamp");
  await run(env, "UPDATE staff SET late_pct=COALESCE(?,late_pct), excused_pct=COALESCE(?,excused_pct), updated_at=? WHERE code=?", clamp(b.latePct), clamp(b.excusedPct), nowIso(), me.code);
  await bumpRoster(env);
  return { ok: true, staff: staffPublic(await getStaff(env, me.code)) };
}
__name(saveMySettings, "saveMySettings");
var TERM_SQL = "SELECT * FROM terms WHERE status='active' ORDER BY updated_at DESC LIMIT 1";
var activeTerm = /* @__PURE__ */ __name(async (env) => termOut(await one(env, TERM_SQL)), "activeTerm");
function mondayOf(iso) {
  const d = /* @__PURE__ */ new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
__name(mondayOf, "mondayOf");
function teachingWeeks(term) {
  if (!term || !term.startDate) return [];
  const breaks = new Set(term.breaks.map(mondayOf));
  const out = [];
  const d = /* @__PURE__ */ new Date(mondayOf(term.startDate) + "T00:00:00Z");
  for (let guard = 0; out.length < TERM_WEEKS && guard < 60; guard++) {
    const iso = d.toISOString().slice(0, 10);
    if (!breaks.has(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}
__name(teachingWeeks, "teachingWeeks");
var weekOf = /* @__PURE__ */ __name((term, date) => {
  const i = teachingWeeks(term).indexOf(mondayOf(date));
  return i === -1 ? null : i + 1;
}, "weekOf");
async function saveTerm(env, b, me) {
  if (!b.name || !/^\d{4}-\d{2}-\d{2}$/.test(b.startDate || "")) fail("Give the term a name and a start date");
  const id = String(b.termId || "").trim() || "T" + b.startDate;
  const breaks = (b.breaks || []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)).map(mondayOf);
  await run(env, "UPDATE terms SET status='closed' WHERE status='active' AND id<>?", id);
  const cats = catWeeksOf((b.catWeeks || []).join(","));
  const hours = Number(b.lessonHours) > 0 && Number(b.lessonHours) <= 8 ? Math.round(Number(b.lessonHours) * 100) / 100 : null;
  await run(
    env,
    `INSERT INTO terms (id,name,duration,start_date,weeks,breaks,status,updated_at,cat_weeks,series,lesson_hours) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, duration=excluded.duration, start_date=excluded.start_date, breaks=excluded.breaks, status=excluded.status, updated_at=excluded.updated_at, cat_weeks=excluded.cat_weeks, series=excluded.series, lesson_hours=excluded.lesson_hours`,
    id,
    b.name,
    b.duration || "",
    b.startDate,
    TERM_WEEKS,
    breaks.join(", "),
    b.close ? "closed" : "active",
    nowIso(),
    cats.join(", "),
    String(b.series || "").trim().slice(0, 60),
    hours
  );
  await audit(env, me, b.close ? "close term" : "save term", `${id} ${b.name} from ${b.startDate}${breaks.length ? " breaks " + breaks.join(" ") : ""}${cats.length ? " CAT weeks " + cats.join(" ") : ""}`);
  await bumpRoster(env);
  const term = await activeTerm(env);
  return { ok: true, term, weeks: teachingWeeks(term) };
}
__name(saveTerm, "saveTerm");
async function uploadLoading(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail("Set up the term first (Manage > Term)");
  const now = nowIso();
  const seen = /* @__PURE__ */ new Map();
  for (const r of b.rows || []) {
    if (!r || !r.classCode || !r.unitCode) continue;
    const k = r.classCode + "|" + r.unitCode;
    if (!seen.has(k)) seen.set(k, r);
  }
  if (!seen.size) fail("No loading rows found in that file");
  const rows = [...seen.values()];
  await run(env, "DELETE FROM loading WHERE term_id=?", term.id);
  await upsertMany(
    env,
    "loading",
    ["term_id", "class_code", "unit_code", "unit_name", "trainer_code", "trainer_name", "lessons_per_week", "hours_per_week", "population", "updated_at"],
    rows.map((r) => ({
      term_id: term.id,
      class_code: r.classCode,
      unit_code: r.unitCode,
      unit_name: r.unitName || r.unitCode,
      trainer_code: r.trainerCode || "",
      trainer_name: r.trainerName || "",
      lessons_per_week: Number(r.lessonsPerWeek) || 2,
      hours_per_week: Number(r.hoursPerWeek) || 3,
      population: Number(r.population) || null,
      updated_at: now
    })),
    ["term_id", "class_code", "unit_code"]
  );
  const classes = /* @__PURE__ */ new Map();
  for (const r of rows) if (!classes.has(r.classCode)) classes.set(r.classCode, { code: r.classCode, name: r.classCode, level: levelOf(r.classCode), mis_class: null, population: Number(r.population) || null });
  await upsertMany(env, "classes", ["code", "name", "level", "mis_class", "population"], [...classes.values()], ["code"], []);
  const info = /* @__PURE__ */ new Map();
  for (const r of rows) if (r.trainerCode) info.set(lower(r.trainerCode), { code: r.trainerCode, name: r.trainerName });
  const extra = /* @__PURE__ */ new Map();
  for (const t of b.trainers || []) if (t.code) {
    extra.set(lower(t.code), t);
    if (!info.has(lower(t.code))) info.set(lower(t.code), { code: t.code, name: t.name });
  }
  const existing = new Map((await all(env, `SELECT * FROM staff WHERE code IN ${IN}`, JSON.stringify([...info.values()].map((x) => x.code)))).map((r) => [lower(r.code), r]));
  let added = 0;
  const staffRows = [...info.entries()].map(([k, x]) => {
    const e = extra.get(k) || {}, old = existing.get(k);
    const isHod = /^HOD$/i.test(String(e.responsibility || "").trim());
    if (!old) added++;
    return {
      code: old ? old.code : String(x.code).trim().toUpperCase(),
      name: e.name || x.name || old?.name || x.code,
      roles: rolesList((old ? old.roles + "," : "") + "TRAINER" + (isHod ? ",HOD" : "")).join(", "),
      responsibility: e.responsibility || old?.responsibility || "",
      active: old ? old.active : 1,
      must_change: old ? old.must_change : 1,
      pin_version: old ? old.pin_version : 0,
      updated_at: now
    };
  });
  await upsertMany(env, "staff", ["code", "name", "roles", "responsibility", "active", "must_change", "pin_version", "updated_at"], staffRows, ["code"], ["name", "roles", "responsibility", "updated_at"]);
  await audit(env, me, "upload loading", `${term.id}: ${rows.length} class-units, ${info.size} trainers`);
  await bumpRoster(env);
  return { ok: true, term: term.id, rows: rows.length, trainers: info.size, newStaff: added, classes: classes.size };
}
__name(uploadLoading, "uploadLoading");
async function readRoster(env, b, me, pre) {
  const version = pre.meta.roster_v || "none";
  if (b.version && b.version === version) return { ok: true, unchanged: true, version, me };
  const [termRows, loading, unitRows, classRows, reqs, staffRows] = await many(
    env,
    [TERM_SQL],
    [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`],
    ["SELECT * FROM units"],
    ["SELECT * FROM classes"],
    ["SELECT adm_no, name, class_code, requested_name, reason, status, merged_into FROM requests WHERE status IN ('pending','rejected','merged')"],
    ["SELECT code, name, late_pct, excused_pct FROM staff"]
  );
  const [termList, unlockRows] = await many(env, ["SELECT * FROM terms ORDER BY start_date DESC"], [`SELECT term_id, class_code, unit_code, until FROM unlocks WHERE ${UNLOCK_LIVE}`]);
  const term = termOut(termRows[0]);
  const gone = new Set(classRows.filter((r) => r.status === "archived").map((r) => r.code));
  const keep = /* @__PURE__ */ __name((code) => !classParts(code).some((c) => gone.has(c)) && !gone.has(code), "keep");
  loading.splice(0, loading.length, ...loading.filter((r) => keep(r.class_code)));
  const units = loading.length ? loading.map((r) => ({
    classCode: r.class_code,
    code: r.unit_code,
    name: r.unit_name || r.unit_code,
    trainerCode: r.trainer_code,
    trainerName: r.trainer_name,
    lessonsPerWeek: Number(r.lessons_per_week) || 2,
    hoursPerWeek: Number(r.hours_per_week) || 3
  })) : unitRows.filter((r) => keep(r.class_code)).map((r) => ({ classCode: r.class_code, code: r.code, name: r.name || r.code, lessonsPerWeek: 2, hoursPerWeek: 3 }));
  const mine = /* @__PURE__ */ new Set();
  if (!(me.roles.includes("HOD") || me.roles.includes("MIS"))) {
    for (const u of loading) if (lower(u.trainer_code) === lower(me.code)) classParts(u.class_code).forEach((c) => mine.add(c));
  }
  const everyone = mine.size ? await all(env, `SELECT adm_no, name, class_code, status, reg_code FROM trainees WHERE class_code IN ${IN}`, JSON.stringify([...mine])) : await all(env, "SELECT adm_no, name, class_code, status, reg_code FROM trainees");
  const trainees = everyone.filter((r) => !gone.has(r.class_code));
  const staff = {};
  for (const r of staffRows) staff[r.code] = { name: r.name, latePct: r.late_pct ?? 50, excusedPct: r.excused_pct ?? 100 };
  return {
    ok: true,
    version,
    me,
    term,
    weeks: teachingWeeks(term),
    classes: classRows.filter((r) => !gone.has(r.code)).map((r) => ({ code: r.code, name: r.name || r.code, level: r.level || levelOf(r.code), misClass: r.mis_class || "" })),
    units,
    terms: termList.map((r) => ({ id: r.id, name: r.name, duration: r.duration || "", startDate: r.start_date || "", status: r.status || "" })),
    unlocks: unlockRows.map((r) => ({ termId: r.term_id, classCode: r.class_code, unitCode: r.unit_code, until: r.until || "" })),
    archived: me.roles.includes("MIS") ? classRows.filter((r) => gone.has(r.code)).map((r) => ({
      code: r.code,
      misClass: r.mis_class || "",
      archivedAt: r.archived_at || "",
      archivedBy: r.archived_by || "",
      students: everyone.filter((x) => x.class_code === r.code && active(x)).length
    })) : [],
    trainees: trainees.map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no, classCode: r.class_code, active: active(r), regCode: r.reg_code || "" })),
    pending: reqs.filter((r) => r.status === "pending").map((r) => ({ admNo: r.adm_no, name: r.name, classCode: r.class_code, requestedBy: r.requested_name, reason: r.reason })),
    rejected: reqs.filter((r) => r.status === "rejected").map((r) => ({ admNo: r.adm_no, classCode: r.class_code })),
    aliases: reqs.filter((r) => r.status === "merged" && r.merged_into).map((r) => ({ from: r.adm_no, to: r.merged_into, classCode: r.class_code })),
    staff
  };
}
__name(readRoster, "readRoster");
var GROUP = "COALESCE(NULLIF(t.mis_class,''), NULLIF(c.mis_class,''), t.class_code)";
async function publicClasses(env) {
  const [cache, ver] = await many(env, ["SELECT value FROM meta WHERE key='pub_classes'"], ["SELECT value FROM meta WHERE key='roster_v'"]);
  const v = ver[0]?.value || "none";
  if (cache[0]) {
    const c = JSON.parse(cache[0].value);
    if (c.v === v) return { ok: true, classes: c.classes };
  }
  const rows = await all(env, `SELECT DISTINCT ${GROUP} AS g FROM trainees t LEFT JOIN classes c ON c.code=t.class_code WHERE t.status NOT IN ${GONE} ORDER BY g`);
  const classes = rows.map((r) => ({ code: r.g, name: r.g }));
  await setMeta(env, "pub_classes", JSON.stringify({ v, classes }));
  return { ok: true, classes };
}
__name(publicClasses, "publicClasses");
async function classList(env, group) {
  if (!group) fail("Choose a class");
  const rows = await all(env, `SELECT t.adm_no, t.name, t.class_code, t.status, t.mis_class, c.mis_class AS cm FROM trainees t LEFT JOIN classes c ON c.code=t.class_code
    WHERE t.mis_class=?1 OR t.class_code=?1 OR t.class_code IN (SELECT code FROM classes WHERE mis_class=?1)`, group);
  const list = rows.filter((r) => active(r) && (r.mis_class || r.cm || r.class_code) === group).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { ok: true, classCode: group, trainees: list.map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no, classCode: r.class_code })) };
}
__name(classList, "classList");
async function registerDevice(env, b) {
  const adm = String(b.admNo || "").trim();
  const [tRows, devRows, admRows] = await many(
    env,
    ["SELECT t.*, c.name AS class_name FROM trainees t LEFT JOIN classes c ON c.code=t.class_code WHERE t.adm_no=?", adm],
    ["SELECT d.*, t.name AS tname FROM devices d LEFT JOIN trainees t ON t.adm_no=d.adm_no WHERE d.device_id=?", String(b.deviceId || "")],
    ["SELECT * FROM devices WHERE adm_no=?", adm]
  );
  const t = tRows[0], dev = devRows[0], byAdm = admRows[0];
  if (!t || !active(t)) return { ok: false, error: "That student is not on the class list" };
  if (!b.deviceId) return { ok: false, error: "Missing phone ID" };
  if (dev && lower(dev.adm_no) !== lower(t.adm_no)) return { ok: false, error: `This phone is already registered to ${dev.tname || dev.adm_no}. Ask your trainer to reset it.` };
  if (byAdm && byAdm.device_id !== b.deviceId) return { ok: false, error: `${t.name} is already registered on another phone. Ask your trainer to reset it.` };
  const now = nowIso();
  await run(
    env,
    "INSERT INTO devices (device_id,adm_no,name,class_code,registered_at,last_seen) VALUES (?,?,?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET last_seen=excluded.last_seen",
    b.deviceId,
    t.adm_no,
    t.name,
    t.class_code,
    now,
    now
  );
  return { ok: true, admNo: t.adm_no, name: t.name, classCode: t.class_code, className: t.class_name || t.class_code };
}
__name(registerDevice, "registerDevice");
var TCOLS = ["adm_no", "name", "class_code", "status", "mis_class", "added_by", "added_at", "updated_by", "updated_at", "note"];
async function importClassList(env, b, me) {
  const mis = String(b.misClass || "").trim();
  let streams = [...new Set((b.streams || []).map((s) => String(s).trim()).filter(Boolean))];
  if (!mis) fail("The class code is missing");
  if (!streams.length) streams = [mis];
  const students = [], seenAdm = /* @__PURE__ */ new Set();
  for (const s of b.students || []) {
    const adm = String(s.admNo || "").trim(), name = String(s.name || "").replace(/\s+/g, " ").trim();
    if (!adm || seenAdm.has(lower(adm))) continue;
    seenAdm.add(lower(adm));
    students.push({ admNo: adm, name: name || adm });
  }
  if (!students.length) fail("No students found in that list");
  const assign = new Map(Object.entries(b.assign || {}).map(([k, v]) => [lower(k), String(v)]).filter(([, v]) => streams.includes(v)));
  const now = nowIso();
  const [rows, pend] = await many(
    env,
    [`SELECT * FROM trainees WHERE class_code IN ${IN} OR adm_no IN ${IN}`, JSON.stringify(streams), JSON.stringify(students.map((s) => s.admNo))],
    [`SELECT * FROM requests WHERE status='pending' AND adm_no IN ${IN}`, JSON.stringify(students.map((s) => s.admNo))]
  );
  const byAdm = new Map(rows.map((r) => [lower(r.adm_no), r]));
  const inStream = Object.fromEntries(streams.map((s) => [s, 0]));
  for (const r of rows) if (inStream[r.class_code] !== void 0 && active(r)) inStream[r.class_code]++;
  const firstUpload = streams.every((s) => !inStream[s]);
  const out = { added: [], unchanged: 0, renamed: [], moved: [], confirmed: [], missing: [], byStream: {}, plan: [] };
  const smallest = /* @__PURE__ */ __name(() => [...streams].sort((a, c) => inStream[a] - inStream[c] || (a < c ? -1 : 1))[0], "smallest");
  const writes = [];
  students.forEach((s, idx) => {
    const old = byAdm.get(lower(s.admNo));
    const here = old && streams.includes(old.class_code) ? old.class_code : "";
    let to = assign.get(lower(s.admNo));
    if (!to) to = here || (firstUpload ? streams[Math.floor(idx * streams.length / students.length)] : smallest());
    if (here && active(old)) inStream[here]--;
    inStream[to]++;
    out.plan.push({ admNo: s.admNo, name: s.name, from: old ? old.class_code : "", fromActive: old ? active(old) : false, to, isNew: !old });
    if (!old) {
      out.added.push({ admNo: s.admNo, name: s.name, classCode: to });
      writes.push({ adm_no: s.admNo, name: s.name, class_code: to, status: "active", mis_class: mis, added_by: me.code, added_at: now, updated_by: me.code, updated_at: now, note: "" });
      return;
    }
    const row = { ...old };
    let changed = false;
    if (row.name !== s.name) {
      out.renamed.push({ admNo: row.adm_no, old: row.name, name: s.name });
      if (b.useNewNames) {
        row.name = s.name;
        changed = true;
      }
    }
    if (row.class_code !== to) {
      out.moved.push({ admNo: row.adm_no, name: row.name, from: row.class_code, to, within: !!here });
      row.class_code = to;
      changed = true;
    }
    if (!active(row)) {
      row.status = "active";
      changed = true;
    }
    if (row.mis_class !== mis) {
      row.mis_class = mis;
      changed = true;
    }
    if (changed) writes.push({ ...row, updated_by: me.code, updated_at: now });
    else out.unchanged++;
  });
  for (const r of pend) out.confirmed.push({ admNo: r.adm_no, name: r.name, requestedBy: r.requested_name });
  const withdraw = new Set((b.withdraw || []).map(lower));
  for (const r of rows) {
    if (seenAdm.has(lower(r.adm_no)) || inStream[r.class_code] === void 0 || !active(r)) continue;
    out.missing.push({ admNo: r.adm_no, name: r.name, classCode: r.class_code });
    if (withdraw.has(lower(r.adm_no))) {
      writes.push({ ...r, status: "withdrawn", updated_by: me.code, updated_at: now, note: `Not on the ${mis} list ${todayIso()}` });
      inStream[r.class_code]--;
    }
  }
  for (const s of streams) out.byStream[s] = inStream[s];
  if (!b.dryRun) {
    await many(
      env,
      ...upsertStmts("trainees", TCOLS, writes, ["adm_no"]),
      pend.length && [`UPDATE requests SET status='approved', decided_by=?, decided_at=?, note=? WHERE id IN ${IN}`, me.code, now, "On the MIS list for " + mis, JSON.stringify(pend.map((r) => r.id))],
      ...upsertStmts("classes", ["code", "name", "level", "mis_class"], streams.map((s) => ({ code: s, name: s, level: levelOf(s) || levelOf(mis), mis_class: mis })), ["code"], ["mis_class"])
    );
    await audit(env, me, "class list", `${mis} \u2192 ${streams.join(", ")}: ${out.added.length} added, ${out.moved.length} moved, ${(b.withdraw || []).length} withdrawn, ${out.confirmed.length} trainer additions confirmed`);
    await bumpRoster(env);
  }
  return { ...out, ok: true, dryRun: !!b.dryRun, misClass: mis, streams, total: students.length };
}
__name(importClassList, "importClassList");
async function studentsOf(env, misClass, classCode) {
  const rows = classCode ? await all(env, "SELECT * FROM trainees WHERE class_code=?", classCode) : await all(env, "SELECT t.* FROM trainees t LEFT JOIN classes c ON c.code=t.class_code WHERE t.mis_class=? OR c.mis_class=?", misClass, misClass);
  return { ok: true, students: rows.map((r) => ({ admNo: r.adm_no, name: r.name, classCode: r.class_code, status: active(r) ? "active" : r.status || "withdrawn", note: r.note })) };
}
__name(studentsOf, "studentsOf");
async function updateStudent(env, b, me) {
  const r = await one(env, "SELECT * FROM trainees WHERE adm_no=?", String(b.admNo || "").trim());
  if (!r) fail("No student with admission number " + b.admNo);
  const what = [];
  if (b.classCode && b.classCode !== r.class_code) {
    what.push(`moved ${r.class_code} \u2192 ${b.classCode}`);
    r.class_code = b.classCode;
  }
  if (b.status === "withdrawn" || b.status === "active") {
    what.push(b.status);
    r.status = b.status;
  }
  if (b.name) {
    what.push("renamed");
    r.name = String(b.name).trim();
  }
  if (b.note !== void 0) r.note = String(b.note);
  await upsertMany(env, "trainees", TCOLS, [{ ...r, updated_by: me.code, updated_at: nowIso() }], ["adm_no"]);
  await audit(env, me, "student", `${r.adm_no} ${what.join(", ")}`);
  await bumpRoster(env);
  return { ok: true, student: { admNo: r.adm_no, name: r.name, classCode: r.class_code, status: r.status || "active" } };
}
__name(updateStudent, "updateStudent");
async function addStudents(env, list, me) {
  list = list.slice(0, 100).filter((s) => s && s.admNo && s.classCode);
  const adms = list.map((s) => String(s.admNo).trim());
  const trainees = new Map((await all(env, `SELECT * FROM trainees WHERE adm_no IN ${IN}`, JSON.stringify(adms))).map((r) => [lower(r.adm_no), r]));
  const reqs = new Map((await all(env, `SELECT * FROM requests WHERE id IN ${IN}`, JSON.stringify(list.map((s) => s.classCode + "|" + String(s.admNo).trim())))).map((r) => [r.id, r]));
  const now = nowIso(), results = [], writes = [];
  for (const s of list) {
    const adm = String(s.admNo).trim(), cls = String(s.classCode).trim();
    const t = trainees.get(lower(adm));
    if (t && t.class_code === cls && active(t)) {
      results.push({ admNo: adm, classCode: cls, status: "on-list" });
      continue;
    }
    const id = cls + "|" + adm, old = reqs.get(id);
    if (old && old.status !== "rejected") {
      results.push({ admNo: adm, classCode: cls, status: old.status });
      continue;
    }
    writes.push({
      id,
      adm_no: adm,
      name: String(s.name || adm).trim(),
      class_code: cls,
      reason: String(s.reason || "").slice(0, 300),
      requested_by: me.code,
      requested_name: me.name,
      requested_at: s.addedAt || now,
      status: "pending",
      decided_by: null,
      decided_at: null,
      merged_into: null,
      note: t ? `On the list of ${t.class_code}${active(t) ? "" : " (withdrawn)"}` : ""
    });
    results.push({ admNo: adm, classCode: cls, status: "pending" });
  }
  if (writes.length) {
    await upsertMany(env, "requests", ["id", "adm_no", "name", "class_code", "reason", "requested_by", "requested_name", "requested_at", "status", "decided_by", "decided_at", "merged_into", "note"], writes, ["id"]);
    await bumpRoster(env);
  }
  return { ok: true, results };
}
__name(addStudents, "addStudents");
async function listRequests(env) {
  const reqs = await all(env, "SELECT * FROM requests ORDER BY requested_at DESC LIMIT 500");
  const trainees = new Map((await all(env, `SELECT * FROM trainees WHERE adm_no IN ${IN}`, JSON.stringify(reqs.map((r) => r.adm_no)))).map((r) => [lower(r.adm_no), r]));
  return {
    ok: true,
    requests: reqs.map((r) => {
      const t = trainees.get(lower(r.adm_no));
      return {
        id: r.id,
        admNo: r.adm_no,
        name: r.name,
        classCode: r.class_code,
        reason: r.reason,
        requestedBy: r.requested_name,
        requestedAt: r.requested_at,
        status: r.status,
        decidedAt: r.decided_at,
        mergedInto: r.merged_into,
        note: r.note,
        existing: t ? { classCode: t.class_code, name: t.name, active: active(t) } : null
      };
    })
  };
}
__name(listRequests, "listRequests");
async function decideRequest(env, b, me) {
  const r = await one(env, "SELECT * FROM requests WHERE id=?", b.id);
  if (!r) fail("That request no longer exists");
  const now = nowIso();
  if (b.decision === "approve") {
    const t = await one(env, "SELECT * FROM trainees WHERE adm_no=?", r.adm_no);
    const cls = await one(env, "SELECT mis_class FROM classes WHERE code=?", r.class_code);
    const row = t ? { ...t } : { adm_no: r.adm_no, name: b.name || r.name, mis_class: cls?.mis_class || "", added_by: r.requested_by, added_at: r.requested_at, note: "Added by " + r.requested_name };
    Object.assign(row, { class_code: r.class_code, status: "active", updated_by: me.code, updated_at: now });
    if (b.name) row.name = b.name;
    await upsertMany(env, "trainees", TCOLS, [row], ["adm_no"]);
    r.status = "approved";
  } else if (b.decision === "reject") r.status = "rejected";
  else if (b.decision === "merge") {
    const target = await one(env, "SELECT adm_no FROM trainees WHERE adm_no=?", String(b.mergeInto || "").trim());
    if (!target) fail("No student with admission number " + b.mergeInto);
    r.status = "merged";
    r.merged_into = target.adm_no;
  } else fail("Choose approve, reject or merge");
  await run(env, "UPDATE requests SET status=?, merged_into=?, decided_by=?, decided_at=?, note=COALESCE(?,note) WHERE id=?", r.status, r.merged_into || null, me.code, now, b.note || null, r.id);
  await audit(env, me, "student request", `${r.adm_no} in ${r.class_code}: ${r.status}${r.merged_into ? " into " + r.merged_into : ""}`);
  await bumpRoster(env);
  return { ok: true, status: r.status };
}
__name(decideRequest, "decideRequest");
async function listStaff(env) {
  const [rows, def] = await many(env, ["SELECT * FROM staff ORDER BY name"], ["SELECT value FROM meta WHERE key='default_pin'"]);
  const d = def[0] ? JSON.parse(def[0].value || "{}") : null;
  return { ok: true, staff: rows.map(staffPublic), defaultPin: d ? { at: d.at || "", by: d.by || "" } : null };
}
__name(listStaff, "listStaff");
async function setDefaultPin(env, b, me) {
  const pin = String(b.pin || "").trim();
  if (!pin) {
    await run(env, "DELETE FROM meta WHERE key='default_pin'");
    await audit(env, me, "first-time PIN", "removed");
    return { ok: true, set: false };
  }
  if (!/^\d{4,8}$/.test(pin)) fail("Use 4 to 8 digits for the first-time PIN");
  const salt = crypto.randomUUID().slice(0, 12);
  await setMeta(env, "default_pin", JSON.stringify({ salt, hash: await sha256Hex(salt + "|" + pin), at: nowIso(), by: me.name }));
  await audit(env, me, "first-time PIN", "set");
  return { ok: true, set: true };
}
__name(setDefaultPin, "setDefaultPin");
async function updateStaff(env, b, me) {
  const code = String(b.code || "").trim().toUpperCase();
  if (!code) fail("Enter a staff code");
  let row = await getStaff(env, code);
  if (!row) {
    if (!b.name) fail("Enter the staff member's name");
    row = { code, name: b.name, roles: "TRAINER", responsibility: "", active: 1, pin_version: 0, must_change: 1 };
  }
  if (b.name) row.name = String(b.name).trim();
  if (b.roles) {
    const roles = rolesList(Array.isArray(b.roles) ? b.roles.join(",") : b.roles);
    if (lower(code) === lower(me.code) && !roles.includes("MIS")) fail("You cannot remove your own MIS role");
    row.roles = roles.join(", ");
  }
  if (b.driveFolder !== void 0) {
    const id = (String(b.driveFolder).match(/[-\w]{20,}/) || [""])[0];
    await run(env, "UPDATE staff SET drive_folder=?, updated_at=? WHERE code=?", id || null, nowIso(), code);
    if (!b.roles && b.active === void 0 && !b.resetPin && !b.name) return { ok: true, staff: staffPublic(await getStaff(env, code)) };
  }
  if (b.active !== void 0) {
    if (lower(code) === lower(me.code) && !b.active) fail("You cannot switch off your own account");
    row.active = b.active ? 1 : 0;
    row.pin_version = (Number(row.pin_version) || 0) + 1;
  }
  await run(
    env,
    `INSERT INTO staff (code,name,roles,responsibility,active,pin_version,must_change,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, roles=excluded.roles, active=excluded.active, pin_version=excluded.pin_version, updated_at=excluded.updated_at`,
    row.code,
    row.name,
    row.roles,
    row.responsibility || "",
    row.active ? 1 : 0,
    Number(row.pin_version) || 0,
    row.must_change ? 1 : 0,
    nowIso()
  );
  let pin = null, toDefault = false;
  if (b.resetPin && b.toDefault && await getMeta(env, "default_pin")) {
    await run(env, "UPDATE staff SET pin_hash=NULL, pin_salt=NULL, must_change=1, pin_version=COALESCE(pin_version,0)+1, updated_at=? WHERE code=?", nowIso(), code);
    toDefault = true;
  } else if (b.resetPin) {
    pin = randomPin();
    row = await setStaffPin(env, code, pin, true);
  }
  await audit(env, me, "staff", `${code}${b.roles ? " roles " + row.roles : ""}${b.active !== void 0 ? b.active ? " switched on" : " switched off" : ""}${pin ? " PIN reset" : ""}${toDefault ? " back to the first-time PIN" : ""}`);
  await bumpRoster(env);
  return { ok: true, staff: staffPublic(await getStaff(env, code)), pin, toDefault };
}
__name(updateStaff, "updateStaff");
function finalMarks(s, accepted) {
  const out = {};
  for (const m of s.marks || []) out[m.admNo] = { admNo: m.admNo, name: m.name, status: m.status, source: m.explicit ? "trainer" : "default" };
  for (const [adm, c] of Object.entries({ ...s.qrFolded || {}, ...accepted || {} })) {
    if (out[adm]?.source === "trainer") continue;
    out[adm] = { admNo: adm, name: out[adm]?.name || c.name, status: "Present", source: "qr" };
  }
  return Object.values(out);
}
__name(finalMarks, "finalMarks");
function acceptedOf(rows) {
  const map = {};
  for (const r of rows) if (r.status === void 0 || r.status === "accepted") (map[r.session_id] = map[r.session_id] || {})[r.adm_no] = { name: r.name, scannedAt: r.scanned_at };
  return map;
}
__name(acceptedOf, "acceptedOf");
async function acceptedMap(env, ids) {
  const map = {};
  if (!ids.length) return map;
  for (const r of await all(env, `SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN ${IN}`, JSON.stringify(ids))) {
    (map[r.session_id] = map[r.session_id] || {})[r.adm_no] = { name: r.name, scannedAt: r.scanned_at };
  }
  return map;
}
__name(acceptedMap, "acceptedMap");
function sessionRow(s, accepted, term, now) {
  const c = { P: 0, A: 0, L: 0, E: 0 };
  for (const m of finalMarks(s, accepted)) {
    const k = STATUS_CODE[m.status];
    if (k) c[k]++;
  }
  const counted = c.P + c.L + c.A;
  return {
    id: s.sessionId,
    date: s.date,
    class_code: s.classCode,
    unit_code: s.unitCode,
    unit_name: s.unitName,
    period: s.period,
    trainer_id: s.trainerId,
    trainer_name: s.trainerName,
    present: c.P,
    absent: c.A,
    late: c.L,
    excused: c.E,
    total: c.P + c.A + c.L + c.E,
    pct: counted ? Math.round((c.P + c.L) / counted * 1e3) / 10 : null,
    updated_at: s.updatedAt || "",
    synced_at: now,
    term_id: s.termId || term?.id || "",
    week: Number(s.week) || (term ? weekOf(term, s.date) : null),
    data: JSON.stringify(s),
    kind: ["cat", "extra"].includes(s.kind) ? s.kind : "lesson",
    slots: Number(s.slots) === 2 ? 2 : 1
  };
}
__name(sessionRow, "sessionRow");
var SCOLS = ["id", "date", "class_code", "unit_code", "unit_name", "period", "trainer_id", "trainer_name", "present", "absent", "late", "excused", "total", "pct", "updated_at", "synced_at", "term_id", "week", "data", "kind", "slots"];
var pushList = /* @__PURE__ */ __name((sessions) => sessions.filter((s) => s && s.sessionId).slice(0, 50), "pushList");
function pushPre(sessions) {
  const J = JSON.stringify(pushList(sessions).map((s) => s.sessionId));
  return [
    [`SELECT id, updated_at, term_id, data FROM sessions WHERE id IN ${IN}`, J],
    [TERM_SQL],
    [`SELECT * FROM checkins WHERE session_id IN ${IN} AND status IN ('accepted','pending')`, J],
    [`SELECT term_id, class_code, unit_code FROM unlocks WHERE ${UNLOCK_LIVE}`]
  ];
}
__name(pushPre, "pushPre");
async function pushSessions(env, sessions, me, pre) {
  sessions = pushList(sessions);
  const [old, termRows, cis, unlockRows] = pre.rows;
  const prev = new Map(old.map((r) => [r.id, r]));
  const activeId = termRows[0]?.id || "";
  const open = new Set(unlockRows.map((r) => `${r.term_id}|${r.class_code}|${r.unit_code}`));
  const results = [], fresh = [];
  for (const s of sessions) {
    const had = prev.get(s.sessionId);
    const termId = had?.term_id || s.termId || "";
    if (had && termId && activeId && termId !== activeId && !open.has(`${termId}|${s.classCode}|${s.unitCode}`)) {
      results.push({ sessionId: s.sessionId, status: "locked" });
      continue;
    }
    const out = had ? mergeRegisters(JSON.parse(had.data), s) : s;
    out.uploadedBy = me.code;
    fresh.push(out);
    const differs = had && registerKey(out) !== registerKey(s);
    results.push({ sessionId: s.sessionId, status: !had ? "added" : differs ? "merged" : "updated", ...differs ? { session: out } : {} });
  }
  if (!fresh.length) return { ok: true, results };
  const byId = new Map(fresh.map((s) => [s.sessionId, s]));
  const now = nowIso(), ciWrites = [];
  for (const r of cis) {
    if (r.status !== "pending" || !byId.has(r.session_id)) continue;
    const v = await verifyCode({ sessionId: r.session_id, w: r.w, token: r.code }, byId.get(r.session_id));
    if (v === null) continue;
    Object.assign(r, { status: v ? "accepted" : "rejected", reason: v ? "" : "invalid-code", updated_at: now });
    ciWrites.push(r);
  }
  const accepted = acceptedOf(cis.filter((r) => r.status === "accepted"));
  const term = termOut(termRows[0]);
  await many(
    env,
    ...upsertStmts("sessions", SCOLS, fresh.map((s) => sessionRow(s, accepted[s.sessionId], term, now)), ["id"]),
    ...upsertStmts("checkins", CICOLS, ciWrites, CIKEY),
    ciWrites.some((r) => r.status === "accepted") && changedStmt()
  );
  return { ok: true, results };
}
__name(pushSessions, "pushSessions");
function mergeRegisters(a, b) {
  const newer = String(b.updatedAt || "") >= String(a.updatedAt || "") ? b : a, older = newer === b ? a : b;
  const best = /* @__PURE__ */ new Map();
  [older, newer].forEach((s, rank) => {
    for (const m of s.marks || []) {
      const at = m.at || s.createdAt || "", k = lower(m.admNo), had = best.get(k);
      if (!had || at > had.at || at === had.at && rank >= had.rank) best.set(k, { m: { ...m, at }, at, rank });
    }
  });
  const logs = /* @__PURE__ */ new Map();
  for (const l of [...a.editLog || [], ...b.editLog || []]) logs.set(`${l.at}|${l.device || ""}|${l.reason || ""}`, l);
  const marks = [...best.values()].map((x) => x.m);
  const counts = { P: 0, A: 0, L: 0, E: 0 };
  for (const m of marks) {
    const k = STATUS_CODE[m.status];
    if (k) counts[k]++;
  }
  const created = [a.createdAt, b.createdAt].filter(Boolean).sort()[0] || "";
  return {
    ...older,
    ...newer,
    marks,
    counts,
    createdAt: created,
    updatedAt: newer.updatedAt || older.updatedAt || "",
    editLog: [...logs.values()].sort((x, y) => String(x.at).localeCompare(String(y.at))),
    edits: logs.size,
    viaQr: { ...older.viaQr || {}, ...newer.viaQr || {} },
    qrFolded: { ...older.qrFolded || {}, ...newer.qrFolded || {} },
    qr: newer.qr || older.qr,
    notes: newer.notes || older.notes || ""
  };
}
__name(mergeRegisters, "mergeRegisters");
var registerKey = /* @__PURE__ */ __name((s) => JSON.stringify([(s.marks || []).map((m) => `${lower(m.admNo)}=${m.status}`).sort(), s.notes || ""]), "registerKey");
async function mySessions(env, b, me) {
  const at = String(b.cursor?.at || ""), id = String(b.cursor?.id || "");
  const rows = await all(env, `SELECT id, data, synced_at FROM sessions WHERE trainer_id=? AND (synced_at > ? OR (synced_at = ? AND id > ?))
    ORDER BY synced_at, id LIMIT ${PULL_PAGE}`, me.code, at, at, id);
  const last = rows[rows.length - 1];
  return { ok: true, sessions: rows.map((r) => r.data), cursor: last ? { at: last.synced_at, id: last.id } : { at, id }, more: rows.length === PULL_PAGE };
}
__name(mySessions, "mySessions");
var PULL_PAGE = 120;
var UNLOCK_LIVE = "(until IS NULL OR until = '' OR until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
async function setUnlock(env, b, me, on) {
  const termId = String(b.termId || ""), cls = String(b.classCode || ""), unit = String(b.unitCode || "");
  if (!termId || !cls || !unit) fail("Choose the term, class and unit");
  const term = await one(env, "SELECT id, status FROM terms WHERE id=?", termId);
  if (!term) fail("That term does not exist");
  if (on) {
    const days = Math.min(60, Math.max(1, Number(b.days) || 7));
    const until = new Date(Date.now() + days * 864e5).toISOString();
    await run(
      env,
      `INSERT INTO unlocks (term_id,class_code,unit_code,by_code,by_name,at,until) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(term_id,class_code,unit_code) DO UPDATE SET by_code=excluded.by_code, by_name=excluded.by_name, at=excluded.at, until=excluded.until`,
      termId,
      cls,
      unit,
      me.code,
      me.name,
      nowIso(),
      until
    );
    await audit(env, me, "unlock", `${termId} ${cls} ${unit} for ${days} day(s)`);
  } else {
    await run(env, "DELETE FROM unlocks WHERE term_id=? AND class_code=? AND unit_code=?", termId, cls, unit);
    await audit(env, me, "relock", `${termId} ${cls} ${unit}`);
  }
  await bumpRoster(env);
  return { ok: true };
}
__name(setUnlock, "setUnlock");
var unlockedSet = /* @__PURE__ */ __name(async (env) => new Set((await all(env, `SELECT term_id, class_code, unit_code FROM unlocks WHERE ${UNLOCK_LIVE}`)).map((r) => `${r.term_id}|${r.class_code}|${r.unit_code}`)), "unlockedSet");
async function termUnits(env, b, me) {
  const termId = String(b.termId || "");
  const term = termOut(termId ? await one(env, "SELECT * FROM terms WHERE id=?", termId) : await one(env, TERM_SQL));
  if (!term) fail("That term does not exist");
  const rows = await all(env, "SELECT * FROM loading WHERE term_id=? ORDER BY class_code, unit_code", term.id);
  const mine = seesAll(me) ? rows : rows.filter((r) => lower(r.trainer_code) === lower(me.code));
  return {
    ok: true,
    term,
    weeks: teachingWeeks(term),
    units: mine.map((r) => ({
      classCode: r.class_code,
      code: r.unit_code,
      name: r.unit_name || r.unit_code,
      trainerCode: r.trainer_code,
      trainerName: r.trainer_name,
      lessonsPerWeek: Number(r.lessons_per_week) || 2,
      hoursPerWeek: Number(r.hours_per_week) || 3
    }))
  };
}
__name(termUnits, "termUnits");
async function absenceLimit(env) {
  return Math.max(0, Math.round(Number(await getMeta(env, "absence_limit")) || 3));
}
__name(absenceLimit, "absenceLimit");
async function setAbsenceLimit(env, b, me) {
  const n = Math.max(0, Math.min(60, Math.round(Number(b.limit))));
  if (!Number.isFinite(n)) fail("Enter a number of lessons");
  await setMeta(env, "absence_limit", String(n));
  await audit(env, me, "absence limit", String(n));
  return { ok: true, limit: n };
}
__name(setAbsenceLimit, "setAbsenceLimit");
async function absences(env, b, me) {
  const term = termOut(b.termId ? await one(env, "SELECT * FROM terms WHERE id=?", String(b.termId)) : await one(env, TERM_SQL));
  if (!term) return { ok: true, term: null, limit: await absenceLimit(env), rows: [] };
  const limit = b.limit !== void 0 && b.limit !== "" ? Math.max(0, Math.round(Number(b.limit) || 0)) : await absenceLimit(env);
  const [missed, held, loading, archived] = await many(
    env,
    [`SELECT s.class_code, s.unit_code, MAX(s.unit_name) AS unit_name, json_extract(m.value,'$.admNo') AS adm, MAX(json_extract(m.value,'$.name')) AS name,
      SUM(CASE WHEN json_extract(m.value,'$.status')='Absent' THEN COALESCE(s.slots,1) ELSE 0 END) AS missed,
      SUM(CASE WHEN json_extract(m.value,'$.status') IN ('Present','Late') THEN COALESCE(s.slots,1) ELSE 0 END) AS attended
      FROM sessions s, json_each(s.data, '$.marks') m
      WHERE s.term_id=? AND COALESCE(s.kind,'lesson')='lesson'
      GROUP BY s.class_code, s.unit_code, adm HAVING missed > ?`, term.id, limit],
    [`SELECT class_code, unit_code, SUM(COALESCE(slots,1)) AS held FROM sessions WHERE term_id=? AND COALESCE(kind,'lesson')='lesson' GROUP BY class_code, unit_code`, term.id],
    ["SELECT class_code, unit_code, unit_name, trainer_name FROM loading WHERE term_id=?", term.id],
    ["SELECT code FROM classes WHERE status='archived'"]
  );
  const gone = new Set(archived.map((r) => r.code));
  const heldOf = new Map(held.map((r) => [r.class_code + "|" + r.unit_code, r.held]));
  const load = new Map(loading.map((r) => [r.class_code + "|" + r.unit_code, r]));
  const rows = missed.filter((r) => r.adm && !gone.has(r.class_code)).map((r) => {
    const k = r.class_code + "|" + r.unit_code, l = load.get(k) || {}, h = Number(heldOf.get(k)) || 0;
    return {
      classCode: r.class_code,
      unitCode: r.unit_code,
      unitName: l.unit_name || r.unit_name || r.unit_code,
      trainerName: l.trainer_name || "",
      admNo: r.adm,
      name: r.name || r.adm,
      missed: Number(r.missed) || 0,
      held: h,
      pct: h ? Math.round((Number(r.attended) || 0) / h * 100) : null
    };
  });
  return { ok: true, term, limit, rows };
}
__name(absences, "absences");
var codesOf = /* @__PURE__ */ __name((b) => [...new Set((b.codes || []).map((c) => String(c || "").trim()).filter(Boolean))].slice(0, 50), "codesOf");
async function archiveClasses(env, b, me) {
  const codes = codesOf(b);
  if (!codes.length) fail("Choose a class");
  const on = b.archive !== false, J = JSON.stringify(codes), now = nowIso();
  await many(
    env,
    [`INSERT OR IGNORE INTO classes (code, name, level) SELECT value, value, '' FROM json_each(?)`, J],
    [`UPDATE classes SET status=?, archived_at=?, archived_by=? WHERE code IN ${IN}`, on ? "archived" : "active", on ? now : null, on ? me.name : null, J]
  );
  await audit(env, me, on ? "archive class" : "restore class", codes.join(", "));
  await bumpRoster(env);
  return { ok: true, codes, archived: on };
}
__name(archiveClasses, "archiveClasses");
async function classExport(env, b, me) {
  const codes = codesOf(b);
  if (!codes.length) fail("Choose a class");
  const J = JSON.stringify(codes);
  const [classes, trainees, loading, sessions, checkins, marks, oldMarks, signoffs, evidence, requests, devices] = await many(
    env,
    [`SELECT * FROM classes WHERE code IN ${IN}`, J],
    [`SELECT * FROM trainees WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM loading WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM sessions WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM checkins WHERE session_id IN (SELECT id FROM sessions WHERE class_code IN ${IN})`, J],
    [`SELECT * FROM unit_marks WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM marks WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM signoffs WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM evidence WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM requests WHERE class_code IN ${IN}`, J],
    [`SELECT * FROM devices WHERE class_code IN ${IN}`, J]
  );
  await audit(env, me, "class export", codes.join(", "));
  return {
    ok: true,
    app: "rvnp-class-export",
    exportedAt: nowIso(),
    by: me.name,
    codes,
    tables: { classes, trainees, loading, sessions, checkins, marks, oldMarks, signoffs, evidence, requests, devices }
  };
}
__name(classExport, "classExport");
async function deleteClasses(env, b, me) {
  const codes = codesOf(b);
  if (!codes.length) fail("Choose a class");
  const J = JSON.stringify(codes);
  const rows = await all(env, `SELECT code, status FROM classes WHERE code IN ${IN}`, J);
  if (rows.length !== codes.length || rows.some((r) => r.status !== "archived")) fail("Archive a class before deleting it");
  if (String(b.confirm || "").trim().toLowerCase() !== String(b.label || codes[0]).trim().toLowerCase()) fail("Type the class name exactly to confirm");
  const SESS = `(SELECT id FROM sessions WHERE class_code IN ${IN})`, ADMS = `(SELECT adm_no FROM trainees WHERE class_code IN ${IN})`;
  await many(
    env,
    [`DELETE FROM checkins WHERE session_id IN ${SESS}`, J],
    [`DELETE FROM sessions WHERE class_code IN ${IN}`, J],
    [`DELETE FROM unit_marks WHERE class_code IN ${IN}`, J],
    [`DELETE FROM marks WHERE class_code IN ${IN}`, J],
    [`DELETE FROM signoffs WHERE class_code IN ${IN}`, J],
    [`DELETE FROM unlocks WHERE class_code IN ${IN}`, J],
    [`DELETE FROM loading WHERE class_code IN ${IN}`, J],
    [`DELETE FROM units WHERE class_code IN ${IN}`, J],
    [`DELETE FROM push_subs WHERE adm_no IN ${ADMS}`, J],
    [`DELETE FROM devices WHERE class_code IN ${IN}`, J],
    [`DELETE FROM evidence WHERE class_code IN ${IN}`, J],
    [`DELETE FROM requests WHERE class_code IN ${IN}`, J],
    [`DELETE FROM trainees WHERE class_code IN ${IN}`, J],
    [`DELETE FROM classes WHERE code IN ${IN}`, J],
    ["DELETE FROM meta WHERE key='pub_classes'"]
  );
  await audit(env, me, "delete class", codes.join(", "));
  await bumpRoster(env);
  return { ok: true, deleted: codes };
}
__name(deleteClasses, "deleteClasses");
async function teachesUnit(env, me, classCode, unitCode, term) {
  if (me.roles.includes("HOD") || me.roles.includes("MIS")) return true;
  if (!term) return true;
  const any = await one(env, "SELECT 1 FROM loading WHERE term_id=? LIMIT 1", term.id);
  if (!any) return true;
  return !!await one(env, "SELECT 1 FROM loading WHERE term_id=? AND class_code=? AND unit_code=? AND trainer_code=?", term.id, classCode, unitCode, me.code);
}
__name(teachesUnit, "teachesUnit");
function reportPre(b) {
  const c = String(b.classCode || ""), u = String(b.unitCode || ""), tid = String(b.termId || "");
  const TERM = tid ? ["SELECT * FROM terms WHERE id=?", tid] : [TERM_SQL], T = tid ? "?" : ACTIVE_TERM, tp = tid ? [tid] : [];
  return [
    TERM,
    [`SELECT 1 AS x FROM loading WHERE term_id=${T} LIMIT 1`, ...tp],
    [`SELECT * FROM loading WHERE term_id=${T} AND class_code=? AND unit_code=?`, ...tp, c, u],
    ["SELECT id, date, data FROM sessions WHERE class_code=? AND unit_code=?", c, u],
    ["SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN (SELECT id FROM sessions WHERE class_code=? AND unit_code=?)", c, u],
    ["SELECT * FROM signoffs WHERE class_code=? AND unit_code=?", c, u],
    [TERM_SQL],
    [`SELECT 1 AS x FROM loading WHERE term_id=${ACTIVE_TERM} AND class_code=? AND unit_code=?`, c, u],
    [`SELECT 1 AS x FROM unlocks WHERE term_id=${T} AND class_code=? AND unit_code=? AND ${UNLOCK_LIVE}`, ...tp, c, u]
  ];
}
__name(reportPre, "reportPre");
async function reportData(env, b, me, pre) {
  if (!b.classCode || !b.unitCode) fail("Choose a class and a unit");
  const [termRows, anyLoading, loadRows, sessRows, acc, soRows, activeRows, nowLoad, unlockRow] = pre.rows;
  const term = termOut(termRows[0]), load = loadRows[0] || null;
  if (b.termId && !term) fail("That term does not exist");
  const staffOnly = !(me.roles.includes("HOD") || me.roles.includes("MIS"));
  const ended = !!(term && activeRows[0] && term.id !== activeRows[0].id);
  const teachesNow = ended && nowLoad.length && !!await one(env, `SELECT 1 FROM loading WHERE term_id=${ACTIVE_TERM} AND class_code=? AND unit_code=? AND trainer_code=?`, b.classCode, b.unitCode, me.code);
  if (staffOnly && term && anyLoading.length && !(load && lower(load.trainer_code) === lower(me.code)) && !teachesNow) fail("You can only see reports for the units in your loading");
  const weeks = teachingWeeks(term);
  let from = "0000-00-00", to = "9999-12-31";
  if (weeks.length) {
    from = weeks[0];
    const e = /* @__PURE__ */ new Date(weeks[weeks.length - 1] + "T00:00:00Z");
    e.setUTCDate(e.getUTCDate() + 6);
    to = e.toISOString().slice(0, 10);
  }
  const accepted = acceptedOf(acc);
  const lessons = sessRows.filter((r) => r.date >= from && r.date <= to).map((r) => {
    const s = JSON.parse(r.data);
    const marks = {}, names = {};
    for (const m of finalMarks(s, accepted[r.id])) {
      const k = STATUS_CODE[m.status];
      if (k) {
        marks[m.admNo] = k;
        names[m.admNo] = m.name;
      }
    }
    return {
      id: r.id,
      date: s.date,
      period: s.period,
      slots: Number(s.slots) === 2 ? 2 : 1,
      kind: s.kind || "lesson",
      title: s.title || "",
      trainerId: s.trainerId,
      trainerName: s.trainerName,
      updatedAt: s.updatedAt,
      marks,
      names
    };
  });
  const so = soRows.find((r) => r.id === signoffId(term, b.classCode, b.unitCode));
  return {
    ok: true,
    term,
    weeks,
    lessons,
    serverTime: nowIso(),
    signoff: so ? signoffOut(so) : null,
    ended,
    unlocked: unlockRow.length > 0,
    loading: load ? { trainerCode: load.trainer_code, trainerName: load.trainer_name, unitName: load.unit_name, lessonsPerWeek: Number(load.lessons_per_week) || 2, hoursPerWeek: Number(load.hours_per_week) || 3 } : null
  };
}
__name(reportData, "reportData");
var signoffId = /* @__PURE__ */ __name((term, c, u) => `${term ? term.id : "no-term"}|${c}|${u}`, "signoffId");
var signoffOut = /* @__PURE__ */ __name((r) => ({
  id: r.id,
  classCode: r.class_code,
  unitCode: r.unit_code,
  unitName: r.unit_name,
  trainerCode: r.trainer_code,
  trainerName: r.trainer_name,
  lecturerComment: r.lecturer_comment,
  submittedAt: r.submitted_at,
  status: r.status,
  hodName: r.hod_name,
  hodComment: r.hod_comment,
  decidedAt: r.decided_at
}), "signoffOut");
async function submitSignoff(env, b, me) {
  const term = await activeTerm(env);
  if (!await teachesUnit(env, me, b.classCode, b.unitCode, term)) fail("You can only submit registers for the units in your loading");
  const id = signoffId(term, b.classCode, b.unitCode);
  const old = await one(env, "SELECT * FROM signoffs WHERE id=?", id);
  if (old && old.status === "approved" && !b.resubmit) fail("The HOD has already approved this register");
  await run(
    env,
    `INSERT INTO signoffs (id,term_id,class_code,unit_code,unit_name,trainer_code,trainer_name,lecturer_comment,submitted_at,status,hod_code,hod_name,hod_comment,decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,NULL) ON CONFLICT(id) DO UPDATE SET trainer_code=excluded.trainer_code, trainer_name=excluded.trainer_name,
    lecturer_comment=excluded.lecturer_comment, submitted_at=excluded.submitted_at, status='submitted', hod_code=NULL, hod_name=NULL, decided_at=NULL`,
    id,
    term ? term.id : "",
    b.classCode,
    b.unitCode,
    b.unitName || "",
    me.code,
    me.name,
    String(b.comment || "").slice(0, 1e3),
    nowIso(),
    "submitted",
    old?.hod_comment || null
  );
  return { ok: true, signoff: signoffOut(await one(env, "SELECT * FROM signoffs WHERE id=?", id)) };
}
__name(submitSignoff, "submitSignoff");
async function decideSignoff(env, b, me) {
  const old = await one(env, "SELECT * FROM signoffs WHERE id=?", b.id);
  if (!old) fail("That register has not been submitted");
  if (b.decision !== "approved" && b.decision !== "returned") fail("Choose approve or return");
  if (b.decision === "returned" && !String(b.comment || "").trim()) fail("Say what needs fixing when returning a register");
  await run(env, "UPDATE signoffs SET status=?, hod_code=?, hod_name=?, hod_comment=?, decided_at=? WHERE id=?", b.decision, me.code, me.name, String(b.comment || "").slice(0, 1e3), nowIso(), b.id);
  await audit(env, me, "sign-off", `${b.id} ${b.decision}`);
  return { ok: true, signoff: signoffOut(await one(env, "SELECT * FROM signoffs WHERE id=?", b.id)) };
}
__name(decideSignoff, "decideSignoff");
async function listSignoffs(env, b, me) {
  const term = b.termId ? termOut(await one(env, "SELECT * FROM terms WHERE id=?", String(b.termId))) : await activeTerm(env);
  const mine = !me.roles.includes("HOD") && !me.roles.includes("MIS");
  const rows = await all(
    env,
    `SELECT * FROM signoffs WHERE (? IS NULL OR term_id=?) ${mine ? "AND trainer_code=?" : ""} ORDER BY submitted_at DESC`,
    ...mine ? [term?.id ?? null, term?.id ?? null, me.code] : [term?.id ?? null, term?.id ?? null]
  );
  return { ok: true, signoffs: rows.map(signoffOut) };
}
__name(listSignoffs, "listSignoffs");
function overviewPre(b = {}) {
  const tid = String(b.termId || "");
  if (tid) {
    return [
      ["SELECT * FROM terms WHERE id=?", tid],
      [`SELECT class_code, unit_code, SUM(COALESCE(slots,1)) AS lessons, MAX(date) AS last, SUM(present+late) AS att, SUM(present+late+absent) AS counted FROM sessions
        WHERE COALESCE(kind,'lesson')='lesson' AND term_id=? GROUP BY class_code, unit_code`, tid],
      ["SELECT class_code, unit_code, status FROM signoffs WHERE term_id=?", tid],
      ["SELECT * FROM loading WHERE term_id=?", tid],
      ["SELECT code FROM classes WHERE status='archived'"]
    ];
  }
  return [
    [TERM_SQL],
    [`SELECT class_code, unit_code, SUM(COALESCE(slots,1)) AS lessons, MAX(date) AS last, SUM(present+late) AS att, SUM(present+late+absent) AS counted FROM sessions
      WHERE COALESCE(kind,'lesson')='lesson' AND (term_id=${ACTIVE_TERM} OR ((term_id IS NULL OR term_id='') AND date >= date((SELECT start_date FROM terms WHERE status='active' ORDER BY updated_at DESC LIMIT 1), '-6 days')))
      GROUP BY class_code, unit_code`],
    [`SELECT class_code, unit_code, status FROM signoffs WHERE term_id=${ACTIVE_TERM}`],
    [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`],
    ["SELECT code FROM classes WHERE status='archived'"]
  ];
}
__name(overviewPre, "overviewPre");
function overview(pre) {
  const [termRows, statRows, soRows, allLoading, archivedRows] = pre.rows;
  const archived = new Set(archivedRows.map((r) => r.code));
  const loading = allLoading.filter((r) => !archived.has(r.class_code));
  const term = termOut(termRows[0]);
  if (!term) return { ok: true, term: null, rows: [] };
  const weeks = teachingWeeks(term), today = todayIso();
  const elapsed = weeks.filter((w) => w <= today).length;
  const stats = new Map(statRows.map((r) => [r.class_code + "|" + r.unit_code, r]));
  const so = new Map(soRows.map((r) => [r.class_code + "|" + r.unit_code, r.status]));
  const rows = loading.map((r) => {
    const k = r.class_code + "|" + r.unit_code, s = stats.get(k) || { lessons: 0, last: "", att: 0, counted: 0 };
    return {
      classCode: r.class_code,
      unitCode: r.unit_code,
      unitName: r.unit_name,
      trainerCode: r.trainer_code,
      trainerName: r.trainer_name,
      lessons: s.lessons,
      due: elapsed * (Number(r.lessons_per_week) || 2),
      last: s.last || "",
      pct: s.counted ? Math.round(s.att / s.counted * 100) : null,
      signoff: so.get(k) || ""
    };
  });
  return { ok: true, term, week: elapsed, rows };
}
__name(overview, "overview");
async function verifyCode(c, s) {
  if (!s || !s.qr || !s.qr.secret) return null;
  const w = Number(c.w);
  if (!Number.isFinite(w)) return false;
  const intervals = s.qr.intervals || [];
  const inRange = intervals.some((iv) => w >= iv[0] - 1 && w <= iv[1] + 1);
  const genuine = (await hmacHex(`${c.sessionId}|${w}`, s.qr.secret)).slice(0, CODE_LENGTH) === String(c.token || "").toLowerCase();
  if (!inRange) {
    const lastEnd = intervals.reduce((m, iv) => Math.max(m, iv[1]), -Infinity);
    if (w <= lastEnd + 1) return false;
    const nowW = Math.floor(Date.now() / 1e3 / WINDOW_SECONDS);
    if (genuine && Math.abs(w - nowW) <= 3) return true;
    return null;
  }
  return genuine;
}
__name(verifyCode, "verifyCode");
var CICOLS = ["session_id", "adm_no", "device_id", "name", "w", "code", "scanned_at", "updated_at", "status", "reason"];
var CIKEY = ["session_id", "adm_no", "device_id"];
var ciId = /* @__PURE__ */ __name((r) => `${r.session_id}|${r.adm_no}|${r.device_id}`, "ciId");
async function receiveCheckins(env, list) {
  list = list.filter((c) => c && c.sessionId && c.admNo && c.deviceId).slice(0, 200);
  if (!list.length) return { ok: true, results: [] };
  const now = nowIso();
  const adms = JSON.stringify(list.map((c) => String(c.admNo))), sids = JSON.stringify([...new Set(list.map((c) => c.sessionId))]);
  const [tRows, dRows, aRows, cRows, sRows, termRows] = await many(
    env,
    [`SELECT * FROM trainees WHERE adm_no IN ${IN}`, adms],
    [`SELECT * FROM devices WHERE device_id IN ${IN}`, JSON.stringify(list.map((c) => c.deviceId))],
    [`SELECT * FROM devices WHERE adm_no IN ${IN}`, adms],
    [`SELECT * FROM checkins WHERE session_id IN ${IN}`, sids],
    [`SELECT id, data FROM sessions WHERE id IN ${IN}`, sids],
    [TERM_SQL]
  );
  const trainees = new Map(tRows.map((r) => [lower(r.adm_no), r]));
  const devById = new Map(dRows.map((r) => [r.device_id, r]));
  const devByAdm = new Map(aRows.map((r) => [lower(r.adm_no), r]));
  const ids = list.map((c) => {
    const t = trainees.get(lower(c.admNo));
    return `${c.sessionId}|${t ? t.adm_no : c.admNo}|${c.deviceId}`;
  });
  const existing = new Map(cRows.map((r) => [ciId(r), r]));
  const sessions = new Map(sRows.map((r) => [r.id, JSON.parse(r.data)]));
  const results = [], ciWrites = [], devWrites = /* @__PURE__ */ new Map(), touched = /* @__PURE__ */ new Set();
  for (let i = 0; i < list.length; i++) {
    const c = list[i], t = trainees.get(lower(c.admNo)), adm = t ? t.adm_no : String(c.admNo), id = ids[i];
    const row = existing.get(id) || {
      session_id: c.sessionId,
      adm_no: adm,
      device_id: c.deviceId,
      name: t ? t.name : "",
      w: String(c.w),
      code: String(c.token || ""),
      scanned_at: c.scannedAt || "",
      updated_at: "",
      status: "",
      reason: ""
    };
    if (row.status !== "accepted") {
      let status, reason = "";
      if (!t || !active(t)) {
        status = "rejected";
        reason = "unknown-student";
      } else if (!classParts(classFromSession(c.sessionId)).includes(t.class_code)) {
        status = "rejected";
        reason = "wrong-class";
      } else {
        const di = devById.get(c.deviceId), ai = devByAdm.get(lower(adm));
        if (di && lower(di.adm_no) !== lower(adm)) {
          status = "rejected";
          reason = "device-other-student";
        } else if (ai && ai.device_id !== c.deviceId) {
          status = "rejected";
          reason = "student-other-device";
        } else {
          const reg = { device_id: c.deviceId, adm_no: adm, name: t.name, class_code: t.class_code, registered_at: di?.registered_at || now, last_seen: now };
          devWrites.set(c.deviceId, reg);
          devById.set(c.deviceId, reg);
          devByAdm.set(lower(adm), reg);
          const v = await verifyCode({ sessionId: c.sessionId, w: row.w, token: row.code }, sessions.get(c.sessionId));
          status = v === null ? "pending" : v ? "accepted" : "rejected";
          if (v === false) reason = "invalid-code";
        }
      }
      if (!existing.has(id) || row.status !== status || row.reason !== reason) {
        Object.assign(row, { status, reason, updated_at: now });
        ciWrites.push(row);
        existing.set(id, row);
      }
    }
    if (row.status === "accepted") touched.add(c.sessionId);
    results.push({ id, status: row.status, reason: row.reason, name: t ? t.name : "", classCode: t ? t.class_code : "" });
  }
  const newly = [...new Set(ciWrites.filter((r) => r.status === "accepted").map((r) => r.session_id))].filter((id) => sessions.has(id));
  const accepted = acceptedOf([...existing.values()].filter((r) => r.status === "accepted"));
  const term = termOut(termRows[0]);
  await many(
    env,
    ...upsertStmts("checkins", CICOLS, ciWrites, CIKEY),
    ...upsertStmts("devices", ["device_id", "adm_no", "name", "class_code", "registered_at", "last_seen"], [...devWrites.values()], ["device_id"], ["last_seen"]),
    newly.length && changedStmt(),
    ...upsertStmts("sessions", SCOLS, newly.map((id) => sessionRow(sessions.get(id), accepted[id], term, now)), ["id"])
  );
  return { ok: true, results };
}
__name(receiveCheckins, "receiveCheckins");
var FOLD_DAYS = 150;
async function foldOldCheckins(env, force = false) {
  const last = await getMeta(env, "fold_at");
  if (!force && last && last > new Date(Date.now() - 864e5).toISOString()) return 0;
  const cutoff = new Date(Date.now() - FOLD_DAYS * 864e5).toISOString();
  const ids = (await all(env, "SELECT DISTINCT session_id FROM checkins INDEXED BY checkins_updated WHERE updated_at < ? AND status IN ('accepted','rejected') LIMIT 100", cutoff)).map((r) => r.session_id);
  if (ids.length < 100) await setMeta(env, "fold_at", nowIso());
  if (!ids.length) return 0;
  const J = JSON.stringify(ids);
  const sessions = await all(env, `SELECT id, data FROM sessions WHERE id IN ${IN}`, J);
  const accepted = await acceptedMap(env, ids);
  const writes = [];
  for (const r of sessions) {
    if (!accepted[r.id]) continue;
    const s = JSON.parse(r.data);
    s.qrFolded = { ...s.qrFolded || {}, ...accepted[r.id] };
    writes.push({ id: r.id, data: JSON.stringify(s) });
  }
  if (writes.length) await upsertMany(env, "sessions", ["id", "data"], writes, ["id"], ["data"]);
  await run(env, `DELETE FROM checkins WHERE session_id IN ${IN} AND updated_at < ? AND status IN ('accepted','rejected')`, J, cutoff);
  return ids.length;
}
__name(foldOldCheckins, "foldOldCheckins");
function checkinsQuery(ids, since) {
  if (!ids.length) return ["SELECT 1 AS x WHERE 0"];
  return since ? ["SELECT session_id, adm_no, name, scanned_at FROM checkins INDEXED BY checkins_updated WHERE updated_at > ? AND status='accepted'", since] : [`SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN ${IN}`, JSON.stringify(ids.slice(0, 2e3))];
}
__name(checkinsQuery, "checkinsQuery");
function acceptedCheckins(ids, rows) {
  const want = new Set(ids.slice(0, 2e3));
  const out = {};
  let count = 0;
  for (const r of rows) {
    if (!want.has(r.session_id)) continue;
    (out[r.session_id] = out[r.session_id] || []).push({ admNo: r.adm_no, name: r.name, scannedAt: r.scanned_at });
    count++;
  }
  return { ok: true, serverTime: nowIso(), count, checkins: out };
}
__name(acceptedCheckins, "acceptedCheckins");
var ITEMS = ["CAT1", "CAT2", "CAT3", "CAT4", "PRAC1", "PRAC2", "PRAC3"];
var MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;
var b64u = /* @__PURE__ */ __name((str) => btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "b64u");
var unb64u = /* @__PURE__ */ __name((t) => decodeURIComponent(escape(atob(t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - t.length % 4) % 4)))), "unb64u");
function bridgeSecret(env) {
  if (!env.BRIDGE_SECRET) fail("The Google Drive link is not set up yet: the MIS Officer adds the BRIDGE_SECRET to the Worker (README \u2192 Google Drive).");
  return String(env.BRIDGE_SECRET);
}
__name(bridgeSecret, "bridgeSecret");
async function signTicket(env, payload) {
  const body = b64u(JSON.stringify(payload));
  return body + "." + await hmacHex(body, bridgeSecret(env));
}
__name(signTicket, "signTicket");
async function readTicket(env, ticket, kind, { late = false } = {}) {
  const [body, sig] = String(ticket || "").split(".");
  if (!body || !sig || await hmacHex(body, bridgeSecret(env)) !== sig) fail("That upload ticket is not valid");
  const t = JSON.parse(unb64u(body));
  if (t.k !== kind) fail("That ticket is for something else");
  if (!late && t.exp < Date.now()) fail("That ticket has expired; try again");
  return t;
}
__name(readTicket, "readTicket");
var folderName = /* @__PURE__ */ __name((s) => String(s || "").replace(/[\\:*?"<>|#%]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120), "folderName");
var safeName = /* @__PURE__ */ __name((s) => String(s || "").replace(/[\\/:*?"<>|#%]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120), "safeName");
async function verifyBridge(env, b) {
  const ts = Number(b.ts) || 0;
  if (Math.abs(Date.now() - ts) > 15 * 6e4) fail("Bridge request is too old (check the clock)");
  if (await hmacHex(`${b.action}|${ts}|${b.body || ""}`, bridgeSecret(env)) !== b.sig) fail("Bridge signature does not match: the BRIDGE_SECRET differs");
  return JSON.parse(b.body || "{}");
}
__name(verifyBridge, "verifyBridge");
var BRIDGE_ACTIONS = {
  bridgeFeed: /* @__PURE__ */ __name(async (env, b) => bridgeFeed(env, await verifyBridge(env, b)), "bridgeFeed"),
  bridgeReport: /* @__PURE__ */ __name(async (env, b) => {
    const r = await verifyBridge(env, b);
    await many(env, metaStmt("drive_report", JSON.stringify({ ...r, at: nowIso() })), r.url && metaStmt("drive_url", r.url));
    return { ok: true };
  }, "bridgeReport")
};
var PERIOD_NO = /* @__PURE__ */ __name((p) => {
  const m = /(\d+)/.exec(p || "");
  return m ? Number(m[1]) : 9;
}, "PERIOD_NO");
function buildRegister({ weeks, lessons, roster, alias, rejected, h, latePct, excPct }) {
  const late = latePct / 100, exc = excPct / 100;
  const list = [...lessons].sort((a, c) => (a.date + PERIOD_NO(a.period)).localeCompare(c.date + PERIOD_NO(c.period)));
  const used = weeks.map(() => 0), cellsOf = /* @__PURE__ */ new Map();
  for (const l of list) {
    const w = weeks.indexOf(mondayOf(l.date));
    if (w === -1 || used[w] >= 3) continue;
    const n = Math.min(Number(l.slots) === 2 ? 2 : 1, 3 - used[w]);
    cellsOf.set(l.id, Array.from({ length: n }, (_, k) => w * 3 + used[w] + k));
    used[w] += n;
  }
  const rows = /* @__PURE__ */ new Map();
  const ensure = /* @__PURE__ */ __name((adm, name, pending = false) => {
    if (!rows.has(adm)) rows.set(adm, { admNo: adm, name: name || adm, pending, cells: Array(TERM_WEEKS * 3).fill(""), P: 0, A: 0, L: 0, E: 0, held: 0 });
    return rows.get(adm);
  }, "ensure");
  for (const t of roster) if (!rejected.has(t.admNo)) ensure(t.admNo, t.name, t.pending);
  for (const l of list) {
    const cells = cellsOf.get(l.id);
    if (!cells) continue;
    const marks = {};
    for (const [adm, st] of Object.entries(l.marks)) {
      const to = alias[adm] || adm;
      if (marks[to] && to !== adm) continue;
      marks[to] = st;
    }
    for (const [adm, st] of Object.entries(marks)) {
      if (!"PALE".includes(st) || rejected.has(adm)) continue;
      const r = ensure(adm, l.names[adm]);
      for (const c of cells) {
        r.cells[c] = st;
        r[st]++;
        r.held++;
      }
    }
  }
  return [...rows.values()].sort((a, c) => a.admNo.localeCompare(c.admNo, void 0, { numeric: true })).map((r) => {
    const possible = Math.round(r.held * h * 100) / 100, actual = Math.round((r.P + r.L * late + r.E * exc) * h * 100) / 100;
    return { admNo: r.admNo, name: r.name, pending: r.pending, cells: r.cells, possible, actual, pct: possible ? actual / possible : null };
  });
}
__name(buildRegister, "buildRegister");
var FEED_PAGE = 12;
async function bridgeFeed(env, q2) {
  const since = String(q2.since || ""), offset = Math.max(0, Number(q2.offset) || 0), now = nowIso();
  const [termRows, loading] = await many(env, [TERM_SQL], [`SELECT * FROM loading WHERE term_id=${ACTIVE_TERM}`]);
  const term = termOut(termRows[0]);
  const unitKey = /* @__PURE__ */ __name((u) => u.class_code + "|" + u.unit_code, "unitKey");
  let keys2;
  if (!since) keys2 = loading.map(unitKey);
  else {
    const [sess, tr, rq, so, st, ld, tm, mk] = await many(
      env,
      ["SELECT DISTINCT class_code, unit_code FROM sessions WHERE synced_at > ?", since],
      ["SELECT DISTINCT class_code FROM trainees WHERE updated_at > ? OR added_at > ?", since, since],
      ["SELECT DISTINCT class_code FROM requests WHERE requested_at > ? OR decided_at > ?", since, since],
      ["SELECT DISTINCT class_code, unit_code FROM signoffs WHERE submitted_at > ? OR decided_at > ?", since, since],
      ["SELECT code FROM staff WHERE updated_at > ?", since],
      ["SELECT 1 AS x FROM loading WHERE updated_at > ? LIMIT 1", since],
      ["SELECT 1 AS x FROM terms WHERE updated_at > ? LIMIT 1", since],
      ["SELECT DISTINCT class_code, unit_code FROM unit_marks WHERE synced_at > ?", since]
    );
    const all2 = ld.length || tm.length;
    const want = new Set([...sess, ...so, ...mk].map(unitKey));
    const classes2 = new Set([...tr, ...rq].map((r) => r.class_code)), staffSet = new Set(st.map((r) => lower(r.code)));
    keys2 = loading.filter((u) => all2 || want.has(unitKey(u)) || classParts(u.class_code).some((c) => classes2.has(c)) || staffSet.has(lower(u.trainer_code))).map(unitKey);
  }
  keys2 = [...new Set(keys2)].sort();
  const page = keys2.slice(offset, offset + FEED_PAGE);
  const out = { ok: true, now, term, total: keys2.length, next: offset + FEED_PAGE < keys2.length ? offset + FEED_PAGE : null, units: [] };
  if (offset === 0) {
    const [staffRows, ev] = await many(
      env,
      ["SELECT code, name, drive_folder FROM staff WHERE active=1"],
      ["SELECT * FROM evidence WHERE updated_at > ? ORDER BY updated_at LIMIT 1000", since]
    );
    const codes = new Set(loading.map((u) => lower(u.trainer_code)));
    out.trainers = staffRows.filter((r) => codes.has(lower(r.code))).map((r) => ({ code: r.code, name: r.name, folder: r.drive_folder || "" }));
    out.evidence = ev.map(evidenceOut);
  }
  if (!page.length || !term) return out;
  const units = page.map((k) => loading.find((u) => unitKey(u) === k));
  const classSet = [...new Set(units.flatMap((u) => classParts(u.class_code)))];
  const stmts = units.flatMap((u) => [
    ["SELECT id, data FROM sessions WHERE class_code=? AND unit_code=?", u.class_code, u.unit_code],
    ["SELECT session_id, adm_no, name, scanned_at FROM checkins WHERE status='accepted' AND session_id IN (SELECT id FROM sessions WHERE class_code=? AND unit_code=?)", u.class_code, u.unit_code]
  ]);
  const res = await many(
    env,
    ...stmts,
    [`SELECT adm_no, name, class_code, status, reg_code FROM trainees WHERE class_code IN ${IN}`, JSON.stringify(classSet)],
    [`SELECT adm_no, name, class_code, status, merged_into FROM requests WHERE class_code IN ${IN} AND status IN ('pending','rejected','merged')`, JSON.stringify(units.map((u) => u.class_code))],
    [`SELECT * FROM signoffs WHERE term_id=?`, term.id],
    [`SELECT code, late_pct, excused_pct FROM staff`],
    [`SELECT code, name, mis_class FROM classes WHERE code IN ${IN}`, JSON.stringify(classSet.concat(units.map((u) => u.class_code)))],
    [`SELECT * FROM unit_marks WHERE class_code IN ${IN}`, JSON.stringify(units.map((u) => u.class_code))]
  );
  const [trainees, reqs, signoffs, staffPct, classes, markRows] = res.slice(units.length * 2);
  const weeks = teachingWeeks(term);
  const from = weeks[0], to = (() => {
    const e = /* @__PURE__ */ new Date(weeks[weeks.length - 1] + "T00:00:00Z");
    e.setUTCDate(e.getUTCDate() + 6);
    return e.toISOString().slice(0, 10);
  })();
  units.forEach((u, i) => {
    const accepted = acceptedOf(res[i * 2 + 1]);
    const all2 = res[i * 2].map((r) => {
      const s = JSON.parse(r.data), marks = {}, names = {};
      for (const m of finalMarks(s, accepted[r.id])) {
        const k = STATUS_CODE[m.status];
        if (k) {
          marks[m.admNo] = k;
          names[m.admNo] = m.name;
        }
      }
      return { id: r.id, date: s.date, period: s.period, slots: s.slots, kind: s.kind || "lesson", title: s.title || "", marks, names };
    }).filter((l) => l.date >= from && l.date <= to);
    const parts = classParts(u.class_code);
    const roster = trainees.filter((t) => parts.includes(t.class_code) && active(t)).map((t) => ({ admNo: t.adm_no, name: t.name }));
    const mine = reqs.filter((r) => r.class_code === u.class_code);
    for (const r of mine) if (r.status === "pending" && !roster.some((t) => lower(t.admNo) === lower(r.adm_no))) roster.push({ admNo: r.adm_no, name: r.name, pending: true });
    const rejected = new Set(mine.filter((r) => r.status === "rejected").map((r) => r.adm_no));
    const alias = Object.fromEntries(mine.filter((r) => r.status === "merged" && r.merged_into).map((r) => [r.adm_no, r.merged_into]));
    const pct = staffPct.find((x) => lower(x.code) === lower(u.trainer_code)) || {};
    const h = term.lessonHours || (Number(u.hours_per_week) || 3) / (Number(u.lessons_per_week) || 2);
    const so = signoffs.find((x) => x.class_code === u.class_code && x.unit_code === u.unit_code);
    const lessons = all2.filter((l) => l.kind === "lesson");
    out.units.push({
      key: unitKey(u),
      trainerCode: u.trainer_code,
      trainerName: u.trainer_name,
      classCode: u.class_code,
      unitCode: u.unit_code,
      unitName: u.unit_name,
      misClass: (classes.find((c) => c.code === u.class_code) || {}).mis_class || u.class_code,
      level: levelOf(u.class_code),
      termName: term.name,
      duration: term.duration || "",
      weeks,
      lessonHours: h,
      lessonsHeld: lessons.length,
      rows: buildRegister({ weeks, lessons, roster, alias, rejected, h, latePct: pct.late_pct ?? 50, excPct: pct.excused_pct ?? 100 }),
      lecturerComment: so?.lecturer_comment || "",
      hodComment: so?.hod_comment || "",
      signoff: so?.status || "",
      cats: all2.filter((l) => l.kind !== "lesson").sort((a, c) => a.date.localeCompare(c.date)).map((l) => ({ title: l.title || (l.kind === "cat" ? "CAT" : "Extra"), date: l.date, kind: l.kind, marks: l.marks })),
      marksheet: marksheetOf(u, roster, trainees, markRows, classes, term)
    });
  });
  return out;
}
__name(bridgeFeed, "bridgeFeed");
function marksheetOf(u, roster, trainees, markRows, classes, term) {
  const mine = markRows.filter((m) => m.class_code === u.class_code && m.unit_code === u.unit_code);
  const byAdm = new Map(mine.map((m) => [lower(m.adm_no), m])), reg = new Map(trainees.map((t) => [lower(t.adm_no), t.reg_code || ""]));
  const cls = classes.find((c) => c.code === u.class_code) || classes.find((c) => classParts(u.class_code).includes(c.code)) || {};
  const rows = [...roster].sort((a, c) => String(a.admNo).localeCompare(String(c.admNo))).map((t) => {
    const m = byAdm.get(lower(t.admNo)) || {};
    return { admNo: t.admNo, name: t.name, regCode: reg.get(lower(t.admNo)) || "", cat: ["cat1", "cat2", "cat3"].map((c) => m[c] ?? ""), prac: ["prac1", "prac2", "prac3"].map((c) => m[c] ?? "") };
  });
  return { courseCode: cls.mis_class || u.class_code, courseName: cls.name && cls.name !== cls.code ? cls.name : cls.mis_class || u.class_code, series: term.series || "", entered: mine.length, rows };
}
__name(marksheetOf, "marksheetOf");
var NUDGE_EVERY_MS = 6e4;
var nudgedAt = 0;
async function nudgeDrive(env) {
  const now = Date.now();
  if (!env.BRIDGE_SECRET || now - nudgedAt < NUDGE_EVERY_MS) return "skipped";
  nudgedAt = now;
  const url = await getMeta(env, "drive_url");
  if (!url) return "no-bridge";
  const claim = await run(env, `INSERT INTO meta (key,value) VALUES ('drive_nudged_at', ?1)
    ON CONFLICT(key) DO UPDATE SET value=?1 WHERE CAST(meta.value AS INTEGER) < ?2`, String(now), now - NUDGE_EVERY_MS);
  if (!claim.meta?.changes) return "skipped";
  const ts = now, body = "{}";
  const payload = JSON.stringify({ action: "nudge", ts, body, sig: await hmacHex(`nudge|${ts}|${body}`, bridgeSecret(env)) });
  const res = await fetch(url, { method: "POST", redirect: "follow", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: payload });
  if (!res.ok) {
    console.error(`nudge: the Drive bridge answered ${res.status}`);
    return "error";
  }
  return "sent";
}
__name(nudgeDrive, "nudgeDrive");
var PUSH_MAX = 8;
var MAX_SUBS = 4;
var PUSH_GIVE_UP = 10;
var bytesB64u = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "bytesB64u");
var b64uBytes = /* @__PURE__ */ __name((s) => {
  const x = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(x + "=".repeat((4 - x.length % 4) % 4)), (c) => c.charCodeAt(0));
}, "b64uBytes");
var vapidKey = null;
async function vapidKeys(env) {
  if (vapidKey) return vapidKey;
  const raw = String(env.VAPID_PRIVATE_KEY || "").trim();
  if (!raw) fail("Notifications are not set up on the server yet (the Worker has no VAPID_PRIVATE_KEY).");
  let jwk;
  if (raw.startsWith("{")) jwk = JSON.parse(raw);
  else {
    const pub = b64uBytes(env.VAPID_PUBLIC_KEY || "");
    if (pub.length !== 65 || pub[0] !== 4) fail("Notifications: with a plain private key, add VAPID_PUBLIC_KEY to the Worker as well.");
    jwk = { d: raw.replace(/=+$/, ""), x: bytesB64u(pub.slice(1, 33)), y: bytesB64u(pub.slice(33)) };
  }
  if (!jwk.d || !jwk.x || !jwk.y) fail("Notifications: VAPID_PRIVATE_KEY is not a P-256 key (see the README).");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return vapidKey = { key, pub: bytesB64u(new Uint8Array([4, ...b64uBytes(jwk.x), ...b64uBytes(jwk.y)])) };
}
__name(vapidKeys, "vapidKeys");
var vapidTokens = /* @__PURE__ */ new Map();
async function vapidAuth(env, origin) {
  const { key, pub } = await vapidKeys(env);
  const have = vapidTokens.get(origin);
  if (have && have.until > Date.now()) return { token: have.token, pub };
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claim = b64u(JSON.stringify({ aud: origin, exp: Math.floor(Date.now() / 1e3) + 23 * 3600, sub: String(env.VAPID_SUBJECT || "mailto:ict@rvnp.ac.ke") }));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claim));
  const token = `${head}.${claim}.${bytesB64u(new Uint8Array(sig))}`;
  vapidTokens.set(origin, { token, until: Date.now() + 12 * 36e5 });
  return { token, pub };
}
__name(vapidAuth, "vapidAuth");
async function pushToStudent(env, admNo) {
  const subs = await all(env, "SELECT endpoint FROM push_subs WHERE adm_no=? ORDER BY last_ok_at DESC LIMIT ?", admNo, PUSH_MAX);
  if (!subs.length) return 0;
  const now = nowIso(), gone = [], good = [], bad = [];
  for (const s of subs) {
    try {
      const { token, pub } = await vapidAuth(env, new URL(s.endpoint).origin);
      const res = await fetch(s.endpoint, { method: "POST", headers: { Authorization: `vapid t=${token}, k=${pub}`, TTL: "86400", Urgency: "normal" } });
      if (res.status === 404 || res.status === 410) gone.push(s.endpoint);
      else if (res.ok) good.push(s.endpoint);
      else {
        bad.push(s.endpoint);
        console.error(`push: ${new URL(s.endpoint).host} answered ${res.status}`);
      }
    } catch (e) {
      bad.push(s.endpoint);
      console.error("push", e);
    }
  }
  await many(
    env,
    good.length && [`UPDATE push_subs SET last_ok_at=?, fail_count=0 WHERE endpoint IN ${IN}`, now, JSON.stringify(good)],
    bad.length && [`UPDATE push_subs SET fail_count=COALESCE(fail_count,0)+1 WHERE endpoint IN ${IN}`, JSON.stringify(bad)],
    gone.length && [`DELETE FROM push_subs WHERE endpoint IN ${IN}`, JSON.stringify(gone)],
    bad.length && ["DELETE FROM push_subs WHERE fail_count >= ?", PUSH_GIVE_UP]
  );
  return good.length;
}
__name(pushToStudent, "pushToStudent");
function pushLater(ctx, env, admNo) {
  if (!ctx?.waitUntil || !env.VAPID_PRIVATE_KEY || !admNo) return;
  ctx.waitUntil(pushToStudent(env, admNo).catch((e) => console.error("push", e)));
}
__name(pushLater, "pushLater");
var noticeOut = /* @__PURE__ */ __name((r) => ({
  kind: "evidence",
  id: r.id,
  item: r.item,
  unitCode: r.unit_code,
  unitName: r.unit_name || r.unit_code,
  version: r.version,
  status: r.status,
  comment: r.comment || "",
  decidedName: r.decided_name || "",
  decidedAt: r.decided_at || ""
}), "noticeOut");
async function studentOf(env, b) {
  const [tRows, dRows] = await many(env, ["SELECT * FROM trainees WHERE adm_no=?", String(b.admNo || "").trim()], ["SELECT * FROM devices WHERE device_id=?", String(b.deviceId || "")]);
  const t = tRows[0], d = dRows[0];
  if (!t || !active(t)) fail("That student is not on the class list");
  if (!d || lower(d.adm_no) !== lower(t.adm_no)) fail("This phone is not registered to that student. Set up the phone first.");
  return t;
}
__name(studentOf, "studentOf");
var unitsForClass = /* @__PURE__ */ __name((loading, cls) => loading.filter((u) => classParts(u.class_code).includes(cls) || u.class_code === cls), "unitsForClass");
async function classUnits(env, cls) {
  if (!cls) fail("Choose a class");
  const [loading, url, now] = await many(
    env,
    [`SELECT l.class_code, l.unit_code, l.unit_name, l.term_id FROM loading l LEFT JOIN terms t ON t.id=l.term_id ORDER BY t.start_date DESC`],
    ["SELECT value FROM meta WHERE key='drive_url'"],
    [TERM_SQL]
  );
  const activeId = now[0]?.id || "", seen = /* @__PURE__ */ new Map(), units = [];
  for (const u of unitsForClass(loading, cls)) {
    const current = u.term_id === activeId, had = seen.get(u.unit_code);
    if (had) {
      if (current && !had.current) {
        had.current = true;
        had.name = u.unit_name || had.name;
      }
      continue;
    }
    const x = { code: u.unit_code, name: u.unit_name || u.unit_code, current };
    seen.set(u.unit_code, x);
    units.push(x);
  }
  units.sort((a, b) => b.current - a.current || a.name.localeCompare(b.name));
  return { ok: true, classCode: cls, units, items: ITEMS, driveReady: !!url[0], pushReady: !!env.VAPID_PRIVATE_KEY };
}
__name(classUnits, "classUnits");
var evidenceOut = /* @__PURE__ */ __name((r) => ({
  id: r.id,
  admNo: r.adm_no,
  name: r.name,
  classCode: r.class_code,
  unitCode: r.unit_code,
  unitName: r.unit_name,
  item: r.item,
  version: r.version,
  fileId: r.file_id,
  fileName: r.file_name,
  bytes: r.bytes,
  pages: r.pages,
  submittedAt: r.submitted_at,
  status: r.status,
  decidedName: r.decided_name || "",
  decidedAt: r.decided_at || "",
  comment: r.comment || "",
  receivedAt: r.received_at || "",
  updatedAt: r.updated_at
}), "evidenceOut");
var STUDENT_ACTIONS = {
  /** Every lesson of this student's class with their mark, so the student keeps a copy of their own attendance. */
  async myAttendance(env, b) {
    const t = await studentOf(env, b);
    const [rows, acc] = await many(
      env,
      [`SELECT s.id, s.date, s.unit_code, s.unit_name, s.period, COALESCE(s.kind,'lesson') AS kind, s.slots, json_extract(m.value,'$.status') AS status
        FROM sessions s, json_each(s.data, '$.marks') m
        WHERE (s.class_code=?1 OR instr(s.class_code, ?1) > 0) AND lower(json_extract(m.value,'$.admNo'))=lower(?2)
        ORDER BY s.date DESC, s.period LIMIT 800`, t.class_code, t.adm_no],
      ["SELECT session_id FROM checkins WHERE adm_no=? AND status='accepted'", t.adm_no]
    );
    const qr = new Set(acc.map((r) => r.session_id));
    return { ok: true, serverTime: nowIso(), lessons: rows.map((r) => ({
      id: r.id,
      date: r.date,
      unitCode: r.unit_code,
      unitName: r.unit_name || r.unit_code,
      period: r.period,
      kind: r.kind,
      slots: Number(r.slots) === 2 ? 2 : 1,
      status: qr.has(r.id) && r.status !== "Late" ? "Present" : r.status || ""
    })) };
  },
  async poeTicket(env, b) {
    const t = await studentOf(env, b);
    const item = String(b.item || "").toUpperCase();
    if (!ITEMS.includes(item)) fail("Choose CAT1\u2013CAT4 or PRAC1\u2013PRAC3");
    if (Number(b.bytes) > MAX_EVIDENCE_BYTES) fail("That file is over 20 MB. Scan fewer pages or use the Document filter.");
    const [loading, ver, url] = await many(
      env,
      [`SELECT l.unit_code, l.unit_name, l.class_code FROM loading l LEFT JOIN terms t ON t.id=l.term_id WHERE l.unit_code=? ORDER BY t.start_date DESC`, String(b.unitCode || "")],
      ["SELECT MAX(version) AS v FROM evidence WHERE adm_no=? AND unit_code=? AND item=?", t.adm_no, String(b.unitCode || ""), item],
      ["SELECT value FROM meta WHERE key='drive_url'"]
    );
    const unit = unitsForClass(loading, t.class_code)[0];
    if (!unit) fail("That unit has not been taught to your class");
    if (!url[0]) fail("Evidence uploads are not switched on yet (the Google Drive link is not set up). Your scan is kept on this phone.");
    const v = (Number(ver[0]?.v) || 0) + 1, unitName = unit.unit_name || unit.unit_code;
    const fileName = `${safeName(unitName)} - ${item} - v${v}.pdf`;
    const ticket = await signTicket(env, {
      k: "up",
      id: crypto.randomUUID(),
      adm: t.adm_no,
      sname: t.name,
      cls: t.class_code,
      unit: unit.unit_code,
      unitName,
      item,
      v,
      name: fileName,
      folders: [safeName(t.class_code), folderName(`${t.adm_no} - ${t.name}`)],
      bytes: Number(b.bytes) || 0,
      pages: Number(b.pages) || 0,
      exp: Date.now() + 6 * 36e5
    });
    return { ok: true, ticket, driveUrl: url[0].value, fileName, version: v };
  },
  /** After the bridge saved the file: it signed what it saved, so the record cannot be made up. */
  async poeDone(env, b) {
    const t = await readTicket(env, b.ticket, "up", { late: true });
    if (await hmacHex(`done|${t.id}|${b.fileId}|${b.version}|${b.fileName}`, bridgeSecret(env)) !== b.sig) fail("The Drive bridge did not confirm this file");
    const now = nowIso();
    await run(
      env,
      `INSERT INTO evidence (id,adm_no,name,class_code,unit_code,unit_name,item,version,file_id,file_name,bytes,pages,submitted_at,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'submitted',?) ON CONFLICT(id) DO NOTHING`,
      t.id,
      t.adm,
      t.sname,
      t.cls,
      t.unit,
      t.unitName,
      t.item,
      Number(b.version) || t.v,
      String(b.fileId),
      String(b.fileName),
      t.bytes,
      t.pages,
      now,
      now
    );
    return { ok: true, evidence: evidenceOut(await one(env, "SELECT * FROM evidence WHERE id=?", t.id)) };
  },
  async poeMine(env, b) {
    const t = await studentOf(env, b);
    return { ok: true, evidence: (await all(env, "SELECT * FROM evidence WHERE adm_no=? ORDER BY submitted_at DESC", t.adm_no)).map(evidenceOut) };
  },
  /** The student turned notifications on. The address comes from the browser and is only an address:
   *  nothing private is kept, and only this student's registered phone can add or remove one. */
  async pushSubscribe(env, b) {
    const t = await studentOf(env, b);
    const endpoint = String(b.endpoint || "").trim();
    if (!/^https:\/\/\S{10,900}$/.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(endpoint)) {
      fail("That notification address does not look right");
    }
    const now = nowIso();
    await many(
      env,
      [
        "INSERT INTO push_subs (endpoint,adm_no,device_id,created_at,last_ok_at,fail_count) VALUES (?,?,?,?,?,0) ON CONFLICT(endpoint) DO UPDATE SET adm_no=excluded.adm_no, device_id=excluded.device_id, fail_count=0",
        endpoint,
        t.adm_no,
        String(b.deviceId || ""),
        now,
        now
      ],
      // Only the newest few are kept, so changing phone or browser does not leave old addresses behind.
      ["DELETE FROM push_subs WHERE adm_no=? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE adm_no=? ORDER BY created_at DESC LIMIT ?)", t.adm_no, t.adm_no, MAX_SUBS]
    );
    return { ok: true, on: true };
  },
  async pushUnsubscribe(env, b) {
    const t = await studentOf(env, b);
    await run(env, "DELETE FROM push_subs WHERE endpoint=? AND adm_no=?", String(b.endpoint || ""), t.adm_no);
    return { ok: true, on: false };
  },
  /** What to tell this student, and nothing they have already been told. `seen` marks notices read,
   *  so the same decision is never shown twice. More kinds can be added to the list later (each one
   *  carries its own `kind`), for example a warning when attendance falls below the minimum. */
  async notices(env, b) {
    const t = await studentOf(env, b);
    const seen = (b.seen || []).map(String).filter(Boolean).slice(0, 50);
    if (seen.length) await run(env, `UPDATE evidence SET seen_at=? WHERE adm_no=? AND seen_at IS NULL AND id IN ${IN}`, nowIso(), t.adm_no, JSON.stringify(seen));
    const rows = await all(env, "SELECT * FROM evidence WHERE adm_no=? AND status IN ('approved','returned') AND seen_at IS NULL ORDER BY decided_at DESC LIMIT 20", t.adm_no);
    return { ok: true, notices: rows.map(noticeOut) };
  }
};
async function myUnitPairs(env, me) {
  const loading = await all(env, `SELECT class_code, unit_code, unit_name, trainer_code FROM loading WHERE term_id=${ACTIVE_TERM}`);
  const mine = loading.filter((u) => lower(u.trainer_code) === lower(me.code));
  return { loading, pairs: new Set(mine.flatMap((u) => classParts(u.class_code).map((c) => c + "|" + u.unit_code))) };
}
__name(myUnitPairs, "myUnitPairs");
var seesAll = /* @__PURE__ */ __name((me) => me.roles.includes("HOD") || me.roles.includes("MIS"), "seesAll");
async function everTaught(env, me) {
  const rows = await all(env, "SELECT DISTINCT class_code, unit_code FROM loading WHERE trainer_code=?", me.code);
  return new Set(rows.flatMap((u) => classParts(u.class_code).map((c) => c + "|" + u.unit_code)));
}
__name(everTaught, "everTaught");
async function poeList(env, b, me) {
  const { pairs: now } = await myUnitPairs(env, me);
  const pairs = seesAll(me) ? now : /* @__PURE__ */ new Set([...now, ...await everTaught(env, me)]);
  const status = ["submitted", "approved", "returned"].includes(b.status) ? b.status : "";
  let list = [];
  if (seesAll(me)) {
    list = status ? await all(env, "SELECT * FROM evidence WHERE status=? ORDER BY submitted_at DESC LIMIT 3000", status) : await all(env, "SELECT * FROM evidence ORDER BY submitted_at DESC LIMIT 3000");
  } else {
    const keys2 = [...pairs].map((k) => k.split("|"));
    for (let i = 0; i < keys2.length; i += 40) {
      const part = keys2.slice(i, i + 40);
      const rows = await all(
        env,
        `SELECT * FROM evidence WHERE (${part.map(() => "(class_code=? AND unit_code=?)").join(" OR ")})${status ? " AND status=?" : ""}`,
        ...part.flat(),
        ...status ? [status] : []
      );
      list.push(...rows);
    }
    list.sort((a, c) => String(c.submitted_at).localeCompare(String(a.submitted_at)));
  }
  const rep = JSON.parse(await getMeta(env, "drive_report") || "null") || {};
  const sheetUrl = Object.entries(rep.sheets || {}).find(([c]) => lower(c) === lower(me.code))?.[1] || "";
  return { ok: true, evidence: list.map(evidenceOut), mine: [...now], sheetUrl, indexUrl: seesAll(me) ? rep.indexUrl || "" : "", driveReady: !!rep.url };
}
__name(poeList, "poeList");
async function evidenceFor(env, id, me, decide) {
  const r = await one(env, "SELECT * FROM evidence WHERE id=?", String(id || ""));
  if (!r) fail("That submission no longer exists");
  const { pairs, loading } = await myUnitPairs(env, me);
  const key = r.class_code + "|" + r.unit_code;
  let ok = pairs.has(key) || me.roles.includes("HOD") || !decide && (me.roles.includes("MIS") || (await everTaught(env, me)).has(key));
  if (!ok && decide && !unitsForClass(loading.filter((u) => u.unit_code === r.unit_code), r.class_code).length) {
    const past = await all(env, "SELECT l.class_code, l.trainer_code FROM loading l LEFT JOIN terms t ON t.id=l.term_id WHERE l.unit_code=? ORDER BY t.start_date DESC", r.unit_code);
    const last = unitsForClass(past, r.class_code)[0];
    ok = !!last && lower(last.trainer_code) === lower(me.code);
  }
  if (!ok) fail("Only the trainer of this unit or the HOD can do that");
  return r;
}
__name(evidenceFor, "evidenceFor");
async function poeView(env, b, me) {
  const r = await evidenceFor(env, b.id, me, false);
  const url = await getMeta(env, "drive_url");
  if (!url) fail("The Google Drive link is not set up yet");
  return { ok: true, driveUrl: url, fileName: r.file_name, ticket: await signTicket(env, { k: "view", fileId: r.file_id, exp: Date.now() + 10 * 6e4 }) };
}
__name(poeView, "poeView");
async function poeDecide(env, b, me, ctx) {
  const r = await evidenceFor(env, b.id, me, true);
  if (!["approved", "returned"].includes(b.decision)) fail("Choose approve or return");
  const comment = String(b.comment || "").trim().slice(0, 500);
  if (b.decision === "returned" && !comment) fail("Say what needs fixing when returning evidence");
  const now = nowIso();
  await run(env, "UPDATE evidence SET status=?, decided_by=?, decided_name=?, decided_at=?, comment=?, updated_at=?, seen_at=NULL WHERE id=?", b.decision, me.code, me.name, now, comment, now, r.id);
  await audit(env, me, "evidence", `${r.adm_no} ${r.unit_code} ${r.item} v${r.version} ${b.decision}`);
  pushLater(ctx, env, r.adm_no);
  return { ok: true, evidence: evidenceOut(await one(env, "SELECT * FROM evidence WHERE id=?", r.id)) };
}
__name(poeDecide, "poeDecide");
async function poeReceive(env, b, me) {
  const ids = (b.ids || []).map(String).slice(0, 1e3), now = nowIso();
  await run(env, `UPDATE evidence SET received_at=?, updated_at=? WHERE status='approved' AND received_at IS NULL AND id IN ${IN}`, now, now, JSON.stringify(ids));
  await audit(env, me, "evidence received", `${ids.length} file(s)`);
  return { ok: true };
}
__name(poeReceive, "poeReceive");
var MARK_COLS = ["cat1", "cat2", "cat3", "prac1", "prac2", "prac3"];
var markOf = /* @__PURE__ */ __name((v) => {
  if (v === "" || v === null || v === void 0) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) fail("Marks are percentages from 0 to 100");
  return Math.round(n * 10) / 10;
}, "markOf");
var marksOut = /* @__PURE__ */ __name((r) => ({ admNo: r.adm_no, ...Object.fromEntries(MARK_COLS.map((c) => [c, r[c] ?? null])), updatedAt: r.updated_at, updatedBy: r.updated_by || "" }), "marksOut");
var metaOf = /* @__PURE__ */ __name((r) => {
  try {
    return JSON.parse(r?.meta || "{}") || {};
  } catch {
    return {};
  }
}, "metaOf");
function lockedCells(r, activeId, open, cls, unit) {
  const meta = metaOf(r);
  return MARK_COLS.filter((c) => {
    const t = meta[c]?.term;
    return t && activeId && t !== activeId && !open.has(`${t}|${cls}|${unit}`);
  });
}
__name(lockedCells, "lockedCells");
async function marksAccess(env, me, cls, unit, write) {
  if (!cls || !unit) fail("Choose the class and unit");
  if (me.roles.includes("HOD") || !write && me.roles.includes("MIS")) return;
  const { pairs } = await myUnitPairs(env, me);
  if (!pairs.has(cls + "|" + unit)) fail("Only the trainer of this unit (or the HOD) can enter its marks");
}
__name(marksAccess, "marksAccess");
async function marksPull(env, b, me) {
  const cls = String(b.classCode || ""), unit = String(b.unitCode || "");
  await marksAccess(env, me, cls, unit, false);
  const [rows, termRows] = await many(env, ["SELECT * FROM unit_marks WHERE class_code=? AND unit_code=?", cls, unit], [TERM_SQL]);
  const activeId = termRows[0]?.id || "", open = await unlockedSet(env);
  const terms = Object.fromEntries((await all(env, "SELECT id, name FROM terms")).map((x) => [x.id, x.name]));
  return {
    ok: true,
    classCode: cls,
    unitCode: unit,
    activeTerm: activeId,
    rows: rows.map((r) => {
      const meta = metaOf(r);
      return {
        ...marksOut(r),
        locked: lockedCells(r, activeId, open, cls, unit),
        terms: Object.fromEntries(MARK_COLS.filter((c) => meta[c]?.term).map((c) => [c, terms[meta[c].term] || meta[c].term]))
      };
    }),
    lockedTerms: [...new Set(rows.flatMap((r) => lockedCells(r, activeId, open, cls, unit).map((c) => metaOf(r)[c].term)))].map((id) => ({ id, name: terms[id] || id }))
  };
}
__name(marksPull, "marksPull");
async function marksPush(env, b, me) {
  const term = await activeTerm(env);
  if (!term) fail("The MIS Officer has not set up the term yet");
  const cls = String(b.classCode || ""), unit = String(b.unitCode || "");
  await marksAccess(env, me, cls, unit, true);
  const now = nowIso(), open = await unlockedSet(env);
  const incoming = (b.rows || []).slice(0, 400).filter((r) => r && r.admNo);
  const have = new Map((await all(
    env,
    `SELECT * FROM unit_marks WHERE class_code=? AND unit_code=? AND adm_no IN ${IN}`,
    cls,
    unit,
    JSON.stringify(incoming.map((r) => String(r.admNo).trim()))
  )).map((r) => [lower(r.adm_no), r]));
  let held = 0;
  const writes = [];
  for (const r of incoming) {
    const adm = String(r.admNo).trim(), old = have.get(lower(adm));
    const at = String(r.updatedAt || now) > now ? now : String(r.updatedAt || now);
    if (old && String(old.updated_at || "") > at) continue;
    const meta = metaOf(old), locked = new Set(old ? lockedCells(old, term.id, open, cls, unit) : []);
    const vals = MARK_COLS.map((c) => {
      const v = markOf(r[c]), was = old ? old[c] ?? null : null;
      if (v === was) return was;
      if (locked.has(c)) {
        held++;
        return was;
      }
      meta[c] = { term: term.id, by: me.code, at: now };
      return v;
    });
    writes.push([cls, unit, adm, ...vals, JSON.stringify(meta), at, me.code, now]);
  }
  const sql = `INSERT INTO unit_marks (class_code,unit_code,adm_no,${MARK_COLS.join(",")},meta,updated_at,updated_by,synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(class_code,unit_code,adm_no) DO UPDATE SET ${MARK_COLS.map((c) => `${c}=excluded.${c}`).join(", ")}, meta=excluded.meta, updated_at=excluded.updated_at,
    updated_by=excluded.updated_by, synced_at=excluded.synced_at`;
  for (let i = 0; i < writes.length; i += 50) await many(env, ...writes.slice(i, i + 50).map((w) => [sql, ...w]));
  if (writes.length) await audit(env, me, "marks", `${cls} ${unit}: ${writes.length} student(s)${held ? `, ${held} locked mark(s) kept` : ""}`);
  return { ...await marksPull(env, b, me), held };
}
__name(marksPush, "marksPush");
async function importRegCodes(env, b, me) {
  const pairs = (b.rows || []).map((r) => [String(r.admNo || "").trim(), String(r.regCode || "").trim()]).filter(([a, c]) => a && c).slice(0, 5e3);
  if (!pairs.length) fail("No admission numbers with registration codes were found in that file");
  const known = new Set((await all(env, `SELECT adm_no FROM trainees WHERE adm_no IN ${IN}`, JSON.stringify(pairs.map((p) => p[0])))).map((r) => lower(r.adm_no)));
  const use = pairs.filter(([a]) => known.has(lower(a))), now = nowIso();
  for (let i = 0; i < use.length; i += 50) await many(env, ...use.slice(i, i + 50).map(([a, c]) => ["UPDATE trainees SET reg_code=?, updated_at=? WHERE adm_no=?", c, now, a]));
  await audit(env, me, "registration codes", `${use.length} of ${pairs.length}`);
  if (use.length) await bumpRoster(env);
  return { ok: true, updated: use.length, unknown: pairs.filter(([a]) => !known.has(lower(a))).map(([a]) => a).slice(0, 50), total: pairs.length };
}
__name(importRegCodes, "importRegCodes");
async function poeClass(env, b) {
  const loading = await all(env, `SELECT class_code, unit_code, unit_name FROM loading WHERE term_id=${ACTIVE_TERM}`);
  const classes = [...new Set(loading.flatMap((u) => classParts(u.class_code)))].sort();
  const cls = String(b.classCode || "");
  if (!cls) return { ok: true, classes };
  const seen = /* @__PURE__ */ new Set(), units = [];
  for (const u of unitsForClass(loading, cls)) if (!seen.has(u.unit_code)) {
    seen.add(u.unit_code);
    units.push({ code: u.unit_code, name: u.unit_name || u.unit_code });
  }
  const students = (await all(env, `SELECT adm_no, name FROM trainees WHERE class_code=? AND COALESCE(status,'') NOT IN ${GONE} ORDER BY name`, cls)).map((r) => ({ admNo: r.adm_no, name: r.name || r.adm_no }));
  return { ok: true, classes, classCode: cls, units, students };
}
__name(poeClass, "poeClass");
async function driveStatus(env) {
  const r = await getMeta(env, "drive_report");
  return { ok: true, secret: !!env.BRIDGE_SECRET, report: r ? JSON.parse(r) : null };
}
__name(driveStatus, "driveStatus");
var internals = {
  all,
  one,
  run,
  many,
  finalMarks,
  acceptedMap,
  setMeta,
  getMeta,
  teachingWeeks,
  activeTerm,
  weekOf,
  nudgeDrive,
  pushToStudent,
  resetCaches() {
    schemaReady = false;
    secretCache = null;
    keys.clear();
    vapidKey = null;
    vapidTokens.clear();
    nudgedAt = 0;
  },
  resetNudge() {
    nudgedAt = 0;
  }
};

// dev.js
var SAMPLE = `INSERT INTO classes (code,name,level) VALUES ('ICT6A','Diploma in ICT L6 - Sept 2025 A','6'),('ICT5B','Certificate in ICT L5 - Jan 2026 B','5');
INSERT INTO units (class_code,code,name) VALUES ('ICT6A','PROG-601','Object Oriented Programming (Java)'),('ICT6A','NET-602','Computer Networking'),('ICT5B','APP-501','Computer Applications'),('ICT5B','PROG-502','Fundamentals of Programming');
INSERT INTO trainees (adm_no,name,class_code,status) VALUES ('RVNP/ICT/0101','Achieng Mary Otieno','ICT6A','active'),('RVNP/ICT/0102','Brian Kiprono Rotich','ICT6A','active'),('RVNP/ICT/0201','Ian Kipchumba Kirui','ICT5B','active'),('RVNP/ICT/0202','Joy Akinyi Ochieng','ICT5B','active');`;
var TABLES = ["meta", "staff", "login_fails", "terms", "classes", "units", "loading", "trainees", "requests", "sessions", "checkins", "devices", "signoffs", "audit", "evidence", "marks", "push_subs", "unit_marks", "unlocks"];
var CORS = { "Access-Control-Allow-Origin": "*" };
var yn = /* @__PURE__ */ __name((v) => v ? "Yes" : "No", "yn");
var blank = /* @__PURE__ */ __name((v) => v === null || v === void 0 ? "" : v, "blank");
async function reset(env) {
  await env.DB.exec(TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join("\n"));
  internals.resetCaches();
  await worker_default.fetch(new Request("http://x/?action=ping"), env);
  await env.DB.exec(SAMPLE);
  await setStaffPin(env, "MIS", "2468", false, { name: "MIS Officer", roles: "MIS" });
}
__name(reset, "reset");
async function dump(env) {
  const all2 = /* @__PURE__ */ __name((sql) => internals.all(env, sql), "all");
  const out = {};
  out.Staff = [
    ["StaffCode", "Name", "Roles", "Responsibility", "Active", "PinHash", "PinSalt", "PinVersion", "MustChange", "LatePct", "ExcusedPct", "UpdatedAt"],
    ...(await all2("SELECT * FROM staff")).map((r) => [r.code, r.name, r.roles, r.responsibility, yn(r.active), blank(r.pin_hash), blank(r.pin_salt), r.pin_version, yn(r.must_change), blank(r.late_pct), blank(r.excused_pct), r.updated_at])
  ];
  out.Terms = [
    ["TermID", "Name", "Duration", "StartDate", "Weeks", "Breaks", "Status", "UpdatedAt"],
    ...(await all2("SELECT * FROM terms")).map((r) => [r.id, r.name, r.duration, r.start_date, r.weeks, r.breaks, r.status, r.updated_at])
  ];
  out.Classes = [
    ["ClassCode", "ClassName", "Level", "MisClass", "Population"],
    ...(await all2("SELECT * FROM classes")).map((r) => [r.code, r.name, r.level, blank(r.mis_class), blank(r.population)])
  ];
  out.Units = [["ClassCode", "UnitCode", "UnitName"], ...(await all2("SELECT * FROM units")).map((r) => [r.class_code, r.code, r.name])];
  out.Loading = [
    ["LoadID", "TermID", "ClassCode", "UnitCode", "UnitName", "TrainerCode", "TrainerName", "LessonsPerWeek", "HoursPerWeek", "Population", "UpdatedAt"],
    ...(await all2("SELECT * FROM loading")).map((r) => [`${r.term_id}|${r.class_code}|${r.unit_code}`, r.term_id, r.class_code, r.unit_code, r.unit_name, r.trainer_code, r.trainer_name, r.lessons_per_week, r.hours_per_week, blank(r.population), r.updated_at])
  ];
  out.Trainees = [
    ["AdmNo", "Name", "ClassCode", "Active", "Status", "MisClass", "AddedBy", "AddedAt", "UpdatedBy", "UpdatedAt", "Note"],
    ...(await all2("SELECT * FROM trainees")).map((r) => [r.adm_no, r.name, r.class_code, yn(!/withdrawn|rejected/i.test(r.status || "")), blank(r.status), blank(r.mis_class), blank(r.added_by), blank(r.added_at), blank(r.updated_by), blank(r.updated_at), blank(r.note)])
  ];
  out.Requests = [
    ["RequestID", "AdmNo", "Name", "ClassCode", "Reason", "RequestedBy", "RequestedName", "RequestedAt", "Status", "DecidedBy", "DecidedAt", "MergedInto", "Note"],
    ...(await all2("SELECT * FROM requests")).map((r) => [r.id, r.adm_no, r.name, r.class_code, r.reason, r.requested_by, r.requested_name, r.requested_at, r.status, blank(r.decided_by), blank(r.decided_at), blank(r.merged_into), blank(r.note)])
  ];
  const sessions = await all2("SELECT * FROM sessions ORDER BY synced_at");
  const accepted = await internals.acceptedMap(env, sessions.map((r) => r.id));
  out.Sessions = [["SessionID", "Date", "ClassCode", "ClassName", "UnitCode", "UnitName", "Period", "TrainerID", "TrainerName", "Present", "Absent", "Late", "Excused", "Total", "AttendancePct", "Notes", "Edits", "DeviceID", "CreatedAt", "UpdatedAt", "SyncedAt", "TermID", "Week"]];
  out.Attendance = [["RecordID", "SessionID", "Date", "ClassCode", "UnitCode", "UnitName", "Period", "AdmNo", "Name", "Status", "TrainerID", "TrainerName", "UpdatedAt", "SyncedAt", "Source"]];
  out.SessionData = [["SessionID", "UpdatedAt", "Json"]];
  for (const r of sessions) {
    const s = JSON.parse(r.data);
    out.Sessions.push([
      r.id,
      r.date,
      r.class_code,
      blank(s.className),
      r.unit_code,
      r.unit_name,
      r.period,
      r.trainer_id,
      r.trainer_name,
      r.present,
      r.absent,
      r.late,
      r.excused,
      r.total,
      blank(r.pct),
      blank(s.notes),
      Number(s.edits) || 0,
      blank(s.deviceId),
      blank(s.createdAt),
      r.updated_at,
      r.synced_at,
      blank(r.term_id),
      blank(r.week)
    ]);
    for (const m of internals.finalMarks(s, accepted[r.id])) {
      out.Attendance.push([`${r.id}|${m.admNo}`, r.id, s.date, s.classCode, s.unitCode, s.unitName, s.period, m.admNo, m.name, m.status, s.trainerId, s.trainerName, s.updatedAt, r.synced_at, m.source]);
    }
    out.SessionData.push([r.id, r.updated_at, r.data]);
  }
  out.SignOffs = [
    ["SignOffID", "TermID", "ClassCode", "UnitCode", "UnitName", "TrainerCode", "TrainerName", "LecturerComment", "SubmittedAt", "Status", "HodCode", "HodName", "HodComment", "DecidedAt"],
    ...(await all2("SELECT * FROM signoffs")).map((r) => [r.id, r.term_id, r.class_code, r.unit_code, r.unit_name, r.trainer_code, r.trainer_name, blank(r.lecturer_comment), r.submitted_at, r.status, blank(r.hod_code), blank(r.hod_name), blank(r.hod_comment), blank(r.decided_at)])
  ];
  out.CheckIns = [
    ["CheckInID", "SessionID", "AdmNo", "Name", "ClassCode", "DeviceID", "Window", "Code", "ScannedAt", "UpdatedAt", "Status", "Reason"],
    ...(await all2("SELECT * FROM checkins ORDER BY updated_at")).map((r) => [`${r.session_id}|${r.adm_no}|${r.device_id}`, r.session_id, r.adm_no, r.name, String(r.session_id).split(":")[2] || "", r.device_id, r.w, r.code, r.scanned_at, r.updated_at, r.status, blank(r.reason)])
  ];
  out.Devices = [
    ["DeviceID", "AdmNo", "Name", "ClassCode", "RegisteredAt", "LastSeen"],
    ...(await all2("SELECT * FROM devices ORDER BY rowid")).map((r) => [r.device_id, r.adm_no, r.name, r.class_code, r.registered_at, r.last_seen])
  ];
  out.AuditLog = [["At", "StaffCode", "Name", "Action", "Details"], ...(await all2("SELECT * FROM audit ORDER BY id")).map((r) => [r.at, r.staff_code, r.name, r.action, r.details])];
  return out;
}
__name(dump, "dump");
var meter = {};
function wrapDB(db, t) {
  const note = /* @__PURE__ */ __name((m) => {
    t.queries++;
    if (m) {
      t.read += m.rows_read || 0;
      t.written += m.rows_written || 0;
    }
  }, "note");
  const wrapStmt = /* @__PURE__ */ __name((st) => ({
    _st: st,
    bind: /* @__PURE__ */ __name((...a) => wrapStmt(st.bind(...a)), "bind"),
    all: /* @__PURE__ */ __name(async () => {
      t.trips++;
      const r = await st.all();
      note(r.meta);
      return r;
    }, "all"),
    run: /* @__PURE__ */ __name(async () => {
      t.trips++;
      const r = await st.run();
      note(r.meta);
      return r;
    }, "run"),
    first: /* @__PURE__ */ __name(async () => {
      t.trips++;
      const r = await st.all();
      note(r.meta);
      return (r.results || [])[0] ?? null;
    }, "first")
  }), "wrapStmt");
  return {
    prepare: /* @__PURE__ */ __name((sql) => wrapStmt(db.prepare(sql)), "prepare"),
    exec: /* @__PURE__ */ __name(async (sql) => {
      t.trips++;
      const r = await db.exec(sql);
      t.queries += r.count || 1;
      return r;
    }, "exec"),
    batch: /* @__PURE__ */ __name(async (list) => {
      t.trips++;
      const res = await db.batch(list.map((x) => x._st || x));
      res.forEach((r) => note(r.meta));
      return res;
    }, "batch")
  };
}
__name(wrapDB, "wrapDB");
async function metered(request, env, ctx) {
  const url = new URL(request.url);
  let action = url.searchParams.get("action") || "";
  if (request.method === "POST") {
    try {
      action = JSON.parse(await request.clone().text()).action || "?";
    } catch {
      action = "?";
    }
  }
  const t = { queries: 0, read: 0, written: 0, trips: 0 };
  const res = await worker_default.fetch(request, { ...env, DB: wrapDB(env.DB, t) }, ctx);
  const m = meter[action] = meter[action] || { n: 0, queries: 0, read: 0, written: 0, trips: 0, maxQueries: 0, maxRead: 0, maxWritten: 0, maxTrips: 0 };
  m.n++;
  m.queries += t.queries;
  m.read += t.read;
  m.written += t.written;
  m.trips += t.trips;
  m.maxTrips = Math.max(m.maxTrips, t.trips);
  m.maxQueries = Math.max(m.maxQueries, t.queries);
  m.maxRead = Math.max(m.maxRead, t.read);
  m.maxWritten = Math.max(m.maxWritten, t.written);
  return res;
}
__name(metered, "metered");
var SEED = ["Chebet Faith Jeptoo", "Kiprono Collins Rotich", "Wanjiru Grace Kamau", "Omondi Kevin Ouma", "Njeri Esther Wambui", "Kipchumba Allan Kosgei", "Atieno Sharon Akinyi", "Mutua Dennis Musyoka", "Jelagat Mercy Chepkoech", "Barasa Victor Wekesa"];
var dev_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), p = url.searchParams;
    const ok = /* @__PURE__ */ __name(() => new Response("ok", { headers: CORS }), "ok");
    if (url.pathname === "/__reset") {
      await reset(env);
      return ok();
    }
    if (url.pathname === "/__dump") return new Response(JSON.stringify(await dump(env)), { headers: { ...CORS, "Content-Type": "application/json" } });
    if (url.pathname === "/__pin") {
      await setStaffPin(env, p.get("code"), p.get("pin"), p.get("must") === "1", p.get("create") ? { name: p.get("name") || p.get("code"), roles: p.get("roles") || "TRAINER" } : null);
      return ok();
    }
    if (url.pathname === "/__seedClass") {
      for (const [i, nm] of SEED.entries()) await internals.run(env, "INSERT OR IGNORE INTO trainees (adm_no,name,class_code,status) VALUES (?,?,'ICT6A','active')", "RVNP/ICT/01" + (10 + i), nm);
      await internals.setMeta(env, "roster_v", "seed-" + Date.now());
      return ok();
    }
    if (url.pathname === "/__addTrainee") {
      await internals.run(env, "INSERT OR IGNORE INTO trainees (adm_no,name,class_code,status) VALUES ('RVNP/ICT/0203','Kevin Mwangi Githinji','ICT5B','active')");
      await internals.setMeta(env, "roster_v", "seed-" + Date.now());
      return ok();
    }
    if (url.pathname === "/__sql") {
      const r = await env.DB.prepare(await request.text()).all();
      return new Response(JSON.stringify(r.results || []), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    if (url.pathname === "/__fold") return new Response(String(await foldOldCheckins(env, true)), { headers: CORS });
    if (url.pathname === "/__nudgeReset") {
      internals.resetNudge();
      await internals.run(env, "DELETE FROM meta WHERE key='drive_nudged_at'");
      return ok();
    }
    if (url.pathname === "/__meter") {
      if (p.get("reset")) for (const k of Object.keys(meter)) delete meter[k];
      return new Response(JSON.stringify(meter), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    return env.METER ? metered(request, env, ctx) : worker_default.fetch(request, env, ctx);
  }
};

// C:/Users/Musumbi Denis/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/Musumbi Denis/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-RPQRdr/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = dev_default;

// C:/Users/Musumbi Denis/AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-RPQRdr/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=dev.js.map
