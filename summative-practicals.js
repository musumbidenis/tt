/* Summative practicals - TVET CDACC moderated practical marks (the Practicals tab).
 * Candidates (MIS Officer, HOD): upload the CDACC nominal roll - its own upload, separate from the class lists, which it
 *   never changes - tick the courses to keep and fill each course's sheet heading.
 * Marks: anyone signed in as a trainer, a guest (an account with an end date, for people outside the staff) or an external
 *   officer types in the internal assessor's and the external verifier's marks of any unit; they save by themselves as they
 *   are typed. Whoever saves the internal marks is the Internal Assessor named on the sheet; the External Verifier lines are
 *   always left blank (signed by hand).
 *   The moderated marks are worked out by the server, CDACC style, and cannot be typed: the verifier's sample must be at
 *   least 10% of the candidates assessed; mean deviation = sum of (external - internal) over the sample / the number
 *   sampled; within +/-5 the internal marks stand, beyond it every mark moves by the mean deviation. The screen and the
 *   per-unit sheet show the formula and the workings.
 * Sheets: the two CDACC forms (CBA/SAMSP/2) - all units of a course, and per unit of competency - as PDF and Excel,
 *   made on this device.
 * Uses app.js (state, api, $, $$, esc, toast, hasRole, me, download, fileSafe, todayISO) and Xlsx, HtmlPdf. */
'use strict';

