/* POE tab → Verification: internal verification of POE evidence.
 *  - The MIS Officer or the Internal Assessment Officer drafts a panel (a chair and members); it is approved at once.
 *  - The MIS Officer ticks the trainers and the classes; the system makes the panels, gives each class to a panel
 *    (biggest classes first, balanced by students) and each unit to one member, the least loaded, never anyone who teaches
 *    it - no class is ever left out: only when nobody else is left are the rules bent, and the history says so. The server draws the sample: everyone up to 10 students, otherwise max(10, ⌈√N × risk⌉), always including
 *    students returned-then-approved, files changed after sending and one from each third of the marks.
 *  - The verifier checks every sampled student (valid, authentic, current, sufficient; agree with the trainer?) and gives
 *    a result. Too many disagreements doubles the sample, then takes in everyone.
 *  - The trainer responds; the chair or the HOD signs. The External Assessment Officer sees every panel's class-units,
 *    can pick their own sample by class and unit, and gives their own result.
 * Uses app.js (api, $, $$, esc, toast, hasRole, me, fmtTime, lower) and PoeStaff (evidence list and preview). */
'use strict';

const Verify = (() => {
  const vs = { data: null, open: '', seq: 0 };
  const RESULT = { verified: 'Verified', actions: 'Verified with actions', not_verified: 'Not verified' };
  const STAT = { open: ['pending', 'In progress'], submitted: ['wait', 'Submitted'], signed: ['synced', 'Signed'] };
  const slotOf = (v) => (isMe(v.verifier) ? 'internal' : '');
  const external = () => hasRole('EAO');
  const office = () => hasRole('MIS') || hasRole('IAO') || hasRole('HOD');
  const drafts = () => hasRole('MIS') || hasRole('IAO');
  const isMe = (code) => lower(code) === lower(me()?.code || '');
  const staffName = (code) => vs.data?.staff.find((s) => lower(s.code) === lower(code))?.name || code;
  const nameOf = (adm) => vs.data?.names[lower(adm)] || PoeStaff.state.list.find((e) => lower(e.admNo) === lower(adm))?.name || adm;
  const checkOf = (v, adm, who) => vs.data.checks.find((c) => c.verificationId === v.id && lower(c.admNo) === lower(adm) && c.who === who);
  const evidenceOf = (v, adm) => PoeStaff.state.list.filter((e) => e.classCode === v.classCode && e.unitCode === v.unitCode && lower(e.admNo) === lower(adm) && e.status === 'approved')
    .sort((a, b) => a.item.localeCompare(b.item, undefined, { numeric: true }));
  const pill = ([cls, label]) => `<span class="pill ${cls}">${esc(label)}</span>`;

  /* ---------- every list here is a table: a filter box, headings that sort (tap again to reverse), pages ----------
   * cols: [{ k, label, cls, sort: (row) => value, cell: (row) => html }]. Each table redraws on its own (filtering, sorting
   * and turning pages leave the rest of the screen alone). */
  const vtQ = new Map(), vtDraw = new Map();
  function vt(key, rows, cols, opts = {}) {
    const q = (vtQ.get(key) || '').trim().toLowerCase(), search = opts.search || ((r) => cols.map((c) => (c.sort ? c.sort(r) : '')).join(' '));
    const first = opts.first || cols.find((c) => c.sort)?.k;
    const shown = Tables.sort(key, rows.filter((r) => !q || String(search(r)).toLowerCase().includes(q)), Object.fromEntries(cols.filter((c) => c.sort).map((c) => [c.k, c.sort])), first);
    const page = Tables.slice(key, shown);
    vtDraw.set(key, () => vt(key, rows, cols, opts));
    Tables.on(key, () => redrawTable(key));
    const head = '<th class="num sn">S/N</th>' + cols.map((c) => (c.sort ? Tables.th(key, c.k, c.label, c.cls || '') : `<th class="${c.cls || ''}">${c.label}</th>`)).join('');
    const sn = new Map(shown.map((r, i) => [r, i + 1]));
    return `<div class="vt" data-vt="${esc(key)}"><div class="vt-tools">${rows.length || q ? `<input type="search" class="vt-q" data-vtq="${esc(key)}" placeholder="${esc(opts.filter || 'Filter')}" value="${esc(vtQ.get(key) || '')}" aria-label="Filter">` : ''}${opts.tools ? opts.tools(shown) : ''}</div>
      ${shown.length ? `<div class="table-wrap"><table class="report-table ver-table${opts.cls ? ' ' + opts.cls : ''}"><thead><tr>${head}</tr></thead>
        <tbody>${page.map((r) => `<tr${opts.rowCls ? ` class="${opts.rowCls(r)}"` : ''}><td class="num sn">${sn.get(r)}</td>${cols.map((c) => `<td${c.cls ? ` class="${c.cls}"` : ''}>${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${Tables.bar(key, shown)}`
        : `<p class="muted small">${q ? 'Nothing matches that filter.' : esc(opts.empty || 'None yet.')}</p>`}</div>`;
  }
  /** The rows a table shows after its filter (for "select all"). */
  function vtShown(key, rows, search) { const q = (vtQ.get(key) || '').trim().toLowerCase(); return rows.filter((r) => !q || String(search(r)).toLowerCase().includes(q)); }
  function redrawTable(key) {
    const el = document.querySelector(`[data-vt="${CSS.escape(key)}"]`), f = vtDraw.get(key);
    if (!el || !f) return;
    const had = document.activeElement?.dataset?.vtq === key ? document.activeElement.selectionStart : null;
    el.outerHTML = f();
    if (had !== null) { const i = document.querySelector(`[data-vtq="${CSS.escape(key)}"]`); if (i) { i.focus(); i.setSelectionRange(had, had); } }
  }
  document.addEventListener('input', (e) => {
    const k = e.target.dataset?.vtq; if (k === undefined) return;
    vtQ.set(k, e.target.value); Tables.reset(k); redrawTable(k);
  });

  async function load() {
    const r = await api('verifyData', {});
    if (!r.ok) throw new Error(r.error || 'Could not load the verification');
    vs.data = r;
  }
  async function render(box, toggle) {
    const seq = ++vs.seq;
    if (!vs.data) box.innerHTML = `<div class="card poe-head"><div class="msec-head"><h2>Evidence (POE)</h2></div>${toggle}<p class="muted">Loading the verification…</p></div>`;
    try { await load(); } catch (e) { if (seq === vs.seq) box.innerHTML = `<div class="card poe-head">${toggle}</div><div class="card notice"><h2>Could not load the verification</h2><p>${esc(e.message)}</p></div>`; return; }
    if (seq === vs.seq) draw(box, toggle);
  }
  function draw(box, toggle) {
    const d = vs.data, v = vs.open && d.verifications.find((x) => x.id === vs.open);
    const head = `<div class="card poe-head"><div class="msec-head"><h2>Evidence (POE)</h2><button type="button" class="btn small ghost" data-vact="reload">Refresh</button></div>${toggle}
      <p class="muted small">Internal verification: a panel checks a sample of the evidence each trainer approved, class by class and unit by unit.</p></div>`;
    if (v) { box.innerHTML = head + detail(v); return; }
    const mine = d.verifications.filter((x) => slotOf(x));
    const units = d.verifications.filter((x) => isMe(x.trainerCode) && x.status !== 'open');
    const parts = [];
    if (mine.length) parts.push(card('Class-units given to you', 'Check every student in each sample, then give your result.', table(mine, { key: 'vMine' }), count(mine.length)));
    if (external()) parts.push(extCard());
    if (units.length) parts.push(card('Verification of your units', 'What the panel found in your units, and your response.', table(units, { key: 'vUnits' })));
    // Panels first, then the classes to verify (they are given out to the panels).
    if (drafts()) parts.push(listCard());
    if (office() || (d.panels.length && !external())) parts.push(panelsCard());
    if (!parts.length) parts.push('<div class="card notice"><h2>Nothing to verify</h2><p class="muted">When a panel gives you a class and unit to verify, or verifies one of your units, it shows here.</p></div>');
    box.innerHTML = head + parts.join('');
  }
  const closed = new Set();
  const card = (title, sub, body, extra = '') => `<details class="card vcard" data-card="${esc(title)}"${closed.has(title) ? '' : ' open'}><summary><h2>${esc(title)}</h2>${extra}</summary>
    <p class="muted small">${esc(sub)}</p>${body}</details>`;
  document.addEventListener('toggle', (e) => { const d = e.target; if (d.matches?.('details.vcard')) { if (d.open) closed.delete(d.dataset.card); else closed.add(d.dataset.card); } }, true);
  const count = (n) => `<span class="vcount">${n}</span>`;

  /** Class-units given out, as a table: class, unit, trainer, the two verifiers, sample, status, result. */
  const vPicked = new Set();
  function table(list, opts = {}) {
    const done = (v, who) => vs.data.checks.filter((c) => c.verificationId === v.id && c.who === who && c.agree !== null).length;
    const pick = drafts() && !opts.noPick;
    return vt(opts.key || 'vList', list, [
      ...(pick ? [{ k: 'pick', label: '<span class="sr">Choose</span>', cell: (v) => `<input type="checkbox" data-vpick="${esc(v.id)}"${vPicked.has(v.id) ? ' checked' : ''} aria-label="${esc(v.classCode + ' ' + v.unitCode)}">` }] : []),
      { k: 'cls', label: 'Class', sort: (v) => v.classCode, cell: (v) => esc(v.classCode) },
      { k: 'unit', label: 'Unit', sort: (v) => v.unitCode + ' ' + v.unitName, cell: (v) => `<span title="${esc(v.unitName)}">${esc(v.unitCode)}</span>` },
      { k: 'trainer', label: 'Trainer', sort: (v) => v.trainerName || v.trainerCode, cell: (v) => esc(v.trainerName || v.trainerCode) },
      { k: 'ver', label: 'Verifier', sort: (v) => staffName(v.verifier), cell: (v) => `${esc(staffName(v.verifier))}${v.v1?.at ? ' ✓' : ''}` },
      { k: 'size', label: 'Sample', cls: 'num', sort: (v) => v.size, cell: (v) => `<span title="${v.size} of the ${v.population} students in the class">${v.status === 'open' && v.sample.length ? `${done(v, 'internal')} / ` : ''}${v.size} of ${v.population}</span>` },
      { k: 'status', label: 'Status', sort: (v) => (STAT[v.status] || [, v.status])[1], cell: (v) => pill(STAT[v.status] || ['pending', v.status]) },
      { k: 'result', label: 'Result', sort: (v) => RESULT[v.result] || '', cell: (v) => `${v.result ? esc(RESULT[v.result]) : '–'}${v.extResult ? `<br><small class="muted">External: ${esc(RESULT[v.extResult])}</small>` : ''}` },
      { k: 'open', label: '<span class="sr">Open</span>', cell: (v) => `<button type="button" class="btn small" data-vopen="${esc(v.id)}">Open</button>${drafts() ? ` <button type="button" class="btn small ghost danger-text" data-vact="del-ver" data-id="${esc(v.id)}" data-what="${esc(v.classCode + ' ' + v.unitCode)}">Delete</button>` : ''}${opts.hod && v.status === 'open' ? ` <button type="button" class="btn small ghost" data-vact="redraw" data-id="${esc(v.id)}">Draw again</button>` : ''}` },
    ], { first: 'cls', filter: 'Filter by class, unit, trainer or verifier', empty: opts.empty || 'Nothing given out yet.',
      tools: pick ? (shown) => `<label class="kchip"><input type="checkbox" data-vpickall="${esc(opts.key || 'vList')}"${shown.length && shown.every((v) => vPicked.has(v.id)) ? ' checked' : ''}><span>Select all (${shown.length})</span></label>
        <button type="button" class="btn small ghost danger-text" data-vact="del-vers"${shown.some((v) => vPicked.has(v.id)) ? '' : ' disabled'}>Delete selected</button>` : null });
  }

  /* ---------- panels ---------- */
  // The members ticked in each panel form (the table pages, so the ticks are kept here, not read from the page).
  const memberSets = new Map();
  const memberSet = (p) => { const k = p?.id || 'new'; if (!memberSets.has(k)) memberSets.set(k, new Set((p?.members || []).map(lower))); return memberSets.get(k); };
  const teaches = (code) => [...new Set(vs.data.loading.filter((u) => lower(u.trainerCode) === lower(code)).map((u) => u.unitCode))];
  function membersTable(p, people) {
    const set = memberSet(p), k = p?.id || 'new';
    return vt('vMem:' + k, people, [
      { k: 'pick', label: '<span class="sr">Choose</span>', cell: (s) => `<input type="checkbox" data-mem="${esc(k)}" value="${esc(s.code)}"${set.has(lower(s.code)) ? ' checked' : ''} aria-label="${esc(s.name)}">` },
      { k: 'name', label: 'Name', sort: (s) => s.name, cell: (s) => esc(s.name) },
      { k: 'code', label: 'Code', sort: (s) => s.code, cell: (s) => esc(s.code) },
      { k: 'units', label: 'Units they teach', sort: (s) => teaches(s.code).length, cell: (s) => `<small>${esc(teaches(s.code).join(', ')) || '–'}</small>` },
    ], { first: 'name', filter: 'Filter staff', empty: 'Everyone is already on a panel.', search: (s) => `${s.name} ${s.code} ${teaches(s.code).join(' ')}` });
  }
  const termName = () => state.meta.term?.name || 'this term';
  /** The numbers free this term (and the panel's own number when changing it). */
  function panelNumbers(p) {
    const used = new Set(vs.data.panels.filter((x) => x.termId === vs.data.termId && x.id !== p?.id && x.number).map((x) => x.number));
    return Array.from({ length: 20 }, (_, i) => i + 1).filter((n) => !used.has(n));
  }
  function panelsCard() {
    const d = vs.data, people = d.staff.filter((s) => !(s.roles.length && s.roles.every((r) => r === 'EAO')));
    // A member sits on one panel a term: anyone on another panel is left out of the choices.
    const busy = (p) => new Set(d.panels.filter((x) => x.termId === d.termId && x.id !== p?.id).flatMap((x) => x.members.map(lower)));
    const free = (p) => people.filter((s) => !busy(p).has(lower(s.code)));
    const opts = (sel, p) => free(p).map((s) => `<option value="${esc(s.code)}"${lower(s.code) === lower(sel || '') ? ' selected' : ''}>${esc(s.name)} (${esc(s.code)})</option>`).join('');
    const form = (p) => `<form class="panel-form" data-panel="${esc(p?.id || '')}">
        <label>Panel number<select name="number" required>${panelNumbers(p).map((n) => `<option value="${n}"${(p?.number || panelNumbers(p)[0]) === n ? ' selected' : ''}>Panel ${n}</option>`).join('')}</select>
          <small class="muted">Named ${esc(termName())} - Panel and the number</small></label>
        <label>Chair<select name="chair" required><option value="">Choose…</option>${opts(p?.chair, p)}</select></label>
        <fieldset class="members"><legend>Members <span class="muted small">(${memberSet(p).size} chosen; staff already on another panel are not listed)</span></legend>${membersTable(p, free(p))}</fieldset>
        <button class="btn primary">${p ? 'Save the panel' : 'Draft the panel'}</button></form>`;
    const rows = d.panels.map((p) => {
      const vers = d.verifications.filter((v) => v.panelId === p.id);
      return `<details class="mdone panel"${vers.length ? ' open' : ''}><summary><b>${esc(p.name)}</b>
          <span class="muted small">Chair ${esc(staffName(p.chair))} - ${p.members.length} member${p.members.length === 1 ? '' : 's'}</span></summary>
        <div class="panel-who"><p class="small">${p.members.map((m) => esc(staffName(m)) + (lower(m) === lower(p.chair) ? ' (chair)' : '')).join(', ')}</p>
          ${drafts() ? `<button type="button" class="btn small danger" data-vact="del-panel" data-id="${esc(p.id)}" data-name="${esc(p.name)}" data-n="${vers.length}">Delete panel</button>` : ''}</div>
        ${table(vers, { key: 'vPanel:' + p.id, hod: hasRole('HOD') }) + (drafts() ? assignForm(p, vers) : '')}
        ${drafts() ? `<details class="mdone"><summary>Change this panel</summary>${form(p)}</details>` : ''}</details>`;
    }).join('');
    return card('Verification panels', drafts() ? 'Made by the system from the trainers you ticked. You can still change a panel or delete it.' : 'Panels made for this term\'s verification.',
      rows || '<p class="muted small">No panels yet. Set up verification above.</p>');
  }
  function assignForm(p, vers) {
    const taken = new Set(vers.map((v) => v.classCode + '|' + v.unitCode));
    const opts = vs.data.loading.filter((u) => !taken.has(u.classCode + '|' + u.unitCode)).sort((a, b) => (a.classCode + a.unitCode).localeCompare(b.classCode + b.unitCode));
    const eaos = vs.data.staff.filter((s) => s.roles.includes('EAO'));
    return `<form class="assign-form" data-panel="${esc(p.id)}">
        <label>Class and unit<select name="cu" required><option value="">Choose…</option>${opts.map((u) => `<option value="${esc(u.classCode + '|' + u.unitCode)}" data-trainer="${esc(u.trainerCode)}">${esc(u.classCode)} - ${esc(u.unitCode)} ${esc(u.unitName)} (${esc(u.trainerName || u.trainerCode)})</option>`).join('')}</select></label>
        <label>Verifier<select name="verifier" required><option value="">Choose…</option>${p.members.map((m) => `<option value="${esc(m)}">${esc(staffName(m))}</option>`).join('')}</select></label>
        <button class="btn primary">Give it and draw the sample</button>
      </form>
      ${eaos.length && vers.length ? `<div class="ext-assign"><b class="small">External Assessment Officer</b>${vers.map((v) => `<label class="small">${esc(v.classCode)} - ${esc(v.unitCode)}
        <select data-ext="${esc(v.id)}"><option value="">None</option>${eaos.map((s) => `<option value="${esc(s.code)}"${lower(s.code) === lower(v.external) ? ' selected' : ''}>${esc(s.name)}${s.endsOn ? ` (until ${esc(s.endsOn)})` : ''}</option>`).join('')}</select></label>`).join('')}</div>` : ''}`;
  }

  /* ---------- the master list: what to verify this term, given out automatically ---------- */
  const ls = { q: '', picked: new Set() };
  /** This term's classes with their students and units, and how much of each is on the list and given out. */
  function classRows() {
    const d = vs.data, m = new Map();
    for (const u of d.loading) { if (!m.has(u.classCode)) m.set(u.classCode, { code: u.classCode, units: 0, students: d.classStudents?.[u.classCode] || 0 }); m.get(u.classCode).units++; }
    for (const c of m.values()) { const on = d.list.filter((r) => r.classCode === c.code); c.listed = on.length; c.given = on.filter((r) => r.verificationId).length; }
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code));
  }
  const classSearch = (c) => c.code;
  const su = { trainers: new Set(), size: 3 };
  const trainerRows = () => vs.data.staff.filter((s) => !s.roles.includes('EAO'));
  const trSearch = (s) => `${s.name} ${s.code} ${teaches(s.code).join(' ')}`;
  function listCard() {
    const d = vs.data, rows = classRows(), listed = rows.filter((c) => c.listed);
    const started = d.verifications.some((v) => d.checks.some((c) => c.verificationId === v.id));
    const vOf = (r) => d.verifications.find((v) => v.id === r.verificationId);
    const panelsOf = (cls) => [...new Set(d.list.filter((r) => r.classCode === cls && r.verificationId).map((r) => d.panels.find((p) => p.id === vOf(r)?.panelId)?.name).filter(Boolean))].join(', ');
    const trainers = vt('vTr', trainerRows(), [
      { k: 'pick', label: '<span class="sr">Choose</span>', cell: (s) => `<input type="checkbox" data-trpick="${esc(s.code)}"${su.trainers.has(lower(s.code)) ? ' checked' : ''} aria-label="${esc(s.name)}">` },
      { k: 'name', label: 'Trainer', sort: (s) => s.name, cell: (s) => esc(s.name) },
      { k: 'code', label: 'Code', sort: (s) => s.code, cell: (s) => esc(s.code) },
      { k: 'units', label: 'Units they teach', sort: (s) => teaches(s.code).length, cell: (s) => `<small>${esc(teaches(s.code).join(', ')) || '–'}</small>` },
    ], { first: 'name', filter: 'Filter trainers', empty: 'No staff.', search: trSearch,
      tools: (shown) => `<label class="kchip"><input type="checkbox" data-trall${shown.length && shown.every((s) => su.trainers.has(lower(s.code))) ? ' checked' : ''}><span>Select all (${shown.length})</span></label><span class="muted small">${su.trainers.size} ticked</span>` });
    const pick = vt('vPick', rows, [
      { k: 'pick', label: '<span class="sr">Choose</span>', cell: (c) => `<input type="checkbox" data-lspick="${esc(c.code)}"${ls.picked.has(c.code) ? ' checked' : ''} aria-label="${esc(c.code)}">` },
      { k: 'cls', label: 'Class', sort: (c) => c.code, cell: (c) => esc(c.code) },
      { k: 'students', label: 'Students', cls: 'num', sort: (c) => c.students, cell: (c) => String(c.students) },
      { k: 'units', label: 'Units', cls: 'num', sort: (c) => c.units, cell: (c) => String(c.units) },
    ], { first: 'cls', filter: 'Filter classes', empty: 'No classes in this term\'s loading.', search: classSearch,
      tools: (shown) => `<label class="kchip"><input type="checkbox" data-lsall${shown.length && shown.every((c) => ls.picked.has(c.code)) ? ' checked' : ''}><span>Select all (${shown.length})</span></label><span class="muted small">${ls.picked.size} ticked</span>` });
    const on = vt('vOn', listed, [
      { k: 'cls', label: 'Class', sort: (c) => c.code, cell: (c) => esc(c.code) },
      { k: 'students', label: 'Students', cls: 'num', sort: (c) => c.students, cell: (c) => String(c.students) },
      { k: 'units', label: 'Units given out', cls: 'num', sort: (c) => c.given, cell: (c) => `${c.given} of ${c.listed}` },
      { k: 'panel', label: 'Panel', sort: (c) => panelsOf(c.code), cell: (c) => esc(panelsOf(c.code)) || '<span class="muted small">none could take it</span>' },
    ], { first: 'cls', filter: 'Filter classes', empty: 'Nothing set up yet.', search: (c) => `${c.code} ${panelsOf(c.code)}` });
    return card('Set up verification', 'Tick the trainers who verify and the classes to verify. The system makes the panels (about the size you choose, each named after the term and its number), gives every class to a panel by its number of students and every unit to one member who does not teach it, and draws the samples.',
      `<h3 class="ver-ph">1. Trainers who verify</h3>${trainers}
      <h3 class="ver-ph">2. Classes to verify</h3>${pick}
      <div class="row-actions su-go"><label class="small">Members per panel <input type="number" id="suSize" min="2" max="8" value="${su.size}"></label>
        <button type="button" class="btn primary" data-vact="setup"${su.trainers.size && ls.picked.size ? '' : ' disabled'}>${d.panels.length ? 'Start again: make the panels and allocate' : 'Make the panels and allocate'}</button></div>
      ${started ? '<p class="warn-text small">Checking has started, so starting again is not allowed. Delete this term\'s verification first if you really need to.</p>' : ''}
      ${listed.length ? `<h3 class="ver-ph">What was given out</h3>${on}` : ''}
      <div class="row-actions"><button type="button" class="btn small danger" data-vact="clear-all">Delete this term's verification</button></div>`);
  }
  const listFree = () => vtShown('vPick', classRows(), classSearch);

  /* ---------- the external officer: choose a class or a unit ---------- */
  const ef = { cls: '', unit: '' };
  function extCard() {
    const all = vs.data.verifications;
    const classes = [...new Set(all.map((v) => v.classCode))].sort();
    const units = [...new Map(all.filter((v) => !ef.cls || v.classCode === ef.cls).map((v) => [v.unitCode, v.unitName])).entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (ef.unit && !units.some(([c]) => c === ef.unit)) ef.unit = '';
    const list = all.filter((v) => (!ef.cls || v.classCode === ef.cls) && (!ef.unit || v.unitCode === ef.unit));
    return card('Verification', 'Choose a class or a unit to verify. Open one to see the panel\'s checks, pick your own students, leave your comments and export the report.',
      `<div class="poe-filters"><select id="efClass" aria-label="Class"><option value="">All classes</option>${classes.map((c) => `<option${c === ef.cls ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="efUnit" aria-label="Unit"><option value="">All units</option>${units.map(([c, n]) => `<option value="${esc(c)}"${c === ef.unit ? ' selected' : ''}>${esc(c)} - ${esc(n)}</option>`).join('')}</select></div>
      ${ef.cls || ef.unit ? table(list, { key: 'vExt', empty: 'Nothing given out for that choice yet.' }) : '<p class="muted small">Choose a class or a unit above.</p>'}`);
  }

  /* ---------- the external officer's own sample ---------- */
  const ext = { pool: null, for: '', picked: new Set() };
  function extBox(v) {
    if (!external()) return '';
    if (ext.for !== v.id) { ext.for = v.id; ext.pool = null; ext.picked = new Set(v.extSample.map(lower)); api('verifyPool', { id: v.id }).then((r) => { if (r.ok && ext.for === v.id) { ext.pool = r.students; redraw(); } }); }
    return `<details class="mdone ext-own" open><summary>Your own sample</summary>
      <p class="muted small">Pick the students of this class you want to verify yourself. ${ext.picked.size} picked.</p>
      ${!ext.pool ? '<p class="muted small">Loading the students…</p>' : vt('vPool', ext.pool, [
        { k: 'pick', label: '<span class="sr">Choose</span>', cell: (s) => `<input type="checkbox" data-extpick="${esc(s.admNo)}"${ext.picked.has(lower(s.admNo)) ? ' checked' : ''} aria-label="${esc(s.name)}">` },
        { k: 'name', label: 'Student', sort: (s) => s.name, cell: (s) => `<b>${esc(s.name)}</b>` },
        { k: 'adm', label: 'Admission no.', sort: (s) => s.admNo, cell: (s) => `<span class="tadm">${esc(s.admNo)}</span>` },
        { k: 'ev', label: 'Approved evidence', sort: (s) => (s.evidence ? 'Yes' : 'No'), cell: (s) => (s.evidence ? 'Yes' : '<span class="muted">No</span>') },
        { k: 'ins', label: "Panel's sample", sort: (s) => (s.inSample ? 'Yes' : ''), cell: (s) => (s.inSample ? 'Yes' : '') },
      ], { first: 'adm', filter: 'Filter by name or admission no.', empty: 'This class has no students on its list.', search: (s) => `${s.name} ${s.admNo}`,
        tools: () => '<button type="button" class="btn small primary" data-vact="ext-pick">Save my sample</button>' })}</details>`;
  }

  const sPicked = new Set();
  /* ---------- one class-unit ---------- */
  function detail(v) {
    const d = vs.data, slot = slotOf(v), mySub = slot === 'internal' ? v.v1 : null;
    const mineInt = !!slot && v.status === 'open' && !mySub?.at, mineExt = external();
    const extList = v.extSample.filter((a) => !v.sample.some((s) => lower(s) === lower(a)));
    const sample = [...v.sample, ...extList];
    const showExt = mineExt || !!v.extResult || d.checks.some((c) => c.verificationId === v.id && c.who === 'external');
    const checked = v.sample.filter((a) => checkOf(v, a, slot || 'internal')?.agree != null).length;
    const against = v.sample.filter((a) => checkOf(v, a, 'internal')?.agree === false).length;
    const order = sample.flatMap((a) => evidenceOf(v, a).map((e) => e.id));
    const extEdit = (adm) => mineExt && (v.extSample.some((s) => lower(s) === lower(adm)) || ['submitted', 'signed'].includes(v.status));
    const panel = d.panels.find((p) => p.id === v.panelId);
    const canSign = v.status === 'submitted' && (hasRole('HOD') || (panel && isMe(panel.chair)));
    const why = (adm) => v.reasons[adm] || (extList.includes(adm) ? "the external officer's choice" : '');
    const status = (adm, who) => { const c = checkOf(v, adm, who); return !c || c.agree == null ? 'Not checked' : c.agree ? 'Agrees' : 'Does not agree'; };
    const canPick = mineInt;
    const sampleTable = vt('vSample:' + v.id, sample, [
      ...(canPick ? [{ k: 'pick', label: '<span class="sr">Choose</span>', cell: (adm) => (extList.includes(adm) ? '' : `<input type="checkbox" data-spick="${esc(adm)}"${sPicked.has(adm) ? ' checked' : ''} aria-label="${esc(nameOf(adm))}">`) }] : []),
      { k: 'name', label: 'Student', sort: (adm) => nameOf(adm), cell: (adm) => `<b>${esc(nameOf(adm))}</b><br><span class="tadm">${esc(adm.toUpperCase())}</span>` },
      { k: 'why', label: 'Why in the sample', cls: 'small', sort: why, cell: (adm) => esc(why(adm)) },
      { k: 'ev', label: 'Approved evidence', sort: (adm) => evidenceOf(v, adm).length, cell: (adm) => { const ev = evidenceOf(v, adm); return ev.length ? ev.map((e) => `<button type="button" class="btn small" data-vview="${esc(e.id)}" data-order="${esc(order.join(','))}">${esc(e.item)}</button>`).join(' ') : '<span class="muted small">no approved file</span>'; } },
      { k: 'v1', label: esc(staffName(v.verifier)), sort: (adm) => status(adm, 'internal'), cell: (adm) => (extList.includes(adm) ? '' : checkCell(v, adm, 'internal', mineInt && slot === 'internal')) },
      ...(showExt ? [{ k: 'ext', label: 'External check', sort: (adm) => status(adm, 'external'), cell: (adm) => checkCell(v, adm, 'external', extEdit(adm)) }] : []),
    ], { first: 'name', cls: 'ver-sample', filter: 'Filter by name or admission no.', empty: 'No sample.', search: (adm) => `${nameOf(adm)} ${adm}`,
      tools: canPick ? (shown) => `<label class="kchip"><input type="checkbox" data-spickall${shown.length && shown.filter((a) => !extList.includes(a)).every((a) => sPicked.has(a)) ? ' checked' : ''}><span>Select all (${shown.length})</span></label>
        <button type="button" class="btn small primary" data-vact="mark-ok"${sPicked.size ? '' : ' disabled'}>Mark selected: all four met - agree${sPicked.size ? ` (${sPicked.size})` : ''}</button>
        <button type="button" class="btn small" data-vact="mark-no"${sPicked.size ? '' : ' disabled'}>Mark selected: do not agree</button>` : null });
    const firstLog = v.log[0]?.what || '';
    return `<section class="card ver-detail">
      <div class="msec-head"><h2>${esc(v.classCode)} - ${esc(v.unitCode)} ${esc(v.unitName)}</h2><button type="button" class="btn small ghost" data-vact="back">‹ Back</button></div>
      <p class="small">Trainer <b>${esc(v.trainerName || v.trainerCode)}</b> - verifier <b>${esc(staffName(v.verifier))}</b>${v.external ? ` - external <b>${esc(staffName(v.external))}</b>` : ''} - ${pill(STAT[v.status] || ['pending', v.status])}</p>
      ${!v.sample.length ? `<p class="warn-text small">No sample: the class list was empty when this was given out.${office() ? ' <button type="button" class="btn small primary" data-vact="draw" data-id="' + esc(v.id) + '">Draw the sample now</button>' : ''}</p>` : ''}
      <p class="small">Sample: <b>${v.size}</b> of the ${v.population} students in the class${v.risk > 1 ? ` (higher risk × ${v.risk})` : ''}. ${esc(firstLog)}${v.round > 1 ? ` <b class="warn-text">${v.round === 2 ? 'The sample was doubled after disagreements.' : 'Every student is now in the sample.'}</b>` : ''}</p>
      ${v.status === 'open' && slot ? `<p class="small">You have checked ${checked} of ${v.sample.length}${against ? ` - <b class="warn-text">${against} disagreement${against === 1 ? '' : 's'}</b>` : ''}</p>` : ''}
      ${sampleTable}
      ${extBox(v)}
      ${mineInt ? `<form class="ver-submit"><h3>Your result</h3>
        <label>Result<select name="result" required><option value="">Choose…</option>${Object.entries(RESULT).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
        <label>Actions for the trainer <span class="muted small">(needed unless verified)</span><textarea name="actions" rows="3" maxlength="2000"></textarea></label>
        <button class="btn primary">Submit the result</button></form>` : ''}
      ${v.status !== 'open' ? `<div class="ver-result"><h3>Result: ${esc(RESULT[v.result] || '')}</h3>
        ${v.actions ? `<p class="small"><b>Actions:</b> ${esc(v.actions)}</p>` : ''}
        <p class="muted small">Submitted ${esc(fmtTime(v.submittedAt))}${v.signedAt ? ` - signed by ${esc(v.signedBy)} ${esc(fmtTime(v.signedAt))}` : ''}</p>
        ${v.response ? `<p class="small"><b>Trainer's response:</b> ${esc(v.response)}</p>` : ''}
        ${isMe(v.trainerCode) ? `<form class="ver-respond"><label>Your response<textarea name="response" rows="2" maxlength="2000">${esc(v.response)}</textarea></label><button class="btn">Send response</button></form>` : ''}
        ${canSign ? '<button type="button" class="btn primary" data-vact="sign">Sign the report</button>' : ''}
</div>` : ''}
      ${mineExt ? `<form class="ver-ext"><h3>Your external result</h3><label>Result<select name="result" required><option value="">Choose…</option>${Object.entries(RESULT).map(([k, l]) => `<option value="${k}"${v.extResult === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label>Note<textarea name="note" rows="2" maxlength="2000">${esc(v.extNote)}</textarea></label><button class="btn primary">Save the external result</button></form>`
        : v.extResult ? `<p class="small"><b>External result:</b> ${esc(RESULT[v.extResult])}${v.extNote ? ` - ${esc(v.extNote)}` : ''}</p>` : ''}
      ${hasRole('IAO') && !mineExt && v.status === 'open' ? '<button type="button" class="btn small ghost" data-vact="more">Add 5 more students</button>' : ''}
      <div class="row-actions table-actions"><button type="button" class="btn" data-vact="xlsx"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel</button>
        <button type="button" class="btn" data-vact="pdf"><svg class="i" aria-hidden="true"><use href="#i-print"/></svg>Print the report</button></div>
      <details class="mdone"><summary>History</summary><ul class="small">${v.log.map((l) => `<li>${esc(fmtTime(l.at))} - ${esc(l.by)}: ${esc(l.what)}</li>`).join('')}</ul></details>
    </section>`;
  }
  const TICKS = [['valid', 'Valid'], ['authentic', 'Authentic'], ['current', 'Current'], ['sufficient', 'Sufficient']];
  function checkCell(v, adm, who, edit) {
    const c = checkOf(v, adm, who);
    if (!edit) {
      if (!c || c.agree == null) return '<span class="muted small">Not checked</span>';
      return `<span class="small">${TICKS.map(([k, l]) => `${c[k] ? '✓' : '✗'} ${l}`).join(' - ')}<br><b class="${c.agree ? 'ok-text' : 'warn-text'}">${c.agree ? 'Agrees with the trainer' : 'Does not agree'}</b>${c.comment ? `<br>${esc(c.comment)}` : ''}</span>`;
    }
    return `<div class="vcheck" data-adm="${esc(adm)}" data-who="${who}">${TICKS.map(([k, l]) => `<label class="kchip"><input type="checkbox" name="${k}"${c?.[k] ? ' checked' : ''}><span>${l}</span></label>`).join('')}
      <select name="agree" aria-label="Agree with the trainer's decision"><option value="">Agree with the trainer?</option><option value="1"${c?.agree === true ? ' selected' : ''}>Agree</option><option value="0"${c?.agree === false ? ' selected' : ''}>Do not agree</option></select>
      <input name="comment" maxlength="1000" placeholder="Comment" value="${esc(c?.comment || '')}"><button type="button" class="btn small" data-vact="save-check">Save</button></div>`;
  }

  /* ---------- the report: Excel and print with signature lines ---------- */
  function reportRows(v) {
    const yn = (b) => (b ? 'Yes' : 'No');
    const one = (c) => (c && c.agree != null ? `${['valid', 'authentic', 'current', 'sufficient'].filter((k) => c[k]).length}/4 - ${c.agree ? 'Agree' : 'Do not agree'}${c.comment ? ' - ' + c.comment : ''}` : '');
    return v.sample.map((adm, i) => [i + 1, adm.toUpperCase(), nameOf(adm), v.reasons[adm] || '', one(checkOf(v, adm, 'internal')), one(checkOf(v, adm, 'external'))]);
  }
  const HEAD = ['#', 'Admission no.', 'Name', 'Why in the sample', 'Verifier (ticks - decision)', 'External'];
  function printReport(v) {
    const panel = vs.data.panels.find((p) => p.id === v.panelId);
    const chairSigned = !!(v.signedAt && panel && lower(staffName(panel.chair)) === lower(v.signedBy || ''));
    $('#printArea').innerHTML = `<div class="tbl-print ver-print"><h1>INTERNAL VERIFICATION REPORT</h1>
      <p>${esc(v.classCode)} - ${esc(v.unitCode)} ${esc(v.unitName)} - trainer ${esc(v.trainerName || v.trainerCode)}</p>
      <p>Panel: ${esc(panel?.name || '')} - verifier ${esc(staffName(v.verifier))} - sample ${v.size} of ${v.population}${v.risk > 1 ? ` (risk × ${v.risk})` : ''}</p>
      <table><thead><tr>${HEAD.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${reportRows(v).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <p><b>Result:</b> ${esc(RESULT[v.result] || 'not given yet')}${v.actions ? ` - <b>Actions:</b> ${esc(v.actions)}` : ''}</p>
      ${v.response ? `<p><b>Trainer's response:</b> ${esc(v.response)}</p>` : ''}
      <table class="sign-lines"><tr><th>Verifier</th><td>${esc(staffName(v.verifier))}</td><th>Signature</th><td class="sig">${v.v1.at ? esc(initials(staffName(v.verifier))) : ''}</td><th>Date</th><td>${esc(v.v1.at ? fmtShort(v.v1.at) : '')}</td></tr>
        <tr><th>Panel chair</th><td>${esc(panel ? staffName(panel.chair) : '')}</td><th>Signature</th><td class="sig">${chairSigned ? esc(initials(staffName(panel.chair))) : ''}</td><th>Date</th><td>${chairSigned ? esc(fmtShort(v.signedAt)) : ''}</td></tr>
        <tr><th>HOD</th><td>${esc(v.signedBy || '')}</td><th>Signature</th><td class="sig">${v.signedAt ? esc(initials(v.signedBy)) : ''}</td><th>Date</th><td>${esc(v.signedAt ? fmtShort(v.signedAt) : '')}</td></tr></table></div>`;
    document.body.classList.add('printing', 'print-table');
    const done = () => { document.body.classList.remove('printing', 'print-table'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 80);
  }

  /* ---------- actions ---------- */
  const redraw = () => PoeStaff.redraw();
  async function call(action, body, msg) {
    const r = await api(action, body);
    if (!r.ok) throw new Error(r.error);
    if (msg) toast(msg, 'ok');
    return r;
  }
  function upsertVer(ver) { const i = vs.data.verifications.findIndex((x) => x.id === ver.id); if (i >= 0) vs.data.verifications[i] = ver; else vs.data.verifications.unshift(ver); }
  async function onClick(t) {
    const o = t.closest('[data-vopen]'); if (o) { vs.open = o.dataset.vopen; sPicked.clear(); redraw(); return true; }
    const w = t.closest('[data-vview]'); if (w) { PoeStaff.open(w.dataset.vview, w.dataset.order.split(',')); return true; }
    const a = t.closest('[data-vact]'); if (!a) return false;
    const act = a.dataset.vact, v = vs.data?.verifications.find((x) => x.id === vs.open);
    try {
      if (act === 'reload') { vs.data = null; redraw(); }
      if (act === 'back') { vs.open = ''; redraw(); }
      if (act === 'mark-ok' || act === 'mark-no') {
        const ok = act === 'mark-ok', comment = ok ? '' : prompt('Why do you not agree with the trainer? (saved for each student ticked)');
        if (!ok && !String(comment || '').trim()) return true;
        const r = await call('saveChecks', { id: v.id, admNos: [...sPicked], valid: ok, authentic: ok, current: ok, sufficient: ok, agree: ok, comment: comment || '' });
        for (const c of r.checks) { const i = vs.data.checks.findIndex((x) => x.verificationId === v.id && lower(x.admNo) === lower(c.admNo) && x.who === c.who); if (i >= 0) vs.data.checks[i] = c; else vs.data.checks.push(c); }
        toast(`${r.checks.length} student${r.checks.length === 1 ? '' : 's'} marked`, 'ok'); sPicked.clear(); redraw();
      }
      if (act === 'del-vers') {
        const ids = [...vPicked]; if (!ids.length) return true;
        if (!confirm(`Delete ${ids.length} class-unit${ids.length === 1 ? '' : 's'} from verification, with their samples and checks?`)) return true;
        let n = 0; for (const id of ids) { try { await call('deleteVerification', { id }); n++; } catch { /* next */ } }
        toast(`Deleted ${n}`, 'ok'); vPicked.clear(); vs.data = null; redraw();
      }
      if (act === 'del-panel') {
        if (!confirm(`Delete ${a.dataset.name}${Number(a.dataset.n) ? ` and the ${a.dataset.n} class-unit(s) given to it, with their checks` : ''}? This cannot be undone.`)) return true;
        await call('deletePanel', { id: a.dataset.id }, 'Panel deleted'); vs.data = null; redraw();
      }
      if (act === 'del-ver') {
        if (!confirm(`Delete ${a.dataset.what} from verification, with its sample and checks? It goes back to the list to allocate again.`)) return true;
        await call('deleteVerification', { id: a.dataset.id }, 'Deleted'); vs.open = ''; vs.data = null; redraw();
      }
      if (act === 'clear-all') {
        if (prompt("This deletes this term's panels, everything given out, every check and the classes list. Type DELETE to go ahead.") !== 'DELETE') return true;
        await call('clearVerification', {}, "This term's verification is deleted"); vs.open = ''; vs.data = null; redraw();
      }
      if (act === 'draw') { const r = await call('redrawSample', { id: a.dataset.id }, 'Sample drawn'); upsertVer(r.verification); redraw(); }
      if (act === 'setup') {
        if (vs.data.panels.length && !confirm("This replaces this term's panels and everything given out with new ones. Go ahead?")) return true;
        su.size = Number($('#suSize')?.value) || 3;
        const codes = trainerRows().filter((s) => su.trainers.has(lower(s.code))).map((s) => s.code);
        const r = await call('setupVerification', { trainers: codes, classes: [...ls.picked], size: su.size });
        toast(`${r.panels} panel${r.panels === 1 ? '' : 's'} made from ${r.trainers} trainer${r.trainers === 1 ? '' : 's'}; ${r.classes.length} class${r.classes.length === 1 ? '' : 'es'} and ${r.allocated} unit${r.allocated === 1 ? '' : 's'} given out${r.relaxed?.length ? ` - ${r.relaxed.length} with the rules bent (see each one's history)` : ''}`, 'ok');
        vs.data = null; redraw();
      }
      if (act === 'allocate') {
        const r = await call('allocateVerification', {});
        toast(`${r.classes.length} class${r.classes.length === 1 ? '' : 'es'} to the panels, ${r.allocated} unit${r.allocated === 1 ? '' : 's'} given out${r.relaxed?.length ? ` - ${r.relaxed.length} with the rules bent` : ''}`, 'ok');
        vs.data = null; redraw();
      }
      if (act === 'list-add') { const r = await call('verifyListSave', { classes: [...ls.picked] }); toast(`${ls.picked.size} class${ls.picked.size === 1 ? '' : 'es'} added (${r.added} units)`, 'ok'); ls.picked.clear(); vs.data = null; redraw(); }
      if (act === 'list-remove') { await call('verifyListSave', { removeClasses: [a.dataset.cls] }, 'Removed from the list'); vs.data = null; redraw(); }
      if (act === 'ext-pick') {
        const admNos = (ext.pool || []).filter((s) => ext.picked.has(lower(s.admNo))).map((s) => s.admNo);
        const r = await call('externalSample', { id: v.id, admNos }, `Your sample: ${admNos.length} student${admNos.length === 1 ? '' : 's'}`); upsertVer(r.verification); vs.data = null; redraw();
      }
      if (act === 'redraw') {
        const reason = prompt('Why draw this sample again? (kept in its history)'); if (reason === null) return true;
        const r = await call('redrawSample', { id: a.dataset.id, reason }, 'A new sample was drawn'); upsertVer(r.verification); redraw();
      }
      if (act === 'save-check') await saveCheck(a.closest('.vcheck'));
      if (act === 'sign') { const r = await call('signVerification', { id: v.id }, 'Report signed'); upsertVer(r.verification); redraw(); }
      if (act === 'more') { const r = await call('moreSample', { id: v.id, count: 5 }, 'More students added to the sample'); upsertVer(r.verification); vs.data = null; redraw(); }
      if (act === 'xlsx') Tables.exportXlsx(`Verification ${v.classCode} ${v.unitCode}`, HEAD, reportRows(v));
      if (act === 'pdf') printReport(v);
    } catch (e) { toast(e.message, 'err'); }
    return true;
  }
  async function saveCheck(box) {
    const v = vs.data.verifications.find((x) => x.id === vs.open), get = (n) => box.querySelector(`[name="${n}"]`);
    const agree = get('agree').value === '' ? null : get('agree').value === '1';
    if (agree === null) { toast('Say whether you agree with the trainer\'s decision', 'err'); return; }
    const r = await call('saveCheck', { id: v.id, admNo: box.dataset.adm, valid: get('valid').checked, authentic: get('authentic').checked, current: get('current').checked,
      sufficient: get('sufficient').checked, agree, comment: get('comment').value.trim() }, 'Saved');
    const i = vs.data.checks.findIndex((c) => c.verificationId === v.id && lower(c.admNo) === lower(box.dataset.adm) && c.who === box.dataset.who);
    if (i >= 0) vs.data.checks[i] = r.check; else vs.data.checks.push(r.check);
    redraw();
  }
  async function onSubmit(form) {
    try {
      if (form.matches('.panel-form')) {
        const fd = new FormData(form);
        const set = memberSets.get(form.dataset.panel || 'new') || new Set();
        const r = await call('savePanel', { id: form.dataset.panel || undefined, number: Number(fd.get('number')), chair: fd.get('chair'), members: [...set] });
        memberSets.delete(form.dataset.panel || 'new');
        toast(`${r.panel.name} saved and approved`, 'ok');
        vs.data = null; redraw();
      } else if (form.matches('.assign-form')) {
        const fd = new FormData(form), [classCode, unitCode] = String(fd.get('cu')).split('|');
        const r = await call('assignVerification', { panelId: form.dataset.panel, classCode, unitCode, verifier: fd.get('verifier') });
        toast(`Given to ${staffName(r.verification.verifier)}: ${r.verification.size} of ${r.verification.population} students to check`, 'ok');
        upsertVer(r.verification); redraw();
      } else if (form.matches('.ver-submit')) {
        const fd = new FormData(form), v = vs.data.verifications.find((x) => x.id === vs.open);
        const r = await call('submitVerification', { id: v.id, result: fd.get('result'), actions: fd.get('actions') });
        if (r.extended) toast(r.extended === 'doubled' ? `Too many disagreements: the sample is doubled to ${r.verification.size}. Check the new students.` : `Still too many disagreements: every student (${r.verification.size}) is now in the sample.`, 'err');
        else toast('Result submitted. The chair or the HOD signs the report.', 'ok');
        upsertVer(r.verification); vs.data = null; redraw();
      } else if (form.matches('.ver-respond')) {
        const r = await call('respondVerification', { id: vs.open, response: new FormData(form).get('response') }, 'Response sent'); upsertVer(r.verification); redraw();
      } else if (form.matches('.ver-ext')) {
        const fd = new FormData(form);
        const r = await call('externalVerdict', { id: vs.open, result: fd.get('result'), note: fd.get('note') }, 'External result saved'); upsertVer(r.verification); redraw();
      } else return false;
    } catch (e) { toast(e.message, 'err'); }
    return true;
  }
  async function onChange(t) {
    if (t.matches('[data-ext]')) {
      try { const r = await call('setExternal', { id: t.dataset.ext, external: t.value }, t.value ? 'External Assessment Officer given' : 'External Assessment Officer removed'); upsertVer(r.verification); }
      catch (e) { toast(e.message, 'err'); }
      return true;
    }
    if (t.matches('.assign-form [name=cu]')) {
      // Nobody verifies a unit they teach: leave its trainers out of the list.
      const unit = t.value.split('|')[1] || '', own = new Set(vs.data.loading.filter((u) => u.unitCode === unit).map((u) => lower(u.trainerCode)));
      for (const o of t.form.querySelector('[name=verifier]').options) o.hidden = !!o.value && own.has(lower(o.value));
      return true;
    }
    if (t.matches('[data-vpick]')) { if (t.checked) vPicked.add(t.dataset.vpick); else vPicked.delete(t.dataset.vpick); redrawTable(t.closest('[data-vt]').dataset.vt); return true; }
    if (t.matches('[data-vpickall]')) {
      const key = t.dataset.vpickall, el = t.closest('[data-vt]');
      for (const b of el.querySelectorAll('[data-vpick]')) { if (t.checked) vPicked.add(b.dataset.vpick); else vPicked.delete(b.dataset.vpick); }
      redrawTable(key); return true;
    }
    if (t.matches('[data-spick]')) { if (t.checked) sPicked.add(t.dataset.spick); else sPicked.delete(t.dataset.spick); redrawTable(t.closest('[data-vt]').dataset.vt); return true; }
    if (t.matches('[data-spickall]')) { const el = t.closest('[data-vt]'); for (const b of el.querySelectorAll('[data-spick]')) { if (t.checked) sPicked.add(b.dataset.spick); else sPicked.delete(b.dataset.spick); } redrawTable(el.dataset.vt); return true; }
    if (t.id === 'efClass') { ef.cls = t.value; ef.unit = ''; Tables.reset('vExt'); redraw(); return true; }
    if (t.id === 'efUnit') { ef.unit = t.value; Tables.reset('vExt'); redraw(); return true; }
    if (t.matches('[data-trpick]')) { if (t.checked) su.trainers.add(lower(t.dataset.trpick)); else su.trainers.delete(lower(t.dataset.trpick)); redrawTable('vTr'); goState(); return true; }
    if (t.matches('[data-trall]')) { for (const s of vtShown('vTr', trainerRows(), trSearch)) { if (t.checked) su.trainers.add(lower(s.code)); else su.trainers.delete(lower(s.code)); } redrawTable('vTr'); goState(); return true; }
    if (t.matches('[data-lspick]')) { if (t.checked) ls.picked.add(t.dataset.lspick); else ls.picked.delete(t.dataset.lspick); redrawTable('vPick'); goState(); return true; }
    if (t.matches('[data-lsall]')) { for (const c of listFree()) { if (t.checked) ls.picked.add(c.code); else ls.picked.delete(c.code); } redrawTable('vPick'); goState(); return true; }
    if (t.matches('[data-mem]')) { const s = memberSets.get(t.dataset.mem) || new Set(); memberSets.set(t.dataset.mem, s); if (t.checked) s.add(lower(t.value)); else s.delete(lower(t.value));
      const lg = t.closest('fieldset')?.querySelector('legend .muted'); if (lg) lg.textContent = `(${s.size} chosen; staff already on another panel are not listed)`; return true; }
    if (t.matches('[data-extpick]')) { if (t.checked) ext.picked.add(lower(t.dataset.extpick)); else ext.picked.delete(lower(t.dataset.extpick)); return true; }
    return false;
  }
  const goState = () => { const b = $('[data-vact=setup]'); if (b) b.disabled = !(su.trainers.size && ls.picked.size); };
  const reset = () => { vs.data = null; vs.open = ''; };
  return { render, onClick, onSubmit, onChange, reset, state: vs };
})();
