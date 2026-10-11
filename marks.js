/* Marks: the continuous assessment marksheet per class and unit (CAT 1–3, PRAC 1–3, each 0–100).
 * Entered on the phone, offline too; each student's row is saved on the phone at once and sent to the
 * server when there is internet. The server copy feeds the trainer's "Marksheets" Google Sheet and the
 * Excel export in RVNP's marksheet layout. AVG = sum of the three ÷ 3 (a CAT not done counts as 0).
 * Uses app.js (state, api, $, $$, esc, toast, hasRole, me, getLocal, updateLocal, rosterFor, download). */
'use strict';

const Marks = (() => {
  const COLS = ['cat1', 'cat2', 'cat3', 'prac1', 'prac2', 'prac3'];
  const HEAD = { cat1: 'CAT 1', cat2: 'CAT 2', cat3: 'CAT 3', prac1: 'PRAC 1', prac2: 'PRAC 2', prac3: 'PRAC 3' };
  const ms = { q: '', roster: [], edit: false, drawnKey: '', key: '', doc: null, saving: Promise.resolve(), sendTimer: null, sending: false, seq: 0 };
  // One marksheet per class and unit for the unit's whole life, whichever terms and trainers it spans.
  const LIFE = 'unit';
  const docId = (cls, unit) => `marks:${LIFE}:${cls}|${unit}`;
  const oldDocId = (cls, unit) => `marks:${state.meta.term?.id || 'term'}:${cls}|${unit}`;   // before marks spanned terms
  const avg = (r, keys) => (keys.some((k) => r?.[k] !== null && r?.[k] !== undefined && r?.[k] !== '') ? keys.reduce((n, k) => n + (Number(r[k]) || 0), 0) / 3 : null);
  const show = (n) => (n === null || n === undefined ? '' : String(Math.round(n)));
  const canEdit = (unit) => (hasRole('HOD') || (hasRole('TRAINER') && isMyUnit(unit)));
  const parse = (v) => {
    const t = String(v ?? '').trim().replace(',', '.');
    if (t === '') return { ok: true, value: null };
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? { ok: true, value: Math.round(n * 10) / 10 } : { ok: false };
  };

  async function load(cls, unit) {
    let d = await getLocal(docId(cls, unit), { rows: {}, dirty: {} });
    d.rows = d.rows || {}; d.dirty = d.dirty || {};
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
      d.pulledAt = nowISO();
    }, { rows: {}, dirty: {} });
  }
  async function push(cls, unit) {
    const d = await load(cls, unit);
    const keys = Object.keys(d.dirty);
    if (!keys.length) return 0;
    const res = await api('marksPush', { classCode: cls, unitCode: unit, rows: keys.map((k) => d.rows[k]).filter(Boolean) });
    if (!res.ok) throw new Error(res.error);
    await updateLocal(docId(cls, unit), (x) => {
      for (const k of keys) if (x.dirty[k] && String(x.rows[k]?.updatedAt) <= String(d.rows[k]?.updatedAt)) delete x.dirty[k];
      for (const r of res.rows) { const k = lower(r.admNo); if (!x.dirty[k]) x.rows[k] = rowOf(r); }
      x.lockedTerms = res.lockedTerms || [];
      x.sentAt = nowISO();
    }, { rows: {}, dirty: {} }).then(async (x) => {
      if (!Object.keys(x.dirty || {}).length) await updateLocal('marksIndex', (i) => { i.keys = (i.keys || []).filter((k) => k.slice(k.indexOf(':') + 1) !== `${cls}|${unit}`); }, { keys: [] });
    });
    if (res.held) toast(`${res.held} mark(s) were entered in a term that has ended, so they were kept as they were. The HOD or MIS Officer can unlock them.`, 'err');
    return keys.length;
  }
  /** Every marksheet on this phone with unsent rows (run with the register sync and when the internet returns). */
  async function syncAll({ quiet = false } = {}) {
    if (!navigator.onLine || !state.auth || ms.sending) return 0;
    ms.sending = true;
    let sent = 0;
    try {
      // _local docs are not listed by the database, so the phone keeps its own list of marksheets with unsent rows.
      const idx = await getLocal('marksIndex', { keys: [] });
      for (const key of idx.keys || []) {
        const cu = key.slice(key.indexOf(':') + 1);
        const [cls, unit] = cu.split('|');
        sent += await push(cls, unit);
      }
      if (sent && !quiet) toast(`Marks sent for ${sent} student(s)`, 'ok');
    } catch (e) { if (!quiet) toast('Marks not sent yet: ' + e.message, 'err'); }
    finally { ms.sending = false; }
    if (state.reportMode === 'marks') status();
    return sent;
  }
  const pendingFor = (d) => Object.keys(d?.dirty || {}).length;

  /* ---------- the marks table ---------- */
  async function render() {
    const cls = $('#rClass').value, unit = $('#rUnit').value, box = $('#marksCard');
    if (!cls || !unit) { box.innerHTML = '<p class="empty">Choose a class and unit to enter its marks.</p>'; return; }
    const seq = ++ms.seq;
    ms.key = cls + '|' + unit;
    ms.doc = await load(cls, unit);
    draw(cls, unit);
    if (navigator.onLine && state.auth) {
      let fresh = null;
      try { await ms.saving; fresh = await pull(cls, unit); } catch (e) { ms.pullError = e.message; }
      if (seq !== ms.seq || !fresh) return;
      // Anything typed while the server's copy was on its way stays as typed.
      const before = ms.doc;
      for (const k of Object.keys(before.dirty)) {
        if (!fresh.rows[k] || String(before.rows[k]?.updatedAt) >= String(fresh.rows[k].updatedAt)) { fresh.rows[k] = before.rows[k]; fresh.dirty[k] = true; }
      }
      ms.doc = fresh;
      if ($('#marksCard').contains(document.activeElement)) refreshValues(); else draw(cls, unit);
      if (pendingFor(ms.doc)) scheduleSend();
    }
  }
  function draw(cls, unit) {
    const u = state.units.find((x) => x.classCode === cls && x.code === unit) || { code: unit, name: unit };
    const edit = canEdit(u), d = ms.doc;
    const roster = rosterFor(cls).sort((a, b) => String(a.admNo).localeCompare(String(b.admNo)));
    // Students who have marks but left the list stay visible so nothing is lost.
    for (const r of Object.values(d.rows)) if (!roster.some((t) => lower(t.admNo) === lower(r.admNo))) roster.push({ admNo: r.admNo, name: r.admNo, gone: true });
    if (ms.drawnKey !== cls + '|' + unit) { ms.drawnKey = cls + '|' + unit; ms.q = ''; Tables.reset('marks'); }
    ms.roster = roster; ms.edit = edit;
    $('#marksCard').innerHTML = `
      <div class="marks-head">
        <div><h2>${esc(u.name)}</h2></div>
        <span id="marksStatus" class="save-state"></span>
      </div>
      ${!roster.length ? '<div class="empty-state"><svg class="i" aria-hidden="true"><use href="#i-me"/></svg><b>No trainees in this class yet</b><span>Once the class list is loaded, the marks sheet shows up here.</span></div>' : `
      ${edit ? '<p class="muted small">Marks are percentages (0–100). Each one is saved on this device as you type and sent when there is internet. Enter moves down the column.</p>'
        : '<p class="muted small">Only the trainer of this unit can change these marks.</p>'}
      ${(d.lockedTerms || []).length ? `<div class="report-lock"><span><b>Some marks are locked.</b> Marks entered in ${d.lockedTerms.map((x) => esc(x.name)).join(', ')} cannot change now that the term has ended.</span>
        ${hasRole('HOD') || hasRole('MIS') ? d.lockedTerms.map((x) => `<button type="button" class="btn small" data-munlock="${esc(x.id)}">Unlock ${esc(x.name)} for 7 days</button>`).join('') : ''}</div>` : ''}
      <input type="search" id="marksSearch" class="marks-search" placeholder="Search name or admission no." aria-label="Search students" value="${esc(ms.q)}">
      <div id="marksTable"></div>
      <div class="row-actions marks-actions">
        <button type="button" class="btn primary" id="marksExport"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel marksheet</button>
        ${edit ? '<button type="button" class="btn" id="marksSend">Send now</button>' : ''}
      </div>`}`;
    if (roster.length) drawTable();
    status();
  }
  /** The table alone (a search or a page change must not rebuild the box being typed in). */
  function drawTable() {
    const box = $('#marksTable'); if (!box) return;
    const q = (ms.q || '').trim().toLowerCase(), d = ms.doc;
    const row = (t) => d.rows[lower(t.admNo)] || {};
    const all = Tables.sort('marks', ms.roster.map((t, i) => ({ t, n: i + 1 })).filter(({ t }) => !q || t.name.toLowerCase().includes(q) || String(t.admNo).toLowerCase().includes(q)),
      { sn: (x) => x.n, name: (x) => x.t.name, cat: (x) => avg(row(x.t), ['cat1', 'cat2', 'cat3']), prac: (x) => avg(row(x.t), ['prac1', 'prac2', 'prac3']) }, 'sn');
    all.forEach((x, i) => { x.pos = i + 1; });   // S/N follows the order on screen
    const rows = Tables.slice('marks', all);
    box.innerHTML = all.length ? `<div class="marks-wrap"><table class="marks-table">
        <thead><tr>${Tables.th('marks', 'sn', 'S/N', 'mt-sn', ' rowspan="2"')}${Tables.th('marks', 'name', 'Student', 'mt-name', ' rowspan="2"')}<th colspan="4" class="mt-grp">Oral / Theory (100%)</th><th colspan="4" class="mt-grp prac">Practical (100%)</th></tr>
        <tr>${['cat1', 'cat2', 'cat3'].map((c) => `<th>${HEAD[c]}</th>`).join('')}${Tables.th('marks', 'cat', 'AVG', 'avg')}${['prac1', 'prac2', 'prac3'].map((c) => `<th class="prac">${HEAD[c]}</th>`).join('')}${Tables.th('marks', 'prac', 'AVG', 'avg prac')}</tr></thead>
        <tbody>${rows.map(({ t, pos }) => rowHtml(t, pos - 1, row(t), ms.edit, d.dirty[lower(t.admNo)])).join('')}</tbody>
      </table></div>${Tables.bar('marks', all)}` : '<p class="empty">Nobody matches that search.</p>';
  }
  function rowHtml(t, i, r, edit, dirty) {
    const cell = (c) => {
      const lock = (r.locked || []).includes(c);
      return `<td><input class="mk${lock ? ' locked' : ''}" inputmode="decimal" autocomplete="off" data-adm="${esc(t.admNo)}" data-col="${c}" value="${r[c] ?? ''}"
      aria-label="${esc(t.name)} ${HEAD[c]}"${lock ? ` title="Entered in ${esc(r.terms?.[c] || 'an earlier term')}, which has ended: locked"` : ''} ${edit && !lock ? '' : 'readonly'}></td>`;
    };
    return `<tr data-adm="${esc(t.admNo)}" class="${t.gone ? 'gone' : ''}${dirty ? ' dirty' : ''}">
      <td class="mt-sn">${i + 1}</td>
      <th scope="row" class="mt-name"><div class="mt-in"><b>${esc(t.name)}</b><small>${esc(t.admNo)}${t.regCode ? ' · ' + esc(t.regCode) : ''}${t.pending ? ' · pending' : ''}${t.gone ? ' · not on the list' : ''}</small></div></th>
      ${['cat1', 'cat2', 'cat3'].map(cell).join('')}<td class="avg" data-avg="cat">${show(avg(r, ['cat1', 'cat2', 'cat3']))}</td>
      ${['prac1', 'prac2', 'prac3'].map(cell).join('')}<td class="avg" data-avg="prac">${show(avg(r, ['prac1', 'prac2', 'prac3']))}</td></tr>`;
  }
  /** Updates the numbers in place (keeps the cell being typed in). */
  function refreshValues() {
    for (const inp of $$('#marksCard input.mk')) {
      if (inp === document.activeElement) continue;
      const r = ms.doc.rows[lower(inp.dataset.adm)] || {};
      inp.value = r[inp.dataset.col] ?? '';
    }
    for (const tr of $$('#marksCard tbody tr')) {
      const r = ms.doc.rows[lower(tr.dataset.adm)] || {};
      tr.querySelector('[data-avg=cat]').textContent = show(avg(r, ['cat1', 'cat2', 'cat3']));
      tr.querySelector('[data-avg=prac]').textContent = show(avg(r, ['prac1', 'prac2', 'prac3']));
    }
    status();
  }
  function status() {
    const el = $('#marksStatus'); if (!el || !ms.doc) return;
    const n = pendingFor(ms.doc);
    el.className = 'save-state' + (n ? ' pending' : ' ok');
    el.textContent = n ? (navigator.onLine ? `Sending ${n}…` : `${n} saved on this device`) : ms.doc.sentAt || ms.doc.pulledAt ? 'All sent' : 'Saved';
    if (ms.pullError && !n) { el.textContent = 'Saved on this device'; el.title = ms.pullError; }
  }

  async function onInput(inp) {
    const res = parse(inp.value);
    inp.classList.toggle('bad', !res.ok);
    if (!res.ok) return;
    const [cls, unit] = ms.key.split('|'), k = lower(inp.dataset.adm), col = inp.dataset.col;
    const tr = inp.closest('tr');
    const row = ms.doc.rows[k] = { ...(ms.doc.rows[k] || { admNo: inp.dataset.adm }), [col]: res.value, updatedAt: nowISO() };
    ms.doc.dirty[k] = true;
    tr.classList.add('dirty');
    tr.querySelector('[data-avg=cat]').textContent = show(avg(row, ['cat1', 'cat2', 'cat3']));
    tr.querySelector('[data-avg=prac]').textContent = show(avg(row, ['prac1', 'prac2', 'prac3']));
    // Saved straight away (one save after another), so closing the app a moment later loses nothing.
    ms.saving = Promise.resolve(ms.saving).then(() => saveLocal(cls, unit)).catch((e) => toast('Could not save on this device: ' + e.message, 'err'));
    status();
  }
  async function saveLocal(cls, unit) {
    const snap = ms.doc;
    const saved = await updateLocal(docId(cls, unit), (d) => {
      d.rows = d.rows || {}; d.dirty = d.dirty || {};
      for (const [k, r] of Object.entries(snap.rows)) if (!d.rows[k] || String(r.updatedAt) >= String(d.rows[k].updatedAt)) d.rows[k] = r;
      for (const k of Object.keys(snap.dirty)) d.dirty[k] = true;
    }, { rows: {}, dirty: {} });
    if (ms.doc === snap && ms.key === cls + '|' + unit) { snap._rev = saved._rev; }
    await updateLocal('marksIndex', (i) => { const k = `${LIFE}:${cls}|${unit}`; i.keys = [...new Set([...(i.keys || []), k])]; }, { keys: [] });
    scheduleSend();
  }
  function scheduleSend() {
    clearTimeout(ms.sendTimer);
    ms.sendTimer = setTimeout(async () => {
      if (!navigator.onLine) return status();
      const [cls, unit] = ms.key.split('|');
      try { await push(cls, unit); ms.doc = await load(cls, unit); $$('#marksCard tr.dirty').forEach((tr) => { if (!ms.doc.dirty[lower(tr.dataset.adm)]) tr.classList.remove('dirty'); }); }
      catch (e) { ms.pullError = e.message; }
      status();
    }, 2500);
  }

  async function exportXlsx() {
    const cls = $('#rClass').value, unit = $('#rUnit').value;
    if (!cls || !unit) return;
    const u = state.units.find((x) => x.classCode === cls && x.code === unit) || { code: unit, name: unit };
    const c = state.classes.find((x) => x.code === cls) || {};
    const d = ms.doc || await load(cls, unit);
    const students = rosterFor(cls).sort((a, b) => String(a.admNo).localeCompare(String(b.admNo))).map((t) => {
      const r = d.rows[lower(t.admNo)] || {};
      return { regCode: t.regCode || '', admNo: t.admNo, name: t.name, cat: ['cat1', 'cat2', 'cat3'].map((k) => r[k] ?? ''), prac: ['prac1', 'prac2', 'prac3'].map((k) => r[k] ?? '') };
    });
    try {
      const tpl = await (await fetch('templates/marksheet.xlsx')).arrayBuffer();
      const blob = await Xlsx.marksheetFile(tpl, { courseCode: c.misClass || cls, courseName: c.name && c.name !== c.code ? c.name : (c.misClass || cls), unitCode: u.code, unitTitle: u.name,
        series: state.meta.term?.series || '', sheetName: `${String(cls).split(' ').pop()} ${u.code}`, students });
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
      const un = e.target.closest('[data-munlock]');
      if (un) {
        const [cls, unit] = ms.key.split('|');
        api('unlock', { termId: un.dataset.munlock, classCode: cls, unitCode: unit, days: 7 })
          .then((r) => { if (!r.ok) throw new Error(r.error); toast('Unlocked for 7 days', 'ok'); render(); })
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
  return { render, wire, syncAll, setMode, state: ms };
})();
