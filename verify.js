/* POE tab → Verification: internal verification of POE evidence.
 *  - The MIS Officer or the Internal Assessment Officer drafts a panel (a chair and members); it is approved at once (the
 *    HOD can return it).
 *  - The MIS Officer lists the class-units to verify; "Allocate" gives them out across the panels (biggest classes first,
 *    balanced by students) and to two members each, picked at random among the least loaded, never anyone who teaches the
 *    unit. The server draws the sample: everyone up to 10 students, otherwise max(10, ⌈√N × risk⌉), always including
 *    students returned-then-approved, files changed after sending and one from each third of the marks.
 *  - Both members check every sampled student (valid, authentic, current, sufficient; agree with the trainer?) and each
 *    gives a result; the report takes the stricter. Too many disagreements doubles the sample, then takes in everyone.
 *  - The trainer responds; the chair or the HOD signs. The External Assessment Officer sees every panel's class-units,
 *    can pick their own sample by class and unit, and gives their own result.
 * Uses app.js (api, $, $$, esc, toast, hasRole, me, fmtTime, lower) and PoeStaff (evidence list and preview). */
'use strict';

const Verify = (() => {
  const vs = { data: null, open: '', seq: 0 };
  const RESULT = { verified: 'Verified', actions: 'Verified with actions', not_verified: 'Not verified' };
  const STAT = { open: ['pending', 'In progress'], submitted: ['wait', 'Submitted'], signed: ['synced', 'Signed'] };
  const PSTAT = { draft: ['pending', 'Waiting for the HOD'], approved: ['synced', 'Approved'], returned: ['rejected', 'Returned by the HOD'] };
  const slotOf = (v) => (isMe(v.verifier) ? 'internal' : v.verifier2 && isMe(v.verifier2) ? 'second' : '');
  const external = () => hasRole('EAO');
  const both = (v) => [v.verifier, v.verifier2].filter(Boolean).map(staffName).join(' and ');
  const office = () => hasRole('MIS') || hasRole('IAO') || hasRole('HOD');
  const drafts = () => hasRole('MIS') || hasRole('IAO');
  const isMe = (code) => lower(code) === lower(me()?.code || '');
  const staffName = (code) => vs.data?.staff.find((s) => lower(s.code) === lower(code))?.name || code;
  const nameOf = (adm) => vs.data?.names[lower(adm)] || PoeStaff.state.list.find((e) => lower(e.admNo) === lower(adm))?.name || adm;
  const checkOf = (v, adm, who) => vs.data.checks.find((c) => c.verificationId === v.id && lower(c.admNo) === lower(adm) && c.who === who);
  const evidenceOf = (v, adm) => PoeStaff.state.list.filter((e) => e.classCode === v.classCode && e.unitCode === v.unitCode && lower(e.admNo) === lower(adm) && e.status === 'approved')
    .sort((a, b) => a.item.localeCompare(b.item, undefined, { numeric: true }));
  const pill = ([cls, label]) => `<span class="pill ${cls}">${esc(label)}</span>`;

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
    if (mine.length) parts.push(card('Class-units given to you', 'You and one other member each check every student in the sample, then each give a result.', table(mine)));
    if (external()) parts.push(card('What each panel was given', 'Every class-unit given out this term. Open one to see the panel\'s checks, pick your own sample of students and give your result.',
      d.panels.map((p) => `<h3 class="ver-ph">${esc(p.name)} <span class="muted small">chair ${esc(staffName(p.chair))}</span></h3>${table(d.verifications.filter((v) => v.panelId === p.id))}`).join('') || '<p class="muted small">Nothing given out yet.</p>'));
    if (units.length) parts.push(card('Verification of your units', 'What the panel found in your units, and your response.', table(units)));
    if (drafts()) parts.push(listCard());
    if (office() || (d.panels.length && !external())) parts.push(panelsCard());
    if (!parts.length) parts.push('<div class="card notice"><h2>Nothing to verify</h2><p class="muted">When a panel gives you a class and unit to verify, or verifies one of your units, it shows here.</p></div>');
    box.innerHTML = head + parts.join('');
  }
  const card = (title, sub, body) => `<section class="card"><div class="msec-head"><h2>${esc(title)}</h2></div><p class="muted small">${esc(sub)}</p>${body}</section>`;

  /** Verifications as a table: class, unit, trainer, verifier, sample, status, result. */
  function table(list, opts = {}) {
    if (!list.length) return '<p class="muted small">None yet.</p>';
    return `<div class="table-wrap"><table class="report-table ver-table"><thead><tr><th>Class</th><th>Unit</th><th>Trainer</th><th>Verifiers</th><th class="num">Sample</th><th>Status</th><th>Result</th><th><span class="sr">Open</span></th></tr></thead>
      <tbody>${list.map((v) => {
        const done = (who) => vs.data.checks.filter((c) => c.verificationId === v.id && c.who === who && c.agree !== null).length;
        return `<tr><td>${esc(v.classCode)}</td><td title="${esc(v.unitName)}">${esc(v.unitCode)}</td><td>${esc(v.trainerName || v.trainerCode)}</td>
          <td>${esc(staffName(v.verifier))}${v.v1.at ? ' ✓' : ''}${v.verifier2 ? `<br>${esc(staffName(v.verifier2))}${v.v2.at ? ' ✓' : ''}` : ''}</td>
          <td class="num" title="${v.size} of ${v.population} students with approved evidence">${!v.sample.length ? '<span class="muted small">not drawn</span>' : `${v.status === 'open' ? `${done('internal')}+${done('second')} / ` : ''}${v.size} of ${v.population}`}</td>
          <td>${pill(STAT[v.status] || ['pending', v.status])}</td><td>${v.result ? esc(RESULT[v.result]) : '–'}${v.extResult ? `<br><small class="muted">External: ${esc(RESULT[v.extResult])}</small>` : ''}</td>
          <td><button type="button" class="btn small" data-vopen="${esc(v.id)}">Open</button>${!v.sample.length && office() ? ` <button type="button" class="btn small primary" data-vact="draw" data-id="${esc(v.id)}">Draw the sample</button>`
            : opts.hod && v.status === 'open' ? ` <button type="button" class="btn small ghost" data-vact="redraw" data-id="${esc(v.id)}">Draw again</button>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>`;
  }

  /* ---------- panels ---------- */
  function panelsCard() {
    const d = vs.data, people = d.staff.filter((s) => !(s.roles.length && s.roles.every((r) => r === 'EAO')));
    const opts = (sel) => people.map((s) => `<option value="${esc(s.code)}"${lower(s.code) === lower(sel || '') ? ' selected' : ''}>${esc(s.name)} (${esc(s.code)})</option>`).join('');
    const form = (p) => `<form class="panel-form" data-panel="${esc(p?.id || '')}">
        <label>Panel name<input name="name" required maxlength="80" value="${esc(p?.name || '')}" placeholder="e.g. Term 3 2026 panel A"></label>
        <label>Chair<select name="chair" required><option value="">Choose…</option>${opts(p?.chair)}</select></label>
        <fieldset class="members"><legend>Members</legend>${people.map((s) => `<label class="kchip"><input type="checkbox" name="member" value="${esc(s.code)}"${(p?.members || []).some((m) => lower(m) === lower(s.code)) ? ' checked' : ''}><span>${esc(s.name)}</span></label>`).join('')}</fieldset>
        <button class="btn primary">${p ? 'Save the panel' : 'Draft the panel'}</button></form>`;
    const rows = d.panels.map((p) => {
      const vers = d.verifications.filter((v) => v.panelId === p.id);
      return `<details class="mdone panel"${p.status !== 'approved' || vers.length ? ' open' : ''}><summary><b>${esc(p.name)}</b> ${pill(PSTAT[p.status] || ['pending', p.status])}
          <span class="muted small">Chair ${esc(staffName(p.chair))} - ${p.members.length} member${p.members.length === 1 ? '' : 's'}</span></summary>
        <p class="small">${p.members.map((m) => esc(staffName(m)) + (lower(m) === lower(p.chair) ? ' (chair)' : '')).join(', ')}</p>
        ${p.note ? `<p class="small warn-text">HOD: ${esc(p.note)}</p>` : ''}
        ${p.decidedBy === 'Approved automatically' ? '<p class="muted tiny">Approved automatically when saved.</p>' : ''}
        ${hasRole('HOD') && p.status === 'approved' ? `<div class="row-actions"><input class="hod-note" data-note="${esc(p.id)}" placeholder="Why return it?"><button type="button" class="btn small" data-vact="return-panel" data-id="${esc(p.id)}">Return the panel</button></div>` : ''}
        ${hasRole('HOD') && ['draft', 'returned'].includes(p.status) ? `<div class="row-actions"><input class="hod-note" data-note="${esc(p.id)}" placeholder="Note (needed to return)"><button type="button" class="btn small" data-vact="return-panel" data-id="${esc(p.id)}">Return</button><button type="button" class="btn small primary" data-vact="approve-panel" data-id="${esc(p.id)}">Approve the panel</button></div>` : ''}
        ${p.status === 'approved' ? table(vers, { hod: hasRole('HOD') }) + (drafts() ? assignForm(p, vers) : '') : ''}
        ${drafts() ? `<details class="mdone"><summary>Change this panel</summary>${form(p)}</details>` : ''}</details>`;
    }).join('');
    return card('Verification panels', drafts() ? 'Draft a panel: it is approved for the HOD straight away (the HOD can return it). The master list above gives out the class-units; you can also give one by hand below.' : 'Panels drafted by the MIS Officer or the Internal Assessment Officer.',
      (rows || '<p class="muted small">No panels yet.</p>') + (drafts() ? `<details class="mdone"><summary>Draft a new panel</summary>${form(null)}</details>` : ''));
  }
  function assignForm(p, vers) {
    const taken = new Set(vers.map((v) => v.classCode + '|' + v.unitCode));
    const opts = vs.data.loading.filter((u) => !taken.has(u.classCode + '|' + u.unitCode)).sort((a, b) => (a.classCode + a.unitCode).localeCompare(b.classCode + b.unitCode));
    const eaos = vs.data.staff.filter((s) => s.roles.includes('EAO'));
    return `<form class="assign-form" data-panel="${esc(p.id)}">
        <label>Class and unit<select name="cu" required><option value="">Choose…</option>${opts.map((u) => `<option value="${esc(u.classCode + '|' + u.unitCode)}" data-trainer="${esc(u.trainerCode)}">${esc(u.classCode)} - ${esc(u.unitCode)} ${esc(u.unitName)} (${esc(u.trainerName || u.trainerCode)})</option>`).join('')}</select></label>
        <label>First verifier<select name="verifier" required><option value="">Choose…</option>${p.members.map((m) => `<option value="${esc(m)}">${esc(staffName(m))}</option>`).join('')}</select></label>
        <label>Second verifier<select name="verifier2" required><option value="">Choose…</option>${p.members.map((m) => `<option value="${esc(m)}">${esc(staffName(m))}</option>`).join('')}</select></label>
        <button class="btn primary">Give it and draw the sample</button>
      </form>
      ${eaos.length && vers.length ? `<div class="ext-assign"><b class="small">External Assessment Officer</b>${vers.map((v) => `<label class="small">${esc(v.classCode)} - ${esc(v.unitCode)}
        <select data-ext="${esc(v.id)}"><option value="">None</option>${eaos.map((s) => `<option value="${esc(s.code)}"${lower(s.code) === lower(v.external) ? ' selected' : ''}>${esc(s.name)}${s.endsOn ? ` (until ${esc(s.endsOn)})` : ''}</option>`).join('')}</select></label>`).join('')}</div>` : ''}`;
  }

  /* ---------- the master list: what to verify this term, given out automatically ---------- */
  const ls = { q: '', picked: new Set() };
  function listCard() {
    const d = vs.data, on = new Set(d.list.map((r) => r.classCode + '|' + r.unitCode)), q = ls.q.trim().toLowerCase();
    const free = d.loading.filter((u) => !on.has(u.classCode + '|' + u.unitCode)).filter((u) => !q || [u.classCode, u.unitCode, u.unitName, u.trainerName].some((s) => String(s || '').toLowerCase().includes(q)))
      .sort((a, b) => (a.classCode + a.unitCode).localeCompare(b.classCode + b.unitCode));
    const given = d.list.filter((r) => r.verificationId).length;
    const vOf = (r) => d.verifications.find((v) => v.id === r.verificationId);
    return card('Master list', `The class-units to verify this term (${d.list.length}, ${given} given out). Allocate gives the rest to the panels - the biggest classes first, balanced by students - and to two members each, picked at random, never anyone who teaches the unit.`,
      `${d.list.length ? `<div class="table-wrap"><table class="report-table ver-table"><thead><tr><th>Class</th><th>Unit</th><th>Trainer</th><th class="num">Students</th><th>Given to</th><th><span class="sr">Remove</span></th></tr></thead><tbody>
        ${d.list.map((r) => { const v = vOf(r), p = v && d.panels.find((x) => x.id === v.panelId); return `<tr><td>${esc(r.classCode)}</td><td title="${esc(r.unitName)}">${esc(r.unitCode)} <small class="muted">${esc(r.unitName)}</small></td><td>${esc(r.trainerName || r.trainerCode)}</td><td class="num">${r.students}</td>
          <td>${v ? `${esc(p?.name || '')}<br><small>${esc(both(v))}</small>` : '<span class="muted small">not yet</span>'}</td>
          <td>${v ? '' : `<button type="button" class="btn small ghost" data-vact="list-remove" data-cu="${esc(r.classCode + '|' + r.unitCode)}">Remove</button>`}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted small">Nothing on the list yet.</p>'}
      <div class="row-actions"><button type="button" class="btn primary" data-vact="allocate"${d.list.length > given ? '' : ' disabled'}>Allocate ${d.list.length - given} to the panels</button></div>
      <details class="mdone"${d.list.length ? '' : ' open'}><summary>Add class-units to the list</summary>
        <input type="search" class="ls-search" placeholder="Filter by class, unit or trainer" value="${esc(ls.q)}" aria-label="Filter class-units">
        <div class="row-actions"><label class="kchip"><input type="checkbox" data-lsall${free.length && free.every((u) => ls.picked.has(u.classCode + '|' + u.unitCode)) ? ' checked' : ''}><span>All ${free.length} shown</span></label>
          <button type="button" class="btn small primary" data-vact="list-add"${ls.picked.size ? '' : ' disabled'}>Add ${ls.picked.size || ''} to the list</button></div>
        <div class="ls-pick">${free.map((u) => { const k = u.classCode + '|' + u.unitCode; return `<label class="kchip"><input type="checkbox" data-lspick="${esc(k)}"${ls.picked.has(k) ? ' checked' : ''}><span>${esc(u.classCode)} - ${esc(u.unitCode)} <small>${esc(u.trainerName || u.trainerCode)}</small></span></label>`; }).join('') || '<span class="muted small">Every class-unit is on the list.</span>'}</div>
      </details>`);
  }
  const listFree = () => { const on = new Set(vs.data.list.map((r) => r.classCode + '|' + r.unitCode)), q = ls.q.trim().toLowerCase();
    return vs.data.loading.filter((u) => !on.has(u.classCode + '|' + u.unitCode) && (!q || [u.classCode, u.unitCode, u.unitName, u.trainerName].some((s) => String(s || '').toLowerCase().includes(q)))); };

  /* ---------- the external officer's own sample ---------- */
  const ext = { pool: null, for: '' };
  function extBox(v) {
    if (!external()) return '';
    if (ext.for !== v.id) { ext.for = v.id; ext.pool = null; api('verifyPool', { id: v.id }).then((r) => { if (r.ok && ext.for === v.id) { ext.pool = r.students; redraw(); } }); }
    const mine = new Set(v.extSample.map(lower));
    return `<details class="mdone ext-own" open><summary>Your own sample</summary>
      <p class="muted small">Pick the students you want to verify yourself from those with approved evidence in this class and unit. ${v.extSample.length} picked.</p>
      ${!ext.pool ? '<p class="muted small">Loading the students…</p>' : `<div class="ls-pick">${ext.pool.map((s) => `<label class="kchip"><input type="checkbox" name="extpick" value="${esc(s.admNo)}"${mine.has(lower(s.admNo)) ? ' checked' : ''}><span>${esc(s.name)} <small>${esc(s.admNo)}${s.inSample ? ' - in the panel\'s sample' : ''}</small></span></label>`).join('') || '<span class="muted small">No approved evidence yet.</span>'}</div>
      <div class="row-actions"><button type="button" class="btn small primary" data-vact="ext-pick">Save my sample</button></div>`}</details>`;
  }

  /* ---------- one class-unit ---------- */
  function detail(v) {
    const d = vs.data, slot = slotOf(v), mySub = slot === 'internal' ? v.v1 : slot === 'second' ? v.v2 : null;
    const mineInt = !!slot && v.status === 'open' && !mySub?.at, mineExt = external();
    const extList = v.extSample.filter((a) => !v.sample.some((s) => lower(s) === lower(a)));
    const sample = [...v.sample, ...extList];
    const showExt = mineExt || !!v.extResult || d.checks.some((c) => c.verificationId === v.id && c.who === 'external');
    const checked = v.sample.filter((a) => checkOf(v, a, slot || 'internal')?.agree != null).length;
    const against = v.sample.filter((a) => checkOf(v, a, 'internal')?.agree === false || checkOf(v, a, 'second')?.agree === false).length;
    const order = sample.flatMap((a) => evidenceOf(v, a).map((e) => e.id));
    const extEdit = (adm) => mineExt && (v.extSample.some((s) => lower(s) === lower(adm)) || ['submitted', 'signed'].includes(v.status));
    const panel = d.panels.find((p) => p.id === v.panelId);
    const canSign = v.status === 'submitted' && (hasRole('HOD') || (panel && isMe(panel.chair)));
    const rows = sample.map((adm) => {
      const ev = evidenceOf(v, adm);
      return `<tr><td><b>${esc(nameOf(adm))}</b><br><span class="tadm">${esc(adm.toUpperCase())}</span></td>
        <td class="small">${esc(v.reasons[adm] || (extList.includes(adm) ? "the external officer's choice" : ''))}</td>
        <td>${ev.length ? ev.map((e) => `<button type="button" class="btn small" data-vview="${esc(e.id)}" data-order="${esc(order.join(','))}">${esc(e.item)}</button>`).join(' ') : '<span class="muted small">no approved file</span>'}</td>
        <td>${extList.includes(adm) ? '' : checkCell(v, adm, 'internal', mineInt && slot === 'internal')}</td>
        <td>${extList.includes(adm) || !v.verifier2 ? '' : checkCell(v, adm, 'second', mineInt && slot === 'second')}</td>${showExt ? `<td>${checkCell(v, adm, 'external', extEdit(adm))}</td>` : ''}</tr>`;
    }).join('');
    const firstLog = v.log[0]?.what || '';
    return `<section class="card ver-detail">
      <div class="msec-head"><h2>${esc(v.classCode)} - ${esc(v.unitCode)} ${esc(v.unitName)}</h2><button type="button" class="btn small ghost" data-vact="back">‹ Back</button></div>
      <p class="small">Trainer <b>${esc(v.trainerName || v.trainerCode)}</b> - verifiers <b>${esc(both(v))}</b>${v.external ? ` - external <b>${esc(staffName(v.external))}</b>` : ''} - ${pill(STAT[v.status] || ['pending', v.status])}</p>
      ${!v.sample.length ? `<p class="warn-text small">No sample yet: no evidence in this class and unit was approved when it was given out.${office() ? ' <button type="button" class="btn small primary" data-vact="draw" data-id="' + esc(v.id) + '">Draw the sample now</button>' : ''}</p>` : ''}
      ${v.status === 'open' && (v.v1.at || v.v2.at) ? `<p class="small">${[['v1', v.verifier], ['v2', v.verifier2]].filter(([k]) => v[k].at).map(([k, c]) => `${esc(staffName(c))} submitted: <b>${esc(RESULT[v[k].result])}</b>`).join(' - ')} - waiting for the other verifier.</p>` : ''}
      <p class="small">Sample: <b>${v.size}</b> of ${v.population} students with approved evidence${v.risk > 1 ? ` (higher risk × ${v.risk})` : ''}. ${esc(firstLog)}${v.round > 1 ? ` <b class="warn-text">${v.round === 2 ? 'The sample was doubled after disagreements.' : 'Every student is now in the sample.'}</b>` : ''}</p>
      ${v.status === 'open' && slot ? `<p class="small">You have checked ${checked} of ${v.sample.length}${against ? ` - <b class="warn-text">${against} disagreement${against === 1 ? '' : 's'} between you</b>` : ''}</p>` : ''}
      <div class="table-wrap"><table class="report-table ver-sample"><thead><tr><th>Student</th><th>Why in the sample</th><th>Approved evidence</th><th>${esc(staffName(v.verifier))}</th><th>${esc(v.verifier2 ? staffName(v.verifier2) : '')}</th>${showExt ? '<th>External check</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
      ${extBox(v)}
      ${mineInt ? `<form class="ver-submit"><h3>Your result</h3>
        <label>Result<select name="result" required><option value="">Choose…</option>${Object.entries(RESULT).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
        <label>Actions for the trainer <span class="muted small">(needed unless verified)</span><textarea name="actions" rows="3" maxlength="2000"></textarea></label>
        <button class="btn primary">Submit the result</button></form>` : ''}
      ${v.status !== 'open' ? `<div class="ver-result"><h3>Result: ${esc(RESULT[v.result] || '')}</h3>
        ${v.v1.at || v.v2.at ? `<p class="small">${[['v1', v.verifier], ['v2', v.verifier2]].filter(([k]) => v[k].at).map(([k, c]) => `${esc(staffName(c))}: ${esc(RESULT[v[k].result])}`).join(' - ')} (the report takes the stricter)</p>` : ''}
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
    return v.sample.map((adm, i) => [i + 1, adm.toUpperCase(), nameOf(adm), v.reasons[adm] || '', one(checkOf(v, adm, 'internal')), one(checkOf(v, adm, 'second')), one(checkOf(v, adm, 'external'))]);
  }
  const HEAD = ['#', 'Admission no.', 'Name', 'Why in the sample', 'First verifier (ticks - decision)', 'Second verifier', 'External'];
  function printReport(v) {
    const panel = vs.data.panels.find((p) => p.id === v.panelId);
    const chairSigned = !!(v.signedAt && panel && lower(staffName(panel.chair)) === lower(v.signedBy || ''));
    $('#printArea').innerHTML = `<div class="tbl-print ver-print"><h1>INTERNAL VERIFICATION REPORT</h1>
      <p>${esc(v.classCode)} - ${esc(v.unitCode)} ${esc(v.unitName)} - trainer ${esc(v.trainerName || v.trainerCode)}</p>
      <p>Panel: ${esc(panel?.name || '')} - verifiers ${esc(both(v))} - sample ${v.size} of ${v.population}${v.risk > 1 ? ` (risk × ${v.risk})` : ''}</p>
      <table><thead><tr>${HEAD.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${reportRows(v).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <p><b>Result:</b> ${esc(RESULT[v.result] || 'not given yet')}${v.actions ? ` - <b>Actions:</b> ${esc(v.actions)}` : ''}</p>
      ${v.response ? `<p><b>Trainer's response:</b> ${esc(v.response)}</p>` : ''}
      <table class="sign-lines"><tr><th>First verifier</th><td>${esc(staffName(v.verifier))}</td><th>Signature</th><td class="sig">${v.v1.at ? esc(initials(staffName(v.verifier))) : ''}</td><th>Date</th><td>${esc(v.v1.at ? fmtShort(v.v1.at) : '')}</td></tr>
        ${v.verifier2 ? `<tr><th>Second verifier</th><td>${esc(staffName(v.verifier2))}</td><th>Signature</th><td class="sig">${v.v2.at ? esc(initials(staffName(v.verifier2))) : ''}</td><th>Date</th><td>${esc(v.v2.at ? fmtShort(v.v2.at) : '')}</td></tr>` : ''}
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
    const o = t.closest('[data-vopen]'); if (o) { vs.open = o.dataset.vopen; redraw(); return true; }
    const w = t.closest('[data-vview]'); if (w) { PoeStaff.open(w.dataset.vview, w.dataset.order.split(',')); return true; }
    const a = t.closest('[data-vact]'); if (!a) return false;
    const act = a.dataset.vact, v = vs.data?.verifications.find((x) => x.id === vs.open);
    try {
      if (act === 'reload') { vs.data = null; redraw(); }
      if (act === 'back') { vs.open = ''; redraw(); }
      if (act === 'approve-panel' || act === 'return-panel') {
        const note = $(`[data-note="${a.dataset.id}"]`)?.value.trim() || '';
        await call('decidePanel', { id: a.dataset.id, decision: act === 'approve-panel' ? 'approved' : 'returned', note }, act === 'approve-panel' ? 'Panel approved' : 'Panel returned');
        vs.data = null; redraw();
      }
      if (act === 'draw') { const r = await call('redrawSample', { id: a.dataset.id }, 'Sample drawn'); upsertVer(r.verification); redraw(); }
      if (act === 'allocate') {
        const r = await call('allocateVerification', {});
        toast(`${r.allocated} class-unit${r.allocated === 1 ? '' : 's'} given out${r.skipped.length ? ` - ${r.skipped.length} could not be: ${r.skipped[0].why}` : ''}`, r.skipped.length ? 'err' : 'ok');
        vs.data = null; redraw();
      }
      if (act === 'list-add') { await call('verifyListSave', { items: [...ls.picked].map((k) => { const [classCode, unitCode] = k.split('|'); return { classCode, unitCode }; }) }, 'Added to the list'); ls.picked.clear(); vs.data = null; redraw(); }
      if (act === 'list-remove') { const [classCode, unitCode] = a.dataset.cu.split('|'); await call('verifyListSave', { remove: [{ classCode, unitCode }] }, 'Removed from the list'); vs.data = null; redraw(); }
      if (act === 'ext-pick') {
        const admNos = $$('input[name=extpick]:checked').map((i) => i.value);
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
        await call('savePanel', { id: form.dataset.panel || undefined, name: fd.get('name'), chair: fd.get('chair'), members: fd.getAll('member') }, 'Panel saved and approved');
        vs.data = null; redraw();
      } else if (form.matches('.assign-form')) {
        const fd = new FormData(form), [classCode, unitCode] = String(fd.get('cu')).split('|');
        const r = await call('assignVerification', { panelId: form.dataset.panel, classCode, unitCode, verifier: fd.get('verifier'), verifier2: fd.get('verifier2') });
        toast(`Given to ${both(r.verification)}: ${r.verification.size} of ${r.verification.population} students to check`, 'ok');
        upsertVer(r.verification); redraw();
      } else if (form.matches('.ver-submit')) {
        const fd = new FormData(form), v = vs.data.verifications.find((x) => x.id === vs.open);
        const r = await call('submitVerification', { id: v.id, result: fd.get('result'), actions: fd.get('actions') });
        if (r.extended) toast(r.extended === 'doubled' ? `Too many disagreements: the sample is doubled to ${r.verification.size}. Both of you check the new students.` : `Still too many disagreements: every student (${r.verification.size}) is now in the sample.`, 'err');
        else if (r.waiting) toast('Result submitted. The report is ready when the second verifier submits theirs.', 'ok');
        else toast('Both results are in. The chair or the HOD signs the report.', 'ok');
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
      // Nobody verifies a unit they teach: leave its trainers out of both lists.
      const unit = t.value.split('|')[1] || '', own = new Set(vs.data.loading.filter((u) => u.unitCode === unit).map((u) => lower(u.trainerCode)));
      for (const n of ['verifier', 'verifier2']) for (const o of t.form.querySelector(`[name=${n}]`).options) o.hidden = !!o.value && own.has(lower(o.value));
      return true;
    }
    if (t.matches('[data-lspick]')) { if (t.checked) ls.picked.add(t.dataset.lspick); else ls.picked.delete(t.dataset.lspick); redraw(); return true; }
    if (t.matches('[data-lsall]')) { for (const u of listFree()) { const k = u.classCode + '|' + u.unitCode; if (t.checked) ls.picked.add(k); else ls.picked.delete(k); } redraw(); return true; }
    return false;
  }
  // The list filter hides choices in place (no reload while typing).
  document.addEventListener('input', (e) => {
    if (!e.target.matches?.('.ls-search')) return;
    ls.q = e.target.value; const q = ls.q.trim().toLowerCase();
    for (const l of $$('.ls-pick [data-lspick]')) l.closest('label').hidden = !!q && !l.closest('label').textContent.toLowerCase().includes(q);
  });
  const reset = () => { vs.data = null; vs.open = ''; };
  return { render, onClick, onSubmit, onChange, reset, state: vs };
})();
