/* Absences tab (HOD and MIS Officer): students who have missed more lessons of a unit than the limit set here.
 * The tab's dot shows how many; the list can be searched, sorted, and saved as Excel or PDF.
 * Uses app.js (api, state, $, esc, toast, hasRole, me) and tables.js (Tables). */
'use strict';

const Alerts = (() => {
  const al = { rows: [], limit: 3, term: null, termId: '', q: '', cls: '', loaded: false, badgeAt: 0, seq: 0 };
  const box = () => $('#alerts');
  const allowed = () => hasRole('HOD') || hasRole('MIS');

  async function load() {
    const res = await api('absences', al.termId ? { termId: al.termId } : {});
    if (!res.ok) throw new Error(res.error || 'Could not count the absences');
    Object.assign(al, { rows: res.rows || [], limit: res.limit ?? 3, term: res.term, loaded: true });
    badge();
  }
  function badge() {
    const dot = $('#alertCount'); if (!dot) return;
    const n = al.termId ? 0 : new Set(al.rows.map((r) => r.admNo.toLowerCase())).size;
    dot.hidden = !n; dot.textContent = n > 99 ? '99+' : String(n);
  }
  /** After sign-in: one small request for the tab's dot (at most every 15 minutes). */
  async function refreshBadge() {
    if (!me() || !allowed() || !navigator.onLine || Date.now() - al.badgeAt < 15 * 60e3) return;
    al.badgeAt = Date.now();
    try { await load(); } catch { /* shown when the tab opens */ }
  }

  async function render() {
    if (!allowed()) { box().innerHTML = ''; return; }
    if (!navigator.onLine) { box().innerHTML = '<div class="card notice"><h2>Absences need internet</h2><p>They are counted from every trainer\'s registers on the server.</p></div>'; return; }
    if (!al.loaded) box().innerHTML = '<div class="card"><p class="muted">Counting absences…</p></div>';
    const seq = ++al.seq;
    try { await load(); } catch (e) { if (seq === al.seq) box().innerHTML = `<div class="card notice"><h2>Could not count absences</h2><p>${esc(e.message)}</p></div>`; return; }
    if (seq === al.seq) draw();
  }

  const shown = () => {
    const q = al.q.trim().toLowerCase();
    return al.rows.filter((r) => (!al.cls || r.classCode === al.cls)
      && (!q || [r.name, r.admNo, r.unitName, r.unitCode, r.trainerName].some((x) => String(x || '').toLowerCase().includes(q))));
  };
  const sorted = (list) => Tables.sort('absences', list, { name: (r) => r.name, adm: (r) => r.admNo, cls: (r) => r.classCode, unit: (r) => r.unitName,
    trainer: (r) => r.trainerName, missed: (r) => -r.missed, pct: (r) => r.pct }, 'missed');
  function draw() {
    const list = sorted(shown());
    list.forEach((r, i) => { r.sn = i + 1; });
    const students = new Set(list.map((r) => r.admNo.toLowerCase())).size;
    const classes = [...new Set(al.rows.map((r) => r.classCode))].sort();
    const now = state.meta.term?.id || '', past = (state.meta.terms || []).filter((t) => t.id !== now);
    const th = (col, label, cls) => Tables.th('absences', col, label, cls || '');
    box().innerHTML = `
      <div class="card alerts-head">
        <div class="msec-head"><h2>Absences</h2><button type="button" class="btn small ghost" data-act="reload-alerts">Refresh</button></div>
        <form id="alertLimitForm" class="alert-limit">
          <label>Tell me about students who have missed more than
            <span class="input-suffix"><input type="number" id="alertLimit" min="0" max="60" step="1" value="${al.limit}"><span>lessons of a unit</span></span></label>
          <button class="btn small">Save</button>
        </form>
        <div class="poe-filters">
          ${past.length ? `<select id="alertTerm" aria-label="Term"><option value="">${esc(state.meta.term?.duration || state.meta.term?.name || 'Current term')} (current)</option>${past.map((t) => `<option value="${esc(t.id)}"${t.id === al.termId ? ' selected' : ''}>${esc(t.duration || t.name)}</option>`).join('')}</select>` : ''}
          <select id="alertClass" aria-label="Class"><option value="">All classes</option>${classes.map((c) => `<option${c === al.cls ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
          <input type="search" id="alertSearch" placeholder="Name, admission no., unit or trainer" value="${esc(al.q)}" aria-label="Search">
        </div>
        <p class="muted small">${students} student${students === 1 ? '' : 's'} over the limit${al.cls ? ' in ' + esc(al.cls) : ''}${al.term ? ` · ${esc(al.term.duration || al.term.name)}` : ''}. A double lesson counts as two.</p>
      </div>
      ${list.length ? `<div class="card table-card"><div class="table-wrap"><table class="report-table alerts-table">
        <thead><tr><th class="num">S/N</th>${th('name', 'Student')}${th('adm', 'Admission no.')}${th('cls', 'Class')}${th('unit', 'Unit')}${th('trainer', 'Trainer')}${th('missed', 'Missed', 'num')}${th('pct', 'Attendance', 'num')}</tr></thead>
        <tbody>${Tables.slice('absences', list).map((r) => `<tr class="${r.pct !== null && r.pct < 75 ? 'below' : ''}"><td class="num">${r.sn}</td><td class="who">${esc(r.name)}</td><td class="tadm">${esc(r.admNo)}</td>
          <td>${esc(r.classCode)}</td><td>${esc(r.unitName)}</td><td>${esc(r.trainerName)}</td><td class="num"><b>${r.missed}</b> of ${r.held}</td><td class="num">${r.pct === null ? '–' : r.pct + '%'}</td></tr>`).join('')}</tbody>
      </table></div>${Tables.bar('absences', list)}
      <div class="row-actions table-actions">
        <button type="button" class="btn" data-act="alerts-xlsx"><svg class="i" aria-hidden="true"><use href="#i-download"/></svg>Export Excel</button>
        <button type="button" class="btn" data-act="alerts-pdf"><svg class="i" aria-hidden="true"><use href="#i-print"/></svg>Save as PDF</button>
      </div></div>`
      : `<div class="empty-state"><svg class="i" aria-hidden="true"><use href="#i-bell"/></svg><b>No one over the limit</b><span>Nobody${al.cls ? ' in ' + esc(al.cls) : ''} has missed more than ${al.limit} lesson${al.limit === 1 ? '' : 's'} of a unit${al.q ? ' that matches the search' : ''}.</span></div>`}`;
  }
  function sheet() {
    const list = sorted(shown());
    const head = ['S/N', 'Admission no.', 'Name', 'Class', 'Unit code', 'Unit', 'Trainer', 'Lessons missed', 'Lessons held', 'Attendance %'];
    return { head, rows: list.map((r, i) => [i + 1, r.admNo, r.name, r.classCode, r.unitCode, r.unitName, r.trainerName, r.missed, r.held, r.pct === null ? '' : r.pct]) };
  }

  function wire() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#alerts')) return;
      const a = e.target.closest('[data-act]'); if (!a) return;
      if (a.dataset.act === 'reload-alerts') render();
      if (a.dataset.act === 'alerts-xlsx' || a.dataset.act === 'alerts-pdf') {
        const { head, rows } = sheet();
        const title = `Absences over ${al.limit} lessons${al.cls ? ' ' + al.cls : ''}`;
        if (a.dataset.act === 'alerts-xlsx') Tables.exportXlsx(title, head, rows);
        else Tables.print(title, `${al.term ? (al.term.duration || al.term.name) + ' · ' : ''}${new Set(rows.map((r) => r[1])).size} student(s) · printed ${new Date().toLocaleDateString()}`, head, rows);
      }
    });
    document.addEventListener('submit', async (e) => {
      if (e.target.id !== 'alertLimitForm') return;
      e.preventDefault();
      try {
        const res = await api('setAbsenceLimit', { limit: Number($('#alertLimit').value) });
        if (!res.ok) throw new Error(res.error);
        toast(`You will be told about students who miss more than ${res.limit} lesson${res.limit === 1 ? '' : 's'} of a unit`, 'ok');
        Tables.reset('absences');
        render();
      } catch (err) { toast(err.message, 'err'); }
    });
    document.addEventListener('change', (e) => {
      if (e.target.id === 'alertClass') { al.cls = e.target.value; Tables.reset('absences'); draw(); }
      if (e.target.id === 'alertTerm') { al.termId = e.target.value; Tables.reset('absences'); render(); }
    });
    document.addEventListener('input', (e) => {
      if (e.target.id !== 'alertSearch') return;
      al.q = e.target.value; Tables.reset('absences');
      clearTimeout(al.qt); al.qt = setTimeout(() => { const pos = e.target.selectionStart; draw(); const s = $('#alertSearch'); s.focus(); s.setSelectionRange(pos, pos); }, 200);
    });
    Tables.on('absences', draw);
  }
  wire();
  return { render, refreshBadge };
})();
window.Alerts = Alerts;
