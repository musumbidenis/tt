/* Reports in bulk (Manage tab: MIS Officer and HOD). Every term register (with its CAT register) and every marksheet of
 * the chosen classes, units or trainers, as Excel and PDF, all at once: one zip file to download, and the same files saved
 * in Google Drive (Reports / <this run> / <class, unit or trainer>) through the Drive bridge.
 * Uses app.js (reportFor, registerExportData, api, state, $, $$, esc, toast, download, todayISO, fileSafe), TermReport,
 * Xlsx, Marks, HtmlPdf and JSZip. */
'use strict';

const Bulk = (() => {
  const bs = { by: 'class', picked: null, busy: false, last: null };
  const allowed = () => hasRole('MIS') || hasRole('HOD');
  const pairs = () => state.units.filter((u) => u.trainerCode || u.trainerName);
  /** The groups for the chosen way: each with its label and its class-units. */
  function groups() {
    const m = new Map();
    for (const u of pairs()) {
      const key = bs.by === 'class' ? u.classCode : bs.by === 'unit' ? u.code : (u.trainerCode || u.trainerName);
      const label = bs.by === 'class' ? u.classCode : bs.by === 'unit' ? `${u.code} - ${u.name}` : (u.trainerName || u.trainerCode);
      if (!m.has(key)) m.set(key, { key, label, items: [] });
      m.get(key).items.push(u);
    }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  }
  function html() {
    const gs = groups();
    if (!bs.picked) bs.picked = new Set(gs.map((g) => g.key));
    const n = gs.filter((g) => bs.picked.has(g.key)).reduce((a, g) => a + g.items.length, 0);
    const way = [['class', 'By class'], ['unit', 'By unit'], ['trainer', 'By trainer']]
      .map(([k, l]) => `<button type="button" class="chipbtn${bs.by === k ? ' on' : ''}" data-bkby="${k}">${l}</button>`).join('');
    return `<p class="muted small">Every term register (with its CAT register) and marksheet of the chosen ${bs.by === 'class' ? 'classes' : bs.by === 'unit' ? 'units' : 'trainers'}, in Excel and PDF, in one go: a zip file to download, and the same files in Google Drive.</p>
      <div class="chips" role="group" aria-label="Group the reports">${way}</div>
      <div class="bk-picks"><label class="kchip"><input type="checkbox" data-bkall${gs.every((g) => bs.picked.has(g.key)) ? ' checked' : ''}><span>All (${gs.length})</span></label>
        ${gs.map((g) => `<label class="kchip"><input type="checkbox" data-bkpick="${esc(g.key)}"${bs.picked.has(g.key) ? ' checked' : ''}><span>${esc(g.label)} <small>${g.items.length}</small></span></label>`).join('') || '<span class="muted">No loading for this term yet.</span>'}</div>
      <div class="bk-opts">
        <label class="check small"><input type="checkbox" id="bkReg" checked> Term registers and CAT registers</label>
        <label class="check small"><input type="checkbox" id="bkMarks" checked> Marksheets</label>
        <label class="check small"><input type="checkbox" id="bkXlsx" checked> Excel</label>
        <label class="check small"><input type="checkbox" id="bkPdf" checked> PDF</label>
        <label class="check small"><input type="checkbox" id="bkDrive" checked> Save in Google Drive too</label>
      </div>
      <div class="row-actions"><button type="button" class="btn primary" id="bkGo"${n && !bs.busy ? '' : ' disabled'}>Make ${n} class unit${n === 1 ? '' : 's'}' reports</button></div>
      <div id="bkOut" aria-live="polite">${bs.last || ''}</div>`;
  }
  const redraw = () => { const s = $('#m-bulk'); if (s) { [...s.children].slice(1).forEach((c) => c.remove()); s.insertAdjacentHTML('beforeend', html()); } };
  const b64 = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const clean = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 90);

  async function go(btn) {
    const want = { reg: $('#bkReg').checked, marks: $('#bkMarks').checked, xlsx: $('#bkXlsx').checked, pdf: $('#bkPdf').checked, drive: $('#bkDrive').checked };
    if (!want.reg && !want.marks) { toast('Tick registers, marksheets or both', 'err'); return; }
    if (!want.xlsx && !want.pdf) { toast('Tick Excel, PDF or both', 'err'); return; }
    if (!navigator.onLine) { toast('Making reports in bulk needs internet (the latest registers and marks come from the server)', 'err'); return; }
    const jobs = groups().filter((g) => bs.picked.has(g.key)).flatMap((g) => g.items.map((u) => ({ g, u })));
    if (!jobs.length) return;
    bs.busy = true; btn.disabled = true;
    const out = $('#bkOut'), zip = new JSZip(), run = `${todayISO()} ${new Date().toTimeString().slice(0, 5).replace(':', '.')} - ${bs.by === 'class' ? 'by class' : bs.by === 'unit' ? 'by unit' : 'by trainer'}`;
    let ticket = null, driveUrl = '', folderUrl = '', files = 0;
    const problems = [];
    try {
      if (want.drive) {
        const t = await api('bulkTicket', { run });
        if (!t.ok) { problems.push('Google Drive: ' + t.error); want.drive = false; } else { ticket = t.ticket; driveUrl = t.driveUrl; }
      }
      const regTpl = want.reg && want.xlsx ? await (await fetch('templates/class-register.xlsx')).arrayBuffer() : null;
      for (let i = 0; i < jobs.length; i++) {
        const { g, u } = jobs[i], tag = `${u.classCode} ${u.code}`;
        out.innerHTML = `<div class="bk-prog"><progress max="${jobs.length}" value="${i}"></progress><span>${i + 1} of ${jobs.length} - ${esc(tag)}</span></div>`;
        const made = [];
        try {
          if (want.reg) {
            const d = registerExportData(await reportFor(u.classCode, u.code)), base = clean(`Register - ${u.classCode} - ${u.code}`);
            if (want.xlsx) made.push({ name: base + '.xlsx', blob: await Xlsx.registerFile(regTpl, d) });
            if (want.pdf) made.push({ name: base + '.pdf', blob: await HtmlPdf.make(TermReport.printHtml(d, esc), { landscape: true }) });
          }
          if (want.marks) {
            const d = await Marks.dataFor(u.classCode, u.code), base = clean(`Marksheet - ${u.classCode} - ${u.code}`);
            if (want.xlsx) made.push({ name: base + '.xlsx', blob: await Marks.xlsxFor(d) });
            if (want.pdf) made.push({ name: base + '.pdf', blob: await HtmlPdf.make(Marks.printHtml(d), { landscape: true }) });
          }
        } catch (e) { problems.push(`${tag}: ${e.message}`); }
        const folder = clean(g.label);
        for (const f of made) { zip.file(`${folder}/${f.name}`, f.blob); files++; }
        if (want.drive && made.length) {
          try {
            const body = { action: 'bulk', ticket, folder, files: await Promise.all(made.map(async (f) => ({ name: f.name, mime: f.blob.type || (f.name.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), data: await b64(f.blob) }))) };
            const r = await (await fetch(driveUrl, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' })).json();
            if (!r.ok) throw new Error(r.error);
            folderUrl = r.url || folderUrl;
          } catch (e) { problems.push(`Google Drive, ${tag}: ${e.message}`); }
        }
      }
      out.innerHTML = '<p class="muted">Putting the zip file together…</p>';
      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      download(`Reports ${run}.zip`, blob);
      bs.last = `<p class="ok-text"><b>${files} file${files === 1 ? '' : 's'}</b> made for ${jobs.length} class unit${jobs.length === 1 ? '' : 's'} - the zip file is downloading.</p>
        ${folderUrl ? `<p><a class="btn small" href="${esc(folderUrl)}" target="_blank" rel="noopener">Open the folder in Google Drive</a></p>` : ''}
        ${problems.length ? `<details class="fold"><summary class="warn-text">${problems.length} problem${problems.length === 1 ? '' : 's'}</summary><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}`;
      out.innerHTML = bs.last;
      toast(`Reports made: ${files} files`, problems.length ? 'err' : 'ok');
    } catch (e) { out.innerHTML = `<p class="err-text">${esc(e.message)}</p>`; }
    finally { bs.busy = false; btn.disabled = false; }
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#m-bulk')) return;
    const by = e.target.closest('[data-bkby]'); if (by) { bs.by = by.dataset.bkby; bs.picked = null; bs.last = null; redraw(); return; }
    const g = e.target.closest('#bkGo'); if (g) go(g);
  });
  document.addEventListener('change', (e) => {
    const t = e.target; if (!t.closest?.('#m-bulk')) return;
    if (t.matches('[data-bkpick]')) { if (t.checked) bs.picked.add(t.dataset.bkpick); else bs.picked.delete(t.dataset.bkpick); redraw(); }
    if (t.matches('[data-bkall]')) { bs.picked = new Set(t.checked ? groups().map((x) => x.key) : []); redraw(); }
  });
  return { html, allowed, redraw };
})();
window.Bulk = Bulk;
