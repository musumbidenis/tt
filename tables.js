/* Shared table helpers, so every long table behaves the same way:
 *   Tables.slice(key, list)      the rows of the page being shown
 *   Tables.bar(key, list)        the "Previous / Next / rows per page" strip (empty when the list is short)
 *   Tables.on(key, redraw)       what to call when the page or the page size changes
 *   Tables.reset(key)            back to page 1 (call when a filter changes)
 *   Tables.th(key, col, label)   a heading that sorts the table when tapped; Tables.sort(key, list, getters, first)
 *   Tables.exportXlsx(...)       an Excel file of a table; Tables.print(...) prints it or saves it as a PDF
 * Needs app.js ($, esc, download, toast, todayISO) and Xlsx.simple (xlsx.js). */
'use strict';

const Tables = (() => {
  const SIZES = [10, 25, 30, 50, 100];
  const st = new Map(), redraw = new Map(), start = new Map([['marks', 30], ['register', 30], ['signoffs', 30]]);
  const get = (key) => { if (!st.has(key)) st.set(key, { page: 1, size: start.get(key) || 30 }); return st.get(key); };
  /** How many rows a table starts with (before the person chooses another number). */
  const defaults = (key, size) => { start.set(key, size); };

  function slice(key, list) {
    const s = get(key), pages = Math.max(1, Math.ceil(list.length / s.size));
    s.page = Math.min(Math.max(1, s.page), pages);
    return list.slice((s.page - 1) * s.size, s.page * s.size);
  }
  function bar(key, list) {
    const s = get(key), n = list.length;
    if (n <= Math.min(SIZES[0], s.size) || (s.page === 1 && n <= s.size && s.size === 30)) return '';
    const pages = Math.ceil(n / s.size), from = (s.page - 1) * s.size + 1, to = Math.min(n, s.page * s.size);
    return `<nav class="pager" data-pager="${key}" aria-label="Pages">
      <span class="pg-info">${from}–${to} of ${n}</span>
      <span class="pg-ctl">
        <button type="button" class="btn small ghost" data-pg="prev"${s.page <= 1 ? ' disabled' : ''}>‹ Previous</button>
        <span class="pg-now">Page ${s.page} of ${pages}</span>
        <button type="button" class="btn small ghost" data-pg="next"${s.page >= pages ? ' disabled' : ''}>Next ›</button>
      </span>
      <select data-pg-size aria-label="Rows per page">${SIZES.map((z) => `<option value="${z}"${z === s.size ? ' selected' : ''}>${z} per page</option>`).join('')}</select>
    </nav>`;
  }
  const reset = (key) => { get(key).page = 1; };
  /** How many rows come before the page being shown (call after slice). */
  const offset = (key) => { const s = get(key); return (s.page - 1) * s.size; };

  /* ---------- sorting: tap a heading, tap it again to reverse; remembered on this device ---------- */
  const sorts = new Map();
  const saved = (key) => { try { return JSON.parse(localStorage.getItem('tsort:' + key) || 'null'); } catch { return null; } };
  const sortOf = (key, first) => { if (!sorts.has(key)) sorts.set(key, saved(key) || { col: first, dir: 1 }); return sorts.get(key); };
  function th(key, col, label, cls = '', extra = '') {
    const s = sorts.get(key), on = s && s.col === col;
    return `<th${cls ? ` class="${cls}"` : ''}${extra} data-tkey="${key}" data-tsort="${col}" tabindex="0" aria-sort="${on ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}<span class="sort-ind">${on ? (s.dir > 0 ? ' ▲' : ' ▼') : ''}</span></th>`;
  }
  function sort(key, list, getters, first) {
    const s = sortOf(key, first), get = getters[s.col] || getters[first];
    if (!get) return list;
    return [...list].sort((a, b) => {
      const x = get(a), y = get(b);
      const blank = (v) => v === null || v === undefined || v === '';
      if (blank(x) !== blank(y)) return blank(x) ? 1 : -1;        // empty cells always go last
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true, sensitivity: 'base' });
      return c * s.dir;
    });
  }
  function sortBy(el) {
    const key = el.dataset.tkey, col = el.dataset.tsort, s = sorts.get(key) || { col, dir: -1 };
    const next = { col, dir: s.col === col ? -s.dir : 1 };
    sorts.set(key, next);
    try { localStorage.setItem('tsort:' + key, JSON.stringify(next)); } catch { /* private mode */ }
    get(key).page = 1;
    redraw.get(key)?.();
  }
  document.addEventListener('click', (e) => { const h = e.target.closest?.('th[data-tsort]'); if (h) sortBy(h); });
  document.addEventListener('keydown', (e) => { const h = e.target.closest?.('th[data-tsort]'); if (h && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sortBy(h); } });
  const on = (key, fn) => { redraw.set(key, fn); };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pg]'); if (!b) return;
    const key = b.closest('[data-pager]')?.dataset.pager; if (!key) return;
    get(key).page += b.dataset.pg === 'next' ? 1 : -1;
    redraw.get(key)?.();
  });
  document.addEventListener('change', (e) => {
    const z = e.target.closest?.('[data-pg-size]'); if (!z) return;
    const key = z.closest('[data-pager]')?.dataset.pager; if (!key) return;
    const s = get(key); s.size = Number(z.value) || SIZES[0]; s.page = 1;
    redraw.get(key)?.();
  });

  const fileName = (title, ext) => `${String(title).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'table'}_${todayISO()}.${ext}`;

  async function exportXlsx(title, head, rows) {
    try {
      download(fileName(title, 'xlsx'), await Xlsx.simple(title, head, rows));
      toast('Excel file saved', 'ok');
    } catch (e) { toast('Could not make the Excel file: ' + e.message, 'err'); }
  }
  function print(title, subtitle, head, rows) {
    const area = $('#printArea');
    area.innerHTML = `<div class="tbl-print"><h1>${esc(title)}</h1>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
      <table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    document.body.classList.add('printing', 'print-table');
    const done = () => { document.body.classList.remove('printing', 'print-table'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 80);
  }

  /** The order a table is in, and setting it (for a "Sort by" choice that sits beside the headings). */
  const sortState = (key, first) => ({ ...sortOf(key, first) });
  function setSort(key, col, dir = 1) {
    sorts.set(key, { col, dir });
    try { localStorage.setItem('tsort:' + key, JSON.stringify({ col, dir })); } catch { /* private mode */ }
    get(key).page = 1;
  }
  return { slice, offset, bar, reset, on, defaults, th, sort, sortState, setSort, exportXlsx, print };
})();