const SummativePracticals = (() => {
  const sp = {
    view: 'marks', data: null, courseId: '', unitCode: '', marks: null, edits: new Map(),
    roll: null, pick: new Set(), find: '', open: new Set(), sheetUnits: null, sheetUnit: '', busy: false,
  };
  const allowed = () => ['MIS', 'HOD', 'IAO', 'TRAINER', 'EAO', 'GUEST'].some(hasRole);
  const uploader = () => hasRole('MIS') || hasRole('HOD');
  const office = () => hasRole('MIS') || hasRole('HOD') || hasRole('IAO');
  const enters = () => ['TRAINER', 'HOD', 'EAO', 'GUEST'].some(hasRole);
  const need = (r) => { if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'The server refused that'); return r; };
  const box = () => $('#sumprac');
  const lc = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const course = () => sp.data?.courses.find((c) => c.id === sp.courseId) || null;
  const unitOf = (c, code) => c?.units.find((u) => u.code === code) || null;
  const KINDS = ['internal', 'external'];
  const shortLevel = (l) => String(l || '').replace(/^level\s*/i, 'L');
  const courseLabel = (c) => `${c.course} ${shortLevel(c.level)}${c.series ? ' - ' + c.series : ''}`.trim();
  const unitLabel = (u) => `${u.seq}. ${u.name} - ${u.code} (${u.moderated}/${u.candidates})`;
  const markOk = (v) => { const t = String(v ?? '').trim(); return t === '' || (/^\d{1,3}$/.test(t) && Number(t) <= 100); };
  const markNum = (v) => { const t = String(v ?? '').trim(); return t === '' ? null : Number(t); };
  const splitKey = (k) => { const i = k.indexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };
  const val = (kind, c) => { const k = kind + '|' + c.regNo; return sp.edits.has(k) && markOk(sp.edits.get(k)) ? markNum(sp.edits.get(k)) : c[kind]; };
  const candOf = (reg) => sp.marks?.candidates.find((x) => x.regNo === reg) || null;
  /** Typed marks that differ from the saved ones and are valid, by column; and how many typed ones are not valid. */
  function changes() {
    const out = {};
    let bad = 0;
    for (const [k, v] of sp.edits) {
      const [kind, reg] = splitKey(k), c = candOf(reg);
      if (!c || !KINDS.includes(kind)) continue;
      if (!markOk(v)) { bad++; continue; }
      if (markNum(v) !== c[kind]) (out[kind] = out[kind] || []).push({ regNo: reg, mark: v });
    }
    return { out, bad, n: Object.values(out).reduce((t, l) => t + l.length, 0) };
  }

  /* ---------- loading and drawing ---------- */
  async function loadCourses() {
    sp.data = need(await api('spCourses'));
    if (!course()) { sp.courseId = sp.data.courses[0]?.id || ''; sp.unitCode = ''; sp.marks = null; sp.sheetUnits = null; }
    const c = course();
    if (sp.unitCode && !unitOf(c, sp.unitCode)) { sp.unitCode = ''; sp.marks = null; }
    if (!sp.unitCode && c?.units.length && sp.view === 'marks') sp.unitCode = c.units[0].code;
  }
  async function loadMarks() {
    sp.marks = null; sp.edits.clear();
    if (!sp.courseId || !sp.unitCode) return;
    setMarks(need(await api('spMarks', { courseId: sp.courseId, unitCode: sp.unitCode })));
  }
  /** A fresh copy of a unit from the server: keep it, and its counts in the course list. */
  function setMarks(res) {
    sp.marks = res; sp.edits.clear();
    keepUnit(res.unit);
  }
  function keepUnit(u) { const c = course(), i = c ? c.units.findIndex((x) => x.code === u.code) : -1; if (i >= 0) c.units[i] = u; }
  async function render() {
    const el = box();
    if (!el) return;
    if (!allowed()) { el.innerHTML = ''; return; }
    if (!navigator.onLine) { el.innerHTML = '<div class="card notice"><h2>Practicals need internet</h2><p>Marks and sheets come straight from the server.</p></div>'; return; }
    if (!sp.data) el.innerHTML = '<div class="card"><p class="muted">Loading summative practicals…</p></div>';
    try {
      await loadCourses();
      if (sp.view === 'marks' && sp.unitCode && !changes().n && !saving) await loadMarks();
    } catch (e) {
      el.innerHTML = `<div class="card"><p class="err-text">${esc(e.message)}</p><button type="button" class="btn" data-sp="reload">Try again</button></div>`;
      return;
    }
    draw();
  }
  function draw() {
    const el = box();
    if (!el || !sp.data) return;
    const body = sp.view === 'roll' && office() ? rollHtml() : sp.view === 'sheets' ? sheetsHtml() : marksHtml();
    el.innerHTML = `<div class="sp">${viewTabs()}${body}</div>`;
  }
  function viewTabs() {
    const tabs = [['marks', 'Marks'], ...(office() ? [['roll', 'Candidates']] : []), ['sheets', 'Sheets']];
    return `<div class="view-tabs" role="group" aria-label="View">${tabs.map(([k, l]) => `<button type="button" data-spview="${k}" aria-pressed="${sp.view === k}">${l}</button>`).join('')}</div>`;
  }
  function emptyHtml() {
    const why = uploader() ? 'Upload the CDACC nominal roll under Candidates.' : 'The MIS Officer or HOD uploads the CDACC nominal roll first.';
    return `<div class="empty-state"><svg class="i" aria-hidden="true"><use href="#i-chart"/></svg><b>No courses yet</b><span>${why}</span></div>`;
  }
  function pickers(withUnit) {
    const c = course();
    return `<div class="sp-pick"><label>Course<select id="spCourse">${sp.data.courses.map((x) => `<option value="${esc(x.id)}"${x.id === sp.courseId ? ' selected' : ''}>${esc(courseLabel(x))}</option>`).join('')}</select></label>
      ${withUnit ? `<label>Unit<select id="spUnit"><option value="">Choose a unit</option>${(c?.units || []).map((u) => `<option value="${esc(u.code)}"${u.code === sp.unitCode ? ' selected' : ''}>${esc(unitLabel(u))}</option>`).join('')}</select></label>` : ''}</div>`;
  }

  /* ---------- CDACC moderation: the same rules as the server (spModeration in worker.js) ---------- */
  const SAMPLE_DIV = 10, TOLERANCE = 5;
  const signed = (v) => { const r = Math.round(v * 100) / 100; return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r); };
  const md2 = (v) => { const r = Math.round(v * 100) / 100; return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(2); };
  /** From the sampled candidates' marks ([internal, external] pairs): the terms, their sum and the mean deviation. */
  function deviation(pairs) {
    const terms = pairs.map(([i, x]) => x - i), sum = terms.reduce((t, d) => t + d, 0);
    return { pairs, terms, sum, n: terms.length, md: terms.length ? Math.round((sum / terms.length) * 100) / 100 : null };
  }
  function moderation(list, get) {
    const assessed = list.filter((c) => get('internal', c) !== null), both = assessed.filter((c) => get('external', c) !== null);
    const needN = assessed.length ? Math.max(1, Math.ceil(assessed.length / SAMPLE_DIV)) : 0;
    const d = deviation(both.map((c) => [get('internal', c), get('external', c)]));
    const ready = assessed.length > 0 && both.length >= needN;
    return { ...d, assessed: assessed.length, need: needN, sampled: both.length, ready, adjust: ready && Math.abs(d.md) > TOLERANCE ? d.md : 0 };
  }
  const modOf = (c, m) => (m.ready && val('internal', c) !== null ? Math.max(0, Math.min(100, Math.round(val('internal', c) + m.adjust))) : null);
  /** "(64 − 60) + (80 − 70) = (+4) + (+10) = +14; +14 ÷ 2 = +7.00" */
  const workText = (m) => `${m.pairs.map(([i, x]) => `(${x} − ${i})`).join(' + ')} = ${m.terms.map((t) => `(${signed(t)})`).join(' + ')} = ${signed(m.sum)}; ${signed(m.sum)} ÷ ${m.n} = ${md2(m.md)}`;
  const decisionText = (m) => (!m.ready ? `The moderated marks appear once the external verifier’s marks are in for at least ${m.need} candidate${m.need === 1 ? '' : 's'}.`
    : m.adjust ? `${md2(m.md)} is more than ±${TOLERANCE}, so each moderated mark = internal mark ${m.adjust > 0 ? '+' : '−'} ${Math.abs(m.adjust).toFixed(2)}, rounded to a whole number (0 to 100).`
      : `${md2(m.md)} is within ±${TOLERANCE}, so the moderated marks are the internal assessor’s marks.`);
  function modHtml(m) {
    if (!m.assessed) return '<p><b>Mean deviation</b> = Σ (External − Internal) ÷ number of sampled candidates</p><p class="muted">Enter the internal assessor’s marks first.</p>';
    return `<p><b>Mean deviation</b> = Σ (External − Internal) ÷ number of sampled candidates</p>
      <p>Sample: <b>${m.sampled}</b> of the ${m.assessed} candidate${m.assessed === 1 ? '' : 's'} assessed - CDACC needs at least 10%, here ${m.need}.</p>
      ${m.n ? `<p>Workings: ${workText(m)}</p>` : '<p class="muted">Workings: no external marks yet.</p>'}
      <p>Decision: ${decisionText(m)}</p>`;
  }

  /* ---------- marks ---------- */
  function cell(kind, c, edit) {
    const k = kind + '|' + c.regNo, raw = sp.edits.has(k) ? sp.edits.get(k) : (c[kind] ?? '');
    if (!edit) return `<td class="mkc">${c[kind] ?? '<span class="muted">-</span>'}</td>`;
    const changed = sp.edits.has(k) && markOk(raw) && markNum(raw) !== c[kind];
    return `<td class="mkc"><input class="spmk${markOk(raw) ? '' : ' bad'}${changed ? ' changed' : ''}" inputmode="numeric" maxlength="3" autocomplete="off" data-kind="${kind}" data-reg="${esc(c.regNo)}" value="${esc(raw)}" aria-label="${kind} mark for ${esc(c.name)}"></td>`;
  }
  const devCell = (c) => { const i = val('internal', c), x = val('external', c); if (i === null || x === null) return ''; const d = x - i; return `<span class="sp-dev ${d < 0 ? 'neg' : d > 0 ? 'pos' : ''}">${signed(d)}</span>`; };
  const modCell = (c, m) => { const v = modOf(c, m); return v === null ? '<span class="muted">-</span>' : `<b>${v}</b>`; };
  function marksHtml() {
    if (!sp.data.courses.length) return emptyHtml();
    let out = `<section class="card">${pickers(true)}`;
    if (!sp.unitCode) return out + '<p class="muted">Choose a unit to enter or see its marks.</p></section>';
    const m = sp.marks;
    if (!m) return out + '<p class="muted">Loading the unit…</p></section>';
    const u = m.unit, edit = enters(), mod = moderation(m.candidates, val);
    out += `<div class="sp-unit-head"><div><b>${esc(u.name)}</b> <span class="muted small">${esc(u.code)}</span>
        <div class="small muted">Internal assessor on the sheet: ${esc(u.assessorName || 'not yet')} - ${u.candidates} candidates</div></div>
      ${edit ? `<span class="sp-save small" id="spSave" role="status">${saveText()}</span>` : ''}</div>`;
    if (!m.candidates.length) return out + '<p class="empty">No candidates for this unit on the roll.</p></section>';
    if (!edit) out += '<p class="small muted">You can see this unit’s marks. Trainers, guests and external officers enter them.</p>';
    out += `<div class="table-wrap"><table class="report-table sp-table"><thead><tr><th>S/N</th><th class="sp-reg">Reg No</th><th>Name</th>
        <th class="mkc">Internal</th><th class="mkc">External</th><th class="mkc sp-devc">Deviation</th><th class="mkc">Moderated</th></tr></thead>
      <tbody>${m.candidates.map((c, i) => `<tr><td>${i + 1}</td><td class="tadm sp-reg">${esc(c.regNo)}</td><td class="sp-who">${esc(c.name)}<span class="adm sp-reg-m">${esc(c.regNo)}</span>${c.admNo ? `<span class="adm">${esc(c.admNo)}</span>` : ''}</td>
        ${cell('internal', c, edit)}${cell('external', c, edit)}<td class="mkc sp-devc" data-dev="${esc(c.regNo)}">${devCell(c)}</td><td class="mkc sp-modc" data-mod="${esc(c.regNo)}">${modCell(c, mod)}</td></tr>`).join('')}</tbody></table></div>
      <div class="sp-mdbox" id="spMd">${modHtml(mod)}</div>
      <div class="row-actions">
        <button type="button" class="btn ghost" data-sp="unit-pdf">Sheet - PDF</button>
        <button type="button" class="btn ghost" data-sp="unit-xlsx">Sheet - Excel</button>
      </div>
      ${signHtml(m)}</section>`;
    return out;
  }
  function signHtml(m) {
    const u = m.unit, ok = enters() || office();
    const f = (id, label, v, can, ph = '') => `<label>${label}<input id="${id}" value="${esc(v)}"${can ? '' : ' readonly'}${ph ? ` placeholder="${esc(ph)}"` : ''}></label>`;
    return `<details class="fold" data-sec="sp-sign"${sp.open.has('sp-sign') ? ' open' : ''}><summary>Sign-off details on the sheet</summary>
      <div class="grid2">
        ${f('spAName', 'Internal assessor', u.assessorName, false, 'Whoever types in the marks')}
        ${f('spAReg', 'Assessor Reg. Code / National ID', u.assessorReg, ok)}
        ${f('spMName', 'Assessment Center Manager / Officer', u.managerName, ok)}
        ${f('spADate', 'Date of assessment', u.assessDate, ok, m.course.assessDate || 'e.g. 12/11/2026')}
      </div>
      <p class="small muted">The internal assessor is whoever types in the marks. The External Verifier lines, the signatures and the dates beside them are left blank on the sheet, for signing by hand.</p>
      ${ok ? '<button type="button" class="btn" data-sp="sign-save">Save details</button>' : ''}</details>`;
  }
  /** After a keystroke or a save: deviations, moderated marks, workings and the save status, without redrawing the inputs. */
  function refreshDev() {
    if (!sp.marks) return;
    const mod = moderation(sp.marks.candidates, val);
    for (const c of sp.marks.candidates) {
      const e = CSS.escape(c.regNo), td = $(`[data-dev="${e}"]`), tm = $(`[data-mod="${e}"]`);
      if (td) td.innerHTML = devCell(c);
      if (tm) tm.innerHTML = modCell(c, mod);
    }
    const p = $('#spMd'); if (p) p.innerHTML = modHtml(mod);
    const s = $('#spSave'); if (s) { s.textContent = saveText(); s.dataset.state = saveState; }
    $('#sumprac .sp-table')?.classList.toggle('sp-preview', changes().n > 0 || !!saving);
  }

  /* ---------- saving by itself: a moment after typing stops, when a box is left, and before leaving the unit ---------- */
  const AUTOSAVE_MS = 800;
  let saveTimer = null, saving = null, saveState = 'saved', saveErr = '';
  function saveText() {
    const ch = sp.marks ? changes() : { n: 0, bad: 0 };
    if (saveState === 'error') return `Not saved - ${saveErr}. It tries again when you type or reconnect.`;
    if (saving || saveState === 'saving') return 'Saving…';
    if (ch.bad) return `${ch.bad} mark${ch.bad === 1 ? ' is' : 's are'} not a whole number from 0 to 100 - not saved`;
    if (ch.n) return 'Saving…';
    return 'All marks saved';
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => flush(), AUTOSAVE_MS); }
  /** Sends what has changed. Resolves true when everything valid is saved. */
  async function flush() {
    clearTimeout(saveTimer);
    if (saving) await saving;
    if (!sp.marks) return true;
    const { out, n } = changes();
    if (!n) { saveState = 'saved'; refreshDev(); return true; }
    const cid = sp.courseId, unit = sp.unitCode;
    saving = (async () => {
      saveState = 'saving'; refreshDev();
      try {
        let res = null;
        for (const kind of Object.keys(out)) res = need(await api('spSave', { courseId: cid, unitCode: unit, kind, marks: out[kind] }));
        if (sp.courseId !== cid || sp.unitCode !== unit) return true;
        // What was sent is saved; anything typed while it was on the way stays to be sent next.
        for (const kind of Object.keys(out)) for (const it of out[kind]) { const k = kind + '|' + it.regNo; if (sp.edits.get(k) === it.mark) sp.edits.delete(k); }
        sp.marks = { ...res, candidates: res.candidates }; keepUnit(res.unit);
        for (const inp of $$('#sumprac input.spmk')) { const c = candOf(inp.dataset.reg), k = inp.dataset.kind + '|' + inp.dataset.reg; if (c && !sp.edits.has(k)) inp.classList.remove('changed'); }
        const head = $('#sumprac .sp-unit-head .small.muted'); if (head) head.textContent = `Internal assessor on the sheet: ${res.unit.assessorName || 'not yet'} - ${res.unit.candidates} candidates`;
        saveState = 'saved'; saveErr = '';
        return true;
      } catch (e) { saveState = 'error'; saveErr = e.message; return false; }
    })();
    const ok = await saving;
    saving = null;
    refreshDev();
    if (ok && changes().n) scheduleSave();
    return ok;
  }
  /** Before leaving the unit: save, and if that cannot happen, ask. */
  async function leaveOk() {
    if (!sp.marks || (!changes().n && !changes().bad && !saving)) return true;
    const ok = await flush();
    const { n, bad } = changes();
    if (ok && !n && !bad) return true;
    return confirm(bad ? 'Some marks are not whole numbers from 0 to 100 and were not saved. Leave them?' : 'Some marks could not be saved (no connection?). Leave them?');
  }
  async function saveSign(btn) {
    const u = sp.marks.unit, body = { courseId: sp.courseId, unitCode: sp.unitCode };
    const take = (id, key) => { const el = $('#' + id); if (el && !el.readOnly && el.value.trim() !== (u[key] || '')) body[key] = el.value; };
    take('spAReg', 'assessorReg'); take('spADate', 'assessDate'); take('spMName', 'managerName');
    if (Object.keys(body).length === 2) { toast('Nothing changed', 'ok'); return; }
    btn.disabled = true;
    try {
      const res = need(await api('spUnitSave', body));
      sp.marks.unit = res.unit; keepUnit(res.unit);
      toast('Details saved', 'ok'); draw();
    }
    catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }

  /* ---------- the CDACC nominal roll (candidates) ---------- */
  const H = {   // column headings, matched exactly first, then loosely (in this order, so "Center Reg No" is not taken as "Reg No")
    adm: ['center reg no', 'centre reg no', 'center reg number', 'admission no', 'admission number', 'adm no'],
    reg: ['reg no', 'registration no', 'registration number', 'reg number', 'registration code', 'reg code', 'cdacc reg no'],
    name: ['name', 'candidate name', 'candidates name', 'full name'],
    unit: ['unit code', 'unit of competency code'],
    unitName: ['unit name', 'unit title', 'unit of competency'],
    level: ['course level', 'level'],
    course: ['course', 'qualification', 'course name', 'qualification title'],
    series: ['series', 'assessment series'],
    center: ['assessment center', 'assessment centre', 'center', 'centre'],
  };
  const hnorm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function columns(head) {
    const hs = Array.from(head, hnorm), col = {}, taken = new Set();
    for (const [f, names] of Object.entries(H)) { const i = hs.findIndex((h, j) => !taken.has(j) && names.includes(h)); if (i >= 0) { col[f] = i; taken.add(i); } }
    for (const [f, names] of Object.entries(H)) {
      if (col[f] !== undefined) continue;
      const i = hs.findIndex((h, j) => h && !taken.has(j) && names.some((n) => h.includes(n)));
      if (i >= 0) { col[f] = i; taken.add(i); }
    }
    return col;
  }
  async function readRoll(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['xlsx', 'xlsm'].includes(ext)) throw new Error('Choose the Excel file (.xlsx) of the CDACC nominal roll');
    const wb = await Xlsx.open(await file.arrayBuffer());
    for (const name of wb.names) {
      const rows = Array.from(await wb.rows(name), (r) => r || []);
      for (let h = 0; h < Math.min(10, rows.length); h++) {
        const col = columns(rows[h]);
        if (col.reg === undefined || col.name === undefined || col.unit === undefined) continue;
        if (col.course === undefined) throw new Error(`The sheet "${name}" has no Course column, so its candidates cannot be put under a course`);
        return group(rows.slice(h + 1), col);
      }
    }
    throw new Error('No sheet has the columns Reg No, Name and Unit Code (the CDACC nominal roll)');
  }
  function group(rows, col) {
    const s = (r, f) => (col[f] === undefined ? '' : String(r[col[f]] ?? '').replace(/\s+/g, ' ').trim());
    const map = new Map();
    for (const r of rows) {
      const row = { regNo: s(r, 'reg'), admNo: s(r, 'adm'), name: s(r, 'name'), unitCode: s(r, 'unit'), unitName: s(r, 'unitName') };
      if (!row.regNo || !row.name || !row.unitCode) continue;
      const level = s(r, 'level'), courseName = s(r, 'course'), series = s(r, 'series');
      const key = [level, courseName, series].map(lc).join('|');
      if (!map.has(key)) map.set(key, { key, level, course: courseName, series, center: '', rows: [], regs: new Set(), units: new Set() });
      const g = map.get(key);
      if (!g.center) g.center = s(r, 'center');
      g.rows.push(row); g.regs.add(lc(row.regNo)); g.units.add(row.unitCode.toUpperCase());
    }
    if (!map.size) throw new Error('No candidate rows were found under the headings');
    return [...map.values()].sort((a, b) => a.course.localeCompare(b.course) || a.level.localeCompare(b.level));
  }
  function rollHtml() {
    const have = new Set(sp.data.courses.map((c) => c.id));
    let up = '';
    if (uploader()) {
      up = `<section class="card"><h2 class="card-h">Upload the CDACC nominal roll</h2>
        <p class="muted small">The Excel file from CDACC with one row per candidate per unit: Reg No, Center Reg No, Name, Unit Code, Unit Name, Course, Course Level, Series and Assessment Center.
        It is separate from the class lists and does not change them. Uploading it again updates the courses you tick; candidates who already have marks are kept.</p>
        <label class="btn file-btn"><svg class="i" aria-hidden="true"><use href="#i-upload"/></svg>Choose the Excel file<input type="file" id="spFile" accept=".xlsx,.xlsm"></label>`;
      if (sp.roll) {
        const shown = sp.roll.filter((g) => !sp.find || lc(`${g.course} ${g.level} ${g.series}`).includes(lc(sp.find)));
        up += `<p class="small">${sp.roll.length} course${sp.roll.length === 1 ? '' : 's'} in the file. Tick the ones for this department${have.size ? ' (those already here are ticked)' : ''}.</p>
          <label class="sp-find">Find a course<input id="spFind" value="${esc(sp.find)}" placeholder="e.g. Computer Science" autocomplete="off"></label>
          <div class="table-wrap"><table class="report-table"><thead><tr><th><input type="checkbox" id="spPickAll" aria-label="Tick all shown"${shown.length && shown.every((g) => sp.pick.has(g.key)) ? ' checked' : ''}></th><th>Course</th><th>Level</th><th>Series</th><th class="num">Candidates</th><th class="num">Units</th><th></th></tr></thead>
          <tbody>${shown.map((g) => `<tr><td><input type="checkbox" data-pick="${esc(g.key)}"${sp.pick.has(g.key) ? ' checked' : ''} aria-label="${esc(g.course)}"></td><td>${esc(g.course)}</td><td>${esc(g.level)}</td><td>${esc(g.series)}</td>
            <td class="num">${g.regs.size}</td><td class="num">${g.units.size}</td><td>${have.has(g.key) ? '<span class="pill synced">Here - updates</span>' : '<span class="pill locked">New</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No course matches</td></tr>'}</tbody></table></div>
          <div class="row-actions"><button type="button" class="btn primary" data-sp="roll-save"${sp.pick.size ? '' : ' disabled'}>Register ${sp.pick.size} course${sp.pick.size === 1 ? '' : 's'}</button>
          <button type="button" class="btn ghost" data-sp="roll-cancel">Cancel</button></div>`;
      }
      up += '</section>';
    }
    const list = sp.data.courses.map(courseCard).join('');
    return up + `<section class="card"><h2 class="card-h">Courses</h2>
      <p class="muted small">Anyone signed in as a trainer, a guest or an external officer can enter the marks of any unit, and their names go on the sheet. Someone outside the staff gets a Guest account in Manage &gt; People &gt; Staff, with an end date: it only reaches Practicals and stops on that date.</p>
      ${list || '<p class="muted">No courses yet.</p>'}</section>`;
  }
  function courseCard(c) {
    const up = uploader();
    const f = (k, label, v, ph = '') => `<label>${label}<input data-cf="${k}" value="${esc(v)}"${up ? '' : ' readonly'}${ph ? ` placeholder="${esc(ph)}"` : ''}></label>`;
    return `<details class="fold sp-course" data-course="${esc(c.id)}"${sp.open.has(c.id) ? ' open' : ''}><summary>${esc(courseLabel(c))} - ${c.candidates} candidates - ${c.units.length} units</summary>
      <div class="grid2">${f('centerCode', 'Assessment Center Code', c.centerCode)}${f('centerName', 'Assessment Center Name', c.centerName)}
        ${f('qualCode', 'Course/Qualification Code', c.qualCode, 'From CDACC')}${f('course', 'Course/Qualification Title', c.course)}
        ${f('assessDate', 'Date of assessment', c.assessDate, 'e.g. 10/11/2026 - 14/11/2026')}</div>
      ${up ? '<div class="row-actions"><button type="button" class="btn" data-sp="course-save">Save sheet heading</button></div>' : ''}
      <div class="table-wrap"><table class="report-table sp-units"><thead><tr><th>#</th><th>Unit</th><th class="num">Candidates</th><th class="num">Marks I/E/M</th><th>Internal assessor</th></tr></thead>
      <tbody>${c.units.map((u) => `<tr><td>${u.seq}</td><td class="sp-who">${esc(u.name)}<span class="adm">${esc(u.code)}</span></td><td class="num">${u.candidates}</td>
        <td class="num">${u.internal}/${u.external}/${u.moderated}</td><td>${esc(u.assessorName || '-')}</td></tr>`).join('')}</tbody></table></div>
      ${up ? '<div class="row-actions"><button type="button" class="btn ghost danger-text" data-sp="course-delete">Remove this course</button></div>' : ''}</details>`;
  }
  async function rollFile(input) {
    const file = input.files[0];
    if (!file) return;
    try {
      toast('Reading the roll…', 'ok');
      sp.roll = await readRoll(file);
      const have = new Set(sp.data.courses.map((c) => c.id));
      sp.pick = new Set(sp.roll.filter((g) => have.has(g.key)).map((g) => g.key));
      sp.find = '';
      draw();
    } catch (e) { toast(e.message, 'err'); }
    input.value = '';
  }
  async function rollSave(btn) {
    const todo = sp.roll.filter((g) => sp.pick.has(g.key));
    if (!todo.length) return;
    btn.disabled = true;
    let cands = 0, kept = 0;
    const failed = [];
    for (let i = 0; i < todo.length; i++) {
      const g = todo[i];
      btn.textContent = `Registering ${i + 1} of ${todo.length}…`;
      try {
        const res = need(await api('spUpload', { level: g.level, course: g.course, series: g.series, center: g.center, rows: g.rows }));
        cands += res.candidates; kept += res.kept;
      } catch (e) { failed.push(`${g.course} ${shortLevel(g.level)}: ${e.message}`); }
    }
    sp.roll = null; sp.pick.clear();
    try { await loadCourses(); } catch { /* the list shows what it has */ }
    draw();
    if (failed.length) toast(`Not registered - ${failed.join('; ')}`, 'err');
    else toast(`${todo.length} course${todo.length === 1 ? '' : 's'} registered - ${cands} candidates${kept ? `; ${kept} entries off the roll kept for their marks` : ''}`, 'ok');
  }
  async function courseSave(btn) {
    const card = btn.closest('[data-course]'), body = { id: card.dataset.course };
    for (const el of card.querySelectorAll('[data-cf]')) body[el.dataset.cf] = el.value;
    btn.disabled = true;
    try {
      const res = need(await api('spCourseSave', body));
      const i = sp.data.courses.findIndex((c) => c.id === body.id);
      if (i >= 0) sp.data.courses[i] = { ...sp.data.courses[i], ...res.course };
      toast('Sheet heading saved', 'ok'); draw();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }
  async function courseDelete(btn) {
    const id = btn.closest('[data-course]').dataset.course, c = sp.data.courses.find((x) => x.id === id);
    if (!c || !confirm(`Remove ${courseLabel(c)} with its ${c.candidates} candidates and every mark entered for it? This cannot be undone.`)) return;
    btn.disabled = true;
    try { need(await api('spCourseDelete', { id })); if (sp.courseId === id) { sp.courseId = ''; sp.unitCode = ''; sp.marks = null; } await loadCourses(); toast('Course removed', 'ok'); draw(); }
    catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }
  /* ---------- sheets (CDACC CBA/SAMSP/2), made on this device ---------- */
  function sheetsHtml() {
    if (!sp.data.courses.length) return emptyHtml();
    const c = course();
    if (!c) return '';
    if (!sp.sheetUnits) sp.sheetUnits = new Set(c.units.map((u) => u.code));
    return `<section class="card sp-sec">${pickers(false)}
      <h3>All units - moderated marks</h3>
      <p class="muted small">Candidates down the side, one numbered column per unit (named under KEY), each cell the moderated mark out of 100. Candidates with none of the ticked units are left out.</p>
      <div class="sp-check-list">${c.units.map((u) => `<label class="check"><input type="checkbox" data-su="${esc(u.code)}"${sp.sheetUnits.has(u.code) ? ' checked' : ''}>${u.seq}. ${esc(u.name)} <span class="muted small">(${u.moderated}/${u.candidates})</span></label>`).join('')}</div>
      <div class="row-actions"><button type="button" class="btn primary" data-sp="all-pdf">All units - PDF</button><button type="button" class="btn" data-sp="all-xlsx">All units - Excel</button></div>
      <h3>Per unit of competency</h3>
      <p class="muted small">Internal assessor’s marks (all candidates), the external verifier’s (sampled), the moderated marks, the mean deviation and the three sign-offs. “Every unit” puts one sheet per unit into a single PDF.</p>
      <label>Unit<select id="spSheetUnit"><option value="">Every unit (one PDF)</option>${c.units.map((u) => `<option value="${esc(u.code)}"${u.code === sp.sheetUnit ? ' selected' : ''}>${esc(u.seq + '. ' + u.name)}</option>`).join('')}</select></label>
      <div class="row-actions"><button type="button" class="btn primary" data-sp="per-pdf">Per unit - PDF</button><button type="button" class="btn" data-sp="per-xlsx"${sp.sheetUnit ? '' : ' disabled title="Choose one unit for Excel"'}>Per unit - Excel</button></div></section>`;
  }
  const CDACC = 'TVET CURRICULUM DEVELOPMENT, ASSESSMENT AND CERTIFICATION COUNCIL (TVET CDACC)';
  // Candidates per printed sheet (landscape A4). The KEY and the sign-offs go on the last sheet only, so it holds fewer.
  // A unit's last sheet also carries the mean deviation, its workings (one row fewer per line they take) and a breather.
  const ALL_FULL = 24, ALL_LAST = 19, UNIT_FULL = 24, UNIT_LAST = 18;
  const title = (c) => [c.course, c.level].filter(Boolean).join(' - ');
  /** Splits a list into sheets: as few as fit (full sheets hold `full`, the last one `last`), evened out so no sheet is nearly empty. */
  function pagesOf(list, full, last) {
    const n = list.length;
    if (n <= last) return [list];
    const P = 1 + Math.ceil((n - last) / full), lastSize = Math.min(last, Math.round(n / P)), rest = n - lastSize, out = [];
    let i = 0;
    for (let k = 0; k < P - 1; k++) { const take = Math.ceil((rest - i) / (P - 1 - k)); out.push(list.slice(i, i + take)); i += take; }
    out.push(list.slice(i));
    return out;
  }
  const ln = (v, cls = '') => `<span class="ln${cls ? ' ' + cls : ''}">${esc(v || '')}</span>`;
  function headHtml(c, heading, sheet, of, date, extra = '') {
    return `<div class="sp-top"><img src="icons/cdacc-logo.png" alt=""><div class="sp-org">${CDACC}</div></div>
      <div class="sp-form"><span>CBA/SAMSP/2</span><span>SHEET ${sheet} OF ${of}</span></div>
      <h1>${heading}</h1>
      <table class="sp-fields"><tr><th>Assessment Center Code:</th><td>${esc(c.centerCode)}</td><th>Assessment Center Name:</th><td>${esc(c.centerName)}</td></tr>
        <tr><th>Course/Qualification Code:</th><td>${esc(c.qualCode)}</td><th>Course/Qualification Title:</th><td>${esc(title(c))}</td></tr>
        <tr><th>Date of Assessment:</th><td>${esc(date || '')}</td><th>Assessment Series:</th><td>${esc(c.series)}</td></tr>${extra}</table>`;
  }
  const common = (units, key) => { const v = [...new Set(units.map((u) => u[key]).filter(Boolean))]; return v.length === 1 ? v[0] : ''; };
  function allUnitsPages(d, units) {
    const c = d.course, codes = new Set(units.map((u) => u.code)), people = new Map();
    for (const m of d.marks) {
      if (!codes.has(m.unit)) continue;
      const k = m.regNo.toLowerCase();
      if (!people.has(k)) people.set(k, { regNo: m.regNo, name: m.name, admNo: m.admNo, marks: {} });
      people.get(k).marks[m.unit] = m.moderated;
    }
    const list = [...people.values()].sort((a, b) => a.regNo.localeCompare(b.regNo, undefined, { numeric: true }));
    const pages = pagesOf(list, ALL_FULL, Math.max(6, ALL_LAST - Math.ceil(units.length / 3)));
    const key = `<div class="sp-key"><b>KEY:</b>${units.map((u, j) => `<span>${j + 1} - ${esc(u.name)}</span>`).join('')}</div>`;
    const sign = `<div class="sp-sign"><p>1. Name of External Verifier:${ln('')}External Verifier Reg. Code/National ID. No:${ln('', 's')}</p>
      <p>Signature:${ln('', 's')}Date:${ln('', 's')}</p>
      <p>2. Name of Assessment Center Manager/Officer:${ln(common(units, 'managerName'))}Signature:${ln('', 's')}Date:${ln('', 's')}</p>
      <p>Institutional stamp:${ln('', 's')}</p></div>`;
    let n = 0;
    return pages.map((rows, p) => `${headHtml(c, 'SUMMATIVE ASSESSMENT MODERATED PRACTICAL MARKS SHEETS FOR ALL UNITS OF COMPETENCY', p + 1, pages.length, c.assessDate || common(units, 'assessDate'))}
      <table class="sp-grid${units.length > 14 ? ' many' : ''}"><thead><tr><th rowspan="3" class="sn">S/N</th><th rowspan="3" class="rg">Candidate’s Registration Code/National Id No.</th><th rowspan="3">Candidate’s Name</th>
        <th colspan="${units.length}">Candidate’s Score Per Unit of Competency out of 100% (units numbered as under KEY)</th></tr>
        <tr><th colspan="${units.length}">MODERATED MARKS</th></tr><tr>${units.map((u, j) => `<th class="mk">${j + 1}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((s) => `<tr><td class="c">${++n}</td><td class="nw">${esc(s.regNo)}</td><td class="nw">${esc(s.name)}</td>${units.map((u) => `<td class="mk">${s.marks[u.code] ?? (u.code in s.marks ? '' : '-')}</td>`).join('')}</tr>`).join('')}</tbody></table>
      ${p === pages.length - 1 ? key + sign : ''}`);
  }
  function perUnitPages(c, u, cands) {
    const m = moderation(cands, (k, x) => x[k]), workLines = m.n ? Math.ceil((170 + workText(m).length) / 190) : 0;
    const pages = pagesOf(cands, UNIT_FULL, Math.max(6, UNIT_LAST - workLines));
    const extra = `<tr><th>Unit of Competency Code:</th><td>${esc(u.code)}</td><th>Unit of Competency Title:</th><td>${esc(u.name)}</td></tr>`;
    const sign = `<div class="sp-sign"><p>1. Name of Internal Assessor${ln(u.assessorName)}Internal Assessor Reg. Code/National ID. No.${ln(u.assessorReg, 's')}Signature${ln('', 's')}Date${ln('', 's')}</p>
      <p>2. Name of External Verifier${ln('')}External Verifier Reg. Code/National ID. No.${ln('', 's')}Signature${ln('', 's')}Date${ln('', 's')}</p>
      <p>3. Name of Assessment Center Manager/Officer${ln(u.managerName)}Signature${ln('', 's')}Date${ln('', 's')}Institutional stamp${ln('', 's')}</p></div>`;
    let n = 0;
    return pages.map((rows, p) => `${headHtml(c, 'SUMMATIVE ASSESSMENT MODERATED PRACTICAL MARKS SHEETS PER UNIT OF COMPETENCY', p + 1, pages.length, u.assessDate || c.assessDate, extra)}
      <table class="sp-grid"><thead><tr><th class="sn">S/N</th><th class="rg">Candidate’s Registration Code</th><th>Candidate’s Name</th><th class="w">Internal assessor’s marks (All Candidates) (100%)</th>
        <th class="w">External verifier’s (Sampled Candidates) (100%)</th><th class="w">Moderated Marks (100%)</th></tr></thead>
      <tbody>${rows.map((s) => `<tr><td class="c">${++n}</td><td class="nw">${esc(s.regNo)}</td><td class="nw">${esc(s.name)}</td><td class="mk">${s.internal ?? ''}</td><td class="mk">${s.external ?? ''}</td><td class="mk">${s.moderated ?? ''}</td></tr>`).join('')}</tbody></table>
      ${p === pages.length - 1 ? `<div class="sp-mdblock"><p class="sp-mdp">Mean Deviation: ${m.n ? md2(m.md) : ''}</p>
        ${m.n ? `<p class="sp-mdw">Mean Deviation = Σ(External verifier’s mark − Internal assessor’s mark) ÷ number of sampled candidates = ${workText(m)}. ${sheetDecision(m)}</p>` : ''}</div>${sign}` : ''}`);
  }
  function sheetDecision(m) {
    if (!m.ready) return `Sample below 10% of those assessed (needs ${m.need}): no moderated marks yet.`;
    return m.adjust ? `More than ±${TOLERANCE}: every moderated mark = internal mark ${m.adjust > 0 ? '+' : '−'} ${Math.abs(m.adjust).toFixed(2)}.` : `Within ±${TOLERANCE}: the moderated marks are the internal assessor’s marks.`;
  }
  /** Puts "Page x of y" on every page of the document and wraps it for HtmlPdf. */
  const doc = (pages) => `<div class="sp-print">${pages.map((p, i) => `<div class="sp-page">${p}<div class="sp-foot">Page ${i + 1} of ${pages.length}</div></div>`).join('')}</div>`;
  async function sheetData() { return need(await api('spSheet', { courseId: sp.courseId })); }
  const stamp = () => todayISO();
  async function makeAll(kind, btn) {
    const units0 = course()?.units.filter((u) => sp.sheetUnits?.has(u.code)) || [];
    if (!units0.length) { toast('Tick at least one unit', 'err'); return; }
    btn.disabled = true;
    try {
      const d = await sheetData(), units = d.units.filter((u) => sp.sheetUnits.has(u.code)), c = d.course;
      const name = `CDACC moderated practicals - all units - ${fileSafe(c.course + ' ' + shortLevel(c.level))}_${stamp()}`;
      if (kind === 'pdf') {
        toast('Making the PDF…', 'ok');
        download(name + '.pdf', await HtmlPdf.make(doc(allUnitsPages(d, units)), { landscape: true }));
      } else {
        const people = new Map();
        for (const m of d.marks) {
          if (!units.some((u) => u.code === m.unit)) continue;
          const k = m.regNo.toLowerCase();
          if (!people.has(k)) people.set(k, { ...m, marks: {} });
          people.get(k).marks[m.unit] = m.moderated;
        }
        const list = [...people.values()].sort((a, b) => a.regNo.localeCompare(b.regNo, undefined, { numeric: true }));
        download(name + '.xlsx', await Xlsx.simple('All units', ['S/N', 'Candidate’s Registration Code', 'Candidate’s Name', 'Center Reg No', ...units.map((u, j) => `${j + 1} ${u.name} (${u.code})`)],
          list.map((s, i) => [i + 1, s.regNo, s.name, s.admNo, ...units.map((u) => s.marks[u.code] ?? '')])));
      }
      toast('Sheet saved to this device', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  }
  async function makePerUnit(kind, btn, only) {
    btn.disabled = true;
    try {
      const d = await sheetData(), c = d.course;
      const units = only ? d.units.filter((u) => u.code === only) : d.units;
      if (!units.length) throw new Error('That unit is not on the course');
      const candsOf = (u) => d.marks.filter((m) => m.unit === u.code).sort((a, b) => a.regNo.localeCompare(b.regNo, undefined, { numeric: true }));
      const base = `CDACC moderated practicals - ${only ? fileSafe(units[0].name) : 'every unit'} - ${fileSafe(c.course + ' ' + shortLevel(c.level))}_${stamp()}`;
      if (kind === 'pdf') {
        toast('Making the PDF…', 'ok');
        download(base + '.pdf', await HtmlPdf.make(doc(units.flatMap((u) => perUnitPages(c, u, candsOf(u)))), { landscape: true }));
      } else {
        const u = units[0], cands = candsOf(u), m = moderation(cands, (k, x) => x[k]);
        download(base + '.xlsx', await Xlsx.simple(u.name, ['S/N', 'Candidate’s Registration Code', 'Candidate’s Name', 'Center Reg No', 'Internal assessor (all candidates, 100%)', 'External verifier (sampled, 100%)', 'Moderated (100%)'],
          [...cands.map((s, i) => [i + 1, s.regNo, s.name, s.admNo, s.internal ?? '', s.external ?? '', s.moderated ?? '']), [], ['', '', 'Mean deviation', '', '', m.md ?? '', ''], ['', '', 'Formula', 'Σ(External − Internal) ÷ number of sampled candidates'],
           ['', '', 'Workings', m.n ? workText(m) : 'no external marks yet'], ['', '', 'Sample', `${m.sampled} of ${m.assessed} assessed (10% needed: ${m.need})`],
           ['', '', 'Decision', sheetDecision(m)]]));
      }
      toast('Sheet saved to this device', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  }

  /* ---------- events ---------- */
  function wire() {
    document.addEventListener('click', async (e) => {
      const root = box();
      if (!root || !root.contains(e.target)) return;
      const v = e.target.closest('[data-spview]');
      if (v) {
        if (v.dataset.spview === sp.view || !(await leaveOk())) return;
        sp.view = v.dataset.spview; sp.edits.clear();
        const c = course();
        if (sp.view === 'marks' && !sp.unitCode && c?.units.length) sp.unitCode = c.units[0].code;
        draw();
        if (sp.view === 'marks' && sp.unitCode) { try { await loadMarks(); } catch (er) { toast(er.message, 'err'); } draw(); }
        return;
      }
      const b = e.target.closest('[data-sp]');
      if (!b || b.disabled) return;
      const act = b.dataset.sp;
      if (act === 'reload') return render();
      if (act === 'sign-save') return saveSign(b);
      if (act === 'unit-pdf' || act === 'unit-xlsx') { await flush(); return makePerUnit(act === 'unit-pdf' ? 'pdf' : 'xlsx', b, sp.unitCode); }
      if (act === 'roll-save') return rollSave(b);
      if (act === 'roll-cancel') { sp.roll = null; sp.pick.clear(); draw(); return; }
      if (act === 'course-save') return courseSave(b);
      if (act === 'course-delete') return courseDelete(b);
      if (act === 'all-pdf') return makeAll('pdf', b);
      if (act === 'all-xlsx') return makeAll('xlsx', b);
      if (act === 'per-pdf') return makePerUnit('pdf', b, sp.sheetUnit);
      if (act === 'per-xlsx') return makePerUnit('xlsx', b, sp.sheetUnit);
    });
    document.addEventListener('change', async (e) => {
      const t = e.target, root = box();
      if (!root || !root.contains(t)) return;
      if (t.id === 'spCourse') {
        if (!(await leaveOk())) { t.value = sp.courseId; return; }
        sp.courseId = t.value; sp.unitCode = ''; sp.marks = null; sp.edits.clear(); sp.sheetUnits = null; sp.sheetUnit = '';
        const c = course();
        if (sp.view === 'marks' && c?.units.length) { sp.unitCode = c.units[0].code; draw(); try { await loadMarks(); } catch (er) { toast(er.message, 'err'); } }
        draw(); return;
      }
      if (t.id === 'spUnit') {
        if (!(await leaveOk())) { t.value = sp.unitCode; return; }
        sp.unitCode = t.value; sp.marks = null; sp.edits.clear(); draw();
        try { await loadMarks(); } catch (er) { toast(er.message, 'err'); }
        draw(); return;
      }
      if (t.id === 'spFile') return rollFile(t);
      if (t.dataset.pick !== undefined) { if (t.checked) sp.pick.add(t.dataset.pick); else sp.pick.delete(t.dataset.pick); draw(); return; }
      if (t.id === 'spPickAll') { for (const g of sp.roll.filter((x) => !sp.find || lc(`${x.course} ${x.level} ${x.series}`).includes(lc(sp.find)))) { if (t.checked) sp.pick.add(g.key); else sp.pick.delete(g.key); } draw(); return; }
      if (t.dataset.su !== undefined) { if (t.checked) sp.sheetUnits.add(t.dataset.su); else sp.sheetUnits.delete(t.dataset.su); return; }
      if (t.id === 'spSheetUnit') { sp.sheetUnit = t.value; draw(); }
    });
    document.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'spFind' && box()?.contains(t)) {
        sp.find = t.value; const pos = t.selectionStart; draw();
        const f = $('#spFind'); if (f) { f.focus(); f.setSelectionRange(pos, pos); }
        return;
      }
      if (!t.matches || !t.matches('#sumprac input.spmk')) return;
      const k = t.dataset.kind + '|' + t.dataset.reg, c = candOf(t.dataset.reg);
      sp.edits.set(k, t.value.trim());
      t.classList.toggle('bad', !markOk(t.value));
      t.classList.toggle('changed', !!c && markOk(t.value) && markNum(t.value) !== c[t.dataset.kind]);
      if (saveState === 'error') saveState = 'saved';
      refreshDev();
      scheduleSave();
    });
    // Enter goes down the column, as in a spreadsheet.
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (e.key !== 'Enter' || !t.matches || !t.matches('#sumprac input.spmk')) return;
      e.preventDefault();
      const col = $$(`#sumprac input.spmk[data-kind="${t.dataset.kind}"]`), i = col.indexOf(t);
      const next = col[i + (e.shiftKey ? -1 : 1)];
      if (next) { next.focus(); next.select(); }
    });
    document.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !box()?.contains(d)) return;
      const key = d.dataset.course || d.dataset.sec;
      if (key) { if (d.open) sp.open.add(key); else sp.open.delete(key); }
    }, true);
    // Leaving a mark box saves at once; a connection coming back sends what is waiting; closing the page warns if anything is.
    document.addEventListener('focusout', (e) => { if (e.target.matches?.('#sumprac input.spmk')) flush(); });
    window.addEventListener('online', () => { if (sp.marks && changes().n) flush(); });
    window.addEventListener('beforeunload', (e) => { if (sp.marks && (changes().n || saving)) { e.preventDefault(); e.returnValue = ''; } });
  }
  wire();
  return { render, allowed };
})();
window.SummativePracticals = SummativePracticals;
