/* Candidates for the summative assessment (Manage tab: Assessment Officers, the HOD and the MIS Officer).
 * Pick a class and unit and set the rules - the least attendance this term, which POE items must be in (all of them or at
 * least one, sent or approved), which marks must be in - and get the list of who can sit it, with the reasons for anyone
 * who cannot. Export to Excel or print / save as PDF. Uses app.js (api, state, $, $$, esc, toast, me, initials) and Tables. */
'use strict';

const Candidates = (() => {
  const POE = ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'PRAC1', 'PRAC2', 'PRAC3'];
  const MARKS = ['cat1', 'cat2', 'cat3', 'prac1', 'prac2', 'prac3'];
  const label = (i) => String(i).toUpperCase().replace(/^(CAT|PRAC)(\d)$/, '$1 $2');
  const cs = { cls: '', unit: '', res: null, show: 'yes', rules: { minAtt: 75, poe: { items: ['CAT1', 'CAT2'], need: 'all', approvedOnly: false }, marks: { items: ['cat1', 'cat2'], need: 'all' } } };
  try { const saved = JSON.parse(localStorage.getItem('candRules') || 'null'); if (saved) cs.rules = saved; } catch { /* private mode */ }
  const allowed = () => hasRole('IAO') || hasRole('HOD') || hasRole('MIS');

  const classes = () => [...new Set(state.units.map((u) => u.classCode))].sort();
  const unitsOf = (cls) => state.units.filter((u) => u.classCode === cls).sort((a, b) => a.name.localeCompare(b.name));
  function html() {
    if (!cs.cls) cs.cls = classes()[0] || '';
    if (!unitsOf(cs.cls).some((u) => u.code === cs.unit)) cs.unit = unitsOf(cs.cls)[0]?.code || '';
    const r = cs.rules, tick = (name, list, items) => list.map((i) => `<label class="kchip"><input type="checkbox" name="${name}" value="${i}"${items.includes(i) ? ' checked' : ''}><span>${label(i)}</span></label>`).join('');
    return `<p class="muted small">Who can sit a unit's summative assessment: set the rules, then get the list. The rules are remembered on this device.</p>
      <div class="cand-form">
        <div class="poe-filters"><select id="cdClass" aria-label="Class">${classes().map((c) => `<option${c === cs.cls ? ' selected' : ''}>${esc(c)}</option>`).join('') || '<option value="">No classes this term</option>'}</select>
          <select id="cdUnit" aria-label="Unit">${unitsOf(cs.cls).map((u) => `<option value="${esc(u.code)}"${u.code === cs.unit ? ' selected' : ''}>${esc(u.code)} - ${esc(u.name)}</option>`).join('')}</select></div>
        <label class="cd-att">Least attendance this term (%)<input id="cdAtt" type="number" min="0" max="100" step="1" value="${r.minAtt}"></label>
        <fieldset class="cd-rule"><legend>POE sent</legend><div class="chips">${tick('cdPoe', POE, r.poe.items)}</div>
          <select id="cdPoeNeed" aria-label="POE rule"><option value="all"${r.poe.need === 'all' ? ' selected' : ''}>All ticked</option><option value="any"${r.poe.need === 'any' ? ' selected' : ''}>At least one of them</option></select>
          <label class="check small"><input type="checkbox" id="cdApproved"${r.poe.approvedOnly ? ' checked' : ''}> Approved only</label></fieldset>
        <fieldset class="cd-rule"><legend>Marks in</legend><div class="chips">${tick('cdMark', MARKS, r.marks.items)}</div>
          <select id="cdMarkNeed" aria-label="Marks rule"><option value="all"${r.marks.need === 'all' ? ' selected' : ''}>All ticked</option><option value="any"${r.marks.need === 'any' ? ' selected' : ''}>At least one of them</option></select></fieldset>
        <div class="row-actions"><button type="button" class="btn primary" id="cdGo">Get the list</button></div>
      </div>
      <div id="cdOut">${cs.res ? resultHtml() : ''}</div>`;
  }
  function readRules() {
    const r = {
      minAtt: Math.max(0, Math.min(100, Number($('#cdAtt').value) || 0)),
      poe: { items: $$('input[name=cdPoe]:checked').map((i) => i.value), need: $('#cdPoeNeed').value, approvedOnly: $('#cdApproved').checked },
      marks: { items: $$('input[name=cdMark]:checked').map((i) => i.value), need: $('#cdMarkNeed').value },
    };
    try { localStorage.setItem('candRules', JSON.stringify(r)); } catch { /* private mode */ }
    return (cs.rules = r);
  }
  const ruleText = (r) => [r.minAtt ? `attendance at least ${r.minAtt}%` : '',
    r.poe.items.length ? `POE ${r.poe.approvedOnly ? 'approved' : 'sent'} for ${r.poe.need === 'all' ? r.poe.items.map(label).join(' and ') : 'at least one of ' + r.poe.items.map(label).join(', ')}` : '',
    r.marks.items.length ? `marks in for ${r.marks.need === 'all' ? r.marks.items.map(label).join(' and ') : 'at least one of ' + r.marks.items.map(label).join(', ')}` : ''].filter(Boolean).join(' - ') || 'no rules';
  async function go(btn) {
    if (!cs.cls || !cs.unit) { toast('Choose the class and unit', 'err'); return; }
    btn.disabled = true;
    try {
      const r = await api('candidates', { classCode: cs.cls, unitCode: cs.unit, rules: readRules() });
      if (!r.ok) throw new Error(r.error);
      cs.res = r; cs.show = r.students.some((s) => s.eligible) ? 'yes' : ''; Tables.reset('cand');   // nobody can sit: show everyone, with the reasons
      $('#cdOut').innerHTML = resultHtml();
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  }
  const SYM = { approved: '✓', submitted: '•', returned: '↺' };
  const poeText = (s, r) => (r.rules.poe.items.length ? r.rules.poe.items : POE.filter((i) => s.poe[i])).map((i) => `${label(i)} ${SYM[s.poe[i]] || '–'}`).join(' ');
  const markText = (s, r) => (r.rules.marks.items.length ? r.rules.marks.items : MARKS.filter((c) => s.marks[c] !== null)).map((c) => `${label(c)} ${s.marks[c] ?? '–'}`).join(' ');
  const shown = () => cs.res.students.filter((s) => cs.show === '' || (cs.show === 'yes' ? s.eligible : !s.eligible));
  function resultHtml() {
    const r = cs.res, yes = r.students.filter((s) => s.eligible).length, list = shown(), page = Tables.slice('cand', list);
    const chips = [['yes', 'Can sit', yes], ['no', 'Cannot sit', r.students.length - yes], ['', 'All', r.students.length]]
      .map(([k, l, n]) => `<button type="button" class="chipbtn${cs.show === k ? ' on' : ''}" data-cdshow="${k}">${l} <span class="n">${n}</span></button>`).join('');
    return `<div class="cand-res"><p><b>${yes} of ${r.students.length}</b> can sit ${esc(r.unitCode)} - ${esc(r.unitName)} (${esc(r.classCode)}, ${esc(r.term.name)}, ${r.lessonsHeld} lessons so far).</p>
      <p class="muted small">Rules: ${esc(ruleText(r.rules))}. POE: ✓ approved - • with the trainer - ↺ returned - – not sent.</p>
      <div class="chips" role="group" aria-label="Show">${chips}</div>
      ${list.length ? `<div class="table-wrap"><table class="report-table cand-table"><thead><tr><th>S/NO</th><th>Admission no.</th><th>Name</th><th class="num">Attendance</th><th>POE</th><th>Marks</th><th>Can sit</th></tr></thead>
      <tbody>${page.map((s) => `<tr class="${s.eligible ? '' : 'below'}"><td>${r.students.indexOf(s) + 1}</td><td class="tadm">${esc(s.admNo)}</td><td><b>${esc(s.name)}</b></td>
        <td class="num">${s.att === null ? '–' : s.att + '%'}</td><td class="small">${esc(poeText(s, r))}</td><td class="small">${esc(markText(s, r))}</td>
        <td>${s.eligible ? '<span class="pill synced">Yes</span>' : `<span class="pill rejected">No</span><br><small>${esc(s.reasons.join(' - '))}</small>`}</td></tr>`).join('')}</tbody></table></div>${Tables.bar('cand', list)}`
        : '<p class="muted">Nobody here.</p>'}
      <div class="row-actions table-actions"><button type="button" class="btn" data-cdact="xlsx"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel</button>
        <button type="button" class="btn" data-cdact="pdf"><svg class="i" aria-hidden="true"><use href="#i-print"/></svg>Save as PDF</button></div></div>`;
  }
  function sheet(list) {
    const r = cs.res;
    return { head: ['S/NO', 'Admission no.', 'Reg code', 'Name', 'Attendance %', 'POE', 'Marks', 'Can sit', 'Why not'],
      rows: list.map((s, i) => [i + 1, s.admNo, s.regCode, s.name, s.att ?? '', poeText(s, r), markText(s, r), s.eligible ? 'Yes' : 'No', s.reasons.join(' - ')]) };
  }
  /** The printed list: the department heading, the class, unit and rules, the table, and who prepared it. */
  function print(list) {
    const r = cs.res, { head, rows } = sheet(list), who = me()?.name || '';
    $('#printArea').innerHTML = `<div class="tbl-print cand-print"><div class="rp-head"><img src="icons/rvnp-logo.png" alt=""><div class="rp-title">
      <h1>RIFT VALLEY NATIONAL POLYTECHNIC</h1><h2>DEPARTMENT OF COMPUTING AND INFORMATICS</h2><h2>CANDIDATES FOR SUMMATIVE ASSESSMENT</h2>
      <table class="rp-fields"><tr><th>CLASS</th><td>${esc(r.classCode)}</td><th>TERM</th><td>${esc(r.term.duration || r.term.name)}</td></tr>
      <tr><th>UNIT</th><td>${esc(r.unitCode)} - ${esc(r.unitName)}</td><th>SERIES</th><td>${esc(r.term.series)}</td></tr>
      <tr><th>TRAINER</th><td colspan="3">${esc(r.trainer)}</td></tr></table>
      <p>Rules: ${esc(ruleText(r.rules))} - ${list.filter((s) => s.eligible).length} of ${list.length} listed can sit</p></div></div>
      <table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((x) => `<tr>${x.map((c) => `<td>${esc(c ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <table class="sign-lines"><tr><th>Prepared by</th><td>${esc(who)}</td><th>Signature</th><td class="sig">${esc(initials(who))}</td><th>Date</th><td>${esc(fmtShort(new Date().toISOString()))}</td></tr>
      <tr><th>Approved by</th><td></td><th>Signature</th><td></td><th>Date</th><td></td></tr></table></div>`;
    document.body.classList.add('printing', 'print-table');
    const done = () => { document.body.classList.remove('printing', 'print-table'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 80);
  }

  function wire() {
    document.addEventListener('change', (e) => {
      if (e.target.id === 'cdClass') { cs.cls = e.target.value; cs.unit = ''; cs.res = null; Admin.redrawCandidates?.(); }
      if (e.target.id === 'cdUnit') { cs.unit = e.target.value; cs.res = null; $('#cdOut').innerHTML = ''; }
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#m-candidates')) return;
      if (e.target.closest('#cdGo')) go(e.target.closest('#cdGo'));
      const sh = e.target.closest('[data-cdshow]'); if (sh) { cs.show = sh.dataset.cdshow; Tables.reset('cand'); $('#cdOut').innerHTML = resultHtml(); }
      const a = e.target.closest('[data-cdact]');
      if (a && cs.res) {
        const list = shown(), title = `Candidates ${cs.res.classCode} ${cs.res.unitCode}`;
        if (a.dataset.cdact === 'xlsx') { const { head, rows } = sheet(list); Tables.exportXlsx(title, head, rows); } else print(list);
      }
    });
    Tables.on('cand', () => { if ($('#cdOut') && cs.res) $('#cdOut').innerHTML = resultHtml(); });
  }
  wire();
  return { html, allowed };
})();
window.Candidates = Candidates;
