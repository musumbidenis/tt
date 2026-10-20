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
    try { res = await api('tpoeList', office() ? { trainer: ts.trainer } : {}); } catch (e) { if (seq === ts.seq) box().innerHTML = `${wrap('')}<div class="card notice"><h2>Could not load</h2><p>${esc(e.message)}</p></div>`; return; }
    if (seq !== ts.seq) return;
    if (!res.ok) { box().innerHTML = `${wrap('')}<div class="card notice"><h2>Could not load</h2><p>${esc(res.error || '')}</p></div>`; return; }
    ts.data = res; ts.loaded = true;
    draw();
  }
  const wrap = (inner) => `<div class="card poe-head"><div class="msec-head"><h2>Evidence (POE)</h2><button type="button" class="btn small ghost" data-act="treload">Refresh</button></div>${ts.toggle}${inner}</div>`;

  function draw() {
    const d = ts.data;
    // The office with no trainer chosen yet: pick one.
    if (office() && !d.trainer) {
      const opts = (d.trainers || []).map((t) => `<option value="${esc(t.code)}">${esc(t.name)} (${esc(t.code)})</option>`).join('');
      box().innerHTML = `${wrap('<p class="muted small">Each trainer\'s portfolio of evidence: the registers, marksheets and student POE the app gathered, and the documents the trainer uploaded.</p>')}
        <div class="card"><label>Choose a trainer<select id="tpoePick"><option value="">— pick a trainer —</option>${opts}</select></label></div>`;
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
    const d = ts.data, c = d.complete || { done: 0, total: 0, pct: 0 };
    return `<div class="tpoe-head-row">
      ${office() ? '<button type="button" class="btn small ghost" data-act="tback">‹ All trainers</button>' : ''}
      <div><b>${esc(d.trainer?.name || '')}</b> <span class="muted small">${esc(d.trainer?.code || '')} - ${esc(d.term?.name || '')}</span></div>
      <span class="tpoe-pct" title="${c.done} of ${c.total} items uploaded"><b>${c.pct}%</b> complete</span></div>
      ${d.sheetUrl ? `<div class="row-actions"><a class="btn small" href="${esc(d.sheetUrl)}" target="_blank" rel="noopener">Attendance sheet in Drive</a></div>` : ''}`;
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

  function onClick(t) {
    const a = t.closest('[data-act]')?.dataset.act;
    if (a === 'treload') { ts.loaded = false; render(box(), ts.toggle); return; }
    if (a === 'tback') { ts.trainer = ''; ts.loaded = false; render(box(), ts.toggle); return; }
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
