/* Student outbox - the one place that sends what is waiting on the phone: check-ins and POE evidence.
 * It has no screen and needs no page, so it runs in the app (a window) and also in the service worker when the
 * app is closed. Plain fetch only. The page and the worker never send at the same time (a Web Lock), and they
 * share the same resume fields on each document (d.plan / d.drive / d.upload), so a send started in one can be
 * finished by the other.
 *
 *   Outbox.run({ db, serverUrl, deviceId, admNo, parts?, wait?, getToken?, drive?, onChange? })
 *     db         the 'rvnp_student' PouchDB
 *     parts      ['checkins'] and/or ['evidence'] (default: both)
 *     wait       true: queue behind another send (the page); false: skip when one is running (the worker)
 *     getToken   async (fresh) -> Google access token, or '' when the student has not connected Google.
 *                Default: ask the server (googleToken), used by the worker.
 *     onChange   called after a document changes, so the page can redraw
 *   Returns { checkins, evidence, failed, skipped?, error?, moved?, needGoogle? } */
'use strict';

const Outbox = (() => {
  const ARK = 'ark-outbox';
  const nowISO = () => new Date().toISOString();
  const lowerEq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  class NeedConnect extends Error {}

  async function post(serverUrl, body) {
    const res = await fetch(serverUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
    return res.json();
  }
  async function bytesToB64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function putDoc(db, d) { const r = await db.put(d); d._rev = r.rev; return d; }
  async function updateLocal(db, id, fn) {
    for (let i = 0; i < 6; i++) {
      let doc;
      try { doc = await db.get('_local/' + id); } catch (e) { if (e.status === 404) doc = { _id: '_local/' + id }; else throw e; }
      fn(doc);
      try { await db.put(doc); return; } catch (e) { if (e.status !== 409) throw e; }
    }
  }

  /* ---------- the student's own Drive (Drive REST; mirrors google.js) ---------- */
  function driveApi(getToken) {
    let tok = '';
    const call = async (url, opts = {}, retried = false) => {
      if (!tok) tok = await getToken(false);
      if (!tok) throw new NeedConnect('Connect Google first');
      const res = await fetch(url.startsWith('http') ? url : 'https://www.googleapis.com' + url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + tok } });
      if (res.status === 401) {
        tok = '';
        if (!retried) { tok = await getToken(true); if (tok) return call(url, opts, true); }
        throw new NeedConnect('Your Google sign-in has expired');
      }
      return res;
    };
    const json = async (url, opts) => {
      const res = await call(url, opts);
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(out.error?.message || `Google said no (${res.status})`), { status: res.status });
      return out;
    };
    return {
      token: async () => { if (!tok) tok = await getToken(false); return tok; },
      async folder(name, parent) {
        const q = `name='${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parent ? ` and '${parent}' in parents` : '');
        const found = await json('/drive/v3/files?fields=files(id)&pageSize=1&q=' + encodeURIComponent(q));
        if (found.files?.[0]) return found.files[0].id;
        const made = await json('/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }) });
        return made.id;
      },
      async upload(blob, { name, parent, description, mime = 'application/pdf' }) {
        const start = await call('/upload/drive/v3/files?uploadType=resumable&fields=id,name,md5Checksum,size', {
          method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(blob.size) },
          body: JSON.stringify({ name, mimeType: mime, description, ...(parent ? { parents: [parent] } : {}) }) });
        if (!start.ok) throw new Error(`Google did not start the upload (${start.status})`);
        const where = start.headers.get('Location');
        if (!where) throw new Error('Google did not give an upload address');
        const res = await fetch(where, { method: 'PUT', headers: { 'Content-Type': mime }, body: blob });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.id) throw new Error(out.error?.message || `The upload did not finish (${res.status})`);
        return out;
      },
      async share(fileId, email) {
        await json(`/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: email }) });
      },
    };
  }

  /** Default token source (no page): ask the college server. '' when the student has not connected Google. */
  function serverToken(o) {
    let cached = null, exp = 0, pinged = null;
    return async (fresh) => {
      if (!fresh && cached && exp > Date.now() + 60e3) return cached;
      cached = null;
      if (pinged === null) {
        try { const j = await (await fetch(o.serverUrl + (o.serverUrl.includes('?') ? '&' : '?') + 'action=ping', { redirect: 'follow' })).json(); pinged = j?.googleConnect === true; } catch { pinged = false; }
      }
      if (!pinged) return '';
      let r;
      try { r = await post(o.serverUrl, { action: 'googleToken', deviceId: o.deviceId, admNo: o.admNo }); } catch { return ''; }
      if (!r || !r.ok || r.needConnect || !r.accessToken) return '';
      cached = r.accessToken; exp = Date.now() + (Number(r.expiresIn) || 3600) * 1000;
      return cached;
    };
  }

  /* ---------- (a) check-ins ---------- */
  async function sendCheckins(o, out) {
    const rows = await o.db.allDocs({ include_docs: true, startkey: 'checkin:', endkey: 'checkin:￿' });
    const docs = rows.rows.map((x) => x.doc).filter((d) => d.status === 'saved' || d.status === 'pending');
    for (let i = 0; i < docs.length; i += 100) {
      const part = docs.slice(i, i + 100);
      try {
        const res = await post(o.serverUrl, { action: 'checkin', checkins: part.map((d) => ({ sessionId: d.sessionId, classCode: d.classCode, admNo: d.admNo, deviceId: d.deviceId, w: d.w, token: d.token, scannedAt: d.scannedAt })) });
        if (!res.ok) throw new Error(res.error || 'The server did not accept the check-ins');
        const byId = new Map((res.results || []).map((r) => [String(r.id).toLowerCase(), r]));
        for (const d of part) {
          const r = byId.get(`${d.sessionId}|${d.admNo}|${d.deviceId}`.toLowerCase());
          if (!r) continue;
          Object.assign(d, { status: r.status, reason: r.reason || '', checkedAt: nowISO() });
          try { await putDoc(o.db, d); } catch (e) {
            if (e.status !== 409) throw e;
            const fresh = await o.db.get(d._id); Object.assign(fresh, { status: r.status, reason: r.reason || '', checkedAt: nowISO() }); await putDoc(o.db, fresh);
          }
          out.checkins++;
          // The MIS Officer may have moved this student to another stream: the page follows the official list.
          if (r.classCode && lowerEq(r.admNo || d.admNo, o.admNo)) out.moved = { admNo: r.admNo || d.admNo, classCode: r.classCode };
        }
        o.onChange?.();
      } catch (e) {
        out.failed += part.length; out.error = e.message;
        return;
      }
    }
    if (docs.length) await updateLocal(o.db, 'settings', (d) => { d.lastSync = nowISO(); }).catch(() => {});
  }

  /* ---------- (b) POE evidence ---------- */
  async function viaDrive(o, drive, d) {
    const blobOf = () => o.db.getAttachment(d._id, 'doc.pdf');
    if (!d.plan) {
      const blob = await blobOf();
      const pl = await post(o.serverUrl, { action: 'poeDrivePlan', deviceId: o.deviceId, admNo: o.admNo, unitCode: d.unitCode, item: d.item, bytes: blob.size, pages: d.pageCount });
      if (!pl.ok) throw new Error(pl.error);
      d.plan = { plan: pl.plan, fileName: pl.fileName, version: pl.version, folder: pl.folder, subfolder: pl.subfolder, description: pl.description, share: pl.share || [] };
      await putDoc(o.db, d);
    }
    if (!d.drive) {
      const root = await drive.folder(d.plan.folder);
      const sub = await drive.folder(d.plan.subfolder, root);
      const up = await drive.upload(await blobOf(), { name: d.plan.fileName, parent: sub, description: d.plan.description });
      d.drive = { fileId: up.id, shared: [] };
      await putDoc(o.db, d);
    }
    for (const email of d.plan.share) {
      if (d.drive.shared.includes(email)) continue;
      try { await drive.share(d.drive.fileId, email); d.drive.shared.push(email); } catch (e) { if (e instanceof NeedConnect) throw e; /* shared later */ }
    }
    await putDoc(o.db, d);
    const done = await post(o.serverUrl, { action: 'poeDriveDone', deviceId: o.deviceId, admNo: o.admNo, plan: d.plan.plan, fileId: d.drive.fileId, accessToken: await drive.token(), shared: d.drive.shared });
    if (!done.ok) throw new Error(done.error);
    return { evidence: done.evidence, fileName: d.plan.fileName, version: d.plan.version };
  }
  /** A file the old bridge already took but whose confirmation was lost: only the confirmation is sent. */
  async function confirmOld(o, d) {
    const up = d.upload;
    const done = await post(o.serverUrl, { action: 'poeDone', ...up });
    if (!done.ok) throw new Error(done.error);
    return { evidence: done.evidence, fileName: up.fileName, version: up.version };
  }
  async function sendEvidence(o, out) {
    const rows = await o.db.allDocs({ include_docs: true, startkey: 'ev:', endkey: 'ev:￿' });
    const waiting = rows.rows.map((r) => r.doc).filter((d) => d.status === 'saved' || d.status === 'uploading' || d.status === 'error');
    if (!waiting.length) return;
    const getToken = o.getToken || serverToken(o);
    const drive = driveApi(getToken);
    // Documents go only to the student's own Google Drive, shared with the trainer. Not connected: they wait on the phone.
    for (const d of waiting) {
      try {
        if (d.upload) {
          d.status = 'uploading'; d.needGoogle = false; await putDoc(o.db, d); o.onChange?.();
          const r = await confirmOld(o, d);
          Object.assign(d, { status: 'sent', serverId: r.evidence.id, fileName: r.fileName, version: r.version, sentAt: nowISO(), error: '' });
          delete d.upload;
          await putDoc(o.db, d);
        } else {
          if (!(await getToken(false))) throw new NeedConnect('Connect Google first');
          d.status = 'uploading'; d.needGoogle = false; await putDoc(o.db, d); o.onChange?.();
          const r = await viaDrive(o, drive, d);
          Object.assign(d, { status: 'sent', serverId: r.evidence.id, fileName: r.fileName, version: r.version, sentAt: nowISO(), error: '' });
          delete d.plan; delete d.drive;
          await putDoc(o.db, d);
        }
        out.evidence++;
      } catch (e) {
        out.failed++;
        d.status = 'error';
        d.needGoogle = e instanceof NeedConnect;
        if (d.needGoogle) out.needGoogle = true;
        d.error = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'Waiting for internet'
          : d.needGoogle ? 'Connect Google to send it. Your file is safe on this device.'
          : 'Could not send: ' + e.message;
        try { await putDoc(o.db, d); } catch { /* changed by the other side: it is picked up next time */ }
      }
      o.onChange?.();
    }
  }

  async function work(o) {
    const out = { checkins: 0, evidence: 0, failed: 0 };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { out.offline = true; return out; }
    const parts = o.parts || ['checkins', 'evidence'];
    if (parts.includes('checkins')) await sendCheckins(o, out);
    if (parts.includes('evidence')) {
      try { await sendEvidence(o, out); } catch (e) { out.error = out.error || e.message; }
    }
    return out;
  }

  async function run(o) {
    if (!o || !o.db || !o.serverUrl || !o.deviceId || !o.admNo) return { checkins: 0, evidence: 0, failed: 0, skipped: true };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
    if (!locks || !locks.request) return work(o);
    if (o.wait) return locks.request(ARK, () => work(o));
    return locks.request(ARK, { ifAvailable: true }, (lock) => (lock ? work(o) : { checkins: 0, evidence: 0, failed: 0, skipped: true }));
  }

  return { run, NeedConnect };
})();

if (typeof self !== 'undefined') self.Outbox = Outbox;
