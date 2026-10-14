/* POE tab — trainers review the evidence students sent for their units: preview inside the app, approve or
 * return with a note. The HOD sees the department. The MIS Officer gets the approved submissions and marks
 * them received. Files stay in the college Drive; the preview is fetched through the Drive bridge.
 * Uses app.js (api, state, $, $$, esc, toast, hasRole, me) and Imports.pdfLib (pdf.js). */
'use strict';

const PoeStaff = (() => {
  const ITEMS = ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'PRAC1', 'PRAC2', 'PRAC3'];
  const STATUS = { submitted: ['pending', 'To review'], approved: ['synced', 'Approved'], returned: ['rejected', 'Returned'] };
  const ps = { list: [], status: '', cls: '', unit: '', q: '', loaded: false, sheetUrl: '', indexUrl: '', driveReady: true, open: null, files: new Map(), picked: new Set(), seq: 0, mode: 'unit', classes: [], roster: new Map(), sCls: '', sFilter: '', order: [], marks: new Map() };
  /* Marks from the unit's marksheet, beside the evidence they are for: CAT1 → cat1 … PRAC3 → prac3 (CAT4 has no mark column). */
  const markKey = (cls, unit, adm) => `${cls}|${unit}|${lower(adm)}`;
  const keepMarks = (rows) => { for (const m of rows || []) ps.marks.set(markKey(m.c, m.u, m.a), m); };
  const markOf = (cls, unit, adm, item) => { const v = ps.marks.get(markKey(cls, unit, adm))?.[String(item).toLowerCase()]; return v === undefined || v === null ? '' : v; };
  const fmtMark = (v) => (v === '' ? '–' : String(Math.round(v * 10) / 10));
  const box = () => $('#poe');
  const misOnly = () => hasRole('MIS') && !hasRole('TRAINER') && !hasRole('HOD');
  const canDecide = () => hasRole('TRAINER') || hasRole('HOD');
  const byStudentAllowed = () => hasRole('MIS') || hasRole('HOD');

  async function load() {
    const res = await api('poeList', {});
    if (!res.ok) throw new Error(res.error || 'Could not load the evidence');
    Object.assign(ps, { list: res.evidence, sheetUrl: res.sheetUrl || '', indexUrl: res.indexUrl || '', driveReady: res.driveReady !== false, loaded: true });
    keepMarks(res.marks);
    badge();
  }
  function badge() {
    const n = ps.list.filter((e) => (misOnly() ? e.status === 'approved' && !e.receivedAt : e.status === 'submitted')).length;
    const dot = $('#poeCount'); if (!dot) return;
    dot.hidden = !n; dot.textContent = n > 99 ? '99+' : String(n);
  }

  async function render() {
    if (!me()) return;
    if (!ps.status) ps.status = misOnly() ? 'approved' : 'submitted';
    if (!navigator.onLine) {
      box().innerHTML = '<div class="card notice"><h2>Evidence needs internet</h2><p>The students\' files are in the college Google Drive. Connect to review them.</p></div>';
      return;
    }
    if (!ps.loaded) box().innerHTML = '<div class="card"><p class="muted">Loading evidence…</p></div>';
    const seq = ++ps.seq;
    try { await load(); } catch (e) { if (seq === ps.seq) box().innerHTML = `<div class="card notice"><h2>Could not load evidence</h2><p>${esc(e.message)}</p></div>`; return; }
    if (seq === ps.seq) draw();
  }

  function filtered() {
    const q = ps.q.trim().toLowerCase();
    return ps.list.filter((e) => (!ps.status || ps.status === 'received' ? true : e.status === ps.status)
      && (ps.status !== 'received' || (e.status === 'approved' && e.receivedAt))
      && (ps.status !== 'approved' || !misOnly() || !e.receivedAt)
      && (!ps.cls || e.classCode === ps.cls) && (!ps.unit || e.unitCode === ps.unit)
      && (!q || e.name.toLowerCase().includes(q) || e.admNo.toLowerCase().includes(q)));
  }
  const modeToggle = () => (byStudentAllowed() ? `<div class="view-tabs poe-mode" role="group" aria-label="View">
      <button type="button" data-mode="unit" aria-pressed="${ps.mode === 'unit'}">By unit</button>
      <button type="button" data-mode="student" aria-pressed="${ps.mode === 'student'}">By student</button></div>` : '');
  function draw() {
    if (ps.mode === 'student' && byStudentAllowed()) return drawStudents();
    const all = ps.list, counts = { submitted: 0, approved: 0, returned: 0, received: 0 };
    for (const e of all) { counts[e.status] = (counts[e.status] || 0) + 1; if (e.status === 'approved' && e.receivedAt) counts.received++; }
    if (misOnly()) counts.approved -= counts.received;
    const chips = (misOnly() ? [['approved', 'To receive'], ['received', 'Received'], ['submitted', 'With trainers'], ['returned', 'Returned'], ['', 'All']]
      : [['submitted', 'To review'], ['approved', 'Approved'], ['returned', 'Returned'], ['', 'All']])
      .map(([k, l]) => `<button type="button" class="chipbtn${ps.status === k ? ' on' : ''}" data-status="${k}">${l}${k && counts[k] ? ` <span class="n">${counts[k]}</span>` : ''}</button>`).join('');
    const classes = [...new Set(all.map((e) => e.classCode))].sort();
    const units = [...new Map(all.filter((e) => !ps.cls || e.classCode === ps.cls).map((e) => [e.unitCode, e.unitName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    const rows = shownUnit();
    const receivable = rows.filter((e) => e.status === 'approved' && !e.receivedAt);
    const links = [ps.sheetUrl && `<a class="btn small" href="${esc(ps.sheetUrl)}" target="_blank" rel="noopener">My attendance sheet in Drive</a>`,
      ps.indexUrl && `<a class="btn small" href="${esc(ps.indexUrl)}" target="_blank" rel="noopener">Evidence index sheet</a>`].filter(Boolean).join('');
    box().innerHTML = `
      <div class="card poe-head">
        <div class="msec-head"><h2>Evidence (POE)</h2><button type="button" class="btn small ghost" data-act="reload">Refresh</button></div>
        ${modeToggle()}
        <p class="muted small">${misOnly() ? 'Submissions the trainers approved arrive here. Mark them received once you have filed them.'
          : 'Students send CAT and practical evidence from the student app. Open one to see it, then approve it or return it with a note.'}</p>
        ${ps.driveReady ? '' : '<p class="warn-text small">The Google Drive bridge has not reported in yet, so students cannot upload. The MIS Officer sets it up once (see the README).</p>'}
        ${links ? `<div class="row-actions">${links}</div>` : ''}
        <div class="chips poe-chips" role="group" aria-label="Show">${chips}</div>
        <div class="poe-filters">
          <select id="poeClass" aria-label="Class"><option value="">All classes</option>${classes.map((c) => `<option${c === ps.cls ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <select id="poeUnitF" aria-label="Unit"><option value="">All units</option>${units.map(([c, n]) => `<option value="${esc(c)}"${c === ps.unit ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <input type="search" id="poeSearch" placeholder="Name or admission no." value="${esc(ps.q)}" aria-label="Search students">
        </div>
      </div>
      ${hasRole('MIS') && receivable.length ? `<div class="card poe-receive"><label class="check"><input type="checkbox" id="poeAll"${receivable.every((e) => ps.picked.has(e.id)) ? ' checked' : ''}> Select all ${receivable.length} shown</label>
        <button type="button" class="btn primary" data-act="receive"${[...ps.picked].some((id) => receivable.some((e) => e.id === id)) ? '' : ' disabled'}>Mark ${[...ps.picked].filter((id) => receivable.some((e) => e.id === id)).length || ''} as received</button></div>` : ''}
      ${rows.length ? unitTable(rows)
        : `<div class="card notice"><h2>${ps.status === 'submitted' ? 'Nothing to review' : 'Nothing here'}</h2><p class="muted">${all.length ? 'Try another filter.' : 'When students send evidence for your units it shows here.'}</p></div>`}`;
  }
  /** By unit: one row per submission, in the order chosen by tapping a heading; Previous / Next in the preview follow it. */
  const statusOf = (e) => (e.receivedAt ? ['locked', 'Received'] : STATUS[e.status] || ['pending', e.status]);
  const shownUnit = () => Tables.sort('poeUnit', filtered(), { name: (e) => e.name, adm: (e) => e.admNo, unit: (e) => e.unitName, item: (e) => ITEMS.indexOf(e.item),
    mark: (e) => markOf(e.classCode, e.unitCode, e.admNo, e.item), sent: (e) => e.submittedAt, status: (e) => statusOf(e)[1] }, 'sent');
  function unitTable(rows) {
    const page = Tables.slice('poeUnit', rows), pick = hasRole('MIS');
    const th = (col, label, cls = '') => Tables.th('poeUnit', col, label, cls);
    return `<div class="card table-card"><div class="table-wrap"><table class="report-table poe-table poe-unit-table">
      <thead><tr>${pick ? '<th class="pick"><span class="sr">Select</span></th>' : ''}${th('name', 'Student')}${th('adm', 'Admission no.')}${th('unit', 'Unit')}${th('item', 'Item')}${th('mark', 'Mark', 'num')}${th('sent', 'Sent')}${th('status', 'Status')}<th><span class="sr">Preview</span></th></tr></thead>
      <tbody>${page.map((e) => unitRow(e, pick)).join('')}</tbody></table></div>
      ${Tables.bar('poeUnit', rows)}
      <div class="row-actions table-actions">
        <button type="button" class="btn" data-act="unit-xlsx"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel</button>
        <button type="button" class="btn" data-act="unit-pdf"><svg class="i" aria-hidden="true"><use href="#i-print"/></svg>Save as PDF</button>
      </div></div>`;
  }
  function unitRow(e, pick) {
    const [cls, label] = statusOf(e), can = pick && e.status === 'approved' && !e.receivedAt;
    const verb = canDecide() && e.status === 'submitted' ? 'Review' : 'Preview';
    return `<tr data-id="${esc(e.id)}">
      ${pick ? `<td class="pick">${can ? `<input type="checkbox" class="poe-pick" data-pick="${esc(e.id)}" aria-label="Select ${esc(e.name)}"${ps.picked.has(e.id) ? ' checked' : ''}>` : ''}</td>` : ''}
      <td><b>${esc(e.name)}</b></td><td class="tadm">${esc(e.admNo)}</td>
      <td class="unit-cell" title="${esc(e.classCode)}">${esc(e.unitName)}</td>
      <td><span class="item-tag">${esc(e.item)}</span>${e.version > 1 ? ` <small class="muted">v${e.version}</small>` : ''}</td>
      <td class="num">${fmtMark(markOf(e.classCode, e.unitCode, e.admNo, e.item))}</td>
      <td class="small">${esc(fmtTime(e.submittedAt))}${e.changedAt ? '<br><b class="warn-text tiny">changed after sending</b>' : ''}</td>
      <td><span class="pill ${cls}">${label}</span></td>
      <td><button type="button" class="btn small${verb === 'Review' ? ' primary' : ''}" data-open="${esc(e.id)}">${verb}</button></td></tr>`;
  }
  /** The by-unit table as plain text, for Excel and the printed copy. */
  function unitSheet(rows) {
    return { head: ['Student', 'Admission no.', 'Class', 'Unit', 'Item', 'Version', 'Mark', 'Sent', 'Status'],
      rows: rows.map((e) => [e.name, e.admNo, e.classCode, e.unitName, e.item, e.version, markOf(e.classCode, e.unitCode, e.admNo, e.item), fmtTime(e.submittedAt), statusOf(e)[1]]) };
  }

  /* ---------- by student: every unit and item of one student, what is in and what is missing ---------- */
  async function loadClass(cls) {
    const res = await api('poeClass', cls ? { classCode: cls } : {});
    if (!res.ok) throw new Error(res.error || 'Could not load the class');
    ps.classes = res.classes || [];
    if (cls) { ps.roster.set(cls, { students: res.students, units: res.units }); keepMarks(res.marks); }
  }
  const latestOf = (adm) => {
    const out = new Map();
    for (const e of ps.list) {
      if (lower(e.admNo) !== lower(adm)) continue;
      const k = e.unitCode + '|' + e.item, had = out.get(k);
      if (!had || e.version > had.version) out.set(k, e);
    }
    return out;
  };
  async function drawStudents() {
    const seq = ps.seq;
    try {
      if (!ps.classes.length) await loadClass('');
      if (!ps.sCls) ps.sCls = ps.classes[0] || '';
      if (ps.sCls && !ps.roster.has(ps.sCls)) {
        const holder = box().querySelector('#poeStudents');
        if (holder) holder.innerHTML = '<p class="muted">Loading the class…</p>';
        else box().innerHTML = '<div class="card"><p class="muted">Loading the class…</p></div>';
        await loadClass(ps.sCls);
      }
    } catch (e) { box().innerHTML = `<div class="card notice"><h2>Could not load the class</h2><p>${esc(e.message)}</p></div>`; return; }
    if (seq !== ps.seq) return;
    const r = ps.roster.get(ps.sCls) || { students: [], units: [] };
    const q = ps.q.trim().toLowerCase();
    const rows = r.students.map((st) => {
      const got = latestOf(st.admNo);
      const units = [...r.units];
      for (const e of got.values()) if (!units.some((u) => u.code === e.unitCode)) units.push({ code: e.unitCode, name: e.unitName }); // moved from another class
      const c = { approved: 0, submitted: 0, returned: 0 };
      for (const e of got.values()) c[e.status]++;
      return { st, got, units, c, sent: got.size };
    });
    const show = rows.filter((x) => (!q || x.st.name.toLowerCase().includes(q) || x.st.admNo.toLowerCase().includes(q))
      && (ps.sFilter === '' || (ps.sFilter === 'none' ? !x.sent : x.c[ps.sFilter] > 0)));
    const total = { none: rows.filter((x) => !x.sent).length, submitted: rows.filter((x) => x.c.submitted).length, returned: rows.filter((x) => x.c.returned).length, approved: rows.filter((x) => x.c.approved).length };
    const chips = [['', 'Everyone'], ['submitted', 'With trainer'], ['returned', 'Returned'], ['approved', 'Has approved'], ['none', 'Nothing sent']]
      .map(([k, l]) => `<button type="button" class="chipbtn${ps.sFilter === k ? ' on' : ''}" data-sfilter="${k}">${l}${k && total[k] ? ` <span class="n">${total[k]}</span>` : ''}</button>`).join('');
    box().innerHTML = `
      <div class="card poe-head">
        <div class="msec-head"><h2>Evidence (POE)</h2><button type="button" class="btn small ghost" data-act="reload">Refresh</button></div>
        ${modeToggle()}
        <div class="chips poe-chips" role="group" aria-label="Show">${chips}</div>
        <div class="poe-filters">
          <select id="poeSClass" aria-label="Class">${ps.classes.map((c) => `<option${c === ps.sCls ? ' selected' : ''}>${esc(c)}</option>`).join('') || '<option value="">No classes this term</option>'}</select>
          <input type="search" id="poeSearch" placeholder="Name or admission no." value="${esc(ps.q)}" aria-label="Search students">
        </div>
      </div>
      <div id="poeStudents">
      <p class="muted small poe-sum">${esc(ps.sCls)} (${r.students.length} students, ${r.units.length} units)</p>
      ${show.length ? studentTable(sortStudents(show)) : `<div class="card notice"><h2>Nobody here</h2><p class="muted">${r.students.length ? 'Try another filter.' : 'This class has no students on its list.'}</p></div>`}
      </div>`;
    ps.shown = sortStudents(show);
  }
  const sortStudents = (list) => Tables.sort('poeStu', list, { name: (x) => x.st.name, adm: (x) => x.st.admNo, sent: (x) => x.sent,
    approved: (x) => x.c.approved, submitted: (x) => x.c.submitted, returned: (x) => x.c.returned }, 'name');
  const SYM = { approved: '✓', returned: '↺', submitted: '•' };
  /** The table's rows as plain text, for Excel and the printed copy. */
  function studentSheet(show) {
    const head = ['Admission no.', 'Name', 'Items sent', 'Approved', 'With trainer', 'Returned', 'Details'];
    const rows = show.map(({ st, got, units, c, sent }) => [st.admNo, st.name, sent, c.approved, c.submitted, c.returned,
      units.map((u) => {
        const mine = [...got.values()].filter((e) => e.unitCode === u.code).sort((a, b) => ITEMS.indexOf(a.item) - ITEMS.indexOf(b.item));
        return mine.length ? `${u.code}: ${mine.map((e) => { const m = markOf(ps.sCls, u.code, st.admNo, e.item); return `${e.item} ${STATUS[e.status]?.[1] || e.status}${m === '' ? '' : ` (${fmtMark(m)})`}`; }).join(', ')}` : '';
      }).filter(Boolean).join('; ')]);
    return { head, rows };
  }
  function studentTable(show) {
    const rows = Tables.slice('poeStu', show);
    return `<div class="card table-card"><div class="table-wrap"><table class="report-table poe-table">
      <thead><tr>${Tables.th('poeStu', 'name', 'Student')}${Tables.th('poeStu', 'adm', 'Admission no.')}${Tables.th('poeStu', 'sent', 'Sent', 'num')}${Tables.th('poeStu', 'approved', 'Approved', 'num')}${Tables.th('poeStu', 'submitted', 'With trainer', 'num')}${Tables.th('poeStu', 'returned', 'Returned', 'num')}<th><span class="sr">Preview</span></th></tr></thead>
      <tbody>${rows.map(studentHtml).join('')}</tbody></table></div>
      ${Tables.bar('poeStu', show)}
      <div class="row-actions table-actions">
        <button type="button" class="btn" data-act="stu-xlsx"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel</button>
        <button type="button" class="btn" data-act="stu-pdf"><svg class="i" aria-hidden="true"><use href="#i-print"/></svg>Save as PDF</button>
      </div></div>`;
  }
  function studentHtml({ st, got, units, c, sent }) {
    const used = ITEMS.filter((it) => [...got.values()].some((e) => e.item === it));
    const cols = used.length ? ITEMS.filter((it) => ITEMS.indexOf(it) <= Math.max(...used.map((u) => ITEMS.indexOf(u))) || it === 'CAT1' || it === 'PRAC1') : ['CAT1', 'CAT2', 'PRAC1'];
    // Each cell: what was sent (tap to preview, approve or return) and, under it, the mark for that item.
    const mark = (e, u, it) => {
      const m = markOf(ps.sCls, u.code, st.admNo, it), mk = m === '' ? '' : `<span class="pm-mark">${fmtMark(m)}</span>`;
      if (!e) return `<td class="pm none">–${mk}</td>`;
      return `<td class="pm"><button type="button" class="pm-btn ${e.status}${e.receivedAt ? ' received' : ''}" data-open="${esc(e.id)}" data-adm="${esc(st.admNo)}" title="${STATUS[e.status]?.[1] || e.status}"
        aria-label="${esc(e.unitName)} ${e.item} ${STATUS[e.status]?.[1] || e.status}">${SYM[e.status] || '•'}${e.version > 1 ? `<small>v${e.version}</small>` : ''}</button>${mk}</td>`;
    };
    // The row's Preview opens the student's first submission waiting for review (else their first one), unit by unit.
    const theirs = units.flatMap((u) => cols.map((it) => got.get(u.code + '|' + it)).filter(Boolean));
    const first = theirs.find((e) => e.status === 'submitted') || theirs[0];
    const open = ps.openStu === st.admNo;
    const n = (v, cls) => `<td class="num">${v ? `<span class="pill ${cls}">${v}</span>` : '–'}</td>`;
    return `<tr class="stu-row${open ? ' open' : ''}" data-adm="${esc(st.admNo)}" tabindex="0" role="button" aria-expanded="${open}">
        <td><b>${esc(st.name)}</b></td><td class="tadm">${esc(st.admNo)}</td>
        <td class="num">${sent || '–'}</td>${n(c.approved, 'synced')}${n(c.submitted, 'pending')}${n(c.returned, 'rejected')}
        <td>${first ? `<button type="button" class="btn small${canDecide() && first.status === 'submitted' ? ' primary' : ''}" data-preview="${esc(first.id)}" data-adm="${esc(st.admNo)}">${canDecide() && first.status === 'submitted' ? 'Review' : 'Preview'}</button>` : ''}</td></tr>
      ${open ? `<tr class="stu-detail"><td colspan="7"><div class="table-wrap"><table class="poe-matrix"><thead><tr><th>Unit</th>${cols.map((it) => `<th>${it}</th>`).join('')}</tr></thead>
        <tbody>${units.map((u) => `<tr><th scope="row">${esc(u.name)}</th>${cols.map((it) => mark(got.get(u.code + '|' + it), u, it)).join('')}</tr>`).join('')}</tbody></table></div>
        <p class="muted tiny pm-key">✓ approved - • with the trainer - ↺ returned - – not sent. The number under each is the mark in the unit's marksheet.</p></td></tr>` : ''}`;
  }

  /* ---------- preview ---------- */
  /* Files are kept on this device after the first look (an evidence file never changes: a new version gets a
   * new id), and the next submission in the list is fetched while the trainer reads this one. */
  const FILE_CACHE = 'rvnp-poe-files';
  const fileKey = (id) => `./__poe-file/${encodeURIComponent(id)}`;
  async function cachedFile(id) {
    try {
      const hit = await (await caches.open(FILE_CACHE)).match(fileKey(id));
      if (!hit) return null;
      return { bytes: new Uint8Array(await hit.arrayBuffer()), mime: hit.headers.get('Content-Type') || 'application/pdf', name: decodeURIComponent(hit.headers.get('X-Name') || ''), md5: hit.headers.get('X-Md5') || '' };
    } catch { return null; }
  }
  async function keepFile(id, file) {
    try {
      const c = await caches.open(FILE_CACHE);
      await c.put(fileKey(id), new Response(file.bytes, { headers: { 'Content-Type': file.mime, 'X-Name': encodeURIComponent(file.name || ''), 'X-Md5': file.md5 || '' } }));
      const keys = await c.keys();
      for (const k of keys.slice(0, Math.max(0, keys.length - 60))) await c.delete(k);   // the 60 most recent
    } catch { /* storage full or private mode: it is fetched again next time */ }
  }
  /* A document in the student's own Drive: opened with the trainer's Google sign-in. Its fingerprint (md5) is
   * compared with the one recorded when it was sent, so a file changed afterwards is flagged. */
  const needGoogle = () => Object.assign(new Error('Connect your Google account to open this document.'), { needGoogle: true });
  async function driveFile(id) {
    const hit = await cachedFile(id);
    if (!navigator.onLine) { if (hit) return hit; throw new Error('Connect to the internet to open this document.'); }
    if (!Google.token('staff')) { if (hit) return hit; throw needGoogle(); }
    const v = await api('poeView', { id });
    if (!v.ok) throw new Error(v.error);
    let m;
    try { m = await Google.meta('staff', v.fileId); } catch (err) {
      if (err instanceof Google.NeedSignIn) throw needGoogle();
      if (err.status === 404 || err.status === 403) throw new Error(`This document has not been shared with ${Google.email() || 'your Google account'} yet. It is shared when the student's phone is next online. Check that the Google account in Profile is your college one.`);
      throw err;
    }
    const changed = !!(v.md5 && m.md5Checksum && m.md5Checksum !== v.md5);
    if (changed) api('poeChanged', { id, md5: m.md5Checksum }).catch(() => {});
    if (hit && hit.md5 && hit.md5 === m.md5Checksum) return { ...hit, changed };
    const file = { bytes: await Google.download('staff', v.fileId), mime: 'application/pdf', name: v.fileName, md5: m.md5Checksum || '', changed };
    keepFile(id, file);
    return file;
  }
  const fetching = new Map();
  function fetchFile(id) {
    if (ps.files.has(id)) return Promise.resolve(ps.files.get(id));
    if (fetching.has(id)) return fetching.get(id);
    const job = (async () => {
      if (ps.list.find((x) => x.id === id)?.source === 'drive') {
        const file = await driveFile(id);
        ps.files.set(id, file);
        if (ps.files.size > 12) ps.files.delete(ps.files.keys().next().value);
        return file;
      }
      let file = await cachedFile(id);
      if (!file) {
        const v = await api('poeView', { id });
        if (!v.ok) throw new Error(v.error);
        const res = await fetch(v.driveUrl + (v.driveUrl.includes('?') ? '&' : '?') + 'action=file&ticket=' + encodeURIComponent(v.ticket), { redirect: 'follow' });
        const out = await res.json();
        if (!out.ok) throw new Error(out.error || 'The Drive did not send the file');
        const bin = atob(out.data), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        file = { bytes, mime: out.mime || 'application/pdf', name: out.name };
        keepFile(id, file);
      }
      ps.files.set(id, file);
      if (ps.files.size > 12) ps.files.delete(ps.files.keys().next().value);
      return file;
    })().finally(() => fetching.delete(id));
    fetching.set(id, job);
    return job;
  }
  const prefetch = (ids) => { for (const x of ids) if (x && navigator.onLine) fetchFile(x).catch(() => {}); };
  async function openViewer(id, order) {
    const e = ps.list.find((x) => x.id === id); if (!e) return;
    ps.open = id;
    if (order) ps.order = order;
    else if (!ps.order.includes(id)) ps.order = shownUnit().map((x) => x.id);
    order = ps.order;
    const i = order.indexOf(id);
    const decided = e.status !== 'submitted';
    $('#poeDialogBody').innerHTML = `
      <div class="poe-view-head">
        <div><h2>${esc(e.name)} <span class="item-tag small-tag">${esc(e.item)}</span></h2>
          <p class="muted small">${esc(e.admNo)} - ${esc(e.unitName)} v${e.version}</p></div>
        <button type="button" class="btn small ghost" data-act="close">Close</button>
      </div>
      ${decided ? `<p class="poe-decided ${e.status}">${e.status === 'approved' ? `Approved by ${esc(e.decidedName)}${e.receivedAt ? ' and received by the MIS Officer' : ''}.` : `Returned by ${esc(e.decidedName)}.`}</p>
        ${e.comment ? `<p class="small"><b>Comment(s):</b> ${esc(e.comment)}</p>` : ''}` : ''}
      <div id="poePages" class="poe-pages-view" aria-live="polite"><p class="muted">Opening ${esc(e.fileName)}…</p></div>
      <div class="poe-view-actions">
        <span class="poe-nav"><button type="button" class="btn small" data-nav="${order[i - 1] || ''}" ${i > 0 ? '' : 'disabled'} aria-label="Previous submission">‹ Previous</button>
        <button type="button" class="btn small" data-nav="${order[i + 1] || ''}" ${i >= 0 && i < order.length - 1 ? '' : 'disabled'} aria-label="Next submission">Next ›</button></span>
        <a class="btn small ghost" href="https://drive.google.com/file/d/${esc(e.fileId)}/view" target="_blank" rel="noopener">Open in Drive</a>
      </div>
      ${canDecide() && (e.status === 'submitted' || hasRole('HOD') || e.decidedName === me().name) && !e.receivedAt ? `
      <div class="poe-decide">
        <label>Note to the student <span class="muted small">(needed when returning)</span><textarea id="poeComment" rows="2" maxlength="500" placeholder="For example: page 2 is missing">${esc(e.status === 'returned' ? e.comment : '')}</textarea></label>
        <div class="row-actions"><button type="button" class="btn danger" data-decide="returned">Return to student</button><button type="button" class="btn primary" data-decide="approved">${e.status === 'approved' ? 'Approved ✓' : 'Approve'}</button></div>
      </div>` : ''}`;
    if (!$('#poeDialog').open) $('#poeDialog').showModal();
    Imports.pdfLib().catch(() => {});            // the PDF reader loads while the file is on its way
    try {
      const file = await fetchFile(id);
      prefetch([order[i + 1], order[i - 1]]);
      if (ps.open !== id) return;
      if (file.changed || e.changedAt) $('#poePages').insertAdjacentHTML('beforebegin', '<p class="poe-changed">This file was changed in the student\'s Drive after it was sent. Check it carefully before deciding.</p>');
      await showPdf(file);
    } catch (err) {
      if (ps.open !== id) return;
      $('#poePages').innerHTML = err.needGoogle
        ? `<p>${esc(err.message)} Students now save their documents in their own college Google Drive and share them with you.</p><button type="button" class="btn primary" data-act="gconnect">${me()?.email ? 'Sign in to Google' : 'Connect Google'}</button>`
        : `<p class="err-text">${esc(err.message)}</p><p class="muted small">You can still open it in Drive.</p>`;
    }
  }
  async function showPdf(file) {
    const holder = $('#poePages');
    if (!/pdf/.test(file.mime)) {
      const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mime }));
      holder.innerHTML = /^image\//.test(file.mime) ? `<img src="${url}" alt="Evidence" class="poe-img">` : `<p><a href="${url}" download="${esc(file.name)}">Download ${esc(file.name)}</a></p>`;
      return;
    }
    const lib = await Imports.pdfLib();
    const doc = await lib.getDocument({ data: file.bytes.slice() }).promise;
    holder.innerHTML = `<p class="muted small">${doc.numPages} page${doc.numPages === 1 ? '' : 's'}</p>`;
    const width = Math.min(holder.clientWidth || 640, 900), dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: (width / base.width) * dpr });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height); c.style.width = width + 'px';
      c.setAttribute('aria-label', `Page ${n}`); c.className = 'poe-page';
      holder.appendChild(c);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    }
    doc.destroy?.();
  }
  async function decide(decision, btn) {
    const comment = $('#poeComment')?.value.trim() || '';
    if (decision === 'returned' && !comment) { toast('Write what needs fixing, then return it', 'err'); $('#poeComment').focus(); return; }
    btn.disabled = true;
    try {
      const r = await api('poeDecide', { id: ps.open, decision, comment });
      if (!r.ok) throw new Error(r.error);
      const i = ps.list.findIndex((x) => x.id === r.evidence.id); if (i >= 0) ps.list[i] = r.evidence;
      toast(decision === 'approved' ? 'Approved' : 'Returned to the student', 'ok');
      badge();
      // Straight on to the next one waiting, so a class can be reviewed in one go.
      const order = ps.order, at = order.indexOf(ps.open);
      const next = ps.mode === 'unit' && [...order.slice(at + 1), ...order.slice(0, Math.max(0, at))].map((id) => ps.list.find((x) => x.id === id)).find((x) => x && x.status === 'submitted');
      draw();
      if (next && ps.status === 'submitted') openViewer(next.id, shownUnit().map((x) => x.id)); else $('#poeDialog').close();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }
  async function receive(btn) {
    const ids = [...ps.picked].filter((id) => ps.list.some((e) => e.id === id && e.status === 'approved' && !e.receivedAt));
    if (!ids.length) return;
    btn.disabled = true;
    try {
      const r = await api('poeReceive', { ids });
      if (!r.ok) throw new Error(r.error);
      const now = new Date().toISOString();
      for (const e of ps.list) if (ids.includes(e.id)) e.receivedAt = now;
      ps.picked.clear();
      toast(`${ids.length} marked as received`, 'ok');
      badge(); draw();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }

  function wire() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#poe, #poeDialog')) return;
      const t = e.target;
      const s = t.closest('[data-status]'); if (s && t.closest('#poe')) { ps.status = s.dataset.status; ps.picked.clear(); Tables.reset('poeUnit'); draw(); return; }
      const m = t.closest('[data-mode]'); if (m && t.closest('#poe')) { ps.mode = m.dataset.mode; ps.q = ''; ps.seq++; draw(); return; }
      const sf = t.closest('[data-sfilter]'); if (sf) { ps.sFilter = sf.dataset.sfilter; Tables.reset('poeStu'); draw(); return; }
      const pv = t.closest('[data-preview]');
      if (pv) {
        // By student, the row's Preview: that student's files, unit by unit, from their first one waiting.
        const row = ps.shown?.find((x) => x.st.admNo === pv.dataset.adm);
        const ids = row ? row.units.flatMap((u) => ITEMS.map((it) => row.got.get(u.code + '|' + it)?.id).filter(Boolean)) : [pv.dataset.preview];
        openViewer(pv.dataset.preview, ids); return;
      }
      const row = t.closest('.stu-row');
      if (row && t.closest('#poe')) { ps.openStu = ps.openStu === row.dataset.adm ? '' : row.dataset.adm; draw(); return; }
      const o = t.closest('[data-open]');
      if (o && o.dataset.adm) {
        // By student: previous / next go through that student's files, unit by unit.
        ps.openStu = o.dataset.adm;
        const ids = [...o.closest('.stu-detail').querySelectorAll('[data-open]')].map((b) => b.dataset.open);
        openViewer(o.dataset.open, ids); return;
      }
      if (o) { openViewer(o.dataset.open, shownUnit().map((x) => x.id)); return; }
      const n = t.closest('[data-nav]'); if (n && n.dataset.nav) { openViewer(n.dataset.nav); return; }
      const d = t.closest('[data-decide]'); if (d) { decide(d.dataset.decide, d); return; }
      const a = t.closest('[data-act]');
      if (a?.dataset.act === 'close') $('#poeDialog').close();
      if (a?.dataset.act === 'gconnect') { const id = ps.open; connectGoogle(false).then((ok) => { if (ok && id) { ps.files.delete(id); openViewer(id); } }); }
      if (a?.dataset.act === 'reload') { ps.files.clear(); ps.roster.clear(); ps.classes = []; render(); }
      if (a?.dataset.act === 'receive') receive(a);
      if (a?.dataset.act === 'unit-xlsx' || a?.dataset.act === 'unit-pdf') {
        const { head, rows } = unitSheet(shownUnit());
        const title = `Evidence ${ps.cls || 'all classes'}${ps.unit ? ' ' + ps.unit : ''}`;
        if (a.dataset.act === 'unit-xlsx') Tables.exportXlsx(title, head, rows); else Tables.print(title, `${rows.length} submissions`, head, rows);
      }
      if (a?.dataset.act === 'stu-xlsx' || a?.dataset.act === 'stu-pdf') {
        const { head, rows } = studentSheet(ps.shown || []);
        const title = `Evidence ${ps.sCls}`;
        if (a.dataset.act === 'stu-xlsx') Tables.exportXlsx(title, head, rows); else Tables.print(title, `${rows.length} students`, head, rows);
      }
    });
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'poeClass') { ps.cls = t.value; ps.unit = ''; Tables.reset('poeUnit'); draw(); }
      if (t.id === 'poeUnitF') { ps.unit = t.value; Tables.reset('poeUnit'); draw(); }
      if (t.id === 'poeSClass') { ps.sCls = t.value; ps.openStu = ''; ps.seq++; Tables.reset('poeStu'); draw(); }
      if (t.dataset?.pick) { if (t.checked) ps.picked.add(t.dataset.pick); else ps.picked.delete(t.dataset.pick); draw(); }
      if (t.id === 'poeAll') { for (const x of filtered()) if (x.status === 'approved' && !x.receivedAt) { if (t.checked) ps.picked.add(x.id); else ps.picked.delete(x.id); } draw(); }
    });
    document.addEventListener('input', (e) => {
      if (e.target.id !== 'poeSearch') return;
      ps.q = e.target.value; Tables.reset('poeStu'); Tables.reset('poeUnit');
      clearTimeout(ps.qt); ps.qt = setTimeout(() => { const pos = e.target.selectionStart; draw(); const s = $('#poeSearch'); s.focus(); s.setSelectionRange(pos, pos); }, 200);
    });
    $('#poeDialog').addEventListener('close', () => { ps.open = null; });
    document.addEventListener('keydown', (e) => {
      const row = e.target.closest?.('.stu-row');
      if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
    });
    Tables.on('poeStu', () => draw());
    Tables.on('poeUnit', () => draw());
  }
  /** After sign-in: count what is waiting, for the tab's dot (one small request). */
  async function refreshBadge() {
    if (!me() || state.auth?.mustChange || !navigator.onLine || Date.now() - (ps.badgeAt || 0) < 15 * 60e3) return;
    ps.badgeAt = Date.now();
    try { await load(); } catch { /* shown when the tab opens */ }
  }
  function reset() { Object.assign(ps, { list: [], status: '', cls: '', unit: '', q: '', loaded: false, open: null, badgeAt: 0, mode: 'unit', classes: [], sCls: '', sFilter: '', order: [], openStu: '' }); ps.roster.clear(); ps.files.clear(); ps.picked.clear(); ps.marks.clear(); badge(); }
  return { render, wire, refreshBadge, reset, state: ps };
})();
