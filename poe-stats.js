/* POE Statistics tab — a department-wide view of who has submitted their Portfolio of Evidence and who has
 * not. The class summary (submitted / not submitted / % done, plus verification state) drills down to the
 * exact students in a class, so staff can see who to chase. Export to Excel (one sheet) or PDF.
 * "Submitted" = a student has at least one current evidence item in a unit; pending = still to check,
 * approved = verified, returned = sent back. Seen by every staff role except an EAO-only visitor.
 * Uses app.js (api, state, $, $$, esc, toast, hasRole, me, download, todayISO) and Tables (tables.js). */
'use strict';

const PoeStats = (() => {
  const S = { data: null, loaded: false, q: '', only: '', open: new Set(), seq: 0 };
  const box = () => $('#poestats');
  const pctBar = (p) => `<span class="pbar" title="${p}% submitted"><span style="width:${Math.max(0, Math.min(100, p))}%"></span></span>`;

  async function render() {
    if (!me()) return;
    if (!navigator.onLine && !S.data) {
      box().innerHTML = '<div class="card notice"><h2>POE statistics need internet</h2><p>The numbers are read from the server. Connect once to load them.</p></div>';
      return;
    }
    if (!S.loaded) box().innerHTML = '<div class="card"><p class="muted">Loading POE statistics…</p></div>';
    const seq = ++S.seq;
    try {
      const res = await api('poeStats', {});
      if (!res.ok) throw new Error(res.error || 'Could not load the statistics');
      Object.assign(S, { data: res, loaded: true });
    } catch (e) { if (seq === S.seq) box().innerHTML = `<div class="card notice"><h2>Could not load POE statistics</h2><p>${esc(e.message)}</p></div>`; return; }
    if (seq === S.seq) draw();
  }

  /** Summary rows after the search box and the "behind only" filter. */
  function classes() {
    const q = S.q.trim().toLowerCase();
    let list = S.data.classes;
    if (q) list = list.filter((c) => `${c.classCode} ${c.misClass} ${c.name}`.toLowerCase().includes(q));
    if (S.only === 'behind') list = list.filter((c) => c.notSubmitted > 0);
    return list;
  }
  const sorted = () => Tables.sort('poeStats', classes(), {
    class: (c) => c.classCode, students: (c) => c.students, submitted: (c) => c.submitted, pct: (c) => c.pct,
    not: (c) => c.notSubmitted, pending: (c) => c.pending, approved: (c) => c.approved, returned: (c) => c.returned,
  }, 'class');

  const sum = (list, k) => list.reduce((n, c) => n + (c[k] || 0), 0);
  const classLabel = (c) => c.classCode + (c.misClass && c.misClass !== c.classCode ? ` - ${c.misClass}` : '');

  /** The students of a class for the drill-down, newest problem first: not-submitted on top, then by name. */
  function studentsOf(code) {
    const rows = (S.data.detail[code] || []).slice();
    rows.sort((a, b) => (a.submitted - b.submitted) || String(a.name).localeCompare(String(b.name)));
    return rows;
  }

  function detailRows(code) {
    const rows = studentsOf(code).filter((r) => S.only !== 'behind' || !r.submitted);
    if (!rows.length) return '<tr><td colspan="8" class="muted">No students to show.</td></tr>';
    return rows.map((r, i) => `<tr class="${r.submitted ? '' : 'ps-no'}">
      <td class="sn">${i + 1}</td>
      <td><b>${esc(r.name)}</b><small class="tadm">${esc(r.admNo)}</small></td>
      <td>${r.submitted ? '<span class="pill synced">Submitted</span>' : '<span class="pill rejected">Not submitted</span>'}</td>
      <td class="num">${r.units || ''}</td>
      <td class="num">${r.pending || ''}</td>
      <td class="num">${r.approved || ''}</td>
      <td class="num">${r.returned || ''}</td>
      <td class="num">${r.items || ''}</td></tr>`).join('');
  }

  function draw() {
    if (!S.data) return;
    const list = sorted(), off = Tables.offset('poeStats'), page = Tables.slice('poeStats', list);
    const th = (col, label, cls = '') => Tables.th('poeStats', col, label, cls);
    const t = { students: sum(list, 'students'), submitted: sum(list, 'submitted'), not: sum(list, 'notSubmitted'),
      pending: sum(list, 'pending'), approved: sum(list, 'approved'), returned: sum(list, 'returned') };
    const tPct = t.students ? Math.round((t.submitted / t.students) * 100) : 0;
    box().innerHTML = `
      <div class="card">
        <div class="row-between wrap">
          <h2 class="card-h">POE statistics</h2>
          <div class="btn-row">
            <button type="button" class="btn small" data-act="stats-xlsx"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel</button>
            <button type="button" class="btn small" data-act="stats-pdf"><svg class="i" aria-hidden="true"><use href="#i-print"/></svg>Export PDF</button>
          </div>
        </div>
        <p class="muted small">Submitted means a student has sent at least one evidence item. Tap a class to see who has and has not submitted.</p>
        <div class="filters">
          <input type="search" id="statsQ" placeholder="Find a class…" value="${esc(S.q)}" aria-label="Find a class">
          <label class="chk"><input type="checkbox" id="statsBehind"${S.only === 'behind' ? ' checked' : ''}> Only classes with gaps</label>
        </div>
        <div class="stat-strip">
          <span><b>${t.submitted}</b> of <b>${t.students}</b> students submitted (${tPct}%)</span>
          <span class="ps-gap"><b>${t.not}</b> not submitted</span>
          <span>${t.pending} to check · ${t.approved} verified · ${t.returned} returned</span>
        </div>
        ${list.length ? `<div class="table-wrap"><table class="report-table h-table ps-table"><thead><tr>
          ${th('class', 'Class')}${th('students', 'Students', 'num')}${th('submitted', 'Submitted', 'num')}
          ${th('pct', '% done', 'num')}${th('not', 'Not submitted', 'num')}${th('pending', 'To check', 'num')}
          ${th('approved', 'Verified', 'num')}${th('returned', 'Returned', 'num')}</tr></thead>
          <tbody>${page.map((c, i) => `
            <tr class="ps-row" data-cls="${esc(c.classCode)}" tabindex="0" aria-expanded="${S.open.has(c.classCode)}">
              <td><span class="ps-caret">${S.open.has(c.classCode) ? '▾' : '▸'}</span> <b>${esc(classLabel(c))}</b></td>
              <td class="num">${c.students}</td>
              <td class="num">${c.submitted} ${pctBar(c.pct)}</td>
              <td class="num">${c.pct}%</td>
              <td class="num${c.notSubmitted ? ' warn-text' : ''}">${c.notSubmitted || ''}</td>
              <td class="num">${c.pending || ''}</td>
              <td class="num">${c.approved || ''}</td>
              <td class="num">${c.returned || ''}</td></tr>
            ${S.open.has(c.classCode) ? `<tr class="ps-detail"><td colspan="8"><div class="ps-drill">
              <table class="report-table"><thead><tr><th class="sn">#</th><th>Student</th><th>Status</th>
                <th class="num">Units</th><th class="num">To check</th><th class="num">Verified</th><th class="num">Returned</th><th class="num">Items</th></tr></thead>
              <tbody>${detailRows(c.classCode)}</tbody></table></div></td></tr>` : ''}`).join('')}</tbody></table></div>
          ${Tables.bar('poeStats', list)}` : '<p class="empty">No classes with students yet.</p>'}
      </div>`;
  }

  /* ---------- export: one Excel sheet (summary then detail), or a printed / PDF copy ---------- */
  const HEAD = ['Class', 'Students', 'Submitted', '% done', 'Not submitted', 'To check', 'Verified', 'Returned', 'Units'];
  const DHEAD = ['Class', 'Adm no.', 'Student', 'Status', 'Units', 'To check', 'Verified', 'Returned', 'Items'];
  const summaryRows = () => S.data.classes.map((c) => [classLabel(c), c.students, c.submitted, c.pct + '%', c.notSubmitted, c.pending, c.approved, c.returned, c.units]);
  function detailAll() {
    const out = [];
    for (const c of S.data.classes) for (const r of studentsOf(c.classCode)) {
      out.push([classLabel(c), r.admNo, r.name, r.submitted ? 'Submitted' : 'Not submitted', r.units, r.pending, r.approved, r.returned, r.items]);
    }
    return out;
  }
  function exportXlsx() {
    // One sheet: the class summary on top, a spacer, then every student's line below it.
    const rows = [...summaryRows(), [], ['STUDENT DETAIL'], DHEAD, ...detailAll()];
    Tables.exportXlsx('POE statistics', HEAD, rows);
  }
  function exportPdf() {
    const row = (cells, head) => `<tr>${cells.map((c) => `<${head ? 'th' : 'td'}>${esc(c ?? '')}</${head ? 'th' : 'td'}>`).join('')}</tr>`;
    const detailByClass = S.data.classes.map((c) => {
      const rows = studentsOf(c.classCode);
      if (!rows.length) return '';
      return `<h2>${esc(classLabel(c))} - ${c.submitted}/${c.students} submitted (${c.pct}%)</h2>
        <table><thead>${row(['#', 'Adm no.', 'Student', 'Status', 'Units', 'To check', 'Verified', 'Returned', 'Items'], true)}</thead>
        <tbody>${rows.map((r, i) => row([i + 1, r.admNo, r.name, r.submitted ? 'Submitted' : 'Not submitted', r.units, r.pending, r.approved, r.returned, r.items])).join('')}</tbody></table>`;
    }).join('');
    $('#printArea').innerHTML = `<div class="tbl-print"><h1>POE STATISTICS</h1><p>Rift Valley National Polytechnic - Department of Computing and Informatics</p>
      <table><thead>${row(HEAD, true)}</thead><tbody>${summaryRows().map((r) => row(r)).join('')}</tbody></table>
      ${detailByClass}</div>`;
    document.body.classList.add('printing', 'print-table');
    const done = () => { document.body.classList.remove('printing', 'print-table'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 80);
  }

  /* ---------- events (bound once) ---------- */
  function toggle(code) { if (S.open.has(code)) S.open.delete(code); else S.open.add(code); draw(); }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#poestats')) return;
    const a = e.target.closest('[data-act]');
    if (a) { if (a.dataset.act === 'stats-xlsx') exportXlsx(); else if (a.dataset.act === 'stats-pdf') exportPdf(); return; }
    const r = e.target.closest('.ps-row'); if (r) toggle(r.dataset.cls);
  });
  document.addEventListener('keydown', (e) => {
    const r = e.target.closest?.('.ps-row'); if (r && e.target.closest('#poestats') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(r.dataset.cls); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'statsQ') return;
    S.q = e.target.value; Tables.reset('poeStats'); draw();
    const el = $('#statsQ'); if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; } // keep the cursor at the end after redraw
  });
  document.addEventListener('change', (e) => {
    if (e.target.id !== 'statsBehind') return;
    S.only = e.target.checked ? 'behind' : ''; Tables.reset('poeStats'); draw();
  });
  Tables.on('poeStats', draw);

  return { render };
})();
