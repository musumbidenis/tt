/* Summative practicals - TVET CDACC moderated practical marks (the Practicals tab).
 * Candidates (MIS Officer, HOD; the Assessment Officer assigns assessors too): upload the CDACC nominal roll - its own
 *   upload, separate from the class lists, which it never changes - tick the courses to keep, fill each course's sheet
 *   heading and give every unit an internal assessor (a trainer, or someone added in Manage as a Trainer with an end date).
 * Marks: the assessor enters every candidate's mark (out of 100), the external verifier the sampled ones; the HOD, MIS
 *   Officer or Assessment Officer works out the moderated marks (internal + the mean deviation, then adjusted by hand)
 *   and finalises the unit.
 * Sheets: the two CDACC forms (CBA/SAMSP/2) - all units of a course, and per unit of competency - as PDF and Excel,
 *   made on this device.
 * Uses app.js (state, api, $, $$, esc, toast, hasRole, me, download, fileSafe, todayISO) and Xlsx, HtmlPdf. */
'use strict';

const SummativePracticals = (() => {
  const sp = {
    view: 'marks', data: null, courseId: '', unitCode: '', marks: null, edits: new Map(),
    roll: null, pick: new Set(), find: '', open: new Set(), sheetUnits: null, sheetUnit: '', busy: false,
  };
  const allowed = () => ['MIS', 'HOD', 'IAO', 'TRAINER', 'EAO'].some(hasRole);
  const uploader = () => hasRole('MIS') || hasRole('HOD');
  const office = () => hasRole('MIS') || hasRole('HOD') || hasRole('IAO');
  const need = (r) => { if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'The server refused that'); return r; };
  const box = () => $('#sumprac');
  const lc = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const course = () => sp.data?.courses.find((c) => c.id === sp.courseId) || null;
  const unitOf = (c, code) => c?.units.find((u) => u.code === code) || null;
  const mine = (u) => !!u?.assessorCode && lc(u.assessorCode) === lc(me()?.code);
  const can = {
    internal: (u) => mine(u) || hasRole('HOD'),
    external: () => hasRole('EAO') || hasRole('IAO') || hasRole('HOD'),
    moderated: () => office(),
  };
  const KINDS = ['internal', 'external', 'moderated'];
  const shortLevel = (l) => String(l || '').replace(/^level\s*/i, 'L');
  const courseLabel = (c) => `${c.course} ${shortLevel(c.level)}${c.series ? ' - ' + c.series : ''}`.trim();
  const unitLabel = (u) => `${u.seq}. ${u.name} - ${u.code} (${u.moderated}/${u.candidates})`;
  const markOk = (v) => { const t = String(v ?? '').trim(); return t === '' || (/^\d{1,3}$/.test(t) && Number(t) <= 100); };
  const markNum = (v) => { const t = String(v ?? '').trim(); return t === '' ? null : Number(t); };
  const dirty = () => [...sp.edits].some(([k, v]) => { const [kind, reg] = splitKey(k); const c = sp.marks?.candidates.find((x) => x.regNo === reg); return c && markNum(v) !== c[kind]; });
  const splitKey = (k) => { const i = k.indexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };
  const val = (kind, c) => { const k = kind + '|' + c.regNo; return sp.edits.has(k) ? markNum(sp.edits.get(k)) : c[kind]; };
  const discardOk = () => !dirty() || confirm('You have marks that are not saved. Leave them?');

  /* ---------- loading and drawing ---------- */
  async function loadCourses() {
    sp.data = need(await api('spCourses'));
    if (!course()) { sp.courseId = sp.data.courses[0]?.id || ''; sp.unitCode = ''; sp.marks = null; sp.sheetUnits = null; }
    const c = course();
    if (sp.unitCode && !unitOf(c, sp.unitCode)) { sp.unitCode = ''; sp.marks = null; }
    if (!sp.unitCode && c?.units.length && sp.view === 'marks') sp.unitCode = (c.units.find(mine) || c.units[0]).code;
  }
  async function loadMarks() {
    sp.marks = null; sp.edits.clear();
    if (!sp.courseId || !sp.unitCode) return;
    setMarks(need(await api('spMarks', { courseId: sp.courseId, unitCode: sp.unitCode })));
  }
  /** A fresh copy of a unit from the server: keep it, and its counts in the course list. */
  function setMarks(res) {
    sp.marks = res; sp.edits.clear();
    const c = course(), i = c ? c.units.findIndex((u) => u.code === res.unit.code) : -1;
    if (i >= 0) c.units[i] = res.unit;
  }
  async function render() {
    const el = box();
    if (!el) return;
    if (!allowed()) { el.innerHTML = ''; return; }
    if (!navigator.onLine) { el.innerHTML = '<div class="card notice"><h2>Practicals need internet</h2><p>Marks and sheets come straight from the server.</p></div>'; return; }
    if (!sp.data) el.innerHTML = '<div class="card"><p class="muted">Loading summative practicals…</p></div>';
    try {
      await loadCourses();
      if (sp.view === 'marks' && sp.unitCode && !dirty()) await loadMarks();
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
    const why = office() ? (uploader() ? 'Upload the CDACC nominal roll under Candidates.' : 'The MIS Officer or HOD uploads the CDACC nominal roll first.')
      : 'No practical unit is assigned to you yet. The HOD or MIS Officer assigns the assessors.';
    return `<div class="empty-state"><svg class="i" aria-hidden="true"><use href="#i-chart"/></svg><b>No courses yet</b><span>${why}</span></div>`;
  }
  function pickers(withUnit) {
    const c = course();
    return `<div class="sp-pick"><label>Course<select id="spCourse">${sp.data.courses.map((x) => `<option value="${esc(x.id)}"${x.id === sp.courseId ? ' selected' : ''}>${esc(courseLabel(x))}</option>`).join('')}</select></label>
      ${withUnit ? `<label>Unit<select id="spUnit"><option value="">Choose a unit</option>${(c?.units || []).map((u) => `<option value="${esc(u.code)}"${u.code === sp.unitCode ? ' selected' : ''}>${esc(unitLabel(u))}</option>`).join('')}</select></label>` : ''}</div>`;
  }

  /* ---------- marks ---------- */
  const meanDev = (list) => {
    const both = list.filter((c) => val('internal', c) !== null && val('external', c) !== null);
    return { n: both.length, v: both.length ? both.reduce((s, c) => s + val('external', c) - val('internal', c), 0) / both.length : 0 };
  };
  const fmtDev = (v) => { const r = Math.round(v * 10) / 10; return (r > 0 ? '+' : '') + r; };
  function cell(kind, c, edit) {
    const v = val(kind, c), k = kind + '|' + c.regNo, raw = sp.edits.has(k) ? sp.edits.get(k) : (v ?? '');
    if (!edit) return `<td class="num">${v ?? '<span class="muted">-</span>'}</td>`;
    const changed = sp.edits.has(k) && markNum(sp.edits.get(k)) !== c[kind];
    return `<td class="num"><input class="spmk${markOk(raw) ? '' : ' bad'}${changed ? ' changed' : ''}" inputmode="numeric" maxlength="3" autocomplete="off" data-kind="${kind}" data-reg="${esc(c.regNo)}" value="${esc(raw)}" aria-label="${kind} mark for ${esc(c.name)}"></td>`;
  }
  const devCell = (c) => { const i = val('internal', c), x = val('external', c); if (i === null || x === null) return ''; const d = x - i; return `<span class="sp-dev ${d < 0 ? 'neg' : d > 0 ? 'pos' : ''}">${fmtDev(d)}</span>`; };
  function marksHtml() {
    if (!sp.data.courses.length) return emptyHtml();
    let out = `<section class="card">${pickers(true)}`;
    if (!sp.unitCode) return out + '<p class="muted">Choose a unit to enter or see its marks.</p></section>';
    const m = sp.marks;
    if (!m) return out + '<p class="muted">Loading the unit…</p></section>';
    const u = m.unit, locked = !!u.lockedAt;
    const edit = { internal: !locked && can.internal(u), external: !locked && can.external(), moderated: !locked && can.moderated() };
    const md = meanDev(m.candidates);
    out += `<div class="sp-unit-head"><div><b>${esc(u.name)}</b> <span class="muted small">${esc(u.code)}</span>
        <div class="small muted">Assessor: ${esc(u.assessorName || 'not assigned')} - ${u.candidates} candidates - internal ${u.internal}, external ${u.external}, moderated ${u.moderated}</div></div>
      ${locked ? `<span class="pill synced">Finalised - ${esc(u.lockedBy)}, ${esc(u.lockedAt.slice(0, 10))}</span>` : '<span class="pill pending">Open</span>'}</div>`;
    if (!m.candidates.length) return out + '<p class="empty">No candidates for this unit on the roll.</p></section>';
    if (!locked && !KINDS.some((k) => edit[k])) out += '<p class="small muted">You can see this unit’s marks. Its internal assessor, the external verifier and the HOD enter them.</p>';
    out += `<div class="table-wrap"><table class="report-table sp-table"><thead><tr><th>S/N</th><th class="sp-reg">Reg No</th><th>Name</th>
        <th class="num">Internal</th><th class="num">External</th><th class="num sp-devc">Deviation</th><th class="num">Moderated</th></tr></thead>
      <tbody>${m.candidates.map((c, i) => `<tr><td>${i + 1}</td><td class="tadm sp-reg">${esc(c.regNo)}</td><td class="sp-who">${esc(c.name)}<span class="adm sp-reg-m">${esc(c.regNo)}</span>${c.admNo ? `<span class="adm">${esc(c.admNo)}</span>` : ''}</td>
        ${cell('internal', c, edit.internal)}${cell('external', c, edit.external)}<td class="num sp-devc" data-dev="${esc(c.regNo)}">${devCell(c)}</td>${cell('moderated', c, edit.moderated)}</tr>`).join('')}</tbody></table></div>
      <p class="sp-md" id="spMd">${mdText(md)}</p>
      <div class="row-actions">
        ${KINDS.some((k) => edit[k]) ? '<button type="button" class="btn primary" data-sp="save">Save marks</button>' : ''}
        ${edit.moderated ? '<button type="button" class="btn" data-sp="workout">Work out moderated marks</button>' : ''}
        ${office() ? (locked ? '<button type="button" class="btn" data-sp="reopen">Reopen</button>' : '<button type="button" class="btn" data-sp="finalise">Finalise</button>') : ''}
        <button type="button" class="btn ghost" data-sp="unit-pdf">Sheet - PDF</button>
        <button type="button" class="btn ghost" data-sp="unit-xlsx">Sheet - Excel</button>
      </div>
      ${signHtml(m)}</section>`;
    return out;
  }
  const mdText = (md) => `Mean deviation: <b>${md.n ? fmtDev(md.v) : '-'}</b> <span class="small muted">${md.n ? `external - internal, over ${md.n} sampled candidate${md.n === 1 ? '' : 's'}` : 'no sampled candidates yet'}</span>`;
  function signHtml(m) {
    const u = m.unit, mineU = mine(u) || office(), ver = office() || hasRole('EAO'), off = office();
    const f = (id, label, v, ok, ph = '') => `<label>${label}<input id="${id}" value="${esc(v)}"${ok ? '' : ' readonly'}${ph ? ` placeholder="${esc(ph)}"` : ''}></label>`;
    return `<details class="fold" data-sec="sp-sign"${sp.open.has('sp-sign') ? ' open' : ''}><summary>Sign-off details on the sheet</summary>
      <div class="grid2">
        ${f('spAName', 'Internal assessor', u.assessorName, false, 'Assigned under Candidates')}
        ${f('spAReg', 'Assessor Reg. Code / National ID', u.assessorReg, mineU)}
        ${f('spVName', 'External verifier', u.verifierName, ver)}
        ${f('spVReg', 'Verifier Reg. Code / National ID', u.verifierReg, ver)}
        ${f('spMName', 'Assessment Center Manager / Officer', u.managerName, off)}
        ${f('spADate', 'Date of assessment', u.assessDate, mineU, m.course.assessDate || 'e.g. 12/11/2026')}
      </div>
      <p class="small muted">Signatures and the dates beside them are left blank on the sheet, for signing by hand.</p>
      ${mineU || ver ? '<button type="button" class="btn" data-sp="sign-save">Save details</button>' : ''}</details>`;
  }
  function refreshDev() {
    if (!sp.marks) return;
    for (const c of sp.marks.candidates) { const td = $(`[data-dev="${CSS.escape(c.regNo)}"]`); if (td) td.innerHTML = devCell(c); }
    const p = $('#spMd'); if (p) p.innerHTML = mdText(meanDev(sp.marks.candidates));
  }
  async function saveMarks(btn) {
    const m = sp.marks;
    if (!m) return;
    const bad = [...sp.edits].find(([, v]) => !markOk(v));
    if (bad) { toast(`Marks are whole numbers from 0 to 100 (check ${splitKey(bad[0])[1]})`, 'err'); return; }
    const byKind = {};
    for (const [k, v] of sp.edits) {
      const [kind, reg] = splitKey(k), c = m.candidates.find((x) => x.regNo === reg);
      if (c && markNum(v) !== c[kind]) (byKind[kind] = byKind[kind] || []).push({ regNo: reg, mark: v });
    }
    const kinds = Object.keys(byKind);
    if (!kinds.length) { toast('Nothing changed', 'ok'); return; }
    btn.disabled = true;
    try {
      let res = null, n = 0;
      for (const kind of kinds) { res = need(await api('spSave', { courseId: sp.courseId, unitCode: sp.unitCode, kind, marks: byKind[kind] })); n += byKind[kind].length; }
      setMarks(res);
      toast(`${n} mark${n === 1 ? '' : 's'} saved`, 'ok');
      draw();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }
  /** Moderated = internal + the mean deviation (rounded, kept within 0-100); without sampled candidates, the internal mark. */
  function workOut() {
    const m = sp.marks, md = meanDev(m.candidates);
    let n = 0;
    for (const c of m.candidates) {
      const i = val('internal', c);
      if (i === null) continue;
      sp.edits.set('moderated|' + c.regNo, String(Math.max(0, Math.min(100, Math.round(i + (md.n ? md.v : 0))))));
      n++;
    }
    draw();
    toast(n ? `Moderated marks worked out for ${n} candidate${n === 1 ? '' : 's'} (${md.n ? 'mean deviation ' + fmtDev(md.v) : 'no sample, so the internal marks'}). Check them, then Save.` : 'Enter the internal marks first', n ? 'ok' : 'err');
  }
  async function lock(on, btn) {
    const m = sp.marks;
    if (on) {
      if (dirty()) { toast('Save the marks first', 'err'); return; }
      const missing = m.candidates.filter((c) => c.moderated === null).length;
      if (!confirm(missing ? `${missing} candidate${missing === 1 ? ' has' : 's have'} no moderated mark. Finalise anyway? Nobody can change the marks until it is reopened.` : 'Finalise this unit? Nobody can change its marks until it is reopened.')) return;
    } else if (!confirm('Reopen this unit so its marks can be changed?')) return;
    btn.disabled = true;
    try { setMarks(need(await api('spLock', { courseId: sp.courseId, unitCode: sp.unitCode, lock: on }))); toast(on ? 'Unit finalised' : 'Unit reopened', 'ok'); draw(); }
    catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }
  async function saveSign(btn) {
    const u = sp.marks.unit, body = { courseId: sp.courseId, unitCode: sp.unitCode };
    const take = (id, key) => { const el = $('#' + id); if (el && !el.readOnly && el.value.trim() !== (u[key] || '')) body[key] = el.value; };
    take('spAReg', 'assessorReg'); take('spADate', 'assessDate'); take('spVName', 'verifierName'); take('spVReg', 'verifierReg'); take('spMName', 'managerName');
    if (Object.keys(body).length === 2) { toast('Nothing changed', 'ok'); return; }
    btn.disabled = true;
    try {
      const res = need(await api('spUnitSave', body)), c = course(), i = c ? c.units.findIndex((x) => x.code === res.unit.code) : -1;
      sp.marks.unit = res.unit; if (i >= 0) c.units[i] = res.unit;
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
      <p class="muted small">Give every unit an internal assessor. Someone who is not on the staff list can be added in Manage &gt; People &gt; Staff as a Trainer with an end date: their account stops on that date.</p>
      ${list || '<p class="muted">No courses yet.</p>'}</section>`;
  }
  function courseCard(c) {
    const assigned = c.units.filter((u) => u.assessorCode).length, done = c.units.filter((u) => u.lockedAt).length, up = uploader();
    const f = (k, label, v, ph = '') => `<label>${label}<input data-cf="${k}" value="${esc(v)}"${up ? '' : ' readonly'}${ph ? ` placeholder="${esc(ph)}"` : ''}></label>`;
    const opts = (u) => `<option value="">Not assigned</option>${(sp.data.assessors || []).map((s) => `<option value="${esc(s.code)}"${lc(s.code) === lc(u.assessorCode) ? ' selected' : ''}>${esc(s.name)} (${esc(s.code)})${s.endsOn ? ' - until ' + esc(s.endsOn) : ''}</option>`).join('')}`;
    return `<details class="fold sp-course" data-course="${esc(c.id)}"${sp.open.has(c.id) ? ' open' : ''}><summary>${esc(courseLabel(c))} - ${c.candidates} candidates - ${c.units.length} units - assessors ${assigned}/${c.units.length}${done ? ` - finalised ${done}` : ''}</summary>
      <div class="grid2">${f('centerCode', 'Assessment Center Code', c.centerCode)}${f('centerName', 'Assessment Center Name', c.centerName)}
        ${f('qualCode', 'Course/Qualification Code', c.qualCode, 'From CDACC')}${f('course', 'Course/Qualification Title', c.course)}
        ${f('assessDate', 'Date of assessment', c.assessDate, 'e.g. 10/11/2026 - 14/11/2026')}</div>
      ${up ? '<div class="row-actions"><button type="button" class="btn" data-sp="course-save">Save sheet heading</button></div>' : ''}
      <div class="table-wrap"><table class="report-table sp-units"><thead><tr><th>#</th><th>Unit</th><th class="num">Candidates</th><th class="num">Marks I/E/M</th><th>Internal assessor</th></tr></thead>
      <tbody>${c.units.map((u) => `<tr><td>${u.seq}</td><td>${esc(u.name)}<span class="adm">${esc(u.code)}${u.lockedAt ? ' - finalised' : ''}</span></td><td class="num">${u.candidates}</td>
        <td class="num">${u.internal}/${u.external}/${u.moderated}</td><td><select data-assessor="${esc(u.code)}" aria-label="Assessor for ${esc(u.name)}">${opts(u)}</select></td></tr>`).join('')}</tbody></table></div>
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
    let cands = 0, kept = 0, fin = 0;
    const failed = [];
    for (let i = 0; i < todo.length; i++) {
      const g = todo[i];
      btn.textContent = `Registering ${i + 1} of ${todo.length}…`;
      try {
        const res = need(await api('spUpload', { level: g.level, course: g.course, series: g.series, center: g.center, rows: g.rows }));
        cands += res.candidates; kept += res.kept; fin += res.finalised || 0;
      } catch (e) { failed.push(`${g.course} ${shortLevel(g.level)}: ${e.message}`); }
    }
    sp.roll = null; sp.pick.clear();
    try { await loadCourses(); } catch { /* the list shows what it has */ }
    draw();
    if (failed.length) toast(`Not registered - ${failed.join('; ')}`, 'err');
    else toast(`${todo.length} course${todo.length === 1 ? '' : 's'} registered - ${cands} candidates${kept ? `; ${kept} entries off the roll kept for their marks` : ''}${fin ? `; ${fin} finalised unit${fin === 1 ? '' : 's'} left as ${fin === 1 ? 'it was' : 'they were'}` : ''}`, 'ok');
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
  async function assign(sel) {
    const id = sel.closest('[data-course]').dataset.course;
    sel.disabled = true;
    try {
      const res = need(await api('spUnitSave', { courseId: id, unitCode: sel.dataset.assessor, assessorCode: sel.value }));
      const c = sp.data.courses.find((x) => x.id === id), i = c.units.findIndex((u) => u.code === res.unit.code);
      if (i >= 0) c.units[i] = res.unit;
      if (sp.marks && sp.courseId === id && sp.unitCode === res.unit.code) sp.marks.unit = res.unit;
      toast(res.unit.assessorName ? `${res.unit.assessorName} assesses ${res.unit.name}` : 'Assessor removed', 'ok');
      const sum = sel.closest('details').querySelector('summary');
      if (sum) sum.textContent = `${courseLabel(c)} - ${c.candidates} candidates - ${c.units.length} units - assessors ${c.units.filter((u) => u.assessorCode).length}/${c.units.length}`;
    } catch (e) { toast(e.message, 'err'); }
    sel.disabled = false;
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
  const ALL_ROWS = 20, UNIT_ROWS = 17;   // candidates per printed sheet (landscape A4), so each sheet keeps its heading and sign-offs
  const title = (c) => [c.course, c.level].filter(Boolean).join(' - ');
  const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out.length ? out : [[]]; };
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
    const pages = chunks(list, Math.max(8, ALL_ROWS - Math.ceil(units.length / 3)));
    const key = `<div class="sp-key"><b>KEY:</b>${units.map((u, j) => `<span>${j + 1} - ${esc(u.name)}</span>`).join('')}</div>`;
    const sign = `<div class="sp-sign"><p>1. Name of External Verifier:${ln(common(units, 'verifierName'))}External Verifier Reg. Code/National ID. No:${ln(common(units, 'verifierReg'), 's')}</p>
      <p>Signature:${ln('', 's')}Date:${ln('', 's')}</p>
      <p>2. Name of Assessment Center Manager/Officer:${ln(common(units, 'managerName'))}Signature:${ln('', 's')}Date:${ln('', 's')}</p>
      <p>Institutional stamp:${ln('', 's')}</p></div>`;
    let n = 0;
    return pages.map((rows, p) => `${headHtml(c, 'SUMMATIVE ASSESSMENT MODERATED PRACTICAL MARKS SHEETS FOR ALL UNITS OF COMPETENCY', p + 1, pages.length, c.assessDate || common(units, 'assessDate'))}
      <table class="sp-grid"><thead><tr><th rowspan="3" class="sn">S/N</th><th rowspan="3" class="rg">Candidate’s Registration Code/National Id No.</th><th rowspan="3">Candidate’s Name</th>
        <th colspan="${units.length}">Candidate’s Score Per Unit of Competency out of 100% (units numbered as under KEY)</th></tr>
        <tr><th colspan="${units.length}">MODERATED MARKS</th></tr><tr>${units.map((u, j) => `<th class="mk">${j + 1}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((s) => `<tr><td class="c">${++n}</td><td>${esc(s.regNo)}</td><td>${esc(s.name)}</td>${units.map((u) => `<td class="mk">${s.marks[u.code] ?? (u.code in s.marks ? '' : '-')}</td>`).join('')}</tr>`).join('')}</tbody></table>
      ${key}${sign}`);
  }
  function perUnitPages(c, u, cands) {
    const md = meanDevOf(cands), pages = chunks(cands, UNIT_ROWS);
    const extra = `<tr><th>Unit of Competency Code:</th><td>${esc(u.code)}</td><th>Unit of Competency Title:</th><td>${esc(u.name)}</td></tr>`;
    const sign = `<div class="sp-sign"><p>1. Name of Internal Assessor${ln(u.assessorName)}Internal Assessor Reg. Code/National ID. No.${ln(u.assessorReg, 's')}Signature${ln('', 's')}Date${ln('', 's')}</p>
      <p>2. Name of External Verifier${ln(u.verifierName)}External Verifier Reg. Code/National ID. No.${ln(u.verifierReg, 's')}Signature${ln('', 's')}Date${ln('', 's')}</p>
      <p>3. Name of Assessment Center Manager/Officer${ln(u.managerName)}Signature${ln('', 's')}Date${ln('', 's')}Institutional stamp${ln('', 's')}</p></div>`;
    let n = 0;
    return pages.map((rows, p) => `${headHtml(c, 'SUMMATIVE ASSESSMENT MODERATED PRACTICAL MARKS SHEETS PER UNIT OF COMPETENCY', p + 1, pages.length, u.assessDate || c.assessDate, extra)}
      <table class="sp-grid"><thead><tr><th class="sn">S/N</th><th class="rg">Candidate’s Registration Code</th><th>Candidate’s Name</th><th class="w">Internal assessor’s marks (All Candidates) (100%)</th>
        <th class="w">External verifier’s (Sampled Candidates) (100%)</th><th class="w">Moderated Marks (100%)</th></tr></thead>
      <tbody>${rows.map((s) => `<tr><td class="c">${++n}</td><td>${esc(s.regNo)}</td><td>${esc(s.name)}</td><td class="mk">${s.internal ?? ''}</td><td class="mk">${s.external ?? ''}</td><td class="mk">${s.moderated ?? ''}</td></tr>`).join('')}</tbody></table>
      ${p === pages.length - 1 ? `<p class="sp-mdp">Mean Deviation: ${md.n ? fmtDev(md.v) : ''}</p>` : ''}${sign}`);
  }
  const meanDevOf = (list) => { const b = list.filter((c) => c.internal !== null && c.external !== null); return { n: b.length, v: b.length ? b.reduce((s, c) => s + c.external - c.internal, 0) / b.length : 0 }; };
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
        const u = units[0], cands = candsOf(u), md = meanDevOf(cands);
        download(base + '.xlsx', await Xlsx.simple(u.name, ['S/N', 'Candidate’s Registration Code', 'Candidate’s Name', 'Center Reg No', 'Internal assessor (all candidates, 100%)', 'External verifier (sampled, 100%)', 'Moderated (100%)'],
          [...cands.map((s, i) => [i + 1, s.regNo, s.name, s.admNo, s.internal ?? '', s.external ?? '', s.moderated ?? '']), [], ['', '', 'Mean deviation', '', '', md.n ? Math.round(md.v * 10) / 10 : '', '']]));
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
        if (v.dataset.spview === sp.view || !discardOk()) return;
        sp.view = v.dataset.spview; sp.edits.clear();
        const c = course();
        if (sp.view === 'marks' && !sp.unitCode && c?.units.length) sp.unitCode = (c.units.find(mine) || c.units[0]).code;
        draw();
        if (sp.view === 'marks' && sp.unitCode) { try { await loadMarks(); } catch (er) { toast(er.message, 'err'); } draw(); }
        return;
      }
      const b = e.target.closest('[data-sp]');
      if (!b || b.disabled) return;
      const act = b.dataset.sp;
      if (act === 'reload') return render();
      if (act === 'save') return saveMarks(b);
      if (act === 'workout') return workOut();
      if (act === 'finalise') return lock(true, b);
      if (act === 'reopen') return lock(false, b);
      if (act === 'sign-save') return saveSign(b);
      if (act === 'unit-pdf') { if (dirty()) toast('The sheet shows saved marks only - save first to include your changes', 'err'); return makePerUnit('pdf', b, sp.unitCode); }
      if (act === 'unit-xlsx') return makePerUnit('xlsx', b, sp.unitCode);
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
        if (!discardOk()) { t.value = sp.courseId; return; }
        sp.courseId = t.value; sp.unitCode = ''; sp.marks = null; sp.edits.clear(); sp.sheetUnits = null; sp.sheetUnit = '';
        const c = course();
        if (sp.view === 'marks' && c?.units.length) { sp.unitCode = (c.units.find(mine) || c.units[0]).code; draw(); try { await loadMarks(); } catch (er) { toast(er.message, 'err'); } }
        draw(); return;
      }
      if (t.id === 'spUnit') {
        if (!discardOk()) { t.value = sp.unitCode; return; }
        sp.unitCode = t.value; sp.marks = null; sp.edits.clear(); draw();
        try { await loadMarks(); } catch (er) { toast(er.message, 'err'); }
        draw(); return;
      }
      if (t.id === 'spFile') return rollFile(t);
      if (t.dataset.pick !== undefined) { if (t.checked) sp.pick.add(t.dataset.pick); else sp.pick.delete(t.dataset.pick); draw(); return; }
      if (t.id === 'spPickAll') { for (const g of sp.roll.filter((x) => !sp.find || lc(`${x.course} ${x.level} ${x.series}`).includes(lc(sp.find)))) { if (t.checked) sp.pick.add(g.key); else sp.pick.delete(g.key); } draw(); return; }
      if (t.dataset.assessor !== undefined) return assign(t);
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
      const k = t.dataset.kind + '|' + t.dataset.reg, c = sp.marks?.candidates.find((x) => x.regNo === t.dataset.reg);
      sp.edits.set(k, t.value.trim());
      t.classList.toggle('bad', !markOk(t.value));
      t.classList.toggle('changed', !!c && markOk(t.value) && markNum(t.value) !== c[t.dataset.kind]);
      refreshDev();
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
    window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });
  }
  wire();
  return { render, allowed };
})();
window.SummativePracticals = SummativePracticals;
