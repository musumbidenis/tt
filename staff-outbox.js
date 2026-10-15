/* The trainer's outbox: sends the registers and marks this device has and the server does not, nothing else.
 * One sending path for the page (app.js, marks.js) and for the service worker (so unsent work still goes when
 * the app is closed). No DOM, no toast: it only uses fetch and the PouchDB instance it is given.
 *   StaffOutbox.run({ db })  ->  { registers, marks, locked, held, merged: [session...], authError, busy, skipped }
 * Options: registers / marks (both true unless set false), only (array of marksIndex keys), force, holdBack(session),
 * deviceId. It throws when the server cannot be reached or refuses (the error carries .partial with what was sent
 * before that), so a background sync is tried again later. */
'use strict';

(function (root) {
  const LEGACY_SERVER = 'https://script.google.com/macros/s/AKfycbw3bSI2h4GrfV2BBmZOqDkyioa4tYZz3ND_PL-0JurcQKneg9TNBwbuLMPBh3qqIKOxTA/exec';
  const OLD_SERVER = /script\.google(usercontent)?\.com/;
  const STATUSES = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };
  // The same lesson times as app.js (SLOTS / PERIODS / LUNCH_*): keep them in step.
  const SLOTS = [['7.30', '9.00'], ['9.00', '10.30'], ['10.30', '12.00'], ['13.00', '14.30'], ['14.30', '16.00'], ['16.00', '17.30']];
  const PERIOD_LABEL = { L1: 'Lesson 1', L2: 'Lesson 2', L3: 'Lesson 3', L4: 'Lesson 4', L5: 'Lesson 5', L6: 'Lesson 6', EV: 'Evening' };
  const LUNCH_SLOT = 7, LUNCH_TIME = ['12.00', '13.00'];
  const lower = (s) => String(s ?? '').trim().toLowerCase();
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
  const nowISO = () => new Date().toISOString();

  function slotLabel(period, slots = 1) {
    const m = /^L(\d)$/.exec(period || ''), n = m ? Number(m[1]) : 0;
    if (n === LUNCH_SLOT) return `Lunch - ${LUNCH_TIME[0]}–${LUNCH_TIME[1]}`;
    if (!n || !SLOTS[n - 1]) return PERIOD_LABEL[period] || period;
    const end = SLOTS[Math.min(SLOTS.length, n + (slots === 2 ? 1 : 0)) - 1][1];
    return (slots === 2 ? `Lessons ${n}–${n + 1}` : `Lesson ${n}`) + ` - ${SLOTS[n - 1][0]}–${end}`;
  }
  const kindOf = (s) => (s && ['cat', 'extra'].includes(s.kind) ? s.kind : 'lesson');
  function countMarks(s) {
    const c = { P: 0, A: 0, L: 0, E: 0, none: 0 };
    for (const v of Object.values(s.marks || {})) { if (c[v] !== undefined) c[v]++; else c.none++; }
    return c;
  }
  /** A register as the server takes it. */
  function toSheetSession(s) {
    const c = countMarks(s);
    return {
      sessionId: s._id, date: s.date, classCode: s.classCode, className: s.className || '',
      unitCode: s.unitCode, unitName: s.unitName || '', period: slotLabel(s.period, Number(s.slots) === 2 ? 2 : 1),
      kind: kindOf(s), title: s.title || '', slots: Number(s.slots) === 2 ? 2 : 1,
      trainerId: s.trainerId || '', trainerName: s.trainerName || '', deviceId: s.deviceId || '',
      termId: s.termId || '', week: s.week || '', ...(s.combined?.length > 1 ? { combined: s.combined } : {}),
      notes: s.notes || '', createdAt: s.createdAt || '', updatedAt: s.updatedAt || '',
      edits: (s.editLog || []).length, counts: { P: c.P, A: c.A, L: c.L, E: c.E }, editLog: s.editLog || [], viaQr: s.viaQr || {},
      marks: Object.entries(s.marks || {}).filter(([, v]) => STATUSES[v])
        .map(([admNo, st]) => ({ admNo, name: s.names?.[admNo] || '', status: STATUSES[st], explicit: !!s.explicit?.[admNo], at: s.marksAt?.[admNo] || '' })),
      ...(s.qr ? { qr: { secret: s.qr.secret, intervals: s.qr.intervals } } : {}),
    };
  }

  async function getLocal(db, id, fallback = {}) {
    try { return await db.get('_local/' + id); }
    catch (e) { if (e.status === 404) return { _id: '_local/' + id, ...clone(fallback) }; throw e; }
  }
  async function updateLocal(db, id, fn, fallback = {}) {
    for (let i = 0; i < 6; i++) {
      const doc = await getLocal(db, id, fallback);
      fn(doc);
      try { const r = await db.put(doc); doc._rev = r.rev; return doc; }
      catch (e) { if (e.status !== 409) throw e; }
    }
    throw new Error('Could not update ' + id);
  }

  const tryJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
  async function post(url, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const opts = { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctrl.signal, redirect: 'follow' };
    try {
      let res = await fetch(url, opts), text = await res.text(), parsed = tryJson(text);
      if (!parsed) { // Google sometimes answers with a temporary error page: try once more
        await new Promise((r) => setTimeout(r, 1500));
        res = await fetch(url, opts); text = await res.text(); parsed = tryJson(text);
      }
      if (parsed) return parsed;
      throw new Error(`The server did not answer properly (${res.status}). Try again in a moment; if it keeps happening, tell the MIS Officer.`);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('The server took too long to answer');
      if (e instanceof TypeError) throw new Error('No connection to the server');
      throw e;
    } finally { clearTimeout(timer); }
  }

  async function runLocked(opts) {
    const db = opts.db;
    const out = { registers: 0, marks: 0, locked: 0, held: 0, merged: [], authError: false, authMessage: '', busy: false, skipped: '' };
    const auth = await getLocal(db, 'auth');
    if (!auth.token || auth.mustChange) { out.skipped = 'no sign-in'; return out; }
    const settings = await getLocal(db, 'settings');
    const cfg = root.ATTENDANCE_CONFIG || {}, cfgUrl = cfg.serverUrl || cfg.sheetsUrl || '', own = settings.serverUrl || '';
    const server = own && !(OLD_SERVER.test(own) && cfgUrl && !OLD_SERVER.test(cfgUrl)) ? own : cfgUrl;
    if (!server) { out.skipped = 'no server'; return out; }
    const token = auth.token;
    const call = async (action, body) => {
      const res = await post(new URL(server).toString(), { action, auth: token, ...body });
      if (res && (res.authError || res.mustChange)) { out.authError = true; out.authMessage = res.error || ''; return null; }
      return res;
    };
    try {
      if (opts.registers !== false) await sendRegisters(db, opts, out, server, call);
      if (opts.marks !== false && !out.authError) await sendMarks(db, opts, out, call);
    } catch (e) { e.partial = { registers: out.registers, marks: out.marks }; throw e; }
    return out;
  }

  async function sendRegisters(db, opts, out, server, call) {
    const deviceId = opts.deviceId || (await getLocal(db, 'device')).deviceId || '';
    const sentMap = async () => { const d = await getLocal(db, 'sheetsSync', { map: {} }); return (d.server || LEGACY_SERVER) === server ? d.map || {} : {}; };
    const markSent = (fn) => updateLocal(db, 'sheetsSync', (d) => {
      if ((d.server || LEGACY_SERVER) !== server) d.map = {};
      d.server = server; d.map = d.map || {};
      fn(d.map);
    }, { map: {} });
    const all = await db.allDocs({ include_docs: true, startkey: 'session:', endkey: 'session:￰' });
    const map = await sentMap();
    const pending = all.rows.map((x) => x.doc).filter((s) => map[s._id] !== s._rev)
      .filter((s) => opts.force || !opts.holdBack || !opts.holdBack(s));
    for (const batch of chunk(pending, 20)) {
      const res = await call('push', { deviceId, sessions: batch.map(toSheetSession) });
      if (!res) return;
      if (!res.ok) throw new Error(res.error || 'The server rejected the upload');
      await markSent((m) => { for (const s of batch) m[s._id] = s._rev; });
      for (const r of res.results || []) {
        if (r.status === 'merged' && r.session) out.merged.push(r.session);
        if (r.status === 'locked') out.locked++;
      }
      out.registers += batch.length;
      if (opts.onBatch) { try { await opts.onBatch(batch, res); } catch (e) { console.warn('outbox onBatch', e); } }
    }
  }

  async function sendMarks(db, opts, out, call) {
    const idx = await getLocal(db, 'marksIndex', { keys: [] });
    const only = opts.only ? new Set(opts.only.map((k) => k.slice(k.indexOf(':') + 1))) : null;
    for (const key of idx.keys || []) {
      const cu = key.slice(key.indexOf(':') + 1);
      if (only && !only.has(cu)) continue;
      const [cls, unit] = cu.split('|');
      const id = `marks:unit:${cu}`;
      let d = await getLocal(db, id, { rows: {}, dirty: {} });
      d.rows = d.rows || {}; d.dirty = d.dirty || {};
      // Started afresh on the server: marks from before that moment go; anything typed since stays.
      const at = (await getLocal(db, 'syncLog')).resetAt || '';
      if (at && (d.resetAt || '') < at) {
        d = await updateLocal(db, id, (x) => {
          x.rows = Object.fromEntries(Object.entries(x.rows || {}).filter(([, r]) => String(r.updatedAt || '') > at));
          x.dirty = Object.fromEntries(Object.entries(x.dirty || {}).filter(([k]) => x.rows[k]));
          x.sheet = null; x.resetAt = at;
        }, { rows: {}, dirty: {} });
      }
      const keys = Object.keys(d.dirty);
      if (!keys.length) { await dropKey(db, cu); continue; }
      const res = await call('marksPush', { classCode: cls, unitCode: unit, rows: keys.map((k) => d.rows[k]).filter(Boolean) });
      if (!res) return;
      if (!res.ok) throw new Error(res.error);
      const x = await updateLocal(db, id, (y) => {
        y.rows = y.rows || {}; y.dirty = y.dirty || {};
        for (const k of keys) if (y.dirty[k] && String(y.rows[k]?.updatedAt) <= String(d.rows[k]?.updatedAt)) delete y.dirty[k];
        for (const r of res.rows || []) {
          const k = lower(r.admNo);
          if (!y.dirty[k]) y.rows[k] = { admNo: r.admNo, cat1: r.cat1, cat2: r.cat2, cat3: r.cat3, prac1: r.prac1, prac2: r.prac2, prac3: r.prac3, updatedAt: r.updatedAt, updatedBy: r.updatedBy, locked: r.locked || [], terms: r.terms || {} };
        }
        y.lockedTerms = res.lockedTerms || [];
        y.sentAt = nowISO();
      }, { rows: {}, dirty: {} });
      if (!Object.keys(x.dirty || {}).length) await dropKey(db, cu);
      out.marks += keys.length;
      out.held += Number(res.held) || 0;
    }
  }
  const dropKey = (db, cu) => updateLocal(db, 'marksIndex', (i) => { i.keys = (i.keys || []).filter((k) => k.slice(k.indexOf(':') + 1) !== cu); }, { keys: [] });

  async function run(opts = {}) {
    if (!opts.db) throw new Error('StaffOutbox.run needs { db }');
    const locks = root.navigator && root.navigator.locks;
    if (!locks || !locks.request) return runLocked(opts);
    return locks.request('ark-staff-outbox', { ifAvailable: true }, async (lock) => {
      if (!lock) return { registers: 0, marks: 0, locked: 0, held: 0, merged: [], authError: false, authMessage: '', busy: true, skipped: 'busy' };
      return runLocked(opts);
    });
  }

  root.StaffOutbox = { run, toSheetSession };
})(typeof self !== 'undefined' ? self : this);
