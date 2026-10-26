/* Student app — POE evidence: scan pages like a document scanner, keep the PDF on the device, and send it
 * when there is internet: to the student's own college Google Drive, shared with the trainer (google.js, when
 * config.js has a googleClientId); the student connects Google first. Statuses (with your trainer, approved, returned) come back
 * when the app opens, when it comes back into view, after an upload, and when a notification arrives.
 * Uses student.js (st, sdb, api, toast, esc, $) and scanner.js. */
'use strict';

const POE = (() => {
  const ITEMS = ['CAT1', 'CAT2', 'CAT3', 'CAT4', 'PRAC1', 'PRAC2', 'PRAC3'];
  const ps = { units: [], unit: '', picked: new Set(), drafts: {}, server: [], syncing: false, crop: null, target: null, notify: null };
  const $$ = (q, el = document) => [...el.querySelectorAll(q)];
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const draftId = (unit, item) => `ev:draft:${unit}:${item}`;
  const unitName = (code) => (ps.units.find((u) => u.code === code) || { name: code }).name;

  async function allDocs() { return (await sdb.allDocs({ include_docs: true, startkey: 'ev:', endkey: 'ev:￿' })).rows.map((r) => r.doc); }
  async function attachment(doc, name) { return sdb.getAttachment(doc._id, name); }

  /* ---------- units of my class (cached for offline) ---------- */
  const MIN_PAGES = 2;   // a submission is never a single page
  const pagesOf = (d) => (d?.pdfOnly ? Number(d.pdfPages) || 0 : (d?.pages || []).length);
  async function loadUnits() {
    const p = st.profile; if (!p) return;
    const cache = await getLocal('poeUnits');
    if (cache.classCode === p.classCode) { ps.units = cache.units || []; ps.ready = cache.driveReady; ps.pushReady = cache.pushReady; }
    if (navigator.onLine && st.sheetsUrl) {
      try {
        const r = await api('GET', { action: 'units', class: p.classCode });
        if (r.ok) {
          ps.units = r.units; ps.ready = r.driveReady; ps.pushReady = r.pushReady;
          await updateLocal('poeUnits', (d) => { d.classCode = p.classCode; d.units = r.units; d.driveReady = r.driveReady; d.pushReady = r.pushReady; });
        }
      } catch { /* offline: the cached list */ }
    }
  }

  /* ---------- the screen ---------- */
  async function render() {
    const card = $('#poeCard'); if (!card) return;
    if (!st.profile) { card.hidden = true; $('#poeListCard').hidden = true; return; }
    card.hidden = false;
    renderGoogle();
    const sel = $('#poeUnit');
    sel.innerHTML = ps.units.length ? ps.units.map((u) => `<option value="${esc(u.code)}">${esc(u.code)} - ${esc(u.name)}${u.current === false ? ' (earlier term)' : ''}</option>`).join('')
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
    const started = Object.values(ps.drafts).filter((d) => pagesOf(d) > 0);
    const ready = started.filter((d) => pagesOf(d) >= MIN_PAGES).length, short = started.length - ready;
    $('#poeSave').disabled = !ready || short > 0;
    $('#poeSave').textContent = short ? `Add at least ${MIN_PAGES} pages to each item` : ready ? `Save and send ${ready === 1 ? 'the document' : ready + ' documents'}` : `Scan at least ${MIN_PAGES} pages`;
    // Thumbnails load after the cards exist: the small copy of each page, not the page itself.
    for (const u of ps.thumbUrls || []) URL.revokeObjectURL(u);
    ps.thumbUrls = [];
    for (const it of ps.picked) {
      const d = ps.drafts[it]; if (!d) continue;
      (d.pages || []).forEach(async (name, i) => {
        const img = document.querySelector(`[data-doc="${it}"] [data-page="${i}"] img`);
        if (!img || img.src) return;
        const url = URL.createObjectURL(await attachment(d, d._attachments?.['t-' + name] ? 't-' + name : name));
        ps.thumbUrls.push(url); img.src = url;
      });
    }
    await renderList(docs);
    await renderNotify();
  }
  /* ---------- the student's own Google Drive ---------- */
  const viaGoogle = () => typeof Google !== 'undefined' && Google.on();
  function renderGoogle() {
    const box = $('#poeGoogle'); if (!box) return;
    box.hidden = false;
    $('#poeIntro').textContent = 'Scan your marked CAT or practical like a document. It is saved on this device first, then in your own Google Drive when you have internet, and shared with your trainer, who approves it.';
    if (!viaGoogle()) { box.className = 'google-row'; box.innerHTML = '<span class="small">Google Drive is not set up for this app yet. Your documents are safe on this device. Ask your MIS Officer.</span>'; return; }
    const mail = Google.email(), live = !!Google.token('student');
    if (!Google.connected('student')) {
      box.className = 'google-row card';
      box.innerHTML = `<b>Connect your college Google account</b><span class="small">Your POE documents are saved in your own Google Drive and shared with your trainer. You do this once.</span><button type="button" class="btn primary" data-gsignin>Connect Google</button>`;
      return;
    }
    box.className = 'google-row';
    box.innerHTML = Google.supports()
      ? `<span class="small">Google Drive - connected as <b>${esc(mail)}</b></span><button type="button" class="linkish" data-gswitch>Change account</button>`
      : `<span class="small">Google Drive: <b>${esc(mail)}</b>${live ? '' : ' <span class="muted">(you sign in again when sending)</span>'}</span><button type="button" class="linkish" data-gswitch>Use another account</button>`;
  }
  async function googleSignIn(choose = false) {
    try { await Google.connect('student', { choose }); renderGoogle(); return true; } catch (e) { toast(e.message, 'err'); renderGoogle(); return false; }
  }
  /** True when this student's own Drive can be used right now (connected, a fresh sign-in is fetched silently). */
  async function driveReady() {
    if (!viaGoogle()) return false;
    try { await Google.ensure('student'); return true; } catch (e) { if (e instanceof Google.NeedSignIn) return false; throw e; }
  }
  /** A new trainer, HOD or MIS Officer since a file was sent: give them view access too (nobody is removed). */
  async function shareMissing(list) {
    if (!viaGoogle() || !(await driveReady())) return;
    for (const e of list) {
      if (!e.share?.length) continue;
      const done = [];
      for (const email of e.share) { try { await Google.share('student', e.fileId, email); done.push(email); } catch (err) { if (err instanceof Google.NeedSignIn) return; } }
      if (done.length) await api('POST', null, { action: 'poeShared', deviceId: st.deviceId, admNo: st.profile.admNo, id: e.id, emails: done }).catch(() => {});
    }
  }

  function docCard(item, d) {
    const pages = d?.pages || [];
    return `<div class="poe-doc" data-doc="${item}">
      <div class="poe-doc-head"><span class="item-tag">${item}</span><span class="muted small">${pagesOf(d)} page${pagesOf(d) === 1 ? '' : 's'}${d?.pdfOnly ? ' (PDF from the device)' : ''}</span></div>
      ${d?.pdfOnly ? `<p class="small">${esc(d.pdfName || 'document.pdf')} <button type="button" class="linkish" data-clear>Remove</button></p>` : `
      <ol class="poe-pages">${pages.map((_, i) => `<li data-page="${i}"><img alt="Page ${i + 1}" class="f-document"><span>${i + 1}</span>
        <span class="pg-tools"><button type="button" data-move="-1" aria-label="Move page ${i + 1} up" ${i ? '' : 'disabled'}>↑</button><button type="button" data-move="1" aria-label="Move page ${i + 1} down" ${i < pages.length - 1 ? '' : 'disabled'}>↓</button><button type="button" data-del aria-label="Delete page ${i + 1}">✕</button></span></li>`).join('')}</ol>`}
      <div class="row-actions"><button type="button" class="btn small primary" data-camera>${pages.length ? 'Add another page' : 'Take photo of a page'}</button><button type="button" class="btn small" data-gallery>From gallery or PDF</button></div>
    </div>`;
  }
  const STATUS = { submitted: ['pending', 'With your trainer'], approved: ['synced', 'Approved'], returned: ['rejected', 'Returned'] };
  /* My POE submissions: one table of what is still on this device and what has been sent, searchable, filterable and
   * sortable (tap a heading). */
  const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
  async function renderList(docs) {
    docs = docs || await allDocs();
    const local = docs.filter((d) => d.status !== 'draft');
    const rows = [];
    for (const d of local.filter((x) => x.status !== 'sent')) {
      const [cls, label] = d.status === 'uploading' ? ['pending', 'Sending…'] : d.status === 'error' ? ['rejected', 'Not sent yet'] : ['pending', 'Saved on device'];
      rows.push({ local: true, id: d._id, unit: d.unitName, item: d.item, version: null, at: d.createdAt, status: 'local', cls, label, note: d.error || '', copy: d._id,
        retry: d.status === 'error' && navigator.onLine, needGoogle: d.needGoogle });
    }
    // Only the latest version of each item (an older one sent again is replaced).
    const top = new Map();
    for (const e of ps.server) { const k = e.unitCode + '|' + e.item; if (!(top.get(k)?.version >= e.version)) top.set(k, e); }
    for (const e of top.values()) {
      const [cls, label] = STATUS[e.status] || ['pending', e.status];
      rows.push({ id: e.id, unit: e.unitName, item: e.item, version: e.version, at: e.submittedAt, status: e.status, cls, label, note: e.comment || '',
        copy: local.find((d) => d.serverId === e.id)?._id || '', redo: e.status === 'returned' ? `${e.unitCode}|${e.item}` : '' });
    }
    $('#poeListCard').hidden = !rows.length;
    if ($('#poeListCount')) $('#poeListCount').textContent = rows.length || '';
    try { if (!localStorage.getItem('tsort:poeMine')) Tables.setSort('poeMine', 'at', -1); } catch { /* private mode */ }   // newest first to start
    const q = ($('#poeSearch')?.value || '').trim().toLowerCase(), f = $('#poeFilter')?.value || '';
    const shown = Tables.sort('poeMine', rows.filter((r) => (!f || r.status === f) && (!q || [r.unit, r.item, r.note, r.label].some((x) => String(x || '').toLowerCase().includes(q)))),
      { unit: (r) => r.unit, item: (r) => r.item, v: (r) => r.version, at: (r) => r.at, status: (r) => r.label }, 'at');
    const page = Tables.slice('poeMine', shown), first = shown.indexOf(page[0]);
    $('#poeList').innerHTML = !shown.length ? '<p class="muted small">Nothing matches.</p>'
      : `<div class="table-wrap"><table class="report-table stu-table"><thead><tr><th class="num">S/N</th>${Tables.th('poeMine', 'unit', 'Document')}${Tables.th('poeMine', 'at', 'Sent')}${Tables.th('poeMine', 'status', 'Status')}</tr></thead>
        <tbody>${page.map((r, i) => `<tr${r.local ? ` data-local="${esc(r.id)}"` : ''}><td class="num">${first + i + 1}</td>
          <td><b>${esc(r.item)}</b>${r.version ? ` v${r.version}` : ''}<span class="sub">${esc(r.unit)}</span></td>
          <td class="small">${esc(shortDate(r.at))}</td>
          <td><span class="pill ${r.cls}">${esc(r.label)}</span>${r.note ? `<span class="sub">${r.local ? esc(r.note) : `<b>Comment(s):</b> ${esc(r.note)}`}</span>` : ''}
            <span class="acts">${r.retry ? `<button type="button" class="linkish" data-retry>${r.needGoogle ? 'Connect Google and send' : 'Try again'}</button>` : ''}${r.redo ? `<button type="button" class="linkish" data-redo="${esc(r.redo)}">Scan again</button>` : ''}${r.copy ? `<button type="button" class="linkish" data-copy data-id="${esc(r.copy)}">Save a copy</button>` : ''}</span></td></tr>`).join('')}</tbody></table></div>${Tables.bar('poeMine', shown)}`;
  }

  /* ---------- drafts: one per unit and item, kept on the device ---------- */
  async function draft(item) {
    const id = draftId(ps.unit, item);
    try { return await sdb.get(id); } catch (e) { if (e.status !== 404) throw e; }
    return { _id: id, type: 'evidence', status: 'draft', unitCode: ps.unit, unitName: unitName(ps.unit), item, pages: [], createdAt: nowISO() };
  }
  async function saveDraft(d) { const r = await sdb.put(d); d._rev = r.rev; return d; }
  async function addPage(item, blob, small) {
    const d = await draft(item);
    const name = `p${Date.now().toString(36)}.jpg`;
    d.pages = [...(d.pages || []), name];
    d._attachments = { ...(d._attachments || {}), [name]: { content_type: 'image/jpeg', data: blob } };
    if (small) d._attachments['t-' + name] = { content_type: 'image/jpeg', data: small };
    if (d.pdfOnly) { delete d.pdfOnly; delete d._attachments['doc.pdf']; }
    await saveDraft(d);
  }

  /* ---------- the crop screen ---------- */
  /** Closes the crop screen and gives its photo's memory back (a phone closes the page when memory runs out). */
  function closeCrop() {
    if ($('#cropDialog').open) $('#cropDialog').close();
    if (ps.crop) { Scanner.release(ps.crop.canvas); ps.crop = null; }
    Scanner.release($('#cropCanvas'));
  }
  async function openCrop(file, item) {
    $('#cropNext').textContent = ps.fromCam ? 'Keep and take the next page' : 'Keep page';
    ps.cropSeq = (ps.cropSeq || 0) + 1;
    if (ps.crop) { Scanner.release(ps.crop.canvas); ps.crop = null; }
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
    const o = Scanner.outSize(quad);
    $('#cropInfo').textContent = `Photo ${canvas.width} x ${canvas.height} - page will be about ${o.w} x ${o.h}`;
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
  /** Straightens the page, saves it (with a small copy for the list) and lets go of the photo. True when kept. */
  async function keepPage() {
    if (!ps.crop || ps.keeping) return false;
    const { canvas, quad, item } = ps.crop;
    ps.keeping = true;
    const btn = $('#cropNext'), label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Straightening…';
    await new Promise((r) => setTimeout(r, 30));
    let flat = null, small = null;
    try {
      flat = Scanner.flatten(canvas, quad);
      // The preview is shown stretched to the full width of the page card, so it is kept large enough to stay sharp there
      // (the old 320px/0.7 copy looked blurred); the full-quality page is still what is sent.
      small = Scanner.thumb(flat, 720);
      // Kept at high quality: the page is compressed again when the PDF is made, so little is lost twice.
      const [page, preview] = await Promise.all([Scanner.toJpeg(flat, 0.94), Scanner.toJpeg(small, 0.82)]);
      Scanner.release(flat); Scanner.release(small); flat = small = null;
      closeCrop();
      await addPage(item, page, preview);
      toast('Page added');
      await render();
      return true;
    } catch (e) { toast('Could not keep that page: ' + e.message, 'err'); return false; }
    finally {
      Scanner.release(flat); Scanner.release(small);
      ps.keeping = false;
      btn.disabled = false; btn.textContent = label;
    }
  }
  /** The phone's own camera app (only when the camera inside the app cannot be used). */
  function openCamera(item) { ps.target = item; ps.cameraAt = Date.now(); $('#poeCamera').click(); }
  /** True while a page is being taken: the camera or crop screen is open, a page is being saved, or the camera app may be up. */
  const busy = () => !!($('#docCamDialog').open || $('#cropDialog').open || ps.keeping || (ps.cameraAt && Date.now() - ps.cameraAt < 3 * 60e3));

  /* ---------- the camera inside the app ----------
   * Opening the phone's camera app sends the browser to the background, and Android often closes it to make room
   * ("unable to complete previous operation due to low memory"), so the page taken is lost. A live camera inside
   * the page never leaves the browser, and goes straight back to the next page. */
  let camStream = null;
  const camOk = () => !!navigator.mediaDevices?.getUserMedia;
  async function openDocCam(item) {
    ps.target = item;
    if (!camOk() || ps.useCameraApp) return openCamera(item);   // still inside the tap, so the camera app can open
    const d = ps.drafts[item], n = (d?.pdfOnly ? 0 : (d?.pages || []).length) + 1;
    $('#docCamTitle').textContent = `${item} - page ${n}`;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } } });
    } catch (e) {
      if (e && e.name === 'NotAllowedError') { toast('Allow the camera for this app (browser settings), or use "From gallery or PDF".', 'err'); return; }
      ps.useCameraApp = true;     // from now on this device uses the phone's camera app
      toast('The camera could not be opened inside the app. Tap "Take photo of a page" again to use the camera app.', 'err');
      return;
    }
    const video = $('#docCamVideo');
    video.srcObject = camStream;
    if (!$('#docCamDialog').open) $('#docCamDialog').showModal();
    await video.play().catch(() => {});
    await sharpenStream(camStream.getVideoTracks()[0]);
  }
  /** Asks the camera for its largest picture, and for continuous focus and exposure, where it supports them. */
  async function sharpenStream(track) {
    try {
      const caps = track.getCapabilities?.() || {};
      if (caps.width?.max && caps.height?.max) {
        try { await track.applyConstraints({ width: { ideal: caps.width.max }, height: { ideal: caps.height.max } }); } catch { /* keeps what it has */ }
      }
      const adv = {};
      const has = (list, v) => Array.isArray(list) && list.includes(v);
      if (has(caps.focusMode, 'continuous')) adv.focusMode = 'continuous'; else if (has(caps.focusMode, 'auto')) adv.focusMode = 'auto';
      if (has(caps.exposureMode, 'continuous')) adv.exposureMode = 'continuous';
      if (Object.keys(adv).length) { try { await track.applyConstraints({ advanced: [adv] }); } catch { /* not supported */ } }
    } catch { /* the camera stays as it opened */ }
    const video = $('#docCamVideo');
    for (let i = 0; i < 10 && video.videoWidth < 1600; i++) await new Promise((r) => setTimeout(r, 100));   // the higher size takes a moment
  }
  function stopDocCam() {
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
    $('#docCamVideo').srcObject = null;
    if ($('#docCamDialog').open) $('#docCamDialog').close();
  }
  /** Takes the page: a full photo from the camera when the browser can (sharper), else the frame on screen. */
  async function shootPage() {
    const video = $('#docCamVideo'), btn = $('#docCamShot'), hint = $('#docCamHint'), track = camStream?.getVideoTracks()[0];
    if (!track || btn.disabled) return;
    btn.disabled = true;
    const hintText = hint.textContent;
    hint.textContent = 'Focusing…';
    let blob = null;
    try {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      let caps = {};
      try { caps = track.getCapabilities?.() || {}; } catch { caps = {}; }
      let focused = false;
      if (Array.isArray(caps.focusMode) && caps.focusMode.includes('single-shot')) {
        try { await track.applyConstraints({ advanced: [{ focusMode: 'single-shot' }] }); focused = true; await wait(450); } catch { focused = false; }
      }
      if (!focused) await wait(250);
      if (window.ImageCapture) {
        try {
          const ic = new ImageCapture(track);
          let opts;
          try { const pc = await ic.getPhotoCapabilities(); if (pc?.imageWidth?.max && pc?.imageHeight?.max) opts = { imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight.max }; } catch { opts = undefined; }
          try { blob = opts ? await ic.takePhoto(opts) : await ic.takePhoto(); } catch { blob = null; }
          if (!blob && opts) { try { blob = await ic.takePhoto(); } catch { blob = null; } }
        } catch { blob = null; }
      }
      if (!blob && video.videoWidth) {
        const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        blob = await Scanner.toJpeg(c, 0.94);
        Scanner.release(c);
      }
    } finally { btn.disabled = false; hint.textContent = hintText; }
    if (!blob) { toast('That page could not be taken. Try again.', 'err'); return; }
    const item = ps.target;
    stopDocCam();                  // the camera is let go while the page is adjusted (less memory)
    ps.fromCam = true;
    $('#cropCancel').textContent = 'Retake';
    await openCrop(blob, item);
  }

  /* ---------- saving: one PDF per item, kept on the device ---------- */
  async function saveAll() {
    const btn = $('#poeSave');
    btn.disabled = true; btn.textContent = 'Making the PDF…';
    try {
      for (const it of [...ps.picked]) {
        const d = ps.drafts[it];
        if (!d || pagesOf(d) < MIN_PAGES) continue;
        let pdf;
        if (d.pdfOnly) pdf = await attachment(d, 'doc.pdf');
        else {
          const pages = [];
          for (const name of d.pages) {
            const c = await Scanner.load(await attachment(d, name));
            // The photo as taken (straightened, no cleaning filter), high quality, at most 2 MB a page.
            const page = await Scanner.page(c);
            Scanner.release(c);   // one page in memory at a time
            pages.push(page);
          }
          pdf = await Scanner.pdf(pages);
        }
        const doc = { _id: 'ev:' + uid(), type: 'evidence', status: 'saved', unitCode: d.unitCode, unitName: d.unitName, item: d.item, pageCount: d.pdfOnly ? 0 : d.pages.length,
          bytes: pdf.size, createdAt: nowISO(), _attachments: { 'doc.pdf': { content_type: 'application/pdf', data: pdf } } };
        await sdb.put(doc);
        await sdb.remove(d._id, d._rev);
        ps.picked.delete(it);
      }
      queueOutbox();
      toast(viaGoogle() && Google.connected('student') ? 'Saved on this device. It goes to your Google Drive when you have internet.' : 'Saved on this device. It is sent once you connect Google.', 'ok');
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

  /* ---------- sending ----------
   * The sending itself (always the student's own Google Drive) is student-outbox.js, the same
   * code the phone runs when the app is closed. This only draws the screen around it and fetches the statuses. */
  /** The student's Google sign-in for the Outbox: '' when they have not connected Google. */
  async function googleToken(fresh) {
    if (fresh) Google.drop();
    try { return await Google.ensure('student'); } catch (e) { if (e instanceof Google.NeedSignIn) return ''; throw e; }
  }
  async function sync() {
    const p = st.profile;
    if (ps.syncing || !p || !navigator.onLine || !st.sheetsUrl) return;
    // Documents go only to the student's own Drive: without Google connected they wait on the phone.
    ps.syncing = true;
    try {
      const res = await Outbox.run({ db: sdb, serverUrl: st.sheetsUrl, deviceId: st.deviceId, admNo: p.admNo, parts: ['evidence'], wait: true,
        getToken: viaGoogle() ? googleToken : async () => '', onChange: () => render() });
      if (res.failed && !res.needGoogle) window.queueOutbox?.();   // something could not go: the phone tries again later, even with the app closed
      const mine = await api('POST', null, { action: 'poeMine', deviceId: st.deviceId, admNo: p.admNo });
      if (mine.ok) { ps.server = mine.evidence; await updateLocal('poeMine', (x) => { x.list = mine.evidence; }); await shareMissing(mine.evidence); }
    } catch { /* offline */ }
    finally { ps.syncing = false; render(); }
  }

  /* ---------- "Notify me about my evidence" ----------
   * Standard browser notifications: the device subscribes with the college's public key (config.js) and
   * the server pokes it when a trainer decides on something. Permission is only ever asked for when the
   * student taps the switch, never when the app opens. */
  const vapidKey = () => window.ATTENDANCE_CONFIG?.vapidPublicKey || '';
  const pushCan = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!vapidKey();
  const onIphone = () => /iP(hone|od|ad)/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
  const installed = () => window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
  const keyBytes = (s) => {
    const x = s.replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(x + '='.repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };
  async function subscription() {
    if (!pushCan()) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? await reg.pushManager.getSubscription() : null;
  }
  /** What the service worker needs when a notification wakes it: it cannot read this app's database. */
  async function rememberIdentity() { await window.rememberIdentity?.(); }
  async function renderNotify() {
    const row = $('#poeNotify'), box = $('#poeNotifyOn'), hint = $('#poeNotifyHint');
    if (!row) return;
    // An iPhone can only do this once the app is on the Home Screen; other browsers that cannot, say nothing.
    if (!pushCan()) {
      const why = onIphone() && !installed() && vapidKey()
        ? 'To be told about your evidence on an iPhone, first add this app to your Home Screen (tap Share, then “Add to Home Screen”) and open it from there.' : '';
      row.hidden = !why;
      if (why) { box.closest('label').hidden = true; hint.textContent = why; }
      return;
    }
    box.closest('label').hidden = false;
    row.hidden = false;
    const sub = await subscription();
    box.checked = !!sub && Notification.permission === 'granted';
    if (box.checked) await rememberIdentity();   // keeps the server address and the device's details in step
    hint.textContent = box.checked ? 'Your device will tell you when your trainer approves your work or sends it back.'
      : Notification.permission === 'denied' ? 'Notifications are switched off for this app in your device settings. Turn them on there first.'
      : 'Your device tells you when your trainer approves your work or sends it back.';
  }
  async function toggleNotify(on) {
    const box = $('#poeNotifyOn');
    box.disabled = true;
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!on) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api('POST', null, { action: 'pushUnsubscribe', deviceId: st.deviceId, admNo: st.profile.admNo, endpoint: sub.endpoint }).catch(() => {});
          await sub.unsubscribe();
        }
        toast('Notifications off');
        return;
      }
      const ask = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (ask !== 'granted') { toast(ask === 'denied' ? 'Your device is blocking notifications for this app' : 'Not switched on', 'err'); return; }
      const sub = await reg.pushManager.getSubscription()
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey()) });
      const r = await api('POST', null, { action: 'pushSubscribe', deviceId: st.deviceId, admNo: st.profile.admNo, endpoint: sub.endpoint });
      if (!r.ok) throw new Error(r.error);
      await rememberIdentity();
      toast('Done - your device will tell you about your evidence', 'ok');
    } catch (e) {
      toast((on ? 'Could not switch that on: ' : 'Could not switch that off: ') + e.message, 'err');
    } finally {
      box.disabled = false;
      await renderNotify();
    }
  }

  /* ---------- wiring ---------- */
  function wire() {
    $('#viewTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      document.body.dataset.view = b.dataset.view;
      $$('#viewTabs [data-view]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (b.dataset.view === 'poe') { if (viaGoogle()) Google.preload(); loadUnits().then(render); sync(); }
      if (b.dataset.view === 'subs') { render(); sync(); window.syncAttendance?.({ force: true }); }
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
      if (e.target.closest('[data-camera]')) { openDocCam(item); return; }
      if (e.target.closest('[data-gallery]')) { ps.target = item; ps.cameraAt = Date.now(); $('#poeGallery').click(); return; }
      const d = await draft(item);
      const li = e.target.closest('[data-page]');
      if (e.target.closest('[data-clear]')) { if (d._rev) await sdb.remove(d._id, d._rev); ps.picked.delete(item); return render(); }
      if (li && e.target.closest('[data-del]')) {
        const [gone] = d.pages.splice(Number(li.dataset.page), 1);
        if (d._attachments) { delete d._attachments[gone]; delete d._attachments['t-' + gone]; }
        await saveDraft(d); return render();
      }
      if (li && e.target.closest('[data-move]')) {
        const i = Number(li.dataset.page), j = i + Number(e.target.closest('[data-move]').dataset.move);
        [d.pages[i], d.pages[j]] = [d.pages[j], d.pages[i]]; await saveDraft(d); return render();
      }
    });
    $('#poeCamera').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; ps.cameraAt = 0; ps.fromCam = false; $('#cropCancel').textContent = 'Cancel'; if (f) openCrop(f, ps.target); });
    $('#docCamShot').addEventListener('click', shootPage);
    $('#docCamDone').addEventListener('click', stopDocCam);
    $('#docCamDialog').addEventListener('close', () => { camStream?.getTracks().forEach((t) => t.stop()); camStream = null; });
    $('#poeGallery').addEventListener('change', async (e) => {
      const files = [...e.target.files]; e.target.value = ''; ps.cameraAt = 0; ps.fromCam = false; $('#cropCancel').textContent = 'Cancel';
      const pdf = files.find((f) => f.type === 'application/pdf');
      if (pdf) {
        const text = new TextDecoder('latin1').decode(new Uint8Array(await pdf.arrayBuffer()));
        const count = (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
        if (count && count < MIN_PAGES) { toast(`That PDF has ${count} page. A submission needs at least ${MIN_PAGES} pages.`, 'err'); return; }
        const d = await draft(ps.target);
        Object.assign(d, { pdfOnly: true, pdfName: pdf.name, pdfPages: count || MIN_PAGES, pages: [], _attachments: { 'doc.pdf': { content_type: 'application/pdf', data: pdf } } });
        await saveDraft(d); return render();
      }
      for (const f of files) {
        await openCrop(f, ps.target);
        if ($('#cropDialog').open) await new Promise((r) => $('#cropDialog').addEventListener('close', r, { once: true }));
      }
    });
    $('#cropHandles').addEventListener('pointerdown', dragHandle);
    // From the camera inside the app, Cancel is "Retake": back to the live camera for the same page.
    $('#cropCancel').addEventListener('click', () => { const item = ps.crop?.item; const again = ps.fromCam && item; closeCrop(); if (again) openDocCam(item); });
    $('#cropDialog').addEventListener('close', () => { if (!ps.keeping && ps.crop) { Scanner.release(ps.crop.canvas); ps.crop = null; } });
    // Keep this page, and only then open the camera for the next one: opening it while the page is still being
    // straightened is when a phone, short of memory, closes the browser (and the app reloads).
    // One button: from the camera it keeps the page and goes straight to the next one (Done on the camera finishes);
    // for photos picked from the gallery it just keeps the page.
    $('#cropNext').addEventListener('click', async () => {
      const item = ps.crop?.item, started = Date.now(), fromCam = ps.fromCam;
      if (!item || !(await keepPage())) return;
      if (!fromCam) return;
      // The camera inside the app opens again at once. The phone's camera app can only be opened for a few
      // seconds after a tap, so with that one the student may need to tap "Add another page".
      if (camOk() && !ps.useCameraApp) openDocCam(item);
      else if (Date.now() - started < 4000) openCamera(item);
      else toast('Page added. Tap "Add another page" for the next one.', 'ok');
    });
    $('#poeSearch').addEventListener('input', () => { Tables.reset('poeMine'); renderList(); });
    $('#poeFilter').addEventListener('change', () => { Tables.reset('poeMine'); renderList(); });
    Tables.on('poeMine', () => renderList());
    $('#poeGoogle').addEventListener('click', (e) => {
      if (e.target.closest('[data-gsignin]')) googleSignIn().then((ok) => ok && sync());
      if (e.target.closest('[data-gswitch]')) { Google.signOut(); googleSignIn(true).then((ok) => ok && sync()); }
    });
    $('#poeSave').addEventListener('click', saveAll);
    $('#poeList').addEventListener('click', (e) => {
      if (e.target.closest('[data-retry]')) {
        if (viaGoogle() && !Google.connected('student')) { googleSignIn().then((ok) => ok && sync()); return; }
        sync(); return;
      }
      const c = e.target.closest('[data-copy]');
      if (c) { saveCopy(c.dataset.id || c.closest('[data-local]').dataset.local); return; }
      const r = e.target.closest('[data-redo]');
      if (r) { const [u, it] = r.dataset.redo.split('|'); ps.unit = u; ps.picked = new Set([it]); render(); $('#poeCard').scrollIntoView({ behavior: 'smooth' }); }
    });
    $('#poeNotifyOn').addEventListener('change', (e) => toggleNotify(e.target.checked));
    // No timer: statuses are fetched when the app opens, when it comes back into view, after an upload,
    // when the internet comes back, and when a notification arrives. Nothing is asked for in between.
    window.addEventListener('online', () => sync());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
    navigator.serviceWorker?.addEventListener('message', (e) => {
      if (e.data?.type === 'evidence-changed') sync();
      if (e.data?.type === 'show-evidence') showEvidence();
    });
  }
  /** Brings the Submissions view to the front (after a tap on a notification): that is where the decisions are. */
  function showEvidence() {
    const btn = document.querySelector('#viewTabs [data-view=subs]');
    if (btn && !$('#viewTabs').hidden) btn.click();
  }

  async function init() {
    const cached = await getLocal('poeMine'); ps.server = cached.list || [];
    wire();
    if (viaGoogle()) {
      const call = (body) => api('POST', null, { ...body, deviceId: st.deviceId, admNo: st.profile?.admNo });
      Google.setServer('student', { connect: (code) => call({ action: 'googleConnect', code }), token: () => call({ action: 'googleToken' }), supported: () => Google.supports() });
      Google.probe(st.sheetsUrl).then(() => renderGoogle());
    }
    await loadUnits();
    await render();
    if (viaGoogle()) Google.preload();
    sync();   // on opening the app: send anything waiting and bring the statuses up to date
  }
  return { init, render, sync, showEvidence, busy, state: ps };
})();
