/**
 * Local test harness only (wrangler dev --config worker/wrangler.test.toml). Not deployed.
 * Wraps worker.js and adds the helper endpoints the browser tests used with the Sheet imitation:
 *   /__reset      empty database + sample classes, the test MIS sign-in (MIS / 2468)
 *   /__dump       every table laid out like the Google Sheet tabs (same column order)
 *   /__pin        set a PIN for any staff code (create=1 makes the account)
 *   /__seedClass, /__addTrainee   extra sample students
 */
import worker, { internals as I, setStaffPin, foldOldCheckins } from './worker.js';

const SAMPLE = `INSERT INTO classes (code,name,level) VALUES ('ICT6A','Diploma in ICT L6 - Sept 2025 A','6'),('ICT5B','Certificate in ICT L5 - Jan 2026 B','5');
INSERT INTO units (class_code,code,name) VALUES ('ICT6A','PROG-601','Object Oriented Programming (Java)'),('ICT6A','NET-602','Computer Networking'),('ICT5B','APP-501','Computer Applications'),('ICT5B','PROG-502','Fundamentals of Programming');
INSERT INTO trainees (adm_no,name,class_code,status) VALUES ('RVNP/ICT/0101','Achieng Mary Otieno','ICT6A','active'),('RVNP/ICT/0102','Brian Kiprono Rotich','ICT6A','active'),('RVNP/ICT/0201','Ian Kipchumba Kirui','ICT5B','active'),('RVNP/ICT/0202','Joy Akinyi Ochieng','ICT5B','active');`;
const TABLES = ['meta', 'staff', 'login_fails', 'terms', 'classes', 'units', 'loading', 'trainees', 'requests', 'sessions', 'checkins', 'devices', 'signoffs', 'audit'];
const CORS = { 'Access-Control-Allow-Origin': '*' };
const yn = (v) => (v ? 'Yes' : 'No');
const blank = (v) => (v === null || v === undefined ? '' : v);

async function reset(env) {
  await env.DB.exec(TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join('\n'));
  I.resetCaches();
  await worker.fetch(new Request('http://x/?action=ping'), env); // creates the tables
  await env.DB.exec(SAMPLE);
  await setStaffPin(env, 'MIS', '2468', false, { name: 'MIS Officer', roles: 'MIS' });
}

