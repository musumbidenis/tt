/* Marks: the continuous assessment marksheet per class and unit (CAT 1–3, PRAC 1–3, each 0–100).
 * Entered on the phone, offline too; each student's row is saved on the phone at once and sent to the
 * server when there is internet. The server copy feeds the trainer's "Marksheets" Google Sheet and the
 * Excel export in RVNP's marksheet layout. AVG = sum of the three ÷ 3, only when all three are in (else C.R.N.M).
 * A marksheet is sent by its trainer, received by the Assessment Officer and approved by the HOD; the Excel footer
 * shows who, with initials for the signatures.
 * Uses app.js (state, api, $, $$, esc, toast, hasRole, me, getLocal, updateLocal, rosterFor, download). */
'use strict';

const Marks = (() => {
  const COLS = ['cat1', 'cat2', 'cat3', 'prac1', 'prac2', 'prac3'];
  const HEAD = { cat1: 'CAT 1', cat2: 'CAT 2', cat3: 'CAT 3', prac1: 'PRAC 1', prac2: 'PRAC 2', prac3: 'PRAC 3' };
  const ms = { q: '', roster: [], drawnKey: '', key: '', unit: '', sheets: [], saving: Promise.resolve(), sendTimer: null, sending: false, seq: 0 };
  // One marksheet per class and unit for the unit's whole life, whichever terms and trainers it spans.
  const LIFE = 'unit';
  const docId = (cls, unit) => `marks:${LIFE}:${cls}|${unit}`;
  const oldDocId = (cls, unit) => `marks:${state.meta.term?.id || 'term'}:${cls}|${unit}`;   // before marks spanned terms
  // AVG only when all three marks are in; with some missing the marksheet says C.R.N.M.
  const has = (r, k) => r?.[k] !== null && r?.[k] !== undefined && r?.[k] !== '';
  const avg = (r, keys) => (keys.every((k) => has(r, k)) ? Math.round(keys.reduce((n, k) => n + Number(r[k]), 0) / 3) : null);
  const avgText = (r, keys) => { const a = avg(r, keys); return a !== null ? String(Math.round(a)) : keys.some((k) => has(r, k)) ? 'C.R.N.M' : ''; };
  const show = (n) => (n === null || n === undefined ? '' : String(Math.round(n)));
  const canEdit = (unit) => (hasRole('HOD') || (hasRole('TRAINER') && isMyUnit(unit)));
  const parse = (v) => {
    const t = String(v ?? '').trim();
    if (t === '') return { ok: true, value: null };
    const n = /^\d{1,3}$/.test(t) ? Number(t) : NaN;   // whole numbers only: "7.5" and "7,5" are refused
    return n >= 0 && n <= 100 ? { ok: true, value: n } : { ok: false };
  };

  async function load(cls, unit) {
    let d = await getLocal(docId(cls, unit), { rows: {}, dirty: {} });
    d.rows = d.rows || {}; d.dirty = d.dirty || {};
    // Started afresh on the server: marks from before that moment go (once); anything typed since stays.
    const at = await resetAt();
    if (at && (d.resetAt || '') < at) {
      d = await updateLocal(docId(cls, unit), (x) => {
        x.rows = Object.fromEntries(Object.entries(x.rows || {}).filter(([, r]) => String(r.updatedAt || '') > at));
        x.dirty = Object.fromEntries(Object.entries(x.dirty || {}).filter(([k]) => x.rows[k]));
        x.sheet = null; x.resetAt = at;
      }, { rows: {}, dirty: {} });
    }
    // Marks typed on this device before marksheets spanned terms (and maybe not sent yet) move across once.
    if (!d._rev) {
      const old = await getLocal(oldDocId(cls, unit), { rows: {}, dirty: {} });
      if (old._rev && Object.keys(old.rows || {}).length) {
        d = await updateLocal(docId(cls, unit), (x) => { x.rows = { ...(old.rows || {}) }; x.dirty = { ...(old.dirty || {}) }; x.movedFrom = old._id; }, { rows: {}, dirty: {} });
      }
    }
    return d;
  }
  const rowOf = (r) => ({ admNo: r.admNo, ...Object.fromEntries(COLS.map((c) => [c, r[c]])), updatedAt: r.updatedAt, updatedBy: r.updatedBy, locked: r.locked || [], terms: r.terms || {} });
  /** The server's rows join the phone's: a row edited here and not sent yet stays as typed. */
  async function pull(cls, unit) {
    const res = await api('marksPull', { classCode: cls, unitCode: unit });
    if (!res.ok) throw new Error(res.error);
    return updateLocal(docId(cls, unit), (d) => {
      d.rows = d.rows || {}; d.dirty = d.dirty || {};
      for (const r of res.rows) {
        const k = lower(r.admNo), mine = d.rows[k];
        if (d.dirty[k] && mine && String(mine.updatedAt) > String(r.updatedAt)) continue;
        d.rows[k] = rowOf(r);
        delete d.dirty[k];
      }
      d.lockedTerms = res.lockedTerms || [];
      d.sheet = res.sheet || null;
      d.pulledAt = nowISO();
    }, { rows: {}, dirty: {} });
  }
  /** Sends one marksheet's unsent rows (or, with no arguments, every marksheet's) through the shared outbox. */
  async function sendMarks(only) {
    const out = await outbox({ registers: false, marks: true, ...(only ? { only } : {}) }).catch((e) => { wakeOutbox(); throw e; });
    if (out.held) toast(`${out.held} mark(s) were entered in a term that has ended, so they were kept as they were. The HOD or MIS Officer can unlock them.`, 'err');
    return out.marks;
  }
  async function push(cls, unit) {
    await load(cls, unit);     // brings an older marksheet across and applies a fresh start first
    return sendMarks([`${LIFE}:${cls}|${unit}`]);
  }
  /** Every marksheet on this phone with unsent rows (run with the register sync and when the internet returns). */
  async function syncAll({ quiet = false } = {}) {
    if (!navigator.onLine || !state.auth || ms.sending) return 0;
    ms.sending = true;
    let sent = 0;
    try {
      // _local docs are not listed by the database, so the phone keeps its own list of marksheets with unsent rows.
      const idx = await getLocal('marksIndex', { keys: [] });
      for (const key of idx.keys || []) { const [cls, unit] = key.slice(key.indexOf(':') + 1).split('|'); await load(cls, unit); }
      sent = await sendMarks();
      if (sent && !quiet) toast(`Marks sent for ${sent} student(s)`, 'ok');
    } catch (e) { if (!quiet) toast('Marks not sent yet: ' + e.message, 'err'); }
    finally { ms.sending = false; }
    if (state.reportMode === 'marks') status();
    return sent;
  }
  const pendingFor = (d) => Object.keys(d?.dirty || {}).length;

  /* ---------- the marks table ----------
   * Marks are kept per class and unit. With streams, the chosen streams' marksheets show as one table:
   * each student's marks are saved in, and sent to, their own stream's marksheet. */
  const sheetOf = (cls) => ms.sheets.find((s) => s.cls === cls) || ms.sheets[0];
  const rowFor = (t) => sheetOf(t.cls).doc.rows[lower(t.admNo)] || {};
  const pendingAll = () => (ms.sheets || []).reduce((n, s) => n + pendingFor(s.doc), 0);
  async function render() {
    const codes = reportCodes(), unit = $('#rUnit').value, box = $('#marksCard');
    if (!codes.length || !unit) { box.innerHTML = '<p class="empty">Choose a class and unit to enter its marks.</p>'; return; }
    const seq = ++ms.seq;
    ms.unit = unit; ms.key = codes.join(',') + '|' + unit;
    ms.sheets = await Promise.all(codes.map(async (cls) => ({ cls, doc: await load(cls, unit) })));
    if (seq !== ms.seq) return;
    draw();
    if (navigator.onLine && state.auth) {
      await ms.saving;
      const fresh = await Promise.all(ms.sheets.map((s) => pull(s.cls, unit).catch((e) => { ms.pullError = e.message; return null; })));
      if (seq !== ms.seq) return;
      ms.sheets.forEach((s, i) => {
        const f = fresh[i]; if (!f) return;
        // Anything typed while the server's copy was on its way stays as typed.
        for (const k of Object.keys(s.doc.dirty)) {
          if (!f.rows[k] || String(s.doc.rows[k]?.updatedAt) >= String(f.rows[k].updatedAt)) { f.rows[k] = s.doc.rows[k]; f.dirty[k] = true; }
        }
        s.doc = f;
      });
      if ($('#marksCard').contains(document.activeElement)) refreshValues(); else draw();
      if (pendingAll()) scheduleSend();
    }
  }
  function draw() {
    const unit = ms.unit, many = ms.sheets.length > 1;
    for (const s of ms.sheets) { s.u = state.units.find((x) => x.classCode === s.cls && x.code === unit) || { code: unit, name: unit }; s.edit = canEdit(s.u); }
    const roster = [];
    for (const s of ms.sheets) {
      const tag = many ? streamLetter(s.cls) || s.cls : '';
      const list = rosterFor(s.cls).map((t) => ({ ...t, cls: s.cls, stream: tag }));
      // Students who have marks but left the list stay visible so nothing is lost.
      for (const r of Object.values(s.doc.rows)) if (!list.some((t) => lower(t.admNo) === lower(r.admNo))) list.push({ admNo: r.admNo, name: r.admNo, gone: true, cls: s.cls, stream: tag });
      roster.push(...list);
    }
    roster.sort((a, b) => String(a.admNo).localeCompare(String(b.admNo)));
    if (ms.drawnKey !== ms.key) { ms.drawnKey = ms.key; ms.q = ''; Tables.reset('marks'); }
    ms.roster = roster;
    const edits = ms.sheets.filter((s) => s.edit).length, u = ms.sheets[0].u;
    const locked = new Map();
    for (const s of ms.sheets) for (const t of s.doc.lockedTerms || []) locked.set(t.id, t.name);
    $('#marksCard').innerHTML = `
      <div class="marks-head">
        <div><h2>${esc(u.name)}</h2>${many ? `<p class="muted small">Streams ${ms.sheets.map((s) => esc(streamLetter(s.cls) || s.cls)).join(', ')} together</p>` : ''}</div>
        <span id="marksStatus" class="save-state"></span>
      </div>
      ${!roster.length ? '<div class="empty-state"><svg class="i" aria-hidden="true"><use href="#i-me"/></svg><b>No trainees in this class yet</b><span>Once the class list is loaded, the marks sheet shows up here.</span></div>' : `
      ${edits ? `<p class="muted small">Marks are percentages - whole numbers from 0 to 100. Each one is saved on this device as you type and sent when there is internet. Enter moves down the column.${edits < ms.sheets.length ? ' Only the streams you teach can be changed.' : ''}</p>`
        : '<p class="muted small">Only the trainer of this unit can change these marks.</p>'}
      ${locked.size ? `<div class="report-lock"><span><b>Some marks are locked.</b> Marks entered in ${[...locked.values()].map(esc).join(', ')} cannot change now that the term has ended.</span>
        ${hasRole('HOD') || hasRole('MIS') ? [...locked].map(([id, name]) => `<button type="button" class="btn small" data-munlock="${esc(id)}">Unlock ${esc(name)} for 7 days</button>`).join('') : ''}</div>` : ''}
      <input type="search" id="marksSearch" class="marks-search" placeholder="Search name or admission no." aria-label="Search students" value="${esc(ms.q)}">
      <div id="marksTable"></div>
      <div class="row-actions marks-actions">
        <button type="button" class="btn primary" id="marksExport"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel marksheet</button>
        ${edits ? '<button type="button" class="btn" id="marksSend">Send now</button>' : ''}
      </div>
      <div id="msSteps" class="ms-steps"></div>`}`;
    if (roster.length) { drawTable(); drawSteps(); }
    status();
  }
  /** The table alone (a search or a page change must not rebuild the box being typed in). */
  function drawTable() {
    const box = $('#marksTable'); if (!box) return;
    const q = (ms.q || '').trim().toLowerCase();
    const all = Tables.sort('marks', ms.roster.map((t, i) => ({ t, n: i + 1 })).filter(({ t }) => !q || t.name.toLowerCase().includes(q) || String(t.admNo).toLowerCase().includes(q)),
      { sn: (x) => x.n, name: (x) => x.t.name, cat: (x) => avg(rowFor(x.t), ['cat1', 'cat2', 'cat3']) ?? -1, prac: (x) => avg(rowFor(x.t), ['prac1', 'prac2', 'prac3']) ?? -1 }, 'sn');
    all.forEach((x, i) => { x.pos = i + 1; });   // S/N follows the order on screen
    const rows = Tables.slice('marks', all);
    box.innerHTML = all.length ? `<div class="marks-wrap"><table class="marks-table">
        <thead><tr>${Tables.th('marks', 'sn', 'S/N', 'mt-sn', ' rowspan="2"')}${Tables.th('marks', 'name', 'Student', 'mt-name', ' rowspan="2"')}<th colspan="4" class="mt-grp">Oral / Theory (100%)</th><th colspan="4" class="mt-grp prac">Practical (100%)</th></tr>
        <tr>${['cat1', 'cat2', 'cat3'].map((c) => `<th>${HEAD[c]}</th>`).join('')}${Tables.th('marks', 'cat', 'AVG', 'avg')}${['prac1', 'prac2', 'prac3'].map((c) => `<th class="prac">${HEAD[c]}</th>`).join('')}${Tables.th('marks', 'prac', 'AVG', 'avg prac')}</tr></thead>
        <tbody>${rows.map(({ t, pos }) => { const s = sheetOf(t.cls); return rowHtml(t, pos - 1, rowFor(t), s.edit, s.doc.dirty[lower(t.admNo)]); }).join('')}</tbody>
      </table></div>${Tables.bar('marks', all)}` : '<p class="empty">Nobody matches that search.</p>';
  }
  function rowHtml(t, i, r, edit, dirty) {
    const cell = (c) => {
      const lock = (r.locked || []).includes(c);
      return `<td><input class="mk${lock ? ' locked' : ''}" inputmode="numeric" autocomplete="off" data-adm="${esc(t.admNo)}" data-cls="${esc(t.cls)}" data-col="${c}" value="${r[c] ?? ''}"
      aria-label="${esc(t.name)} ${HEAD[c]}"${lock ? ` title="Entered in ${esc(r.terms?.[c] || 'an earlier term')}, which has ended: locked"` : ''} ${edit && !lock ? '' : 'readonly'}></td>`;
    };
    return `<tr data-adm="${esc(t.admNo)}" data-cls="${esc(t.cls)}" class="${t.gone ? 'gone' : ''}${dirty ? ' dirty' : ''}">
      <td class="mt-sn">${i + 1}</td>
      <th scope="row" class="mt-name"><div class="mt-in"><b>${esc(t.name)}${t.stream ? ` <span class="stag" title="Stream">${esc(t.stream)}</span>` : ''}</b><small>${esc(t.admNo)}${t.regCode ? ' - ' + esc(t.regCode) : ''}${t.pending ? ' - pending' : ''}${t.gone ? ' - not on the list' : ''}</small></div></th>
      ${['cat1', 'cat2', 'cat3'].map(cell).join('')}<td class="avg" data-avg="cat">${avgText(r, ['cat1', 'cat2', 'cat3'])}</td>
      ${['prac1', 'prac2', 'prac3'].map(cell).join('')}<td class="avg" data-avg="prac">${avgText(r, ['prac1', 'prac2', 'prac3'])}</td></tr>`;
  }
  /** Updates the numbers in place (keeps the cell being typed in). */
  function refreshValues() {
    for (const inp of $$('#marksCard input.mk')) {
      if (inp === document.activeElement) continue;
      const r = sheetOf(inp.dataset.cls).doc.rows[lower(inp.dataset.adm)] || {};
      inp.value = r[inp.dataset.col] ?? '';
    }
    for (const tr of $$('#marksCard tbody tr')) {
      const r = sheetOf(tr.dataset.cls).doc.rows[lower(tr.dataset.adm)] || {};
      tr.querySelector('[data-avg=cat]').textContent = avgText(r, ['cat1', 'cat2', 'cat3']);
      tr.querySelector('[data-avg=prac]').textContent = avgText(r, ['prac1', 'prac2', 'prac3']);
    }
    status();
  }
  function status() {
    const el = $('#marksStatus'); if (!el || !ms.sheets?.length) return;
    const n = pendingAll();
    el.className = 'save-state' + (n ? ' pending' : ' ok');
    el.textContent = n ? (navigator.onLine ? `Sending ${n}…` : `${n} saved on this device`) : ms.sheets.some((s) => s.doc.sentAt || s.doc.pulledAt) ? 'All sent' : 'Saved';
    if (ms.pullError && !n) { el.textContent = 'Saved on this device'; el.title = ms.pullError; }
  }

  async function onInput(inp) {
    const res = parse(inp.value);
    inp.classList.toggle('bad', !res.ok);
    if (!res.ok) return;
    const sheet = sheetOf(inp.dataset.cls), unit = ms.unit, k = lower(inp.dataset.adm), col = inp.dataset.col;
    const tr = inp.closest('tr');
    const row = sheet.doc.rows[k] = { ...(sheet.doc.rows[k] || { admNo: inp.dataset.adm }), [col]: res.value, updatedAt: nowISO() };
    sheet.doc.dirty[k] = true;
    tr.classList.add('dirty');
    tr.querySelector('[data-avg=cat]').textContent = avgText(row, ['cat1', 'cat2', 'cat3']);
    tr.querySelector('[data-avg=prac]').textContent = avgText(row, ['prac1', 'prac2', 'prac3']);
    // Saved straight away (one save after another), so closing the app a moment later loses nothing.
    ms.saving = Promise.resolve(ms.saving).then(() => saveLocal(sheet, unit)).catch((e) => toast('Could not save on this device: ' + e.message, 'err'));
    status();
  }
  async function saveLocal(sheet, unit) {
    const snap = sheet.doc, cls = sheet.cls;
    const saved = await updateLocal(docId(cls, unit), (d) => {
      d.rows = d.rows || {}; d.dirty = d.dirty || {};
      for (const [k, r] of Object.entries(snap.rows)) if (!d.rows[k] || String(r.updatedAt) >= String(d.rows[k].updatedAt)) d.rows[k] = r;
      for (const k of Object.keys(snap.dirty)) d.dirty[k] = true;
    }, { rows: {}, dirty: {} });
    if (sheet.doc === snap) snap._rev = saved._rev;
    await updateLocal('marksIndex', (i) => { const k = `${LIFE}:${cls}|${unit}`; i.keys = [...new Set([...(i.keys || []), k])]; }, { keys: [] });
    scheduleSend();
  }
  function scheduleSend() {
    if (typeof wakeOutbox === 'function') wakeOutbox();
    clearTimeout(ms.sendTimer);
    ms.sendTimer = setTimeout(async () => {
      if (!navigator.onLine) return status();
      const sheets = ms.sheets, unit = ms.unit;
      try {
        for (const s of sheets) if (pendingFor(s.doc)) { await push(s.cls, unit); s.doc = await load(s.cls, unit); }
        $$('#marksCard tr.dirty').forEach((tr) => { if (!sheetOf(tr.dataset.cls).doc.dirty[lower(tr.dataset.adm)]) tr.classList.remove('dirty'); });
      } catch (e) { ms.pullError = e.message; }
      status();
    }, 2500);
  }

  /* ---------- the marksheet's way to approval: trainer → Assessment Officer → HOD ---------- */
  const MS_STATUS = { submitted: ['pending', 'With the Assessment Officer'], received: ['pending', 'Received - with the HOD'], approved: ['synced', 'Approved'], returned: ['rejected', 'Returned'] };
  const day = (iso) => (iso ? fmtShort(iso) : '');
  function drawSteps() {
    const box = $('#msSteps'); if (!box) return;
    box.innerHTML = `<h3>Marksheet approval</h3>${ms.sheets.map((s) => {
      const m = s.doc.sheet, many = ms.sheets.length > 1, tag = many ? `<b>${esc(streamLetter(s.cls) || s.cls)}:</b> ` : '';
      const [cls, label] = m ? MS_STATUS[m.status] || ['pending', m.status] : ['', 'Not sent yet'];
      const who = m ? [m.preparedName && `Prepared by ${esc(m.preparedName)} ${day(m.preparedAt)}`, m.receivedName && `received by ${esc(m.receivedName)} ${day(m.receivedAt)}`,
        m.approvedName && `approved by ${esc(m.approvedName)} ${day(m.approvedAt)}`].filter(Boolean).join(' - ') : '';
      const acts = [];
      if (s.edit && (!m || m.status === 'returned' || m.status === 'approved')) acts.push(`<button type="button" class="btn small primary" data-ms="submit" data-cls="${esc(s.cls)}">${m ? 'Send again' : 'Send to the Assessment Officer'}</button>`);
      if ((hasRole('IAO') || hasRole('HOD')) && m?.status === 'submitted') acts.push(`<button type="button" class="btn small primary" data-ms="receive" data-cls="${esc(s.cls)}">Mark as received</button>`);
      const decide = hasRole('HOD') && m?.status === 'received';
      return `<div class="ms-step" data-cls="${esc(s.cls)}"><p>${tag}${cls ? `<span class="pill ${cls}">${label}</span>` : `<span class="muted">${label}</span>`} <span class="small">${who}</span>
          ${m?.approvalRef ? `<span class="small"> - Ref ${esc(m.approvalRef)}</span>` : ''}</p>
        ${m?.comment && m.status === 'returned' ? `<p class="so-quote small"><b>HOD's comment:</b> ${esc(m.comment)}</p>` : ''}
        ${decide ? `<label>HOD's comment<textarea id="msComment-${esc(s.cls)}" rows="2" placeholder="Left empty: ${esc(OK_SAID.marksheet)}"></textarea></label>${quickSays('marksheet', 'msComment-' + s.cls)}
          <div class="row-actions"><button type="button" class="btn small primary" data-ms="approved" data-cls="${esc(s.cls)}">Approve marksheet</button><button type="button" class="btn small" data-ms="returned" data-cls="${esc(s.cls)}">Return to trainer</button></div>` : ''}
        ${acts.length ? `<div class="row-actions">${acts.join('')}</div>` : ''}</div>`;
    }).join('')}<p class="muted tiny">The Excel marksheet's footer shows who prepared, received and approved it, with their initials as signatures.</p>`;
  }
  async function step(act, cls, btn) {
    const s = ms.sheets.find((x) => x.cls === cls); if (!s) return;
    if (!navigator.onLine) { toast('This needs internet. The marks are safe on this device.', 'err'); return; }
    btn.disabled = true;
    try {
      let r;
      if (act === 'submit') { await push(cls, ms.unit); r = await api('msSubmit', { classCode: cls, unitCode: ms.unit, again: true }); }
      if (act === 'receive') r = await api('msReceive', { id: s.doc.sheet.id });
      if (act === 'approved' || act === 'returned') {
        const comment = $(`#msComment-${CSS.escape(cls)}`)?.value.trim() || '';
        if (act === 'returned' && !comment) { toast('Write what needs fixing, then return it', 'err'); btn.disabled = false; return; }
        const body = { id: s.doc.sheet.id, decision: act, comment };
        r = act === 'approved' ? await withPin('Approve this marksheet', (pin) => api('msDecide', { ...body, pin })) : await api('msDecide', body);
        if (!r) { btn.disabled = false; return; }
      }
      if (!r.ok) throw new Error(r.error);
      const sheet = r.marksheet || r.marksheets?.[0];
      s.doc = await updateLocal(docId(cls, ms.unit), (d) => { d.sheet = sheet; }, { rows: {}, dirty: {} });
      toast({ submit: 'Sent to the Assessment Officer', receive: 'Received', approved: 'Marksheet approved', returned: 'Returned to the trainer' }[act], 'ok');
      drawSteps();
      window.Admin?.refreshBadge?.();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
  }
  /** The footer of the Excel marksheet: the unit's trainer prepares it; who received and approved it, once they have. */
  function footerOf(sheets, u) {
    const pick = (f) => [...new Set(sheets.map((s) => f(s.doc.sheet)).filter(Boolean))].join(', ');
    const all = (st) => sheets.every((s) => st.includes(s.doc.sheet?.status));
    const at = (f) => { const v = sheets.map((s) => f(s.doc.sheet)).filter(Boolean).sort().pop(); return v ? fmtShort(v) : ''; };
    const trainer = pick((m) => m?.preparedName) || [...new Set(sheets.map((s) => state.units.find((x) => x.classCode === s.cls && x.code === u.code)?.trainerName).filter(Boolean))].join(', ');
    const sent = sheets.some((s) => s.doc.sheet);
    const prepared = { name: trainer, initials: sent ? trainer.split(', ').map(initials).join(' ') : '', date: at((m) => m?.preparedAt) };
    const recName = all(['received', 'approved']) ? pick((m) => m?.receivedName) : '';
    const received = { name: recName, initials: recName.split(', ').filter(Boolean).map(initials).join(' '), date: recName ? at((m) => m?.receivedAt) : '' };
    const appName = all(['approved']) ? pick((m) => m?.approvedName) : '';
    const approved = { name: appName, initials: appName.split(', ').filter(Boolean).map(initials).join(' '), date: appName ? at((m) => m?.approvedAt) : '' };
    return { prepared, received, approved };
  }

  /* ---------- one class and unit's marksheet, for reports made in bulk ---------- */
  /** The marksheet's data (as the Excel file takes it) for a class and unit, from the server when there is internet. */
  async function dataFor(cls, unitCode) {
    let doc;
    try { doc = await pull(cls, unitCode); } catch { doc = await load(cls, unitCode); }
    const u = state.units.find((x) => x.classCode === cls && x.code === unitCode) || { code: unitCode, name: unitCode };
    const c = state.classes.find((x) => x.code === cls) || {};
    const students = rosterFor(cls).map((t) => {
      const r = doc.rows[lower(t.admNo)] || {};
      return { regCode: t.regCode || '', admNo: t.admNo, name: t.name, cat: ['cat1', 'cat2', 'cat3'].map((k) => r[k] ?? ''), prac: ['prac1', 'prac2', 'prac3'].map((k) => r[k] ?? '') };
    }).sort((a, b) => String(a.admNo).localeCompare(String(b.admNo)));
    return { courseCode: c.misClass || cls, courseName: c.name && c.name !== c.code ? c.name : (c.misClass || cls), unitCode: u.code, unitTitle: u.name,
      series: state.meta.term?.series || '', sheetName: `${String(cls).split(' ').pop()} ${u.code}`, students, footer: footerOf([{ cls, doc }], u) };
  }
  const xlsxFor = async (d) => Xlsx.marksheetFile(await (await fetch('templates/marksheet.xlsx')).arrayBuffer(), d);
  /** The printed marksheet (for PDF): the RVNP heading, the marks (AVG or C.R.N.M), and the Prepared / Received / Approved rows. */
  function printHtml(d) {
    const PER = 18, pages = [];
    for (let i = 0; i < Math.max(1, d.students.length); i += PER) pages.push(d.students.slice(i, i + PER));
    const av = (xs) => (xs.filter((x) => x !== '' && x != null).length === 3 ? String(Math.round(xs.reduce((n, x) => n + Number(x), 0) / 3)) : 'C.R.N.M');
    const head = `<thead><tr><th rowspan="2">S/N</th><th rowspan="2">Candidate's Reg Code</th><th rowspan="2">Center Admission No.</th><th rowspan="2">Candidate's Name</th>
      <th colspan="4" class="g">Oral/Theory Marks (100%)</th><th colspan="4" class="p">Practical Marks (100%)</th></tr>
      <tr><th class="g">CAT 1</th><th class="g">CAT 2</th><th class="g">CAT 3</th><th class="g">AVG</th><th class="p">PRAC 1</th><th class="p">PRAC 2</th><th class="p">PRAC 3</th><th class="p">AVG</th></tr></thead>`;
    let n = 0;
    const f = d.footer || {}, line = (label, w) => `<tr><th>${label}</th><td>${esc(w?.name || '')}</td><th>Signature:</th><td class="sig">${esc(w?.initials || '')}</td><th>Date:</th><td>${esc(w?.date || '')}</td></tr>`;
    return `<div class="ms-print">${pages.map((list, p) => `<div class="ms-page${p ? ' ms-more' : ''}">
      ${p ? '' : `<div class="ms-head"><img src="icons/rvnp-logo.png" alt=""><h1>THE RIFT VALLEY NATIONAL POLYTECHNIC</h1><h1>DEPARTMENT OF COMPUTING AND INFORMATICS</h1>
        <h2>CONTINUOUS ASSESSMENT MARKS SHEET PER UNIT OF COMPETENCY</h2>
        <table class="ms-fields"><tr><th>Course Code:</th><td>${esc(d.courseCode)}</td><th>Course Name:</th><td>${esc(d.courseName)}</td></tr>
        <tr><th>Unit Code:</th><td>${esc(d.unitCode)}</td><th>Unit Title:</th><td>${esc(d.unitTitle)}</td></tr><tr><th>Assessment Series:</th><td>${esc(d.series)}</td><th></th><td></td></tr></table></div>`}
      <table class="ms-grid">${head}<tbody>${list.map((s) => `<tr><td>${++n}</td><td>${esc(s.regCode)}</td><td class="l">${esc(s.admNo)}</td><td class="l">${esc(s.name)}</td>
        ${s.cat.map((v) => `<td>${v ?? ''}</td>`).join('')}<td>${av(s.cat)}</td>${s.prac.map((v) => `<td>${v ?? ''}</td>`).join('')}<td>${av(s.prac)}</td></tr>`).join('')}</tbody></table>
      ${p === pages.length - 1 ? `<table class="ms-foot">${line('Prepared by:', f.prepared)}${line('Received by:', f.received)}${line('Approved by:', f.approved)}</table>` : ''}</div>`).join('')}</div>`;
  }

  async function exportXlsx() {
    const codes = reportCodes(), unit = $('#rUnit').value;
    if (!codes.length || !unit) return;
    const sheets = ms.key === codes.join(',') + '|' + unit ? ms.sheets : await Promise.all(codes.map(async (cls) => ({ cls, doc: await load(cls, unit) })));
    // All streams in one marksheet, under their MIS class when they share one.
    const g = codes.length > 1 ? reportGroup() : null, cls = g ? g.base : codes[0];
    const u = state.units.find((x) => x.classCode === codes[0] && x.code === unit) || { code: unit, name: unit };
    const c = g ? (() => { const mis = [...new Set(codes.map((k) => state.classes.find((x) => x.code === k)?.misClass || ''))]; return { code: g.base, misClass: mis.length === 1 ? mis[0] : '' }; })()
      : (state.classes.find((x) => x.code === cls) || {});
    const students = sheets.flatMap((s) => rosterFor(s.cls).map((t) => {
      const r = s.doc.rows[lower(t.admNo)] || {};
      return { regCode: t.regCode || '', admNo: t.admNo, name: t.name, cat: ['cat1', 'cat2', 'cat3'].map((k) => r[k] ?? ''), prac: ['prac1', 'prac2', 'prac3'].map((k) => r[k] ?? '') };
    })).sort((a, b) => String(a.admNo).localeCompare(String(b.admNo)));
    try {
      const tpl = await (await fetch('templates/marksheet.xlsx')).arrayBuffer();
      const blob = await Xlsx.marksheetFile(tpl, { courseCode: c.misClass || cls, courseName: c.name && c.name !== c.code ? c.name : (c.misClass || cls), unitCode: u.code, unitTitle: u.name,
        series: state.meta.term?.series || '', sheetName: `${String(cls).split(' ').pop()} ${u.code}`, students, footer: footerOf(sheets, u) });
      download(`Marksheet_${fileSafe(cls)}_${fileSafe(u.code)}_${todayISO()}.xlsx`, blob);
      toast('Excel marksheet saved', 'ok');
    } catch (e) { toast('Could not make the marksheet: ' + e.message, 'err'); }
  }

  function wire() {
    document.addEventListener('input', (e) => {
      if (e.target.id === 'marksSearch') { ms.q = e.target.value; Tables.reset('marks'); drawTable(); return; }
      if (e.target.matches('#marksCard input.mk') && !e.target.readOnly) onInput(e.target);
    });
    Tables.on('marks', drawTable);
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!t.matches?.('#marksCard input.mk') || (e.key !== 'Enter' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      const rows = $$('#marksCard tbody tr'), i = rows.indexOf(t.closest('tr'));
      const next = rows[i + (e.key === 'ArrowUp' ? -1 : 1)]?.querySelector(`input[data-col="${t.dataset.col}"]`);
      if (next) { next.focus(); next.select(); }
    });
    document.addEventListener('focusin', (e) => { if (e.target.matches?.('#marksCard input.mk')) e.target.select(); });
    document.addEventListener('click', (e) => {
      if (e.target.closest('#marksExport')) exportXlsx();
      if (e.target.closest('#marksSend')) syncAll().then(() => render());
      const st = e.target.closest('[data-ms]'); if (st) step(st.dataset.ms, st.dataset.cls, st);
      const un = e.target.closest('[data-munlock]');
      if (un) {
        // Every stream on screen whose marks from that term are locked.
        const term = un.dataset.munlock, unit = ms.unit;
        const sheets = ms.sheets.filter((s) => (s.doc.lockedTerms || []).some((t) => t.id === term));
        Promise.all(sheets.map((s) => api('unlock', { termId: term, classCode: s.cls, unitCode: unit, days: 7 }).then((r) => { if (!r.ok) throw new Error(r.error); })))
          .then(() => { toast('Unlocked for 7 days', 'ok'); render(); })
          .catch((err) => toast(err.message, 'err'));
      }
      const m = e.target.closest('#reportMode [data-rmode]');
      if (m) setMode(m.dataset.rmode);
    });
    window.addEventListener('online', () => syncAll({ quiet: true }));
  }
  function setMode(mode) {
    // Marks belong to the unit, not to a term: the marksheet always opens on this term's classes.
    if (mode === 'marks' && state.reportTerm) { state.reportTerm = ''; state.pastUnits = null; fillTermSelect(); fillReportClasses(); }
    state.reportMode = mode;
    $$('#reportMode [data-rmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.rmode === mode)));
    $('#tab-reports').classList.toggle('marks-mode', mode === 'marks');
    renderReport();
  }
  return { render, wire, syncAll, setMode, state: ms, footerOf, dataFor, xlsxFor, printHtml };
})();
