/* POE tab → Verification: internal verification of POE evidence.
 *  - The MIS Officer or the Internal Assessment Officer drafts a panel (a chair and members); the HOD approves it.
 *  - Each class and unit is given to one panel member (never its own trainer). The server draws the sample: everyone up to
 *    10 students, otherwise max(10, ⌈√N × risk⌉), always including students returned-then-approved, files changed after
 *    sending and one from each third of the marks.
 *  - The member checks each sampled student's approved evidence (valid, authentic, current, sufficient; agree with the
 *    trainer?) and gives a result. Too many disagreements doubles the sample, then takes in everyone.
 *  - The trainer responds; the chair or the HOD signs. An External Assessment Officer then checks the same sample.
 * Uses app.js (api, $, $$, esc, toast, hasRole, me, fmtTime, lower) and PoeStaff (evidence list and preview). */
'use strict';

const Verify = (() => {
  const vs = { data: null, open: '', seq: 0 };
  const RESULT = { verified: 'Verified', actions: 'Verified with actions', not_verified: 'Not verified' };
  const STAT = { open: ['pending', 'In progress'], submitted: ['wait', 'Submitted'], signed: ['synced', 'Signed'] };
  const PSTAT = { draft: ['pending', 'Waiting for the HOD'], approved: ['synced', 'Approved'], returned: ['rejected', 'Returned'] };
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
    const mine = d.verifications.filter((x) => isMe(x.verifier));
    const ext = d.verifications.filter((x) => isMe(x.external));
    const units = d.verifications.filter((x) => isMe(x.trainerCode) && x.status !== 'open');
    const parts = [];
    if (mine.length) parts.push(card('Class-units given to you', 'Check each student in the sample, then give your result.', table(mine)));
    if (ext.length) parts.push(card('For external verification', 'The panel has finished these. Check the same sample and give your result.', table(ext)));
    if (units.length) parts.push(card('Verification of your units', 'What the panel found in your units, and your response.', table(units)));
    if (office() || d.panels.length) parts.push(panelsCard());
    if (!parts.length) parts.push('<div class="card notice"><h2>Nothing to verify</h2><p class="muted">When a panel gives you a class and unit to verify, or verifies one of your units, it shows here.</p></div>');
    box.innerHTML = head + parts.join('');
  }
  const card = (title, sub, body) => `<section class="card"><div class="msec-head"><h2>${esc(title)}</h2></div><p class="muted small">${esc(sub)}</p>${body}</section>`;

  /** Verifications as a table: class, unit, trainer, verifier, sample, status, result. */
  function table(list, opts = {}) {
    if (!list.length) return '<p class="muted small">None yet.</p>';
    return `<div class="table-wrap"><table class="report-table ver-table"><thead><tr><th>Class</th><th>Unit</th><th>Trainer</th><th>Verifier</th><th class="num">Sample</th><th>Status</th><th>Result</th><th><span class="sr">Open</span></th></tr></thead>
      <tbody>${list.map((v) => {
        const done = vs.data.checks.filter((c) => c.verificationId === v.id && c.who === 'internal' && c.agree !== null).length;
        return `<tr><td>${esc(v.classCode)}</td><td title="${esc(v.unitName)}">${esc(v.unitCode)}</td><td>${esc(v.trainerName || v.trainerCode)}</td><td>${esc(staffName(v.verifier))}</td>
          <td class="num" title="${v.size} of ${v.population} students with approved evidence">${v.status === 'open' ? `${done}/` : ''}${v.size} of ${v.population}</td>
          <td>${pill(STAT[v.status] || ['pending', v.status])}</td><td>${v.result ? esc(RESULT[v.result]) : '–'}${v.extResult ? `<br><small class="muted">External: ${esc(RESULT[v.extResult])}</small>` : ''}</td>
          <td><button type="button" class="btn small" data-vopen="${esc(v.id)}">Open</button>${opts.hod && v.status === 'open' ? ` <button type="button" class="btn small ghost" data-vact="redraw" data-id="${esc(v.id)}">Draw again</button>` : ''}</td></tr>`;
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
        <button class="btn primary">${p ? 'Save and send to the HOD' : 'Draft the panel'}</button></form>`;
    const rows = d.panels.map((p) => {
      const vers = d.verifications.filter((v) => v.panelId === p.id);
      return `<details class="mdone panel"${p.status !== 'approved' || vers.length ? ' open' : ''}><summary><b>${esc(p.name)}</b> ${pill(PSTAT[p.status] || ['pending', p.status])}
          <span class="muted small">Chair ${esc(staffName(p.chair))} - ${p.members.length} member${p.members.length === 1 ? '' : 's'}</span></summary>
        <p class="small">${p.members.map((m) => esc(staffName(m)) + (lower(m) === lower(p.chair) ? ' (chair)' : '')).join(', ')}</p>
        ${p.note ? `<p class="small warn-text">HOD: ${esc(p.note)}</p>` : ''}
        ${hasRole('HOD') && p.status === 'draft' ? `<div class="row-actions"><input class="hod-note" data-note="${esc(p.id)}" placeholder="Note (needed to return)"><button type="button" class="btn small" data-vact="return-panel" data-id="${esc(p.id)}">Return</button><button type="button" class="btn small primary" data-vact="approve-panel" data-id="${esc(p.id)}">Approve the panel</button></div>` : ''}
        ${p.status === 'approved' ? table(vers, { hod: hasRole('HOD') }) + (drafts() ? assignForm(p, vers) : '') : ''}
        ${drafts() ? `<details class="mdone"><summary>Change this panel</summary>${form(p)}</details>` : ''}</details>`;
    }).join('');
    return card('Verification panels', drafts() ? 'Draft a panel; the HOD approves it. Then give each class and unit to a member, who checks a sample of the approved evidence.' : 'Panels drafted by the MIS Officer or the Internal Assessment Officer.',
      (rows || '<p class="muted small">No panels yet.</p>') + (drafts() ? `<details class="mdone"><summary>Draft a new panel</summary>${form(null)}</details>` : ''));
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

  /* ---------- one class-unit ---------- */
  function detail(v) {
    const d = vs.data, sample = v.sample, mineInt = isMe(v.verifier) && v.status === 'open', mineExt = isMe(v.external) && v.status !== 'open';
    const showExt = !!v.external && (mineExt || office() || isMe(v.verifier));
    const checked = sample.filter((a) => checkOf(v, a, 'internal')?.agree != null).length;
    const against = sample.filter((a) => checkOf(v, a, 'internal')?.agree === false).length;
    const order = sample.flatMap((a) => evidenceOf(v, a).map((e) => e.id));
    const panel = d.panels.find((p) => p.id === v.panelId);
    const canSign = v.status === 'submitted' && (hasRole('HOD') || (panel && isMe(panel.chair)));
    const rows = sample.map((adm) => {
      const ev = evidenceOf(v, adm);
      return `<tr><td><b>${esc(nameOf(adm))}</b><br><span class="tadm">${esc(adm.toUpperCase())}</span></td>
        <td class="small">${esc(v.reasons[adm] || '')}</td>
        <td>${ev.length ? ev.map((e) => `<button type="button" class="btn small" data-vview="${esc(e.id)}" data-order="${esc(order.join(','))}">${esc(e.item)}</button>`).join(' ') : '<span class="muted small">no approved file</span>'}</td>
        <td>${checkCell(v, adm, 'internal', mineInt)}</td>${showExt ? `<td>${checkCell(v, adm, 'external', mineExt)}</td>` : ''}</tr>`;
    }).join('');
    const firstLog = v.log[0]?.what || '';
    return `<section class="card ver-detail">
      <div class="msec-head"><h2>${esc(v.classCode)} - ${esc(v.unitCode)} ${esc(v.unitName)}</h2><button type="button" class="btn small ghost" data-vact="back">‹ Back</button></div>
      <p class="small">Trainer <b>${esc(v.trainerName || v.trainerCode)}</b> - verifier <b>${esc(staffName(v.verifier))}</b>${v.external ? ` - external <b>${esc(staffName(v.external))}</b>` : ''} - ${pill(STAT[v.status] || ['pending', v.status])}</p>
      <p class="small">Sample: <b>${v.size}</b> of ${v.population} students with approved evidence${v.risk > 1 ? ` (higher risk × ${v.risk})` : ''}. ${esc(firstLog)}${v.round > 1 ? ` <b class="warn-text">${v.round === 2 ? 'The sample was doubled after disagreements.' : 'Every student is now in the sample.'}</b>` : ''}</p>
      ${v.status === 'open' ? `<p class="small">${checked} of ${sample.length} checked${against ? ` - <b class="warn-text">${against} disagreement${against === 1 ? '' : 's'}</b>` : ''}</p>` : ''}
      <div class="table-wrap"><table class="report-table ver-sample"><thead><tr><th>Student</th><th>Why in the sample</th><th>Approved evidence</th><th>Panel check</th>${showExt ? '<th>External check</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>
      ${mineInt ? `<form class="ver-submit"><h3>Your result</h3>
        <label>Result<select name="result" required><option value="">Choose…</option>${Object.entries(RESULT).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
        <label>Actions for the trainer <span class="muted small">(needed unless verified)</span><textarea name="actions" rows="3" maxlength="2000"></textarea></label>
        <button class="btn primary">Submit the result</button></form>` : ''}
      ${v.status !== 'open' ? `<div class="ver-result"><h3>Result: ${esc(RESULT[v.result] || '')}</h3>${v.actions ? `<p class="small"><b>Actions:</b> ${esc(v.actions)}</p>` : ''}
        <p class="muted small">Submitted ${esc(fmtTime(v.submittedAt))}${v.signedAt ? ` - signed by ${esc(v.signedBy)} ${esc(fmtTime(v.signedAt))}` : ''}</p>
        ${v.response ? `<p class="small"><b>Trainer's response:</b> ${esc(v.response)}</p>` : ''}
        ${isMe(v.trainerCode) ? `<form class="ver-respond"><label>Your response<textarea name="response" rows="2" maxlength="2000">${esc(v.response)}</textarea></label><button class="btn">Send response</button></form>` : ''}
        ${canSign ? '<button type="button" class="btn primary" data-vact="sign">Sign the report</button>' : ''}
        ${v.extResult ? `<p class="small"><b>External result:</b> ${esc(RESULT[v.extResult])}${v.extNote ? ` - ${esc(v.extNote)}` : ''}</p>` : ''}
        ${mineExt ? `<form class="ver-ext"><h3>Your external result</h3><label>Result<select name="result" required><option value="">Choose…</option>${Object.entries(RESULT).map(([k, l]) => `<option value="${k}"${v.extResult === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label>Note<textarea name="note" rows="2" maxlength="2000">${esc(v.extNote)}</textarea></label><div class="row-actions"><button type="button" class="btn" data-vact="more">Ask for 5 more students</button><button class="btn primary">Save the external result</button></div></form>` : ''}</div>` : ''}
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
    return v.sample.map((adm, i) => {
      const c = checkOf(v, adm, 'internal') || {};
      return [i + 1, adm.toUpperCase(), nameOf(adm), v.reasons[adm] || '', yn(c.valid), yn(c.authentic), yn(c.current), yn(c.sufficient), c.agree == null ? '' : c.agree ? 'Agree' : 'Do not agree', c.comment || ''];
    });
  }
  const HEAD = ['#', 'Admission no.', 'Name', 'Why in the sample', 'Valid', 'Authentic', 'Current', 'Sufficient', 'Trainer\'s decision', 'Comment'];
  function printReport(v) {
    const panel = vs.data.panels.find((p) => p.id === v.panelId);
    const chairSigned = !!(v.signedAt && panel && lower(staffName(panel.chair)) === lower(v.signedBy || ''));
    $('#printArea').innerHTML = `<div class="tbl-print ver-print"><h1>INTERNAL VERIFICATION REPORT</h1>
      <p>${esc(v.classCode)} - ${esc(v.unitCode)} ${esc(v.unitName)} - trainer ${esc(v.trainerName || v.trainerCode)}</p>
      <p>Panel: ${esc(panel?.name || '')} - verifier ${esc(staffName(v.verifier))} - sample ${v.size} of ${v.population}${v.risk > 1 ? ` (risk × ${v.risk})` : ''}</p>
      <table><thead><tr>${HEAD.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${reportRows(v).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <p><b>Result:</b> ${esc(RESULT[v.result] || 'not given yet')}${v.actions ? ` - <b>Actions:</b> ${esc(v.actions)}` : ''}</p>
      ${v.response ? `<p><b>Trainer's response:</b> ${esc(v.response)}</p>` : ''}
      <table class="sign-lines"><tr><th>Verifier</th><td>${esc(staffName(v.verifier))}</td><th>Signature</th><td class="sig">${v.submittedAt ? esc(initials(staffName(v.verifier))) : ''}</td><th>Date</th><td>${esc(v.submittedAt ? fmtShort(v.submittedAt) : '')}</td></tr>
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
        await call('savePanel', { id: form.dataset.panel || undefined, name: fd.get('name'), chair: fd.get('chair'), members: fd.getAll('member') }, 'Panel saved. It goes to the HOD to approve.');
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
      // A trainer cannot verify their own unit: leave them out of the verifier list.
      const tr = t.selectedOptions[0]?.dataset.trainer || '';
      for (const o of t.form.querySelector('[name=verifier]').options) o.hidden = !!o.value && lower(o.value) === lower(tr);
      return true;
    }
    return false;
  }
  const reset = () => { vs.data = null; vs.open = ''; };
  return { render, onClick, onSubmit, onChange, reset, state: vs };
})();
