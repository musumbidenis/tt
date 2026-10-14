/* Manage tab — sections shown by role.
 *   HOD:  registers waiting for approval, department overview, students waiting for the MIS Officer, student phones, backup
 *   MIS:  term, trainer loading, class lists, student requests, staff
 * Everything here talks to the server, so it needs internet (marking does not). */
'use strict';

const Admin = (() => {
  const box = () => $('#manage');
  const ROLE_LABEL = { TRAINER: 'Trainer', HOD: 'HOD', MIS: 'MIS Officer' };
  let cache = { signoffs: [], requests: [], overview: null, staff: [], phones: [], backup: null };
  let loadingPreview = null;
  let ovSort = { key: 'classCode', dir: 1 };
  const secOpen = new Set();   // which folded-away sections the person has opened, so a refresh keeps them as they were
  const fold = (key, label, inner) => `<details class="fold" data-sec="${key}"${secOpen.has(key) ? ' open' : ''}><summary>${label}</summary>${inner}</details>`;
  const classImports = [];

  const section = (id, title, inner, extra = '') => `<section class="card msec" id="${id}">
    <div class="msec-head"><h2>${title}</h2>${extra}</div>${inner}</section>`;
  const busy = (btn, on, label) => { if (!btn) return; btn.disabled = on; if (label) btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = on ? label : (btn.dataset.label || btn.textContent); };
  const need = (res) => { if (!res.ok) throw new Error(res.error || 'The server refused that'); return res; };
  const dialog = (html) => { $('#adminDialogBody').innerHTML = html; $('#adminDialog').showModal(); };
  const closeDialog = () => $('#adminDialog').close();

  async function render() {
    if (!(hasRole('HOD') || hasRole('MIS'))) { box().innerHTML = ''; return; }
    if (!navigator.onLine) {
      box().innerHTML = '<div class="card notice"><h2>Manage needs internet</h2><p>Approvals, uploads and staff changes go straight to the server. Marking registers still works offline.</p></div>';
      return;
    }
    const parts = [];
    if (hasRole('HOD')) parts.push(section('m-signoffs', 'Registers to approve', '<p class="muted">Loading…</p>'), section('m-overview', 'Department overview', '<p class="muted">Loading…</p>'));
    if (hasRole('MIS')) {
      parts.push(section('m-requests', 'Students added by trainers', '<p class="muted">Loading…</p>'));
      parts.push(section('m-term', 'Term', termHtml()));
      parts.push(section('m-loading', 'Trainer loading', loadingHtml()));
      parts.push(section('m-classes', 'Class lists', classesHtml()));
      parts.push(section('m-phones', 'Student phones', '<p class="muted">Loading…</p>'));
      parts.push(section('m-staff', 'Staff and roles', '<p class="muted">Loading…</p>'));
      parts.push(section('m-backup', 'Backup', '<p class="muted">Loading…</p>'));
      parts.push(section('m-drive', 'Google Drive', '<p class="muted">Loading…</p>'));
    } else if (hasRole('HOD')) parts.push(section('m-requests', 'Students waiting for the MIS Officer', '<p class="muted">Loading…</p>'), section('m-phones', 'Student phones', '<p class="muted">Loading…</p>'), section('m-backup', 'Backup', '<p class="muted">Loading…</p>'));
    box().innerHTML = parts.join('');
    const jobs = [];
    if (hasRole('HOD')) jobs.push(loadSignoffs(), loadOverview());
    jobs.push(loadRequests(), loadPhones(), loadBackup());
    if (hasRole('MIS')) jobs.push(loadStaff().then(loadDrive));
    await Promise.allSettled(jobs);
    refreshBadge();
  }

  function fill(id, html) { const el = $('#' + id); if (el) replaceBody(el, html); }
  function replaceBody(el, html) {
    [...el.children].slice(1).forEach((c) => c.remove());
    el.insertAdjacentHTML('beforeend', html);
  }

  /* ---------- HOD: registers to approve ---------- */
  let soQuery = '', soSort = 'new', staffSort = 'name';
  const SO_SORT = {
    new: (a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)), old: (a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)),
    class: (a, b) => a.classCode.localeCompare(b.classCode) || a.unitCode.localeCompare(b.unitCode), unit: (a, b) => String(a.unitName || a.unitCode).localeCompare(String(b.unitName || b.unitCode)) || a.classCode.localeCompare(b.classCode),
    trainer: (a, b) => String(a.trainerName).localeCompare(String(b.trainerName)) || a.classCode.localeCompare(b.classCode) };
  async function loadSignoffs() {
    try {
      cache.signoffs = need(await api('signoffs')).signoffs;
      fill('m-signoffs', `<div class="list-tools"><input type="search" id="soSearch" class="so-search" placeholder="Search by class, unit or trainer" aria-label="Search registers to approve">
        <select id="soSort" aria-label="Sort"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="class">By class</option><option value="unit">By unit</option><option value="trainer">By trainer</option></select></div><div id="soList"></div>`);
      $('#soSearch').value = soQuery; $('#soSort').value = soSort;
      drawSignoffs();
    } catch (e) { fill('m-signoffs', `<p class="err-text">${esc(e.message)}</p>`); }
  }
  function drawSignoffs() {
    const box = $('#soList'); if (!box) return;
    const q = soQuery.trim().toLowerCase();
    const hit = (s) => !q || [s.classCode, s.unitCode, s.unitName, s.trainerName].some((x) => String(x || '').toLowerCase().includes(q));
    const waiting = cache.signoffs.filter((s) => s.status === 'submitted' && hit(s)).sort(SO_SORT[soSort]);
    const done = cache.signoffs.filter((s) => s.status !== 'submitted' && hit(s)).sort(SO_SORT[soSort]);
    const item = (s) => `<li><button type="button" class="mrow" data-open="${esc(s.classCode)}|${esc(s.unitCode)}">
      <span><b>${esc(s.classCode)} - ${esc(s.unitCode)}</b><small>${esc(s.unitName)} - ${esc(s.trainerName)}</small></span>
      <span class="pill ${s.status === 'approved' ? 'synced' : s.status === 'returned' ? 'rejected' : 'pending'}">${s.status === 'submitted' ? 'Submitted ' + fmtShort(s.submittedAt) : s.status === 'approved' ? 'Approved' : 'Returned'}</span></button></li>`;
    const none = q ? '<p class="muted">Nothing matches that search.</p>' : '<p class="muted">Nothing is waiting. Trainers submit their term registers from Reports.</p>';
    box.innerHTML = (waiting.length ? `<ul class="mlist">${Tables.slice('signoffs', waiting).map(item).join('')}</ul>${Tables.bar('signoffs', waiting)}` : none)
      + (done.length ? fold('signoffsDone', `Approved or returned (${done.length})`, `<ul class="mlist">${Tables.slice('signoffsDone', done).map(item).join('')}</ul>${Tables.bar('signoffsDone', done)}`) : '');
  }

  let ovTerm = '';
  async function loadOverview() {
    try {
      const o = cache.overview = need(await api('overview', ovTerm ? { termId: ovTerm } : {}));
      Tables.reset('overview');
      drawOverview();
    } catch (e) { fill('m-overview', `<p class="err-text">${esc(e.message)}</p>`); }
  }
  function drawOverview() {
    const o = cache.overview; if (!o) return;
    if (!o.term) { fill('m-overview', '<p class="muted">The MIS Officer has not set up the term yet.</p>'); return; }
    const { key, dir } = ovSort;
    const val = (r) => (key === 'last' ? r.last || '' : key === 'pct' ? (r.pct === null ? -1 : r.pct) : key === 'signoff' ? r.signoff || '' : r[key]);
    const rows = o.rows.sort((a, b) => {
      const x = val(a), y = val(b);
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
      return (c || a.classCode.localeCompare(b.classCode) || a.unitCode.localeCompare(b.unitCode)) * dir;
    });
    const behind = rows.filter((r) => r.lessons < r.due - 1).length;
    const page = Tables.slice('overview', rows);
    const th = (k, label, cls = '') => `<th${cls ? ` class="${cls}"` : ''} data-sort="${k}" tabindex="0" aria-sort="${key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}<span class="sort-ind">${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</span></th>`;
    const past = (state.meta.terms || []).filter((x) => x.id !== state.meta.term?.id);
    const termPick = past.length ? `<label class="ov-term">Term <select id="ovTerm" aria-label="Term"><option value="">${esc(state.meta.term?.duration || state.meta.term?.name || 'Current')} (current)</option>${past.map((x) => `<option value="${esc(x.id)}"${x.id === ovTerm ? ' selected' : ''}>${esc(x.duration || x.name)}</option>`).join('')}</select></label>` : '';
    fill('m-overview', termPick + `<p class="muted">${esc(o.term.name)} - ${ovTerm ? 'ended' : `Week ${o.week} of 12`}${behind ? ` (<b class="warn-text">${behind} behind on registers</b>)` : ''}</p>`
      + fold('overview', `Show the class units (${rows.length})`, `<div class="table-wrap"><table class="report-table overview-table"><thead><tr>${th('classCode', 'Class')}${th('unitCode', 'Unit')}${th('trainerName', 'Trainer')}${th('lessons', 'Marked', 'num')}${th('due', 'Due', 'num')}${th('last', 'Last')}${th('pct', 'Att.', 'num')}${th('signoff', 'HOD')}</tr></thead>
        <tbody>${page.map((r) => `<tr class="${r.lessons < r.due - 1 ? 'behind' : ''}" data-open="${esc(r.classCode)}|${esc(r.unitCode)}">
          <td>${esc(r.classCode)}</td><td>${esc(r.unitCode)}</td><td>${esc(r.trainerName)}</td><td class="num">${r.lessons}</td><td class="num">${r.due}</td>
          <td>${r.last ? fmtShort(r.last) : '–'}</td><td class="num">${r.pct === null ? '–' : r.pct + '%'}</td><td>${r.signoff ? esc(r.signoff) : ''}</td></tr>`).join('')}</tbody></table></div>${Tables.bar('overview', rows)}`));
  }

  function openReport(key) {
    const [cls, unit] = key.split('|');
    window.openReport(cls, unit);
  }

  /* ---------- requests (MIS decides, HOD sees) ---------- */
  async function loadRequests() {
    try {
      cache.requests = need(await api('requests')).requests;
      const pending = cache.requests.filter((r) => r.status === 'pending');
      const decided = cache.requests.filter((r) => r.status !== 'pending').slice(0, 30);
      // The MIS Officer decides every request; the HOD decides moves between streams of one class.
      const can = hasRole('MIS'), canMove = (r) => can || (hasRole('HOD') && isStreamMove(r.admNo, r.classCode, r.existing?.classCode));
      const item = (r) => `<li class="req" data-id="${esc(r.id)}">
        <div><b>${esc(r.name)}</b> <span class="tadm">${esc(r.admNo)}</span>
          <small>${esc(r.classCode)} - added by ${esc(r.requestedBy)} ${r.requestedAt ? fmtShort(r.requestedAt) : ''}${r.reason ? ' - ' + esc(r.reason) : ''}</small>
          ${r.existing ? `<small class="warn-text">Already on the list of ${esc(r.existing.classCode)} as ${esc(r.existing.name)}${r.existing.active ? '' : ' (withdrawn)'}</small>` : ''}
          ${r.status !== 'pending' ? `<small>${esc(r.status)}${r.mergedInto ? ' into ' + esc(r.mergedInto) : ''}${r.note ? ' - ' + esc(r.note) : ''}</small>` : ''}</div>
        ${canMove(r) && r.status === 'pending' ? `<div class="req-actions"><button type="button" class="btn small primary" data-decide="approve">${r.existing ? 'Move here' : 'Approve'}</button>
          ${can ? '<button type="button" class="btn small" data-decide="merge">Same as…</button>' : ''}<button type="button" class="btn small danger" data-decide="reject">Reject</button></div>` : ''}</li>`;
      fill('m-requests', (pending.length ? `<ul class="mlist reqs">${pending.map(item).join('')}</ul>` : '<p class="muted">No students are waiting. When a trainer adds a student while marking, they appear here.</p>')
        + (decided.length ? `<details class="mdone"><summary>Decided recently (${decided.length})</summary><ul class="mlist reqs">${decided.map(item).join('')}</ul></details>` : ''));
    } catch (e) { fill('m-requests', `<p class="err-text">${esc(e.message)}</p>`); }
  }

  async function decide(id, decision) {
    const r = cache.requests.find((x) => x.id === id); if (!r) return;
    if (decision === 'merge') {
      const others = state.trainees.filter((t) => t.classCode === r.classCode && t.active !== false);
      dialog(`<div class="scan-head"><strong>Same student as…</strong><button type="button" class="btn small ghost" data-close>Cancel</button></div>
        <p class="muted small">Use this when ${esc(r.name)} (${esc(r.admNo)}) was a typo or duplicate. Their marks move to the student you choose.</p>
        <label>Student on the ${esc(r.classCode)} list<select id="mergeInto">${others.map((t) => `<option value="${esc(t.admNo)}">${esc(t.name)} - ${esc(t.admNo)}</option>`).join('')}</select></label>
        <button type="button" class="btn primary big" id="mergeGo" data-id="${esc(id)}">Merge</button>`);
      return;
    }
    if (decision === 'reject' && !confirm(`Reject ${r.name}? They will be left out of ${r.classCode}'s registers and reports.`)) return;
    try {
      need(await api('decideRequest', { id, decision }));
      toast(decision === 'approve' ? `${r.name} added to ${r.classCode}` : `${r.name} rejected`, 'ok');
      await loadRequests();
      pullRoster({ silent: true });
      refreshBadge();
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------- MIS: term ---------- */
  function termHtml() {
    const t = state.meta.term;
    const weeks = state.meta.weeks || [];
    return `${t ? `<p class="term-now">Current term: <b>${esc(t.duration || t.name)}</b></p>
      <ol class="weeks">${weeks.map((w, i) => `<li${(t.catWeeks || []).includes(i + 1) ? ' class="catwk"' : ''}><b>Week ${i + 1}</b> ${fmtShort(w)}${(t.catWeeks || []).includes(i + 1) ? ' - CAT(s)' : ''}</li>`).join('')}</ol>` : '<p class="muted">No term is set up. Trainers can mark, but registers are not tied to weeks until you set the term.</p>'}
      <details ${t ? '' : 'open'}><summary>${t ? 'Change the term or start a new one' : 'Set up the term'}</summary>
      <form id="termForm" class="termform">
        <div class="grid2">
          <label>Term name<input id="tName" required placeholder="Term 3 2026" value="${esc(t?.name || '')}"></label>
          <label>Code<input id="tId" placeholder="2026-T3" value="${esc(t?.id || '')}"></label>
        </div>
        <div class="grid2">
          <label>Duration (as printed on registers)<input id="tDur" placeholder="Sep - Dec 2026" value="${esc(t?.duration || '')}"></label>
          <label>First teaching day<input id="tStart" type="date" required value="${esc(t?.startDate || '')}"></label>
        </div>
        <div class="grid2">
          <label>Assessment series (printed on marksheets)<input id="tSeries" placeholder="Nov/Dec 2026" value="${esc(t?.series || '')}"></label>
          <label>Hours per lesson (for the register's hours)<input id="tHours" type="number" min="0.5" max="8" step="0.25" placeholder="1.5" value="${t?.lessonHours ?? ''}"></label>
        </div>
        <label>Break weeks (no teaching), any day in each week<span id="tBreaks" class="breaks">${(t?.breaks || []).map((b) => `<input type="date" value="${esc(b)}">`).join('')}<input type="date"></span></label>
        <fieldset class="catweeks"><legend>CAT weeks: trainers can take CAT registers in these weeks</legend>
          ${Array.from({ length: 12 }, (_, i) => `<label class="kchip"><input type="checkbox" value="${i + 1}" ${(t?.catWeeks || []).includes(i + 1) ? 'checked' : ''}><span>Week ${i + 1}</span></label>`).join('')}</fieldset>
        <p class="muted small">Every term has 12 teaching weeks; break weeks are skipped. Saving a new code starts a new term and closes the old one.</p>
        <button class="btn primary">Save term</button>
      </form></details>`;
  }
  async function saveTerm(e) {
    e.preventDefault();
    const btn = e.target.querySelector('button.primary');
    busy(btn, true, 'Saving…');
    try {
      const breaks = $$('#tBreaks input').map((i) => i.value).filter(Boolean);
      const catWeeks = $$('.catweeks input:checked').map((i) => Number(i.value));
      const res = need(await api('saveTerm', { name: $('#tName').value.trim(), termId: $('#tId').value.trim(), duration: $('#tDur').value.trim(), startDate: $('#tStart').value, breaks, catWeeks, lessonHours: Number($('#tHours').value) || null, series: $('#tSeries').value.trim() }));
      const last = res.weeks.length;
      toast(`${res.term.name} saved: week 1 starts ${fmtShort(res.weeks[0])}, week ${last} starts ${fmtShort(res.weeks[last - 1])}${res.term.catWeeks?.length ? ` - CAT weeks ${res.term.catWeeks.join(', ')}` : ''}`, 'ok');
      await pullRoster({ silent: true });
      $('#m-term') && replaceBody($('#m-term'), termHtml());
    } catch (err) { toast(err.message, 'err'); }
    finally { busy(btn, false); }
  }

  /* ---------- MIS: loading ---------- */
  function loadingHtml() {
    const units = state.units.filter((u) => u.trainerCode);
    return `<p class="muted">${units.length ? `${units.length} class units loaded for ${esc(state.meta.term?.name || 'this term')}.` : 'No loading uploaded for this term yet.'}
      Upload the department loading workbook; the app reads its <b>Subject Loading</b>, <b>List of Trainers</b> and <b>List of Subject</b> tabs only.</p>
      <label class="btn file-btn"><svg class="i" aria-hidden="true"><use href="#i-upload"/></svg>Choose loading workbook<input type="file" id="loadingFile" accept=".xlsx,.xlsm"></label>
      <div id="loadingPreview"></div>`;
  }
  async function readLoading(file) {
    const out = $('#loadingPreview');
    out.innerHTML = '<p class="muted">Reading the workbook…</p>';
    try {
      const L = loadingPreview = await Imports.loading(file);
      // A class's department is the first word of its code (ICT, BCE, HT…). The workbook's own department is the
      // one most rows belong to; classes of other departments (shared units an ICT trainer teaches) load only if ticked.
      const count = new Map();
      for (const r of L.rows) count.set(deptOf(r.classCode), (count.get(deptOf(r.classCode)) || 0) + 1);
      L.home = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      const others = [...count.keys()].filter((d) => d !== L.home).sort();
      const t = state.meta.term;
      const termNote = L.meta.term && t && !new RegExp(`\\b${L.meta.term}\\b`).test(t.name) ? `<p class="warn-text">This workbook says Term ${esc(L.meta.term)} ${esc(L.meta.year)}, but the active term is ${esc(t.name)}.</p>` : '';
      out.innerHTML = `<div class="preview">
        <p><b>${esc(L.fileName)}</b>${L.meta.department ? ` - ${esc(L.meta.department)} department` : ''}${L.meta.term ? ` - Term ${esc(L.meta.term)} ${esc(L.meta.year)}` : ''}</p>
        ${termNote}
        ${others.length ? `<fieldset class="catweeks" id="loadingDepts"><legend>This workbook also has classes from other departments. Tick the ones to load as well (${esc(L.home)} classes always load):</legend>
          ${others.map((d) => { const n = new Set(L.rows.filter((r) => deptOf(r.classCode) === d).map((r) => r.classCode)).size;
            return `<label class="kchip"><input type="checkbox" value="${esc(d)}"><span>${esc(d)} - ${n} class${n === 1 ? '' : 'es'}</span></label>`; }).join('')}</fieldset>` : ''}
        <div id="loadingSummary"></div>
        <button type="button" class="btn primary" id="uploadLoading" ${t ? '' : 'disabled'}>${t ? `Upload loading for ${esc(t.name)}` : 'Set up the term first'}</button></div>`;
      drawLoadingSummary();
    } catch (e) { out.innerHTML = `<p class="err-text">${esc(e.message)}</p>`; }
  }
  const deptOf = (code) => String(code || '').trim().split(/\s+/)[0].toUpperCase();
  /** The rows that will be uploaded: the workbook's own department plus any other departments ticked. */
  function loadingRows() {
    const L = loadingPreview, ticked = new Set($$('#loadingDepts input:checked').map((i) => i.value));
    return L.rows.filter((r) => deptOf(r.classCode) === L.home || ticked.has(deptOf(r.classCode)));
  }
  function drawLoadingSummary() {
    const L = loadingPreview, rows = loadingRows(), box = $('#loadingSummary');
    if (!L || !box) return;
    const classes = new Set(rows.map((r) => r.classCode)), trainers = new Set(rows.map((r) => r.trainerCode)), left = L.rows.length - rows.length;
    box.innerHTML = `<p>${rows.length} class units - ${classes.size} classes - ${trainers.size} trainers teaching - ${L.trainers.length} on the trainers list - ${rows.reduce((a, r) => a + r.hoursPerWeek, 0)} hours a week${left ? ` <span class="muted">(${left} class unit${left === 1 ? '' : 's'} of other departments left out)</span>` : ''}</p>
        ${(() => { const j = rows.filter((r) => r.classCode.includes(',')), s = new Set(rows.filter((r) => r.classCode.includes('/') && !r.classCode.includes(',')).map((r) => r.classCode));
          return j.length || s.size ? `<p class="muted small">${j.length ? `${j.length} unit${j.length === 1 ? ' is' : 's are'} taught to classes together (a comma, e.g. <i>${esc(j[0].classCode)}</i>): each class gets the unit and its trainer marks them as one lesson. ` : ''}${s.size ? `${s.size} class${s.size === 1 ? '' : 'es'} with a slash (e.g. <i>${esc([...s][0])}</i>) ${s.size === 1 ? 'is' : 'are'} one class for every unit.` : ''}</p>` : ''; })()}
        <div class="table-wrap"><table class="report-table"><thead><tr><th>Class</th><th>Unit</th><th>Trainer</th><th class="num">Lessons/wk</th><th class="num">Hrs/wk</th></tr></thead>
        <tbody>${rows.slice(0, 6).map((r) => `<tr><td>${esc(r.classCode)}</td><td>${esc(r.unitCode)} - ${esc(r.unitName)}</td><td>${esc(r.trainerName)}</td><td class="num">${r.lessonsPerWeek}</td><td class="num">${r.hoursPerWeek}</td></tr>`).join('')}
        ${rows.length > 6 ? `<tr><td colspan="5" class="muted">…and ${rows.length - 6} more</td></tr>` : ''}</tbody></table></div>`;
  }
  async function uploadLoading(btn) {
    if (!loadingPreview) return;
    busy(btn, true, 'Uploading…');
    try {
      const res = need(await api('uploadLoading', { rows: loadingRows(), trainers: loadingPreview.trainers }));
      toast(`Loading saved: ${res.rows} class units, ${res.trainers} trainers${res.newStaff ? ` (${res.newStaff} new — issue their PINs under Staff)` : ''}`, 'ok');
      loadingPreview = null;
      await pullRoster({ silent: true });
      replaceBody($('#m-loading'), loadingHtml());
      replaceBody($('#m-classes'), classesHtml());
      loadStaff();
    } catch (e) { toast(e.message, 'err'); busy(btn, false); }
  }

  /* ---------- MIS: class lists ---------- */
  function classGroups() {
    const groups = new Map();
    for (const c of state.classes) {
      const g = c.misClass || '';
      if (!g) continue;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c.code);
    }
    return groups;
  }
  function classesHtml() {
    const groups = classGroups();
    const count = (code) => state.trainees.filter((t) => t.classCode === code && t.active !== false).length;
    return `<p class="muted">Upload the class registers from the MIS system (PDF, or the same register saved as Excel). New students are added; nobody is removed without your say.</p>
      <label class="btn file-btn"><svg class="i" aria-hidden="true"><use href="#i-upload"/></svg>Choose class register files<input type="file" id="classFiles" accept=".pdf,.xlsx,.xlsm,.csv" multiple></label>
      <div id="classImports">${classImports.map(importCard).join('')}</div>
      <div class="regcodes"><p class="small"><b>CDACC registration codes</b> for the marksheets: upload any Excel or CSV with admission numbers and registration codes (a filled marksheet works). Trainers can enter marks before this.</p>
        <label class="btn small file-btn"><svg class="i" aria-hidden="true"><use href="#i-upload"/></svg>Upload registration codes<input type="file" id="regFiles" accept=".xlsx,.xlsm,.csv" multiple></label>
        <span id="regResult" class="small"></span></div>
      ${groups.size ? (() => {
        const all = Tables.sort('classes', [...groups.entries()].map(([g, codes]) => ({ g, codes, n: codes.reduce((a, c) => a + count(c), 0) })),
          { g: (x) => x.g, streams: (x) => x.codes.length, n: (x) => x.n }, 'g');
        const page = Tables.slice('classes', all);
        return fold('classes', `Show the classes (${all.length})`, `<div class="table-wrap"><table class="report-table class-table"><thead><tr>${Tables.th('classes', 'g', 'Class')}${Tables.th('classes', 'streams', 'Streams')}${Tables.th('classes', 'n', 'Students', 'num')}</tr></thead>
          <tbody>${page.map(({ g, codes, n }) => `<tr data-group="${esc(g)}" tabindex="0" role="button"><td><b>${esc(g)}</b></td>
            <td class="muted small">${codes.map((c) => `${esc(c.split(' ').pop())} ${count(c)}`).join(' - ')}</td><td class="num">${n}</td></tr>`).join('')}</tbody></table></div>${Tables.bar('classes', all)}`);
      })() : ''}
      ${(() => {
        const arch = archivedGroups();
        return arch.length ? fold('archived', `Archived classes (${arch.length})`, `<ul class="mlist archived-list">${arch.map((g) => `<li><span><b>${esc(g.label)}</b>
          <small>${g.students} student(s) - archived ${esc(fmtShort(g.at))}${g.by ? ' by ' + esc(g.by) : ''}</small></span>
          <span class="st-actions"><button type="button" class="btn small" data-restore="${esc(g.label)}">Bring back</button>
          <button type="button" class="btn small danger" data-delete="${esc(g.label)}">Delete…</button></span></li>`).join('')}</ul>`) : '';
      })()}
      ${(() => {
        const empty = state.classes.filter((c) => state.units.some((u) => u.classCode === c.code) && !/[,/]/.test(c.code) && !count(c.code)).map((c) => c.code).sort();
        return empty.length ? `<details class="mdone"><summary>${empty.length} classes in the loading have no students yet</summary><p class="small">${empty.map(esc).join(' - ')}</p>
          <p class="muted small">Trainers see an empty register for these. Upload their class registers above and tick the matching stream(s).</p></details>` : '';
      })()}`;
  }

  function importCard(imp, i) {
    const loaded = state.classes.filter((c) => state.units.some((u) => u.classCode === c.code) || c.misClass).map((c) => c.code).sort();
    const d = imp.diff;
    const box = (list) => list.map((c) => `<label class="check"><input type="checkbox" value="${esc(c)}" ${imp.streams.includes(c) ? 'checked' : ''}>${esc(c)}</label>`).join('');
    const streamsBox = `<fieldset class="streams"><legend>Streams in the loading (students are split between the ticked ones)</legend>
      ${loaded.length ? box(loaded.filter((c) => imp.streams.includes(c)))
        + `<details class="more"><summary>${imp.streams.length ? 'Other classes' : 'Choose the classes'} (${loaded.length - imp.streams.length})</summary>${box(loaded.filter((c) => !imp.streams.includes(c)))}</details>`
        : '<p class="muted small">Upload the loading first so the class can be linked to its streams.</p>'}</fieldset>`;
    let diff = '';
    if (d) {
      const split = Object.entries(d.byStream).map(([s, n]) => `${esc(s.split(' ').pop())}: ${n}`).join(' - ');
      diff = `<div class="diff">
        <p class="d-add"><b>${d.added.length}</b> new student(s)${d.added.length ? ' → ' + Object.entries(d.added.reduce((m, a) => { m[a.classCode] = (m[a.classCode] || 0) + 1; return m; }, {})).map(([s, n]) => `${esc(s.split(' ').pop())} ${n}`).join(', ') : ''}</p>
        <p><b>${d.unchanged}</b> already on the list</p>
        ${d.confirmed.length ? `<p class="d-add"><b>${d.confirmed.length}</b> student(s) added by trainers are confirmed by this list</p>` : ''}
        ${d.moved.length ? `<p class="warn-text"><b>${d.moved.length}</b> moving from another class: ${d.moved.slice(0, 3).map((m) => `${esc(m.name)} (${esc(m.from)})`).join(', ')}${d.moved.length > 3 ? '…' : ''}</p>` : ''}
        ${d.renamed.length ? `<label class="check"><input type="checkbox" class="useNew" ${imp.useNewNames ? 'checked' : ''}>Use this list's spelling for ${d.renamed.length} name(s): ${d.renamed.slice(0, 2).map((r) => `${esc(r.old)} → ${esc(r.name)}`).join('; ')}${d.renamed.length > 2 ? '…' : ''}</label>` : ''}
        ${d.missing.length ? `<fieldset class="missing"><legend>${d.missing.length} on the app's list but not in this file. Tick anyone who has left:</legend>
          ${d.missing.map((m) => `<label class="check"><input type="checkbox" class="wd" value="${esc(m.admNo)}" ${imp.withdraw.includes(m.admNo) ? 'checked' : ''}>${esc(m.name)} <span class="tadm">${esc(m.admNo)} - ${esc(m.classCode)}</span></label>`).join('')}</fieldset>` : ''}
        ${placementHtml(imp)}
        <p class="muted small">After saving: ${split}</p></div>`;
    }
    return `<div class="card import" data-i="${i}">
      <div class="import-head"><b>${esc(imp.fileName)}</b><button type="button" class="btn small ghost" data-remove>Remove</button></div>
      <div class="grid2"><label>Class code (MIS)<input class="misCode" value="${esc(imp.misClass)}"></label><label>Duration<input value="${esc(imp.duration)}" disabled></label></div>
      <p class="muted small">${imp.students.length} students read - first: ${esc(imp.students[0].name)} (${esc(imp.students[0].admNo)})</p>
      ${streamsBox}${diff}
      <div class="row-actions">${d ? `<button type="button" class="btn primary" data-apply>Save class list</button>` : ''}<button type="button" class="btn${d ? '' : ' primary'}" data-preview>${d ? 'Check again' : 'Check changes'}</button></div>
    </div>`;
  }
  /** Short names for the streams: what differs between them ("A", "B", "C"). */
  function streamLabels(streams) {
    if (streams.length < 2) return Object.fromEntries(streams.map((s) => [s, s.split(' ').pop()]));
    let pre = streams[0];
    for (const x of streams) while (!x.startsWith(pre)) pre = pre.slice(0, -1);
    return Object.fromEntries(streams.map((x) => [x, x.slice(pre.length).replace(/^[-\s]+/, '') || x.split(' ').pop()]));
  }
  /** Every student in the file with the stream they will be in; tap a stream to move someone. */
  function placementHtml(imp) {
    const d = imp.diff;
    if (!d || !d.plan || imp.streams.length < 2) return '';
    const lab = streamLabels(imp.streams);
    const count = (st) => d.plan.filter((p) => p.to === st).length;
    return `<div class="placement">
      <div class="pl-head"><b>Streams</b>${imp.streams.map((st) => `<span class="pill" data-count="${esc(st)}">${esc(lab[st])}: ${count(st)}</span>`).join('')}
        <button type="button" class="btn small ghost" data-resplit>Split the list evenly again</button></div>
      <p class="muted small">Students already in a stream stay there; new students are shared out. Tap a letter to move a student, then save.</p>
      <input type="search" class="plSearch" placeholder="Search name or admission number" aria-label="Search students">
      <ol class="pl-list">${d.plan.map((p, k) => `<li data-k="${k}" data-q="${esc((p.name + ' ' + p.admNo).toLowerCase())}">
        <span class="pl-who"><b>${esc(p.name)}</b><small>${esc(p.admNo)}${p.isNew ? ' - new' : p.from && !imp.streams.includes(p.from) ? ` - now in ${esc(p.from)}` : ''}</small></span>
        <span class="seg">${imp.streams.map((st) => `<button type="button" data-to="${esc(st)}" aria-pressed="${p.to === st}" title="${esc(st)}">${esc(lab[st])}</button>`).join('')}</span></li>`).join('')}</ol></div>`;
  }
  function refreshCounts(card, imp) {
    for (const st of imp.streams) {
      const el = card.querySelector(`[data-count="${CSS.escape(st)}"]`);
      if (el) el.textContent = `${streamLabels(imp.streams)[st]}: ${imp.diff.plan.filter((p) => p.to === st).length}`;
    }
  }
  function readImportCard(card) {
    const imp = classImports[Number(card.dataset.i)];
    imp.misClass = card.querySelector('.misCode').value.trim();
    imp.streams = [...card.querySelectorAll('.streams input:checked')].map((x) => x.value);
    imp.withdraw = [...card.querySelectorAll('.wd:checked')].map((x) => x.value);
    imp.useNewNames = !!card.querySelector('.useNew')?.checked;
    return imp;
  }
  async function addClassFiles(files) {
    for (const f of files) {
      try {
        const r = await Imports.classList(f);
        const codes = state.classes.map((c) => c.code);
        const linked = state.classes.filter((c) => c.misClass && c.misClass === r.misClass).map((c) => c.code);
        classImports.push({ ...r, streams: linked.length ? linked : Imports.suggestStreams(r.misClass, codes), withdraw: [], useNewNames: false, diff: null });
      } catch (e) { toast(`${f.name}: ${e.message}`, 'err'); }
    }
    $('#classImports').innerHTML = classImports.map(importCard).join('');
  }
  async function runImport(card, apply) {
    const imp = readImportCard(card);
    if (!imp.misClass) { toast('Enter the class code', 'err'); return; }
    const loadedClasses = state.classes.some((c) => state.units.some((u) => u.classCode === c.code));
    if (!imp.streams.length && loadedClasses) { toast('Tick the class or stream(s) from the loading that this list belongs to; trainers mark by those names', 'err'); return; }
    if (!imp.streams.length && !confirm(`No streams ticked. Add all ${imp.students.length} students to a class called ${imp.misClass}?`)) return;
    const btn = card.querySelector(apply ? '[data-apply]' : '[data-preview]');
    busy(btn, true, apply ? 'Saving…' : 'Checking…');
    try {
      const assign = imp.diff && imp.diff.plan ? Object.fromEntries(imp.diff.plan.map((p) => [p.admNo, p.to])) : undefined;
      const res = need(await api('importClassList', { misClass: imp.misClass, streams: imp.streams, students: imp.students, dryRun: !apply, withdraw: imp.withdraw, useNewNames: imp.useNewNames, assign }));
      if (apply) {
        const split = imp.streams.length > 1 ? ' - ' + Object.entries(res.byStream).map(([st, n]) => `${streamLabels(imp.streams)[st]} ${n}`).join(', ') : '';
        toast(`${imp.misClass}: ${res.added.length} added${res.moved.length ? `, ${res.moved.length} moved` : ''}${imp.withdraw.length ? `, ${imp.withdraw.length} withdrawn` : ''}${split}`, 'ok');
        classImports.splice(Number(card.dataset.i), 1);
        await pullRoster({ silent: true });
        replaceBody($('#m-classes'), classesHtml());
        loadRequests();
      } else {
        imp.diff = res;
        card.outerHTML = importCard(imp, Number(card.dataset.i));
      }
    } catch (e) { toast(e.message, 'err'); busy(btn, false); }
  }

  async function showGroup(group) {
    dialog(`<div class="scan-head"><strong>${esc(group)}</strong><button type="button" class="btn small ghost" data-close>Close</button></div><p class="muted">Loading…</p>`);
    try {
      const res = need(await api('students', { misClass: group }));
      const streams = classGroups().get(group) || [];
      const list = res.students.sort((a, b) => a.name.localeCompare(b.name));
      $('#adminDialogBody').innerHTML = `<div class="scan-head"><strong>${esc(group)} - ${list.filter((s) => s.status === 'active').length} students</strong><button type="button" class="btn small ghost" data-close>Close</button></div>
        <input type="search" id="grpSearch" placeholder="Search name or admission no." aria-label="Search students">
        <ul class="mlist students">${list.map((s) => `<li data-adm="${esc(s.admNo)}" data-q="${esc((s.name + ' ' + s.admNo).toLowerCase())}" class="${s.status !== 'active' ? 'gone' : ''}">
          <span><b>${esc(s.name)}</b><small>${esc(s.admNo)}${s.status !== 'active' ? ' - ' + esc(s.status) : ''}</small></span>
          <span class="st-actions"><select class="moveTo" aria-label="Stream for ${esc(s.name)}">${streams.map((c) => `<option ${c === s.classCode ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <button type="button" class="btn small ${s.status === 'active' ? 'danger' : ''}" data-status="${s.status === 'active' ? 'withdrawn' : 'active'}">${s.status === 'active' ? 'Withdraw' : 'Restore'}</button></span></li>`).join('')}</ul>`;
      if (hasRole('MIS')) {
        $('#adminDialogBody').insertAdjacentHTML('beforeend', `<div class="archive-row"><p class="muted small">Finished with this class? Archiving hides it, its students and its loading from day-to-day screens. Nothing is deleted, and it can be brought back.</p>
          <button type="button" class="btn" data-archive="${esc(group)}">Archive ${esc(group)}</button></div>`);
      }
    } catch (e) { $('#adminDialogBody').insertAdjacentHTML('beforeend', `<p class="err-text">${esc(e.message)}</p>`); }
  }
  /** Archived classes, by MIS class name (all of its streams together). */
  function archivedGroups() {
    const groups = new Map();
    for (const c of state.meta.archived || []) {
      const g = c.misClass || c.code;
      if (!groups.has(g)) groups.set(g, { label: g, codes: [], students: 0, at: c.archivedAt, by: c.archivedBy });
      const x = groups.get(g); x.codes.push(c.code); x.students += c.students || 0;
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
  async function archive(codes, on, label) {
    try {
      need(await api('archiveClasses', { codes, archive: on }));
      toast(on ? `${label} archived` : `${label} is back`, 'ok');
      closeDialog();
      await pullRoster({ silent: true });
      const el = $('#m-classes'); if (el) replaceBody(el, classesHtml());
    } catch (e) { toast(e.message, 'err'); }
  }
  function askDelete(g) {
    dialog(`<div class="scan-head"><strong>Delete ${esc(g.label)} for good</strong><button type="button" class="btn small ghost" data-close>Cancel</button></div>
      <p>This removes ${esc(g.label)} from the database: its ${g.students} student(s), loading in every term, registers, QR check-ins, marks, sign-offs and evidence records.</p>
      <p><b>The Google Drive copies stay</b> (attendance sheets, marksheets and the students' evidence files). A file with everything being deleted is saved to this device first.</p>
      <label>Type <b>${esc(g.label)}</b> to confirm<input id="delConfirm" autocomplete="off"></label>
      <button type="button" class="btn danger" data-delete-go="${esc(g.label)}">Save a copy and delete</button>`);
  }
  async function deleteGroup(label) {
    const g = archivedGroups().find((x) => x.label === label); if (!g) return;
    const typed = $('#delConfirm').value.trim();
    if (typed.toLowerCase() !== label.toLowerCase()) { toast('Type the class name exactly to confirm', 'err'); return; }
    const btn = $('[data-delete-go]'); btn.disabled = true; btn.textContent = 'Saving a copy…';
    try {
      const copy = need(await api('classExport', { codes: g.codes }));
      download(`Class-${fileSafe(label)}_${todayISO()}.json`, JSON.stringify(copy), 'application/json');
      btn.textContent = 'Deleting…';
      need(await api('deleteClasses', { codes: g.codes, confirm: typed, label }));
      toast(`${label} deleted. The copy is in this device's downloads.`, 'ok');
      closeDialog();
      await pullRoster({ silent: true });
      const el = $('#m-classes'); if (el) replaceBody(el, classesHtml());
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Save a copy and delete'; }
  }
  async function updateStudent(li, patch) {
    try {
      need(await api('updateStudent', { admNo: li.dataset.adm, ...patch }));
      toast(patch.classCode ? `Moved to ${patch.classCode}` : patch.status === 'withdrawn' ? 'Withdrawn from the class' : 'Back on the class list', 'ok');
      if (patch.status) { li.classList.toggle('gone', patch.status !== 'active'); const b = li.querySelector('[data-status]'); b.dataset.status = patch.status === 'active' ? 'withdrawn' : 'active'; b.textContent = patch.status === 'active' ? 'Withdraw' : 'Restore'; b.classList.toggle('danger', patch.status === 'active'); }
      pullRoster({ silent: true });
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------- HOD and MIS: student phones ----------
   * Each student checks in from one registered phone (one browser on it). Reset frees them to set up another:
   * a new or lost phone, a reset phone, cleared browser data, or a different browser. */
  let phoneQuery = '';
  async function loadPhones() {
    try {
      cache.phones = need(await api('phones')).phones;
      fill('m-phones', `<p class="muted">A student checks in only from the phone (and browser) they set up. If they change phones, clear the browser's data, or need a different browser, reset their phone here; the next one they set up becomes theirs. Their check-ins and evidence stay.</p>
        ${fold('phones', `Show registered phones (${cache.phones.length})`, `<input type="search" id="phoneSearch" placeholder="Search name, admission no. or class" aria-label="Search student phones"><div id="phoneList"></div>`)}`);
      $('#phoneSearch').value = phoneQuery;
      drawPhones();
    } catch (e) { fill('m-phones', `<p class="err-text">${esc(e.message)}</p>`); }
  }
  function drawPhones() {
    const box = $('#phoneList'); if (!box) return;
    const q = phoneQuery.trim().toLowerCase();
    const hit = (p) => !q || [p.name, p.admNo, p.classCode].some((x) => String(x || '').toLowerCase().includes(q));
    const list = Tables.sort('phones', (cache.phones || []).filter(hit),
      { name: (p) => p.name, cls: (p) => p.classCode, seen: (p) => p.lastSeen }, 'name');
    if (!list.length) { box.innerHTML = `<p class="muted">${q ? 'Nothing matches that search.' : 'No student phones are registered yet.'}</p>`; return; }
    const page = Tables.slice('phones', list), first = list.indexOf(page[0]);
    box.innerHTML = `<div class="table-wrap"><table class="report-table phone-table"><thead><tr><th class="num">S/N</th>${Tables.th('phones', 'name', 'Student')}<th></th>${Tables.th('phones', 'cls', 'Class')}${Tables.th('phones', 'seen', 'Last used')}</tr></thead>
      <tbody>${page.map((p, i) => `<tr data-adm="${esc(p.admNo)}"><td class="num">${first + i + 1}</td><td><b>${esc(p.name)}</b><br><small class="muted">${esc(p.admNo)}</small></td>
        <td><button type="button" class="btn small danger" data-resetphone>Reset phone</button></td><td>${esc(p.classCode)}</td>
        <td class="small" title="Set up ${esc(fmtShort(p.registeredAt))}">${esc(fmtShort(p.lastSeen))}</td></tr>`).join('')}</tbody></table></div>${Tables.bar('phones', list)}`;
  }
  async function resetPhone(btn) {
    const tr = btn.closest('tr'), adm = tr.dataset.adm, p = (cache.phones || []).find((x) => x.admNo === adm), who = p ? `${p.name} (${p.admNo})` : adm;
    if (!confirm(`Reset the phone for ${who}?\n\nTheir current phone stops checking in. The next phone or browser they set up becomes theirs. Their check-ins and evidence stay.`)) return;
    busy(btn, true, 'Resetting…');
    try {
      need(await api('resetPhone', { admNo: adm }));
      cache.phones = cache.phones.filter((x) => x.admNo !== adm);
      const sum = $('#m-phones summary'); if (sum) sum.textContent = `Show registered phones (${cache.phones.length})`;
      drawPhones();
      toast(`${p ? p.name : adm} can now set up a new phone`, 'ok');
    } catch (e) { busy(btn, false); toast(e.message, 'err'); }
  }

  /* ---------- HOD and MIS: backup of approved evidence into the backup account's Drive ---------- */
  const gb = (n) => (n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1) + ' GB';
  const REPEAT = { off: 'Off', daily: 'Every day', weekly: 'Every week', monthly: 'Every month' };
  async function loadBackup() {
    try {
      const b = cache.backup = need(await api('backupStatus'));
      drawBackup(b);
      refreshBadge();
    } catch (e) { fill('m-backup', `<p class="err-text">${esc(e.message)}</p>`); }
  }
  function drawBackup(b) {
    const r = b.report || {}, who = r.email || b.archiveEmail || 'the backup account', pct = r.limit ? Math.round((r.used / r.limit) * 100) : 0;
    const advice = `Ask IT to give <b>${esc(who)}</b> more Google Drive space, or switch the backup to another college account: set up the Drive bridge under that account (Technical Documentation, 4.3) and change the <b>Backup account</b> in Manage → Google Drive. Copies already made stay where they are.`;
    const banner = b.level === 'full' ? `<div class="backup-alert full"><b>The backup account's Drive is ${pct}% full, so backups have stopped.</b> ${advice}</div>`
      : b.level === 'warn' ? `<div class="backup-alert"><b>The backup account's Drive is ${pct}% full.</b> Backups stop at ${Math.round(b.stopAt * 100)}%. ${advice}</div>` : '';
    const gauge = r.limit ? `<div class="gauge ${b.level}" role="img" aria-label="${pct}% used"><span style="width:${Math.min(100, pct)}%"></span></div>
      <p class="small">${esc(who)}: <b>${gb(r.used)}</b> of ${gb(r.limit)} used (${pct}%)${r.checkedAt ? ` <span class="muted">- checked ${esc(fmtTime(r.checkedAt))}</span>` : ''}</p>`
      : '<p class="muted small">The Drive bridge has not reported the backup account\'s storage yet. It does on its next hourly run.</p>';
    const last = r.running ? `<p><b>Backing up now…</b> ${r.copied || 0} copied so far.</p>`
      : r.finishedAt ? `<p>Last backup ${esc(fmtTime(r.finishedAt))}: <b>${r.copied || 0}</b> copied${r.changed ? `, ${r.changed} changed after sending` : ''}${r.failed ? `, <span class="err-text">${r.failed} could not be copied</span>` : ''}.</p>`
        : r.paused ? '<p class="err-text">The last backup stopped because the Drive is nearly full.</p>' : '<p class="muted">No backup yet.</p>';
    const hours = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === Number(b.plan.hour) ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
    fill('m-backup', `${banner}
      <p class="muted">Approved documents that students keep in their own Drive are copied into <b>The ARK - Archive</b> in ${esc(who)}'s Drive, so the college keeps them after a student leaves.</p>
      ${gauge}
      ${r.wrongAccount ? `<p class="err-text small">The Drive bridge runs as ${esc(r.email)}, but students share their files with ${esc(r.wrongAccount)}. Make them the same account (Manage → Google Drive → Backup account).</p>` : ''}
      ${r.lastError && !r.wrongAccount ? `<p class="err-text small">${esc(r.lastError)}</p>` : ''}
      ${last}
      <p class="small">${b.waiting ? `<b>${b.waiting}</b> approved document(s) waiting for the next backup.` : 'Every approved document is backed up.'}</p>
      ${b.gaveUp.length ? fold('backupFailed', `${b.gaveUp.length} could not be copied`, `<ul class="mlist">${b.gaveUp.map((g) => `<li><span><b>${esc(g.name)}</b><small>${esc(g.admNo)} - ${esc(g.what)} - ${esc(g.error)}</small></span></li>`).join('')}</ul>
        <p class="muted small">Usually the student deleted the file or stopped sharing it.</p><button type="button" class="btn small" data-act="backupRetry">Try these again</button>`) : ''}
      <form id="backupForm" class="inline-form">
        <label class="grow">Repeat<select id="backupRepeat">${Object.entries(REPEAT).map(([k, v]) => `<option value="${k}"${k === b.plan.repeat ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="grow">At<select id="backupHour">${hours}</select></label>
        <button class="btn">Save</button>
      </form>
      <div class="row-actions"><button type="button" class="btn primary" data-act="backupNow"${b.level === 'full' ? ' disabled' : ''}>Back up now</button></div>
`);
  }
  async function backupAction(patch, btn, msg) {
    busy(btn, true, 'Saving…');
    try { cache.backup = need(await api('setBackup', patch)); drawBackup(cache.backup); refreshBadge(); toast(msg, 'ok'); }
    catch (e) { toast(e.message, 'err'); busy(btn, false); }
  }

  /* ---------- MIS: staff ---------- */
  async function loadStaff() {
    if (!hasRole('MIS')) return;
    try {
      const res = need(await api('staff'));
      cache.staff = res.staff; cache.defaultPin = res.defaultPin;
      drawStaff();
    } catch (e) { fill('m-staff', `<p class="err-text">${esc(e.message)}</p>`); }
  }
  const STAFF_SORT = {
    name: (a, b) => (b.active - a.active) || a.name.localeCompare(b.name), code: (a, b) => (b.active - a.active) || a.code.localeCompare(b.code, undefined, { numeric: true }),
    role: (a, b) => (b.active - a.active) || ['MIS', 'HOD', 'TRAINER'].findIndex((r) => a.roles.includes(r)) - ['MIS', 'HOD', 'TRAINER'].findIndex((r) => b.roles.includes(r)) || a.name.localeCompare(b.name),
    pin: (a, b) => (b.active - a.active) || Number(a.hasPin) - Number(b.hasPin) || a.name.localeCompare(b.name) };
  function drawStaff() {
    try {
      const q = $('#staffSearch')?.value || '';
      cache.staff.sort(STAFF_SORT[staffSort] || STAFF_SORT.name);
      const noPin = cache.staff.filter((s) => s.active && !s.hasPin).length, def = cache.defaultPin;
      const firstPin = `<form id="defaultPinForm" class="default-pin"><div><b>First-time PIN</b>
          <p class="muted small">${def ? `Set${def.at ? ' ' + esc(fmtShort(def.at)) : ''}${def.by ? ' by ' + esc(def.by) : ''}. Anyone without a PIN of their own signs in with it, then chooses their own.` : 'Not set. Staff without a PIN cannot sign in until you issue them one.'}</p></div>
        <span class="dp-row"><input id="defaultPin" inputmode="numeric" maxlength="8" placeholder="4 to 8 digits" aria-label="First-time PIN" autocomplete="off">
        <button class="btn small primary">${def ? 'Change' : 'Set'}</button>${def ? '<button type="button" class="btn small ghost" data-act="clearDefaultPin">Remove</button>' : ''}</span></form>`;
      fill('m-staff', `${firstPin}${noPin && !def ? `<p class="warn-text">${noPin} staff member(s) can't sign in yet. Set a first-time PIN above, or tap Issue PIN and give them a PIN privately.</p>` : ''}
        ${fold('staff', `Show the staff (${cache.staff.length})`, `<div class="list-tools"><input type="search" id="staffSearch" placeholder="Search staff" aria-label="Search staff">
        <select id="staffSort" aria-label="Sort staff"><option value="name">By name</option><option value="code">By staff code</option><option value="role">By role</option><option value="pin">No PIN yet first</option></select></div>
        <ul class="mlist staff">${cache.staff.map((s, i) => `<li data-code="${esc(s.code)}" data-q="${esc((s.name + ' ' + s.code).toLowerCase())}" class="${s.active ? '' : 'gone'}">
          <span class="sn st-code">${esc(s.code)}</span>
          <span><b>${esc(s.name)}</b></span>
          <span class="roles">${['TRAINER', 'HOD', 'MIS'].map((r) => `<label class="rolechip"><input type="checkbox" value="${r}" ${s.roles.includes(r) ? 'checked' : ''}>${ROLE_LABEL[r]}</label>`).join('')}</span>
          <span class="st-actions"><button type="button" class="btn small" data-pin>${s.hasPin ? 'Reset PIN' : def ? 'Issue own PIN' : 'Issue PIN'}</button>
          <button type="button" class="btn small ${s.active ? 'danger' : ''}" data-active="${s.active ? '0' : '1'}">${s.active ? 'Switch off' : 'Switch on'}</button></span></li>`).join('')}</ul>`)}
        <details class="mdone"><summary>Add a staff member</summary><form id="addStaff" class="grid2">
          <label>Staff code<input id="nsCode" required autocapitalize="characters" placeholder="ICT070"></label><label>Name<input id="nsName" required placeholder="ICT OTIENO .J"></label>
          <button class="btn primary">Add and issue PIN</button></form></details>`);
      $('#staffSort').value = staffSort;
      if (q) { const s = $('#staffSearch'); s.value = q; s.dispatchEvent(new Event('input', { bubbles: true })); }
    } catch (e) { fill('m-staff', `<p class="err-text">${esc(e.message)}</p>`); }
  }
  function showPin(name, code, pin) {
    dialog(`<div class="scan-head"><strong>PIN for ${esc(name)}</strong><button type="button" class="btn small ghost" data-close>Done</button></div>
      <p class="pin-big">${esc(pin)}</p><p>Staff code <b>${esc(code)}</b>. Give this PIN to them privately; they choose their own PIN the first time they sign in. It is shown only once.</p>`);
  }
  async function staffAction(li, body, okMsg) {
    try {
      const res = need(await api('updateStaff', { code: li ? li.dataset.code : body.code, ...body }));
      if (res.pin) showPin(res.staff.name, res.staff.code, res.pin);
      else if (okMsg) toast(okMsg, 'ok');
      loadStaff();
    } catch (e) { toast(e.message, 'err'); loadStaff(); }
  }

  /* ---------- MIS: CDACC registration codes ---------- */
  const REG = /^[A-Z0-9]{4,12}(\/[A-Z0-9]{1,8}){4}$/i;   // 0320134P/CSC/6/2025/130
  async function readRegCodes(files) {
    const out = $('#regResult'); out.textContent = 'Reading…';
    try {
      const pairs = new Map();
      for (const f of files) {
        let rows = [];
        if (/\.csv$/i.test(f.name)) rows = (await f.text()).split(/\r?\n/).map((l) => l.split(/[,;\t]/).map((x) => x.replace(/^"|"$/g, '').trim()));
        else { const wb = await Xlsx.open(await f.arrayBuffer()); for (const n of wb.names) rows.push(...(await wb.rows(n)).filter(Boolean)); }
        for (const r of rows) {
          const cells = (r || []).map((x) => String(x ?? '').trim());
          const adm = cells.find((x) => Imports.isAdm(x) && !REG.test(x)), reg = cells.find((x) => REG.test(x));
          if (adm && reg) pairs.set(adm.toUpperCase(), reg.toUpperCase());
        }
      }
      if (!pairs.size) throw new Error('No rows with both an admission number and a registration code (like 0320134P/CSC/6/2025/130) were found');
      const res = need(await api('importRegCodes', { rows: [...pairs].map(([admNo, regCode]) => ({ admNo, regCode })) }));
      out.innerHTML = `<b class="ok-text">${res.updated} registration code${res.updated === 1 ? '' : 's'} saved.</b>${res.unknown.length ? ` ${res.unknown.length} admission number(s) are not on any class list: ${res.unknown.slice(0, 5).map(esc).join(', ')}${res.unknown.length > 5 ? '…' : ''}` : ''}`;
      pullRoster({ silent: true });
    } catch (e) { out.innerHTML = `<span class="err-text">${esc(e.message)}</span>`; }
  }

  /* ---------- MIS: the Google Drive bridge (attendance sheets per trainer, POE files) ---------- */
  async function loadDrive() {
    try {
      const { secret, report: r, archiveEmail, quotaGb } = need(await api('driveStatus'));
      // The backup account sees every document students save in their own Drive, and holds the backup copies.
      // Its space is typed in: with the college's pooled storage, Google reports only the whole college's limit.
      const archiveBox = typeof Google !== 'undefined' && Google.on() ? `<p class="muted small">The backup account sees every POE document students save in their own Drive, and keeps the backup copies.</p>
        <form class="inline-form" id="archiveEmailForm"><label class="grow">Backup account<input type="email" id="archiveEmail" value="${esc(archiveEmail || '')}" placeholder="ictpoe@rvnp.ac.ke"></label>
        <label class="narrow">Space (GB)<input type="number" id="archiveQuota" min="1" max="100000" step="1" value="${esc(quotaGb || 50)}"></label><button class="btn">Save</button></form>` : '';
      if (!r) {
        fill('m-drive', `<p class="muted">Not connected yet. Each trainer's attendance sheet and the students' POE files go to the college Google Drive through a small Apps Script in the school account. The README has the steps (about 10 minutes, once).</p>
          ${secret ? '' : '<p class="warn-text small">The database does not have the BRIDGE_SECRET setting yet (Cloudflare → the Worker → Settings → Variables).</p>'}${archiveBox}`);
        return;
      }
      const opts = (sel) => `<option value="">Choose their folder…</option>${(r.folders || []).sort((a, b) => a.name.localeCompare(b.name)).map((f) => `<option value="${esc(f.id)}"${f.id === sel ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}`;
      const staff = new Map((cache.staff || []).map((x) => [lower(x.code), x]));
      // Students upload to this address. The school-only form (/a/macros/<domain>/) asks students to sign in, so uploads fail.
      const schoolOnly = /\/a\/macros\//.test(r.url || '');
      const noFolders = !(r.folders || []).length;
      fill('m-drive', `<p class="muted">Connected - last update ${esc(fmtShort(r.at))}</p>
        ${schoolOnly ? `<p class="err-text small">The bridge address is the school-only form, so students who are not signed in to the school account cannot send evidence. In Apps Script, deploy a new version of the web app with <b>Who has access: Anyone</b>, then run sync() once.</p>` : ''}
        ${noFolders ? '<p class="warn-text small">The Trainers folder in Drive has no folders inside it yet. Create one folder per trainer inside it, or paste each trainer\'s folder link below.</p>' : ''}
        ${(r.unmatched || []).length ? `<p><b>${r.unmatched.length} trainer${r.unmatched.length === 1 ? '' : 's'} without a folder.</b> A folder is made for each trainer in the loading the next time the Drive updates; you can also choose one yourself or paste its link.</p>
        <ul class="mlist drive-list">${r.unmatched.map((u) => `<li data-code="${esc(u.code)}"><span><b>${esc(u.name)}</b> <span class="muted small">${esc(u.code)}</span></span>
          <span class="drive-pick">${(r.folders || []).length ? `<select data-drivefolder aria-label="Drive folder for ${esc(u.name)}">${opts(staff.get(lower(u.code))?.driveFolder || '')}</select>` : ''}
          <input type="text" data-drivelink placeholder="or paste folder link" aria-label="Folder link for ${esc(u.name)}"></span></li>`).join('')}</ul>` : ''}
        ${archiveBox}`);
    } catch (e) { fill('m-drive', `<p class="err-text">${esc(e.message)}</p>`); }
  }

  async function setDriveFolder(input) {
    const code = input.closest('li').dataset.code;
    const value = input.dataset.drivelink !== undefined ? input.value.trim() : input.value;
    if (!value) return;
    if (input.dataset.drivelink !== undefined && !/[-\w]{20,}/.test(value)) { toast('That does not look like a Drive folder link', 'err'); return; }
    input.disabled = true;
    try { need(await api('updateStaff', { code, driveFolder: value })); toast('Saved — their sheet is made on the next Drive update (about 10 minutes)', 'ok'); }
    catch (e) { toast(e.message, 'err'); }
    finally { input.disabled = false; }
  }

  /* ---------- badge on the Manage tab ---------- */
  /** Is this request a move from one stream of a class to another? */
  function isStreamMove(adm, classCode, from) {
    const now = from || state.trainees.find((t) => lower(t.admNo) === lower(adm))?.classCode;
    return !!now && now !== classCode && !!streamGroup(classCode)?.codes.includes(now);
  }
  function refreshBadge() {
    const dot = $('#manageCount'); if (!dot) return;
    let n = 0;
    if (hasRole('MIS')) n += (state.meta.pending || []).length;
    else if (hasRole('HOD')) n += (state.meta.pending || []).filter((p) => isStreamMove(p.admNo, p.classCode)).length;   // stream moves to decide
    if (hasRole('HOD')) n += cache.signoffs.filter((s) => s.status === 'submitted').length;
    if (cache.backup && cache.backup.level !== 'ok') n += 1;       // the backup account's Drive is filling up
    dot.hidden = !n;
    dot.textContent = n > 9 ? '9+' : String(n);
  }

  /* ---------- events (delegated, the sections are re-rendered often) ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#adminDialog [data-close]')) { closeDialog(); return; }
    if (!t.closest('#manage, #adminDialog')) return;
    const arc = t.closest('[data-archive]');
    if (arc) { const codes = classGroups().get(arc.dataset.archive) || []; if (codes.length && confirm(`Archive ${arc.dataset.archive}? It can be brought back later.`)) archive(codes, true, arc.dataset.archive); return; }
    const res = t.closest('[data-restore]');
    if (res) { const g = archivedGroups().find((x) => x.label === res.dataset.restore); if (g) archive(g.codes, false, g.label); return; }
    const del = t.closest('[data-delete]');
    if (del) { const g = archivedGroups().find((x) => x.label === del.dataset.delete); if (g) askDelete(g); return; }
    const go = t.closest('[data-delete-go]');
    if (go) { deleteGroup(go.dataset.deleteGo); return; }
    const sortTh = t.closest('th[data-sort]');
    if (sortTh) { const k = sortTh.dataset.sort; ovSort = { key: k, dir: ovSort.key === k ? -ovSort.dir : 1 }; Tables.reset('overview'); drawOverview(); return; }
    const open = t.closest('[data-open]'); if (open) { openReport(open.dataset.open); return; }
    const bn = t.closest('[data-act="backupNow"]'); if (bn) { backupAction({ now: true }, bn, 'Backup asked for: it starts within a few minutes'); return; }
    const br = t.closest('[data-act="backupRetry"]'); if (br) { backupAction({ retry: true, now: true }, br, 'They will be tried again in the next backup'); return; }
    if (t.closest('[data-act="clearDefaultPin"]')) {
      if (confirm('Remove the first-time PIN? Staff without their own PIN will not be able to sign in.')) {
        api('setDefaultPin', { pin: '' }).then((r) => { need(r); toast('First-time PIN removed', 'ok'); loadStaff(); }).catch((err) => toast(err.message, 'err'));
      }
      return;
    }
    const dec = t.closest('[data-decide]'); if (dec) { decide(dec.closest('.req').dataset.id, dec.dataset.decide); return; }
    if (t.closest('#mergeGo')) {
      const id = t.closest('#mergeGo').dataset.id;
      api('decideRequest', { id, decision: 'merge', mergeInto: $('#mergeInto').value }).then(need)
        .then(() => { closeDialog(); toast('Merged — their marks now count for that student', 'ok'); loadRequests(); pullRoster({ silent: true }); })
        .catch((err) => toast(err.message, 'err'));
      return;
    }
    if (t.closest('#uploadLoading')) { uploadLoading(t.closest('#uploadLoading')); return; }
    const card = t.closest('.import');
    if (card && t.closest('[data-preview]')) { runImport(card, false); return; }
    if (card && t.closest('[data-apply]')) { runImport(card, true); return; }
    const seg = t.closest('.placement [data-to]');
    if (card && seg) {
      const imp = classImports[Number(card.dataset.i)], li = seg.closest('li');
      imp.diff.plan[Number(li.dataset.k)].to = seg.dataset.to;
      li.querySelectorAll('[data-to]').forEach((x) => x.setAttribute('aria-pressed', String(x === seg)));
      refreshCounts(card, imp);
      return;
    }
    if (card && t.closest('[data-resplit]')) {
      const imp = classImports[Number(card.dataset.i)], n = imp.streams.length, total = imp.diff.plan.length;
      imp.diff.plan.forEach((p, k) => { p.to = imp.streams[Math.floor((k * n) / total)]; }); // equal parts in list order
      readImportCard(card); card.outerHTML = importCard(imp, Number(card.dataset.i));
      toast('Split in list order — move anyone who belongs elsewhere, then save');
      return;
    }
    if (card && t.closest('[data-remove]')) { classImports.splice(Number(card.dataset.i), 1); $('#classImports').innerHTML = classImports.map(importCard).join(''); return; }
    const grp = t.closest('[data-group]'); if (grp) { showGroup(grp.dataset.group); return; }
    const rp = t.closest('[data-resetphone]'); if (rp) { resetPhone(rp); return; }
    const st = t.closest('.students [data-status]'); if (st) { updateStudent(st.closest('li'), { status: st.dataset.status }); return; }
    const pin = t.closest('.staff [data-pin]');
    if (pin) {
      const li = pin.closest('li'), who = li.querySelector('b').textContent;
      // Only the MIS Officer resets PINs. With a first-time PIN set, a reset sends them back to it.
      if (cache.defaultPin && confirm(`Send ${who} back to the first-time PIN? Their own PIN stops working and they choose a new one when they next sign in.\n\nCancel to issue them a one-off PIN instead.`)) {
        staffAction(li, { resetPin: true, toDefault: true }, `${who} can now sign in with the first-time PIN`);
      } else if (confirm(`Issue a one-off PIN for ${who}? Their old PIN stops working.`)) staffAction(li, { resetPin: true });
      return;
    }
    const act = t.closest('.staff [data-active]');
    if (act) { const li = act.closest('li'); staffAction(li, { active: act.dataset.active === '1' }, act.dataset.active === '1' ? 'Switched on' : 'Switched off — they are signed out everywhere'); return; }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'loadingFile' && t.files[0]) { readLoading(t.files[0]); t.value = ''; }
    if (t.closest('#loadingDepts')) drawLoadingSummary();
    if (t.id === 'ovTerm') { ovTerm = t.value; loadOverview(); }
    if (t.id === 'soSort') { soSort = t.value; Tables.reset('signoffs'); Tables.reset('signoffsDone'); drawSignoffs(); }
    if (t.id === 'staffSort') { staffSort = t.value; drawStaff(); }
    if (t.id === 'classFiles' && t.files.length) { addClassFiles([...t.files]); t.value = ''; }
    if (t.id === 'regFiles' && t.files.length) { readRegCodes([...t.files]); t.value = ''; }
    if (t.matches('#tBreaks input') && t.value && t === $$('#tBreaks input').at(-1)) t.insertAdjacentHTML('afterend', '<input type="date">');
    if (t.matches('.import .streams input, .import .misCode')) { const card = t.closest('.import'); const imp = readImportCard(card); imp.diff = null; card.outerHTML = importCard(imp, Number(card.dataset.i)); }
    if (t.matches('[data-drivefolder]')) setDriveFolder(t);
    if (t.matches('[data-drivelink]') && t.value.trim()) setDriveFolder(t);
    if (t.matches('.students .moveTo')) updateStudent(t.closest('li'), { classCode: t.value });
    if (t.matches('.staff .rolechip input')) { const li = t.closest('li'); staffAction(li, { roles: [...li.querySelectorAll('.rolechip input:checked')].map((x) => x.value) }, 'Roles saved'); }
  });
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('.plSearch')) {
      const q = t.value.trim().toLowerCase();
      t.closest('.placement').querySelectorAll('.pl-list li').forEach((li) => { li.hidden = q && !li.dataset.q.includes(q); });
    }
    if (t.id === 'phoneSearch') { phoneQuery = t.value; Tables.reset('phones'); drawPhones(); return; }
    if (t.id === 'soSearch') { soQuery = t.value; Tables.reset('signoffs'); Tables.reset('signoffsDone'); drawSignoffs(); return; }
    if (t.id === 'grpSearch' || t.id === 'staffSearch') {
      const q = t.value.trim().toLowerCase();
      const list = t.id === 'grpSearch' ? $$('#adminDialog .students li') : $$('#m-staff .staff li');
      list.forEach((li) => { li.hidden = q && !li.dataset.q.includes(q); });
    }
  });
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.matches?.('details.fold[data-sec]')) { if (d.open) secOpen.add(d.dataset.sec); else secOpen.delete(d.dataset.sec); }
  }, true);
  Tables.on('overview', drawOverview);
  Tables.on('signoffs', drawSignoffs);
  Tables.on('phones', drawPhones);
  Tables.on('signoffsDone', drawSignoffs);
  Tables.defaults('signoffsDone', 30);
  Tables.on('classes', () => { const el = $('#m-classes'); if (el) replaceBody(el, classesHtml()); });
  document.addEventListener('keydown', (e) => {
    const row = e.target.closest?.('tr[data-group]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'backupForm') {
      e.preventDefault();
      const repeat = $('#backupRepeat').value, hour = Number($('#backupHour').value);
      backupAction({ repeat, hour }, e.target.querySelector('button'), repeat === 'off' ? 'Backups run only when you tap Back up now' : `Backups: ${REPEAT[repeat].toLowerCase()} at ${String(hour).padStart(2, '0')}:00`);
      return;
    }
    if (e.target.id === 'archiveEmailForm') {
      e.preventDefault();
      const btn = e.target.querySelector('button');
      busy(btn, true, 'Saving…');
      api('setArchiveEmail', { email: $('#archiveEmail').value.trim(), quotaGb: Number($('#archiveQuota').value) || 50 }).then(need)
        .then((r) => { toast(r.email ? `Saved: ${r.email}, ${r.quotaGb} GB` : 'No backup account', 'ok'); if (cache.backup) loadBackup(); })
        .catch((err) => toast(err.message, 'err')).finally(() => busy(btn, false));
      return;
    }
    if (e.target.id === 'defaultPinForm') {
      e.preventDefault();
      const pin = $('#defaultPin').value.trim();
      if (!/^[0-9]{4,8}$/.test(pin)) { toast('Use 4 to 8 digits for the first-time PIN', 'err'); return; }
      api('setDefaultPin', { pin }).then((r) => { need(r); toast('First-time PIN saved. Tell staff privately.', 'ok'); loadStaff(); }).catch((err) => toast(err.message, 'err'));
    }
    if (e.target.id === 'termForm') saveTerm(e);
    if (e.target.id === 'addStaff') {
      e.preventDefault();
      staffAction(null, { code: $('#nsCode').value.trim(), name: $('#nsName').value.trim(), roles: ['TRAINER'], resetPin: true });
    }
  });

  return { render, refreshBadge };
})();
window.Admin = Admin;
