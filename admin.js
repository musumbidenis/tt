/* Manage tab — sections shown by role.
 *   HOD:  registers waiting for approval, department overview, students waiting for the MIS Officer
 *   MIS:  term, trainer loading, class lists, student requests, staff
 * Everything here talks to the server, so it needs internet (marking does not). */
'use strict';

const Admin = (() => {
  const box = () => $('#manage');
  const ROLE_LABEL = { TRAINER: 'Trainer', HOD: 'HOD', MIS: 'MIS Officer' };
  let cache = { signoffs: [], requests: [], overview: null, staff: [] };
  let loadingPreview = null;
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
      parts.push(section('m-staff', 'Staff and roles', '<p class="muted">Loading…</p>'));
      parts.push(section('m-drive', 'Google Drive', '<p class="muted">Loading…</p>'));
      if (!OLD_SERVER.test(serverUrl())) parts.push(section('m-move', 'Bring in data from the Google Sheet', moveHtml()));
    } else if (hasRole('HOD')) parts.push(section('m-requests', 'Students waiting for the MIS Officer', '<p class="muted">Loading…</p>'));
    box().innerHTML = parts.join('');
    const jobs = [];
    if (hasRole('HOD')) jobs.push(loadSignoffs(), loadOverview());
    jobs.push(loadRequests());
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
  async function loadSignoffs() {
    try {
      cache.signoffs = need(await api('signoffs')).signoffs;
      const waiting = cache.signoffs.filter((s) => s.status === 'submitted');
      const done = cache.signoffs.filter((s) => s.status !== 'submitted');
      const item = (s) => `<li><button type="button" class="mrow" data-open="${esc(s.classCode)}|${esc(s.unitCode)}">
        <span><b>${esc(s.classCode)} · ${esc(s.unitCode)}</b><small>${esc(s.unitName)} · ${esc(s.trainerName)}</small></span>
        <span class="pill ${s.status === 'approved' ? 'synced' : s.status === 'returned' ? 'rejected' : 'pending'}">${s.status === 'submitted' ? 'Submitted ' + fmtShort(s.submittedAt) : s.status === 'approved' ? 'Approved' : 'Returned'}</span></button></li>`;
      fill('m-signoffs', (waiting.length ? `<ul class="mlist">${waiting.map(item).join('')}</ul>` : '<p class="muted">Nothing is waiting. Trainers submit their term registers from Reports.</p>')
        + (done.length ? `<details class="mdone"><summary>Approved or returned (${done.length})</summary><ul class="mlist">${done.map(item).join('')}</ul></details>` : ''));
    } catch (e) { fill('m-signoffs', `<p class="err-text">${esc(e.message)}</p>`); }
  }

  async function loadOverview() {
    try {
      const o = cache.overview = need(await api('overview'));
      if (!o.term) { fill('m-overview', '<p class="muted">The MIS Officer has not set up the term yet.</p>'); return; }
      const rows = o.rows.sort((a, b) => a.classCode.localeCompare(b.classCode) || a.unitCode.localeCompare(b.unitCode));
      const behind = rows.filter((r) => r.lessons < r.due - 1).length;
      fill('m-overview', `<p class="muted">${esc(o.term.name)} · week ${o.week} of 12 · ${rows.length} class units${behind ? ` · <b class="warn-text">${behind} behind on registers</b>` : ''}</p>
        <div class="table-wrap"><table class="report-table overview-table"><thead><tr><th>Class</th><th>Unit</th><th>Trainer</th><th class="num">Marked</th><th class="num">Due</th><th>Last</th><th class="num">Att.</th><th>HOD</th></tr></thead>
        <tbody>${rows.map((r) => `<tr class="${r.lessons < r.due - 1 ? 'behind' : ''}" data-open="${esc(r.classCode)}|${esc(r.unitCode)}">
          <td>${esc(r.classCode)}</td><td>${esc(r.unitCode)}</td><td>${esc(r.trainerName)}</td><td class="num">${r.lessons}</td><td class="num">${r.due}</td>
          <td>${r.last ? fmtShort(r.last) : '–'}</td><td class="num">${r.pct === null ? '–' : r.pct + '%'}</td><td>${r.signoff ? esc(r.signoff) : ''}</td></tr>`).join('')}</tbody></table></div>`);
    } catch (e) { fill('m-overview', `<p class="err-text">${esc(e.message)}</p>`); }
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
      const can = hasRole('MIS');
      const item = (r) => `<li class="req" data-id="${esc(r.id)}">
        <div><b>${esc(r.name)}</b> <span class="tadm">${esc(r.admNo)}</span>
          <small>${esc(r.classCode)} · added by ${esc(r.requestedBy)} ${r.requestedAt ? fmtShort(r.requestedAt) : ''}${r.reason ? ' · ' + esc(r.reason) : ''}</small>
          ${r.existing ? `<small class="warn-text">Already on the list of ${esc(r.existing.classCode)} as ${esc(r.existing.name)}${r.existing.active ? '' : ' (withdrawn)'}</small>` : ''}
          ${r.status !== 'pending' ? `<small>${esc(r.status)}${r.mergedInto ? ' into ' + esc(r.mergedInto) : ''}${r.note ? ' · ' + esc(r.note) : ''}</small>` : ''}</div>
        ${can && r.status === 'pending' ? `<div class="req-actions"><button type="button" class="btn small primary" data-decide="approve">${r.existing ? 'Move here' : 'Approve'}</button>
          <button type="button" class="btn small" data-decide="merge">Same as…</button><button type="button" class="btn small danger" data-decide="reject">Reject</button></div>` : ''}</li>`;
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
        <label>Student on the ${esc(r.classCode)} list<select id="mergeInto">${others.map((t) => `<option value="${esc(t.admNo)}">${esc(t.name)} — ${esc(t.admNo)}</option>`).join('')}</select></label>
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
    return `${t ? `<p><b>${esc(t.name)}</b> <span class="muted">· ${esc(t.duration || '')} · code ${esc(t.id)}</span></p>
      <ol class="weeks">${weeks.map((w, i) => `<li${(t.catWeeks || []).includes(i + 1) ? ' class="catwk"' : ''}><b>Week ${i + 1}</b> ${fmtShort(w)}${(t.catWeeks || []).includes(i + 1) ? ' · CAT' : ''}</li>`).join('')}</ol>` : '<p class="muted">No term is set up. Trainers can mark, but registers are not tied to weeks until you set the term.</p>'}
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
      const res = need(await api('saveTerm', { name: $('#tName').value.trim(), termId: $('#tId').value.trim(), duration: $('#tDur').value.trim(), startDate: $('#tStart').value, breaks, catWeeks }));
      const last = res.weeks.length;
      toast(`${res.term.name} saved: week 1 starts ${fmtShort(res.weeks[0])}, week ${last} starts ${fmtShort(res.weeks[last - 1])}${res.term.catWeeks?.length ? ` · CAT weeks ${res.term.catWeeks.join(', ')}` : ''}`, 'ok');
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
      const classes = new Set(L.rows.map((r) => r.classCode)), trainers = new Set(L.rows.map((r) => r.trainerCode));
      const t = state.meta.term;
      const termNote = L.meta.term && t && !new RegExp(`\\b${L.meta.term}\\b`).test(t.name) ? `<p class="warn-text">This workbook says Term ${esc(L.meta.term)} ${esc(L.meta.year)}, but the active term is ${esc(t.name)}.</p>` : '';
      out.innerHTML = `<div class="preview">
        <p><b>${esc(L.fileName)}</b>${L.meta.department ? ` · ${esc(L.meta.department)} department` : ''}${L.meta.term ? ` · Term ${esc(L.meta.term)} ${esc(L.meta.year)}` : ''}</p>
        ${termNote}
        <p>${L.rows.length} class units · ${classes.size} classes · ${trainers.size} trainers teaching · ${L.trainers.length} on the trainers list · ${L.rows.reduce((a, r) => a + r.hoursPerWeek, 0)} hours a week</p>
        <div class="table-wrap"><table class="report-table"><thead><tr><th>Class</th><th>Unit</th><th>Trainer</th><th class="num">Lessons/wk</th><th class="num">Hrs/wk</th></tr></thead>
        <tbody>${L.rows.slice(0, 6).map((r) => `<tr><td>${esc(r.classCode)}</td><td>${esc(r.unitCode)} — ${esc(r.unitName)}</td><td>${esc(r.trainerName)}</td><td class="num">${r.lessonsPerWeek}</td><td class="num">${r.hoursPerWeek}</td></tr>`).join('')}
        ${L.rows.length > 6 ? `<tr><td colspan="5" class="muted">…and ${L.rows.length - 6} more</td></tr>` : ''}</tbody></table></div>
        <button type="button" class="btn primary" id="uploadLoading" ${t ? '' : 'disabled'}>${t ? `Upload loading for ${esc(t.name)}` : 'Set up the term first'}</button></div>`;
    } catch (e) { out.innerHTML = `<p class="err-text">${esc(e.message)}</p>`; }
  }
  async function uploadLoading(btn) {
    if (!loadingPreview) return;
    busy(btn, true, 'Uploading…');
    try {
      const res = need(await api('uploadLoading', { rows: loadingPreview.rows, trainers: loadingPreview.trainers }));
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
      ${groups.size ? `<ul class="mlist">${[...groups.entries()].sort().map(([g, codes]) => `<li><button type="button" class="mrow" data-group="${esc(g)}">
        <span><b>${esc(g)}</b><small>${codes.map((c) => `${esc(c.split(' ').pop())} ${count(c)}`).join(' · ')}</small></span>
        <span class="pill synced">${codes.reduce((a, c) => a + count(c), 0)} students</span></button></li>`).join('')}</ul>` : ''}
      ${(() => {
        const empty = state.classes.filter((c) => state.units.some((u) => u.classCode === c.code) && !/[,/]/.test(c.code) && !count(c.code)).map((c) => c.code).sort();
        return empty.length ? `<details class="mdone"><summary>${empty.length} classes in the loading have no students yet</summary><p class="small">${empty.map(esc).join(' · ')}</p>
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
      const split = Object.entries(d.byStream).map(([s, n]) => `${esc(s.split(' ').pop())}: ${n}`).join(' · ');
      diff = `<div class="diff">
        <p class="d-add"><b>${d.added.length}</b> new student(s)${d.added.length ? ' → ' + Object.entries(d.added.reduce((m, a) => { m[a.classCode] = (m[a.classCode] || 0) + 1; return m; }, {})).map(([s, n]) => `${esc(s.split(' ').pop())} ${n}`).join(', ') : ''}</p>
        <p><b>${d.unchanged}</b> already on the list</p>
        ${d.confirmed.length ? `<p class="d-add"><b>${d.confirmed.length}</b> student(s) added by trainers are confirmed by this list</p>` : ''}
        ${d.moved.length ? `<p class="warn-text"><b>${d.moved.length}</b> moving from another class: ${d.moved.slice(0, 3).map((m) => `${esc(m.name)} (${esc(m.from)})`).join(', ')}${d.moved.length > 3 ? '…' : ''}</p>` : ''}
        ${d.renamed.length ? `<label class="check"><input type="checkbox" class="useNew" ${imp.useNewNames ? 'checked' : ''}>Use this list's spelling for ${d.renamed.length} name(s): ${d.renamed.slice(0, 2).map((r) => `${esc(r.old)} → ${esc(r.name)}`).join('; ')}${d.renamed.length > 2 ? '…' : ''}</label>` : ''}
        ${d.missing.length ? `<fieldset class="missing"><legend>${d.missing.length} on the app's list but not in this file. Tick anyone who has left:</legend>
          ${d.missing.map((m) => `<label class="check"><input type="checkbox" class="wd" value="${esc(m.admNo)}" ${imp.withdraw.includes(m.admNo) ? 'checked' : ''}>${esc(m.name)} <span class="tadm">${esc(m.admNo)} · ${esc(m.classCode)}</span></label>`).join('')}</fieldset>` : ''}
        ${placementHtml(imp)}
        <p class="muted small">After saving: ${split}</p></div>`;
    }
    return `<div class="card import" data-i="${i}">
      <div class="import-head"><b>${esc(imp.fileName)}</b><button type="button" class="btn small ghost" data-remove>Remove</button></div>
      <div class="grid2"><label>Class code (MIS)<input class="misCode" value="${esc(imp.misClass)}"></label><label>Duration<input value="${esc(imp.duration)}" disabled></label></div>
      <p class="muted small">${imp.students.length} students read · first: ${esc(imp.students[0].name)} (${esc(imp.students[0].admNo)})</p>
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
        <span class="pl-who"><b>${esc(p.name)}</b><small>${esc(p.admNo)}${p.isNew ? ' · new' : p.from && !imp.streams.includes(p.from) ? ` · now in ${esc(p.from)}` : ''}</small></span>
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
        const split = imp.streams.length > 1 ? ' — ' + Object.entries(res.byStream).map(([st, n]) => `${streamLabels(imp.streams)[st]} ${n}`).join(', ') : '';
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
      $('#adminDialogBody').innerHTML = `<div class="scan-head"><strong>${esc(group)} · ${list.filter((s) => s.status === 'active').length} students</strong><button type="button" class="btn small ghost" data-close>Close</button></div>
        <input type="search" id="grpSearch" placeholder="Search name or admission no." aria-label="Search students">
        <ul class="mlist students">${list.map((s) => `<li data-adm="${esc(s.admNo)}" data-q="${esc((s.name + ' ' + s.admNo).toLowerCase())}" class="${s.status !== 'active' ? 'gone' : ''}">
          <span><b>${esc(s.name)}</b><small>${esc(s.admNo)}${s.status !== 'active' ? ' · ' + esc(s.status) : ''}</small></span>
          <span class="st-actions"><select class="moveTo" aria-label="Stream for ${esc(s.name)}">${streams.map((c) => `<option ${c === s.classCode ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <button type="button" class="btn small ${s.status === 'active' ? 'danger' : ''}" data-status="${s.status === 'active' ? 'withdrawn' : 'active'}">${s.status === 'active' ? 'Withdraw' : 'Restore'}</button></span></li>`).join('')}</ul>`;
    } catch (e) { $('#adminDialogBody').insertAdjacentHTML('beforeend', `<p class="err-text">${esc(e.message)}</p>`); }
  }
  async function updateStudent(li, patch) {
    try {
      need(await api('updateStudent', { admNo: li.dataset.adm, ...patch }));
      toast(patch.classCode ? `Moved to ${patch.classCode}` : patch.status === 'withdrawn' ? 'Withdrawn from the class' : 'Back on the class list', 'ok');
      if (patch.status) { li.classList.toggle('gone', patch.status !== 'active'); const b = li.querySelector('[data-status]'); b.dataset.status = patch.status === 'active' ? 'withdrawn' : 'active'; b.textContent = patch.status === 'active' ? 'Withdraw' : 'Restore'; b.classList.toggle('danger', patch.status === 'active'); }
      pullRoster({ silent: true });
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------- MIS: staff ---------- */
  async function loadStaff() {
    if (!hasRole('MIS')) return;
    try {
      cache.staff = need(await api('staff')).staff.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
      const noPin = cache.staff.filter((s) => s.active && !s.hasPin).length;
      fill('m-staff', `${noPin ? `<p class="warn-text">${noPin} staff member(s) can't sign in yet. Tap Issue PIN and give them the PIN privately.</p>` : ''}
        <input type="search" id="staffSearch" placeholder="Search staff" aria-label="Search staff">
        <ul class="mlist staff">${cache.staff.map((s) => `<li data-code="${esc(s.code)}" data-q="${esc((s.name + ' ' + s.code).toLowerCase())}" class="${s.active ? '' : 'gone'}">
          <span><b>${esc(s.name)}</b><small>${esc(s.code)}${s.responsibility ? ' · ' + esc(s.responsibility) : ''} · ${s.hasPin ? (s.mustChange ? 'PIN issued, not used yet' : 'signed in before') : 'no PIN yet'}</small></span>
          <span class="roles">${['TRAINER', 'HOD', 'MIS'].map((r) => `<label class="rolechip"><input type="checkbox" value="${r}" ${s.roles.includes(r) ? 'checked' : ''}>${ROLE_LABEL[r]}</label>`).join('')}</span>
          <span class="st-actions"><button type="button" class="btn small" data-pin>${s.hasPin ? 'Reset PIN' : 'Issue PIN'}</button>
          <button type="button" class="btn small ${s.active ? 'danger' : ''}" data-active="${s.active ? '0' : '1'}">${s.active ? 'Switch off' : 'Switch on'}</button></span></li>`).join('')}</ul>
        <details class="mdone"><summary>Add a staff member</summary><form id="addStaff" class="grid2">
          <label>Staff code<input id="nsCode" required autocapitalize="characters" placeholder="ICT070"></label><label>Name<input id="nsName" required placeholder="ICT OTIENO .J"></label>
          <button class="btn primary">Add and issue PIN</button></form></details>`);
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

  /* ---------- MIS: one-time move from the Google Sheet ---------- */
  const MOVE_ORDER = ['Staff', 'Terms', 'Classes', 'Units', 'Loading', 'Trainees', 'Requests', 'Devices', 'CheckIns', 'SessionData', 'SignOffs', 'AuditLog'];
  const MOVE_LABEL = { Staff: 'staff', Terms: 'terms', Classes: 'classes', Units: 'units', Loading: 'loading rows', Trainees: 'students', Requests: 'added students',
    Devices: 'student phones', CheckIns: 'QR check-ins', SessionData: 'registers', SignOffs: 'sign-offs', AuditLog: 'history entries' };
  function moveHtml() {
    return `<details class="mdone"><summary>Only needed once, if you used the Google Sheet before</summary>
      <ol class="steps small">
        <li>Open the Google Sheet and paste the latest <code>apps-script/Code.gs</code> into Extensions › Apps Script, then save.</li>
        <li>Back in the Sheet, reload it and choose <b>Attendance › Export everything for the new database</b>. Allow access when Google asks.</li>
        <li>Download the export file it saved in your Google Drive, then choose it here.</li>
      </ol>
      <p class="muted small">Everything is copied: staff (their PINs keep working), terms, loading, class lists, registers, QR check-ins and sign-offs. Running it twice does no harm.</p>
      <label class="btn">Choose the export file<input type="file" id="sheetExport" accept=".json,application/json" hidden></label>
      <p id="moveStatus" class="muted small" aria-live="polite"></p></details>`;
  }
  async function importSheetFile(file) {
    const status = $('#moveStatus');
    let data;
    try { data = JSON.parse(await file.text()); } catch { data = null; }
    if (!data || data.format !== 'rvnp-sheet-export' || !data.tabs) { status.textContent = 'That is not an export file from the attendance Sheet.'; status.className = 'err-text small'; return; }
    status.className = 'muted small';
    const done = [];
    try {
      for (const tab of MOVE_ORDER) {
        const rows = (data.tabs[tab] || []).filter((r) => Object.values(r).some((v) => String(v).trim() !== ''));
        if (!rows.length) continue;
        const size = tab === 'SessionData' ? 15 : 200;
        let saved = 0;
        for (let i = 0; i < rows.length; i += size) {
          status.textContent = `Copying ${MOVE_LABEL[tab]}… ${Math.min(i + size, rows.length)} of ${rows.length}`;
          saved += need(await api('importSheet', { tab, rows: rows.slice(i, i + size) })).saved || 0;
        }
        done.push(`${saved} ${MOVE_LABEL[tab]}`);
      }
      status.textContent = 'Copied: ' + (done.join(', ') || 'nothing (the export was empty)') + '.';
      toast('Data from the Google Sheet is now in the new database', 'ok');
      pullRoster({ silent: true });
      loadRequests(); loadStaff();
    } catch (e) {
      status.textContent = `Stopped${done.length ? ' after ' + done.join(', ') : ''}: ${e.message}. Choose the file again to carry on.`;
      status.className = 'err-text small';
    }
  }

  /* ---------- MIS: the Google Drive bridge (attendance sheets per trainer, POE files) ---------- */
  async function loadDrive() {
    try {
      const { secret, report: r } = need(await api('driveStatus'));
      if (!r) {
        fill('m-drive', `<p class="muted">Not connected yet. Each trainer's attendance sheet and the students' POE files go to the college Google Drive through a small Apps Script in the school account. The README has the steps (about 10 minutes, once).</p>
          ${secret ? '' : '<p class="warn-text small">The database does not have the BRIDGE_SECRET setting yet (Cloudflare → the Worker → Settings → Variables).</p>'}`);
        return;
      }
      const opts = (sel) => `<option value="">Choose their folder…</option>${(r.folders || []).sort((a, b) => a.name.localeCompare(b.name)).map((f) => `<option value="${esc(f.id)}"${f.id === sel ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}`;
      const staff = new Map((cache.staff || []).map((x) => [lower(x.code), x]));
      // Students upload to this address. The school-only form (/a/macros/<domain>/) asks students to sign in, so uploads fail.
      const schoolOnly = /\/a\/macros\//.test(r.url || '');
      const noFolders = !(r.folders || []).length;
      fill('m-drive', `<p class="muted">Connected · last update ${esc(fmtShort(r.at))} · ${r.matched} trainer folder${r.matched === 1 ? '' : 's'} found${r.indexUrl ? ` · <a href="${esc(r.indexUrl)}" target="_blank" rel="noopener">POE evidence index</a>` : ''}</p>
        <div class="drive-test"><code class="drive-url">${esc(r.url || '')}</code> <button type="button" class="btn small" data-act="testBridge">Test connection</button> <span id="driveTest" class="muted small"></span></div>
        ${schoolOnly ? `<p class="err-text small">The bridge address is the school-only form, so students who are not signed in to the school account cannot send evidence. In Apps Script, deploy a new version of the web app with <b>Who has access: Anyone</b>, then run sync() once.</p>` : ''}
        ${noFolders ? '<p class="warn-text small">The Trainers folder in Drive has no folders inside it yet. Create one folder per trainer inside it, or paste each trainer\'s folder link below.</p>' : ''}
        ${(r.unmatched || []).length ? `<p><b>${r.unmatched.length} trainer${r.unmatched.length === 1 ? '' : 's'} without a folder.</b> Choose their folder, or paste its link. Their sheet is made after that.</p>
        <ul class="mlist drive-list">${r.unmatched.map((u) => `<li data-code="${esc(u.code)}"><span><b>${esc(u.name)}</b> <span class="muted small">${esc(u.code)}</span></span>
          <span class="drive-pick">${(r.folders || []).length ? `<select data-drivefolder aria-label="Drive folder for ${esc(u.name)}">${opts(staff.get(lower(u.code))?.driveFolder || '')}</select>` : ''}
          <input type="text" data-drivelink placeholder="or paste folder link" aria-label="Folder link for ${esc(u.name)}"></span></li>`).join('')}</ul>` : '<p>Every trainer with units has a folder and a sheet.</p>'}
        <p class="muted small">Sheets refresh about every 10 minutes from the registers that have reached the server.</p>`);
    } catch (e) { fill('m-drive', `<p class="err-text">${esc(e.message)}</p>`); }
  }
  /** Asks the bridge a question the way a phone does. A sign-in page or no answer shows here, not on a student's phone. */
  async function testBridge(btn) {
    const out = $('#driveTest'); const url = $('.drive-url')?.textContent || '';
    if (!url) { out.textContent = 'No bridge address yet.'; return; }
    btn.disabled = true; out.textContent = 'Testing…';
    try {
      const res = await fetch(url, { redirect: 'follow' });
      let j = null; try { j = await res.json(); } catch { /* not JSON */ }
      out.innerHTML = j && j.ok ? '<b class="ok-text">Reachable — students can send evidence.</b>'
        : '<b class="err-text">It asks for a sign-in. Redeploy the web app with Who has access: Anyone, then run sync().</b>';
    } catch (e) {
      out.innerHTML = '<b class="err-text">No answer from this address. Check it in Apps Script → Deploy → Manage deployments.</b>';
    } finally { btn.disabled = false; }
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
  function refreshBadge() {
    const dot = $('#manageCount'); if (!dot) return;
    let n = 0;
    if (hasRole('MIS')) n += (state.meta.pending || []).length;
    if (hasRole('HOD')) n += cache.signoffs.filter((s) => s.status === 'submitted').length;
    dot.hidden = !n;
    dot.textContent = n > 9 ? '9+' : String(n);
  }

  /* ---------- events (delegated, the sections are re-rendered often) ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('#adminDialog [data-close]')) { closeDialog(); return; }
    if (!t.closest('#manage, #adminDialog')) return;
    const open = t.closest('[data-open]'); if (open) { openReport(open.dataset.open); return; }
    const tb = t.closest('[data-act="testBridge"]'); if (tb) { testBridge(tb); return; }
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
    const st = t.closest('.students [data-status]'); if (st) { updateStudent(st.closest('li'), { status: st.dataset.status }); return; }
    const pin = t.closest('.staff [data-pin]');
    if (pin) { const li = pin.closest('li'); if (confirm(`Issue a new PIN for ${li.querySelector('b').textContent}? Their old PIN stops working.`)) staffAction(li, { resetPin: true }); return; }
    const act = t.closest('.staff [data-active]');
    if (act) { const li = act.closest('li'); staffAction(li, { active: act.dataset.active === '1' }, act.dataset.active === '1' ? 'Switched on' : 'Switched off — they are signed out everywhere'); return; }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'loadingFile' && t.files[0]) { readLoading(t.files[0]); t.value = ''; }
    if (t.id === 'classFiles' && t.files.length) { addClassFiles([...t.files]); t.value = ''; }
    if (t.id === 'sheetExport' && t.files[0]) { importSheetFile(t.files[0]); t.value = ''; }
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
    if (t.id === 'grpSearch' || t.id === 'staffSearch') {
      const q = t.value.trim().toLowerCase();
      const list = t.id === 'grpSearch' ? $$('#adminDialog .students li') : $$('#m-staff .staff li');
      list.forEach((li) => { li.hidden = q && !li.dataset.q.includes(q); });
    }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'termForm') saveTerm(e);
    if (e.target.id === 'addStaff') {
      e.preventDefault();
      staffAction(null, { code: $('#nsCode').value.trim(), name: $('#nsName').value.trim(), roles: ['TRAINER'], resetPin: true });
    }
  });

  return { render, refreshBadge };
})();
window.Admin = Admin;
