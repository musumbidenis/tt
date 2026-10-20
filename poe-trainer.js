/* POE tab → Trainer POE: a trainer's own portfolio of evidence.
 *  - The attendance registers, marksheets and student evidence are gathered automatically from what the app holds.
 *  - The trainer uploads the documents the app cannot know about, one per fixed checklist item: per unit (scheme of
 *    work, lesson plans, lesson notes, CAT/exam papers with marking schemes, moderation form, record of work) and per
 *    term (industrial attachment visit reports, CPD certificates). Files go to the trainer's own Drive folder.
 *  - A trainer sees and fills only their own; the HOD, MIS Officer and IAO pick any trainer and view the files.
 * (HOD sign-off and time-limited assessor access come next.) Uses app.js (api, $, esc, toast, hasRole, me, fmtTime, lower). */
'use strict';

const PoeTrainer = (() => {
  const ts = { trainer: '', data: null, seq: 0, loaded: false, busy: false };
  const office = () => hasRole('HOD') || hasRole('MIS') || hasRole('IAO');
  const box = () => document.querySelector('#poe');
  const STAGE = { '': ['pending', 'Not yet'], submitted: ['wait', 'Submitted'], approved: ['synced', 'Approved'], returned: ['rejected', 'Returned'],
    prepared: ['wait', 'Prepared'], received: ['wait', 'With Assessment Officer'] };
  const stage = (s) => { const [c, l] = STAGE[s] || ['pending', s || 'Not yet']; return `<span class="pill ${c}">${esc(l)}</span>`; };

  async function render(_box, toggleHtml) {
    ts.toggle = toggleHtml || '';
    if (!me()) return;
    if (!navigator.onLine) { box().innerHTML = `${wrap('')}<div class="card notice"><h2>Trainer POE needs internet</h2><p>The files are in the college Google Drive.</p></div>`; return; }
    const seq = ++ts.seq;
    if (!ts.loaded) box().innerHTML = `${wrap('')}<div class="card"><p class="muted">Loading…</p></div>`;
    let res;
    try { res = await api('tpoeList', { trainer: ts.trainer }); } catch (e) { if (seq === ts.seq) box().innerHTML = `${wrap('')}<div class="card notice"><h2>Could not load</h2><p>${esc(e.message)}</p></div>`; return; }
    if (seq !== ts.seq) return;
    if (!res.ok) { box().innerHTML = `${wrap('')}<div class="card notice"><h2>Could not load</h2><p>${esc(res.error || '')}</p></div>`; return; }
    ts.data = res; ts.loaded = true;
    draw();
  }
  const wrap = (inner) => `<div class="card poe-head"><div class="msec-head"><h2>Evidence (POE)</h2><button type="button" class="btn small ghost" data-act="treload">Refresh</button></div>${ts.toggle}${inner}</div>`;

  function draw() {
    const d = ts.data;
    // The office or an assessor with no trainer chosen yet: pick one.
    if (d.trainers && !d.trainer) {
      const opts = (d.trainers || []).map((t) => `<option value="${esc(t.code)}">${esc(t.name)} (${esc(t.code)})</option>`).join('');
      box().innerHTML = `${wrap(`<p class="muted small">${d.assessor ? 'The trainers you have been given access to. Choose one to see their evidence (read-only).' : 'Each trainer\'s portfolio of evidence: the registers, marksheets and student POE the app gathered, and the documents the trainer uploaded.'}</p>`)}
        <div class="card"><label>Choose a trainer<select id="tpoePick"><option value="">— pick a trainer —</option>${opts}</select></label></div>
        ${(hasRole('HOD') || hasRole('MIS')) ? '<div class="card" id="tpoeGrantCard"><p class="muted">Loading assessor access…</p></div>' : ''}`;
      if (hasRole('HOD') || hasRole('MIS')) loadGrants();
      return;
    }
    if (!d.term) { box().innerHTML = `${wrap(head())}<div class="card notice"><h2>No active term</h2><p class="muted">Trainer POE follows the active term.</p></div>`; return; }
    const units = d.units || [];
    box().innerHTML = `${wrap(head())}
      ${d.canUpload ? '<p class="muted small">Upload one document per item. A new upload replaces the old one. PDF, Word, Excel or an image.</p>' : ''}
      ${termCard(d.termFiles || {})}
      ${units.length ? units.map(unitCard).join('') : '<div class="card notice"><h2>No units this term</h2><p class="muted">Units in the loading show here, each with its checklist.</p></div>'}`;
  }
  function head() {
    const d = ts.data, c = d.complete || { done: 0, total: 0, pct: 0 }, canPick = office() || d.assessor;
    const so = d.signoff;
    return `<div class="tpoe-head-row">
      ${canPick ? '<button type="button" class="btn small ghost" data-act="tback">‹ All trainers</button>' : ''}
      <div><b>${esc(d.trainer?.name || '')}</b> <span class="muted small">${esc(d.trainer?.code || '')} - ${esc(d.term?.name || '')}</span>${d.assessor ? ' <span class="pill cat">Assessor view</span>' : ''}</div>
      <span class="tpoe-pct" title="${c.done} of ${c.total} items uploaded"><b>${c.pct}%</b> complete</span></div>
      <div class="tpoe-signoff ${so ? 'is-signed' : ''}">${so
        ? `<span class="pill synced">Verified</span> <span class="small">by ${esc(so.by)}, ${esc(fmtTime(so.at))}${so.note ? ` - "${esc(so.note)}"` : ''}</span>`
        : '<span class="pill pending">Not yet verified by the HOD</span>'}
        ${hasRole('HOD') ? `<span class="tpoe-so-actions">${so
          ? '<button type="button" class="btn small ghost" data-act="tunsign">Remove sign-off</button>'
          : '<button type="button" class="btn small primary" data-act="tsign">Sign off this term</button>'}</span>` : ''}</div>
      <div class="row-actions tpoe-head-actions">
        ${d.sheetUrl ? `<a class="btn small" href="${esc(d.sheetUrl)}" target="_blank" rel="noopener">Attendance sheet in Drive</a>` : ''}
        ${c.done ? `<button type="button" class="btn small" data-act="tbundle-pdf"><svg class="i" aria-hidden="true"><use href="#i-print"/></svg>POE index (PDF)</button>
        <button type="button" class="btn small" data-act="tbundle-zip"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Download bundle (ZIP)</button>` : ''}</div>`;
  }
  const slotRow = (label, file, slot, cls, unit) => `<div class="tpoe-slot">
    <div class="tpoe-slot-name">${esc(label)}</div>
    <div class="tpoe-slot-body">${file
      ? `<span class="tpoe-file" title="${esc(file.uploadedBy)}, ${esc(fmtTime(file.uploadedAt))}">${esc(file.fileName)}${file.version > 1 ? ` <small class="muted">v${file.version}</small>` : ''}</span>
         <button type="button" class="btn small" data-tview="${esc(file.id)}">View</button>
         ${ts.data.canUpload ? `<button type="button" class="btn small ghost" data-tup="${esc(slot)}" data-cls="${esc(cls || '')}" data-unit="${esc(unit || '')}">Replace</button>
         <button type="button" class="btn small ghost" data-tdel="${esc(file.id)}">Remove</button>` : ''}`
      : `<span class="pill pending">Missing</span>${ts.data.canUpload ? ` <button type="button" class="btn small primary" data-tup="${esc(slot)}" data-cls="${esc(cls || '')}" data-unit="${esc(unit || '')}">Upload</button>` : ''}`}
    </div></div>`;
  function termCard(files) {
    const slots = ts.data.slots?.term || [];
    return `<div class="card tpoe-card"><h3>For the term</h3>
      <div class="tpoe-slots">${slots.map((s) => slotRow(s.label, files[s.slot], s.slot, '', '')).join('')}</div></div>`;
  }
  function unitCard(u) {
    const slots = ts.data.slots?.unit || [], a = u.auto || {}, ev = a.evidence || {};
    const evTxt = (ev.approved || ev.submitted || ev.returned)
      ? `${ev.approved || 0} approved${ev.submitted ? `, ${ev.submitted} to review` : ''}${ev.returned ? `, ${ev.returned} returned` : ''}`
      : 'none yet';
    return `<div class="card tpoe-card"><div class="tpoe-unit-head"><h3>${esc(u.unitName)}</h3><span class="muted small">${esc(u.unitCode)} - ${esc(u.classCode)}</span></div>
      <div class="tpoe-auto"><span>Register ${stage(a.register)}</span><span>Marksheet ${stage(a.marksheet)}</span><span>Student POE: ${esc(evTxt)}</span></div>
      <div class="tpoe-slots">${slots.map((s) => slotRow(s.label, u.files?.[s.slot], s.slot, u.classCode, u.unitCode)).join('')}</div></div>`;
  }

  /* ---------- upload, view, remove ---------- */
  const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onerror = () => rej(new Error('Could not read the file')); r.onload = () => res(String(r.result).split(',')[1] || ''); r.readAsDataURL(blob); });
  function fileInput() {
    let el = document.querySelector('#tpoeFile');
    if (!el) { el = document.createElement('input'); el.type = 'file'; el.id = 'tpoeFile'; el.hidden = true;
      el.accept = '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,application/pdf,image/*';
      el.addEventListener('change', onPicked); document.body.appendChild(el); }
    return el;
  }
  function askUpload(slot, cls, unit) {
    const el = fileInput();
    el.dataset.slot = slot; el.dataset.cls = cls || ''; el.dataset.unit = unit || ''; el.value = '';
    el.click();
  }
  async function onPicked(e) {
    const el = e.target, file = el.files?.[0]; if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast('That file is over 20 MB.', 'err'); return; }
    if (ts.busy) return; ts.busy = true; toast('Uploading…');
    try {
      const t = await api('tpoeTicket', { slot: el.dataset.slot, classCode: el.dataset.cls, unitCode: el.dataset.unit, bytes: file.size, name: file.name });
      if (!t.ok) throw new Error(t.error);
      const body = { action: 'tupload', ticket: t.ticket, mime: file.type || 'application/octet-stream', data: await b64(file) };
      const r = await (await fetch(t.driveUrl, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' })).json();
      if (!r.ok) throw new Error(r.error || 'The Drive did not save the file');
      const done = await api('tpoeDone', { ticket: t.ticket, fileId: r.fileId, fileName: r.fileName, version: r.version, mime: file.type || '', sig: r.sig });
      if (!done.ok) throw new Error(done.error);
      toast('Uploaded', 'ok');
      await render(box(), ts.toggle);
    } catch (err) { toast(err.message || 'Upload failed', 'err'); }
    finally { ts.busy = false; }
  }
  async function view(id) {
    toast('Opening…');
    try {
      const v = await api('tpoeView', { id });
      if (!v.ok) throw new Error(v.error);
      const res = await fetch(v.driveUrl + (v.driveUrl.includes('?') ? '&' : '?') + 'action=file&ticket=' + encodeURIComponent(v.ticket), { redirect: 'follow' });
      const out = await res.json();
      if (!out.ok) throw new Error(out.error || 'The Drive did not send the file');
      const bin = atob(out.data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: out.mime || 'application/octet-stream' }));
      const w = window.open(url, '_blank');
      if (!w) { const a = document.createElement('a'); a.href = url; a.download = out.name || v.fileName || 'file'; a.click(); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { toast(err.message || 'Could not open it', 'err'); }
  }
  async function remove(id) {
    if (!confirm('Remove this document from the portfolio? The file stays in your Drive.')) return;
    try { const r = await api('tpoeDelete', { id }); if (!r.ok) throw new Error(r.error); await render(box(), ts.toggle); }
    catch (err) { toast(err.message || 'Could not remove it', 'err'); }
  }
  /** The bytes of one portfolio file, through the bridge (so no Drive sharing is needed). */
  async function fetchBytes(id) {
    const v = await api('tpoeView', { id });
    if (!v.ok) throw new Error(v.error);
    const out = await (await fetch(v.driveUrl + (v.driveUrl.includes('?') ? '&' : '?') + 'action=file&ticket=' + encodeURIComponent(v.ticket), { redirect: 'follow' })).json();
    if (!out.ok) throw new Error(out.error || 'The Drive did not send the file');
    const bin = atob(out.data), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: out.mime || 'application/octet-stream', name: out.name || v.fileName || id };
  }
  const labelOf = (slot) => [...(ts.data.slots?.unit || []), ...(ts.data.slots?.term || [])].find((s) => s.slot === slot)?.label || slot;
  /** Every item that has a file, with the Drive folder it belongs in (for the ZIP). */
  function withFiles() {
    const out = [];
    for (const u of ts.data.units || []) for (const [slot, f] of Object.entries(u.files || {})) if (f) out.push({ f, folder: `${u.unitCode} ${u.unitName}`, where: `${u.unitName} (${u.unitCode})`, slot });
    for (const [slot, f] of Object.entries(ts.data.termFiles || {})) if (f) out.push({ f, folder: 'General', where: 'For the term', slot });
    return out;
  }
  /** The checklist as a table: every item, in or missing, for the PDF index and the ZIP's cover. */
  function indexHtml() {
    const d = ts.data, c = d.complete || {}, rows = [];
    const line = (where, label, f) => rows.push(`<tr><td>${esc(where)}</td><td>${esc(label)}</td><td>${f ? 'In' : 'Missing'}</td><td>${f ? esc(f.fileName) : '-'}</td></tr>`);
    for (const u of d.units || []) for (const s of d.slots.unit) line(`${u.unitName} (${u.unitCode})`, s.label, u.files?.[s.slot]);
    for (const s of d.slots.term) line('For the term', s.label, (d.termFiles || {})[s.slot]);
    return `<div class="tbl-print"><h1>TRAINER POE - PORTFOLIO OF EVIDENCE</h1>
      <p>Rift Valley National Polytechnic - Department of Computing and Informatics</p>
      <table><tbody>
        <tr><th>Trainer</th><td>${esc(d.trainer.name)} (${esc(d.trainer.code)})</td></tr>
        <tr><th>Term</th><td>${esc(d.term.name)}</td></tr>
        <tr><th>Completeness</th><td>${c.done} of ${c.total} items (${c.pct}%)</td></tr>
        <tr><th>HOD sign-off</th><td>${d.signoff ? `Verified by ${esc(d.signoff.by)} on ${esc(fmtTime(d.signoff.at))}` : 'Not yet verified'}</td></tr>
      </tbody></table>
      <table class="report-table"><thead><tr><th>Unit / Term</th><th>Item</th><th>Status</th><th>File</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }
  async function bundle(kind) {
    if (ts.busy) return; ts.busy = true;
    try {
      const indexPdf = await HtmlPdf.make(indexHtml(), { landscape: true });
      const base = `POE - ${ts.data.trainer.name} - ${ts.data.term.name}`.replace(/[\\/:*?"<>|]+/g, ' ');
      if (kind === 'pdf') { download(`${base} - index.pdf`, indexPdf); return; }
      const files = withFiles();
      if (!files.length) { toast('Nothing uploaded to bundle yet', 'err'); return; }
      toast(`Building a bundle of ${files.length} file(s)…`);
      const zip = new JSZip();
      zip.file('POE index.pdf', indexPdf);
      for (let i = 0; i < files.length; i++) {
        const { f, folder } = files[i];
        try { const got = await fetchBytes(f.id); zip.file(`${folder}/${labelOf(f.slot)} - ${got.name}`.replace(/\/{2,}/g, '/'), got.bytes); }
        catch (e) { zip.file(`${folder}/MISSING - ${labelOf(f.slot)}.txt`, `Could not fetch this file: ${e.message}`); }
      }
      download(`${base}.zip`, await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
      toast('Bundle ready', 'ok');
    } catch (err) { toast(err.message || 'Could not build the bundle', 'err'); }
    finally { ts.busy = false; }
  }
  async function sign(undo) {
    if (!undo && !confirm(`Sign off ${ts.data.trainer.name}'s POE for ${ts.data.term.name}? Your name and today's date are recorded.`)) return;
    const note = undo ? '' : (prompt('Optional note on the sign-off:', '') ?? '');
    try { const r = await api('tpoeSign', { trainer: ts.data.trainer.code, undo: !!undo, note }); if (!r.ok) throw new Error(r.error);
      toast(undo ? 'Sign-off removed' : 'Signed off', 'ok'); ts.loaded = false; await render(box(), ts.toggle); }
    catch (err) { toast(err.message || 'Could not sign off', 'err'); }
  }

  /* ---------- assessor access (HOD / MIS) ---------- */
  async function loadGrants() {
    const card = document.querySelector('#tpoeGrantCard'); if (!card) return;
    let g; try { g = await api('tpoeGrants', {}); if (!g.ok) throw new Error(g.error); } catch (e) { card.innerHTML = `<p class="err-text">${esc(e.message)}</p>`; return; }
    ts.grants = g;
    const eaoOpts = g.eaos.map((e) => `<option value="${esc(e.code)}">${esc(e.name)} (${esc(e.code)})</option>`).join('');
    const trOpts = g.trainers.map((t) => `<option value="${esc(t.code)}">${esc(t.name)} (${esc(t.code)})</option>`).join('');
    const live = g.grants.filter((x) => x.active), past = g.grants.filter((x) => !x.active).slice(0, 6);
    const grantRow = (x) => `<li><span><b>${esc(x.eaoName)}</b> <small class="muted">${x.trainers.includes('*') ? 'all trainers' : x.trainers.length + ' trainer(s)'} - until ${esc(fmtTime(x.expires))}${x.active ? '' : x.revokedAt ? ' - revoked' : ' - expired'}</small></span>
      ${x.active ? `<button type="button" class="btn small ghost danger-text" data-grevoke="${esc(x.id)}">End now</button>` : ''}</li>`;
    card.innerHTML = `<div class="msec-head"><h3>Assessor access</h3></div>
      <p class="muted small">Give an External Assessment Officer time-limited, read-only access to trainers' POE for a visit. They see the files through the app; nothing is shared from Drive, and access ends on its own.</p>
      ${g.eaos.length ? `<div class="tpoe-grant-form">
        <label>Assessor<select id="tgEao">${eaoOpts}</select></label>
        <label class="check small"><input type="checkbox" id="tgAll"> All trainers</label>
        <label id="tgTrainersWrap">Trainers (pick one or more)<select id="tgTrainers" multiple size="4">${trOpts}</select></label>
        <label>Days<input type="number" id="tgDays" value="2" min="1" max="30" style="width:5rem"></label>
        <button type="button" class="btn primary small" data-act="tgrant">Grant access</button></div>`
      : '<p class="warn-text small">No External Assessment Officer on the staff list yet. The MIS Officer adds one under Staff and roles.</p>'}
      ${live.length ? `<h4 class="small">In force</h4><ul class="mlist">${live.map(grantRow).join('')}</ul>` : ''}
      ${past.length ? `<details class="fold"><summary>Earlier grants (${past.length})</summary><ul class="mlist">${past.map(grantRow).join('')}</ul></details>` : ''}`;
  }
  async function grant() {
    const eao = document.querySelector('#tgEao')?.value;
    const all = document.querySelector('#tgAll')?.checked;
    const trainers = all ? ['*'] : [...document.querySelectorAll('#tgTrainers option:checked')].map((o) => o.value);
    const days = Number(document.querySelector('#tgDays')?.value) || 2;
    if (!eao) { toast('Choose an assessor', 'err'); return; }
    if (!all && !trainers.length) { toast('Pick trainers, or tick All trainers', 'err'); return; }
    try { const r = await api('tpoeGrant', { eao, trainers, days }); if (!r.ok) throw new Error(r.error); toast('Access granted', 'ok'); loadGrants(); }
    catch (err) { toast(err.message || 'Could not grant access', 'err'); }
  }
  async function revoke(id) {
    if (!confirm('End this assessor\'s access now?')) return;
    try { const r = await api('tpoeRevoke', { id }); if (!r.ok) throw new Error(r.error); toast('Access ended', 'ok'); loadGrants(); }
    catch (err) { toast(err.message || 'Could not end access', 'err'); }
  }

  function onClick(t) {
    const a = t.closest('[data-act]')?.dataset.act;
    if (a === 'treload') { ts.loaded = false; render(box(), ts.toggle); return; }
    if (a === 'tback') { ts.trainer = ''; ts.loaded = false; render(box(), ts.toggle); return; }
    if (a === 'tsign') { sign(false); return; }
    if (a === 'tunsign') { sign(true); return; }
    if (a === 'tbundle-pdf') { bundle('pdf'); return; }
    if (a === 'tbundle-zip') { bundle('zip'); return; }
    if (a === 'tgrant') { grant(); return; }
    const gr = t.closest('[data-grevoke]'); if (gr) { revoke(gr.dataset.grevoke); return; }
    const up = t.closest('[data-tup]'); if (up) { askUpload(up.dataset.tup, up.dataset.cls, up.dataset.unit); return; }
    const vw = t.closest('[data-tview]'); if (vw) { view(vw.dataset.tview); return; }
    const dl = t.closest('[data-tdel]'); if (dl) { remove(dl.dataset.tdel); return; }
  }
  function onChange(t) {
    if (t.id === 'tpoePick') { ts.trainer = t.value; ts.loaded = false; if (t.value) render(box(), ts.toggle); }
  }
  function reset() { Object.assign(ts, { trainer: '', data: null, loaded: false, busy: false }); }
  return { render, onClick, onChange, reset };
})();
