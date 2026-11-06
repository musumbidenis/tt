/* Summative practicals — moderated practical marks per unit of competency (TVET CDACC).
 * MIS/HOD: register candidates for a unit's summative practical via a dedicated Excel upload (separate from
 * the normal class-list import). Trainers select a unit and enter the internal assessor's mark; external
 * verifiers enter sampled external marks; HOD/MIS/IAO set moderated marks with sign-off. Reports produce the
 * TVET CDACC moderated practical marks sheets (all units; per unit of competency).
 * Uses app.js (state, api, $, $$, esc, toast, hasRole, me, download, todayISO, fileSafe) and Tables, Xlsx, HtmlPdf. */
'use strict';

const SummativePracticals = (() => {
  const sp = { step: 'upload', cls: '', unit: '', res: null, preview: [] };
  const allowed = () => hasRole('MIS') || hasRole('HOD') || hasRole('IAO') || hasRole('TRAINER');
  const canUpload = () => hasRole('MIS') || hasRole('HOD');
  const canEnter = () => hasRole('TRAINER') || hasRole('HOD');
  const canVerify = () => hasRole('EAO');
  const canModerate = () => hasRole('HOD') || hasRole('MIS') || hasRole('IAO');

  const classes = () => [...new Set(state.units.map((u) => u.classCode))].sort();
  const unitsOf = (cls) => state.units.filter((u) => u.classCode === cls).sort((a, b) => a.name.localeCompare(b.name));
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const SP_MARK = /^\d{1,3}$/;
  const spParse = (v) => {
    const t = String(v ?? '').trim();
    if (t === '') return { ok: true, value: null };
    const n = SP_MARK.test(t) ? Number(t) : NaN;
    return n >= 0 && n <= 100 ? { ok: true, value: n } : { ok: false };
  };
  const okOrThrow = (r) => { if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'The server refused that'); return r; };

  /* ---------- dedicated candidate upload ---------- */
  const hdrGuess = (h, wanted) => wanted.some((w) => norm(h).includes(w));
  function uploadHtml() {
    return `<p class="muted small">Register candidates for a unit's summative practical from an Excel file (separate from the normal class-list import). Columns: admission no., name, class, unit code, and optionally the CDACC registration code. Nothing is saved until you confirm.</p>
      <div class="sp-upload">
        <label class="btn file-btn"><svg class="i" aria-hidden="true"><use href="#i-upload"/></svg>Choose Excel file<input type="file" id="spFile" accept=".xlsx,.xlsm,.csv"></label>
        <div id="spOut"></div>
      </div>`;
  }
  async function readFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'csv') {
      const text = await file.text();
      const rows = text.split(/\r?\n/).map((l) => l.split(',').map((c) => c.replace(/^"|"$/g, '').trim()));
      return { head: rows[0] || [], rows: rows.slice(1) };
    }
    const wb = await Xlsx.open(await file.arrayBuffer());
    const rows = await wb.rows(wb.names[0]);
    return { head: rows[0] || [], rows: rows.slice(1) };
  }
  function colIndex(head, wanted) {
    for (let i = 0; i < head.length; i++) if (hdrGuess(head[i], wanted)) return i;
    return -1;
  }
  function previewHtml(rows) {
    const take = rows.slice(0, 12);
    return `<p class="muted small">${rows.length} candidate row(s) found. Review before saving.</p>
      <div class="table-wrap"><table class="report-table"><thead><tr><th>#</th><th>Admission no.</th><th>Name</th><th>Class</th><th>Unit code</th><th>CDACC reg code</th></tr></thead>
      <tbody>${take.map((r, i) => `<tr><td>${i + 1}</td><td class="tadm">${esc(r.admNo)}</td><td>${esc(r.name)}</td><td>${esc(r.classCode)}</td><td>${esc(r.unitCode)}</td><td>${esc(r.regCode)}</td></tr>`).join('')}
      ${rows.length > 12 ? `<tr><td colspan="6" class="muted small">…and ${rows.length - 12} more row(s)</td></tr>` : ''}</tbody></table></div>
      <div class="row-actions"><button type="button" class="btn primary" id="spConfirm">Register ${rows.length} candidate(s)</button>
        <button type="button" class="btn" id="spCancel">Cancel</button></div>`;
  }
  async function confirmUpload() {
    if (!sp.preview.length) return;
    const btn = $('#spConfirm'); btn.disabled = true;
    try {
      const res = okOrThrow(await api('spUpload', { rows: sp.preview }));
      toast(`${res.registered} candidate(s) registered for summative practicals${res.added ? ` (${res.added} new)` : ''}`, 'ok');
      sp.preview = []; sp.res = null; $('#spOut').innerHTML = '';
      $('#spFile').value = '';
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; }
  }

  /* ---------- marks: load one class + unit ---------- */
  async function loadMarks(cls, unit) {
    const res = okOrThrow(await api('summativePracticals', { classCode: cls, unitCode: unit }));
    sp.res = res;
  }
  const markLabel = (kind) => kind === 'internal' ? 'Internal assessor (100%)' : kind === 'external' ? 'External verifier (sampled, 100%)' : 'Moderated (100%)';
  function cellInput(kind, adm, value, edit) {
    const v = value === null || value === undefined ? '' : String(Math.round(value));
    return `<input class="spmk spmk-${kind}" inputmode="numeric" autocomplete="off" data-kind="${kind}" data-adm="${esc(adm)}" value="${esc(v)}"${edit ? '' : ' readonly'}>`;
  }
  function marksTableHtml() {
    const { students } = sp.res || { students: [] };
    const edit = canEnter();
    if (!students.length) return '<p class="empty">No candidates registered for this unit yet. Use the upload above to register them.</p>';
    return `<div class="table-wrap"><table class="report-table sp-table"><thead><tr><th>S/N</th><th>Admission no.</th><th>Candidate's Name</th><th class="num">CDACC Reg Code</th><th class="num">${markLabel('internal')}</th>${canVerify() ? `<th class="num">${markLabel('external')}</th>` : ''}${canModerate() ? `<th class="num">${markLabel('moderated')}</th>` : ''}<th class="num">Status</th></tr></thead>
      <tbody>${students.map((s, i) => `<tr data-adm="${esc(s.admNo)}"><td>${i + 1}</td><td class="tadm">${esc(s.admNo)}</td><td><b>${esc(s.name)}</b></td><td class="num">${esc(s.regCode)}</td>
        <td>${cellInput('internal', s.admNo, s.internalMark, edit)}</td>
        ${canVerify() ? `<td>${cellInput('external', s.admNo, s.externalMark, canVerify())}</td>` : ''}
        ${canModerate() ? `<td>${cellInput('moderated', s.admNo, s.moderatedMark, canModerate())}</td>` : ''}
        <td><span class="pill ${s.status === 'moderated' ? 'synced' : s.status === 'submitted' || s.status === 'verified' ? 'pending' : 'rejected'}">${esc(s.status || 'draft')}</span></td></tr>`).join('')}</tbody></table></div>
      <div class="row-actions"><button type="button" class="btn primary" id="spSave">Save marks</button></div>`;
  }

  /* ---------- reports ---------- */
  async function reportAllUnits() {
    const cls = sp.cls;
    if (!cls) { toast('Choose a class', 'err'); return; }
    const res = okOrThrow(await api('spReportAllUnits', { classCode: cls }));
    const unitCols = res.units.map((u) => u.code);
    const head = ['S/N', 'Admission no.', "Candidate's Name", 'CDACC Reg Code', ...unitCols.map((_, j) => `${j + 1}`)];
    const rows = res.students.map((s, i) => [i + 1, s.admNo, s.name, s.regCode, ...unitCols.map((c) => { const m = s[c]; return m && m.moderated !== null ? m.moderated : ''; })]);
    const title = `Summative Practical - All Units - ${fileSafe(cls)}`;
    const blob = await Xlsx.simple(title, head, rows);
    download(`${title}_${todayISO()}.xlsx`, blob);
    const units = res.units.map((u, j) => `${j + 1}. ${esc(u.code)} - ${esc(u.name)}`).join('; ');
    const html = `<div class="tbl-print sp-print"><div class="rp-head"><img src="icons/rvnp-logo.png" alt=""><div class="rp-title">
      <h1>RIFT VALLEY NATIONAL POLYTECHNIC</h1><h2>DEPARTMENT OF COMPUTING AND INFORMATICS</h2>
      <h2>SUMMATIVE ASSESSMENT MODERATED PRACTICAL MARKS SHEETS FOR ALL UNITS</h2>
      <table class="rp-fields"><tr><th>CLASS</th><td>${esc(res.classCode)}</td></tr></table>
      <p class="key"><b>KEY:</b> ${units}</p></div></div>
      <table><thead><tr><th>S/N</th><th>Admission no.</th><th>Candidate's Name</th><th>CDACC Reg Code</th>${res.units.map((u, j) => `<th class="num">${j + 1}</th>`).join('')}</tr></thead>
      <tbody>${res.students.map((s, i) => `<tr><td>${i + 1}</td><td class="tadm">${esc(s.admNo)}</td><td>${esc(s.name)}</td><td>${esc(s.regCode)}</td>${res.units.map((u) => { const m = s[u.code]; return `<td class="num">${m && m.moderated !== null ? m.moderated : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
    const pdf = await HtmlPdf.make(html, { landscape: true });
    download(`Summative Practical - All Units - ${fileSafe(res.classCode)}_${todayISO()}.pdf`, pdf);
    toast('Excel + PDF marksheet saved', 'ok');
  }
  async function reportPerUnit() {
    const cls = sp.cls, unit = sp.unit;
    if (!cls || !unit) { toast('Choose the class and unit', 'err'); return; }
    const res = okOrThrow(await api('spReportPerUnit', { classCode: cls, unitCode: unit }));
    const head = ['S/N', 'Admission no.', "Candidate's Name", 'CDACC Reg Code', 'Internal Assessor (100%)', 'External Verifier (sampled, 100%)', 'Moderated Marks (100%)'];
    const rows = res.students.map((s, i) => [i + 1, s.admNo, s.name, s.regCode, s.internalMark ?? '', s.externalMark ?? '', s.moderatedMark ?? '']);
    const title = `Summative Practical - ${fileSafe(unit)} - ${fileSafe(cls)}`;
    const blob = await Xlsx.simple(title, head, rows);
    download(`${title}_${todayISO()}.xlsx`, blob);
    const html = `<div class="tbl-print sp-print"><div class="rp-head"><img src="icons/rvnp-logo.png" alt=""><div class="rp-title">
      <h1>RIFT VALLEY NATIONAL POLYTECHNIC</h1><h2>DEPARTMENT OF COMPUTING AND INFORMATICS</h2>
      <h2>SUMMATIVE ASSESSMENT MODERATED PRACTICAL MARKS SHEETS PER UNIT OF COMPETENCY</h2>
      <table class="rp-fields"><tr><th>Course Code:</th><td>${esc(cls)}</td><th>Unit Code:</th><td>${esc(unit)}</td></tr>
      <tr><th>Unit Title:</th><td colspan="3">${esc(res.unitCode)}</td></tr></table></div></div>
      <table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <table class="sign-lines"><tr><th>Name of Internal Assessor</th><td></td><th>Reg. Code/ID No.</th><td></td><th>Signature</th><td class="sig"></td><th>Date</th><td></td></tr>
      <tr><th>Name of External Verifier</th><td></td><th>Reg. Code/ID No.</th><td></td><th>Signature</th><td class="sig"></td><th>Date</th><td></td></tr>
      <tr><th>Name of Assessment Center Manager/Officer</th><td></td><th></th><td></td><th>Signature</th><td class="sig"></td><th>Date</th><td><span class="stamp">Institutional stamp</span></td></tr></table></div>`;
    const pdf = await HtmlPdf.make(html, { landscape: true });
    download(`Summative Practical - ${fileSafe(unit)} - ${fileSafe(cls)}_${todayISO()}.pdf`, pdf);
    toast('Excel + PDF marksheet saved', 'ok');
  }

  /* ---------- step navigation ---------- */
  function stepButtons() {
    const b = [];
    if (canUpload()) b.push(`<button type="button" class="btn ${sp.step === 'upload' ? 'primary' : ''}" id="spGoUpload">Register candidates (upload)</button>`);
    if (canEnter()) b.push(`<button type="button" class="btn ${sp.step === 'enter' ? 'primary' : ''}" id="spGoEnter">Enter internal marks</button>`);
    if (canVerify()) b.push(`<button type="button" class="btn ${sp.step === 'verify' ? 'primary' : ''}" id="spGoVerify">External verification</button>`);
    if (canModerate()) b.push(`<button type="button" class="btn ${sp.step === 'moderate' ? 'primary' : ''}" id="spGoModerate">Moderate marks</button>`);
    if (canUpload() || canModerate()) b.push(`<button type="button" class="btn ${sp.step === 'report' ? 'primary' : ''}" id="spGoReport">Reports</button>`);
    return b.join('') || '<span class="muted small">No role permitted any summative-practicals action.</span>';
  }

  function classUnitPickerHtml(show) {
    if (!show) return '';
    return `<div class="sp-pick"><label class="small">Class <select id="spClass">${classes().map((c) => `<option value="${esc(c)}"${c === sp.cls ? ' selected' : ''}>${esc(c)}</option>`).join('') || '<option value="">No classes</option>'}</select></label>
      <label class="small">Unit <select id="spUnit">${unitsOf(sp.cls).map((u) => `<option value="${esc(u.code)}"${u.code === sp.unit ? ' selected' : ''}>${esc(u.code)} - ${esc(u.name)}</option>`).join('')}</select></label>
      <button type="button" class="btn primary" id="spLoad">Load</button></div>`;
  }
  function reportButtonsHtml() {
    return `<div class="row-actions"><button type="button" class="btn primary" id="spReportAll">All units (Excel + PDF)</button>
      <button type="button" class="btn" id="spReportUnit">This unit (Excel + PDF)</button></div>`;
  }

  /* ---------- save marks ---------- */
  async function saveMarks(btn) {
    if (!sp.res || !sp.res.students.length) return;
    btn.disabled = true;
    try {
      const kind = sp.step === 'verify' ? 'external' : sp.step === 'moderate' ? 'moderated' : 'internal';
      const acts = [];
      for (const inp of $$('#spCard input.spmk-' + kind)) {
        const p = spParse(inp.value);
        if (!p.ok) { toast('Marks must be whole numbers from 0 to 100', 'err'); btn.disabled = false; return; }
        const adm = inp.dataset.adm;
        const body = { classCode: sp.cls, unitCode: sp.unit, admNo: adm };
        if (kind === 'internal') body.internalMark = p.value;
        else if (kind === 'external') body.externalMark = p.value;
        else body.moderatedMark = p.value;
        acts.push(kind === 'internal' ? api('spEnter', body) : kind === 'external' ? api('spVerify', body) : api('spModerate', body));
      }
      await Promise.all(acts);
      toast('Marks saved', 'ok');
      await loadMarks(sp.cls, sp.unit);
      $('#spCard').innerHTML = html();
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; }
  }

  function wire() {
    document.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.id === 'spFile' && t.files.length) {
        try {
          const { head, rows } = await readFile(t.files[0]);
          const ci = (w) => colIndex(head, w);
          const a = ci(['admission', 'adm']), n = ci(['name']), c = ci(['class', 'cls']), u = ci(['unit']), r = ci(['reg', 'regcode', 'reg code']);
          if (a === -1 || n === -1 || c === -1 || u === -1) throw new Error('The file needs Admission no., Name, Class and Unit code columns');
          sp.preview = rows.map((row) => ({ admNo: row[a] || '', name: row[n] || '', classCode: row[c] || '', unitCode: row[u] || '', regCode: r === -1 ? '' : row[r] || '' })).filter((x) => x.admNo && x.name && x.classCode && x.unitCode);
          if (!sp.preview.length) throw new Error('No valid candidate rows found');
          $('#spOut').innerHTML = previewHtml(sp.preview);
        } catch (e) { toast(e.message, 'err'); $('#spOut').innerHTML = ''; }
        t.value = '';
      }
      if (t.id === 'spClass') { sp.cls = t.value; sp.unit = ''; sp.res = null; }
      if (t.id === 'spUnit') { sp.unit = t.value; sp.res = null; }
    });
    document.addEventListener('click', async (e) => {
      const card = $('#spCard');
      if (!card || !e.target.closest(card)) return;
      const b = e.target.closest('button[id]');
      if (!b) return;
      const t = b;
      if (t.id === 'spGoUpload') { sp.step = 'upload'; sp.res = null; card.innerHTML = html(); return; }
      if (t.id === 'spGoEnter' && canEnter()) { sp.step = 'enter'; sp.res = null; card.innerHTML = html(); return; }
      if (t.id === 'spGoVerify' && canVerify()) { sp.step = 'verify'; sp.res = null; card.innerHTML = html(); return; }
      if (t.id === 'spGoModerate' && canModerate()) { sp.step = 'moderate'; sp.res = null; card.innerHTML = html(); return; }
      if (t.id === 'spGoReport') { sp.step = 'report'; sp.res = null; card.innerHTML = html(); return; }
      if (t.id === 'spLoad') { sp.cls = $('#spClass').value; sp.unit = $('#spUnit').value; if (!sp.cls || !sp.unit) { toast('Choose the class and unit', 'err'); return; } try { await loadMarks(sp.cls, sp.unit); card.innerHTML = html(); } catch (e) { toast(e.message, 'err'); } return; }
      if (t.id === 'spConfirm') { await confirmUpload(); return; }
      if (t.id === 'spCancel') { sp.preview = []; $('#spOut').innerHTML = ''; return; }
      if (t.id === 'spSave') { await saveMarks(t); return; }
      if (t.id === 'spReportAll') { await reportAllUnits(); return; }
      if (t.id === 'spReportUnit') { await reportPerUnit(); return; }
    });
    document.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('#spCard input.spmk')) { t.classList.toggle('bad', !spParse(t.value).ok); }
    });
  }
  wire();
  return { html, allowed };
})();
window.SummativePracticals = SummativePracticals;
