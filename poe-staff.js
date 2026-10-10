/* POE tab — trainers review the evidence students sent for their units: preview inside the app, approve or
 * return with a note. The HOD sees the department. The MIS Officer gets the approved submissions and marks
 * them received. Files stay in the college Drive; the preview is fetched through the Drive bridge.
 * Uses app.js (api, state, $, $$, esc, toast, hasRole, me) and Imports.pdfLib (pdf.js). */
'use strict';

const PoeStaff = (() => {
  const ITEMS = ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'PRAC1', 'PRAC2', 'PRAC3'];
  const STATUS = { submitted: ['pending', 'To review'], approved: ['synced', 'Approved'], returned: ['rejected', 'Returned'] };
  const ps = { list: [], status: '', cls: '', unit: '', q: '', loaded: false, sheetUrl: '', indexUrl: '', driveReady: true, open: null, files: new Map(), picked: new Set(), seq: 0, mode: 'unit', classes: [], roster: new Map(), sCls: '', sFilter: '', order: [] };
  const box = () => $('#poe');
  const misOnly = () => hasRole('MIS') && !hasRole('TRAINER') && !hasRole('HOD');
  const canDecide = () => hasRole('TRAINER') || hasRole('HOD');
  const byStudentAllowed = () => hasRole('MIS') || hasRole('HOD');

  async function load() {
    const res = await api('poeList', {});
    if (!res.ok) throw new Error(res.error || 'Could not load the evidence');
    Object.assign(ps, { list: res.evidence, sheetUrl: res.sheetUrl || '', indexUrl: res.indexUrl || '', driveReady: res.driveReady !== false, loaded: true });
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
    const rows = filtered();
    const groups = new Map();
    for (const e of rows) { const k = `${e.classCode}|${e.unitCode}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); }
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
      ${rows.length ? [...groups.entries()].map(([k, list]) => groupHtml(k, list)).join('')
        : `<div class="card notice"><h2>${ps.status === 'submitted' ? 'Nothing to review' : 'Nothing here'}</h2><p class="muted">${all.length ? 'Try another filter.' : 'When students send evidence for your units it shows here.'}</p></div>`}`;
  }
  function groupHtml(key, list) {
    const [cls] = key.split('|'), e0 = list[0];
    return `<section class="card poe-group"><div class="msec-head"><h2>${esc(e0.unitName)}</h2><span class="muted small">${esc(cls)} · ${list.length}</span></div>
      <ul class="mlist poe-rows">${list.sort((a, b) => a.name.localeCompare(b.name) || ITEMS.indexOf(a.item) - ITEMS.indexOf(b.item)).map(rowHtml).join('')}</ul></section>`;
  }
  function rowHtml(e) {
    const [cls, label] = e.receivedAt ? ['locked', 'Received'] : STATUS[e.status] || ['pending', e.status];
    const pick = hasRole('MIS') && e.status === 'approved' && !e.receivedAt;
    return `<li class="poe-row" data-id="${esc(e.id)}">
      ${pick ? `<input type="checkbox" class="poe-pick" data-pick="${esc(e.id)}" aria-label="Select ${esc(e.name)}"${ps.picked.has(e.id) ? ' checked' : ''}>` : ''}
      <button type="button" class="poe-open" data-open="${esc(e.id)}">
        <span class="poe-who"><b>${esc(e.name)}</b><span class="muted small">${esc(e.admNo)}</span></span>
        <span class="poe-what"><span class="item-tag">${esc(e.item)}</span><span class="muted small">v${e.version} · ${esc(fmtTime(e.submittedAt))}</span></span>
        <span class="pill ${cls}">${label}</span>
      </button></li>`;
  }

  /* ---------- by student: every unit and item of one student, what is in and what is missing ---------- */
  async function loadClass(cls) {
    const res = await api('poeClass', cls ? { classCode: cls } : {});
    if (!res.ok) throw new Error(res.error || 'Could not load the class');
    ps.classes = res.classes || [];
    if (cls) ps.roster.set(cls, { students: res.students, units: res.units });
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
        <p class="muted small">Each student's units and items as the student sees them: ✓ approved, • with the trainer, ↺ returned, – not sent. Tap a mark to open the file.</p>
        <div class="chips poe-chips" role="group" aria-label="Show">${chips}</div>
        <div class="poe-filters">
          <select id="poeSClass" aria-label="Class">${ps.classes.map((c) => `<option${c === ps.sCls ? ' selected' : ''}>${esc(c)}</option>`).join('') || '<option value="">No classes this term</option>'}</select>
          <input type="search" id="poeSearch" placeholder="Name or admission no." value="${esc(ps.q)}" aria-label="Search students">
        </div>
      </div>
      <div id="poeStudents">
      <p class="muted small poe-sum">${esc(ps.sCls)} · ${r.students.length} students · ${r.units.length} units · ${rows.reduce((n, x) => n + x.sent, 0)} items sent</p>
      ${show.length ? show.map(studentHtml).join('') : `<div class="card notice"><h2>Nobody here</h2><p class="muted">${r.students.length ? 'Try another filter.' : 'This class has no students on its list.'}</p></div>`}
      </div>`;
  }
  function studentHtml({ st, got, units, c }) {
    const used = ITEMS.filter((it) => [...got.values()].some((e) => e.item === it));
    const cols = used.length ? ITEMS.filter((it) => ITEMS.indexOf(it) <= Math.max(...used.map((u) => ITEMS.indexOf(u))) || it === 'CAT1' || it === 'PRAC1') : ['CAT1', 'CAT2', 'PRAC1'];
    const mark = (e) => {
      if (!e) return '<td class="pm none">–</td>';
      const sym = e.status === 'approved' ? '✓' : e.status === 'returned' ? '↺' : '•';
      return `<td class="pm"><button type="button" class="pm-btn ${e.status}${e.receivedAt ? ' received' : ''}" data-open="${esc(e.id)}" data-adm="${esc(st.admNo)}"
        aria-label="${esc(e.unitName)} ${e.item} ${STATUS[e.status]?.[1] || e.status}">${sym}${e.version > 1 ? `<small>v${e.version}</small>` : ''}</button></td>`;
    };
    const tally = [c.approved && `<span class="pill synced">✓ ${c.approved}</span>`, c.submitted && `<span class="pill pending">• ${c.submitted}</span>`,
      c.returned && `<span class="pill rejected">↺ ${c.returned}</span>`].filter(Boolean).join('') || '<span class="pill locked">Nothing sent</span>';
    return `<details class="card poe-stu" data-adm="${esc(st.admNo)}"${ps.openStu === st.admNo ? ' open' : ''}>
      <summary><span class="poe-who"><b>${esc(st.name)}</b><span class="muted small">${esc(st.admNo)}</span></span><span class="poe-tally">${tally}</span></summary>
      <div class="table-wrap"><table class="poe-matrix"><thead><tr><th>Unit</th>${cols.map((it) => `<th>${it}</th>`).join('')}</tr></thead>
      <tbody>${units.map((u) => `<tr><th scope="row">${esc(u.name)}</th>${cols.map((it) => mark(got.get(u.code + '|' + it))).join('')}</tr>`).join('')}</tbody></table></div>
    </details>`;
  }

  /* ---------- preview ---------- */
  async function fetchFile(id) {
    if (ps.files.has(id)) return ps.files.get(id);
    const v = await api('poeView', { id });
    if (!v.ok) throw new Error(v.error);
    const res = await fetch(v.driveUrl + (v.driveUrl.includes('?') ? '&' : '?') + 'action=file&ticket=' + encodeURIComponent(v.ticket), { redirect: 'follow' });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'The Drive did not send the file');
    const bin = atob(out.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = { bytes, mime: out.mime || 'application/pdf', name: out.name };
    ps.files.set(id, file);
    if (ps.files.size > 12) ps.files.delete(ps.files.keys().next().value);
    return file;
  }
  async function openViewer(id, order) {
    const e = ps.list.find((x) => x.id === id); if (!e) return;
    ps.open = id;
    if (order) ps.order = order;
    else if (!ps.order.includes(id)) ps.order = filtered().map((x) => x.id);
    order = ps.order;
    const i = order.indexOf(id);
    const decided = e.status !== 'submitted';
    $('#poeDialogBody').innerHTML = `
      <div class="poe-view-head">
        <div><h2>${esc(e.name)} <span class="item-tag">${esc(e.item)}</span></h2>
          <p class="muted small">${esc(e.admNo)} · ${esc(e.classCode)} · ${esc(e.unitName)} · v${e.version} · sent ${esc(fmtTime(e.submittedAt))}</p></div>
        <button type="button" class="btn small ghost" data-act="close">Close</button>
      </div>
      ${decided ? `<p class="poe-decided ${e.status}">${e.status === 'approved' ? 'Approved' : 'Returned'} by ${esc(e.decidedName)} · ${esc(fmtTime(e.decidedAt))}${e.comment ? ` — “${esc(e.comment)}”` : ''}${e.receivedAt ? ` · received by the MIS Officer ${esc(fmtTime(e.receivedAt))}` : ''}</p>` : ''}
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
    try {
      const file = await fetchFile(id);
      if (ps.open !== id) return;
      await showPdf(file);
    } catch (err) {
      if (ps.open === id) $('#poePages').innerHTML = `<p class="err-text">${esc(err.message)}</p><p class="muted small">You can still open it in Drive.</p>`;
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
      const next = ps.mode === 'unit' && filtered().find((x) => x.status === 'submitted' && x.id !== ps.open);
      draw();
      if (next && ps.status === 'submitted') openViewer(next.id, filtered().map((x) => x.id)); else $('#poeDialog').close();
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
      const s = t.closest('[data-status]'); if (s && t.closest('#poe')) { ps.status = s.dataset.status; ps.picked.clear(); draw(); return; }
      const m = t.closest('[data-mode]'); if (m && t.closest('#poe')) { ps.mode = m.dataset.mode; ps.q = ''; ps.seq++; draw(); return; }
      const sf = t.closest('[data-sfilter]'); if (sf) { ps.sFilter = sf.dataset.sfilter; draw(); return; }
      const o = t.closest('[data-open]');
      if (o && o.dataset.adm) {
        // By student: previous / next go through that student's files, unit by unit.
        ps.openStu = o.dataset.adm;
        const ids = [...o.closest('.poe-stu').querySelectorAll('[data-open]')].map((b) => b.dataset.open);
        openViewer(o.dataset.open, ids); return;
      }
      if (o) { openViewer(o.dataset.open, filtered().map((x) => x.id)); return; }
      const n = t.closest('[data-nav]'); if (n && n.dataset.nav) { openViewer(n.dataset.nav); return; }
      const d = t.closest('[data-decide]'); if (d) { decide(d.dataset.decide, d); return; }
      const a = t.closest('[data-act]');
      if (a?.dataset.act === 'close') $('#poeDialog').close();
      if (a?.dataset.act === 'reload') { ps.files.clear(); ps.roster.clear(); ps.classes = []; render(); }
      if (a?.dataset.act === 'receive') receive(a);
    });
    document.addEventListener('change', (e) => {
      const t = e.target;
      if (t.id === 'poeClass') { ps.cls = t.value; ps.unit = ''; draw(); }
      if (t.id === 'poeUnitF') { ps.unit = t.value; draw(); }
      if (t.id === 'poeSClass') { ps.sCls = t.value; ps.openStu = ''; ps.seq++; draw(); }
      if (t.dataset?.pick) { if (t.checked) ps.picked.add(t.dataset.pick); else ps.picked.delete(t.dataset.pick); draw(); }
      if (t.id === 'poeAll') { for (const x of filtered()) if (x.status === 'approved' && !x.receivedAt) { if (t.checked) ps.picked.add(x.id); else ps.picked.delete(x.id); } draw(); }
    });
    document.addEventListener('input', (e) => {
      if (e.target.id !== 'poeSearch') return;
      ps.q = e.target.value;
      clearTimeout(ps.qt); ps.qt = setTimeout(() => { const pos = e.target.selectionStart; draw(); const s = $('#poeSearch'); s.focus(); s.setSelectionRange(pos, pos); }, 200);
    });
    $('#poeDialog').addEventListener('close', () => { ps.open = null; });
    document.addEventListener('toggle', (e) => {
      const d = e.target;
      if (d.matches?.('details.poe-stu')) { if (d.open) ps.openStu = d.dataset.adm; else if (ps.openStu === d.dataset.adm) ps.openStu = ''; }
    }, true);
  }
  /** After sign-in: count what is waiting, for the tab's dot (one small request). */
  async function refreshBadge() {
    if (!me() || state.auth?.mustChange || !navigator.onLine || Date.now() - (ps.badgeAt || 0) < 15 * 60e3) return;
    ps.badgeAt = Date.now();
    try { await load(); } catch { /* shown when the tab opens */ }
  }
  function reset() { Object.assign(ps, { list: [], status: '', cls: '', unit: '', q: '', loaded: false, open: null, badgeAt: 0, mode: 'unit', classes: [], sCls: '', sFilter: '', order: [], openStu: '' }); ps.roster.clear(); ps.files.clear(); ps.picked.clear(); badge(); }
  return { render, wire, refreshBadge, reset, state: ps };
})();
