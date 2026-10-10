/* Student app — POE evidence: scan pages like a document scanner, keep the PDF on the phone, and send it
 * to the college Drive when there is internet. Statuses (with your trainer, approved, returned) come back.
 * Uses student.js (st, sdb, api, toast, esc, $) and scanner.js. */
'use strict';

const POE = (() => {
  const ITEMS = ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'PRAC1', 'PRAC2', 'PRAC3'];
  const FILTERS = [['document', 'Document'], ['grey', 'Grey'], ['colour', 'Colour']];
  const ps = { units: [], unit: '', picked: new Set(), drafts: {}, server: [], syncing: false, crop: null, target: null };
  const $$ = (q, el = document) => [...el.querySelectorAll(q)];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const draftId = (unit, item) => `ev:draft:${unit}:${item}`;
  const unitName = (code) => (ps.units.find((u) => u.code === code) || { name: code }).name;

  async function allDocs() { return (await sdb.allDocs({ include_docs: true, startkey: 'ev:', endkey: 'ev:￿' })).rows.map((r) => r.doc); }
  async function attachment(doc, name) { return sdb.getAttachment(doc._id, name); }

  /* ---------- units of my class (cached for offline) ---------- */
  async function loadUnits() {
    const p = st.profile; if (!p) return;
    const cache = await getLocal('poeUnits');
    if (cache.classCode === p.classCode) { ps.units = cache.units || []; ps.ready = cache.driveReady; }
    if (navigator.onLine && st.sheetsUrl) {
      try {
        const r = await api('GET', { action: 'units', class: p.classCode });
        if (r.ok) { ps.units = r.units; ps.ready = r.driveReady; await updateLocal('poeUnits', (d) => { d.classCode = p.classCode; d.units = r.units; d.driveReady = r.driveReady; }); }
      } catch { /* offline: the cached list */ }
    }
  }

  /* ---------- the screen ---------- */
  async function render() {
    const card = $('#poeCard'); if (!card) return;
    if (!st.profile) { card.hidden = true; $('#poeListCard').hidden = true; return; }
    card.hidden = false;
    const sel = $('#poeUnit');
    sel.innerHTML = ps.units.length ? ps.units.map((u) => `<option value="${esc(u.code)}">${esc(u.code)} — ${esc(u.name)}</option>`).join('')
      : '<option value="">Connect once to load your units</option>';
    if (!ps.unit || !ps.units.some((u) => u.code === ps.unit)) ps.unit = ps.units[0]?.code || '';
    sel.value = ps.unit;
    const docs = await allDocs();
    ps.drafts = {};
    for (const d of docs) if (d.status === 'draft' && d.unitCode === ps.unit) { ps.drafts[d.item] = d; ps.picked.add(d.item); }
    const latest = (item) => ps.server.filter((e) => e.unitCode === ps.unit && e.item === item).sort((a, b) => b.version - a.version)[0];
    $('#poeItems').innerHTML = ITEMS.map((it) => {
      const s = latest(it);
      const tag = s ? (s.status === 'approved' ? ' ✓' : s.status === 'returned' ? ' ↺' : ' •') : '';
      return `<button type="button" class="kchip-btn${ps.picked.has(it) ? ' on' : ''}${s ? ' ' + s.status : ''}" data-item="${it}" aria-pressed="${ps.picked.has(it)}">${it}${tag}</button>`;
    }).join('');
    $('#poeDocs').innerHTML = [...ps.picked].filter((it) => ITEMS.includes(it)).sort((a, b) => ITEMS.indexOf(a) - ITEMS.indexOf(b)).map((it) => docCard(it, ps.drafts[it])).join('')
      || '<p class="muted small">Tap one or more items above (for example CAT1 and PRAC1), then scan the pages for each.</p>';
    const ready = Object.values(ps.drafts).filter((d) => (d.pages || []).length || d.pdfOnly).length;
    $('#poeSave').disabled = !ready;
    $('#poeSave').textContent = ready ? `Save and send ${ready === 1 ? 'the document' : ready + ' documents'}` : 'Scan pages first';
    // Thumbnails load after the cards exist.
    for (const it of ps.picked) {
      const d = ps.drafts[it]; if (!d) continue;
      (d.pages || []).forEach(async (name, i) => {
        const img = document.querySelector(`[data-doc="${it}"] [data-page="${i}"] img`);
        if (img && !img.src) img.src = URL.createObjectURL(await attachment(d, name));
      });
    }
    await renderList(docs);
  }
  function docCard(item, d) {
    const pages = d?.pages || [], f = d?.filter || 'document';
    return `<div class="poe-doc" data-doc="${item}">
      <div class="poe-doc-head"><b>${esc(unitName(ps.unit))} — ${item}</b><span class="muted small">${d?.pdfOnly ? 'PDF from the phone' : pages.length + ' page' + (pages.length === 1 ? '' : 's')}</span></div>
      ${d?.pdfOnly ? `<p class="small">${esc(d.pdfName || 'document.pdf')} <button type="button" class="linkish" data-clear>Remove</button></p>` : `
      <ol class="poe-pages">${pages.map((_, i) => `<li data-page="${i}"><img alt="Page ${i + 1}" class="f-${f}"><span>${i + 1}</span>
        <span class="pg-tools"><button type="button" data-move="-1" aria-label="Move page ${i + 1} up" ${i ? '' : 'disabled'}>↑</button><button type="button" data-move="1" aria-label="Move page ${i + 1} down" ${i < pages.length - 1 ? '' : 'disabled'}>↓</button><button type="button" data-del aria-label="Delete page ${i + 1}">✕</button></span></li>`).join('')}</ol>
      <div class="seg filt" role="group" aria-label="Look">${FILTERS.map(([k, l]) => `<button type="button" data-filter="${k}" aria-pressed="${f === k}">${l}</button>`).join('')}</div>`}
      <div class="row-actions"><button type="button" class="btn primary" data-camera>Take photo of a page</button><button type="button" class="btn" data-gallery>From gallery or PDF</button></div>
    </div>`;
  }
  const STATUS = { submitted: ['pending', 'With your trainer'], approved: ['synced', 'Approved'], returned: ['rejected', 'Returned'] };
  async function renderList(docs) {
    const local = docs.filter((d) => d.status !== 'draft');
    const box = $('#poeList');
    const rows = [];
    for (const d of local.filter((x) => x.status !== 'sent').sort((a, b) => String(b.createdAt).localeCompare(a.createdAt))) {
      rows.push(`<li data-local="${esc(d._id)}"><div><b>${esc(d.unitName)} — ${esc(d.item)}</b><span class="muted small">${d.pageCount || ''} page(s) · saved ${esc(fmtTime(d.createdAt))}${d.error ? ' · ' + esc(d.error) : ''}</span></div>
        <span class="poe-acts">${d.status === 'error' && navigator.onLine
          ? `<span class="pill rejected">Not sent yet</span><span class="poe-why small">${esc(d.error || 'Try again later')}</span><button type="button" class="linkish" data-retry>Try again</button>`
          : `<span class="pill pending">${d.status === 'uploading' ? 'Sending…' : 'Saved on phone — sends when online'}</span>`}<button type="button" class="linkish" data-copy>Save a copy</button></span></li>`);
    }
    for (const e of [...ps.server].sort((a, b) => String(b.submittedAt).localeCompare(a.submittedAt))) {
      const [cls, label] = STATUS[e.status] || ['pending', e.status];
      const mine = local.find((d) => d.serverId === e.id);
      rows.push(`<li><div><b>${esc(e.unitName)} — ${esc(e.item)} <span class="muted">v${e.version}</span></b><span class="muted small">${esc(e.fileName)} · sent ${esc(fmtTime(e.submittedAt))}${e.comment ? ` · “${esc(e.comment)}”` : ''}</span></div>
        <span class="poe-acts"><span class="pill ${cls}">${label}</span>${mine ? `<button type="button" class="linkish" data-copy data-id="${esc(mine._id)}">Save a copy</button>` : ''}${e.status === 'returned' ? `<button type="button" class="linkish" data-redo="${esc(e.unitCode)}|${esc(e.item)}">Scan again</button>` : ''}</span></li>`);
    }
    $('#poeListCard').hidden = !rows.length;
    box.innerHTML = rows.join('');
  }

  /* ---------- drafts: one per unit and item, kept on the phone ---------- */
  async function draft(item) {
    const id = draftId(ps.unit, item);
    try { return await sdb.get(id); } catch (e) { if (e.status !== 404) throw e; }
    return { _id: id, type: 'evidence', status: 'draft', unitCode: ps.unit, unitName: unitName(ps.unit), item, filter: 'document', pages: [], createdAt: nowISO() };
  }
  async function saveDraft(d) { const r = await sdb.put(d); d._rev = r.rev; return d; }
  async function addPage(item, blob) {
    const d = await draft(item);
    const name = `p${Date.now().toString(36)}.jpg`;
    d.pages = [...(d.pages || []), name];
    d._attachments = { ...(d._attachments || {}), [name]: { content_type: 'image/jpeg', data: blob } };
    if (d.pdfOnly) { delete d.pdfOnly; delete d._attachments['doc.pdf']; }
    await saveDraft(d);
  }

  /* ---------- the crop screen ---------- */
  async function openCrop(file, item) {
    let canvas;
    try { canvas = await Scanner.load(file); } catch (e) { toast(e.message, 'err'); return; }
    ps.crop = { canvas, quad: Scanner.findCorners(canvas), item };
    $('#cropDialog').showModal();
    drawCrop();
  }
  function drawCrop() {
    const { canvas, quad } = ps.crop, stage = $('#cropStage'), view = $('#cropCanvas');
    const maxW = stage.clientWidth || 360, maxH = Math.max(240, window.innerHeight - 190);
    const k = Math.min(maxW / canvas.width, maxH / canvas.height);
    view.width = Math.round(canvas.width * k); view.height = Math.round(canvas.height * k);
    const g = view.getContext('2d');
    g.drawImage(canvas, 0, 0, view.width, view.height);
    g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.rect(0, 0, view.width, view.height);
    quad.forEach(([x, y], i) => (i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k))); g.closePath(); g.fill('evenodd');
    g.strokeStyle = '#4fcd84'; g.lineWidth = 2; g.beginPath(); quad.forEach(([x, y], i) => (i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k))); g.closePath(); g.stroke();
    ps.crop.k = k;
    Object.assign($('#cropHandles').style, { left: view.offsetLeft + 'px', top: view.offsetTop + 'px', width: view.width + 'px', height: view.height + 'px' });
    $('#cropHandles').innerHTML = quad.map(([x, y], i) => `<span class="handle" data-h="${i}" style="left:${x * k}px;top:${y * k}px" aria-label="Corner ${i + 1}"></span>`).join('');
  }
  function dragHandle(e) {
    const h = e.target.closest('.handle'); if (!h) return;
    e.preventDefault();
    const i = Number(h.dataset.h), rect = $('#cropCanvas').getBoundingClientRect();
    const move = (ev) => {
      const { canvas, k } = ps.crop;
      const x = Math.max(0, Math.min(canvas.width, (ev.clientX - rect.left) / k)), y = Math.max(0, Math.min(canvas.height, (ev.clientY - rect.top) / k));
      ps.crop.quad[i] = [x, y]; drawCrop();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }
  async function keepPage() {
    const { canvas, quad, item } = ps.crop;
    $('#cropKeep').disabled = true; $('#cropKeep').textContent = 'Straightening…';
    await new Promise((r) => setTimeout(r, 30));
    try {
      const flat = Scanner.flatten(canvas, quad);
      await addPage(item, await Scanner.toJpeg(flat, 0.85));
      $('#cropDialog').close();
      toast('Page added');
      await render();
    } catch (e) { toast('Could not keep that page: ' + e.message, 'err'); }
    finally { $('#cropKeep').disabled = false; $('#cropKeep').textContent = 'Keep page'; }
  }

  /* ---------- saving: one PDF per item, kept on the phone ---------- */
  async function saveAll() {
    const btn = $('#poeSave'); btn.disabled = true; btn.textContent = 'Making the PDF…';
    try {
      for (const it of [...ps.picked]) {
        const d = ps.drafts[it];
        if (!d || (!(d.pages || []).length && !d.pdfOnly)) continue;
        let pdf;
        if (d.pdfOnly) pdf = await attachment(d, 'doc.pdf');
        else {
          const pages = [];
          for (const name of d.pages) {
            const c = await Scanner.load(await attachment(d, name));
            const f = Scanner.filter(c, d.filter || 'document');
            pages.push({ jpeg: await Scanner.toJpeg(f, d.filter === 'colour' ? 0.72 : 0.68), width: f.width, height: f.height });
          }
          pdf = await Scanner.pdf(pages);
        }
        const doc = { _id: 'ev:' + uid(), type: 'evidence', status: 'saved', unitCode: d.unitCode, unitName: d.unitName, item: d.item, pageCount: d.pdfOnly ? 0 : d.pages.length,
          bytes: pdf.size, createdAt: nowISO(), _attachments: { 'doc.pdf': { content_type: 'application/pdf', data: pdf } } };
        await sdb.put(doc);
        await sdb.remove(d._id, d._rev);
        ps.picked.delete(it);
      }
      toast('Saved on this phone. It is sent to the college Drive when you have internet.', 'ok');
      await render();
      sync();
    } catch (e) { toast('Could not save: ' + e.message, 'err'); }
    finally { btn.disabled = false; }
  }
  async function saveCopy(id) {
    const d = await sdb.get(id);
    const blob = await attachment(d, 'doc.pdf');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = d.fileName || `${d.unitName} - ${d.item}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------- sending to the Drive (via the college's Drive bridge) ---------- */
  const b64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
  async function sync() {
    const p = st.profile;
    if (ps.syncing || !p || !navigator.onLine || !st.sheetsUrl) return;
    ps.syncing = true;
    try {
      const waiting = (await allDocs()).filter((d) => d.status === 'saved' || d.status === 'uploading' || d.status === 'error');
      for (const d of waiting) {
        try {
          d.status = 'uploading'; await saveDraft(d); await render();
          // An upload whose confirmation was lost is confirmed again, not uploaded twice.
          if (!d.upload) {
            const blob = await attachment(d, 'doc.pdf');
            const t = await api('POST', null, { action: 'poeTicket', deviceId: st.deviceId, admNo: p.admNo, unitCode: d.unitCode, item: d.item, bytes: blob.size, pages: d.pageCount });
            if (!t.ok) throw new Error(t.error);
            const res = await fetch(t.driveUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify({ action: 'upload', ticket: t.ticket, data: await b64(blob), mime: 'application/pdf' }) });
            const up = await res.json();
            if (!up.ok) throw new Error(up.error || 'The Drive did not take the file');
            d.upload = { ticket: t.ticket, fileId: up.fileId, fileName: up.fileName, version: up.version, sig: up.sig };
            await saveDraft(d);
          }
          const up = d.upload;
          const done = await api('POST', null, { action: 'poeDone', ...up });
          if (!done.ok) throw new Error(done.error);
          Object.assign(d, { status: 'sent', serverId: done.evidence.id, fileName: up.fileName, version: up.version, sentAt: nowISO(), error: '' });
          delete d.upload;
          await saveDraft(d);
        } catch (e) {
          d.status = 'error';
          d.error = !navigator.onLine ? 'Waiting for internet'
            : /not set up|not switched on|link is not set/i.test(e.message) ? 'The college Drive is not connected yet. Your file is safe on this phone.'
            : 'Could not reach the Drive: ' + e.message;
          await saveDraft(d);
        }
      }
      const mine = await api('POST', null, { action: 'poeMine', deviceId: st.deviceId, admNo: p.admNo });
      if (mine.ok) { ps.server = mine.evidence; await updateLocal('poeMine', (x) => { x.list = mine.evidence; }); }
    } catch { /* offline */ }
    finally { ps.syncing = false; render(); }
  }

  /* ---------- wiring ---------- */
  function wire() {
    $('#viewTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      document.body.dataset.view = b.dataset.view;
      $$('#viewTabs [data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (b.dataset.view === 'poe') { loadUnits().then(render); sync(); }
    });
    $('#poeUnit').addEventListener('change', (e) => { ps.unit = e.target.value; ps.picked = new Set(); render(); });
    $('#poeItems').addEventListener('click', (e) => {
      const b = e.target.closest('[data-item]'); if (!b) return;
      const it = b.dataset.item;
      if (ps.picked.has(it) && !ps.drafts[it]) ps.picked.delete(it); else ps.picked.add(it);
      render();
    });
    $('#poeDocs').addEventListener('click', async (e) => {
      const card = e.target.closest('[data-doc]'); if (!card) return;
      const item = card.dataset.doc;
      if (e.target.closest('[data-camera]')) { ps.target = item; $('#poeCamera').click(); return; }
      if (e.target.closest('[data-gallery]')) { ps.target = item; $('#poeGallery').click(); return; }
      const d = await draft(item);
      const li = e.target.closest('[data-page]');
      if (e.target.closest('[data-filter]')) { d.filter = e.target.closest('[data-filter]').dataset.filter; await saveDraft(d); return render(); }
      if (e.target.closest('[data-clear]')) { if (d._rev) await sdb.remove(d._id, d._rev); ps.picked.delete(item); return render(); }
      if (li && e.target.closest('[data-del]')) {
        const [gone] = d.pages.splice(Number(li.dataset.page), 1);
        if (d._attachments) delete d._attachments[gone];
        await saveDraft(d); return render();
      }
      if (li && e.target.closest('[data-move]')) {
        const i = Number(li.dataset.page), j = i + Number(e.target.closest('[data-move]').dataset.move);
        [d.pages[i], d.pages[j]] = [d.pages[j], d.pages[i]]; await saveDraft(d); return render();
      }
    });
    $('#poeCamera').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openCrop(f, ps.target); });
    $('#poeGallery').addEventListener('change', async (e) => {
      const files = [...e.target.files]; e.target.value = '';
      const pdf = files.find((f) => f.type === 'application/pdf');
      if (pdf) {
        const d = await draft(ps.target);
        Object.assign(d, { pdfOnly: true, pdfName: pdf.name, pages: [], _attachments: { 'doc.pdf': { content_type: 'application/pdf', data: pdf } } });
        await saveDraft(d); return render();
      }
      for (const f of files) { await openCrop(f, ps.target); await new Promise((r) => $('#cropDialog').addEventListener('close', r, { once: true })); }
    });
    $('#cropHandles').addEventListener('pointerdown', dragHandle);
    $('#cropCancel').addEventListener('click', () => $('#cropDialog').close());
    $('#cropRotate').addEventListener('click', () => { ps.crop.canvas = Scanner.rotate(ps.crop.canvas); ps.crop.quad = Scanner.findCorners(ps.crop.canvas); drawCrop(); });
    $('#cropWhole').addEventListener('click', () => { const c = ps.crop.canvas; ps.crop.quad = [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]]; drawCrop(); });
    $('#cropKeep').addEventListener('click', keepPage);
    $('#poeSave').addEventListener('click', saveAll);
    $('#poeList').addEventListener('click', (e) => {
      if (e.target.closest('[data-retry]')) { sync(); return; }
      const c = e.target.closest('[data-copy]');
      if (c) { saveCopy(c.dataset.id || c.closest('[data-local]').dataset.local); return; }
      const r = e.target.closest('[data-redo]');
      if (r) { const [u, it] = r.dataset.redo.split('|'); ps.unit = u; ps.picked = new Set([it]); render(); $('#poeCard').scrollIntoView({ behavior: 'smooth' }); }
    });
    window.addEventListener('online', () => sync());
    setInterval(() => sync(), 3 * 60 * 1000);
  }

  async function init() {
    const cached = await getLocal('poeMine'); ps.server = cached.list || [];
    wire();
    await loadUnits();
    await render();
  }
  return { init, render, sync, state: ps };
})();
