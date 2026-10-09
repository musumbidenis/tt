// Estimates the Worker's own CPU time per request (Cloudflare free plan: 10 ms per request).
// Runs worker.js in Node (same V8 engine) on a copy of the load-test database, with database calls
// answered by SQLite in-process and their time subtracted: on Cloudflare, D1 time is not Worker CPU.
// Usage: node cpu.mjs <d1.sqlite> <seed.json>
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { createHmac, createHash } from 'node:crypto';
import worker from '../worker/worker.js';

const [src, seedPath] = process.argv.slice(2);
const copy = new URL('./cpu-copy.sqlite', import.meta.url).pathname;
rmSync(copy, { force: true });
new DatabaseSync(src, { readOnly: true }).exec(`VACUUM INTO '${copy}'`);
const sql = new DatabaseSync(copy);
const SEED = JSON.parse(readFileSync(seedPath, 'utf8'));

let dbMs = 0;
const timed = (fn) => { const t = performance.now(); try { return fn(); } finally { dbMs += performance.now() - t; } };
const norm = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
const D1 = {
  prepare(q) {
    const make = (params) => ({
      bind: (...p) => make(p.map(norm)),
      all: async () => ({ results: timed(() => sql.prepare(q).all(...params)), meta: {} }),
      first: async () => timed(() => sql.prepare(q).get(...params)) ?? null,
      run: async () => { timed(() => sql.prepare(q).run(...params)); return { meta: {} }; },
    });
    return make([]);
  },
  exec: async (q) => { timed(() => sql.exec(q)); return { count: 1 }; },
};
const env = { DB: D1, ADMIN_PIN: '' };
const call = async (body, get) => {
  const req = get ? new Request('http://x/exec?' + new URLSearchParams(get)) : new Request('http://x/exec', { method: 'POST', body: JSON.stringify(body) });
  const r = await worker.fetch(req, env, { waitUntil() {} });
  return r.json();
};

async function measure(name, n, make) {
  const js = [];
  for (let i = 0; i < n; i++) {
    const [body, get] = await make(i);
    dbMs = 0;
    const t = performance.now();
    const out = await call(body, get);
    const wall = performance.now() - t;
    if (out.ok === false && !out.unchanged) { console.log(name, 'FAILED', out.error); break; }
    js.push(wall - dbMs);
  }
  js.sort((a, b) => a - b);
  const q = (p) => js[Math.min(js.length - 1, Math.floor(p * js.length))];
  const row = { name, n: js.length, median: q(0.5), p95: q(0.95), max: js[js.length - 1] };
  console.log(`${name.padEnd(34)} median ${row.median.toFixed(2).padStart(6)} ms   p95 ${row.p95.toFixed(2).padStart(6)} ms   max ${row.max.toFixed(2).padStart(6)} ms`);
  return row;
}

await call(null, { action: 'ping' }); // warm up: schema check
const tr = 'ICT001', mine = SEED.loading[tr][0];
const T = (await call({ action: 'login', staff: tr, pin: '4826' })).token;
const M = (await call({ action: 'login', staff: 'MIS', pin: '2468' })).token;
const ver = (await call({ action: 'roster', auth: T })).version;
const [stream, unit] = mine;
const students = SEED.students[stream];
const today = new Date().toISOString().slice(0, 10);
const sid = `session:${today}:${stream}:${unit}:L1:cpu`;
const secret = 'cpu-test-secret';
const w = Math.floor(Date.now() / 1000 / 20);
const session = (i) => ({ sessionId: sid, date: today, classCode: stream, unitCode: unit, unitName: 'U', period: 'Lesson 1', trainerId: tr, trainerName: 'T',
  updatedAt: new Date(Date.now() + i * 1000).toISOString(), marks: students.map((a) => ({ admNo: a, name: a, status: 'Absent', explicit: false })),
  qr: { secret, intervals: [[w - 5, w + 5]] } });
const tok = (s, ww) => createHmac('sha256', secret).update(`${s}|${ww}`).digest('hex').slice(0, 10);
const big = Array.from({ length: 82 }, (_, i) => ({ admNo: `L6/25S/${900000 + i}`, name: `Big Class ${i}` }));
const loadRows = Object.entries(SEED.loading).flatMap(([t, l]) => l.map(([c, u]) => ({ classCode: c, unitCode: u, unitName: 'Unit ' + u, trainerCode: t, trainerName: 'Trainer ' + t, lessonsPerWeek: 2, hoursPerWeek: 3 })));

const rows = [];
rows.push(await measure('login', 20, () => [{ action: 'login', staff: tr, pin: '4826' }]));
rows.push(await measure('pulse', 200, () => [{ action: 'pulse', auth: T }]));
rows.push(await measure('roster: version check (unchanged)', 100, () => [{ action: 'roster', auth: T, version: ver }]));
rows.push(await measure('roster: full, trainer', 30, () => [{ action: 'roster', auth: T }]));
rows.push(await measure('roster: full, MIS', 30, () => [{ action: 'roster', auth: M }]));
rows.push(await measure('push: 1 register, 30 marks', 60, (i) => [{ action: 'push', auth: T, sessions: [session(i)] }]));
rows.push(await measure('push: 20 registers (catch-up)', 10, (i) => [{ action: 'push', auth: T, sessions: Array.from({ length: 20 }, (_, k) => ({ ...session(i * 100 + k), sessionId: sid + ':' + k })) }]));
rows.push(await measure('checkin: 1 student (accepted)', 30, (i) => [{ action: 'checkin', checkins: [{ sessionId: sid, admNo: students[i], deviceId: 'cpu-dev-' + i, w, token: tok(sid, w), scannedAt: 'x' }] }]));
rows.push(await measure('checkins: trainer download', 60, () => [{ action: 'checkins', auth: T, sessionIds: [sid], since: '' }]));
rows.push(await measure('report: term register', 30, () => [{ action: 'report', auth: M, classCode: stream, unitCode: unit }]));
rows.push(await measure('overview (HOD)', 30, () => [{ action: 'overview', auth: M }]));
rows.push(await measure('classes (student setup)', 30, () => [null, { action: 'classes' }]));
rows.push(await measure('classlist (student setup)', 30, () => [null, { action: 'classlist', class: stream.replace('ICT ', '') + '-RS' }]));
rows.push(await measure('register (student phone)', 30, (i) => [{ action: 'register', admNo: SEED.students[SEED.streams[5]][i % 30], deviceId: 'stu-' + createHash('md5').update(SEED.students[SEED.streams[5]][i % 30]).digest('hex').slice(0, 12) }]));
rows.push(await measure('importClassList: 82 students', 10, (i) => [{ action: 'importClassList', auth: M, misClass: 'BIG-' + i, streams: ['ICT L6BIG-' + i], students: big }]));
rows.push(await measure('uploadLoading: whole loading', 5, () => [{ action: 'uploadLoading', auth: M, rows: loadRows, trainers: [] }]));
console.log(JSON.stringify(rows));
