/* POE Statistics tab (a section in the POE tab) - who has submitted their Portfolio of Evidence and who has
 * not, with the verification breakdown. Export to Excel (one sheet) or PDF.
 *   - HOD / MIS / IAO: the whole department per class, and can pick one trainer, or all trainers, by unit.
 *   - a trainer: only the class-units they are loaded to teach, per unit - what they must review.
 * "Submitted" = a student has at least one current evidence item; pending/"to check" = sent, not yet approved;
 * approved = verified; returned = sent back. Reads come from one scoped poeStats call.
 * Uses app.js (api, state, $, $$, esc, toast, hasRole, me, download, todayISO) and Tables (tables.js). */
'use strict';

const PoeStats = (() => {
  const S = { data: null, loaded: false, q: '', only: '', who: '', dept: '', open: new Set(), seq: 0 };
  const box = () => $('#poestats');
  const pctBar = (p) => `<span class="pbar" title="${p}% submitted"><span style="width:${Math.max(0, Math.min(100, p))}%"></span></span>`;
  const byUnit = () => S.data && S.data.scope === 'trainer';
  /** Extract department from class code (e.g., "ICT L6CS-26S" -> "ICT"). */
  const deptOf = (c) => String(c.classCode || '').split(' ')[0] || '';
  /** Unique departments from the current data. */
  function departments() {
    if (!S.data?.classes) return [];
    const depts = [...new Set(S.data.classes.map(deptOf).filter(Boolean))].sort();
    return depts;
  }

  async function render() {
    if (!me()) return;
    if (!navigator.onLine && !S.data) {
      box().innerHTML = '<div class="card notice"><h2>POE statistics need internet</h2><p>The numbers are read from the server. Connect once to load them.</p></div>';
      return;
    }
    if (!S.loaded) box().innerHTML = '<div class="card"><p class="muted">Loading POE statistics…</p></div>';
    const seq = ++S.seq;
    try {
      const res = await api('poeStats', S.who ? { trainer: S.who } : {});
      if (!res.ok) throw new Error(res.error || 'Could not load the statistics');
      Object.assign(S, { data: res, loaded: true });
    } catch (e) { if (seq === S.seq) box().innerHTML = `<div class="card notice"><h2>Could not load POE statistics</h2><p>${esc(e.message)}</p></div>`; return; }
    if (seq === S.seq) draw();
  }

  /** The label for a row: a class (department view) or "class - unit" (a trainer's units). */
  const rowLabel = (c) => c.classCode + (c.unitName ? ' - ' + c.unitName : (c.misClass && c.misClass !== c.classCode ? ' - ' + c.misClass : ''));

  function rows() {
    const q = S.q.trim().toLowerCase();
    let list = S.data.classes;
    if (S.dept) list = list.filter((c) => deptOf(c) === S.dept);
    if (q) list = list.filter((c) => `${c.classCode} ${c.misClass || ''} ${c.name || ''} ${c.unitName || ''} ${c.trainerName || ''}`.toLowerCase().includes(q));
    if (S.only === 'behind') list = list.filter((c) => c.notSubmitted > 0);
    return list;
  }
  const sorted = () => Tables.sort('poeStats', rows(), {
    class: (c) => c.classCode + ' ' + (c.unitName || ''), students: (c) => c.students, submitted: (c) => c.submitted, pct: (c) => c.pct,
    not: (c) => c.notSubmitted, pending: (c) => c.pending, approved: (c) => c.approved, returned: (c) => c.returned,
  }, 'class');

  const sum = (list, k) => list.reduce((n, c) => n + (c[k] || 0), 0);
  const studentsOf = (key) => (S.data.detail[key] || []).slice().sort((a, b) => (a.submitted - b.submitted) || String(a.name).localeCompare(String(b.name)));

  function detailRows(key) {
    const list = studentsOf(key).filter((r) => S.only !== 'behind' || !r.submitted);
    if (!list.length) return '<tr><td colspan="8" class="muted">No students to show.</td></tr>';
    return list.map((r, i) => `<tr class="${r.submitted ? '' : 'ps-no'}">
      <td class="sn">${i + 1}</td>
      <td><b>${esc(r.name)}</b><small class="tadm">${esc(r.admNo)}</small></td>
      <td>${r.submitted ? '<span class="pill synced">Submitted</span>' : '<span class="pill rejected">Not submitted</span>'}</td>
      <td class="num">${r.units || ''}</td><td class="num">${r.pending || ''}</td><td class="num">${r.approved || ''}</td><td class="num">${r.returned || ''}</td><td class="num">${r.items || ''}</td></tr>`).join('');
  }

  /** The trainer picker, shown only to HOD/MIS/IAO (the server returns `trainers` then). */
  function whoPicker() {
    if (!S.data.trainers) return '';
    return `<label class="stats-who">View
      <select id="statsWho">
        <option value="">All classes - summary</option>
        <option value="all"${S.who === 'all' ? ' selected' : ''}>All trainers - by unit</option>
        ${S.data.trainers.map((t) => `<option value="${esc(t.code)}"${S.who === t.code ? ' selected' : ''}>${esc(t.name)} - by unit</option>`).join('')}
      </select></label>`;
  }

  function draw() {
    if (!S.data) return;
    const list = sorted(), page = Tables.slice('poeStats', list);
    const th = (col, label, cls = '') => Tables.th('poeStats', col, label, cls);
    const firstCol = byUnit() ? 'Class - unit' : 'Class';
    const t = { students: sum(list, 'students'), submitted: sum(list, 'submitted'), not: sum(list, 'notSubmitted'),
      pending: sum(list, 'pending'), approved: sum(list, 'approved'), returned: sum(list, 'returned') };
    const tPct = t.students ? Math.round((t.submitted / t.students) * 100) : 0;
    const intro = byUnit()
      ? 'Each row is a unit you review. Submitted means a student has sent at least one evidence item; "to check" are submitted but not yet approved. Tap a unit to see who has and has not submitted.'
      : 'Submitted means a student has sent at least one evidence item. Tap a class to see who has and has not submitted.';
    box().innerHTML = `
      <div class="card">
        <div class="row-between wrap">
          <h2 class="card-h">POE statistics</h2>
          <div class="btn-row">
            <button type="button" class="btn small" data-act="stats-xlsx"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel</button>
            <button type="button" class="btn small" data-act="stats-pdf"><svg class="i" aria-hidden="true"><use href="#i-print"/></svg>Export PDF</button>
          </div>
        </div>
        <p class="muted small">${intro}</p>
        <div class="filters">
          ${whoPicker()}
          ${!byUnit() && S.data.trainers ? `<label class="stats-dept">Department<select id="statsDept"><option value="">All departments</option>${departments().map((d) => `<option value="${esc(d)}"${S.dept === d ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select></label>` : ''}
          <input type="search" id="statsQ" placeholder="${byUnit() ? 'Find a unit, class or trainer…' : 'Find a class…'}" value="${esc(S.q)}" aria-label="Filter">
          <label class="chk small"><input type="checkbox" id="statsBehind"${S.only === 'behind' ? ' checked' : ''}> Only with gaps</label>
        </div>
        <div class="stat-strip">
          <span><b>${t.submitted}</b> of <b>${t.students}</b> students submitted (${tPct}%)</span>
          <span class="ps-gap"><b>${t.not}</b> not submitted</span>
          <span>${t.pending} to check - ${t.approved} verified - ${t.returned} returned</span>
        </div>
        ${list.length ? `<div class="table-wrap"><table class="report-table h-table ps-table"><thead><tr>
          ${th('class', firstCol)}${th('students', 'Students', 'num')}${th('submitted', 'Submitted', 'num')}
          ${th('pct', '% done', 'num')}${th('not', 'Not submitted', 'num')}${th('pending', 'To check', 'num')}
          ${th('approved', 'Verified', 'num')}${th('returned', 'Returned', 'num')}</tr></thead>
          <tbody>${page.map((c) => `
            <tr class="ps-row" data-cls="${esc(c.key)}" tabindex="0" aria-expanded="${S.open.has(c.key)}">
              <td><span class="ps-caret">${S.open.has(c.key) ? '▾' : '▸'}</span> <b>${esc(rowLabel(c))}</b>${byUnit() && c.trainerName && S.data.byTrainer === 'all' ? `<small class="tadm">${esc(c.trainerName)}</small>` : ''}</td>
              <td class="num">${c.students}</td>
              <td class="num">${c.submitted} ${pctBar(c.pct)}</td>
              <td class="num">${c.pct}%</td>
              <td class="num${c.notSubmitted ? ' warn-text' : ''}">${c.notSubmitted || ''}</td>
              <td class="num">${c.pending || ''}</td>
              <td class="num">${c.approved || ''}</td>
              <td class="num">${c.returned || ''}</td></tr>
            ${S.open.has(c.key) ? `<tr class="ps-detail"><td colspan="8"><div class="ps-drill">
              <table class="report-table"><thead><tr><th class="sn">#</th><th>Student</th><th>Status</th>
                <th class="num">Units</th><th class="num">To check</th><th class="num">Verified</th><th class="num">Returned</th><th class="num">Items</th></tr></thead>
              <tbody>${detailRows(c.key)}</tbody></table></div></td></tr>` : ''}`).join('')}</tbody></table></div>
          ${Tables.bar('poeStats', list)}` : `<p class="empty">${byUnit() ? 'No units to show.' : 'No classes with students yet.'}</p>`}
      </div>`;
  }

  /* ---------- export: one Excel sheet (summary then detail), or a printed / PDF copy ---------- */
  function cols() {
    if (byUnit()) return {
      head: ['Trainer', 'Class', 'Unit', 'Students', 'Submitted', '% done', 'Not submitted', 'To check', 'Verified', 'Returned'],
      row: (c) => [c.trainerName || '', c.classCode, c.unitName || c.unitCode, c.students, c.submitted, c.pct + '%', c.notSubmitted, c.pending, c.approved, c.returned],
      dhead: ['Trainer', 'Class', 'Unit', 'Adm no.', 'Student', 'Status', 'To check', 'Verified', 'Returned', 'Items'],
      drow: (c, r) => [c.trainerName || '', c.classCode, c.unitName || c.unitCode, r.admNo, r.name, r.submitted ? 'Submitted' : 'Not submitted', r.pending, r.approved, r.returned, r.items],
    };
    return {
      head: ['Class', 'Students', 'Submitted', '% done', 'Not submitted', 'To check', 'Verified', 'Returned', 'Units'],
      row: (c) => [rowLabel(c), c.students, c.submitted, c.pct + '%', c.notSubmitted, c.pending, c.approved, c.returned, c.units],
      dhead: ['Class', 'Adm no.', 'Student', 'Status', 'Units', 'To check', 'Verified', 'Returned', 'Items'],
      drow: (c, r) => [rowLabel(c), r.admNo, r.name, r.submitted ? 'Submitted' : 'Not submitted', r.units, r.pending, r.approved, r.returned, r.items],
    };
  }
  const scopeTitle = () => byUnit() ? ('POE statistics - ' + (S.data.byTrainer === 'all' ? 'all trainers' : (S.data.classes[0]?.trainerName || 'trainer'))) : 'POE statistics';
  function exportXlsx() {
    const C = cols(), list = sorted();  // Use filtered/sorted list
    const summary = list.map(C.row);
    const detail = [];
    for (const c of list) for (const r of studentsOf(c.key)) detail.push(C.drow(c, r));
    Tables.exportXlsx(scopeTitle(), C.head, [...summary, [], ['STUDENT DETAIL'], C.dhead, ...detail]);
  }
  function exportPdf() {
    const C = cols(), list = sorted();  // Use filtered/sorted list
    const tr = (cells, head) => `<tr>${cells.map((x) => `<${head ? 'th' : 'td'}>${esc(x ?? '')}</${head ? 'th' : 'td'}>`).join('')}</tr>`;
    const detail = list.map((c) => {
      const students = studentsOf(c.key); if (!students.length) return '';
      return `<h2>${esc(rowLabel(c))}${byUnit() && c.trainerName ? ' - ' + esc(c.trainerName) : ''} - ${c.submitted}/${c.students} submitted (${c.pct}%)</h2>
        <table><thead>${tr(C.dhead, true)}</thead><tbody>${students.map((r) => tr(C.drow(c, r))).join('')}</tbody></table>`;
    }).join('');
    $('#printArea').innerHTML = `<div class="tbl-print"><h1>${esc(scopeTitle().toUpperCase())}</h1><p>Rift Valley National Polytechnic - Department of Computing and Informatics</p>
      <table><thead>${tr(C.head, true)}</thead><tbody>${list.map((c) => tr(C.row(c))).join('')}</tbody></table>${detail}</div>`;
    document.body.classList.add('printing', 'print-table');
    const done = () => { document.body.classList.remove('printing', 'print-table'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 80);
  }

  /* ---------- events (bound once, scoped to #poestats) ---------- */
  function toggle(key) { if (S.open.has(key)) S.open.delete(key); else S.open.add(key); draw(); }
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
    const el = $('#statsQ'); if (el) { el.focus(); const v = el.value; el.value = ''; el.value = v; }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'statsBehind') { S.only = e.target.checked ? 'behind' : ''; Tables.reset('poeStats'); draw(); return; }
    if (e.target.id === 'statsWho') { S.who = e.target.value; S.open.clear(); Tables.reset('poeStats'); S.loaded = false; render(); return; }
    if (e.target.id === 'statsDept') { S.dept = e.target.value; Tables.reset('poeStats'); draw(); return; }
  });
  Tables.on('poeStats', draw);

  return { render };
})();
