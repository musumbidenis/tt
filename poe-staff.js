/* POE tab — trainers review the evidence students sent for their units: preview inside the app, approve or
 * return with a note. The HOD, the MIS Officer and the Internal Assessment Officer see the department. The Verification
 * view (verify.js) is the panels' internal verification. Files stay in Drive; the preview is fetched through the bridge.
 * Uses app.js (api, state, $, $$, esc, toast, hasRole, me) and Imports.pdfLib (pdf.js). */
'use strict';

const PoeStaff = (() => {
  const ITEMS = ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'PRAC1', 'PRAC2', 'PRAC3'];
  const STATUS = { submitted: ['pending', 'To review'], approved: ['synced', 'Approved'], returned: ['rejected', 'Returned'] };
  const ps = { picked: new Set(), list: [], status: '', cls: '', unit: '', q: '', loaded: false, sheetUrl: '', indexUrl: '', driveReady: true, open: null, files: new Map(), seq: 0, mode: 'unit', classes: [], roster: new Map(), sCls: '', sFilter: '', order: [], marks: new Map() };
  /* Marks from the unit's marksheet, beside the evidence they are for: CAT1 → cat1 … PRAC3 → prac3 (CAT4 has no mark column). */
  const markKey = (cls, unit, adm) => `${cls}|${unit}|${lower(adm)}`;
  const keepMarks = (rows) => { for (const m of rows || []) ps.marks.set(markKey(m.c, m.u, m.a), m); };
  const markOf = (cls, unit, adm, item) => { const v = ps.marks.get(markKey(cls, unit, adm))?.[String(item).toLowerCase()]; return v === undefined || v === null ? '' : v; };
  const fmtMark = (v) => (v === '' ? '–' : String(Math.round(v * 10) / 10));
  const box = () => $('#poe');
  const visitorOnly = () => hasRole('EAO') && !['TRAINER', 'HOD', 'MIS', 'IAO'].some(hasRole);
  const canDecide = () => hasRole('TRAINER') || hasRole('HOD');
  const trainerPoeAllowed = () => hasRole('TRAINER') || hasRole('HOD') || hasRole('MIS') || hasRole('IAO') || hasRole('EAO');

  /** Until this person has connected Google (once), a card at the top of the tab: students' documents open with it. */
  const connectCard = () => (typeof Google !== 'undefined' && Google.on() && !Google.connected('staff')
    ? `<div class="connect-card"><div><b>Connect your college Google account</b><span class="small">Students' documents are in their own Google Drive and shared with you. Connect once and they open straight away - you will not be asked again.</span></div>
      <button type="button" class="btn primary small" data-act="gconnect">Connect Google</button></div>` : '');
  async function load() {
    const res = await api('poeList', {});
    if (!res.ok) throw new Error(res.error || 'Could not load the evidence');
    Object.assign(ps, { list: res.evidence, sheetUrl: res.sheetUrl || '', indexUrl: res.indexUrl || '', driveReady: res.driveReady !== false, loaded: true });
    keepMarks(res.marks);
    badge();
  }
  function badge() {
    const n = canDecide() ? ps.list.filter((e) => e.status === 'submitted').length : 0;
    const dot = $('#poeCount'); if (!dot) return;
    dot.hidden = !n; dot.textContent = n > 99 ? '99+' : String(n);
  }

  async function render() {
    if (!me()) return;
    if (!ps.status) ps.status = 'submitted';
    if (visitorOnly() && ps.mode !== 'trainer') ps.mode = 'verify';
    if (!navigator.onLine) {
      box().innerHTML = '<div class="card notice"><h2>Evidence needs internet</h2><p>The students\' files are in the college Google Drive. Connect to review them.</p></div>';
      return;
    }
    if (!ps.loaded) box().innerHTML = '<div class="card"><p class="muted">Loading evidence…</p></div>';
    const seq = ++ps.seq;
    try { await load(); } catch (e) { if (seq === ps.seq) box().innerHTML = `<div class="card notice"><h2>Could not load evidence</h2><p>${esc(e.message)}</p></div>`; return; }
    if (seq === ps.seq) draw();
  }

  /** Only the latest version of each student's item: an older one sent again is not reviewed (an approved one stays on the server). */
  function latestOnly() {
    const top = new Map();
    for (const e of ps.list) { const k = lower(e.admNo) + '|' + e.unitCode + '|' + e.item; if (!(top.get(k)?.version >= e.version)) top.set(k, e); }
    return ps.list.filter((e) => top.get(lower(e.admNo) + '|' + e.unitCode + '|' + e.item) === e);
  }
  const statusOf = (e) => STATUS[e.status] || ['pending', e.status];
  /** The latest submissions matching the class / unit / search filters (the status chip is applied per student, not here,
   *  so a listed student still shows all their items whatever each one's state). */
  function base() {
    const q = ps.q.trim().toLowerCase();
    return latestOnly().filter((e) => (!ps.cls || e.classCode === ps.cls) && (!ps.unit || e.unitCode === ps.unit)
      && (!q || e.name.toLowerCase().includes(q) || e.admNo.toLowerCase().includes(q)));
  }
  /** One entry per student who has submitted (for the current filters), their items unit-first then in CAT/PRAC order. */
  function byStudent() {
    const map = new Map();
    for (const e of base()) {
      const k = lower(e.admNo);
      if (!map.has(k)) map.set(k, { name: e.name, admNo: e.admNo, classCode: e.classCode, items: [], counts: { submitted: 0, approved: 0, returned: 0 } });
      const r = map.get(k); r.items.push(e); r.counts[e.status] = (r.counts[e.status] || 0) + 1;
    }
    for (const r of map.values()) r.items.sort((a, b) => (a.unitName || '').localeCompare(b.unitName || '') || ITEMS.indexOf(a.item) - ITEMS.indexOf(b.item));
    // The status chip chooses which students are listed; each one still shows every item so a mixed state reads at a glance.
    return [...map.values()].filter((r) => !ps.status || r.counts[ps.status] > 0);
  }
  const sortedStudents = () => Tables.sort('poeUnit', byStudent(), { name: (r) => r.name, adm: (r) => r.admNo,
    items: (r) => r.items.length, pending: (r) => r.counts.submitted }, 'name');
  /** Every shown student's files in display order, so Previous / Next in the preview walk one student then roll on to the next. */
  const evidenceOrder = () => sortedStudents().flatMap((r) => r.items.map((e) => e.id));

  const modeToggle = () => (visitorOnly()
    ? `<div class="view-tabs poe-mode" role="group" aria-label="View">
      <button type="button" data-mode="verify" aria-pressed="${ps.mode === 'verify'}">Verification</button>
      <button type="button" data-mode="trainer" aria-pressed="${ps.mode === 'trainer'}">Trainer POE</button></div>`
    : `<div class="view-tabs poe-mode" role="group" aria-label="View">
      <button type="button" data-mode="unit" aria-pressed="${ps.mode === 'unit'}">Evidence</button>
      ${trainerPoeAllowed() ? `<button type="button" data-mode="trainer" aria-pressed="${ps.mode === 'trainer'}">Trainer POE</button>` : ''}
      <button type="button" data-mode="verify" aria-pressed="${ps.mode === 'verify'}">Verification</button></div>`);
  function draw() {
    if (ps.mode === 'verify') return Verify.render(box(), modeToggle());
    if (ps.mode === 'trainer' && trainerPoeAllowed()) return PoeTrainer.render(box(), modeToggle());
    const all = ps.list, counts = { submitted: 0, approved: 0, returned: 0 };
    for (const e of latestOnly()) counts[e.status] = (counts[e.status] || 0) + 1;
    const chips = [['submitted', canDecide() ? 'To review' : 'With trainers'], ['approved', 'Approved'], ['returned', 'Returned'], ['', 'All']]
      .map(([k, l]) => `<button type="button" class="chipbtn${ps.status === k ? ' on' : ''}" data-status="${k}">${l}${k && counts[k] ? ` <span class="n">${counts[k]}</span>` : ''}</button>`).join('');
    const classes = [...new Set(all.map((e) => e.classCode))].sort();
    // Start scoped to one class and unit (simpler than everything at once); the person can still switch to All.
    if (!ps.defaulted && classes.length) { ps.defaulted = true; if (!ps.cls) ps.cls = classes[0]; }
    const units = [...new Map(all.filter((e) => !ps.cls || e.classCode === ps.cls).map((e) => [e.unitCode, e.unitName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (!ps.unitDefaulted && ps.cls && units.length) { ps.unitDefaulted = true; if (!ps.unit) ps.unit = units[0][0]; }
    const students = sortedStudents();
    const links = [ps.sheetUrl && `<a class="btn small" href="${esc(ps.sheetUrl)}" target="_blank" rel="noopener">My attendance sheet in Drive</a>`,
      ps.indexUrl && `<a class="btn small" href="${esc(ps.indexUrl)}" target="_blank" rel="noopener">Evidence index sheet</a>`].filter(Boolean).join('');
    box().innerHTML = `
      <div class="card poe-head">
        <div class="msec-head"><h2>Evidence (POE)</h2><button type="button" class="btn small ghost" data-act="reload">Refresh</button></div>
        ${connectCard()}
        ${modeToggle()}
        <p class="muted small">${canDecide() ? 'Students send CAT and practical evidence from the student app. Pick a class and unit, open a student to review what they sent, then approve or return each item.'
          : 'Students send CAT and practical evidence from the student app; their trainers approve it or return it with a note.'}</p>
        ${ps.driveReady ? '' : '<p class="warn-text small">The Google Drive bridge has not reported in yet, so students cannot upload. The MIS Officer sets it up once (see the README).</p>'}
        ${links ? `<div class="row-actions">${links}</div>` : ''}
        <div class="chips poe-chips" role="group" aria-label="Show">${chips}</div>
        <div class="poe-filters">
          <select id="poeClass" aria-label="Class">${classes.map((c) => `<option${c === ps.cls ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <select id="poeUnitF" aria-label="Unit">${units.map(([c, n]) => `<option value="${esc(c)}"${c === ps.unit ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <input type="search" id="poeSearch" placeholder="Name or admission no." value="${esc(ps.q)}" aria-label="Search students">
        </div>
      </div>
      ${students.length ? studentTable(students)
        : `<div class="card notice"><h2>${ps.status === 'submitted' ? 'Nothing to review' : 'Nothing here'}</h2><p class="muted">${all.length ? 'Try another filter.' : 'When students send evidence for your units it shows here.'}</p></div>`}`;
  }
  /** Students this person may approve in one go: those with at least one item still waiting (the server checks each is theirs). */
  const batchable = (list) => (canDecide() ? list.filter((r) => r.counts.submitted > 0) : []);
  const SYM = { approved: '✓', returned: '↺', submitted: '•' };
  /** One row per student: name, the items they sent as state-coloured chips, and a Review button (marks live in the preview). */
  function studentTable(list) {
    const page = Tables.slice('poeUnit', list), off = Tables.offset('poeUnit');
    const th = (col, label, cls = '') => Tables.th('poeUnit', col, label, cls);
    const pick = batchable(page);
    const pendingOf = (r) => r.items.filter((e) => e.status === 'submitted').map((e) => e.id);
    return `<div class="card table-card">${pick.length ? `<div class="batch-bar"><label class="kchip"><input type="checkbox" data-pickall${pick.length && pick.every((r) => pendingOf(r).every((id) => ps.picked.has(id))) ? ' checked' : ''}><span>Select all ${pick.length} shown</span></label>
      <button type="button" class="btn primary small" data-act="batch-approve"${ps.picked.size ? '' : ' disabled'}>Approve selected${ps.picked.size ? ` (${ps.picked.size})` : ''}</button>
      <button type="button" class="btn small" data-act="batch-return"${ps.picked.size ? '' : ' disabled'}>Return selected${ps.picked.size ? ` (${ps.picked.size})` : ''}</button>
      <span class="muted small">Approving without a note says: ${esc(OK_SAID.poe)}</span></div>` : ''}<div class="table-wrap"><table class="report-table poe-table poe-stu-table">
      <thead><tr>${pick.length ? '<th class="pick"><span class="sr">Select</span></th>' : ''}<th class="sn">S/N</th>${th('name', 'Student')}<th>Items</th><th><span class="sr">Review</span></th></tr></thead>
      <tbody>${page.map((r, i) => studentRow(r, off + i + 1, pick.length > 0)).join('')}</tbody></table></div>
      ${Tables.bar('poeUnit', list)}
      <div class="row-actions table-actions">
        <button type="button" class="btn" data-act="unit-xlsx"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel</button>
        <button type="button" class="btn" data-act="unit-pdf"><svg class="i" aria-hidden="true"><use href="#i-print"/></svg>Save as PDF</button>
      </div></div>`;
  }
  function studentRow(r, sn, picking) {
    const pendingIds = r.items.filter((e) => e.status === 'submitted').map((e) => e.id);
    const reviewable = canDecide() && pendingIds.length > 0;
    const chips = r.items.map((e) => `<span class="poe-item-chip ${e.status}" title="${esc(e.unitName)} - ${statusOf(e)[1]}${e.changedAt ? ' - changed after sending' : ''}">${esc(e.item)} <span class="ci">${SYM[e.status] || ''}</span>${e.version > 1 ? `<small>v${e.version}</small>` : ''}</span>`).join('');
    const first = r.items.find((e) => e.status === 'submitted') || r.items[0];
    return `<tr>${picking ? `<td class="pick">${pendingIds.length ? `<input type="checkbox" data-pick-stu="${esc(r.admNo)}"${pendingIds.every((id) => ps.picked.has(id)) ? ' checked' : ''} aria-label="Select ${esc(r.name)}">` : ''}</td>` : ''}<td class="sn">${sn}</td>
      <td><b>${esc(r.name)}</b><small class="tadm">${esc(r.admNo)}</small></td>
      <td class="poe-items">${chips}</td>
      <td><button type="button" class="btn small${reviewable ? ' primary' : ''}" data-open="${esc(first.id)}">${reviewable ? 'Review' : 'View'}</button></td></tr>`;
  }
  /** One page for an approved submission: what it is, and the stamp, name and QR code. The student's file is never changed. */
  function printSlip(e) {
    if (!e?.approvalRef) return;
    $('#printArea').innerHTML = `<div class="tbl-print slip-print"><h1>POE EVIDENCE - APPROVAL</h1><p>Rift Valley National Polytechnic - Department of Computing and Informatics</p>
      <table><tbody><tr><th>Student</th><td>${esc(e.name)}</td></tr><tr><th>Admission no.</th><td>${esc(e.admNo)}</td></tr><tr><th>Class</th><td>${esc(e.classCode)}</td></tr>
      <tr><th>Unit</th><td>${esc(e.unitCode)} - ${esc(e.unitName)}</td></tr><tr><th>Item</th><td>${esc(e.item)} (version ${e.version})</td></tr><tr><th>File</th><td>${esc(e.fileName || '')}</td></tr>
      <tr><th>Sent</th><td>${esc(fmtTime(e.submittedAt))}</td></tr><tr><th>Mark</th><td>${fmtMark(markOf(e.classCode, e.unitCode, e.admNo, e.item))}</td></tr></tbody></table>
      ${approvalBlock({ ref: e.approvalRef, by: e.decidedName, role: 'Trainer', at: e.decidedAt })}</div>`;
    document.body.classList.add('printing', 'print-table');
    const done = () => { document.body.classList.remove('printing', 'print-table'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 80);
  }

  /** The shown students flattened to plain rows for Excel / the printed copy: one line per submitted item, with its mark. */
  function reportSheet() {
    const head = ['S/N', 'Student', 'Admission no.', 'Class', 'Unit', 'Item', 'Version', 'Mark', 'Sent', 'Status', 'Approval ref'];
    let n = 0;
    const rows = sortedStudents().flatMap((r) => r.items.map((e) => [++n, e.name, e.admNo, e.classCode, e.unitName, e.item, e.version,
      markOf(e.classCode, e.unitCode, e.admNo, e.item), fmtTime(e.submittedAt), statusOf(e)[1], e.approvalRef || '']));
    return { head, rows };
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
    try { await Google.ensure('staff'); } catch (err) {
      if (err instanceof Google.NeedSignIn) { if (hit) return hit; throw needGoogle(); }
      if (hit) return hit; throw err;
    }
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
    else if (!ps.order.includes(id)) ps.order = evidenceOrder();
    order = ps.order;
    const i = order.indexOf(id);
    const decided = e.status !== 'submitted';
    const mark = fmtMark(markOf(e.classCode, e.unitCode, e.admNo, e.item));
    const canAct = canDecide() && (e.status === 'submitted' || hasRole('HOD') || e.decidedName === me().name);
    // Minimalist: who + item + the mark in the system, the page, then one row of actions (Prev/Next, Approve/Return, Close).
    $('#poeDialogBody').innerHTML = `
      <div class="poe-view2">
        <div class="poe-view2-top">
          <div><b>${esc(e.name)}</b> <span class="muted small">${esc(e.admNo)} · ${esc(e.unitName)}</span></div>
          <button type="button" class="btn small ghost" data-act="close" aria-label="Close">✕</button>
        </div>
        <div class="poe-view2-item">
          <span class="item-tag">${esc(e.item)}${e.version > 1 ? ` v${e.version}` : ''}</span>
          <span class="poe-view2-mark">Mark <b>${mark}</b></span>
          ${decided ? `<span class="pill ${statusOf(e)[0]}">${statusOf(e)[1]}${e.decidedName ? ' · ' + esc(e.decidedName) : ''}</span>` : ''}
          ${order.length > 1 ? `<span class="muted tiny poe-view2-pos">${i + 1} / ${order.length}</span>` : ''}
        </div>
        ${decided && e.comment ? `<p class="so-quote small"><b>Note:</b> ${esc(e.comment)}</p>` : ''}
        <div id="poePages" class="poe-pages-view" aria-live="polite"><p class="muted">Opening…</p></div>
        ${canAct ? `<div class="poe-view2-note"><textarea id="poeComment" rows="1" maxlength="500" placeholder="Note to the student (needed to return; approve leaves: ${esc(OK_SAID.poe)})">${esc(e.status === 'returned' ? e.comment : '')}</textarea>${quickSays('poe', 'poeComment')}</div>` : ''}
        <div class="poe-view2-actions">
          <div class="poe-nav"><button type="button" class="btn small" data-nav="${order[i - 1] || ''}" ${i > 0 ? '' : 'disabled'} aria-label="Previous">‹ Prev</button>
            <button type="button" class="btn small" data-nav="${order[i + 1] || ''}" ${i >= 0 && i < order.length - 1 ? '' : 'disabled'} aria-label="Next">Next ›</button></div>
          ${canAct ? `<div class="poe-decide2"><button type="button" class="btn danger small" data-decide="returned">Return</button>
            <button type="button" class="btn primary small" data-decide="approved">${e.status === 'approved' ? 'Approved ✓' : 'Approve'}</button></div>` : ''}
          <div class="poe-view2-more">${e.status === 'approved' && e.approvalRef ? '<button type="button" class="btn small ghost" data-act="slip">Slip</button>' : ''}
            <a class="btn small ghost" href="https://drive.google.com/file/d/${esc(e.fileId)}/view" target="_blank" rel="noopener">Drive</a></div>
        </div>
      </div>`;
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
        ? `<p>${esc(err.message)} Students now save their documents in their own college Google Drive and share them with you.</p><button type="button" class="btn primary" data-act="gconnect">Connect Google</button>`
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
    // Render each page well above its shown size so scanned pages stay crisp (and sharp when zoomed). The page is still
    // displayed at `width` CSS px; the extra backing pixels are what fixes the blur the old 900px/2x render showed.
    const width = Math.min(holder.clientWidth || 640, 1100), dpr = Math.min(window.devicePixelRatio || 1, 2), QUALITY = 1.6;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: (width / base.width) * dpr * QUALITY });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height); c.style.width = width + 'px';
      c.setAttribute('aria-label', `Page ${n}`); c.className = 'poe-page';
      holder.appendChild(c);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    }
    doc.destroy?.();
  }
  /** Approves the ticked rows, 50 at a time, with one PIN. */
  async function batchApprove(btn) {
    const ids = [...ps.picked].filter((id) => ps.list.find((x) => x.id === id)?.status === 'submitted');
    if (!ids.length) return;
    btn.disabled = true;
    let done = 0, failed = 0;
    try {
      for (let i = 0; i < ids.length; i += 50) {
        const r = await withPin(`Approve ${ids.length} piece${ids.length === 1 ? '' : 's'} of evidence`, (pin) => api('poeDecideMany', { ids: ids.slice(i, i + 50), pin }));
        if (!r) break;
        if (!r.ok) throw new Error(r.error);
        for (const ev of r.evidence) { const k = ps.list.findIndex((x) => x.id === ev.id); if (k >= 0) ps.list[k] = ev; ps.picked.delete(ev.id); }
        done += r.evidence.length; failed += r.failed.length;
      }
      if (done) toast(`Approved ${done}${failed ? ` - ${failed} could not be approved` : ''}`, failed ? 'err' : 'ok');
    } catch (e) { toast(e.message, 'err'); }
    badge(); draw();
  }
  /** Returns the ticked rows with one note (no PIN needed), one after another. */
  async function batchReturn(btn) {
    const ids = [...ps.picked].filter((id) => ps.list.find((x) => x.id === id)?.status === 'submitted');
    if (!ids.length) return;
    const comment = (prompt(`Write what needs fixing (sent to ${ids.length} student${ids.length === 1 ? '' : 's'}):`) || '').trim();
    if (!comment) { toast('Write a note to return them', 'err'); return; }
    btn.disabled = true;
    let done = 0, failed = 0, firstErr = '';
    for (const id of ids) {
      try {
        const r = await api('poeDecide', { id, decision: 'returned', comment });
        if (!r.ok) throw new Error(r.error || 'Could not return it');
        const k = ps.list.findIndex((x) => x.id === r.evidence.id); if (k >= 0) ps.list[k] = r.evidence;
        ps.picked.delete(id); done++;
      } catch (e) { failed++; if (!firstErr) firstErr = e.message; }
    }
    toast(`Returned ${done}${failed ? ` - ${failed} failed: ${firstErr}` : ''}`, failed ? 'err' : 'ok');
    badge(); draw();
  }
  async function decide(decision, btn) {
    const comment = $('#poeComment')?.value.trim() || '';
    if (decision === 'returned' && !comment) { toast('Write what needs fixing, then return it', 'err'); $('#poeComment').focus(); return; }
    btn.disabled = true;
    try {
      const r = decision === 'approved' ? await withPin('Approve this evidence', (pin) => api('poeDecide', { id: ps.open, decision, comment, pin })) : await api('poeDecide', { id: ps.open, decision, comment });
      if (!r) { btn.disabled = false; return; }
      if (!r.ok) throw new Error(r.error);
      const i = ps.list.findIndex((x) => x.id === r.evidence.id); if (i >= 0) ps.list[i] = r.evidence;
      toast(decision === 'approved' ? 'Approved' : 'Returned to the student', 'ok');
      badge();
      // Walk on along the same order - the current student's next file, then the next student's - so a class reviews in one go.
      const order = ps.order, rest = order.slice(order.indexOf(ps.open) + 1);
      const nextId = ps.status === 'submitted' ? rest.find((id) => ps.list.find((x) => x.id === id)?.status === 'submitted') : rest[0];
      draw();
      if (nextId) openViewer(nextId, order); else $('#poeDialog').close();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }

  function wire() {
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (!t.closest?.('#poe')) return;
      // A row's checkbox selects (or clears) all of that student's items still waiting; "Select all" does every shown student's.
      const pend = (r) => (r?.items || []).filter((ev) => ev.status === 'submitted');
      if (t.matches('[data-pick-stu]')) { for (const ev of pend(byStudent().find((x) => lower(x.admNo) === lower(t.dataset.pickStu)))) { if (t.checked) ps.picked.add(ev.id); else ps.picked.delete(ev.id); } draw(); }
      if (t.matches('[data-pickall]')) { for (const r of batchable(Tables.slice('poeUnit', sortedStudents()))) for (const ev of pend(r)) { if (t.checked) ps.picked.add(ev.id); else ps.picked.delete(ev.id); } draw(); }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#poe, #poeDialog')) return;
      const t = e.target;
      if (ps.mode === 'verify' && t.closest('#poe') && !t.closest('[data-mode]')) { Verify.onClick(t); return; }
      if (ps.mode === 'trainer' && t.closest('#poe') && !t.closest('[data-mode]')) { PoeTrainer.onClick(t); return; }
      const s = t.closest('[data-status]'); if (s && t.closest('#poe')) { ps.status = s.dataset.status; Tables.reset('poeUnit'); draw(); return; }
      const m = t.closest('[data-mode]'); if (m && t.closest('#poe')) { ps.mode = m.dataset.mode; ps.q = ''; ps.seq++; draw(); return; }
      // The row's Review button: open that student's first file and walk every shown student's files from there.
      const o = t.closest('[data-open]'); if (o) { openViewer(o.dataset.open, evidenceOrder()); return; }
      const n = t.closest('[data-nav]'); if (n && n.dataset.nav) { openViewer(n.dataset.nav); return; }
      const d = t.closest('[data-decide]'); if (d) { decide(d.dataset.decide, d); return; }
      const a = t.closest('[data-act]');
      if (a?.dataset.act === 'close') $('#poeDialog').close();
      if (a?.dataset.act === 'batch-approve') { batchApprove(a); return; }
      if (a?.dataset.act === 'batch-return') { batchReturn(a); return; }
      if (a?.dataset.act === 'slip') printSlip(ps.list.find((x) => x.id === ps.open));
      if (a?.dataset.act === 'gconnect') { const id = ps.open; connectGoogle(false).then((ok) => { if (!ok) return; if (id && $('#poeDialog').open) { ps.files.delete(id); openViewer(id); } else draw(); }); }
      if (a?.dataset.act === 'reload') { ps.files.clear(); ps.roster.clear(); ps.classes = []; Verify.reset(); render(); }
      if (a?.dataset.act === 'unit-xlsx' || a?.dataset.act === 'unit-pdf') {
        const { head, rows } = reportSheet();
        const title = `Evidence ${ps.cls || 'all classes'}${ps.unit ? ' ' + ps.unit : ''}`;
        if (a.dataset.act === 'unit-xlsx') Tables.exportXlsx(title, head, rows); else Tables.print(title, `${rows.length} submissions`, head, rows);
      }
    });
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (ps.mode === 'verify' && t.closest('#poe')) { Verify.onChange(t); return; }
      if (ps.mode === 'trainer' && t.closest('#poe')) { PoeTrainer.onChange(t); return; }
      if (t.id === 'poeClass') { ps.cls = t.value; ps.unit = ''; ps.unitDefaulted = !t.value; Tables.reset('poeUnit'); draw(); }
      if (t.id === 'poeUnitF') { ps.unit = t.value; Tables.reset('poeUnit'); draw(); }
    });
    document.addEventListener('input', (e) => {
      if (e.target.id !== 'poeSearch') return;
      ps.q = e.target.value; Tables.reset('poeUnit');
      clearTimeout(ps.qt); ps.qt = setTimeout(() => { const pos = e.target.selectionStart; draw(); const s = $('#poeSearch'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } }, 200);
    });
    document.addEventListener('submit', (e) => {
      if (ps.mode !== 'verify' || !e.target.closest('#poe')) return;
      e.preventDefault(); Verify.onSubmit(e.target);
    });
    $('#poeDialog').addEventListener('close', () => { ps.open = null; });
    Tables.on('poeUnit', () => draw());
  }
  /** After sign-in: count what is waiting, for the tab's dot (one small request). */
  async function refreshBadge() {
    if (!me() || state.auth?.mustChange || !navigator.onLine || Date.now() - (ps.badgeAt || 0) < 15 * 60e3) return;
    ps.badgeAt = Date.now();
    try { await load(); } catch { /* shown when the tab opens */ }
  }
  function reset() { Object.assign(ps, { list: [], status: '', cls: '', unit: '', q: '', loaded: false, open: null, badgeAt: 0, mode: 'unit', classes: [], sCls: '', sFilter: '', order: [], openStu: '', defaulted: false, unitDefaulted: false }); ps.roster.clear(); ps.files.clear(); ps.marks.clear(); Verify.reset(); PoeTrainer.reset(); badge(); }
  return { render, wire, refreshBadge, reset, state: ps, open: (id, order) => openViewer(id, order), redraw: () => draw() };
})();