async function dump(env) {
  const all = (sql) => I.all(env, sql);
  const out = {};
  out.Staff = [['StaffCode', 'Name', 'Roles', 'Responsibility', 'Active', 'PinHash', 'PinSalt', 'PinVersion', 'MustChange', 'LatePct', 'ExcusedPct', 'UpdatedAt'],
    ...(await all('SELECT * FROM staff')).map((r) => [r.code, r.name, r.roles, r.responsibility, yn(r.active), blank(r.pin_hash), blank(r.pin_salt), r.pin_version, yn(r.must_change), blank(r.late_pct), blank(r.excused_pct), r.updated_at])];
  out.Terms = [['TermID', 'Name', 'Duration', 'StartDate', 'Weeks', 'Breaks', 'Status', 'UpdatedAt'],
    ...(await all('SELECT * FROM terms')).map((r) => [r.id, r.name, r.duration, r.start_date, r.weeks, r.breaks, r.status, r.updated_at])];
  out.Classes = [['ClassCode', 'ClassName', 'Level', 'MisClass', 'Population'],
    ...(await all('SELECT * FROM classes')).map((r) => [r.code, r.name, r.level, blank(r.mis_class), blank(r.population)])];
  out.Units = [['ClassCode', 'UnitCode', 'UnitName'], ...(await all('SELECT * FROM units')).map((r) => [r.class_code, r.code, r.name])];
  out.Loading = [['LoadID', 'TermID', 'ClassCode', 'UnitCode', 'UnitName', 'TrainerCode', 'TrainerName', 'LessonsPerWeek', 'HoursPerWeek', 'Population', 'UpdatedAt'],
    ...(await all('SELECT * FROM loading')).map((r) => [`${r.term_id}|${r.class_code}|${r.unit_code}`, r.term_id, r.class_code, r.unit_code, r.unit_name, r.trainer_code, r.trainer_name, r.lessons_per_week, r.hours_per_week, blank(r.population), r.updated_at])];
  out.Trainees = [['AdmNo', 'Name', 'ClassCode', 'Active', 'Status', 'MisClass', 'AddedBy', 'AddedAt', 'UpdatedBy', 'UpdatedAt', 'Note'],
    ...(await all('SELECT * FROM trainees')).map((r) => [r.adm_no, r.name, r.class_code, yn(!/withdrawn|rejected/i.test(r.status || '')), blank(r.status), blank(r.mis_class), blank(r.added_by), blank(r.added_at), blank(r.updated_by), blank(r.updated_at), blank(r.note)])];
  out.Requests = [['RequestID', 'AdmNo', 'Name', 'ClassCode', 'Reason', 'RequestedBy', 'RequestedName', 'RequestedAt', 'Status', 'DecidedBy', 'DecidedAt', 'MergedInto', 'Note'],
    ...(await all('SELECT * FROM requests')).map((r) => [r.id, r.adm_no, r.name, r.class_code, r.reason, r.requested_by, r.requested_name, r.requested_at, r.status, blank(r.decided_by), blank(r.decided_at), blank(r.merged_into), blank(r.note)])];
  const sessions = await all('SELECT * FROM sessions ORDER BY synced_at');
  const accepted = await I.acceptedMap(env, sessions.map((r) => r.id));
  out.Sessions = [['SessionID', 'Date', 'ClassCode', 'ClassName', 'UnitCode', 'UnitName', 'Period', 'TrainerID', 'TrainerName', 'Present', 'Absent', 'Late', 'Excused', 'Total', 'AttendancePct', 'Notes', 'Edits', 'DeviceID', 'CreatedAt', 'UpdatedAt', 'SyncedAt', 'TermID', 'Week']];
  out.Attendance = [['RecordID', 'SessionID', 'Date', 'ClassCode', 'UnitCode', 'UnitName', 'Period', 'AdmNo', 'Name', 'Status', 'TrainerID', 'TrainerName', 'UpdatedAt', 'SyncedAt', 'Source']];
  out.SessionData = [['SessionID', 'UpdatedAt', 'Json']];
  for (const r of sessions) {
    const s = JSON.parse(r.data);
    out.Sessions.push([r.id, r.date, r.class_code, blank(s.className), r.unit_code, r.unit_name, r.period, r.trainer_id, r.trainer_name, r.present, r.absent, r.late, r.excused, r.total, blank(r.pct),
      blank(s.notes), Number(s.edits) || 0, blank(s.deviceId), blank(s.createdAt), r.updated_at, r.synced_at, blank(r.term_id), blank(r.week)]);
    for (const m of I.finalMarks(s, accepted[r.id])) {
      out.Attendance.push([`${r.id}|${m.admNo}`, r.id, s.date, s.classCode, s.unitCode, s.unitName, s.period, m.admNo, m.name, m.status, s.trainerId, s.trainerName, s.updatedAt, r.synced_at, m.source]);
    }
    out.SessionData.push([r.id, r.updated_at, r.data]);
  }
  out.SignOffs = [['SignOffID', 'TermID', 'ClassCode', 'UnitCode', 'UnitName', 'TrainerCode', 'TrainerName', 'LecturerComment', 'SubmittedAt', 'Status', 'HodCode', 'HodName', 'HodComment', 'DecidedAt'],
    ...(await all('SELECT * FROM signoffs')).map((r) => [r.id, r.term_id, r.class_code, r.unit_code, r.unit_name, r.trainer_code, r.trainer_name, blank(r.lecturer_comment), r.submitted_at, r.status, blank(r.hod_code), blank(r.hod_name), blank(r.hod_comment), blank(r.decided_at)])];
  out.CheckIns = [['CheckInID', 'SessionID', 'AdmNo', 'Name', 'ClassCode', 'DeviceID', 'Window', 'Code', 'ScannedAt', 'UpdatedAt', 'Status', 'Reason'],
    ...(await all('SELECT * FROM checkins ORDER BY updated_at')).map((r) => [`${r.session_id}|${r.adm_no}|${r.device_id}`, r.session_id, r.adm_no, r.name, String(r.session_id).split(':')[2] || '', r.device_id, r.w, r.code, r.scanned_at, r.updated_at, r.status, blank(r.reason)])];
  out.Devices = [['DeviceID', 'AdmNo', 'Name', 'ClassCode', 'RegisteredAt', 'LastSeen'],
    ...(await all('SELECT * FROM devices ORDER BY rowid')).map((r) => [r.device_id, r.adm_no, r.name, r.class_code, r.registered_at, r.last_seen])];
  out.AuditLog = [['At', 'StaffCode', 'Name', 'Action', 'Details'], ...(await all('SELECT * FROM audit ORDER BY id')).map((r) => [r.at, r.staff_code, r.name, r.action, r.details])];
  return out;
}

const SEED = ['Chebet Faith Jeptoo', 'Kiprono Collins Rotich', 'Wanjiru Grace Kamau', 'Omondi Kevin Ouma', 'Njeri Esther Wambui', 'Kipchumba Allan Kosgei', 'Atieno Sharon Akinyi', 'Mutua Dennis Musyoka', 'Jelagat Mercy Chepkoech', 'Barasa Victor Wekesa'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url), p = url.searchParams;
    const ok = () => new Response('ok', { headers: CORS });
    if (url.pathname === '/__reset') { await reset(env); return ok(); }
    if (url.pathname === '/__dump') return new Response(JSON.stringify(await dump(env)), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    if (url.pathname === '/__pin') {
      await setStaffPin(env, p.get('code'), p.get('pin'), p.get('must') === '1', p.get('create') ? { name: p.get('name') || p.get('code'), roles: p.get('roles') || 'TRAINER' } : null);
      return ok();
    }
    if (url.pathname === '/__seedClass') {
      for (const [i, nm] of SEED.entries()) await I.run(env, "INSERT OR IGNORE INTO trainees (adm_no,name,class_code,status) VALUES (?,?,'ICT6A','active')", 'RVNP/ICT/01' + (10 + i), nm);
      return ok();
    }
    if (url.pathname === '/__addTrainee') {
      await I.run(env, "INSERT OR IGNORE INTO trainees (adm_no,name,class_code,status) VALUES ('RVNP/ICT/0203','Kevin Mwangi Githinji','ICT5B','active')");
      return ok();
    }
    if (url.pathname === '/__sql') { // run SQL directly (tests only)
      const r = await env.DB.prepare(await request.text()).all();
      return new Response(JSON.stringify(r.results || []), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/__fold') return new Response(String(await foldOldCheckins(env, true)), { headers: CORS });
    return worker.fetch(request, env, ctx);
  },
};
